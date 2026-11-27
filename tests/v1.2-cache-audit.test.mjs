import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  auditEnvironmentCache,
  estimateTokens,
  formatCacheAuditMarkdown,
  inspectHookSource
} from "../scripts/cache-audit.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const AUDIT_SCRIPT = path.join(ROOT, "scripts", "cache-audit.mjs");

function makeTempEnv(prefix = "agy-dart-audit-test-") {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const configDir = path.join(baseDir, "config");
  const workspaceDir = path.join(baseDir, "workspace");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  return {
    baseDir,
    configDir,
    workspaceDir,
    cleanup() {
      fs.rmSync(baseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  };
}

function stageAgyDartPlugin(destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const rel of [
    "plugin.json",
    "package.json",
    "mcp_config.json",
    "hooks.json",
    "rules",
    "skills",
    "hooks",
    "fast",
    "context"
  ]) {
    fs.cpSync(path.join(ROOT, rel), path.join(destDir, rel), { recursive: true });
  }
}

function writeMockMcpServer(scriptPath, mode, stateFile = "") {
  const code = `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

const MODE = ${JSON.stringify(mode)};
const STATE_FILE = ${JSON.stringify(stateFile)};

function buildTools() {
  const baseTools = [
    {
      description: "Alpha tool for deterministic checks.",
      inputSchema: { properties: { query: { type: "string" } }, required: ["query"], type: "object" },
      name: "alpha_search"
    },
    {
      description: "Beta tool for deterministic checks.",
      inputSchema: { properties: { path: { type: "string" } }, required: ["path"], type: "object" },
      name: "beta_read"
    },
    {
      description: "Gamma tool for deterministic checks.",
      inputSchema: { properties: { limit: { type: "integer" } }, type: "object" },
      name: "gamma_stats"
    }
  ];

  if (MODE === "deterministic") {
    return baseTools;
  }

  if (MODE === "unsorted_deterministic") {
    return [baseTools[2], baseTools[0], baseTools[1]];
  }

  if (MODE === "non_deterministic") {
    let run = 0;
    try {
      run = Number.parseInt(fs.readFileSync(STATE_FILE, "utf8"), 10) || 0;
    } catch {}
    fs.writeFileSync(STATE_FILE, String(run + 1), "utf8");
    // Flip order deterministically between Run 1 and Run 2 so test is 100% non-flaky
    return run % 2 === 0 ? [baseTools[0], baseTools[1], baseTools[2]] : [baseTools[2], baseTools[0], baseTools[1]];
  }

  if (MODE === "bloated") {
    const out = [];
    for (let i = 0; i < 30; i++) {
      const idx = String(i).padStart(2, "0");
      out.push({
        description: "Verbose enterprise schema description ".repeat(14) + "tool_" + idx,
        inputSchema: {
          properties: {
            argA: { description: "Detailed parameter documentation ".repeat(6), type: "string" },
            argB: { description: "Additional nested constraint text ".repeat(6), type: "string" }
          },
          type: "object"
        },
        name: "bloated_tool_" + idx
      });
    }
    return out;
  }

  return baseTools;
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (msg.id === undefined) return;
  if (MODE === "hang") {
    // Intentionally never reply to test timeout + clean child termination
    return;
  }
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "mock-" + MODE, version: "1.0.0" }
      }
    }) + "\\n");
  } else if (msg.method === "tools/list") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: { tools: buildTools() }
    }) + "\\n");
  }
});
`;
  fs.writeFileSync(scriptPath, code, "utf8");
}

test("1. Clean healthy agy-dart setup scores 100 (Grade A) with live dual-MCP verification and zero false-positive hook warnings", async () => {
  const env = makeTempEnv("agy-dart-clean-");
  try {
    const pluginDir = path.join(env.configDir, "plugins", "agy-dart");
    stageAgyDartPlugin(pluginDir);

    const report = await auditEnvironmentCache({
      workspace: env.workspaceDir,
      configDir: env.configDir,
      live: true,
      timeoutMs: 6000
    });

    assert.equal(report.score, 100, `Expected score 100, got findings: ${JSON.stringify(report.findings, null, 2)}`);
    assert.equal(report.grade, "A");
    assert.equal(report.findings.length, 0);

    // Check 1: rules/AGENTS.md & skills/agy-dart/SKILL.md discovered
    assert.equal(report.prefix.ruleCount, 1);
    assert.equal(report.prefix.skillCount, 1);
    assert.ok(report.prefix.ruleTokens > 0 && report.prefix.ruleTokens < 400);
    assert.ok(report.prefix.skillFrontmatterTokens > 10 && report.prefix.skillFrontmatterTokens < 200);

    // Check 2: fast & context MCP servers both probed twice and 100% deterministic & canonical
    assert.equal(report.mcp.probedCount, 2);
    assert.equal(report.mcp.deterministicCount, 2);
    assert.equal(report.mcp.nonDeterministicCount, 0);
    const fastSrv = report.mcp.servers.find((s) => s.name === "fast");
    const ctxSrv = report.mcp.servers.find((s) => s.name === "context");
    assert.ok(fastSrv && fastSrv.deterministic === true && fastSrv.canonical === true && fastSrv.toolCount === 4);
    assert.ok(ctxSrv && ctxSrv.deterministic === true && ctxSrv.canonical === true && ctxSrv.toolCount === 8);
    assert.equal(fastSrv.rawSha256, fastSrv.rawSha256Run2);
    assert.equal(ctxSrv.rawSha256, ctxSrv.rawSha256Run2);

    // Check 3: agy-dart PreInvocation recognized as UI-only safe (zero prefix pollution), Stop hook clean, zero hook warnings
    assert.equal(report.hooks.hookCount, 5);
    const preInv = report.hooks.entries.find((e) => e.event === "PreInvocation");
    assert.ok(preInv, "PreInvocation hook should be audited");
    assert.equal(preInv.uiOnlySafe, true);
    assert.equal(preInv.status, "ui_only_safe");
    assert.equal(preInv.writesNonEmptySystemMessage, false);
    assert.equal(preInv.injectsDynamicSystemMessage, false);
    const stopHook = report.hooks.entries.find((e) => e.event === "Stop");
    assert.ok(stopHook, "Stop hook should be audited");
    assert.equal(stopHook.writesNonEmptySystemMessage, false);
  } finally {
    env.cleanup();
  }
});

test("2. Mock non-deterministic MCP server is caught as critical non_deterministic_tools_list, while deterministic & remote servers are handled cleanly", async () => {
  const env = makeTempEnv("agy-dart-mcp-det-");
  try {
    const detScript = path.join(env.baseDir, "det-mcp.mjs");
    const nonDetScript = path.join(env.baseDir, "nondet-mcp.mjs");
    const unsortedScript = path.join(env.baseDir, "unsorted-mcp.mjs");
    const bloatedScript = path.join(env.baseDir, "bloated-mcp.mjs");
    const stateFile = path.join(env.baseDir, "nondet-counter.txt");

    writeMockMcpServer(detScript, "deterministic");
    writeMockMcpServer(nonDetScript, "non_deterministic", stateFile);
    writeMockMcpServer(unsortedScript, "unsorted_deterministic");
    writeMockMcpServer(bloatedScript, "bloated");

    fs.writeFileSync(
      path.join(env.configDir, "mcp_config.json"),
      JSON.stringify(
        {
          mcpServers: {
            "stable-server": { command: "node", args: [detScript] },
            "flaky-order-server": { command: "node", args: [nonDetScript] },
            "unsorted-server": { command: "node", args: [unsortedScript] },
            "bloated-server": {
              command: "node",
              args: [bloatedScript],
              tools: Object.fromEntries(
                Array.from({ length: 20 }, (_, i) => [
                  `bloated_tool_${String(i).padStart(2, "0")}`,
                  { eager: true }
                ])
              )
            },
            "remote-http-server": { serverUrl: "https://mcp.example.com/mcp" }
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const report = await auditEnvironmentCache({
      workspace: env.workspaceDir,
      configDir: env.configDir,
      live: true,
      timeoutMs: 4000
    });

    // Deterministic server passes cleanly
    const stableSrv = report.mcp.servers.find((s) => s.name === "stable-server");
    assert.equal(stableSrv.status, "ok");
    assert.equal(stableSrv.deterministic, true);
    assert.equal(stableSrv.canonical, true);
    assert.equal(stableSrv.rawSha256, stableSrv.rawSha256Run2);

    // Non-deterministic server flagged as critical
    const flakySrv = report.mcp.servers.find((s) => s.name === "flaky-order-server");
    assert.equal(flakySrv.status, "non_deterministic");
    assert.equal(flakySrv.deterministic, false);
    assert.notEqual(flakySrv.rawSha256, flakySrv.rawSha256Run2);
    assert.equal(flakySrv.canonicalSha256, flakySrv.canonicalSha256Run2);

    const critFinding = report.findings.find(
      (f) => f.code === "non_deterministic_tools_list" && f.target.includes("flaky-order-server")
    );
    assert.ok(critFinding, "Must emit non_deterministic_tools_list finding");
    assert.equal(critFinding.severity, "critical");

    // Unsorted but deterministic server flagged as info non_canonical_tools_schema
    const unsortedFinding = report.findings.find(
      (f) => f.code === "non_canonical_tools_schema" && f.target.includes("unsorted-server")
    );
    assert.ok(unsortedFinding, "Must emit non_canonical_tools_schema for unsorted deterministic server");
    assert.equal(unsortedFinding.severity, "info");

    // Bloated server flagged as warn bloated_mcp_schema
    const bloatedSrv = report.mcp.servers.find((s) => s.name === "bloated-server");
    assert.ok(bloatedSrv.tokens > 3000);
    const bloatFinding = report.findings.find(
      (f) => f.code === "bloated_mcp_schema" && f.target.includes("bloated-server")
    );
    assert.ok(bloatFinding, "Must emit bloated_mcp_schema warning");
    assert.equal(bloatFinding.severity, "warn");

    // Remote HTTP/SSE entry cleanly skipped
    const remoteSrv = report.mcp.servers.find((s) => s.name === "remote-http-server");
    assert.equal(remoteSrv.status, "skipped_remote");
    assert.equal(remoteSrv.transport, "remote");
    assert.equal(report.mcp.skippedRemoteCount, 1);

    // Score reflects 1 critical (-20) + 1 warn (-8) + 1 info (-2) = 70 (Grade C)
    assert.equal(report.score, 70);
    assert.equal(report.grade, "C");
  } finally {
    env.cleanup();
  }
});

test("3. Hanging MCP server respects bounded timeout and terminates child cleanly without hanging", async () => {
  const env = makeTempEnv("agy-dart-mcp-timeout-");
  try {
    const hangScript = path.join(env.baseDir, "hang-mcp.mjs");
    writeMockMcpServer(hangScript, "hang");

    fs.writeFileSync(
      path.join(env.configDir, "mcp_config.json"),
      JSON.stringify({ mcpServers: { "hang-server": { command: "node", args: [hangScript] } } }),
      "utf8"
    );

    const t0 = Date.now();
    const report = await auditEnvironmentCache({
      workspace: env.workspaceDir,
      configDir: env.configDir,
      live: true,
      timeoutMs: 350
    });
    const elapsed = Date.now() - t0;

    assert.ok(elapsed < 3000, `Expected bounded timeout termination, took ${elapsed}ms`);
    const srv = report.mcp.servers.find((s) => s.name === "hang-server");
    assert.equal(srv.status, "timeout");
    assert.equal(report.mcp.errorCount, 1);
    assert.ok(report.findings.some((f) => f.code === "mcp_probe_failed" && f.severity === "info"));
  } finally {
    env.cleanup();
  }
});

test("4. Legacy plugin conflicts (agy-dart + agy-fast + antigravity-plugin-context-mode) are flagged, while disabled plugins are ignored", async () => {
  const env = makeTempEnv("agy-dart-conflict-");
  try {
    for (const name of ["agy-dart", "agy-fast", "antigravity-plugin-context-mode"]) {
      const dir = path.join(env.configDir, "plugins", name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ name }), "utf8");
    }

    const reportActive = await auditEnvironmentCache({
      workspace: env.workspaceDir,
      configDir: env.configDir,
      live: false
    });

    const conflicts = reportActive.findings.filter((f) => f.code === "plugin_conflict");
    assert.equal(conflicts.length, 2, "Both agy-fast and antigravity-plugin-context-mode must be flagged");
    assert.ok(conflicts.every((f) => f.severity === "warn"));
    assert.ok(conflicts.some((f) => f.target.includes("agy-fast")));
    assert.ok(conflicts.some((f) => f.target.includes("antigravity-plugin-context-mode")));
    assert.equal(reportActive.hooks.conflicts.length, 2);

    // Disabling both legacy plugins in config.json resolves conflicts cleanly
    fs.writeFileSync(
      path.join(env.configDir, "config.json"),
      JSON.stringify({
        plugins: {
          "agy-fast": { enabled: false },
          "antigravity-plugin-context-mode": { enabled: false }
        }
      }),
      "utf8"
    );

    const reportDisabled = await auditEnvironmentCache({
      workspace: env.workspaceDir,
      configDir: env.configDir,
      live: false
    });
    assert.equal(reportDisabled.findings.filter((f) => f.code === "plugin_conflict").length, 0);
    assert.equal(reportDisabled.hooks.disabledPlugins.length, 2);
    assert.equal(reportDisabled.score, 100);
  } finally {
    env.cleanup();
  }
});

test("5. Hooks audit flags cache-busting PreInvocation timestamp injection & missing matchers, while recognizing UI-only and internal DB timestamps as safe", async () => {
  const env = makeTempEnv("agy-dart-hooks-");
  try {
    const hooksDir = path.join(env.configDir, "hooks");
    fs.mkdirSync(hooksDir, { recursive: true });

    // Bad PreInvocation hook: injects non-empty systemMessage with dynamic ISO timestamp
    const badPreInv = path.join(hooksDir, "bad-pre-invocation.mjs");
    fs.writeFileSync(
      badPreInv,
      `
const stamp = new Date().toISOString();
const msg = \`[reminder] current time is \${stamp}\`;
process.stdout.write(JSON.stringify({
  injectSteps: [{ systemMessage: { systemMessage: msg } }]
}) + "\\n");
`,
      "utf8"
    );

    // Good PreInvocation hook: UI-only pattern (systemMessage: "" + user_markdown, even with timestamp in UI)
    const uiOnlyPreInv = path.join(hooksDir, "good-ui-only.mjs");
    fs.writeFileSync(
      uiOnlyPreInv,
      `
const ts = new Date().toISOString();
process.stdout.write(JSON.stringify({
  injectSteps: [{
    systemMessage: {
      systemMessage: "",
      metadata: { user_markdown: \`> Updated at \${ts}\` }
    }
  }]
}) + "\\n");
`,
      "utf8"
    );

    // Good SessionStart hook: uses Date.now() internally for DB/state tracking, NOT injected into systemMessage
    const goodSessionStart = path.join(hooksDir, "good-session-start.mjs");
    fs.writeFileSync(
      goodSessionStart,
      `
const internalDbTs = Date.now();
function writeAuditRow() {
  return { ts: internalDbTs, iso: new Date().toISOString() };
}
writeAuditRow();
const banner = "Static deterministic workspace rules";
process.stdout.write(JSON.stringify({
  injectSteps: [{ systemMessage: { systemMessage: banner } }]
}) + "\\n");
`,
      "utf8"
    );

    // Bad SessionStart hook: injects crypto.randomUUID() into systemMessage via helper function
    const badSessionStart = path.join(hooksDir, "bad-session-start.mjs");
    fs.writeFileSync(
      badSessionStart,
      `
import { randomUUID } from "node:crypto";
function buildHeader() {
  return "Session nonce: " + randomUUID();
}
process.stdout.write(JSON.stringify({
  injectSteps: [{ systemMessage: { systemMessage: buildHeader() } }]
}) + "\\n");
`,
      "utf8"
    );

    // PreToolUse hook without matcher
    const noMatcherPreTool = path.join(hooksDir, "pre-tool-nomatcher.mjs");
    fs.writeFileSync(noMatcherPreTool, `process.stdout.write('{"decision":"allow"}\\n');\n`, "utf8");

    fs.writeFileSync(
      path.join(env.configDir, "hooks.json"),
      JSON.stringify(
        {
          "test-hooks": {
            PreInvocation: [
              { type: "command", command: "node ./hooks/bad-pre-invocation.mjs" },
              { type: "command", command: "node ./hooks/good-ui-only.mjs" }
            ],
            SessionStart: [
              { type: "command", command: "node ./hooks/good-session-start.mjs" },
              { type: "command", command: "node ./hooks/bad-session-start.mjs" }
            ],
            PreToolUse: [
              { type: "command", command: "node ./hooks/pre-tool-nomatcher.mjs" }
            ]
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const report = await auditEnvironmentCache({
      workspace: env.workspaceDir,
      configDir: env.configDir,
      live: false
    });

    // Bad PreInvocation flagged for BOTH mid-session non-empty systemMessage and dynamic timestamp injection
    const badPreEntry = report.hooks.entries.find((e) => e.command.includes("bad-pre-invocation"));
    assert.equal(badPreEntry.writesNonEmptySystemMessage, true);
    assert.equal(badPreEntry.injectsDynamicSystemMessage, true);
    assert.equal(badPreEntry.status, "critical");
    assert.ok(
      report.findings.some(
        (f) => f.code === "mid_session_system_message" && f.severity === "warn" && f.target.includes("bad-pre-invocation")
      )
    );
    assert.ok(
      report.findings.some(
        (f) => f.code === "dynamic_system_message_injection" && f.severity === "critical" && f.target.includes("bad-pre-invocation")
      )
    );

    // Good UI-only PreInvocation recognized as SAFE with zero findings
    const uiOnlyEntry = report.hooks.entries.find((e) => e.command.includes("good-ui-only"));
    assert.equal(uiOnlyEntry.uiOnlySafe, true);
    assert.equal(uiOnlyEntry.status, "ui_only_safe");
    assert.equal(uiOnlyEntry.writesNonEmptySystemMessage, false);
    assert.equal(uiOnlyEntry.injectsDynamicSystemMessage, false);
    assert.ok(!report.findings.some((f) => f.target.includes("good-ui-only")));

    // Good SessionStart with internal DB timestamp has ZERO false positives
    const goodSessEntry = report.hooks.entries.find((e) => e.command.includes("good-session-start"));
    assert.equal(goodSessEntry.injectsDynamicSystemMessage, false);
    assert.equal(goodSessEntry.status, "safe");
    assert.ok(!report.findings.some((f) => f.target.includes("good-session-start")));

    // Bad SessionStart with randomUUID() is caught as critical
    const badSessEntry = report.hooks.entries.find((e) => e.command.includes("bad-session-start"));
    assert.equal(badSessEntry.injectsDynamicSystemMessage, true);
    assert.ok(badSessEntry.dynamicPatterns.includes("randomUUID"));
    assert.ok(
      report.findings.some(
        (f) => f.code === "dynamic_system_message_injection" && f.severity === "critical" && f.target.includes("bad-session-start")
      )
    );

    // Missing matcher on PreToolUse flagged as warn
    assert.ok(report.findings.some((f) => f.code === "missing_hook_matcher" && f.severity === "warn"));

    // Also unit-check shell & PowerShell hook source inspection
    const shRes = inspectHookSource('NOW=$(date -Iseconds)\necho "{\\"systemMessage\\": \\"Started $NOW\\"}"\n', ".sh");
    assert.equal(shRes.writesNonEmptySystemMessage, true);
    assert.equal(shRes.injectsDynamicSystemMessage, true);
    assert.ok(shRes.dynamicPatterns.includes("$(date)"));

    const psRes = inspectHookSource('$t = Get-Date -Format o\n@{ systemMessage = "Now: $t" } | ConvertTo-Json\n', ".ps1");
    assert.equal(psRes.writesNonEmptySystemMessage, true);
    assert.equal(psRes.injectsDynamicSystemMessage, true);
    assert.ok(psRes.dynamicPatterns.includes("Get-Date"));
  } finally {
    env.cleanup();
  }
});

test("5b. Regression checks: escaped shell JSON UI-only, JS regex literals with // or /*, and case-insensitive PowerShell hook flags", async () => {
  // 1. Escaped shell JSON with empty systemMessage + user_markdown must be uiOnlySafe
  const shUiFlat = inspectHookSource(
    'echo "{\\"systemMessage\\": \\"\\", \\"metadata\\": {\\"user_markdown\\": \\"hi\\"}}"',
    ".sh"
  );
  assert.equal(shUiFlat.uiOnlySafe, true);
  assert.equal(shUiFlat.writesNonEmptySystemMessage, false);
  assert.equal(shUiFlat.injectsDynamicSystemMessage, false);

  const shUiNested = inspectHookSource(
    'echo "{\\"injectSteps\\":[{\\"systemMessage\\":{\\"systemMessage\\":\\"\\",\\"metadata\\":{\\"user_markdown\\":\\"hi\\"}}}]}"',
    ".sh"
  );
  assert.equal(shUiNested.uiOnlySafe, true);
  assert.equal(shUiNested.writesNonEmptySystemMessage, false);

  // 2. JS regex literals containing // or /* must not blind comment stripping
  const regexSlash = inspectHookSource(
    'const x = "a".replace(/https?:\\/\\//, ""); const o = { systemMessage: Date.now() };',
    ".mjs"
  );
  assert.equal(regexSlash.writesNonEmptySystemMessage, true);
  assert.equal(regexSlash.injectsDynamicSystemMessage, true);
  assert.deepEqual(regexSlash.dynamicPatterns, ["Date.now"]);

  const regexStar = inspectHookSource(
    'const re = /foo\\/*/;\nconst o = { systemMessage: Date.now() };\n/* end */',
    ".mjs"
  );
  assert.equal(regexStar.writesNonEmptySystemMessage, true);
  assert.equal(regexStar.injectsDynamicSystemMessage, true);
  assert.deepEqual(regexStar.dynamicPatterns, ["Date.now"]);

  // Division operator followed by real line comment still strips comment cleanly
  const divisionComment = inspectHookSource(
    "const ratio = total / 2; // systemMessage: Date.now()\n",
    ".mjs"
  );
  assert.equal(divisionComment.writesNonEmptySystemMessage, false);
  assert.equal(divisionComment.injectsDynamicSystemMessage, false);

  // 3. Lowercase PowerShell flags (-executionpolicy Bypass -file ./hooks/ps-hook.ps1) resolve script path
  const env = makeTempEnv("agy-dart-ps-flags-");
  try {
    const hooksDir = path.join(env.configDir, "hooks");
    fs.mkdirSync(hooksDir, { recursive: true });
    const psHookPath = path.join(hooksDir, "ps-hook.ps1");
    fs.writeFileSync(
      psHookPath,
      '$now = Get-Date -Format o\n@{ systemMessage = "Turn at $now" } | ConvertTo-Json -Compress\n',
      "utf8"
    );
    fs.writeFileSync(
      path.join(env.configDir, "hooks.json"),
      JSON.stringify({
        "ps-test": {
          PreInvocation: [
            { type: "command", command: "pwsh -noprofile -executionpolicy Bypass -file ./hooks/ps-hook.ps1" }
          ]
        }
      }),
      "utf8"
    );

    const report = await auditEnvironmentCache({
      workspace: env.workspaceDir,
      configDir: env.configDir,
      live: false
    });

    const entry = report.hooks.entries[0];
    assert.equal(entry.scriptPath, path.resolve(psHookPath));
    assert.equal(entry.writesNonEmptySystemMessage, true);
    assert.equal(entry.injectsDynamicSystemMessage, true);
    assert.ok(entry.dynamicPatterns.includes("Get-Date"));
    assert.ok(
      report.findings.some((f) => f.code === "dynamic_system_message_injection" && f.severity === "critical")
    );
  } finally {
    env.cleanup();
  }
});

test("6. Bloated CJK rule file is accurately counted (not undercounted by chars/4) and triggers oversized & total prefix warnings", async () => {
  const env = makeTempEnv("agy-dart-cjk-");
  try {
    // 1,600 Chinese characters: naive chars/4 = 400 tokens (would MISS >1500 limit!), CJK estimator = 2,000 tokens
    const cjkSentence = "这是一段用于测试中文提示词缓存前缀体积估算的规则说明文字内容规范";
    const bloatedCjkRule = cjkSentence.repeat(50); // 32 * 50 = 1,600 CJK chars -> 2,000 est. tokens
    const naiveEstimate = Math.ceil(bloatedCjkRule.length / 4);
    const accurateEstimate = estimateTokens(bloatedCjkRule);

    assert.equal(bloatedCjkRule.length, 1600);
    assert.equal(naiveEstimate, 400);
    assert.ok(accurateEstimate >= 1600, `Expected CJK token estimate >= 1600, got ${accurateEstimate}`);

    fs.mkdirSync(path.join(env.configDir, "rules"), { recursive: true });
    fs.writeFileSync(path.join(env.configDir, "rules", "cjk-bloat.md"), bloatedCjkRule, "utf8");

    // Add a second workspace CJK rule pushing total prefix > 6,000 est. tokens
    const hugeWorkspaceCjk = cjkSentence.repeat(140); // 4,480 CJK chars -> 5,600 est. tokens
    fs.writeFileSync(path.join(env.workspaceDir, "AGENTS.md"), hugeWorkspaceCjk, "utf8");

    // Add a skill with small frontmatter and huge on-demand body (body must NOT inflate Turn-0 total)
    const skillDir = path.join(env.configDir, "skills", "demo-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: demo-skill\ndescription: Compact frontmatter\n---\n\n" + "On-demand body paragraph.\n".repeat(400),
      "utf8"
    );

    const report = await auditEnvironmentCache({
      workspace: env.workspaceDir,
      configDir: env.configDir,
      live: false
    });

    const cjkItem = report.prefix.items.find((i) => i.name.includes("cjk-bloat.md"));
    assert.ok(cjkItem);
    assert.equal(cjkItem.cjkChars, 1600);
    assert.equal(cjkItem.tokens, accurateEstimate);
    assert.ok(cjkItem.tokens > 1500);

    const skillItem = report.prefix.items.find((i) => i.kind === "skill_frontmatter");
    assert.ok(skillItem);
    assert.ok(skillItem.tokens < 40, "Only skill YAML frontmatter should count toward Turn-0");
    assert.ok(skillItem.bodyTokens > 2000, "Skill body should be tracked separately");

    const oversizedFindings = report.findings.filter((f) => f.code === "oversized_rule_file");
    assert.equal(oversizedFindings.length, 2);
    assert.ok(oversizedFindings.every((f) => f.severity === "warn"));
    assert.ok(report.findings.some((f) => f.code === "excessive_prefix_budget" && f.severity === "warn"));
  } finally {
    env.cleanup();
  }
});

test("7. CLI supports both --json and Markdown output modes, exits 0 promptly, and never hangs", () => {
  const env = makeTempEnv("agy-dart-cli-");
  try {
    const detScript = path.join(env.baseDir, "cli-det-mcp.mjs");
    writeMockMcpServer(detScript, "deterministic");
    fs.writeFileSync(
      path.join(env.configDir, "mcp_config.json"),
      JSON.stringify({ mcpServers: { "cli-det": { command: "node", args: [detScript] } } }),
      "utf8"
    );
    fs.writeFileSync(path.join(env.workspaceDir, "AGENTS.md"), "# Concise Rules\nKeep prompt prefix lean.\n", "utf8");

    // 7a. --json mode with --live
    const t0 = Date.now();
    const jsonRes = spawnSync(
      process.execPath,
      [AUDIT_SCRIPT, "--workspace", env.workspaceDir, "--config-dir", env.configDir, "--live", "--timeout", "4000", "--json"],
      { encoding: "utf8", timeout: 10000, windowsHide: true }
    );
    assert.equal(jsonRes.status, 0, `JSON CLI failed: ${jsonRes.stderr}`);
    assert.ok(Date.now() - t0 < 8000, "CLI should exit promptly");
    const parsed = JSON.parse(jsonRes.stdout);
    assert.equal(parsed.score, 100);
    assert.equal(parsed.grade, "A");
    assert.equal(parsed.mcp.probedCount, 1);
    assert.equal(parsed.mcp.deterministicCount, 1);

    // 7b. Markdown mode with --no-live
    const mdRes = spawnSync(
      process.execPath,
      [AUDIT_SCRIPT, "--workspace", env.workspaceDir, "--config-dir", env.configDir, "--no-live"],
      { encoding: "utf8", timeout: 10000, windowsHide: true }
    );
    assert.equal(mdRes.status, 0, `Markdown CLI failed: ${mdRes.stderr}`);
    assert.ok(mdRes.stdout.includes("# Prompt Cache Environment Audit"));
    assert.ok(mdRes.stdout.includes("Health Score"));
    assert.ok(mdRes.stdout.includes("100/100 (Grade A)"));
    assert.ok(mdRes.stdout.includes("## 1. Turn-0 Rules & Skills Frontmatter Prefix"));
    assert.ok(mdRes.stdout.includes("## 2. MCP Server Determinism & Schema Bloat"));
    assert.ok(mdRes.stdout.includes("## 4. Findings & Actionable Fixes"));

    // Verify exported formatCacheAuditMarkdown matches CLI Markdown rendering
    assert.equal(formatCacheAuditMarkdown(parsed).includes("# Prompt Cache Environment Audit"), true);
  } finally {
    env.cleanup();
  }
});
