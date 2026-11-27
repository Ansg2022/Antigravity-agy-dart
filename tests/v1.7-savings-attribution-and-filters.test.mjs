import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { ContextModeStore } from "../context/lib/store.js";
import {
  executionReceiptFromText,
  executionReceiptsFromSteps,
  extractFastSavingsToolName,
  fastToolClaimsFromSteps,
  fastToolFingerprint,
  isContextExecution
} from "../context/lib/execution-receipts.js";
import { matchFilterRule, parsePkgManagerCommand } from "../hooks/filter-rules.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const CLEAN_HOST_ENV = {
  ANTIGRAVITY_CONVERSATION_ID: "",
  ANTIGRAVITY_PARENT_CONVERSATION_ID: "",
  ANTIGRAVITY_ROOT_CONVERSATION_ID: "",
  CONVERSATION_ID: "",
  ANTIGRAVITY_SUBAGENT: "",
  ANTIGRAVITY_WORKSPACE_ROOT: "",
  VSCODE_CWD: ""
};

function runHook(scriptRel, payload, dbPath, extraEnv = {}) {
  const res = spawnSync(process.execPath, [path.join(ROOT, scriptRel)], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      ...CLEAN_HOST_ENV,
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
    env: {
      ...process.env,
      ...CLEAN_HOST_ENV,
      AGY_DART_DISABLE_COMPILE_CACHE: "1",
      ...extraEnv
    }
  });
  let buf = "";
  let stderr = "";
  let nextId = 1;
  const pending = new Map();

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

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
          reject(new Error(`MCP request timed out: ${method} (stderr: ${stderr})`));
        }, 12000);
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

function httpPostJson(port, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body || {});
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: urlPath,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(raw),
          "X-Agy-Dart-Token": token
        }
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk.toString("utf8")));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(data) });
          } catch (err) {
            reject(new Error(`Non-JSON HTTP ${res.statusCode}: ${data}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(raw);
    req.end();
  });
}

test("P0: agy-dart_fast records accurate, non-inflated byte savings for read_slices, run_checks & batch_search", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-fast-savings-"));
  const dbPath = path.join(tmpDir, "context.db");
  const wsDir = path.join(tmpDir, "ws");
  fs.mkdirSync(wsDir, { recursive: true });

  // Large structured JS file (~28 KB)
  const bigLines = [];
  for (let i = 0; i < 60; i++) {
    bigLines.push(`export function computeMetric${i}(input, options = {}) {`);
    bigLines.push(`  const note = "${"padding_detail_".repeat(20)}_${i}";`);
    bigLines.push(`  return { id: ${i}, note, len: String(input || "").length + Object.keys(options).length };`);
    bigLines.push("}");
  }
  const bigFile = path.join(wsDir, "metrics.js");
  fs.writeFileSync(bigFile, bigLines.join("\n") + "\n", "utf8");
  const bigSize = fs.statSync(bigFile).size;
  assert.ok(bigSize > 20000);

  // Tiny file (~90 B) where headers make output larger than file -> must NOT inflate savings
  const tinyFile = path.join(wsDir, "tiny.js");
  fs.writeFileSync(tinyFile, "export const x = 1;\nexport const y = 2;\n", "utf8");

  // File with a single huge minified line (~14 KB) for batch_search compaction test
  const minFile = path.join(wsDir, "bundle.min.js");
  fs.writeFileSync(
    minFile,
    `const FIND_ME_MINIFIED_MARKER = "${"z".repeat(14000)}";\n`,
    "utf8"
  );

  // Small search file for zero-truncation baseline
  const smallFile = path.join(wsDir, "small.txt");
  fs.writeFileSync(smallFile, "UNIQUE_SMALL_NEEDLE_777\n", "utf8");

  const fastClient = createPersistentMcpClient(path.join(ROOT, "fast", "mcp-server.mjs"), {
    AGY_DART_DB_PATH: dbPath
  });

  try {
    await fastClient.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "fast-savings-test", version: "1.0" }
    });

    const sid = "conv-fast-direct-1";

    // 1. read_slices outline on 28 KB file -> accurate savings = bigSize - returnedBytes
    const outlineResp = await fastClient.request("tools/call", {
      name: "read_slices",
      arguments: { cwd: wsDir, outlines: ["metrics.js"] },
      _meta: { conversationId: sid }
    });
    assert.equal(outlineResp.result.isError, false);
    const outlineText = outlineResp.result.content[0].text;
    assert.ok(outlineText.startsWith("## Outline: metrics.js"));
    assert.ok(!outlineText.includes("executionReceipt"), "Plain-text fast output must never leak receipt tokens");
    assert.ok(Buffer.byteLength(outlineText, "utf8") <= 8800);

    const store = new ContextModeStore({ dbPath });
    try {
      const s1 = store.getStats(sid);
      assert.equal(s1.calls, 1);
      assert.equal(s1.breakdown.fastTools, 1);
      assert.equal(s1.totalRawBytes, bigSize);
      assert.equal(s1.totalReturnedBytes, Buffer.byteLength(outlineText, "utf8"));
      assert.equal(s1.keptOutBytes, bigSize - Buffer.byteLength(outlineText, "utf8"));

      // 2. read_slices outline + lineRanges on SAME file -> must count bigSize ONCE, not 2x
      const comboResp = await fastClient.request("tools/call", {
        name: "read_slices",
        arguments: { cwd: wsDir, outlines: ["metrics.js"], lineRanges: ["metrics.js:1-4"] },
        _meta: { conversationId: sid }
      });
      assert.equal(comboResp.result.isError, false);
      const comboBytes = Buffer.byteLength(comboResp.result.content[0].text, "utf8");
      const s2 = store.getStats(sid);
      assert.equal(s2.calls, 2);
      assert.equal(s2.totalRawBytes, bigSize * 2);
      assert.equal(s2.keptOutBytes, (bigSize - Buffer.byteLength(outlineText, "utf8")) + (bigSize - comboBytes));

      // 3. Non-inflated cases: tiny file full slice, missing file, invalid args -> 0 new events
      const tinyResp = await fastClient.request("tools/call", {
        name: "read_slices",
        arguments: { cwd: wsDir, lineRanges: ["tiny.js:1-2"] },
        _meta: { conversationId: sid }
      });
      assert.equal(tinyResp.result.isError, false);
      const missResp = await fastClient.request("tools/call", {
        name: "read_slices",
        arguments: { cwd: wsDir, outlines: ["does-not-exist.js"] },
        _meta: { conversationId: sid }
      });
      assert.equal(missResp.result.isError, false);
      const errResp = await fastClient.request("tools/call", {
        name: "read_slices",
        arguments: { cwd: wsDir },
        _meta: { conversationId: sid }
      });
      assert.equal(errResp.result.isError, true);
      assert.equal(store.getStats(sid).calls, 2, "Tiny/missing/errored read_slices must NOT record fake savings");

      // 4. run_checks: tiny output -> 0 savings; noisy 20 KB compact output -> real savings
      const tinyCheck = await fastClient.request("tools/call", {
        name: "run_checks",
        arguments: {
          cwd: wsDir,
          outputMode: "full",
          commands: [{ name: "echo", command: 'node -e "console.log(123)"' }]
        },
        _meta: { conversationId: sid }
      });
      assert.equal(tinyCheck.result.isError, false);
      assert.equal(store.getStats(sid).calls, 2, "Uncompacted tiny run_checks must NOT inflate savings");

      const noisyCheck = await fastClient.request("tools/call", {
        name: "run_checks",
        arguments: {
          cwd: wsDir,
          outputMode: "compact",
          commands: [
            {
              name: "noisy-suite",
              command: 'node -e "for(let i=0;i<400;i++)console.log(\'PASS step_\'+i+\' \'+(\'x\').repeat(40)); console.log(\'400 passed\');"'
            }
          ]
        },
        _meta: { conversationId: sid }
      });
      assert.equal(noisyCheck.result.isError, false);
      const noisyRetBytes = Buffer.byteLength(noisyCheck.result.content[0].text, "utf8");
      assert.ok(noisyRetBytes < 1000);
      const s3 = store.getStats(sid);
      assert.equal(s3.calls, 3);
      assert.ok(s3.keptOutBytes - s2.keptOutBytes > 15000, "Compact run_checks must record real byte savings");

      // 5. batch_search: tiny search -> 0 savings; minified 14 KB line compaction -> real savings
      const tinySearch = await fastClient.request("tools/call", {
        name: "batch_search",
        arguments: { cwd: wsDir, queries: [{ type: "text", pattern: "UNIQUE_SMALL_NEEDLE_777" }] },
        _meta: { conversationId: sid }
      });
      assert.equal(tinySearch.result.isError, false);
      assert.equal(store.getStats(sid).calls, 3, "Uncompacted tiny batch_search must NOT inflate savings");

      const minSearch = await fastClient.request("tools/call", {
        name: "batch_search",
        arguments: { cwd: wsDir, queries: [{ type: "text", pattern: "FIND_ME_MINIFIED_MARKER" }] },
        _meta: { conversationId: sid }
      });
      assert.equal(minSearch.result.isError, false);
      const s4 = store.getStats(sid);
      assert.equal(s4.calls, 4);
      assert.equal(s4.breakdown.fastTools, 4);
      assert.ok(s4.keptOutBytes - s3.keptOutBytes > 12000, "Compacted minified search line must record real byte savings");

      // 6. batch_search glob truncation (>maxResults) records exact omitted filename bytes
      const manyDir = path.join(wsDir, "many");
      fs.mkdirSync(manyDir, { recursive: true });
      for (let i = 0; i < 60; i++) {
        fs.writeFileSync(path.join(manyDir, `generated_module_component_${String(i).padStart(3, "0")}.js`), "export const a=1;\n", "utf8");
      }
      const globSearch = await fastClient.request("tools/call", {
        name: "batch_search",
        arguments: { cwd: wsDir, queries: [{ type: "glob", path: "many", pattern: "**/*.js", maxResults: 5 }] },
        _meta: { conversationId: sid }
      });
      assert.equal(globSearch.result.isError, false);
      const s5 = store.getStats(sid);
      assert.equal(s5.calls, 5);
      assert.ok(s5.keptOutBytes - s4.keptOutBytes > 1000, "Truncated glob result must record omitted path byte savings");

      const roi = store.getFeatureRoi(sid);
      assert.equal(roi.features.fast_tools.calls, 5);
      assert.equal(roi.features.fast_tools.savedBytes, s5.keptOutBytes);
    } finally {
      store.close();
    }
  } finally {
    await fastClient.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("P0: Anonymous shared fast/mcp-server.mjs savings attribute cleanly via PostToolUse & PreInvocation without cross-session stealing", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-fast-claim-"));
  const dbPath = path.join(tmpDir, "context.db");
  const wsDir = path.join(tmpDir, "ws");
  fs.mkdirSync(wsDir, { recursive: true });

  const bigFile = path.join(wsDir, "big.js");
  fs.writeFileSync(
    bigFile,
    Array.from({ length: 80 }, (_, i) => `export function fn_${i}() { return "${"abcde".repeat(50)}_${i}"; }`).join("\n") + "\n",
    "utf8"
  );

  // Verify hooks.json PostToolUse matcher covers write/verify/context tools while omitting read-only
  // read_slices & batch_search (which PreInvocation claims from the transcript without extra hook spawns)
  const hooksCfg = JSON.parse(fs.readFileSync(path.join(ROOT, "hooks.json"), "utf8"));
  const postMatcher = new RegExp(`^(?:${hooksCfg["agy-dart-lifecycle"].PostToolUse[0].matcher})$`);
  for (const name of [
    "mcp_agy-dart_fast_apply_edits",
    "mcp_agy-dart_fast_run_checks",
    "mcp_agy-dart_context_ctx_execute",
    "mcp_agy-dart_context_ctx_index",
    "mcp_agy-dart_context_ctx_batch",
    "call_mcp_tool"
  ]) {
    assert.equal(postMatcher.test(name), true, `hooks.json PostToolUse matcher must cover ${name}`);
  }
  for (const readOnlyFast of ["mcp_agy-dart_fast_read_slices", "mcp_agy-dart_fast_batch_search"]) {
    assert.equal(postMatcher.test(readOnlyFast), false, `PostToolUse matcher should skip read-only ${readOnlyFast}`);
  }

  const fastClient = createPersistentMcpClient(path.join(ROOT, "fast", "mcp-server.mjs"), {
    AGY_DART_DB_PATH: dbPath
  });

  try {
    await fastClient.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "shared-fast", version: "1.0" }
    });

    // Two concurrent conversations run the IDENTICAL read_slices in the same workspace
    const [resA, resB] = await Promise.all([
      fastClient.request("tools/call", {
        name: "read_slices",
        arguments: { cwd: wsDir, outlines: ["big.js"] }
      }),
      fastClient.request("tools/call", {
        name: "read_slices",
        arguments: { cwd: wsDir, outlines: ["big.js"] }
      })
    ]);
    assert.equal(resA.result.isError, false);
    assert.equal(resB.result.isError, false);
    const outText = resA.result.content[0].text;
    assert.ok(fastToolFingerprint("read_slices", outText));

    const store = new ContextModeStore({ dbPath });
    try {
      const allBefore = store.getStats("all");
      assert.equal(allBefore.calls, 2);
      assert.equal(store.getStats("conv-a").calls, 0);
      assert.equal(store.getStats("conv-b").calls, 0);

      // Conv A claims via PostToolUse (with toolResponse)
      runHook(
        "hooks/post-tool-use.mjs",
        {
          common: { conversationId: "conv-a" },
          cwd: wsDir,
          toolCall: { name: "mcp_agy-dart_fast_read_slices", args: { cwd: wsDir, outlines: ["big.js"] } },
          toolResponse: { content: [{ text: outText }] }
        },
        dbPath
      );
      assert.equal(store.getStats("conv-a").calls, 1);
      assert.equal(store.getStats("conv-b").calls, 0);

      // Conv A's PreInvocation runs TWICE on Conv A's transcript (with repeated Created/Completed headers + 4120 truncation):
      // MUST NOT steal Conv B's unclaimed row!
      const txA = path.join(tmpDir, "tx-a.jsonl");
      const header = "Created At: 2026-11-24T02:00:00Z\nCompleted At: 2026-11-24T02:00:01Z\nCreated At: 2026-11-24T02:00:00Z\nCompleted At: 2026-11-24T02:00:01Z\n";
      const stepsA = [
        { step_index: 10, type: "PLANNER_RESPONSE", tool_calls: [{ name: "mcp_agy-dart_fast_read_slices", args: { outlines: ["big.js"] } }] },
        { step_index: 11, type: "GENERIC", content: (header + outText).slice(0, 4120) }
      ];
      fs.writeFileSync(txA, stepsA.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
      runHook("hooks/pre-invocation.mjs", { common: { conversationId: "conv-a", transcriptPath: txA } }, dbPath);
      runHook("hooks/pre-invocation.mjs", { common: { conversationId: "conv-a", transcriptPath: txA } }, dbPath);
      assert.equal(store.getStats("conv-a").calls, 1, "Conv A PreInvocation must NOT steal Conv B's identical fast event");
      assert.equal(store.getStats("conv-b").calls, 0);

      // Conv B's PostToolUse omits toolResponse, then Conv B's PreInvocation claims via call_mcp_tool transcript entry
      const txB = path.join(tmpDir, "tx-b.jsonl");
      const stepsB = [
        {
          step_index: 20,
          type: "PLANNER_RESPONSE",
          tool_calls: [{ name: "call_mcp_tool", args: { ServerName: '"agy-dart_fast"', ToolName: '"read_slices"' } }]
        },
        { step_index: 21, type: "GENERIC", content: (header + outText).slice(0, 4120) }
      ];
      fs.writeFileSync(txB, stepsB.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
      runHook("hooks/pre-invocation.mjs", { common: { conversationId: "conv-b", transcriptPath: txB } }, dbPath);
      runHook("hooks/pre-invocation.mjs", { common: { conversationId: "conv-b", transcriptPath: txB } }, dbPath);

      assert.equal(store.getStats("conv-b").calls, 1);
      assert.equal(store.getStats("conv-b").keptOutBytes, store.getStats("conv-a").keptOutBytes);
      assert.deepEqual(store.getStats("all"), allBefore, "Claiming must preserve exact global totals");
    } finally {
      store.close();
    }
  } finally {
    await fastClient.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("P1-2: executionReceipt covers ctx_index & ctx_batch (plus ctx_execute), claims sources/chunks, and preserves search isolation", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ctx-receipts-"));
  const dbPath = path.join(tmpDir, "context.db");
  const wsA = path.join(tmpDir, "ws-a");
  const wsB = path.join(tmpDir, "ws-b");
  fs.mkdirSync(wsA, { recursive: true });
  fs.mkdirSync(wsB, { recursive: true });

  const docFile = path.join(wsA, "spec.md");
  fs.writeFileSync(
    docFile,
    "# Billing Architecture\n\n" + "INVOICE_TOKEN_DELTA_909 reconciliation ledger details.\n".repeat(120),
    "utf8"
  );

  // Unit assertions on execution-receipts helpers
  assert.equal(isContextExecution({ name: "mcp_agy-dart_context_ctx_index" }), true);
  assert.equal(isContextExecution({ name: "mcp_agy-dart_context_ctx_batch" }), true);
  assert.equal(isContextExecution({ name: "default_api:mcp_agy-dart_context_ctx_execute" }), true);
  assert.equal(
    isContextExecution({ name: "call_mcp_tool", args: { ServerName: '"agy-dart_context"', ToolName: '"ctx_index"' } }),
    true
  );
  assert.equal(
    isContextExecution({ name: "call_mcp_tool", args: { ServerName: "agy-dart_context", ToolName: "ctx_batch" } }),
    true
  );
  assert.equal(extractFastSavingsToolName({ name: "default_api:mcp_agy-dart_fast_run_checks" }), "run_checks");

  const ctxClient = createPersistentMcpClient(path.join(ROOT, "context", "server.js"), {
    AGY_DART_DB_PATH: dbPath
  });

  try {
    await ctxClient.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "ctx-receipts-test", version: "1.0" }
    });

    // 1. Anonymous ctx_index emits executionReceipt FIRST in JSON
    const idxRaw = await ctxClient.request("tools/call", {
      name: "ctx_index",
      arguments: { cwd: wsA, path: "spec.md" }
    });
    assert.equal(idxRaw.result.isError, false);
    const idxText = idxRaw.result.content[0].text;
    assert.ok(Buffer.byteLength(idxText, "utf8") <= 8800);
    const idxJson = JSON.parse(idxText);
    assert.ok(idxJson.executionReceipt);
    assert.equal(executionReceiptFromText(idxText), idxJson.executionReceipt);

    // 2. Anonymous ctx_batch emits executionReceipt FIRST in JSON & stays <= 8.8 KB
    const batchRaw = await ctxClient.request("tools/call", {
      name: "ctx_batch",
      arguments: {
        cwd: wsA,
        commands: ['node -e "process.stdout.write(\'BATCH_TOKEN_OMEGA_505 line\\n\'.repeat(350))"']
      }
    });
    assert.equal(batchRaw.result.isError, false);
    const batchText = batchRaw.result.content[0].text;
    assert.ok(Buffer.byteLength(batchText, "utf8") <= 8800);
    const batchJson = JSON.parse(batchText);
    assert.ok(batchJson.executionReceipt);
    assert.equal(executionReceiptFromText(batchText), batchJson.executionReceipt);

    // 3. Anonymous ctx_execute also claims its source row
    const execRaw = await ctxClient.request("tools/call", {
      name: "ctx_execute",
      arguments: {
        cwd: wsA,
        language: "nodejs",
        code: 'console.log("EXEC_TOKEN_SIGMA_303 ".repeat(500));'
      }
    });
    assert.equal(execRaw.result.isError, false);
    const execText = execRaw.result.content[0].text;
    const execJson = JSON.parse(execText);
    assert.ok(execJson.executionReceipt);
    assert.ok(execJson.sourceId);

    // 4. Host-bound ctx_index/ctx_batch omit executionReceipt and host _meta overrides argument sessionId
    const boundIdx = await ctxClient.request("tools/call", {
      name: "ctx_index",
      arguments: { cwd: wsA, content: "BOUND_ONLY_TOKEN", sessionId: "spoofed-session" },
      _meta: { conversationId: "bound-owner" }
    });
    const boundIdxJson = JSON.parse(boundIdx.result.content[0].text);
    assert.equal(boundIdxJson.executionReceipt, undefined);

    const store = new ContextModeStore({ dbPath });
    try {
      const allBefore = store.getStats("all");
      assert.equal(store.getStats("bound-owner").sourcesCount, 1);
      assert.equal(store.getStats("spoofed-session").sourcesCount, 0);

      // Claim ctx_index via PostToolUse -> conv-idx
      runHook(
        "hooks/post-tool-use.mjs",
        {
          common: { conversationId: "conv-idx" },
          cwd: wsA,
          toolCall: { name: "mcp_agy-dart_context_ctx_index", args: { cwd: wsA, path: "spec.md" } },
          toolResponse: { content: [{ text: idxText }] }
        },
        dbPath
      );

      // Claim ctx_batch + ctx_execute via PreInvocation transcript -> conv-batch-exec
      const txPath = path.join(tmpDir, "tx-be.jsonl");
      const steps = [
        {
          step_index: 5,
          type: "PLANNER_RESPONSE",
          tool_calls: [
            { name: "call_mcp_tool", args: { ServerName: '"agy-dart_context"', ToolName: '"ctx_batch"' } },
            { name: "mcp_agy-dart_context_ctx_execute", args: {} }
          ]
        },
        { step_index: 6, type: "GENERIC", content: "Created At: 2026-11-24T01:00:00Z\n" + batchText.slice(0, 4000) },
        { step_index: 7, type: "GENERIC", content: "Created At: 2026-11-24T01:00:01Z\n" + execText.slice(0, 4000) }
      ];
      assert.deepEqual(executionReceiptsFromSteps(steps), [batchJson.executionReceipt, execJson.executionReceipt]);
      fs.writeFileSync(txPath, steps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
      runHook(
        "hooks/pre-invocation.mjs",
        { common: { conversationId: "conv-batch-exec", transcriptPath: txPath } },
        dbPath
      );

      // Verify events AND sources/chunks were claimed cleanly without double-counting
      const idxStats = store.getStats("conv-idx");
      assert.equal(idxStats.calls, 1);
      assert.equal(idxStats.sourcesCount, 1);
      assert.ok(idxStats.chunksCount >= 1);
      assert.equal(idxStats.totalRawBytes, idxJson.bytesTotal, "Must NOT double-count claimed ctx_index source in unrecordedSources");
      assert.ok(idxStats.keptOutBytes > 4000);
      assert.ok(store.search({ sessionId: "conv-idx", scope: "session", queries: ["INVOICE_TOKEN_DELTA_909"] }).hits.length >= 1);

      const beStats = store.getStats("conv-batch-exec");
      assert.equal(beStats.calls, 2);
      assert.equal(beStats.sourcesCount, 2);
      assert.equal(
        beStats.keptOutBytes,
        (batchJson.rawBytes - batchJson.returnedBytes) + (execJson.rawBytes - execJson.returnedBytes)
      );
      assert.ok(beStats.keptOutBytes > 5000);
      assert.ok(store.search({ sessionId: "conv-batch-exec", scope: "session", queries: ["BATCH_TOKEN_OMEGA_505"] }).hits.length >= 1);
      assert.ok(store.search({ sessionId: "conv-batch-exec", scope: "session", queries: ["EXEC_TOKEN_SIGMA_303"] }).hits.length >= 1);

      // Global totals unchanged before vs after claiming
      assert.deepEqual(store.getStats("all"), allBefore);

      // Anonymous MCP ctx_search with sourceId from same workspace STILL works after PostToolUse claimed source
      const sameWsSearch = JSON.parse(
        (
          await ctxClient.request("tools/call", {
            name: "ctx_search",
            arguments: { cwd: wsA, sourceId: idxJson.sourceId, queries: ["INVOICE_TOKEN_DELTA_909"] }
          })
        ).result.content[0].text
      );
      assert.ok(sameWsSearch.hits.length >= 1);

      // Foreign workspace MUST still be strictly blocked even with the exact sourceId!
      const foreignWsSearch = JSON.parse(
        (
          await ctxClient.request("tools/call", {
            name: "ctx_search",
            arguments: { cwd: wsB, sourceId: idxJson.sourceId, queries: ["INVOICE_TOKEN_DELTA_909"] }
          })
        ).result.content[0].text
      );
      assert.equal(foreignWsSearch.hits.length, 0);
    } finally {
      store.close();
    }
  } finally {
    await ctxClient.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("P1-3: Unified rootSessionId attribution & subagent rollup across PostToolUse, PreInvocation, server.mjs & store.getStats without double-counting", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-root-rollup-"));
  const dbPath = path.join(tmpDir, "context.db");
  const wsDir = path.join(tmpDir, "ws");
  fs.mkdirSync(wsDir, { recursive: true });

  const parentId = "11111111-2222-3333-4444-555555555555";
  const childId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const grandId = "99999999-8888-7777-6666-555555555555";
  const otherId = "ffffffff-0000-1111-2222-333333333333";

  const bigFile = path.join(wsDir, "module.js");
  fs.writeFileSync(
    bigFile,
    Array.from({ length: 60 }, (_, i) => `export function item_${i}() { return "${"value_".repeat(40)}_${i}"; }`).join("\n") + "\n",
    "utf8"
  );

  // Seed watchdog leases establishing parent -> child -> grandchild + cyclic guard check
  const parentTx = path.join(tmpDir, "parent-tx.jsonl");
  const childTx = path.join(tmpDir, "child-tx.jsonl");
  fs.writeFileSync(parentTx, "", "utf8");
  fs.writeFileSync(childTx, "", "utf8");

  const seed = new ContextModeStore({ dbPath });
  const now = Date.now();
  seed.setMeta(
    `watchdog_lease:${parentId}`,
    JSON.stringify({ v: 1, conversationId: parentId, rootSessionId: parentId, isSubagent: false, transcriptPath: parentTx, updatedTs: now })
  );
  seed.setMeta(
    `watchdog_lease:${childId}`,
    JSON.stringify({ v: 1, conversationId: childId, rootSessionId: parentId, parentConversationId: parentId, isSubagent: true, transcriptPath: childTx, updatedTs: now })
  );
  seed.setMeta(
    `watchdog_lease:${grandId}`,
    JSON.stringify({ v: 1, conversationId: grandId, rootSessionId: childId, parentConversationId: childId, isSubagent: true, updatedTs: now })
  );
  // Cyclic corrupt leases must never hang resolveRootSessionId / getSessionFamilyIds
  seed.setMeta("watchdog_lease:cyc-a", JSON.stringify({ conversationId: "cyc-a", rootSessionId: "cyc-b" }));
  seed.setMeta("watchdog_lease:cyc-b", JSON.stringify({ conversationId: "cyc-b", rootSessionId: "cyc-a" }));
  assert.ok(["cyc-a", "cyc-b"].includes(seed.resolveRootSessionId("cyc-a")));
  assert.equal(seed.resolveRootSessionId(childId), parentId);
  assert.equal(seed.resolveRootSessionId(grandId), parentId);
  assert.deepEqual(seed.getSessionFamilyIds(parentId).sort(), [childId, grandId, parentId].sort());

  // Pre-existing events recorded directly under childId, grandId, and unrelated otherId
  seed.recordEvent({ sessionId: childId, worktree: wsDir, kind: "interception", tool: "read_file", key: "blocked", sandboxBytes: 20000, returnedBytes: 0 });
  seed.recordGhostInterception({ sessionId: childId, filePath: path.join(wsDir, "huge.log"), fileSize: 20000, cutoffBytes: 16384 });
  seed.recordEvent({ sessionId: grandId, worktree: wsDir, kind: "cli_filter", tool: "run_command", key: "test-runner", sandboxBytes: 12000, returnedBytes: 2000 });
  seed.recordEvent({ sessionId: otherId, worktree: wsDir, kind: "interception", tool: "read_file", key: "blocked", sandboxBytes: 99000, returnedBytes: 0 });
  seed.close();

  const fastClient = createPersistentMcpClient(path.join(ROOT, "fast", "mcp-server.mjs"), { AGY_DART_DB_PATH: dbPath });
  const ctxClient = createPersistentMcpClient(path.join(ROOT, "context", "server.js"), { AGY_DART_DB_PATH: dbPath });
  let sidecarChild = null;

  try {
    await fastClient.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "f", version: "1" } });
    await ctxClient.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "c", version: "1" } });

    // Both parent AND child call identical read_slices!
    const [fastP, fastC] = await Promise.all([
      fastClient.request("tools/call", { name: "read_slices", arguments: { cwd: wsDir, outlines: ["module.js"] } }),
      fastClient.request("tools/call", { name: "read_slices", arguments: { cwd: wsDir, outlines: ["module.js"] } })
    ]);
    const fastText = fastP.result.content[0].text;
    const fastSavedEach = fs.statSync(bigFile).size - Buffer.byteLength(fastText, "utf8");
    assert.ok(fastSavedEach > 10000);

    // Child calls ctx_execute (claimed via PostToolUse with ONLY childId -> resolves to parentId via lease)
    const childExecRaw = await ctxClient.request("tools/call", {
      name: "ctx_execute",
      arguments: { cwd: wsDir, language: "nodejs", code: 'console.log("SUBAGENT_EXEC ".repeat(1500));' }
    });
    const childExecText = childExecRaw.result.content[0].text;
    const childExecJson = JSON.parse(childExecText);
    const execSaved = childExecJson.rawBytes - childExecJson.returnedBytes;
    assert.ok(execSaved > 4000);

    // Child ALSO finishes a final ctx_index whose response is ONLY in childTx (synced by Sidecar server.mjs!)
    const childIdxRaw = await ctxClient.request("tools/call", {
      name: "ctx_index",
      arguments: { cwd: wsDir, content: "CHILD_FINAL_INDEX_LINE\n".repeat(300), label: "child-final" }
    });
    const childIdxText = childIdxRaw.result.content[0].text;
    const childIdxJson = JSON.parse(childIdxText);
    const idxSaved = childIdxJson.bytesTotal - Buffer.byteLength(JSON.stringify(childIdxJson), "utf8");
    assert.ok(idxSaved > 5000);

    // Parent claims its read_slices via PostToolUse
    runHook(
      "hooks/post-tool-use.mjs",
      {
        common: { conversationId: parentId },
        cwd: wsDir,
        toolCall: { name: "mcp_agy-dart_fast_read_slices", args: { outlines: ["module.js"] } },
        toolResponse: { content: [{ text: fastText }] }
      },
      dbPath
    );

    // Child claims its ctx_execute via PostToolUse WITHOUT parentConversationId in payload (must resolve via lease!)
    runHook(
      "hooks/post-tool-use.mjs",
      {
        common: { conversationId: childId },
        cwd: wsDir,
        toolCall: { name: "mcp_agy-dart_context_ctx_execute", args: {} },
        toolResponse: { content: [{ text: childExecText }] }
      },
      dbPath
    );

    // Child's transcript contains BOTH its identical read_slices AND its final ctx_index
    const childSteps = [
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        tool_calls: [
          { name: "mcp_agy-dart_fast_read_slices", args: { outlines: ["module.js"] } },
          { name: "mcp_agy-dart_context_ctx_index", args: {} }
        ]
      },
      { step_index: 2, type: "GENERIC", content: "Created At: 2026-11-24T02:10:00Z\n" + fastText },
      { step_index: 3, type: "GENERIC", content: "Created At: 2026-11-24T02:10:01Z\n" + childIdxText }
    ];
    fs.writeFileSync(childTx, childSteps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");

    // Start live Sidecar HTTP server and query /api/stats for parentId -> must auto-sync childTx & roll up cleanly!
    const port = 29600 + Math.floor(Math.random() * 500);
    sidecarChild = spawn(process.execPath, [path.join(ROOT, "sidecars", "dashboard", "server.mjs")], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        ...CLEAN_HOST_ENV,
        PORT: String(port),
        SIDECAR_FORCE_HTTP: "1",
        AGY_DART_DB_PATH: dbPath,
        AGY_DART_DISABLE_COMPILE_CACHE: "1"
      }
    });

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("Sidecar failed to start")), 8000);
      sidecarChild.stdout.on("data", (d) => {
        if (d.toString("utf8").includes("listening at")) {
          clearTimeout(t);
          resolve();
        }
      });
      sidecarChild.on("exit", (c) => {
        clearTimeout(t);
        reject(new Error(`Sidecar exited early: ${c}`));
      });
    });

    const pageHtml = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port, path: "/", method: "GET" }, (res) => {
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => resolve(out));
      });
      req.on("error", reject);
      req.end();
    });
    const token = pageHtml.match(/<meta name="agy-dart-token" content="([a-f0-9]+)">/i)?.[1];
    assert.ok(token, "Expected Sidecar CSRF token in dashboard HTML");

    const parentResp1 = await httpPostJson(port, "/api/stats", { scope: "conversation", conversationId: parentId }, token);
    const parentResp2 = await httpPostJson(port, "/api/stats", { scope: "conversation", conversationId: parentId }, token);
    assert.equal(parentResp1.status, 200);
    assert.equal(parentResp2.status, 200);

    const expectedKeptOut = 20000 + 10000 + fastSavedEach + fastSavedEach + execSaved + idxSaved;
    assert.equal(parentResp1.json.keptOutBytes, expectedKeptOut, "Parent rollup must include parent + child + grandchild with zero double-counting");
    assert.equal(parentResp2.json.keptOutBytes, expectedKeptOut, "Repeated Sidecar /api/stats polls must be idempotent");
    assert.equal(parentResp1.json.breakdown.fastTools, 2);
    assert.equal(parentResp1.json.ghost.totalBlocked, 1, "Child ghost interception must roll up into parent");
    assert.equal(parentResp1.json.featureRoi.features.fast_tools.calls, 2);
    assert.equal(parentResp1.json.featureRoi.features.cli_filter.calls, 1);

    // Querying /api/stats with childId resolves to parent rootSessionId stats
    const childViewResp = await httpPostJson(port, "/api/stats", { scope: "conversation", conversationId: childId }, token);
    assert.equal(childViewResp.status, 200);
    assert.equal(childViewResp.json.keptOutBytes, expectedKeptOut);

    // Unrelated tab stays strictly isolated
    const otherResp = await httpPostJson(port, "/api/stats", { scope: "conversation", conversationId: otherId }, token);
    assert.equal(otherResp.json.keptOutBytes, 99000);
  } finally {
    if (sidecarChild) {
      sidecarChild.kill("SIGTERM");
      await new Promise((r) => sidecarChild.once("close", r));
    }
    await fastClient.close();
    await ctxClient.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("P1-1: hooks/filter-rules.mjs supports npm/pnpm/yarn/bun leading flags and safe Windows -- separators without cross-shell hazards", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-filter-win-"));
  const binDir = path.join(tmpDir, "bin");
  const shadowedDir = path.join(tmpDir, "shadowed");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(shadowedDir, { recursive: true });

  try {
    // Fake native .exe binaries vs .cmd/.ps1 shims on a deterministic mock Windows PATH
    fs.writeFileSync(path.join(binDir, "git.exe"), "MZ", "utf8");
    fs.writeFileSync(path.join(binDir, "node.exe"), "MZ", "utf8");
    fs.writeFileSync(path.join(binDir, "cargo.exe"), "MZ", "utf8");
    fs.writeFileSync(path.join(binDir, "npm.cmd"), "@echo off\r\n", "utf8");
    fs.writeFileSync(path.join(binDir, "npm.ps1"), "Write-Output ok\n", "utf8");
    fs.writeFileSync(path.join(binDir, "vitest.cmd"), "@echo off\r\n", "utf8");
    fs.writeFileSync(path.join(binDir, "vitest.ps1"), "Write-Output ok\n", "utf8");

    // Shadowed directory where git.exe sits alongside git.ps1 (PowerShell shadowing hazard)
    fs.writeFileSync(path.join(shadowedDir, "git.exe"), "MZ", "utf8");
    fs.writeFileSync(path.join(shadowedDir, "git.ps1"), "Write-Output shadow\n", "utf8");

    const winEnv = { PATH: binDir, PATHEXT: ".COM;.EXE;.BAT;.CMD;.PS1" };
    const winOpts = { platform: "win32", cwd: tmpDir, env: winEnv };

    // 1. Package manager leading flags (--prefix, -C, --cwd, --dir, --workspace, --filter, -F, yarn workspace)
    const shouldMatch = [
      ["npm --prefix e:\\work\\agy-dart test", "test-runner"],
      ["npm --prefix=e:\\work\\agy-dart run test", "test-runner"],
      ['npm --prefix "C:\\my repo\\app" run build', "build-lint"],
      ['npm --prefix "C:\\my repo\\app\\" test', "test-runner"],
      ["npm -C packages/api test", "test-runner"],
      ["npm -Cpackages/api run lint", "build-lint"],
      ["npm --workspace packages/api run typecheck", "build-lint"],
      ["npm --prefix app ci", "pkg-install"],
      ["npm --prefix app install", "pkg-install"],
      ["npm --silent test", "test-runner"],
      ["pnpm -C apps/web test", "test-runner"],
      ["pnpm --dir apps/web run check", "build-lint"],
      ["pnpm --filter web build", "build-lint"],
      ["pnpm -F web test", "test-runner"],
      ["pnpm -r test", "test-runner"],
      ["pnpm -C apps/web exec playwright test", "playwright"],
      ["pnpm -C apps/web install", "pkg-install"],
      ["yarn --cwd apps/web test", "test-runner"],
      ["yarn -C apps/web build", "build-lint"],
      ["yarn workspace web lint", "build-lint"],
      ["yarn --cwd apps/web playwright test", "playwright"],
      ["yarn --cwd apps/web add lodash", "pkg-install"],
      ["bun --cwd apps/web test", "test-runner"],
      ["bun -C apps/web run build", "build-lint"],
      ["bun --cwd apps/web install", "pkg-install"],
      ["cd packages && npm --prefix web test 2>&1", "test-runner"]
    ];
    for (const [cmd, expectedRule] of shouldMatch) {
      const m = matchFilterRule(cmd, winOpts);
      assert.equal(m?.rule.id, expectedRule, `Expected '${cmd}' to match '${expectedRule}', got ${m?.rule.id}`);
    }

    // Leading-flag rejections (unknown flags, missing value, skip flags, run add, unquoted PS @splat)
    const mustRejectPkg = [
      "npm --unknown-flag test",
      "npm --prefix",
      'npm --prefix "unclosed test',
      "npm --prefix app run custom-script",
      "npm --prefix app run add",
      "npm --prefix app test --watch",
      "npm --prefix app test -- --json",
      "pnpm --filter @org/api test"
    ];
    for (const cmd of mustRejectPkg) {
      assert.equal(matchFilterRule(cmd, winOpts), null, `Expected '${cmd}' to be rejected`);
    }
    assert.equal(parsePkgManagerCommand("npm --prefix app test")?.manager, "npm");

    // 2. Safe Windows `--` separators for native .exe binaries
    assert.equal(matchFilterRule("git diff -- hooks/filter-rules.mjs", winOpts)?.rule.id, "git-diff");
    assert.equal(matchFilterRule("git diff HEAD^ -- hooks/filter-rules.mjs", winOpts)?.rule.id, "git-diff");
    assert.equal(matchFilterRule("git status -- hooks/", winOpts)?.rule.id, "git-status");
    const boundedGitLog = matchFilterRule("git log -- hooks/filter-rules.mjs", winOpts);
    assert.equal(boundedGitLog?.rule.id, "git-log");
    assert.equal(boundedGitLog?.effectiveCommand, "git log -n 30 -- hooks/filter-rules.mjs");
    assert.equal(matchFilterRule("node --test -- tests/a.test.mjs", winOpts)?.rule.id, "test-runner");
    assert.equal(matchFilterRule("cargo test -- my_unit_test", winOpts)?.rule.id, "test-runner");

    // 3. Cross-shell hazards MUST remain strictly blocked on Windows!
    assert.equal(matchFilterRule("npm test -- --grep foo", winOpts), null, "npm .cmd/.ps1 shim with -- must bail out on Windows");
    assert.equal(matchFilterRule("npm --prefix app test -- --grep foo", winOpts), null);
    assert.equal(matchFilterRule("vitest run -- --reporter=verbose", winOpts), null);
    assert.equal(matchFilterRule("git diff -- a,b", winOpts), null, "Unquoted comma must still bail out");
    assert.equal(matchFilterRule("git diff -- --stat", winOpts), null, "SKIP_FLAGS_RE must still bail out");
    assert.equal(matchFilterRule("git log -- -p", winOpts), null, "Rule skipFlags must still bail out");

    // Sibling .ps1 shadowing native .exe must bail out unless .exe is explicit
    const shadowedOpts = { platform: "win32", cwd: tmpDir, env: { PATH: shadowedDir, PATHEXT: ".COM;.EXE;.BAT;.CMD;.PS1" } };
    assert.equal(matchFilterRule("git diff -- hooks/filter-rules.mjs", shadowedOpts), null, "Sibling git.ps1 must block -- on Windows");
    assert.equal(matchFilterRule("git.exe diff -- hooks/filter-rules.mjs", shadowedOpts)?.rule.id, "git-diff");

    // 4. End-to-end live PreToolUse overwrite + cli-filter execution for `git diff -- <file>` on real OS
    const repoDir = path.join(tmpDir, "repo");
    const dbPath = path.join(tmpDir, "cli-e2e.db");
    fs.mkdirSync(repoDir, { recursive: true });
    const gitRun = (args) =>
      spawnSync("git", args, { cwd: repoDir, encoding: "utf8", windowsHide: true });
    if (gitRun(["init"]).status === 0) {
      gitRun(["config", "user.email", "test@example.com"]);
      gitRun(["config", "user.name", "Test"]);
      const tracked = path.join(repoDir, "target.txt");
      fs.writeFileSync(tracked, "line-0\n", "utf8");
      gitRun(["add", "target.txt"]);
      gitRun(["commit", "-m", "init"]);
      fs.writeFileSync(tracked, Array.from({ length: 300 }, (_, i) => `updated_line_${i}_${"x".repeat(40)}`).join("\n") + "\n", "utf8");

      const hookRes = runHook(
        "hooks/pre-tool-use.mjs",
        {
          conversationId: "conv-git-dd",
          cwd: repoDir,
          toolCall: { name: "run_command", args: { CommandLine: "git diff -- target.txt" } }
        },
        dbPath
      );
      assert.equal(hookRes.decision, "allow");
      assert.ok(hookRes.overwrite?.CommandLine?.includes("cli-filter.mjs"), "Live PreToolUse must rewrite git diff -- target.txt");
      const execOut = spawnSync(hookRes.overwrite.CommandLine, {
        shell: process.platform === "win32" ? "powershell.exe" : true,
        cwd: repoDir,
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, ...CLEAN_HOST_ENV, AGY_DART_DB_PATH: dbPath }
      });
      assert.equal(execOut.status, 0, execOut.stderr);
      assert.ok(execOut.stdout.includes("target.txt"));
      assert.ok(Buffer.byteLength(execOut.stdout, "utf8") <= 8800);
      const st = new ContextModeStore({ dbPath });
      try {
        const stats = st.getStats("conv-git-dd");
        assert.equal(stats.breakdown.cliFilters, 1);
        assert.ok(stats.keptOutBytes > 4000);
      } finally {
        st.close();
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("P0/P1 Hardening: anon ctx_search without sourceId, concurrent anon ctx_index, host-bound fast fingerprint isolation, >128KB tail claims, childId root rollup & filter guards", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v17-hardening-"));
  const dbPath = path.join(tmpDir, "context.db");
  const wsA = path.join(tmpDir, "ws-a");
  const wsB = path.join(tmpDir, "ws-b");
  fs.mkdirSync(wsA, { recursive: true });
  fs.mkdirSync(wsB, { recursive: true });

  fs.writeFileSync(
    path.join(wsA, "doc.md"),
    "# Ledger Spec\n\n" + "HARDEN_ANON_SEARCH_NEEDLE_8844 reconciliation entry.\n".repeat(120),
    "utf8"
  );
  fs.writeFileSync(
    path.join(wsA, "big.js"),
    Array.from({ length: 80 }, (_, i) => `export function fn_${i}() { return "${"abcdef".repeat(40)}_${i}"; }`).join("\n") + "\n",
    "utf8"
  );

  // 1. Double-underscore MCP names (Claude Code / Codex) supported by execution-receipts
  assert.equal(isContextExecution({ name: "mcp__agy-dart_context__ctx_execute" }), true);
  assert.equal(isContextExecution({ name: "mcp__agy-dart_context__ctx_index" }), true);
  assert.equal(isContextExecution({ name: "mcp__agy-dart_context__ctx_batch" }), true);
  assert.equal(extractFastSavingsToolName({ name: "mcp__agy-dart_fast__read_slices" }), "read_slices");
  assert.equal(extractFastSavingsToolName({ name: "mcp__agy-dart_fast__run_checks" }), "run_checks");
  assert.equal(extractFastSavingsToolName({ name: "mcp__agy-dart_fast__batch_search" }), "batch_search");
  assert.ok(fastToolFingerprint("mcp__agy-dart_fast__read_slices", "## Outline: big.js\nexport function fn_0()"));

  // 2. Filter-rules playwright guards + quoted @scope + escaped-backslash quote hazard checks
  const binDir = path.join(tmpDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "git.exe"), "MZ", "utf8");
  fs.writeFileSync(path.join(binDir, "npm.cmd"), "@echo off\r\n", "utf8");
  const winOpts = { platform: "win32", cwd: tmpDir, env: { PATH: binDir, PATHEXT: ".COM;.EXE;.BAT;.CMD;.PS1" } };
  assert.equal(matchFilterRule("npm --prefix app run playwright test", winOpts), null);
  assert.equal(matchFilterRule("npm --prefix app playwright test", winOpts), null);
  assert.equal(matchFilterRule("npm --prefix app exec playwright test", winOpts)?.rule.id, "playwright");
  assert.equal(matchFilterRule('pnpm --filter "@org/api" test', winOpts)?.rule.id, "test-runner");
  assert.equal(matchFilterRule("pnpm --filter=@org/api test", winOpts)?.rule.id, "test-runner");
  assert.equal(matchFilterRule('git diff -- "a\\\\" "a,b"', winOpts)?.rule.id, "git-diff");
  assert.equal(matchFilterRule('git diff -- "a\\\\" a,b "c"', winOpts), null);

  const ctxClient = createPersistentMcpClient(path.join(ROOT, "context", "server.js"), { AGY_DART_DB_PATH: dbPath });
  const fastClient = createPersistentMcpClient(path.join(ROOT, "fast", "mcp-server.mjs"), { AGY_DART_DB_PATH: dbPath });
  try {
    await ctxClient.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "h", version: "1" } });
    await fastClient.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "h", version: "1" } });

    // 3. Concurrent anonymous ctx_index by two conversations + anonymous ctx_search WITHOUT sourceId
    const [rA, rB] = await Promise.all([
      ctxClient.request("tools/call", { name: "ctx_index", arguments: { cwd: wsA, path: "doc.md" } }),
      ctxClient.request("tools/call", { name: "ctx_index", arguments: { cwd: wsA, path: "doc.md" } })
    ]);
    const txtA = rA.result.content[0].text;
    const txtB = rB.result.content[0].text;
    const jsonA = JSON.parse(txtA);
    const jsonB = JSON.parse(txtB);
    assert.notEqual(jsonA.sourceId, jsonB.sourceId, "Anonymous concurrent ctx_index calls must not collide on one sourceId");

    runHook(
      "hooks/post-tool-use.mjs",
      {
        common: { conversationId: "conv-h-a" },
        cwd: wsA,
        toolCall: { name: "mcp_agy-dart_context_ctx_index", args: { cwd: wsA, path: "doc.md" } },
        toolResponse: { content: [{ text: txtA }] }
      },
      dbPath
    );
    runHook(
      "hooks/post-tool-use.mjs",
      {
        common: { conversationId: "conv-h-b" },
        cwd: wsA,
        toolCall: { name: "mcp_agy-dart_context_ctx_index", args: { cwd: wsA, path: "doc.md" } },
        toolResponse: { content: [{ text: txtB }] }
      },
      dbPath
    );

    // Anonymous ctx_search WITHOUT sourceId in same workspace MUST still find claimed sources
    const anonSameNoSrc = JSON.parse(
      (
        await ctxClient.request("tools/call", {
          name: "ctx_search",
          arguments: { cwd: wsA, queries: ["HARDEN_ANON_SEARCH_NEEDLE_8844"] }
        })
      ).result.content[0].text
    );
    assert.ok(anonSameNoSrc.hits.length >= 1, "Same-workspace anonymous ctx_search without sourceId must find claimed sources");

    // Foreign workspace without sourceId MUST remain blocked
    const anonForeignNoSrc = JSON.parse(
      (
        await ctxClient.request("tools/call", {
          name: "ctx_search",
          arguments: { cwd: wsB, queries: ["HARDEN_ANON_SEARCH_NEEDLE_8844"] }
        })
      ).result.content[0].text
    );
    assert.equal(anonForeignNoSrc.hits.length, 0, "Foreign workspace anonymous ctx_search must stay isolated");

    // 4. Host-bound fast event stores claim_fingerprint -> PreInvocation must NOT steal another conversation's unclaimed event
    const fastDirect = await fastClient.request("tools/call", {
      name: "read_slices",
      arguments: { cwd: wsA, outlines: ["big.js"] },
      _meta: { conversationId: "conv-direct-own" }
    });
    const fastAnon = await fastClient.request("tools/call", {
      name: "read_slices",
      arguments: { cwd: wsA, outlines: ["big.js"] }
    });
    assert.equal(fastDirect.result.isError, false);
    assert.equal(fastAnon.result.isError, false);
    const fastOutText = fastDirect.result.content[0].text;
    const txDirect = path.join(tmpDir, "tx-direct.jsonl");
    const nowIso = new Date().toISOString();
    fs.writeFileSync(
      txDirect,
      [
        JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", tool_calls: [{ name: "mcp_agy-dart_fast_read_slices", args: {} }] }),
        JSON.stringify({ step_index: 2, type: "GENERIC", content: `Created At: ${nowIso}\nCompleted At: ${nowIso}\n` + fastOutText })
      ].join("\n") + "\n",
      "utf8"
    );
    runHook("hooks/pre-invocation.mjs", { common: { conversationId: "conv-direct-own", transcriptPath: txDirect } }, dbPath);

    const store = new ContextModeStore({ dbPath });
    try {
      assert.equal(store.getStats("conv-h-a").sourcesCount, 1);
      assert.equal(store.getStats("conv-h-b").sourcesCount, 1);
      assert.ok(store.search({ sessionId: "conv-h-b", scope: "session", sourceId: jsonB.sourceId, queries: ["HARDEN_ANON_SEARCH_NEEDLE_8844"] }).hits.length >= 1);
      assert.equal(store.getStats("conv-direct-own").calls, 1, "Host-bound fast event must not trigger stealing another conversation's unclaimed row");

      // 5. store.getStats/getFeatureRoi/getGhostStats/search(childId) resolve rootSessionId cleanly
      store.setMeta("watchdog_lease:root-u", JSON.stringify({ conversationId: "root-u", rootSessionId: "root-u", isSubagent: false }));
      store.setMeta("watchdog_lease:child-u", JSON.stringify({ conversationId: "child-u", rootSessionId: "root-u", parentConversationId: "root-u", isSubagent: true }));
      store.recordEvent({ sessionId: "root-u", worktree: wsA, kind: "execution", tool: "ctx_execute", sandboxBytes: 18000, returnedBytes: 600 });
      store.recordGhostInterception({ sessionId: "root-u", filePath: path.join(wsA, "big.log"), fileSize: 25000, cutoffBytes: 16384 });
      const rootDoc = "ROOT_FAMILY_VISIBLE_TOKEN_551";
      store.indexContent({ sessionId: "root-u", worktree: wsA, kind: "file", label: "r-doc", content: rootDoc });
      assert.equal(store.getStats("child-u").calls, 1);
      assert.equal(store.getStats("child-u").keptOutBytes, 17400 + Buffer.byteLength(rootDoc, "utf8"));
      assert.equal(store.getStats("child-u").keptOutBytes, store.getStats("root-u").keptOutBytes);
      assert.equal(store.getFeatureRoi("child-u").features.sandbox_execute.calls, 1);
      assert.equal(store.getGhostStats("child-u").totalBlocked, 1);
      assert.ok(store.search({ sessionId: "child-u", scope: "session", queries: ["ROOT_FAMILY_VISIBLE_TOKEN_551"] }).hits.length >= 1);
    } finally {
      store.close();
    }

    // 6. >128KB truncated transcript claims unclaimed tail call even when prior claimed call was <120s earlier, and never steals ancient pending row
    const tailDb = path.join(tmpDir, "tail.db");
    const stTail = new ContextModeStore({ dbPath: tailDb });
    const fp = fastToolFingerprint("read_slices", fastOutText);
    const tBase = Date.now();
    stTail.open();
    stTail.db
      .prepare(
        "INSERT INTO events (session_id, worktree, agent, kind, tool, bytes, body, sandbox_bytes, returned_bytes, claim_fingerprint, claimed_conv, created_at, accessed_at) VALUES (?, ?, 'antigravity', 'fast_slice', 'read_slices', 20000, '', 20000, 1000, ?, ?, ?, ?)"
      )
      .run("conv-tail-1", wsA, fp, "conv-tail-1", new Date(tBase - 30000).toISOString(), new Date(tBase - 30000).toISOString());
    stTail.db
      .prepare(
        "INSERT INTO events (session_id, worktree, agent, kind, tool, bytes, body, sandbox_bytes, returned_bytes, claim_fingerprint, claimed_conv, created_at, accessed_at) VALUES (?, ?, 'antigravity', 'fast_slice', 'read_slices', 20000, '', 20000, 1000, ?, NULL, ?, ?)"
      )
      .run("workspace:ancient", wsA, fp, new Date(tBase - 7200000).toISOString(), new Date(tBase - 7200000).toISOString());
    stTail.db
      .prepare(
        "INSERT INTO events (session_id, worktree, agent, kind, tool, bytes, body, sandbox_bytes, returned_bytes, claim_fingerprint, claimed_conv, created_at, accessed_at) VALUES (?, ?, 'antigravity', 'fast_slice', 'read_slices', 20000, '', 20000, 1000, ?, NULL, ?, ?)"
      )
      .run("workspace:tail", wsA, fp, new Date(tBase + 20000).toISOString(), new Date(tBase + 20000).toISOString());
    stTail.close();

    const txTail = path.join(tmpDir, "tx-tail.jsonl");
    fs.writeFileSync(
      txTail,
      [
        JSON.stringify({ step_index: 1, type: "GENERIC", content: "P".repeat(150000) }),
        JSON.stringify({ step_index: 50, type: "PLANNER_RESPONSE", tool_calls: [{ name: "mcp_agy-dart_fast_batch_search", args: {} }] }),
        JSON.stringify({
          step_index: 51,
          type: "GENERIC",
          content: `Created At: ${new Date(tBase).toISOString()}\nCompleted At: ${new Date(tBase + 1000).toISOString()}\n## Query 1\nok`
        }),
        JSON.stringify({ step_index: 54, type: "PLANNER_RESPONSE", tool_calls: [{ name: "mcp_agy-dart_fast_read_slices", args: {} }] }),
        JSON.stringify({
          step_index: 55,
          type: "GENERIC",
          content: `Created At: ${new Date(tBase + 19000).toISOString()}\nCompleted At: ${new Date(tBase + 20000).toISOString()}\n` + fastOutText
        })
      ].join("\n") + "\n",
      "utf8"
    );
    runHook("hooks/pre-invocation.mjs", { common: { conversationId: "conv-tail-1", transcriptPath: txTail } }, tailDb);
    runHook("hooks/pre-invocation.mjs", { common: { conversationId: "conv-tail-1", transcriptPath: txTail } }, tailDb);
    const stTailCheck = new ContextModeStore({ dbPath: tailDb });
    try {
      assert.equal(stTailCheck.getStats("conv-tail-1").calls, 2, "Truncated tail must claim Step 55 once and leave ancient pending row untouched");
      assert.equal(stTailCheck.getStats("all").calls, 3);
    } finally {
      stTailCheck.close();
    }
  } finally {
    await ctxClient.close();
    await fastClient.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
