import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  analyzeTranscriptCache,
  resolveModelProfile
} from "../context/lib/cache-analyzer.js";
import { ContextModeStore } from "../context/lib/store.js";
import { DEFAULT_EXEMPT_EXTENSIONS, FILE_CATEGORIES } from "../context/lib/store/schema.js";
import { WatchdogMonitor } from "../context/lib/watchdog.js";
import {
  detectSubagentFromTranscriptFile,
  isHighReasoningModel,
  isSubagentLeasePayload
} from "../context/lib/watchdog-lease.js";
import { isAgentInstructionFile, isSubagentReadPayload } from "../hooks/pre-tool-use.mjs";
import { isSubagentPayload } from "../hooks/session-start.mjs";

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

function sendFastRpc(messages, env = {}) {
  const input = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
  const childEnv = {
    ...process.env,
    AGY_DART_DISABLE_COMPILE_CACHE: "1",
    ...env
  };
  if (!Object.prototype.hasOwnProperty.call(env, "ANTIGRAVITY_CONVERSATION_ID")) {
    delete childEnv.ANTIGRAVITY_CONVERSATION_ID;
  }
  if (!Object.prototype.hasOwnProperty.call(env, "CONVERSATION_ID")) {
    delete childEnv.CONVERSATION_ID;
  }
  if (!Object.prototype.hasOwnProperty.call(env, "ANTIGRAVITY_SESSION_ID")) {
    delete childEnv.ANTIGRAVITY_SESSION_ID;
  }
  const res = spawnSync(process.execPath, [path.join(ROOT, "fast", "mcp-server.mjs")], {
    input,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
    env: childEnv
  });
  assert.equal(res.status, 0, `fast/mcp-server.mjs failed: ${res.stderr}`);
  return res.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("Wave1-1: Gemini 4 95% implicit caching, per-variant pricing, 2050-delta bust exemption, watchdog ROI floor & high-reasoning", () => {
  // 1. Per-variant pricing & cacheability thresholds (preserving profile.id backward compatibility)
  const neon = resolveModelProfile("gemini-4-neon");
  assert.equal(neon.id, "gemini-4-512k");
  assert.equal(neon.cacheDiscountRate, 0.95);
  assert.equal(neon.inputPer1M, 3.00);
  assert.equal(neon.minCacheableTokens, 4096);
  assert.equal(neon.minTurnDeltaForFullCache, 2050);

  const hydrogen = resolveModelProfile("gemini-4-hydrogen");
  assert.equal(hydrogen.id, "gemini-4-512k");
  assert.equal(hydrogen.cacheDiscountRate, 0.95);
  assert.equal(hydrogen.inputPer1M, 1.50);

  const carbon = resolveModelProfile("gemini-4-carbon");
  assert.equal(carbon.id, "gemini-4-512k");
  assert.equal(carbon.cacheDiscountRate, 0.95);
  assert.equal(carbon.inputPer1M, 4.00);

  const argon1m = resolveModelProfile("google/argon-1m");
  assert.equal(argon1m.id, "gemini-4-1m");
  assert.equal(argon1m.cacheDiscountRate, 0.95);
  assert.equal(argon1m.inputPer1M, 4.00);

  const genericG4 = resolveModelProfile("gemini-4-pro");
  assert.equal(genericG4.id, "gemini-4-512k");
  assert.equal(genericG4.inputPer1M, 2.00);

  assert.equal(resolveModelProfile("gemini-3.8-flash").minCacheableTokens, 4096);
  assert.equal(resolveModelProfile("gemini-3.1-pro").minCacheableTokens, 4096);
  assert.equal(resolveModelProfile("gemini-2.5-flash").minCacheableTokens, 2048);
  assert.equal(resolveModelProfile("gemini-2.5-pro").minCacheableTokens, 2048);

  // 2. Gemini 4 small-delta (<2,050 tokens) tail re-processing must NOT trigger false cache bust
  const nowMs = Date.parse("2026-11-27T12:00:00Z");
  const t1 = new Date(nowMs - 40_000).toISOString();
  const t2 = new Date(nowMs - 20_000).toISOString();
  const smallDeltaSteps = [
    {
      type: "PLANNER_RESPONSE",
      step_index: 1,
      created_at: t1,
      model: "gemini-4-neon",
      input_tokens: 5000,
      cache_read_tokens: 0,
      output_tokens: 200
    },
    {
      type: "PLANNER_RESPONSE",
      step_index: 2,
      created_at: t2,
      model: "gemini-4-neon",
      // Prev ctx = 5,000; new delta = +500 (< 2,050) -> Gemini 4 re-processes trailing 2,050 tokens:
      // cache_read = 2,950 (retainedRatio = 0.59 < 0.70), uncached_input = 2,550, total = 5,500
      input_tokens: 2550,
      cache_read_tokens: 2950,
      output_tokens: 150
    }
  ];
  const smallDiag = analyzeTranscriptCache(smallDeltaSteps, { nowMs });
  assert.equal(smallDiag.bustCount, 0, "Expected Gemini 4 small-delta tail re-process NOT to count as a bust");
  assert.equal(smallDiag.cacheDiscountRate, 0.95);
  assert.equal(smallDiag.modelProfile.minCacheableTokens, 4096);
  assert.equal(smallDiag.modelProfile.minTurnDeltaForFullCache, 2050);

  // Contrast: true cold miss (cache_read=0) or large-delta (>=2,050) prefix drop MUST still detect bust
  const realBustSteps = [
    {
      type: "PLANNER_RESPONSE",
      step_index: 1,
      created_at: t1,
      model: "gemini-4-neon",
      input_tokens: 5000,
      cache_read_tokens: 0,
      output_tokens: 200
    },
    {
      type: "PLANNER_RESPONSE",
      step_index: 2,
      created_at: t2,
      model: "gemini-4-neon",
      // Delta = +3,000 (>= 2,050) yet cache_read only 2,000 (0.40) -> genuine bust
      input_tokens: 6000,
      cache_read_tokens: 2000,
      output_tokens: 150
    }
  ];
  const realBustDiag = analyzeTranscriptCache(realBustSteps, { nowMs });
  assert.equal(realBustDiag.bustCount, 1, "Large-delta prefix drop on Gemini 4 must still be flagged as a bust");

  // 3. Watchdog Gemini 4 keepalive ROI floor (10k tokens unless custom override) & tailReprocessTokens status
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-w1-wd-"));
  const dbPath = path.join(tmpDir, "context.db");
  const store = new ContextModeStore({ dbPath });
  try {
    const wd = new WatchdogMonitor({ getStore: () => store });
    const g4Min = wd._resolveLeaseKeepaliveMinContext(store, {}, { model: "gemini-4-carbon", windowTokens: 512000 });
    assert.equal(g4Min.tailReprocessTokens, 2050);
    assert.equal(g4Min.modelRoiMinTokens, 10000);

    const g4Custom = wd._resolveLeaseKeepaliveMinContext(
      store,
      {},
      { model: "gemini-4-carbon", windowTokens: 512000 },
      { isCustomOverride: true }
    );
    assert.equal(g4Custom.modelRoiMinTokens, 0);

    const claudeMin = wd._resolveLeaseKeepaliveMinContext(store, {}, { model: "claude-sonnet-4-6", windowTokens: 200000 });
    assert.equal(claudeMin.tailReprocessTokens, 0);
    assert.equal(claudeMin.modelRoiMinTokens, 0);

    const status = wd.getStatus({ scope: "all" });
    assert.equal(typeof status.ttlKeepalive.tailReprocessTokens, "number");
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }

  // 4. Gemini 4 Carbon / Neon high-reasoning defaults (excluding -low / -medium)
  assert.equal(isHighReasoningModel("gemini-4-carbon"), true);
  assert.equal(isHighReasoningModel("gemini-4-neon"), true);
  assert.equal(isHighReasoningModel("orchestrator-neon"), true);
  assert.equal(isHighReasoningModel("gemini-4-neon-low"), false);
  assert.equal(isHighReasoningModel("gemini-4-neon-medium"), false);
  assert.equal(isHighReasoningModel("gemini-4-hydrogen"), false);
});

test("Wave1-2: PreToolUse allows small bounded slices on large files, fixes 1-based line span & slice error message, and expands instruction/multimodal exemptions", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-w1-pre-"));
  const dbPath = path.join(tmpDir, "context.db");
  try {
    // 55 KB, 1,500-line source file (~37 B/line): lines 651-1520 = 850 actual lines (~31 KB <= 45 KiB)
    const src55k = path.join(tmpDir, "sample.mjs");
    const lines55k = Array.from({ length: 1500 }, (_, i) => `export const row_${i + 1} = "val_${String(i + 1).padStart(4, "0")}";`);
    fs.writeFileSync(src55k, lines55k.join("\n") + "\n", "utf8");
    assert.ok(fs.statSync(src55k).size > 46080, "Fixture must exceed 45 KiB");

    // Full-file read still denied with accurate full-file text
    const rFull = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "w1-pre-1", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: src55k } } },
      dbPath
    );
    assert.equal(rFull.decision, "deny");
    assert.match(rFull.reason, /exceeding the 45 KB/i);

    // Bounded slice 651..1520 (span > 800, actual slice ~31 KB <= 45 KiB) MUST allow!
    const rTailSlice = runHook(
      "hooks/pre-tool-use.mjs",
      {
        conversationId: "w1-pre-2",
        cwd: tmpDir,
        toolCall: { name: "read_file", args: { Path: src55k, StartLine: 651, EndLine: 1520 } }
      },
      dbPath
    );
    assert.equal(rTailSlice.decision, "allow", `Expected ~31 KB bounded slice to allow, got: ${rTailSlice.reason}`);

    // Exact 1-based 800-line slice (1..800, ~30 KB) MUST allow
    const rExact800 = runHook(
      "hooks/pre-tool-use.mjs",
      {
        conversationId: "w1-pre-3",
        cwd: tmpDir,
        toolCall: { name: "read_file", args: { Path: src55k, StartLine: 1, EndLine: 800 } }
      },
      dbPath
    );
    assert.equal(rExact800.decision, "allow");

    // 123 KB, 1,500-line source file (84 B/line): tests all bounded-slice regimes
    const src123k = path.join(tmpDir, "big_module.mjs");
    const lines123k = Array.from(
      { length: 1500 },
      (_, i) => `export const entry_${String(i + 1).padStart(4, "0")} = "payload_segment_value_${"x".repeat(32)}";`
    );
    fs.writeFileSync(src123k, lines123k.join("\n") + "\n", "utf8");

    // Regime A: 45 KiB < slice <= 90 KiB with span <= 800 (1..700 = ~58.8 KB) -> allow
    const rMidAllow = runHook(
      "hooks/pre-tool-use.mjs",
      {
        conversationId: "w1-pre-4a",
        cwd: tmpDir,
        toolCall: { name: "read_file", args: { Path: src123k, StartLine: 1, EndLine: 700 } }
      },
      dbPath
    );
    assert.equal(rMidAllow.decision, "allow", `Expected <=800-line / <=90KB slice to allow, got: ${rMidAllow.reason}`);

    // Regime B: 45 KiB < slice <= 90 KiB with span > 800 (1..1000 = 82.0 KB) -> deny via isWideRange with slice-specific wording
    const rWideDeny = runHook(
      "hooks/pre-tool-use.mjs",
      {
        conversationId: "w1-pre-4b",
        cwd: tmpDir,
        toolCall: { name: "read_file", args: { Path: src123k, StartLine: 1, EndLine: 1000 } }
      },
      dbPath
    );
    assert.equal(rWideDeny.decision, "deny");
    assert.match(rWideDeny.reason, /File slice \(lines 1-1000\) is 82(?:\.0)? KB/i);
    assert.match(rWideDeny.reason, /exceeding the 45 KB/i);
    assert.ok(!/Reading the entire file/i.test(rWideDeny.reason), `Must not accuse bounded slice of full-file read: ${rWideDeny.reason}`);

    // Regime C: slice > 90 KiB (1..1200 = 98.4 KB) -> deny via isOversizedMultiLineSlice
    const rBigSlice = runHook(
      "hooks/pre-tool-use.mjs",
      {
        conversationId: "w1-pre-4c",
        cwd: tmpDir,
        toolCall: { name: "read_file", args: { Path: src123k, StartLine: 1, EndLine: 1200 } }
      },
      dbPath
    );
    assert.equal(rBigSlice.decision, "deny");
    assert.match(rBigSlice.reason, /File slice \(1200 lines, ~84 B\/line\) is 98\.4 KB/i);
    assert.match(rBigSlice.reason, /exceeding the 90 KB paged slice cap/i);
    assert.ok(!/Reading the entire file/i.test(rBigSlice.reason));

    // Instruction path exemptions across plugin skills/rules/agents, CLI skills, agents, and legacy .agent/
    for (const p of [
      "C:\\Users\\demo\\.gemini\\config\\plugins\\agy-cmd\\skills\\agy-cmd\\references\\routing.md",
      "/repo/.agents/plugins/my-plug/rules/style.md",
      "/repo/.agents/plugins/my-plug/agents/auditor.md",
      "/home/u/.gemini/antigravity-cli/skills/deploy/guide.md",
      "/home/u/.gemini/skills/custom/notes.md",
      "/home/u/.gemini/config/agents/reviewer.md",
      "/repo/.agents/agents/coder.md",
      "/repo/.agent/rules/legacy.md"
    ]) {
      assert.equal(isAgentInstructionFile(p, p), true, `Expected instruction exemption for ${p}`);
    }
    assert.equal(
      isAgentInstructionFile(
        "/home/u/.gemini/config/plugins/agy-dart/hooks/pre-tool-use.mjs",
        "/home/u/.gemini/config/plugins/agy-dart/hooks/pre-tool-use.mjs"
      ),
      false,
      "Plugin runtime code outside skills/rules/agents must NOT be exempt"
    );

    // Multimodal (.amr, .heic, .avif) & view_file StartPage/EndPage exemptions
    assert.ok(FILE_CATEGORIES.images.extensions.includes(".heic"));
    assert.ok(FILE_CATEGORIES.images.extensions.includes(".avif"));
    assert.ok(FILE_CATEGORIES.music.extensions.includes(".amr"));
    assert.ok(DEFAULT_EXEMPT_EXTENSIONS.includes(".amr"));

    const amrFile = path.join(tmpDir, "voice.amr");
    fs.writeFileSync(amrFile, Buffer.alloc(60 * 1024, 0x41));
    const rAmr = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "w1-pre-5", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: amrFile } } },
      dbPath
    );
    assert.equal(rAmr.decision, "allow", ".amr audio file must bypass read size guard");

    const rPdfPage = runHook(
      "hooks/pre-tool-use.mjs",
      {
        conversationId: "w1-pre-6",
        cwd: tmpDir,
        toolCall: { name: "view_file", args: { AbsolutePath: src55k, StartPage: 1, EndPage: 5 } }
      },
      dbPath
    );
    assert.equal(rPdfPage.decision, "allow", "view_file with StartPage/EndPage must allow directly");

    // Also verify view_file StartPage/EndPage bypasses 45 KiB size guard when sensitiveFileGuard is active
    const rPdfPageGuarded = runHook(
      "hooks/pre-tool-use.mjs",
      {
        conversationId: "w1-pre-7",
        cwd: tmpDir,
        toolCall: { name: "view_file", args: { AbsolutePath: src55k, StartPage: 1, EndPage: 5 } }
      },
      dbPath,
      { AGY_DART_SENSITIVE_FILE_GUARD: "warn" }
    );
    assert.equal(rPdfPageGuarded.decision, "allow", "view_file with StartPage/EndPage must stay exempt under sensitiveFileGuard");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Wave1-3: Swarm worker detection, SessionStart override preservation, workspace isolation & genesis transcript detection", () => {
  // 1. Unified Swarm worker detection (while preserving coordinator as primary)
  const workerPayloads = [
    { role: "monitor" },
    { role: "swarm-worker" },
    { workerName: "coder-1" },
    { swarm: { role: "worker", name: "alpha-1" } },
    { isSwarmWorker: true }
  ];
  for (const wp of workerPayloads) {
    assert.equal(isSubagentPayload(wp, {}), true, `session-start must detect ${JSON.stringify(wp)}`);
    assert.equal(isSubagentReadPayload(wp, {}), true, `pre-tool-use must detect ${JSON.stringify(wp)}`);
    assert.equal(isSubagentLeasePayload(wp, {}), true, `watchdog-lease must detect ${JSON.stringify(wp)}`);
  }
  assert.equal(isSubagentPayload({}, { ANTIGRAVITY_SWARM_WORKER: "1" }), true);
  assert.equal(isSubagentReadPayload({}, { ANTIGRAVITY_SWARM_WORKER: "true" }), true);
  assert.equal(isSubagentLeasePayload({}, { ANTIGRAVITY_SWARM_WORKER: "1" }), true);

  for (const coordPayload of [{ role: "coordinator" }, { swarm: { role: "coordinator", name: "coordinator" } }]) {
    assert.equal(isSubagentPayload(coordPayload, {}), false, `Coordinator must stay primary: ${JSON.stringify(coordPayload)}`);
    assert.equal(isSubagentReadPayload(coordPayload, {}), false);
    assert.equal(isSubagentLeasePayload(coordPayload, {}), false);
  }

  // 2. SessionStart override preservation & primary-preferred resolveUniqueActiveWorkspace
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-w1-swarm-"));
  const primaryDir = path.join(tmpDir, "repo-main");
  const primaryDirB = path.join(tmpDir, "repo-other");
  const workerTree = path.join(tmpDir, "repo-swarm-share-1");
  fs.mkdirSync(primaryDir, { recursive: true });
  fs.mkdirSync(primaryDirB, { recursive: true });
  fs.mkdirSync(workerTree, { recursive: true });
  const dbPath = path.join(tmpDir, "context.db");

  let store = null;
  try {
    // Primary session A starts and user sets a session:app override
    runHook("hooks/session-start.mjs", { conversationId: "coord-a", cwd: primaryDir }, dbPath);
    store = new ContextModeStore({ dbPath });
    store.setMeta("cutoff:session:app", "98304");
    assert.equal(store.hasOtherActivePrimarySession("other-conv"), true);
    assert.equal(store.hasOtherActivePrimarySession("coord-a"), false);
    store.close();
    store = null;

    // Concurrent secondary session (e.g. /btw or worker missing subagent flags) fires SessionStart
    // -> must NOT wipe coord-a's active session:app override!
    runHook("hooks/session-start.mjs", { conversationId: "btw-tab", cwd: primaryDir }, dbPath);
    store = new ContextModeStore({ dbPath });
    assert.equal(
      store.getMeta("cutoff:session:app"),
      "98304",
      "Active session:app override must survive concurrent SessionStart while another primary session is active"
    );

    // Swarm worker starts in a shared git worktree -> resolveUniqueActiveWorkspace still resolves primaryDir!
    store.recordSessionWorkspace("worker-1", workerTree, {
      rootSessionId: "coord-a",
      active: true,
      isSubagent: true,
      source: "SessionStart"
    });
    const uniqueRes = store.resolveUniqueActiveWorkspace();
    assert.equal(uniqueRes.status, "unique", "Swarm worker worktree must NOT make coordinator workspace ambiguous");
    assert.equal(path.resolve(uniqueRes.dir).toLowerCase(), path.resolve(primaryDir).toLowerCase());

    // Contrast: two distinct primary workspaces still report ambiguous
    store.recordSessionWorkspace("primary-b", primaryDirB, {
      rootSessionId: "primary-b",
      active: true,
      isSubagent: false,
      source: "SessionStart"
    });
    assert.equal(store.resolveUniqueActiveWorkspace().status, "ambiguous");

    // 3. Swarm worker genesis transcript detection (step-0 SYSTEM_MESSAGE tests both watchdog-lease & store regexes)
    const swarmTranscript = path.join(tmpDir, "worker-transcript.jsonl");
    fs.writeFileSync(
      swarmTranscript,
      JSON.stringify({
        type: "SYSTEM_MESSAGE",
        source: "SYSTEM_SDK",
        content: "<swarm_brief>You are a swarm worker owning module A on the shared message board.</swarm_brief>"
      }) + "\n",
      "utf8"
    );
    const humanMentionTranscript = path.join(tmpDir, "human-mention.jsonl");
    fs.writeFileSync(
      humanMentionTranscript,
      JSON.stringify({
        type: "USER_INPUT",
        user_input: "Can you explain how <swarm_brief> works?"
      }) + "\n",
      "utf8"
    );
    assert.equal(detectSubagentFromTranscriptFile(swarmTranscript), true);
    assert.equal(detectSubagentFromTranscriptFile(humanMentionTranscript), false);

    const wd = new WatchdogMonitor({ getStore: () => store });
    assert.equal(
      wd._isConversationSubagent(store, "worker-genesis", {
        conversationId: "worker-genesis",
        transcriptPath: swarmTranscript
      }),
      true
    );

    // Also exercise STORE_SUBAGENT_GENESIS_RE inside ContextModeStore (settings-maintenance.js)
    store.setMeta(
      "watchdog_lease:worker-store-gen",
      JSON.stringify({
        conversationId: "worker-store-gen",
        transcriptPath: swarmTranscript,
        isSubagent: false,
        phase: "IDLE",
        updatedTs: Date.now()
      })
    );
    store.setTtlKeepaliveEnabled(true, "worker-store-gen");
    assert.equal(
      store.hasAnyExplicitTtlKeepaliveEnabled(),
      false,
      "Swarm worker genesis transcript must suppress explicit TTL keepalive in store"
    );
    const sanitized = store.sanitizeModelTtlState();
    assert.ok(sanitized.healedSubagentLeases >= 1, "sanitizeModelTtlState must heal Swarm worker lease");
  } finally {
    try {
      store?.close();
    } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Wave1-4: PostToolUse matcher drops read_slices/batch_search, bestEffort empty-response error invalidates reads, and fast MCP persists verification checkpoints directly", () => {
  // 1. Matcher narrowing in hooks.json and scripts/install.mjs
  const hooksCfg = JSON.parse(fs.readFileSync(path.join(ROOT, "hooks.json"), "utf8"));
  const matcherStr = hooksCfg["agy-dart-lifecycle"].PostToolUse[0].matcher;
  const postMatcher = new RegExp(`^(?:${matcherStr})$`);
  assert.equal(postMatcher.test("mcp_agy-dart_fast_read_slices"), false, "read_slices must not trigger PostToolUse");
  assert.equal(postMatcher.test("mcp_agy-dart_fast_batch_search"), false, "batch_search must not trigger PostToolUse");
  assert.equal(postMatcher.test("mcp_agy-dart_fast_run_checks"), true, "run_checks must remain matched");
  assert.equal(postMatcher.test("mcp_agy-dart_fast_apply_edits"), true, "apply_edits must remain matched");
  const installSrc = fs.readFileSync(path.join(ROOT, "scripts", "install.mjs"), "utf8");
  assert.ok(installSrc.includes(matcherStr), "scripts/install.mjs PostToolUse matcher must match hooks.json");

  // 2. bestEffort apply_edits with isError=true & empty toolResponse invalidates read cache without polluting modifiedFiles
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-w1-post-"));
  const dbPath = path.join(tmpDir, "context.db");
  const fileA = path.join(tmpDir, "a.js");
  const fileB = path.join(tmpDir, "b.js");
  const padLines = (prefix) =>
    Array.from({ length: 120 }, (_, i) => `export const ${prefix}_line_${i + 1} = "dedup_threshold_padding_${String(i + 1).padStart(3, "0")}";`).join("\n");
  fs.writeFileSync(fileA, `export const a = 1;\n${padLines("a")}\n`, "utf8");
  fs.writeFileSync(fileB, `export const b = 2;\n${padLines("b")}\n`, "utf8");

  let store = null;
  try {
    // Seed read-dedup cache for a.js and b.js (>4 KiB each so read-dedup tracks them)
    const rSeedA = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "be-sess", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: fileA, StartLine: 1, EndLine: 121 } } },
      dbPath
    );
    const rSeedB = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "be-sess", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: fileB, StartLine: 1, EndLine: 121 } } },
      dbPath
    );
    assert.equal(rSeedA.decision, "allow");
    assert.equal(rSeedB.decision, "allow");

    // Atomic apply_edits (bestEffort: false) with isError=true & empty response MUST keep read-dedup cache intact
    runHook(
      "hooks/post-tool-use.mjs",
      {
        conversationId: "be-sess",
        cwd: tmpDir,
        isError: true,
        toolCall: {
          name: "mcp_agy-dart_fast_apply_edits",
          args: { cwd: tmpDir, bestEffort: false, edits: [{ path: "a.js", hunks: [] }] }
        }
      },
      dbPath
    );
    const rAfterAtomicErr = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "be-sess", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: fileA, StartLine: 1, EndLine: 121 } } },
      dbPath
    );
    assert.equal(rAfterAtomicErr.decision, "deny", "Failed atomic apply_edits must NOT clear read-dedup");

    // bestEffort: true with isError=true & empty response MUST invalidate read-dedup for candidate files, NOT pollute modifiedFiles
    runHook(
      "hooks/post-tool-use.mjs",
      {
        conversationId: "be-sess",
        cwd: tmpDir,
        isError: true,
        toolCall: {
          name: "mcp_agy-dart_fast_apply_edits",
          args: {
            cwd: tmpDir,
            bestEffort: true,
            edits: [
              { path: "a.js", hunks: [] },
              { path: "b.js", hunks: [] }
            ]
          }
        }
      },
      dbPath
    );
    const rAfterBeA = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "be-sess", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: fileA, StartLine: 1, EndLine: 121 } } },
      dbPath
    );
    const rAfterBeB = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "be-sess", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: fileB, StartLine: 1, EndLine: 121 } } },
      dbPath
    );
    assert.equal(rAfterBeA.decision, "allow", "bestEffort empty-response error must invalidate read-dedup for a.js");
    assert.equal(rAfterBeB.decision, "allow", "bestEffort empty-response error must invalidate read-dedup for b.js");

    store = new ContextModeStore({ dbPath });
    const cpBe = store.getSessionCheckpoint("be-sess");
    assert.deepEqual(cpBe.modifiedFiles, [], "Unconfirmed bestEffort error must NOT pollute modifiedFiles");
    store.close();
    store = null;

    // 3. Direct verification checkpoint persistence inside fast/mcp-server.mjs (no PostToolUse needed)
    const fastConvId = "fast-verify-sess";
    const responses = sendFastRpc(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "wave1-test", version: "1.0" },
            _meta: { conversationId: fastConvId }
          }
        },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "run_checks",
            _meta: { conversationId: fastConvId },
            arguments: {
              cwd: tmpDir,
              commands: [{ name: "unit-test", command: 'node -e "console.log(\'all tests pass\')"' }]
            }
          }
        },
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "apply_edits",
            _meta: { conversationId: fastConvId },
            arguments: {
              cwd: tmpDir,
              edits: [{ path: "a.js", hunks: [{ target: "export const a = 1;", replacement: "export const a = 2;" }] }],
              verify: 'node -e "console.log(\'build ok\')"'
            }
          }
        }
      ],
      { AGY_DART_DB_PATH: dbPath }
    );
    const checkResp = responses.find((r) => r.id === 2);
    assert.equal(checkResp?.result?.isError, false);
    const editResp = responses.find((r) => r.id === 3);
    assert.equal(editResp?.result?.isError, false);

    store = new ContextModeStore({ dbPath });
    const fastCp = store.getSessionCheckpoint(fastConvId);
    assert.ok(fastCp.lastTest, "fast run_checks must persist lastTest checkpoint directly");
    assert.equal(fastCp.lastTest.ok, true);
    assert.ok(fastCp.lastBuild, "fast apply_edits.verify must persist lastBuild checkpoint directly");
    assert.equal(fastCp.lastBuild.ok, true);
    const fastCpRow = store.db
      .prepare("SELECT worktree FROM session_checkpoints WHERE session_id = ?")
      .get(fastConvId);
    assert.equal(
      path.resolve(fastCpRow?.worktree || "").toLowerCase(),
      path.resolve(tmpDir).toLowerCase(),
      "fast verification checkpoint must persist worktree"
    );

    // Anonymous fast run_checks (no _meta.conversationId) also persists to the unique active primary session for that workspace
    const anonWs = path.join(tmpDir, "anon-ws");
    fs.mkdirSync(anonWs, { recursive: true });
    const anonConvId = "anon-primary-sess";
    store.recordSessionWorkspace(anonConvId, anonWs, {
      rootSessionId: anonConvId,
      active: true,
      isSubagent: false,
      source: "SessionStart"
    });
    store.close();
    store = null;

    const anonResponses = sendFastRpc(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "anon-test", version: "1.0" } }
        },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "run_checks",
            arguments: {
              cwd: anonWs,
              commands: [{ name: "smoke", command: 'node -e "console.log(\'smoke ok\')"' }]
            }
          }
        }
      ],
      { AGY_DART_DB_PATH: dbPath }
    );
    assert.equal(anonResponses.find((r) => r.id === 2)?.result?.isError, false);
    store = new ContextModeStore({ dbPath });
    const anonCp = store.getSessionCheckpoint(anonConvId);
    assert.ok(anonCp.lastTest, "Anonymous fast run_checks must attribute checkpoint to unique active primary session");
    assert.equal(anonCp.lastTest.ok, true);

    // Ambiguous workspace (2 distinct active primary sessions) must NOT misattribute anonymous run_checks
    const anonConvId2 = "anon-primary-sess-2";
    store.recordSessionWorkspace(anonConvId2, anonWs, {
      rootSessionId: anonConvId2,
      active: true,
      isSubagent: false,
      source: "SessionStart"
    });
    assert.equal(store.resolveUniqueActivePrimarySessionForWorkspace(anonWs), "");
  } finally {
    try {
      store?.close();
    } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
