import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { ContextModeStore } from "../context/lib/store.js";
import { createSummaryDbReader } from "../context/lib/store/settings-maintenance.js";
import { createTools } from "../context/lib/tools.js";
import { stableStringify } from "../context/lib/stable-json.js";
import {
  getConversationViaApi,
  normalizeConversationApiRecord,
  parseLoopbackLsAddress
} from "../context/lib/conversation-api.js";
import {
  clearConversationSummaryCache,
  lookupConversationSummary,
  writeWatchdogLease,
  readWatchdogLease
} from "../context/lib/watchdog-lease.js";
import { WatchdogMonitor, WATCHDOG_PHASES } from "../context/lib/watchdog.js";
import {
  clearTranscriptScanCache,
  findTranscriptForConversation
} from "../context/lib/cache-analyzer.js";
import { sendSidecarKeepaliveMessage } from "../sidecars/dashboard/server.mjs";
import { RUNTIME_FILES } from "../scripts/install.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function buildCleanAnonymousEnv(extraEnv = {}) {
  const env = {
    ...process.env,
    AGY_DART_DISABLE_COMPILE_CACHE: "1",
    ...extraEnv
  };
  delete env.ANTIGRAVITY_CONVERSATION_ID;
  delete env.ANTIGRAVITY_ROOT_CONVERSATION_ID;
  delete env.ANTIGRAVITY_PARENT_CONVERSATION_ID;
  delete env.CONVERSATION_ID;
  delete env.ANTIGRAVITY_SESSION_ID;
  return env;
}

function sendContextRpc(messages, extraEnv = {}) {
  const input = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
  const res = spawnSync(process.execPath, [path.join(ROOT, "context", "server.js")], {
    input,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
    env: buildCleanAnonymousEnv(extraEnv)
  });
  assert.equal(res.status, 0, `context/server.js failed: ${res.stderr}`);
  return res.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function startMockConversationServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        } catch {}
        handler(req, res, body);
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        server,
        address: `127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r()))
      });
    });
  });
}

test("Wave3-1 (P1-2): context/server.js returns compact single-line JSON and drops duplicate ASCII report from MCP ctx_stats while preserving direct tools.ctx_stats() report", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-w3-compact-"));
  const dbPath = path.join(tmpDir, "context.db");
  try {
    const seed = new ContextModeStore({ dbPath });
    seed.recordEvent({
      sessionId: "w3-compact-sess",
      worktree: tmpDir,
      kind: "cli_filter",
      tool: "run_command",
      key: "pytest",
      sandboxBytes: 32000,
      returnedBytes: 1600
    });
    const directTools = createTools({ store: seed, getCwd: () => tmpDir, getSessionId: () => "w3-compact-sess" });
    const directStats = await directTools.ctx_stats({});
    assert.equal(typeof directStats.report, "string", "Direct tools.ctx_stats() must preserve report for backward compatibility");
    assert.ok(directStats.report.includes("agy-dart context stats"));
    seed.close();

    const resps = sendContextRpc(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "cli-host", version: "1.0" } }
        },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "ctx_stats", arguments: { sessionId: "w3-compact-sess", cwd: tmpDir } }
        },
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "ctx_doctor", arguments: { cwd: tmpDir } }
        }
      ],
      { AGY_DART_DB_PATH: dbPath }
    );

    const statsCall = resps.find((r) => r.id === 2)?.result;
    const doctorCall = resps.find((r) => r.id === 3)?.result;
    assert.equal(statsCall.isError, false);
    assert.equal(doctorCall.isError, false);

    const statsText = statsCall.content[0].text;
    const doctorText = doctorCall.content[0].text;

    assert.equal(statsText.includes("\n  "), false, "ctx_stats MCP JSON must be compact (no pretty indentation)");
    assert.equal(doctorText.includes("\n  "), false, "ctx_doctor MCP JSON must be compact (no pretty indentation)");

    const parsedStats = JSON.parse(statsText);
    assert.equal(statsText, JSON.stringify(parsedStats));
    assert.equal("report" in parsedStats, false, "MCP ctx_stats must omit duplicate ASCII report string");
    assert.equal(parsedStats.stats.sessionId, "w3-compact-sess");
    assert.equal(parsedStats.stats.totalRawBytes, 32000);
    assert.ok(parsedStats.ghost && parsedStats.featureRoi);

    const legacyPrettyBytes = Buffer.byteLength(JSON.stringify(directStats, null, 2), "utf8");
    const compactBytes = Buffer.byteLength(statsText, "utf8");
    assert.ok(
      compactBytes < legacyPrettyBytes * 0.65,
      `Expected >=35% reduction on ctx_stats MCP wire payload (got ${compactBytes} vs legacy ${legacyPrettyBytes})`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Wave3-2 (P1-2): progressive MCP Apps negotiation exposes ui://agy-dart/diagnostics.html, _meta.ui.resourceUri, and lean content + structuredContent only for UI-capable clients", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-w3-mcpapp-"));
  const dbPath = path.join(tmpDir, "context.db");
  try {
    // 1. Non-UI client: zero resources, zero _meta.ui, zero structuredContent
    const nonUi = sendContextRpc(
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {} } },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        { jsonrpc: "2.0", id: 3, method: "resources/list" },
        { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "ctx_doctor", arguments: { cwd: tmpDir } } }
      ],
      { AGY_DART_DB_PATH: dbPath }
    );
    const nonUiInit = nonUi.find((r) => r.id === 1)?.result;
    assert.deepEqual(nonUiInit.capabilities, { tools: {} });
    const nonUiTools = nonUi.find((r) => r.id === 2)?.result?.tools;
    assert.equal(nonUiTools.some((t) => "_meta" in t), false, "Non-UI client must not receive _meta.ui on tools/list");
    assert.deepEqual(nonUi.find((r) => r.id === 3)?.result, { resources: [] });
    assert.equal("structuredContent" in nonUi.find((r) => r.id === 4).result, false);

    // 2. UI-capable client declaring io.modelcontextprotocol/ui extension
    const uiResps = sendContextRpc(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {
              extensions: {
                "io.modelcontextprotocol/ui": {
                  mimeTypes: ["text/html;profile=mcp-app"]
                }
              }
            }
          }
        },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        { jsonrpc: "2.0", id: 3, method: "resources/list" },
        { jsonrpc: "2.0", id: 4, method: "resources/read", params: { uri: "ui://agy-dart/diagnostics.html" } },
        { jsonrpc: "2.0", id: 5, method: "resources/read", params: { uri: "ui://agy-dart/does-not-exist.html" } },
        { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "ctx_stats", arguments: { sessionId: "w3-ui-s1", cwd: tmpDir } } },
        { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "ctx_doctor", arguments: { cwd: tmpDir } } }
      ],
      { AGY_DART_DB_PATH: dbPath }
    );

    const uiInit = uiResps.find((r) => r.id === 1)?.result;
    assert.ok(uiInit.capabilities.resources, "UI client initialize must advertise resources capability");
    assert.ok(uiInit.capabilities.extensions?.["io.modelcontextprotocol/ui"]);

    const uiTools = uiResps.find((r) => r.id === 2)?.result?.tools;
    assert.equal(JSON.stringify(uiTools), stableStringify(uiTools), "UI tools/list must remain canonically sorted");
    const byName = Object.fromEntries(uiTools.map((t) => [t.name, t]));
    assert.equal(byName.ctx_stats._meta?.ui?.resourceUri, "ui://agy-dart/diagnostics.html");
    assert.equal(byName.ctx_doctor._meta?.ui?.resourceUri, "ui://agy-dart/diagnostics.html");
    assert.equal(
      byName.ctx_stats._meta?.["com.google.antigravity/ui"],
      undefined,
      "Inline MCP App must NOT register duplicate aux_pane entrypoint alongside Sidecar"
    );
    assert.equal(byName.ctx_execute._meta, undefined, "Non-UI tools must stay clean without _meta");

    const resList = uiResps.find((r) => r.id === 3)?.result?.resources;
    assert.equal(resList.length, 1);
    assert.equal(resList[0].uri, "ui://agy-dart/diagnostics.html");
    assert.equal(resList[0].mimeType, "text/html;profile=mcp-app");

    const resRead = uiResps.find((r) => r.id === 4)?.result?.contents;
    assert.equal(resRead.length, 1);
    assert.equal(resRead[0].mimeType, "text/html;profile=mcp-app");
    const html = resRead[0].text;
    assert.ok(html.includes("ui/initialize") && html.includes("2026-01-26"));
    assert.ok(html.includes("ui/notifications/initialized") && html.includes("ui/notifications/tool-result"));
    assert.ok(html.includes("ui/notifications/host-context-changed") && html.includes("ui/notifications/size-changed"));
    assert.ok(html.includes("--color-background-primary") && html.includes('msg.method === "ping"'));
    assert.equal(/<script[^>]+src=/i.test(html), false, "MCP App HTML must have zero external scripts (CSP default-src none)");
    assert.equal(/<link[^>]+href=/i.test(html), false, "MCP App HTML must have zero external stylesheets");

    const missingErr = uiResps.find((r) => r.id === 5)?.error;
    assert.equal(missingErr?.code, -32002);

    const uiStats = uiResps.find((r) => r.id === 6)?.result;
    const uiStatsText = uiStats.content[0].text;
    const uiStatsSummary = JSON.parse(uiStatsText);
    assert.equal(uiStatsSummary.uiRendered, true);
    assert.equal(uiStats.structuredContent.kind, "ctx_stats");
    assert.equal(uiStats.structuredContent.stats.sessionId, "w3-ui-s1");
    assert.ok(
      uiStatsText.length < JSON.stringify(uiStats.structuredContent).length,
      "UI client ctx_stats content text must be leaner than structuredContent"
    );

    const uiDoctor = uiResps.find((r) => r.id === 7)?.result;
    const uiDoctorText = uiDoctor.content[0].text;
    const uiDoctorSummary = JSON.parse(uiDoctorText);
    assert.equal(uiDoctorSummary.uiRendered, true);
    assert.equal(uiDoctorSummary.ok, true);
    assert.equal(uiDoctor.structuredContent.kind, "ctx_doctor");
    assert.ok(uiDoctor.structuredContent.doctor && uiDoctor.structuredContent.readGuard);
    assert.ok(
      uiDoctorText.length < JSON.stringify(uiDoctor.structuredContent).length,
      "UI client ctx_doctor content text must be leaner than structuredContent"
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Wave3-3 (P1-6): conversation-api.js enforces loopback-only LS validation and parses official Connect HTTP+JSON GetConversation responses", async () => {
  assert.deepEqual(parseLoopbackLsAddress("127.0.0.1:5387"), {
    hostname: "127.0.0.1",
    port: 5387,
    hostHeader: "127.0.0.1:5387"
  });
  assert.deepEqual(parseLoopbackLsAddress("localhost:5387"), {
    hostname: "localhost",
    port: 5387,
    hostHeader: "localhost:5387"
  });
  assert.deepEqual(parseLoopbackLsAddress("[::1]:5387"), {
    hostname: "::1",
    port: 5387,
    hostHeader: "[::1]:5387"
  });
  for (const bad of ["192.168.1.10:5387", "evil.example.com:443", "http://127.0.0.1:5387", "127.0.0.1:5387/foo", "127.0.0.1:0", "127.0.0.1:70000"]) {
    assert.equal(parseLoopbackLsAddress(bad), null, `Must reject invalid/non-loopback address: ${bad}`);
  }

  const blocked = await getConversationViaApi("conv-sec-1", {
    lsAddress: "10.0.0.5:5387",
    csrfToken: "secret-token"
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blockedNonLoopback, true);

  const seenHeaders = [];
  const mock = await startMockConversationServer((req, res, body) => {
    seenHeaders.push({
      url: req.url,
      connectVer: req.headers["connect-protocol-version"],
      csrf: req.headers["x-antigravity-csrf-token"],
      ctype: req.headers["content-type"]
    });
    if (body.conversationId === "conv-archived") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "conv-archived",
        metadata: { projectId: "proj-1" },
        annotations: { title: "Archived Thread", archived: true },
        state: { runState: "RUN_STATE_IDLE" }
      }));
      return;
    }
    if (body.conversationId === "conv-child") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "conv-child",
        metadata: { parentConversationId: "conv-parent", projectId: "proj-1" },
        annotations: {},
        state: { runState: "RUN_STATE_RUNNING" }
      }));
      return;
    }
    if (body.conversationId === "conv-missing") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: "not_found", message: "not found" }));
      return;
    }
    res.writeHead(501, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: "unimplemented", message: "old host" }));
  });

  try {
    const arch = await getConversationViaApi("conv-archived", { lsAddress: mock.address, csrfToken: "tok-123" });
    assert.equal(arch.ok, true);
    assert.equal(arch.found, true);
    assert.equal(arch.archived, true);
    assert.equal(arch.isSubagent, false);
    assert.equal(arch.projectId, "proj-1");
    assert.equal(seenHeaders[0].url, "/product.v1.ConversationService/GetConversation");
    assert.equal(seenHeaders[0].connectVer, "1");
    assert.equal(seenHeaders[0].csrf, "tok-123");

    const child = await getConversationViaApi("conv-child", { lsAddress: mock.address, csrfToken: "tok-123" });
    assert.equal(child.ok, true);
    assert.equal(child.isSubagent, true);
    assert.equal(child.isRunning, true);

    const missing = await getConversationViaApi("conv-missing", { lsAddress: mock.address, csrfToken: "tok-123" });
    assert.equal(missing.ok, true);
    assert.equal(missing.found, false);

    const unimpl = await getConversationViaApi("conv-old", { lsAddress: mock.address, csrfToken: "tok-123" });
    assert.equal(unimpl.ok, false);
    assert.equal(unimpl.unsupported, true);

    const normWrapped = normalizeConversationApiRecord({ conversation: { id: "c1", state: { runState: "RUN_STATE_CANCELLING" } } });
    assert.equal(normWrapped.isCancelling, true);
  } finally {
    await mock.close();
  }
});

test("Wave3-4 (P1-6): sendSidecarKeepaliveMessage & WatchdogMonitor prefer ConversationService API and fall back cleanly when unsupported", async () => {
  const mock = await startMockConversationServer((req, res, body) => {
    const id = body.conversationId;
    if (id === "conv-api-archived") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id, metadata: { projectId: "p-a" }, annotations: { archived: true }, state: { runState: "RUN_STATE_IDLE" } }));
      return;
    }
    if (id === "conv-api-sub") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id, metadata: { parentConversationId: "conv-root", projectId: "p-a" }, annotations: {}, state: { runState: "RUN_STATE_IDLE" } }));
      return;
    }
    if (id === "conv-api-running") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id, metadata: { projectId: "p-a" }, annotations: {}, state: { runState: "RUN_STATE_RUNNING" } }));
      return;
    }
    if (id === "conv-api-idle") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id, metadata: { projectId: "proj-from-api" }, annotations: { archived: false }, state: { runState: "RUN_STATE_IDLE" } }));
      return;
    }
    res.writeHead(501, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: "unimplemented" }));
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-w3-wd-"));
  const dbPath = path.join(tmpDir, "context.db");
  const store = new ContextModeStore({ dbPath });
  try {
    const execCalls = [];
    const mockExec = async (args, opts) => {
      execCalls.push({ args, projectId: opts?.projectId || "" });
      if (args[0] === "get-conversation-metadata") {
        return { response: { conversationMetadata: { metadata: { projectId: "proj-from-agentapi" } } } };
      }
      return { ok: true };
    };

    const archRes = await sendSidecarKeepaliveMessage("conv-api-archived", "OK", {
      execFn: mockExec,
      allowDefaultSummaryDb: false,
      lsAddress: mock.address,
      csrfToken: "tok-ka"
    });
    assert.equal(archRes.skippedArchived, true);
    assert.equal(archRes.source, "conversation_api");

    const subRes = await sendSidecarKeepaliveMessage("conv-api-sub", "OK", {
      execFn: mockExec,
      allowDefaultSummaryDb: false,
      lsAddress: mock.address,
      csrfToken: "tok-ka"
    });
    assert.equal(subRes.skippedSubagent, true);

    const runRes = await sendSidecarKeepaliveMessage("conv-api-running", "OK", {
      execFn: mockExec,
      allowDefaultSummaryDb: false,
      lsAddress: mock.address,
      csrfToken: "tok-ka"
    });
    assert.equal(runRes.skippedActiveRun, true);
    assert.equal(runRes.runState, "RUN_STATE_RUNNING");
    assert.equal(execCalls.length, 0, "Suppressed keepalives via ConversationService must invoke zero agentapi subprocesses");

    const idleRes = await sendSidecarKeepaliveMessage("conv-api-idle", "OK", {
      execFn: mockExec,
      allowDefaultSummaryDb: false,
      lsAddress: mock.address,
      csrfToken: "tok-ka"
    });
    assert.equal(idleRes.ok, true);
    assert.equal(execCalls.length, 1, "Successful GetConversation must skip agentapi get-conversation-metadata");
    assert.equal(execCalls[0].args[0], "send-message");
    assert.equal(execCalls[0].projectId, "proj-from-api");

    // Fallback on 501 unimplemented -> calls legacy get-conversation-metadata + send-message
    const fbRes = await sendSidecarKeepaliveMessage("conv-legacy-host", "OK", {
      execFn: mockExec,
      allowDefaultSummaryDb: false,
      lsAddress: mock.address,
      csrfToken: "tok-ka"
    });
    assert.equal(fbRes.ok, true);
    assert.equal(execCalls[1].args[0], "get-conversation-metadata");
    assert.equal(execCalls[2].args[0], "send-message");
    assert.equal(execCalls[2].projectId, "proj-from-agentapi");

    // WatchdogMonitor API-first archived check + periodic expired IDLE lease pruning
    let fakeNow = 1_800_000_000_000;
    let fallbackSummaryCalls = 0;
    const monitor = new WatchdogMonitor({
      getStore: () => store,
      nowFn: () => fakeNow,
      lookupSummaryFn: () => {
        fallbackSummaryCalls += 1;
        return { found: true, archived: false, killed: false, isSubagent: false };
      },
      fetchConversationFn: (cid) => getConversationViaApi(cid, { lsAddress: mock.address, csrfToken: "tok-ka" })
    });

    await monitor.syncConversationApiStatus("conv-api-archived", { store });
    assert.equal(monitor._isConversationArchived(store, "conv-api-archived"), true);
    assert.equal(fallbackSummaryCalls, 0, "Fresh ConversationService cache hit must skip DB summary fallback");

    // Unsupported endpoint backs off and falls back to lookupSummaryFn
    await monitor.syncConversationApiStatus("conv-legacy-host", { store });
    assert.equal(monitor._isConversationArchived(store, "conv-legacy-host"), false);
    assert.equal(fallbackSummaryCalls, 1);

    // Seed an ancient IDLE lease (>72h old) and a recent IDLE lease; tick() must prune ancient IDLE lease
    writeWatchdogLease(store, {
      conversationId: "conv-ancient-idle",
      phase: WATCHDOG_PHASES.IDLE,
      subphase: "stopped",
      updatedTs: fakeNow - 80 * 60 * 60 * 1000
    });
    writeWatchdogLease(store, {
      conversationId: "conv-fresh-idle",
      phase: WATCHDOG_PHASES.IDLE,
      subphase: "stopped",
      updatedTs: fakeNow - 60_000
    });
    monitor._startupCleaned = true; // Test periodic tick() pruning, not startup cleanup
    monitor.tick();
    assert.equal(readWatchdogLease(store, "conv-ancient-idle"), null, "Periodic tick() must prune expired IDLE leases");
    assert.ok(readWatchdogLease(store, "conv-fresh-idle"), "Fresh IDLE lease must be preserved");
  } finally {
    store.close();
    await mock.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Wave3-5 (P1-6): lookupConversationSummary bounded cache invalidates on disk edits and settings-maintenance SummaryDbReader reuses one DB handle with lookup cap", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-w3-sumcache-"));
  const annDir = path.join(tmpDir, "annotations");
  const sumDbPath = path.join(tmpDir, "conversation_summaries.db");
  const prevEnv = process.env.AGY_DART_SUMMARY_DB_PATH;
  try {
    fs.mkdirSync(annDir, { recursive: true });
    const db = new DatabaseSync(sumDbPath);
    db.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT,
        workspace_uris TEXT,
        parent_conversation_id TEXT,
        nesting_depth INTEGER,
        agent_name TEXT,
        killed INTEGER DEFAULT 0,
        archived INTEGER DEFAULT 0
      );
    `);
    const ins = db.prepare(
      "INSERT INTO conversation_summaries (conversation_id, title, workspace_uris, parent_conversation_id, nesting_depth, agent_name, killed, archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    ins.run("conv-direct-arch", "Direct Column", "[]", "", 0, "", 0, 1);
    ins.run("conv-pbtxt-flip", "Flip Test", "[]", "", 0, "", 0, 0);
    for (let i = 0; i < 60; i += 1) {
      ins.run(`conv-bulk-${i}`, `Bulk ${i}`, "[]", i % 5 === 0 ? "conv-parent" : "", 0, "", 0, 0);
    }
    db.close();

    clearConversationSummaryCache();
    // Direct archived column on conversation_summaries works without conversations_fts
    const directRes = lookupConversationSummary("conv-direct-arch", { summaryDbPath: sumDbPath, allowDefaultDb: false });
    assert.equal(directRes.found, true);
    assert.equal(directRes.archived, true);

    // Cache hit + instant invalidation on pbtxt write
    const annFile = path.join(annDir, "conv-pbtxt-flip.pbtxt");
    fs.writeFileSync(annFile, 'title:"Flip Test" archived:false\n', "utf8");
    assert.equal(
      lookupConversationSummary("conv-pbtxt-flip", { summaryDbPath: sumDbPath, allowDefaultDb: false }).archived,
      false
    );
    fs.writeFileSync(annFile, 'title:"Flip Test" archived:true\n', "utf8");
    const flipped = lookupConversationSummary("conv-pbtxt-flip", { summaryDbPath: sumDbPath, allowDefaultDb: false });
    assert.equal(flipped.archived, true, "Updating annotations pbtxt must immediately invalidate lookupConversationSummary cache");

    // SummaryDbReader reuses a single read-only handle across 60 lookups & enforces maxLookups cap
    process.env.AGY_DART_SUMMARY_DB_PATH = sumDbPath;
    const reader = createSummaryDbReader(DatabaseSync, { allowDefaultDb: false, maxLookups: 40 });
    try {
      let subCount = 0;
      let exhaustedCount = 0;
      for (let i = 0; i < 60; i += 1) {
        const hit = reader.lookup(`conv-bulk-${i}`);
        if (hit.isSubagent) subCount += 1;
        if (hit.budgetExhausted) exhaustedCount += 1;
      }
      assert.equal(reader.openCount, 1, "SummaryDbReader must open conversation_summaries.db only ONCE per sweep");
      assert.equal(reader.lookupCount, 40, "SummaryDbReader must stop querying once maxLookups budget is reached");
      assert.equal(exhaustedCount, 20);
      assert.equal(subCount, 8);
    } finally {
      reader.close();
    }
  } finally {
    clearConversationSummaryCache();
    if (prevEnv === undefined) delete process.env.AGY_DART_SUMMARY_DB_PATH;
    else process.env.AGY_DART_SUMMARY_DB_PATH = prevEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Wave3-6 (P1-6): findTranscriptForConversation(null) uses sibling conversation_summaries.db Tier-1 fast path across 600+ dirs and strictly bounds Tier-2 scans", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-w3-brainscan-"));
  try {
    clearTranscriptScanCache();

    // Case A: 600 conversation folders + sibling conversation_summaries.db pointing to #599 as newest
    const agRoot = path.join(tmpDir, "ag-with-db");
    const brainWithDb = path.join(agRoot, "brain");
    fs.mkdirSync(brainWithDb, { recursive: true });
    for (let i = 0; i < 600; i += 1) {
      fs.mkdirSync(path.join(brainWithDb, `conv-${String(i).padStart(4, "0")}`), { recursive: true });
    }
    const newestLog = path.join(brainWithDb, "conv-0599", ".system_generated", "logs", "transcript.jsonl");
    fs.mkdirSync(path.dirname(newestLog), { recursive: true });
    fs.writeFileSync(newestLog, '{"type":"USER_INPUT","step_index":0}\n', "utf8");

    const db = new DatabaseSync(path.join(agRoot, "conversation_summaries.db"));
    db.exec("CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, last_modified_time INTEGER)");
    const ins = db.prepare("INSERT INTO conversation_summaries (conversation_id, last_modified_time) VALUES (?, ?)");
    for (let i = 0; i < 600; i += 1) {
      ins.run(`conv-${String(i).padStart(4, "0")}`, 1_700_000_000 + i);
    }
    db.close();

    const fastHit = findTranscriptForConversation(null, {
      extraRoots: [brainWithDb],
      includeDefaultRoots: false,
      maxEntries: 25,
      noCache: true
    });
    assert.equal(fastHit, newestLog, "Tier-1 summary DB fast path must find conv-0599 even when maxEntries=25 < 600");

    // Case B: Plain brain root WITHOUT summary DB strictly respects maxEntries cap
    const plainBrain = path.join(tmpDir, "plain-brain");
    fs.mkdirSync(plainBrain, { recursive: true });
    for (let i = 0; i < 60; i += 1) {
      fs.mkdirSync(path.join(plainBrain, `dir-${String(i).padStart(3, "0")}`), { recursive: true });
    }
    const lateLog = path.join(plainBrain, "dir-059", ".system_generated", "logs", "transcript.jsonl");
    fs.mkdirSync(path.dirname(lateLog), { recursive: true });
    fs.writeFileSync(lateLog, '{"type":"USER_INPUT","step_index":0}\n', "utf8");

    const cappedMiss = findTranscriptForConversation(null, {
      extraRoots: [plainBrain],
      includeDefaultRoots: false,
      maxEntries: 10,
      noCache: true
    });
    assert.equal(cappedMiss, null, "Tier-2 directory scan must halt after maxEntries=10");

    const uncappedHit = findTranscriptForConversation(null, {
      extraRoots: [plainBrain],
      includeDefaultRoots: false,
      maxEntries: 100,
      noCache: true
    });
    assert.equal(uncappedHit, lateLog);
  } finally {
    clearTranscriptScanCache();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Wave3-7 (P1-6 + packaging): SKILL.md/error-playbook document v2.35.1+ sidecar://agy-dart/dashboard/ pill sparingly and RUNTIME_FILES packages new Wave 3 assets", () => {
  const sidecarCfg = JSON.parse(fs.readFileSync(path.join(ROOT, "sidecars", "dashboard", "sidecar.json"), "utf8"));
  assert.equal(sidecarCfg.has_web_ui, true);
  assert.equal(sidecarCfg.ui_config.views[0].entrypoint, "SIDECAR_UI_ENTRYPOINT_AUX_PANE");
  assert.equal(sidecarCfg.ui_config.views[0].path, "/");
  assert.equal(sidecarCfg.ui_config.views[0].title, "agy-dart Context");

  const expectedPill = "[agy-dart Context](sidecar://agy-dart/dashboard/)";
  const skillMd = fs.readFileSync(path.join(ROOT, "skills", "agy-dart", "SKILL.md"), "utf8");
  const playbookMd = fs.readFileSync(path.join(ROOT, "skills", "agy-dart", "references", "error-playbook.md"), "utf8");
  assert.ok(skillMd.includes(expectedPill), "SKILL.md must include exact sidecar://agy-dart/dashboard/ pill");
  assert.match(skillMd, /sparingly/i, "SKILL.md must instruct agents to emit the side-pane pill sparingly");
  assert.match(skillMd, /MCP App/i, "SKILL.md must document interactive inline MCP App cards on ctx_stats/ctx_doctor");
  assert.ok(playbookMd.includes(expectedPill), "error-playbook.md must include sidecar://agy-dart/dashboard/ pill");

  for (const rel of ["context/ui/diagnostics.html", "context/lib/conversation-api.js"]) {
    assert.ok(RUNTIME_FILES.includes(rel), `RUNTIME_FILES must include ${rel}`);
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `Packaged runtime file must exist on disk: ${rel}`);
  }
});
