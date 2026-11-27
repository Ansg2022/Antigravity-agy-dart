import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { ContextModeStore } from "../context/lib/store.js";
import { createTools, fetchUrlText } from "../context/lib/tools.js";
import {
  detectSensitiveFile,
  isBlockedHostname,
  isPrivateOrReservedIp,
  redactSecrets,
  sanitizeUrlForDisplay,
  validateFetchTarget
} from "../context/lib/security.js";
import {
  analyzeMultipleSessionsCache,
  analyzeTranscriptCache,
  formatCacheDiagMarkdown,
  renderHitRateAsciiTrend,
  resolveModelProfile
} from "../context/lib/cache-analyzer.js";
import { evaluateCacheAlerts } from "../hooks/pre-invocation.mjs";
import { auditPrefixBudget } from "../scripts/prefix-budget.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function runHook(scriptRel, payload, dbPath, extraEnv = {}) {
  const res = spawnSync(process.execPath, [path.join(ROOT, scriptRel)], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      AGY_DART_DB_PATH: dbPath,
      AGY_DART_DISABLE_COMPILE_CACHE: "1",
      ...extraEnv
    }
  });
  assert.equal(res.status, 0, `${scriptRel} failed: ${res.stderr}`);
  return JSON.parse(res.stdout.trim() || "{}");
}

function createPersistentMcpClient(scriptPath, extraEnv = {}) {
  const child = spawn(process.execPath, [scriptPath], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, AGY_DART_DISABLE_COMPILE_CACHE: "1", ...extraEnv }
  });
  let buf = "";
  let nextId = 1;
  const pending = new Map();

  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, timer } = pending.get(msg.id);
        clearTimeout(timer);
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });

  return {
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP request timed out: ${method}`));
        }, 10000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
    close() {
      return new Promise((resolve) => {
        child.once("close", resolve);
        child.stdin.end();
      });
    }
  };
}

test("Opt 1: fast/mcp-server.mjs schema slimming cuts Turn-0 budget while preserving all parameter names, enums, types, and constraints", async () => {
  const report = await auditPrefixBudget(ROOT);
  assert.equal(report.blocks.tools.canonical, true);
  assert.equal(report.blocks.tools.fast.toolCount, 4);
  assert.equal(report.blocks.tools.context.toolCount, 8);
  assert.ok(report.blocks.tools.fast.bytes < 3100);
  assert.ok(report.blocks.brake.tokens < 400, "Keep detailed tool arguments in the on-demand skill");
  assert.equal(report.configuredStartup.toolCount, 4);
  assert.equal(report.configuredStartup.schemaTokens, report.blocks.tools.fast.tokens);
  assert.equal(report.configuredStartup.estimatedTokens, report.totalTokens - report.blocks.tools.context.tokens);

  const client = createPersistentMcpClient(path.join(ROOT, "fast", "mcp-server.mjs"));
  try {
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "schema-check", version: "1.0" }
    });
    const listResp = await client.request("tools/list", {});
    const byName = new Map(listResp.result.tools.map((t) => [t.name, t]));

    // batch_search
    const bs = byName.get("batch_search").inputSchema;
    assert.deepEqual(bs.required, ["queries"]);
    assert.deepEqual(Object.keys(bs.properties).sort(), ["cwd", "maxChars", "queries"]);
    assert.deepEqual(bs.properties.queries.items.properties.type.enum, ["text", "regex", "glob", "fuzzy", "git"]);
    assert.deepEqual(
      Object.keys(bs.properties.queries.items.properties).sort(),
      ["caseSensitive", "contextLines", "fileType", "glob", "maxResults", "multiline", "outputMode", "path", "pattern", "sortBy", "type"]
    );
    assert.equal(bs.properties.maxChars.maximum, 8800);

    // apply_edits
    const ae = byName.get("apply_edits").inputSchema;
    assert.deepEqual(ae.required, ["edits"]);
    assert.deepEqual(
      Object.keys(ae.properties).sort(),
      ["bestEffort", "cwd", "dryRun", "edits", "maxVerifyChars", "verify", "verifyTimeoutSec"]
    );
    assert.deepEqual(
      Object.keys(ae.properties.edits.items.properties).sort(),
      ["create", "hunks", "overwrite", "path"]
    );
    assert.deepEqual(
      Object.keys(ae.properties.edits.items.properties.hunks.items.properties).sort(),
      ["endLine", "replaceAll", "replacement", "startLine", "target"]
    );

    // read_slices
    const rs = byName.get("read_slices").inputSchema;
    assert.deepEqual(Object.keys(rs.properties).sort(), ["cwd", "lineRanges", "maxChars", "outlines", "slices"]);
    assert.equal(rs.properties.outlines.maxItems, 40);
    assert.equal(rs.properties.slices.maxItems, 30);
    assert.equal(rs.properties.lineRanges.maxItems, 30);

    // run_checks
    const rc = byName.get("run_checks").inputSchema;
    assert.deepEqual(rc.required, ["commands"]);
    assert.deepEqual(
      Object.keys(rc.properties).sort(),
      ["commands", "concurrency", "cwd", "maxChars", "outputMode", "timeoutSec"]
    );
    assert.deepEqual(rc.properties.outputMode.enum, ["compact", "full"]);
  } finally {
    await client.close();
  }
});

test("Opt 2: SSRF-hardened fetchUrlText, secret redaction before DB/return, and optional sensitive-file guard", async () => {
  // 2A. IPv4 / IPv6 / IPv4-mapped / NAT64 / 6to4 private IP checks
  const blockedIps = [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "127.255.255.254",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fe80::1",
    "fe80::1%eth0",
    "fc00::1",
    "fd12:3456:789a::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "64:ff9b::10.0.0.1",
    "2002:0a00:0001::1",
    "not-an-ip"
  ];
  for (const ip of blockedIps) {
    assert.equal(isPrivateOrReservedIp(ip), true, `Expected ${ip} to be blocked as private/reserved`);
  }
  const publicIps = ["1.1.1.1", "8.8.8.8", "93.184.216.34", "172.32.0.1", "2606:2800:220:1:248:1893:25c8:1946"];
  for (const ip of publicIps) {
    assert.equal(isPrivateOrReservedIp(ip), false, `Expected ${ip} to be allowed as public`);
  }

  // Protocol whitelist & literal SSRF blocking
  await assert.rejects(() => fetchUrlText("file:///etc/passwd"), /only http: and https:/i);
  await assert.rejects(() => fetchUrlText("ftp://example.com/a.txt"), /only http: and https:/i);
  await assert.rejects(() => fetchUrlText("gopher://127.0.0.1:6379/_INFO"), /only http: and https:/i);
  await assert.rejects(() => fetchUrlText("http://127.0.0.1:80/secret"), /Blocked SSRF/i);
  await assert.rejects(() => fetchUrlText("http://localhost:8080/"), /Blocked SSRF/i);
  await assert.rejects(() => fetchUrlText("http://169.254.169.254/latest/meta-data/"), /Blocked SSRF/i);
  await assert.rejects(() => fetchUrlText("http://[::1]:8080/"), /Blocked SSRF/i);
  await assert.rejects(() => fetchUrlText("http://[::ffff:127.0.0.1]/"), /Blocked SSRF/i);
  await assert.rejects(() => fetchUrlText("http://2130706433/"), /Blocked SSRF/i);

  // Dual-stack DNS poisoning: public A + loopback AAAA must be rejected
  await assert.rejects(
    () =>
      validateFetchTarget("https://dual.example.test/doc", {
        lookupFn: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "::1", family: 6 }
        ]
      }),
    /Blocked SSRF DNS resolution/i
  );

  // Live local HTTP server testing relative Location resolution, 5-hop boundary, >5 hop rejection, protocol downgrade, & size cap
  const server = http.createServer((req, res) => {
    if (req.url === "/rel-start") {
      res.writeHead(302, { Location: "/dir/hop1" });
      res.end();
    } else if (req.url === "/dir/hop1") {
      res.writeHead(301, { Location: "../final" });
      res.end();
    } else if (req.url === "/final") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("hello-after-relative-redirects");
    } else if (req.url?.startsWith("/chain/")) {
      const n = Number(req.url.slice("/chain/".length));
      if (n > 0) {
        res.writeHead(302, { Location: `/chain/${n - 1}` });
        res.end();
      } else {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("chain-done");
      }
    } else if (req.url === "/to-file") {
      res.writeHead(302, { Location: "file:///etc/passwd" });
      res.end();
    } else if (req.url === "/huge") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("A".repeat(8192));
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-sec-"));
  const tmpDb = path.join(tmpDir, "context.db");

  try {
    // Default fetchUrlText & ctx_index(url) MUST block 127.0.0.1
    await assert.rejects(() => fetchUrlText(`${baseUrl}/final`), /Blocked SSRF/i);

    const store = new ContextModeStore({ dbPath: tmpDb });
    const tools = createTools({ store, getCwd: () => tmpDir, getSessionId: () => "sec-sess" });
    await assert.rejects(() => tools.ctx_index({ url: `${baseUrl}/final` }), /Blocked SSRF/i);

    // Controlled redirect tests (allowPrivate: true only for localhost test server)
    const relBody = await fetchUrlText(`${baseUrl}/rel-start`, { allowPrivate: true });
    assert.equal(relBody, "hello-after-relative-redirects");

    // Exact 5 redirects succeed
    const ok5 = await fetchUrlText(`${baseUrl}/chain/5`, { allowPrivate: true });
    assert.equal(ok5, "chain-done");

    // 6 redirects rejected
    await assert.rejects(() => fetchUrlText(`${baseUrl}/chain/6`, { allowPrivate: true }), /Too many redirects/i);

    // Redirect to file:// blocked even when allowPrivate=true
    await assert.rejects(() => fetchUrlText(`${baseUrl}/to-file`, { allowPrivate: true }), /Blocked URL protocol/i);

    // Body size cap stops stream cleanly
    const capped = await fetchUrlText(`${baseUrl}/huge`, { allowPrivate: true, maxBodyBytes: 512 });
    assert.equal(capped.length, 512);

    // 2B. Secret redaction unit & integration tests
    const rawSecrets = [
      "OPENAI=sk-proj-abcdefghijklmnopqrstuvwxyz123456",
      "ANTHROPIC=sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234",
      "GH=ghp_1234567890abcdefghijklmnopqrstuvwxyz1234",
      "GOOGLE=AIzaSyA1234567890abcdefghijklmnopqrstuvwx",
      "AWS=AKIAIOSFODNN7EXAMPLE",
      "SLACK=xoxb-1234567890-abcdefghij",
      "Authorization: Bearer super_secret_bearer_token_value_1234567890",
      "DB=postgres://admin:S3cr3tP4ss!@db.internal:5432/prod",
      "API_KEY=real_live_secret_value_987654321",
      "SAFE_PLACEHOLDER_API_KEY=your_api_key_here",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAtestkeydata\n-----END RSA PRIVATE KEY-----"
    ].join("\n");

    const red = redactSecrets(rawSecrets, { force: true });
    assert.ok(red.redactedCount >= 10, `Expected >=10 redactions, got ${red.redactedCount}`);
    assert.ok(!red.text.includes("sk-proj-abcdef"));
    assert.ok(!red.text.includes("sk-ant-api03"));
    assert.ok(!red.text.includes("ghp_123456"));
    assert.ok(!red.text.includes("AIzaSyA123"));
    assert.ok(!red.text.includes("AKIAIOSFODNN7EXAMPLE"));
    assert.ok(!red.text.includes("S3cr3tP4ss!"));
    assert.ok(!red.text.includes("real_live_secret_value_987654321"));
    assert.ok(!red.text.includes("MIIEowIBAAKCAQEAtestkeydata"));
    assert.ok(red.text.includes("[REDACTED:PRIVATE_KEY]"));
    assert.ok(red.text.includes("postgres://admin:[REDACTED:DB_PASS]@db.internal:5432/prod"));
    assert.ok(red.text.includes("SAFE_PLACEHOLDER_API_KEY=your_api_key_here"), "Placeholders must not be falsely redacted");

    // ctx_index(.env) redacts before storing in SQLite and emits sensitiveFileWarning
    const dotenvPath = path.join(tmpDir, ".env");
    fs.writeFileSync(
      dotenvPath,
      "SERVICE_NAME=billing\nAPI_KEY=live_prod_secret_token_99887766\nGH_TOKEN=ghp_1234567890abcdefghijklmnopqrstuvwxyz1234\n",
      "utf8"
    );
    const idxEnv = await tools.ctx_index({ path: dotenvPath });
    assert.ok(idxEnv.redactedSecrets >= 2);
    assert.ok(idxEnv.sensitiveFileWarning && idxEnv.sensitiveFileWarning.includes(".env"));
    const storedChunks = store.getSourceChunks(idxEnv.sourceId).map((c) => c.body).join("\n");
    assert.ok(!storedChunks.includes("live_prod_secret_token_99887766"));
    assert.ok(!storedChunks.includes("ghp_1234567890"));
    assert.ok(storedChunks.includes("SERVICE_NAME=billing"));

    // ctx_execute redacts stdout before returning & indexing
    const execRes = await tools.ctx_execute({
      language: "nodejs",
      code: 'console.log("token=ghp_1234567890abcdefghijklmnopqrstuvwxyz1234 ok");',
      intent: "secret-check"
    });
    assert.equal(execRes.redactedSecrets, 1);
    assert.ok(!execRes.output.includes("ghp_1234567890"));
    assert.ok(execRes.output.includes("[REDACTED:GITHUB_TOKEN]"));

    // ctx_doctor surfaces security feature states
    const doc = await tools.ctx_doctor();
    assert.equal(doc.features.secretRedactionEnabled, true);
    assert.equal(doc.features.sensitiveFileGuardMode, "off");
    store.close();

    // 2C. Sensitive file detector & optional PreToolUse guard (off / warn / deny)
    assert.equal(detectSensitiveFile(path.join(tmpDir, ".env")).sensitive, true);
    assert.equal(detectSensitiveFile(path.join(tmpDir, ".env.production")).sensitive, true);
    assert.equal(detectSensitiveFile(path.join(tmpDir, ".env.example")).sensitive, false);
    assert.equal(detectSensitiveFile(path.join(tmpDir, "tls.key")).sensitive, true);
    assert.equal(detectSensitiveFile(path.join(tmpDir, "id_ed25519")).sensitive, true);
    assert.equal(detectSensitiveFile(path.join(tmpDir, "id_ed25519.pub")).sensitive, false);
    assert.equal(detectSensitiveFile(path.join(tmpDir, "src/index.ts")).sensitive, false);

    // Default (off): allowed
    const allowDefault = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "sens-off", toolCall: { name: "read_file", args: { Path: dotenvPath } } },
      tmpDb
    );
    assert.equal(allowDefault.decision, "allow");

    // Warn mode: 1st call denies with reminder, 2nd call allows
    const warn1 = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "sens-warn", toolCall: { name: "read_file", args: { Path: dotenvPath } } },
      tmpDb,
      { AGY_DART_SENSITIVE_FILE_GUARD: "warn" }
    );
    assert.equal(warn1.decision, "deny");
    assert.ok(warn1.reason.includes("[agy-dart sensitive-file]"));

    const warn2 = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "sens-warn", toolCall: { name: "read_file", args: { Path: dotenvPath } } },
      tmpDb,
      { AGY_DART_SENSITIVE_FILE_GUARD: "warn" }
    );
    assert.equal(warn2.decision, "allow");

    // Deny mode: always denies
    const deny1 = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "sens-deny", toolCall: { name: "read_file", args: { Path: dotenvPath } } },
      tmpDb,
      { AGY_DART_SENSITIVE_FILE_GUARD: "deny" }
    );
    assert.equal(deny1.decision, "deny");
    assert.ok(deny1.reason.includes("AGY_DART_SENSITIVE_FILE_GUARD=deny"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Opt 3: Doom-loop / edit<->fail oscillation watch in cache-analyzer, PreInvocation UI-only hook, and convergence reset", () => {
  const t0 = Date.parse("2026-11-20T12:00:00Z");
  const iso = (sec) => new Date(t0 + sec * 1000).toISOString();

  // 1. Repeat loop detection (ignores transient toolSummary key)
  const repeatSteps = [1, 2, 3, 4].flatMap((n) => [
    {
      type: "PLANNER_RESPONSE",
      step_index: n * 2,
      created_at: iso(n * 5),
      model: "claude-sonnet-4",
      input_tokens: 2000,
      cache_read_tokens: 20000,
      tool_calls: [
        { name: "run_command", args: { CommandLine: "npm test", toolSummary: `Run #${n}` } }
      ]
    },
    { type: "GENERIC", content: "FAIL (exit 1)\nAssertionError: mismatch", exit_code: 1 }
  ]);
  const repDiag = analyzeTranscriptCache(repeatSteps, { nowMs: t0 + 30000 });
  assert.equal(repDiag.loopWatch.status, "critical");
  assert.equal(repDiag.loopWatch.reason, "repeat_loop");
  assert.equal(repDiag.loopWatch.maxRepeatCount, 4);
  assert.equal(repDiag.loopWatch.repeatRate, 0.75);

  // 2. Edit<->Fail oscillation (2 cycles -> warn, 3 cycles -> critical, inline verify PASS -> resets to ok!)
  const oscSteps = [];
  let idx = 1;
  for (let c = 1; c <= 3; c++) {
    oscSteps.push(
      {
        type: "PLANNER_RESPONSE",
        step_index: idx++,
        created_at: iso(idx * 5),
        model: "claude-sonnet-4",
        input_tokens: 3000,
        cache_read_tokens: 25000 + c * 1000,
        tool_calls: [{ name: "edit_file", args: { Path: "src/parser.js", Target: `v${c}`, Replacement: `v${c + 1}` } }]
      },
      { type: "GENERIC", content: "Edited src/parser.js" },
      {
        type: "PLANNER_RESPONSE",
        step_index: idx++,
        created_at: iso(idx * 5),
        model: "claude-sonnet-4",
        input_tokens: 3000,
        cache_read_tokens: 26000 + c * 1000,
        tool_calls: [{ name: "run_command", args: { CommandLine: `npm test -- --grep case${c}` } }]
      },
      { type: "GENERIC", status: "ERROR", content: "1 failed: AssertionError: expected 1 to equal 2", exit_code: 1 }
    );
  }
  const oscWarnDiag = analyzeTranscriptCache(oscSteps.slice(0, 8), { nowMs: t0 + 200000 });
  assert.equal(oscWarnDiag.loopWatch.status, "warn");
  assert.equal(oscWarnDiag.loopWatch.editFailOscillations, 2);
  assert.ok(oscWarnDiag.loopWatch.oscillatingFiles.includes("src/parser.js"));

  const oscCritDiag = analyzeTranscriptCache(oscSteps, { nowMs: t0 + 200000 });
  assert.equal(oscCritDiag.loopWatch.status, "critical");
  assert.equal(oscCritDiag.loopWatch.editFailOscillations, 3);

  // Add converging apply_edits with inline Verify [PASS]
  const convergedSteps = [
    ...oscSteps,
    {
      type: "PLANNER_RESPONSE",
      step_index: idx++,
      created_at: iso(idx * 5),
      model: "claude-sonnet-4",
      input_tokens: 2500,
      cache_read_tokens: 30000,
      tool_calls: [
        {
          name: "call_mcp_tool",
          args: {
            ServerName: "agy-dart_fast",
            ToolName: "apply_edits",
            Arguments: { edits: [{ path: "src/parser.js", hunks: [{ target: "a", replacement: "b" }] }], verify: "npm test" }
          }
        }
      ]
    },
    { type: "GENERIC", content: "Applied edits to 1 file(s):\nVerify [PASS in 120ms] `npm test`:\n26 passed, 0 failed" }
  ];
  const convDiag = analyzeTranscriptCache(convergedSteps, { nowMs: t0 + 210000 });
  assert.equal(convDiag.loopWatch.editFailOscillations, 0);
  assert.equal(convDiag.loopWatch.status, "ok");

  // 3. PreInvocation zero-prefix-pollution alert & escalation/dedup
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-loop-"));
  const tmpDb = path.join(tmpDir, "context.db");
  const transcriptPath = path.join(tmpDir, "transcript.jsonl");
  try {
    const store = new ContextModeStore({ dbPath: tmpDb });
    const aWarn1 = evaluateCacheAlerts(oscWarnDiag, { sessionId: "loop-s1", store });
    assert.equal(aWarn1.length, 1);
    assert.ok(aWarn1[0].includes("Convergence watch (WARN)"));
    assert.ok(aWarn1[0].includes("2x edit↔fail oscillation"));

    // Repeat warn does not spam
    const aWarn2 = evaluateCacheAlerts(oscWarnDiag, { sessionId: "loop-s1", store });
    assert.equal(aWarn2.length, 0);

    // Escalate warn -> critical fires once
    const aCrit1 = evaluateCacheAlerts(oscCritDiag, { sessionId: "loop-s1", store });
    assert.equal(aCrit1.length, 1);
    assert.ok(aCrit1[0].includes("Convergence watch (CRITICAL)"));
    const aCrit2 = evaluateCacheAlerts(oscCritDiag, { sessionId: "loop-s1", store });
    assert.equal(aCrit2.length, 0);

    // Converging resets alert state
    const aOk = evaluateCacheAlerts(convDiag, { sessionId: "loop-s1", store });
    assert.equal(aOk.length, 0);
    store.close();

    // Live hook run (with opt-in inline alerts) emits systemMessage: "" + metadata.user_markdown
    fs.writeFileSync(transcriptPath, oscCritDiag ? oscSteps.map((s) => JSON.stringify(s)).join("\n") + "\n" : "", "utf8");
    const hookOut = runHook(
      "hooks/pre-invocation.mjs",
      { conversationId: "loop-hook-live", transcriptPath },
      tmpDb,
      { AGY_DART_CACHE_WATCH_INLINE_ALERTS: "1" }
    );
    assert.equal(hookOut.injectSteps?.length, 1);
    assert.equal(hookOut.injectSteps[0].systemMessage.systemMessage, "");
    assert.ok(hookOut.injectSteps[0].systemMessage.metadata.user_markdown.includes("Convergence watch (CRITICAL)"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Opt 4: Model-aware dynamic watermarks, idle TTL, cost discount, and env overrides", () => {
  // Profile table verification
  assert.equal(resolveModelProfile("claude-sonnet-4-1m").windowTokens, 1000000);
  assert.equal(resolveModelProfile("claude-sonnet-4").windowTokens, 200000);
  assert.equal(resolveModelProfile("gemini-2.5-pro").cacheDiscountRate, 0.75);
  assert.equal(resolveModelProfile("gemini-3.1-pro").cacheDiscountRate, 0.90);
  assert.equal(resolveModelProfile("gpt-4o").windowTokens, 128000);
  assert.equal(resolveModelProfile("gpt-4o").cacheDiscountRate, 0.50);
  assert.equal(resolveModelProfile("deepseek-reasoner").ttlSec, 600);
  assert.equal(resolveModelProfile("unknown-custom-model").id, "default-200k");

  const nowMs = Date.now();
  const makeStep = (model, inputTokens, cacheReadTokens, idleSec) => [
    {
      type: "PLANNER_RESPONSE",
      step_index: 1,
      created_at: new Date(nowMs - idleSec * 1000).toISOString(),
      model,
      input_tokens: inputTokens,
      cache_read_tokens: cacheReadTokens,
      output_tokens: 200
    }
  ];

  // gpt-4o (128k, 50% discount): 90k -> warn, 105k -> critical, 90% hit -> 45% savings
  const gptWarn = analyzeTranscriptCache(makeStep("gpt-4o", 9000, 81000, 20), { nowMs });
  assert.equal(gptWarn.modelProfile.id, "gpt-4o-128k");
  assert.equal(gptWarn.warnTokens, 83200);
  assert.equal(gptWarn.criticalTokens, 102400);
  assert.equal(gptWarn.watermark, "warn");
  assert.equal(gptWarn.estimatedCostSavingsPct, 45.0);

  const gptCrit = analyzeTranscriptCache(makeStep("gpt-4o", 15000, 90000, 20), { nowMs });
  assert.equal(gptCrit.watermark, "critical");
  assert.equal(gptCrit.compactAdvice, "critical_compact");

  // claude-sonnet-4-1m (1M): 170k is only 17% -> ok (NOT falsely critical!), 660k -> warn, 810k -> critical
  const c1mOk = analyzeTranscriptCache(makeStep("claude-sonnet-4-1m", 10000, 160000, 20), { nowMs });
  assert.equal(c1mOk.watermark, "ok");
  assert.equal(c1mOk.warnTokens, 650000);
  assert.equal(c1mOk.criticalTokens, 800000);

  const c1mCrit = analyzeTranscriptCache(makeStep("claude-sonnet-4-1m", 10000, 800000, 20), { nowMs });
  assert.equal(c1mCrit.watermark, "critical");

  // deepseek-reasoner (600s default TTL): 400s idle is still WARM, not expired
  const dsWarm = analyzeTranscriptCache(makeStep("deepseek-reasoner", 5000, 45000, 400), { nowMs });
  assert.equal(dsWarm.cacheTtlSec, 600);
  assert.equal(dsWarm.ttlStatus, "warm");
  assert.equal(dsWarm.ttlRemainingSec, 200);

  // PreInvocation env overrides work even on 1M model
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-env-wm-"));
  const tmpDb = path.join(tmpDir, "context.db");
  const transcriptPath = path.join(tmpDir, "transcript.jsonl");
  try {
    fs.writeFileSync(transcriptPath, JSON.stringify(makeStep("claude-sonnet-4-1m", 10000, 65000, 15)[0]) + "\n", "utf8");
    const hookRes = runHook(
      "hooks/pre-invocation.mjs",
      { conversationId: "env-override-s1", transcriptPath },
      tmpDb,
      { AGY_DART_WARN_TOKENS: "50000", AGY_DART_CRITICAL_TOKENS: "70000", AGY_DART_CACHE_WATCH_INLINE_ALERTS: "1" }
    );
    assert.equal(hookRes.injectSteps?.length, 1);
    assert.equal(hookRes.injectSteps[0].systemMessage.systemMessage, "");
    assert.ok(hookRes.injectSteps[0].systemMessage.metadata.user_markdown.includes("critical watermark >= 70k"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Opt 5: Enhanced ctx_resume structured sessionCheckpoint (0 new MCP tools, PostToolUse + cli-filter ledger, <=8.8KB cap)", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-resume-cp-"));
  const tmpDb = path.join(tmpDir, "context.db");
  const sid = "checkpoint-sess-1";

  try {
    // 1. PostToolUse records modified files (and ignores dryRun / aborted edits)
    runHook(
      "hooks/post-tool-use.mjs",
      {
        conversationId: sid,
        cwd: tmpDir,
        toolCall: { name: "edit_file", args: { Path: path.join(tmpDir, "src", "auth.js") } }
      },
      tmpDb
    );
    runHook(
      "hooks/post-tool-use.mjs",
      {
        conversationId: sid,
        cwd: tmpDir,
        toolCall: {
          name: "call_mcp_tool",
          args: {
            ToolName: "apply_edits",
            Arguments: {
              cwd: tmpDir,
              edits: [{ path: "src/api.js", hunks: [{ target: "a", replacement: "b" }] }],
              verify: "npm run build"
            }
          }
        },
        toolResponse: "Applied edits to 1 file(s):\nVerify [PASS in 85ms] `npm run build`:\ncompiled"
      },
      tmpDb
    );
    // dryRun & aborted edit MUST NOT pollute modifiedFiles
    runHook(
      "hooks/post-tool-use.mjs",
      {
        conversationId: sid,
        cwd: tmpDir,
        toolCall: {
          name: "apply_edits",
          args: { cwd: tmpDir, dryRun: true, edits: [{ path: "src/should-not-appear.js", hunks: [] }] }
        }
      },
      tmpDb
    );
    runHook(
      "hooks/post-tool-use.mjs",
      {
        conversationId: sid,
        cwd: tmpDir,
        toolCall: {
          name: "apply_edits",
          args: { cwd: tmpDir, edits: [{ path: "src/aborted.js", hunks: [] }] }
        },
        toolResponse: "Atomic edit aborted (0 files modified):\n- mismatch"
      },
      tmpDb
    );

    // 2. cli-filter records test-runner verdict & redacts secrets
    const testScript = path.join(tmpDir, "fake-test.mjs");
    fs.writeFileSync(
      testScript,
      'console.log("token=ghp_1234567890abcdefghijklmnopqrstuvwxyz1234"); console.error("✖ test_auth failed"); process.exit(1);\n',
      "utf8"
    );
    const enc = (s) => `b:${Buffer.from(s, "utf8").toString("base64url")}`;
    const cliRun = spawnSync(
      process.execPath,
      [
        path.join(ROOT, "hooks", "cli-filter.mjs"),
        "--rule",
        "test-runner",
        "--b64",
        enc(`node "${testScript}"`),
        "--orig-b64",
        enc("npm test"),
        "--session",
        enc(sid)
      ],
      {
        cwd: tmpDir,
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, AGY_DART_DB_PATH: tmpDb, AGY_DART_DISABLE_COMPILE_CACHE: "1" }
      }
    );
    assert.equal(cliRun.status, 1);
    assert.ok(!cliRun.stdout.includes("ghp_1234567890"), "cli-filter must redact secrets before printing");
    assert.ok(cliRun.stdout.includes("[REDACTED:GITHUB_TOKEN]"));

    // 3. Call ctx_resume via MCP context/server.js (verifying still 8 tools + structured checkpoint <= 8.8 KB)
    const client = createPersistentMcpClient(path.join(ROOT, "context", "server.js"), {
      AGY_DART_DB_PATH: tmpDb,
      ANTIGRAVITY_CONVERSATION_ID: sid
    });
    try {
      await client.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "resume-test", version: "1.0" },
        sessionId: sid
      });
      const toolsList = await client.request("tools/list", {});
      assert.equal(toolsList.result.tools.length, 8, "Zero new MCP tools allowed");

      const resumeResp = await client.request("tools/call", {
        name: "ctx_resume",
        arguments: { sessionId: sid }
      });
      const rawText = resumeResp.result.content[0].text;
      assert.ok(Buffer.byteLength(rawText, "utf8") <= 8800, "ctx_resume must stay <= 8.8 KB UTF-8");
      const parsed = JSON.parse(rawText);
      const cp = parsed.sessionCheckpoint;
      assert.ok(cp, "sessionCheckpoint must be present");
      assert.equal(cp.modifiedFileCount, 2);
      assert.ok(cp.modifiedFiles.includes("src/auth.js"));
      assert.ok(cp.modifiedFiles.includes("src/api.js"));
      assert.ok(!cp.modifiedFiles.includes("src/should-not-appear.js"));
      assert.ok(!cp.modifiedFiles.includes("src/aborted.js"));
      assert.equal(cp.lastTest?.ok, false);
      assert.equal(cp.lastTest?.exitCode, 1);
      assert.equal(cp.lastTest?.command, "npm test");
      assert.equal(cp.lastBuild?.ok, true);
      assert.equal(cp.lastBuild?.command, "npm run build");
    } finally {
      await client.close();
    }

    // 4. Purge cleans session_checkpoints
    const store = new ContextModeStore({ dbPath: tmpDb });
    store.purge({ scope: "session", sessionId: sid });
    assert.equal(store.getSessionCheckpoint(sid).modifiedFileCount, 0);
    assert.equal(store.getSessionCheckpoint(sid).lastTest, null);
    store.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Shared ctx_execute savings follow the host conversation exactly once", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-execution-receipts-"));
  const dbPath = path.join(dir, "context.db");
  const env = {
    AGY_DART_DB_PATH: dbPath, ANTIGRAVITY_CONVERSATION_ID: "", ANTIGRAVITY_PARENT_CONVERSATION_ID: "",
    ANTIGRAVITY_ROOT_CONVERSATION_ID: "", CONVERSATION_ID: ""
  };
  const client = createPersistentMcpClient(path.join(ROOT, "context/server.js"), env);
  const store = new ContextModeStore({ dbPath });
  try {
    store.recordEvent({ sessionId: "default", kind: "execution", tool: "ctx_execute", sandboxBytes: 25, returnedBytes: 5 });
    // Exercise an upgrade with an existing anonymous event in the v152 schema.
    store.db.exec("DROP INDEX idx_events_receipt; ALTER TABLE events DROP COLUMN execution_receipt; PRAGMA user_version = 152;");
    store.close();
    const execute = (code, metadata = {}) => client.request("tools/call", {
      name: "ctx_execute", arguments: { language: "nodejs", cwd: dir, code }, ...metadata
    }).then(response => JSON.parse(response.result.content[0].text));
    const code = 'console.log("abcdef".repeat(4000))';
    const [a, b, scoped] = await Promise.all([
      execute(code), execute(code), execute(code, {
        arguments: { language: "nodejs", cwd: dir, code, sessionId: "wrong" },
        _meta: { conversationId: "already-bound" }
      })
    ]);
    assert.ok(a.ok && a.rawBytes > a.returnedBytes);
    assert.ok(a.executionReceipt);
    assert.notEqual(a.executionReceipt, b.executionReceipt);
    assert.equal(scoped.executionReceipt, undefined);
    const allBefore = store.getStats("all");
    const toolCall = { name: "call_mcp_tool", args: { ServerName: "agy-dart_context", ToolName: "ctx_execute" } };
    const post = (id, result, call = toolCall) => runHook("hooks/post-tool-use.mjs", {
      common: { conversationId: id }, toolCall: call, toolResponse: { content: [{ text: JSON.stringify(result) }] }
    }, dbPath, env);
    post("wrong", a, { name: "call_mcp_tool", args: { ServerName: "other", ToolName: "ctx_execute" } });
    post("conv-a", a);
    post("conv-a", a);
    assert.equal(store.getStats("conv-a").keptOutBytes, a.rawBytes - a.returnedBytes);
    assert.equal(store.getStats("conv-b").calls, 0);
    assert.equal(store.getStats("wrong").calls, 0);

    // Hosts that omit the response in PostToolUse persist it in the next invocation's transcript.
    const tx = path.join(dir, "transcript.jsonl");
    const planner = { step_index: 10, type: "PLANNER_RESPONSE", tool_calls: [
      { name: "read_file" },
      { name: "call_mcp_tool", args: { ServerName: '"agy-dart_context"', ToolName: '"ctx_execute"' } }
    ] };
    const steps = [
      planner, { type: "GENERIC", step_index: 11, content: JSON.stringify(b) },
      { type: "GENERIC", step_index: 12, content: "Created At: 2026-11-23T06:00:00Z\n" + JSON.stringify(b, null, 2).slice(0, 4000) }
    ];
    const invocation = () => runHook("hooks/pre-invocation.mjs", {
      common: { conversationId: "conv-b", transcriptPath: tx }
    }, dbPath, env);
    fs.writeFileSync(tx, steps.slice(0, 2).map(s => JSON.stringify(s)).join("\n"));
    invocation();
    assert.equal(store.getStats("conv-b").calls, 0);
    fs.writeFileSync(tx, steps.map(s => JSON.stringify(s)).join("\n"));
    invocation();
    invocation();
    assert.equal(store.getStats("conv-b").keptOutBytes, b.rawBytes - b.returnedBytes);
    assert.equal(store.getStats("already-bound").calls, 1);
    assert.equal(store.getStats("default").calls, 1);
    assert.equal(store.getStats("default").keptOutBytes, 20);
    assert.deepEqual(store.getStats("all"), allBefore);
  } finally {
    await client.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Shared MCP server per-call sessionId isolation (AsyncLocalStorage prevents cross-tab leak, recovers checkpoint & scopes purge)", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-shared-mcp-"));
  const tmpDb = path.join(tmpDir, "context.db");
  const convA = "conv-alpha-1111";
  const convB = "conv-beta-2222";

  try {
    // Seed two concurrent conversations (simulating Hooks writing per-UUID checkpoints/events/file_reads)
    const seed = new ContextModeStore({ dbPath: tmpDb });
    seed.recordModifiedFiles(convA, [path.join(tmpDir, "alpha.js")], { worktree: tmpDir, tool: "edit_file" });
    seed.recordModifiedFiles(convB, [path.join(tmpDir, "beta.js")], { worktree: tmpDir, tool: "edit_file" });
    seed.recordFileRead({ sessionId: convA, filePath: path.join(tmpDir, "alpha.js"), startLine: 1, endLine: 10, mtimeMs: 1, fileSize: 2048, byteEst: 2048 });
    seed.recordFileRead({ sessionId: convB, filePath: path.join(tmpDir, "beta.js"), startLine: 1, endLine: 10, mtimeMs: 1, fileSize: 2048, byteEst: 2048 });
    seed.recordEvent({ sessionId: convA, kind: "interception", tool: "read_file", key: "blocked", path: "alpha.js", sandboxBytes: 20000, returnedBytes: 0, ok: 1 });
    seed.recordEvent({ sessionId: convB, kind: "interception", tool: "read_file", key: "blocked", path: "beta.js", sandboxBytes: 30000, returnedBytes: 0, ok: 1 });
    seed.recordEvent({ sessionId: "default", kind: "execution", tool: "ctx_execute", key: "nodejs", path: null, sandboxBytes: 10000, returnedBytes: 500, ok: 1 });
    seed.close();

    // Launch ONE shared context/server.js WITHOUT ANTIGRAVITY_CONVERSATION_ID or initialize.sessionId
    const client = createPersistentMcpClient(path.join(ROOT, "context", "server.js"), {
      AGY_DART_DB_PATH: tmpDb,
      ANTIGRAVITY_CONVERSATION_ID: "",
      ANTIGRAVITY_ROOT_CONVERSATION_ID: "",
      ANTIGRAVITY_PARENT_CONVERSATION_ID: "",
      CONVERSATION_ID: ""
    });
    try {
      await client.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "shared-host", version: "1.0" }
      });

      // Verify optional sessionId is exposed in schema for ctx_resume, ctx_stats, ctx_purge
      const listResp = await client.request("tools/list", {});
      const byName = Object.fromEntries(listResp.result.tools.map((t) => [t.name, t]));
      assert.equal(byName.ctx_resume.inputSchema.properties.sessionId.type, "string");
      assert.equal(byName.ctx_stats.inputSchema.properties.sessionId.type, "string");
      assert.equal(byName.ctx_purge.inputSchema.properties.sessionId.type, "string");

      // 1. Explicit ctx_resume({ sessionId: convA }) recovers convA's checkpoint & clears ONLY convA's file_reads
      const resA = JSON.parse(
        (await client.request("tools/call", { name: "ctx_resume", arguments: { sessionId: convA } })).result.content[0].text
      );
      assert.equal(resA.sessionId, convA);
      assert.deepEqual(resA.sessionCheckpoint.modifiedFiles, ["alpha.js"]);
      assert.equal(resA.hint, undefined);

      // 2. Subsequent call without an ID uses its workspace, never the previous named session.
      const resDefault = JSON.parse(
        (await client.request("tools/call", { name: "ctx_resume", arguments: { cwd: tmpDir } })).result.content[0].text
      );
      assert.match(resDefault.sessionId, /^workspace:[a-f\d]{64}$/);
      assert.equal(resDefault.sessionCheckpoint.modifiedFileCount, 0);
      assert.ok(typeof resDefault.hint === "string" && resDefault.hint.includes("sessionId"), "Empty default resume must provide actionable hint when UUID checkpoints exist");

      // 3. Interleaved concurrent calls to convA & convB stay isolated via AsyncLocalStorage
      const [statsAOut, statsBOut] = await Promise.all([
        client.request("tools/call", { name: "ctx_stats", arguments: { sessionId: convA } }),
        client.request("tools/call", { name: "ctx_stats", arguments: { sessionId: convB } })
      ]);
      const statsA = JSON.parse(statsAOut.result.content[0].text);
      const statsB = JSON.parse(statsBOut.result.content[0].text);
      assert.equal(statsA.stats.sessionId, convA);
      assert.equal(statsA.stats.totalRawBytes, 20000);
      assert.equal(statsB.stats.sessionId, convB);
      assert.equal(statsB.stats.totalRawBytes, 30000);

      // 4. Scoped ctx_purge({ scope: "session", sessionId: convA }) purges ONLY convA (convB & default stay intact)
      await client.request("tools/call", { name: "ctx_purge", arguments: { scope: "session", sessionId: convA } });
      const checkA = JSON.parse(
        (await client.request("tools/call", { name: "ctx_resume", arguments: { sessionId: convA } })).result.content[0].text
      );
      const checkB = JSON.parse(
        (await client.request("tools/call", { name: "ctx_resume", arguments: { sessionId: convB } })).result.content[0].text
      );
      assert.equal(checkA.sessionCheckpoint.modifiedFileCount, 0);
      assert.deepEqual(checkB.sessionCheckpoint.modifiedFiles, ["beta.js"]);
    } finally {
      await client.close();
    }

    // Verify convB's file_reads survived convA's ctx_resume, and default's event survived convA's ctx_purge
    const verify = new ContextModeStore({ dbPath: tmpDb });
    assert.equal(verify.getStats("default").totalRawBytes, 10000, "Scoped purge of convA must not touch 'default'");
    verify.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Opt 6: read_slices({ slices }) bounded 4MB/256KB cache + apply_edits invalidation + recentTurns(15)/Top-3/ASCII/Sidecar chart", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-opt6-"));
  const tmpDb = path.join(tmpDir, "context.db");

  try {
    // 6A. read_slices({ slices }) bounded line cache + apply_edits invalidation + >256KB skip + >4MB LRU eviction
    const sliceDir = path.join(tmpDir, "slices");
    fs.mkdirSync(sliceDir, { recursive: true });
    const smallPath = path.join(sliceDir, "sample.txt");
    const fixedSec = Math.floor(Date.now() / 1000) - 60;
    fs.writeFileSync(smallPath, "alpha_0001\nbeta__0002\ngamma_0003\n", "utf8");
    fs.utimesSync(smallPath, fixedSec, fixedSec);

    const client = createPersistentMcpClient(path.join(ROOT, "fast", "mcp-server.mjs"), { AGY_DART_DB_PATH: tmpDb });
    try {
      await client.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "slice-cache-test", version: "1.0" }
      });

      // Prime SLICE_LINES_CACHE
      const s1 = await client.request("tools/call", {
        name: "read_slices",
        arguments: { cwd: sliceDir, slices: [{ path: "sample.txt", ranges: [[1, 3]] }] }
      });
      assert.ok(s1.result.content[0].text.includes("alpha_0001"));

      // Overwrite externally with identical byte size & identical mtime -> must HIT cross-call slice cache
      fs.writeFileSync(smallPath, "DELTA_0001\nbeta__0002\ngamma_0003\n", "utf8");
      fs.utimesSync(smallPath, fixedSec, fixedSec);
      const sHit = await client.request("tools/call", {
        name: "read_slices",
        arguments: { cwd: sliceDir, slices: [{ path: "sample.txt", ranges: [[1, 2]] }] }
      });
      assert.ok(sHit.result.content[0].text.includes("alpha_0001"), "Unchanged (mtimeMs, size) must hit SLICE_LINES_CACHE");

      // apply_edits writes same-length change and MUST actively invalidate SLICE_LINES_CACHE
      const ed = await client.request("tools/call", {
        name: "apply_edits",
        arguments: {
          cwd: sliceDir,
          edits: [{ path: "sample.txt", hunks: [{ target: "DELTA_0001", replacement: "OMEGA_0001" }] }]
        }
      });
      assert.equal(ed.result.isError, false, ed.result.content[0].text);
      const sAfterEdit = await client.request("tools/call", {
        name: "read_slices",
        arguments: { cwd: sliceDir, slices: [{ path: "sample.txt", ranges: [[1, 2]] }] }
      });
      assert.ok(sAfterEdit.result.content[0].text.includes("OMEGA_0001"), "apply_edits must invalidate slice cache");

      // File > 256 KB must NOT be stored in SLICE_LINES_CACHE
      const bigPath = path.join(sliceDir, "over256k.txt");
      const pad260k = "x".repeat(265 * 1024);
      fs.writeFileSync(bigPath, `FIRST_LINE\n${pad260k}\n`, "utf8");
      fs.utimesSync(bigPath, fixedSec, fixedSec);
      const b1 = await client.request("tools/call", {
        name: "read_slices",
        arguments: { cwd: sliceDir, slices: [{ path: "over256k.txt", ranges: [[1, 1]] }] }
      });
      assert.ok(b1.result.content[0].text.includes("FIRST_LINE"));

      // Same size & same mtime overwrite -> MUST NOT hit cache since file > 256 KB
      fs.writeFileSync(bigPath, `SECND_LINE\n${pad260k}\n`, "utf8");
      fs.utimesSync(bigPath, fixedSec, fixedSec);
      const b2 = await client.request("tools/call", {
        name: "read_slices",
        arguments: { cwd: sliceDir, slices: [{ path: "over256k.txt", ranges: [[1, 1]] }] }
      });
      assert.ok(b2.result.content[0].text.includes("SECND_LINE"), ">256KB file must bypass SLICE_LINES_CACHE");

      // Total > 4 MB evicts oldest LRU entry (20 files * 220 KB = 4.4 MB > 4 MB)
      const victimPath = path.join(sliceDir, "lru_victim.txt");
      const pad220k = "v".repeat(220 * 1024);
      fs.writeFileSync(victimPath, `VICTIM_OLD\n${pad220k}\n`, "utf8");
      fs.utimesSync(victimPath, fixedSec, fixedSec);
      const v1 = await client.request("tools/call", {
        name: "read_slices",
        arguments: { cwd: sliceDir, slices: [{ path: "lru_victim.txt", ranges: [[1, 1]] }] }
      });
      assert.ok(v1.result.content[0].text.includes("VICTIM_OLD"));
      // Silently mutate victim with same size & mtime
      fs.writeFileSync(victimPath, `VICTIM_NEW\n${pad220k}\n`, "utf8");
      fs.utimesSync(victimPath, fixedSec, fixedSec);

      // Fill > 4 MB with 20 distinct 220 KB files
      for (let i = 0; i < 20; i++) {
        const fp = path.join(sliceDir, `fill_${i}.txt`);
        fs.writeFileSync(fp, `FILL_${String(i).padStart(2, "0")}\n${pad220k}\n`, "utf8");
        await client.request("tools/call", {
          name: "read_slices",
          arguments: { cwd: sliceDir, slices: [{ path: `fill_${i}.txt`, ranges: [[1, 1]] }] }
        });
      }
      const vEvicted = await client.request("tools/call", {
        name: "read_slices",
        arguments: { cwd: sliceDir, slices: [{ path: "lru_victim.txt", ranges: [[1, 1]] }] }
      });
      assert.ok(
        vEvicted.result.content[0].text.includes("VICTIM_NEW"),
        ">4MB aggregate slice cache must evict oldest LRU entry"
      );
    } finally {
      await client.close();
    }

    // 6B. recentTurns (last 15), topContextDeltas (Top-3), pure ASCII trend, and Sidecar chart
    const t0 = Date.parse("2026-11-20T14:00:00Z");
    const steps20 = [];
    let ctx = 10000;
    const toolSeq = [
      { name: "read_file", args: { Path: "src/huge.ts", StartLine: 1, EndLine: 400 }, delta: 25000 },
      { name: "run_command", args: { CommandLine: "npm test" }, delta: 18000 },
      { name: "call_mcp_tool", args: { ToolName: "ctx_execute", Arguments: { intent: "parse-log" } }, delta: 12000 },
      { name: "read_file", args: { Path: "src/tiny.ts" }, delta: 1500 }
    ];
    for (let turn = 1; turn <= 20; turn++) {
      const prevTool =
        turn <= toolSeq.length
          ? toolSeq[turn - 1]
          : { name: "read_file", args: { Path: `src/mod_${turn}.ts`, StartLine: 1, EndLine: 40 } };
      const delta = turn === 1 ? 0 : turn <= 5 ? toolSeq[turn - 2].delta : 1200;
      const isBustTurn = turn === 12;
      const cacheRead = turn === 1 ? 0 : isBustTurn ? 0 : ctx;
      const inputTok = turn === 1 ? ctx : isBustTurn ? ctx + delta : delta;
      ctx = cacheRead + inputTok;
      steps20.push({
        type: "PLANNER_RESPONSE",
        step_index: turn * 2,
        created_at: new Date(t0 + turn * 15000).toISOString(),
        model: "claude-sonnet-4",
        input_tokens: inputTok,
        cache_read_tokens: cacheRead,
        output_tokens: 150,
        tool_calls: [{ name: prevTool.name, args: prevTool.args }]
      });
      steps20.push({ type: "GENERIC", content: "ok" });
    }

    const diag20 = analyzeTranscriptCache(steps20, { nowMs: t0 + 20 * 15000 + 10000 });
    assert.equal(diag20.turnsWithUsage, 20);
    assert.equal(diag20.recentTurns.length, 15, "recentTurns must keep at most last 15 turns");
    assert.equal(diag20.recentTurns[0].turn, 6);
    assert.equal(diag20.recentTurns[14].turn, 20);
    assert.equal(diag20.topContextDeltas.length, 3);
    assert.equal(diag20.topContextDeltas[0].deltaTokens, 25000);
    assert.ok(diag20.topContextDeltas[0].label.includes("read_file(src/huge.ts"));
    assert.equal(diag20.topContextDeltas[1].deltaTokens, 18000);
    assert.equal(diag20.topContextDeltas[2].deltaTokens, 12000);

    const trend = renderHitRateAsciiTrend(diag20.recentTurns);
    assert.ok(trend && trend.strip.length === 17, "15 chars + brackets");
    assert.ok(/^[\x20-\x7E]+$/.test(trend.line), "ASCII trend bar must be pure 7-bit ASCII");
    assert.ok(trend.strip.includes("!"), "Bust turn #12 must be marked with !");

    const md = formatCacheDiagMarkdown(diag20);
    assert.ok(md.includes("### Recent Turns Hit-Rate Trend (ASCII)"));
    assert.ok(md.includes("### Top-3 Context Growth Steps (Tool Attribution)"));
    assert.ok(md.includes("read_file(src/huge.ts"));

    const agg = analyzeMultipleSessionsCache([steps20], { nowMs: t0 + 320000 });
    assert.equal(agg.recentTurns.length, 15);
    assert.equal(agg.topContextDeltas.length, 3);

    // Sidecar server exposes recentTurns / topContextDeltas / loopWatch / modelProfile and HTML chart DOM IDs
    const fakeHome = path.join(tmpDir, "fake-home");
    const convId = "opt6-sidecar-conv";
    const logDir = path.join(fakeHome, ".gemini", "antigravity", "brain", convId, ".system_generated", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, "transcript.jsonl"), steps20.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");

    const port = 38400 + Math.floor(Math.random() * 400);
    const serverProc = spawn(process.execPath, [path.join(ROOT, "sidecars", "dashboard", "server.mjs")], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        USERPROFILE: fakeHome,
        HOME: fakeHome,
        AGY_DART_DB_PATH: tmpDb,
        AGY_DART_DISABLE_COMPILE_CACHE: "1",
        SIDECAR_FORCE_HTTP: "1",
        PORT: String(port)
      }
    });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Sidecar startup timed out")), 5000);
        serverProc.stdout.on("data", (d) => {
          if (d.toString("utf8").includes("listening")) {
            clearTimeout(timer);
            resolve();
          }
        });
        serverProc.on("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`Sidecar exited prematurely: ${code}`));
        });
      });

      const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
      const token = html.match(/<meta name="agy-dart-token" content="([a-f0-9]+)">/i)?.[1];
      assert.ok(token, "Sidecar HTML must inject agy-dart-token meta");
      const authHeaders = { headers: { "X-Agy-Dart-Token": token } };

      const kvJson = await (
        await fetch(`http://127.0.0.1:${port}/api/cache-diag?scope=conversation&conversationId=${convId}`, authHeaders)
      ).json();
      assert.equal(kvJson.transcriptFound, true);
      assert.equal(kvJson.recentTurns.length, 15);
      assert.equal(kvJson.topContextDeltas.length, 3);
      assert.equal(kvJson.modelProfile.id, "claude-200k");
      assert.equal(kvJson.loopWatch.status, "ok");

      assert.ok(html.includes('id="kv-turns-chart-row"'));
      assert.ok(html.includes('id="kv-turns-bars"'));
      assert.ok(html.includes('id="kv-top-deltas-row"'));
      assert.ok(html.includes('id="kv-loop-badge"'));
      assert.ok(html.includes('id="kv-loop-row"'));
      assert.ok(html.includes('id="kv-model-badge"'));
    } finally {
      serverProc.kill("SIGTERM");
    }

    // Verify installer copies new context/lib/security.js and passes doctor on isolated target
    const installDir = path.join(tmpDir, "installed-plugin");
    const inst = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts", "install.mjs"), "install", "--target", installDir, "--mode", "balanced-16k"],
      { encoding: "utf8", windowsHide: true, env: { ...process.env, AGY_DART_DISABLE_COMPILE_CACHE: "1" } }
    );
    assert.equal(inst.status, 0, `${inst.stdout}\n${inst.stderr}`);
    assert.ok(fs.existsSync(path.join(installDir, "context", "lib", "security.js")));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Hardening regressions: SSRF IPv6/dual-stack/slowloris, lowercase/URL secrets, doom-loop FP & multi-session order, strict <=8.8KB JSON, partial PostToolUse & concurrency", async () => {
  // 1. Extended IPv6 SSRF ranges (RFC 2765 IPv4-translated, Teredo, benchmarking, ORCHID) + multi-dot hostnames
  for (const ip of [
    "::ffff:0:127.0.0.1",
    "::ffff:0:169.254.169.254",
    "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    "2001:0:0:0::80ff:fffe",
    "2001:2::1",
    "2001:10::1",
    "2001:20::1"
  ]) {
    assert.equal(isPrivateOrReservedIp(ip), true, `Expected ${ip} to be blocked`);
  }
  assert.equal(isBlockedHostname("localhost.."), true);
  assert.equal(isBlockedHostname("metadata.google.internal.."), true);

  // 2. Lowercase / camelCase / PGP secret redaction without false positives on code expressions
  const mixedPayload = [
    JSON.stringify({
      api_key: "live_lowercase_secret_1234567890",
      clientSecret: "camelCaseSecretValue1234567890",
      access_token: "lower_access_token_1234567890",
      db_password: "MyProdPassword2026!"
    }),
    "-----BEGIN PGP PRIVATE KEY BLOCK-----\nabc123xyz\n-----END PGP PRIVATE KEY BLOCK-----",
    "const apiKey = process.env.OPENAI_API_KEY;",
    "const clientSecret = loadClientSecret();",
    "const dbPassword = config.dbPassword;"
  ].join("\n");
  const red = redactSecrets(mixedPayload, { force: true });
  assert.equal(red.redactedCount, 5);
  assert.ok(!red.text.includes("live_lowercase_secret_1234567890"));
  assert.ok(!red.text.includes("camelCaseSecretValue1234567890"));
  assert.ok(!red.text.includes("lower_access_token_1234567890"));
  assert.ok(!red.text.includes("MyProdPassword2026!"));
  assert.ok(!red.text.includes("abc123xyz"));
  assert.ok(red.text.includes("process.env.OPENAI_API_KEY"), "Code expressions must not be falsely redacted");
  assert.ok(red.text.includes("loadClientSecret()"), "Function calls must not be falsely redacted");
  assert.ok(red.text.includes("config.dbPassword"), "Config property access must not be falsely redacted");
  assert.equal(sanitizeUrlForDisplay("https://alice:SuperSecret999@example.com/path?a=1"), "https://example.com/path?a=1");

  // 3. fetchUrlText: dual-stack IPv4 fallback, slowloris overall deadline, 307 without Location, stalled 302 body, URL creds strip
  const server = http.createServer((req, res) => {
    if (req.url === "/ok") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("dual-stack-ok");
    } else if (req.url === "/redir-no-loc") {
      res.writeHead(307);
      res.end("missing location");
    } else if (req.url === "/redir-stalled") {
      res.writeHead(302, { Location: "/ok" });
      res.write("chunked-body-never-ends");
    } else if (req.url === "/slow") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      let n = 0;
      const iv = setInterval(() => {
        n++;
        res.write("x");
        if (n >= 15) {
          clearInterval(iv);
          res.end();
        }
      }, 120);
      req.on("close", () => clearInterval(iv));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-hard-"));
  const tmpDb = path.join(tmpDir, "context.db");

  try {
    // Dual-stack fallback: DNS returns unlistening IPv6 ::1 first, then listening IPv4 127.0.0.1
    const dualBody = await fetchUrlText(`http://dualstack.example.test:${port}/ok`, {
      allowPrivate: true,
      lookupFn: async () => [
        { address: "::1", family: 6 },
        { address: "127.0.0.1", family: 4 }
      ]
    });
    assert.equal(dualBody, "dual-stack-ok");

    // 307 without Location must reject
    await assert.rejects(
      () => fetchUrlText(`http://127.0.0.1:${port}/redir-no-loc`, { allowPrivate: true }),
      /redirect missing Location/i
    );

    // 302 with unclosed/stalled body must follow immediately and destroy socket cleanly
    const stalledRedir = await fetchUrlText(`http://127.0.0.1:${port}/redir-stalled`, {
      allowPrivate: true,
      timeoutMs: 1500
    });
    assert.equal(stalledRedir, "dual-stack-ok");

    // Slowloris trickle must hit overall deadline timeout
    const tSlow = Date.now();
    await assert.rejects(
      () => fetchUrlText(`http://127.0.0.1:${port}/slow`, { allowPrivate: true, timeoutMs: 400 }),
      /Request timed out/i
    );
    assert.ok(Date.now() - tSlow < 1400, "Slowloris timeout must enforce overall deadline");

    // ctx_index(url) strips credentials from label & event path; ctx_index(.env) with disabled redaction gives accurate warning
    const store = new ContextModeStore({ dbPath: tmpDb });
    const tools = createTools({ store, getCwd: () => tmpDir, getSessionId: () => "hard-sess" });
    const prevAllowPriv = process.env.AGY_DART_ALLOW_PRIVATE_URLS;
    process.env.AGY_DART_ALLOW_PRIVATE_URLS = "1";
    try {
      const idxUrl = await tools.ctx_index({ url: `http://alice:SuperSecret999@127.0.0.1:${port}/ok` });
      assert.ok(!idxUrl.label.includes("SuperSecret999"), "Returned label must not contain URL password");
      const evs = store.getResumeState("hard-sess", 5).recentEvents;
      assert.ok(!String(evs[0]?.path || "").includes("SuperSecret999"), "Event path must not store URL password");
    } finally {
      if (prevAllowPriv === undefined) delete process.env.AGY_DART_ALLOW_PRIVATE_URLS;
      else process.env.AGY_DART_ALLOW_PRIVATE_URLS = prevAllowPriv;
    }

    const envFile = path.join(tmpDir, ".env");
    fs.writeFileSync(envFile, "API_KEY=real_live_secret_value_123456\n", "utf8");
    const prevDis = process.env.AGY_DART_DISABLE_SECRET_REDACTION;
    process.env.AGY_DART_DISABLE_SECRET_REDACTION = "1";
    try {
      const idxDisabled = await tools.ctx_index({ path: envFile });
      assert.ok(
        idxDisabled.sensitiveFileWarning && /disabled/i.test(idxDisabled.sensitiveFileWarning),
        `Warning should accurately reflect disabled redaction, got: ${idxDisabled.sensitiveFileWarning}`
      );
    } finally {
      if (prevDis === undefined) delete process.env.AGY_DART_DISABLE_SECRET_REDACTION;
      else process.env.AGY_DART_DISABLE_SECRET_REDACTION = prevDis;
    }

    // 4. Doom-loop false-positive guards & multi-session chronological recentTurns ordering
    const t0 = Date.parse("2026-11-20T12:00:00Z");
    const iso = (sec) => new Date(t0 + sec * 1000).toISOString();

    // 4a. Healthy TDD (edit distinct files + passing npm test x4) -> status: "ok"
    const tddSteps = ["a.js", "b.js", "c.js", "d.js"].flatMap((f, i) => [
      {
        type: "PLANNER_RESPONSE",
        step_index: i * 4 + 1,
        created_at: iso(i * 20),
        model: "claude-sonnet-4",
        input_tokens: 1000,
        cache_read_tokens: 20000,
        tool_calls: [{ name: "edit_file", args: { Path: f, Target: "1", Replacement: "2" } }]
      },
      { type: "GENERIC", content: `Edited ${f}` },
      {
        type: "PLANNER_RESPONSE",
        step_index: i * 4 + 3,
        created_at: iso(i * 20 + 5),
        model: "claude-sonnet-4",
        input_tokens: 1000,
        cache_read_tokens: 21000,
        tool_calls: [{ name: "run_command", args: { CommandLine: "npm test" } }]
      },
      { type: "GENERIC", content: "✔ handles 1 failed case properly\npass 32\nfail 0", exit_code: 0 }
    ]);
    const tddDiag = analyzeTranscriptCache(tddSteps, { nowMs: t0 + 100000 });
    assert.equal(tddDiag.loopWatch.status, "ok", `Healthy TDD must not false-positive: ${JSON.stringify(tddDiag.loopWatch)}`);
    assert.equal(tddDiag.loopWatch.editFailOscillations, 0);

    // 4b. Normal multi-turn finish({}) calls must not trigger repeat_loop
    const finishSteps = [1, 2, 3, 4].flatMap((n) => [
      { type: "USER_INPUT", content: `q${n}` },
      {
        type: "PLANNER_RESPONSE",
        step_index: n * 2,
        created_at: iso(n * 10),
        model: "claude-sonnet-4",
        input_tokens: 1000,
        cache_read_tokens: 10000,
        tool_calls: [{ name: "finish", args: {} }]
      },
      { type: "GENERIC", content: "done" }
    ]);
    assert.equal(analyzeTranscriptCache(finishSteps, { nowMs: t0 + 100000 }).loopWatch.status, "ok");

    // 4c. Single edit+verify FAIL followed by diagnostic test run (no new edit) must count as 1 oscillation, not 2
    const singleOsc = [
      {
        type: "PLANNER_RESPONSE",
        step_index: 1,
        created_at: iso(1),
        model: "claude-sonnet-4",
        input_tokens: 1000,
        cache_read_tokens: 20000,
        tool_calls: [{ name: "apply_edits", args: { edits: [{ path: "a.js" }], verify: "npm test" } }]
      },
      { type: "GENERIC", content: "Verify [FAIL exit 1] `npm test`: AssertionError" },
      {
        type: "PLANNER_RESPONSE",
        step_index: 2,
        created_at: iso(5),
        model: "claude-sonnet-4",
        input_tokens: 1000,
        cache_read_tokens: 21000,
        tool_calls: [{ name: "run_command", args: { CommandLine: "npm test -- --verbose" } }]
      },
      { type: "GENERIC", content: "AssertionError", exit_code: 1 }
    ];
    assert.equal(analyzeTranscriptCache(singleOsc, { nowMs: t0 + 100000 }).loopWatch.editFailOscillations, 1);

    // 4d. Multi-session newest-first input (like benchmark --recent N) must sort recentTurns chronologically
    const newestSess = [
      {
        type: "PLANNER_RESPONSE",
        step_index: 1,
        created_at: "2026-11-20T15:00:00.000Z",
        model: "claude-sonnet-4",
        input_tokens: 100,
        cache_read_tokens: 9900
      }
    ];
    const oldestSess = Array.from({ length: 15 }, (_, k) => ({
      type: "PLANNER_RESPONSE",
      step_index: k + 1,
      created_at: new Date(Date.parse("2026-11-19T10:00:00.000Z") + k * 1000).toISOString(),
      model: "claude-sonnet-4",
      input_tokens: 9000,
      cache_read_tokens: 1000
    }));
    const multiChrono = analyzeMultipleSessionsCache([newestSess, oldestSess]);
    assert.equal(multiChrono.recentTurns.length, 15);
    assert.equal(
      multiChrono.recentTurns[multiChrono.recentTurns.length - 1].at,
      "2026-11-20T15:00:00.000Z",
      "recentTurns must end with the chronologically newest turn"
    );

    // 5. Strict <= 8.8 KB UTF-8 JSON ceiling on ctx_resume (giant CJK), ctx_execute & ctx_batch (newline escaping)
    const cjkTools = createTools({ store, getCwd: () => tmpDir, getSessionId: () => "giant-cjk-sess" });
    for (let i = 0; i < 3; i++) {
      store.recordModifiedFiles("giant-cjk-sess", ["中文路径".repeat(300) + `${i}.ts`]);
    }
    store.recordVerificationResult("giant-cjk-sess", {
      kind: "test",
      command: "测试".repeat(70),
      exitCode: 1,
      passed: false,
      summary: "错误".repeat(110)
    });
    store.recordVerificationResult("giant-cjk-sess", {
      kind: "build",
      command: "构建".repeat(70),
      exitCode: 1,
      passed: false,
      summary: "异常".repeat(110)
    });
    const resumeBig = await cjkTools.ctx_resume();
    const resumeBigBytes = Buffer.byteLength(JSON.stringify(resumeBig, null, 2), "utf8");
    assert.ok(resumeBigBytes <= 8800, `ctx_resume exceeded 8800 UTF-8 bytes: ${resumeBigBytes}`);

    const execNl = await cjkTools.ctx_execute({
      language: "nodejs",
      code: 'process.stdout.write("a\\n".repeat(4000));'
    });
    const execNlBytes = Buffer.byteLength(JSON.stringify(execNl, null, 2), "utf8");
    assert.ok(execNlBytes <= 8800, `ctx_execute with 4000 newlines exceeded 8800 UTF-8 bytes: ${execNlBytes}`);

    const batchNl = await cjkTools.ctx_batch({
      commands: ['node -e "process.stdout.write(\'b\\n\'.repeat(4000))"']
    });
    const batchNlBytes = Buffer.byteLength(JSON.stringify(batchNl, null, 2), "utf8");
    assert.ok(batchNlBytes <= 8800, `ctx_batch with 4000 newlines exceeded 8800 UTF-8 bytes: ${batchNlBytes}`);

    // 6. hooks.json matches direct run_checks; PostToolUse partial bestEffort & failed edits; 16-process concurrent cold DB
    const hooksCfg = JSON.parse(fs.readFileSync(path.join(ROOT, "hooks.json"), "utf8"));
    const postMatcher = new RegExp(`^(?:${hooksCfg["agy-dart-lifecycle"].PostToolUse[0].matcher})$`);
    assert.equal(postMatcher.test("mcp_agy-dart_fast_run_checks"), true, "PostToolUse matcher must cover direct run_checks");

    runHook(
      "hooks/post-tool-use.mjs",
      {
        conversationId: "partial-sess",
        cwd: tmpDir,
        toolCall: {
          name: "apply_edits",
          args: {
            cwd: tmpDir,
            bestEffort: true,
            edits: [
              { path: "src/ok.js", hunks: [] },
              { path: "src/failed.js", hunks: [] }
            ]
          }
        },
        toolResponse:
          "Partial edit applied (1/2 file(s) written; 1 file(s) failed — do NOT re-send applied files):\n\nApplied:\n- src/ok.js: updated (1 match), lines +1\n\nFailed (fix only these):\n- src/failed.js: target not found"
      },
      tmpDb
    );
    runHook(
      "hooks/post-tool-use.mjs",
      {
        conversationId: "partial-sess",
        cwd: tmpDir,
        toolCall: { name: "edit_file", args: { Path: path.join(tmpDir, "src", "err.js") } },
        isError: true,
        toolResponse: "Encountered error in step execution: target not found"
      },
      tmpDb
    );
    const partialCp = store.getSessionCheckpoint("partial-sess");
    assert.deepEqual(partialCp.modifiedFiles, ["src/ok.js"], "Only actually-applied files may be recorded");
    store.close();

    // 16 parallel processes (12 PostToolUse + 4 cli-filter) writing to a brand-new cold SQLite DB
    const concDb = path.join(tmpDir, "concurrent-cold.db");
    const concSid = "conc-cold-sess";
    const enc = (s) => `b:${Buffer.from(s, "utf8").toString("base64url")}`;
    const workers = [
      ...Array.from({ length: 12 }, (_, i) =>
        new Promise((resolve) => {
          const child = spawn(process.execPath, [path.join(ROOT, "hooks", "post-tool-use.mjs")], {
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            env: { ...process.env, AGY_DART_DB_PATH: concDb, AGY_DART_DISABLE_COMPILE_CACHE: "1" }
          });
          child.on("close", (code) => resolve(code));
          child.stdin.end(
            JSON.stringify({
              conversationId: concSid,
              cwd: tmpDir,
              toolCall: { name: "edit_file", args: { Path: path.join(tmpDir, `src/c_${i}.js`) } }
            })
          );
        })
      ),
      ...Array.from({ length: 4 }, (_, j) =>
        new Promise((resolve) => {
          const child = spawn(
            process.execPath,
            [
              path.join(ROOT, "hooks", "cli-filter.mjs"),
              "--rule",
              j % 2 === 0 ? "test-runner" : "build-lint",
              "--b64",
              enc(`node -e "console.log('ok_${j}')"`),
              "--orig-b64",
              enc(j % 2 === 0 ? `npm test ${j}` : `npm run build ${j}`),
              "--session",
              enc(concSid)
            ],
            {
              cwd: tmpDir,
              stdio: ["ignore", "pipe", "pipe"],
              windowsHide: true,
              env: { ...process.env, AGY_DART_DB_PATH: concDb, AGY_DART_DISABLE_COMPILE_CACHE: "1" }
            }
          );
          child.on("close", (code) => resolve(code));
        })
      )
    ];
    const codes = await Promise.all(workers);
    assert.ok(codes.every((c) => c === 0), `All concurrent hook exits must be 0, got: ${codes.join(",")}`);
    const concStore = new ContextModeStore({ dbPath: concDb });
    const concCp = concStore.getSessionCheckpoint(concSid);
    assert.equal(concCp.modifiedFileCount, 12, "Concurrent writes must never drop a modified file");
    assert.ok(concCp.lastTest && concCp.lastTest.ok === true);
    assert.ok(concCp.lastBuild && concCp.lastBuild.ok === true);
    concStore.close();
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("run_checks keeps both ends of failed commands under character and JSON-RPC byte limits", async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agy-failure-ends-"));
  let client = null;
  t.after(async () => {
    if (client) await client.close();
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  fs.writeFileSync(path.join(cwd, "fail.cjs"), [
    "const name = process.argv[2];",
    'console.error("setup begins " + name);',
    'const line = "error " + ("中🧪" + String.fromCharCode(34, 92)).repeat(32) + "\\n";',
    'process.stderr.write(line.repeat(name === "large" ? 7500 : 80));',
    'console.error("final cause " + name);',
    "process.exitCode = 1;"
  ].join("\n"));
  client = createPersistentMcpClient(path.join(ROOT, "fast", "mcp-server.mjs"), { AGY_DART_DB_PATH: path.join(cwd, "fast-test.db") });
  for (const outputMode of ["compact", "full"]) {
    for (const maxChars of [1000, 8800]) {
      const response = await client.request("tools/call", { name: "run_checks", arguments: {
        cwd, commands: ["node fail.cjs large", "node fail.cjs small"], outputMode, maxChars
      } });
      assert.equal(response.result.isError, false);
      const text = response.result.content[0].text;
      assert.match(text, /2 failed/);
      for (const name of ["large", "small"]) {
        assert.ok(text.includes("setup begins " + name), text);
        assert.ok(text.includes("final cause " + name), text);
      }
      assert.match(text, /truncated/);
      assert.ok(text.isWellFormed());
      assert.ok(text.length <= maxChars);
      assert.ok(Buffer.byteLength(JSON.stringify(response) + "\n") <= 8800);
    }
  }
});
