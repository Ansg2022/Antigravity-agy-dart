import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  CONFIG_DEFAULTS,
  formatEffectiveConfigLines,
  getConfigSnapshot,
  resetConfigCache
} from "../context/lib/config.js";
import { ContextModeStore } from "../context/lib/store.js";
import { readWatchdogLease } from "../context/lib/watchdog-lease.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function runPreInvocation(payload, env = {}) {
  const res = spawnSync(process.execPath, [path.join(ROOT, "hooks", "pre-invocation.mjs")], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      AGY_DART_DISABLE_COMPILE_CACHE: "1",
      ...env
    }
  });
  return res;
}

test("Issue #7: cacheWatchInlineAlerts defaults to false with config/env precedence and doctor visibility", () => {
  assert.equal(CONFIG_DEFAULTS.cacheWatch, true);
  assert.equal(CONFIG_DEFAULTS.cacheWatchInlineAlerts, false);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-issue7-cfg-"));
  const cfgPath = path.join(tmpDir, "config.json");
  try {
    resetConfigCache();
    const defSnap = getConfigSnapshot({ configPath: path.join(tmpDir, "missing.json"), env: {} });
    assert.equal(defSnap.values.cacheWatch, true);
    assert.equal(defSnap.values.cacheWatchInlineAlerts, false);
    assert.equal(defSnap.sources.cacheWatchInlineAlerts, "default");
    const defLines = formatEffectiveConfigLines(defSnap);
    assert.ok(
      defLines.some((l) => l.includes("cacheWatchInlineAlerts=false")),
      `Expected cacheWatchInlineAlerts=false in doctor lines:\n${defLines.join("\n")}`
    );

    fs.writeFileSync(cfgPath, JSON.stringify({ cacheWatchInlineAlerts: true }), "utf8");
    resetConfigCache();
    const cfgOnSnap = getConfigSnapshot({ configPath: cfgPath, env: {} });
    assert.equal(cfgOnSnap.values.cacheWatchInlineAlerts, true);
    assert.equal(cfgOnSnap.sources.cacheWatchInlineAlerts, "config");

    const envDisableSnap = getConfigSnapshot({
      configPath: cfgPath,
      env: {
        AGY_DART_CACHE_WATCH_INLINE_ALERTS: "1",
        AGY_DART_DISABLE_CACHE_WATCH_INLINE_ALERTS: "1"
      }
    });
    assert.equal(envDisableSnap.values.cacheWatchInlineAlerts, false);
    assert.equal(envDisableSnap.sources.cacheWatchInlineAlerts, "env");

    fs.writeFileSync(cfgPath, JSON.stringify({ cacheWatchInlineAlerts: false }), "utf8");
    resetConfigCache();
    const envEnableSnap = getConfigSnapshot({
      configPath: cfgPath,
      env: { AGY_DART_CACHE_WATCH_INLINE_ALERTS: "1" }
    });
    assert.equal(envEnableSnap.values.cacheWatchInlineAlerts, true);
    assert.equal(envEnableSnap.sources.cacheWatchInlineAlerts, "env");
  } finally {
    resetConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Issue #7: PreInvocation suppresses metadata.user_markdown by default while keeping leases, /compact invalidation, turn seq, and wm_desktop reset active", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-issue7-hook-"));
  const dbPath = path.join(tmpDir, "context.db");
  const cfgPath = path.join(tmpDir, "config.json");
  const summaryDbPath = path.join(tmpDir, "missing-summaries.db");
  const criticalTxPath = path.join(tmpDir, "critical.jsonl");
  const okTxPath = path.join(tmpDir, "compacted.jsonl");
  const convId = "issue7-default-guard";

  const nowMs = Date.now();
  const criticalSteps = [
    {
      type: "PLANNER_RESPONSE",
      step_index: 2,
      created_at: new Date(nowMs - 10 * 60 * 1000).toISOString(),
      model: "claude-sonnet-4-6",
      input_tokens: 180000,
      cache_read_tokens: 0,
      output_tokens: 300,
      images: [{ id: "img-1" }]
    }
  ];
  const okSteps = [
    {
      type: "PLANNER_RESPONSE",
      step_index: 4,
      created_at: new Date(nowMs - 10 * 1000).toISOString(),
      model: "claude-sonnet-4-6",
      input_tokens: 20000,
      cache_read_tokens: 18000,
      output_tokens: 200
    }
  ];

  fs.writeFileSync(criticalTxPath, criticalSteps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
  fs.writeFileSync(okTxPath, okSteps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
  fs.writeFileSync(cfgPath, JSON.stringify({ diffRead: true }), "utf8");

  const baseEnv = {
    AGY_DART_DB_PATH: dbPath,
    AGY_DART_CONFIG_PATH: cfgPath,
    AGY_DART_SUMMARY_DB_PATH: summaryDbPath,
    AGY_DART_LANG: "en",
    AGY_DART_CACHE_WATCH_INLINE_ALERTS: "",
    AGY_DART_DISABLE_CACHE_WATCH_INLINE_ALERTS: ""
  };

  try {
    // Seed a file_reads entry and a desktop watermark notification marker
    {
      const seed = new ContextModeStore({ dbPath });
      try {
        seed.recordFileRead({
          sessionId: convId,
          filePath: path.join(tmpDir, "src", "index.js"),
          mtimeMs: 1000,
          fileSize: 8192,
          stepIdx: 1
        });
        seed.setTimedMeta(`cache_alert:${convId}:wm_desktop`, "critical");
      } finally {
        seed.close();
      }
    }

    // 1. Default run on critical + expired + multimodal transcript MUST emit `{}` (zero host panic)
    const rDefault = runPreInvocation(
      {
        conversationId: convId,
        cwd: tmpDir,
        transcriptPath: criticalTxPath,
        invocationNum: 0,
        initialNumSteps: 2,
        lastUserInput: "continue debugging"
      },
      baseEnv
    );
    assert.equal(rDefault.status, 0, rDefault.stderr);
    assert.equal(Buffer.byteLength(rDefault.stderr || "", "utf8"), 0, "PreInvocation must emit 0 bytes stderr");
    assert.equal(rDefault.stdout.trim(), "{}", "Default PreInvocation must NOT emit metadata.user_markdown injectSteps");

    // Verify all non-banner bookkeeping STILL ran and chat dedup meta keys were NOT consumed
    {
      const st = new ContextModeStore({ dbPath });
      try {
        const lease = readWatchdogLease(st, convId);
        assert.ok(lease, "Watchdog lease must still be written when inline alerts are disabled");
        assert.equal(lease.watermark, "critical");
        assert.equal(lease.contextTokens, 180000);
        assert.equal(lease.windowTokens, 200000);
        assert.equal(st.getConversationTurnSeq(convId), 1, "conv_turn_seq must still advance");
        assert.equal(st.getTimedMeta(`cache_alert:${convId}:watermark`, ""), "", "Chat watermark dedup key must stay untouched");
        assert.equal(st.getTimedMeta(`cache_alert:${convId}:ttl_turn`, ""), "", "Chat TTL dedup key must stay untouched");
        assert.equal(st.getTimedMeta(`cache_alert:${convId}:media`, ""), "", "Chat media dedup key must stay untouched");
        assert.equal(st.getTimedMeta(`cache_alert:${convId}:wm_desktop`, ""), "critical");
      } finally {
        st.close();
      }
    }

    // 2. `/compact` + post-compaction `watermark === "ok"` MUST still invalidate file_reads AND reset wm_desktop
    const rCompact = runPreInvocation(
      {
        conversationId: convId,
        cwd: tmpDir,
        transcriptPath: okTxPath,
        invocationNum: 0,
        initialNumSteps: 4,
        lastUserInput: "/compact"
      },
      baseEnv
    );
    assert.equal(rCompact.status, 0, rCompact.stderr);
    assert.equal(rCompact.stdout.trim(), "{}");
    {
      const st = new ContextModeStore({ dbPath });
      st.open();
      try {
        const remainingReads =
          st.db.prepare("SELECT COUNT(*) AS cnt FROM file_reads WHERE session_id = ?").get(convId)?.cnt || 0;
        assert.equal(remainingReads, 0, "/compact must still invalidate file_reads when inline alerts are off");
        assert.equal(
          st.getTimedMeta(`cache_alert:${convId}:wm_desktop`, ""),
          "",
          "watermark === 'ok' must still clear cache_alert:<id>:wm_desktop when inline alerts are off"
        );
        assert.equal(st.getConversationTurnSeq(convId), 2);
      } finally {
        st.close();
      }
    }

    // 3. Explicit opt-in via config.json (`cacheWatchInlineAlerts: true`) restores zero-prefix-pollution user_markdown banner
    fs.writeFileSync(cfgPath, JSON.stringify({ diffRead: true, cacheWatchInlineAlerts: true }), "utf8");
    const rOptInCfg = runPreInvocation(
      {
        conversationId: convId,
        cwd: tmpDir,
        transcriptPath: criticalTxPath,
        invocationNum: 0,
        initialNumSteps: 5,
        lastUserInput: "check alerts after host fix"
      },
      baseEnv
    );
    assert.equal(rOptInCfg.status, 0, rOptInCfg.stderr);
    assert.equal(Buffer.byteLength(rOptInCfg.stderr || "", "utf8"), 0);
    const parsedOptIn = JSON.parse(rOptInCfg.stdout.trim());
    assert.equal(parsedOptIn.injectSteps?.length, 1);
    assert.equal(parsedOptIn.injectSteps[0].systemMessage.systemMessage, "");
    const md = parsedOptIn.injectSteps[0].systemMessage.metadata?.user_markdown || "";
    assert.ok(md.includes("critical watermark"), `Expected critical watermark banner: ${md}`);
    assert.ok(md.includes("KV-cache TTL"), `Expected TTL banner: ${md}`);

    // 4. Env disable flag overrides config.json `cacheWatchInlineAlerts: true` cleanly back to `{}`
    const rEnvOverrideOff = runPreInvocation(
      {
        conversationId: `${convId}-override-off`,
        cwd: tmpDir,
        transcriptPath: criticalTxPath,
        invocationNum: 0,
        initialNumSteps: 2,
        lastUserInput: "override off"
      },
      { ...baseEnv, AGY_DART_DISABLE_CACHE_WATCH_INLINE_ALERTS: "1" }
    );
    assert.equal(rEnvOverrideOff.status, 0, rEnvOverrideOff.stderr);
    assert.equal(rEnvOverrideOff.stdout.trim(), "{}");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
