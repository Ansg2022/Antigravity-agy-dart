import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import {
  analyzeTranscriptCache,
  clearTranscriptScanCache,
  findTranscriptForConversation
} from "../context/lib/cache-analyzer.js";
import { simulateCachePolicies } from "../context/lib/cache-simulator.js";
import {
  clearConversationApiBackoff,
  getConversationViaApi
} from "../context/lib/conversation-api.js";
import { truncateUtf8Safe } from "../context/lib/stable-json.js";
import { ContextModeStore } from "../context/lib/store.js";
import { createSummaryDbReader } from "../context/lib/store/settings-maintenance.js";
import {
  WATCHDOG_PHASES,
  WatchdogMonitor,
  clearConversationSummaryCache,
  deleteWatchdogLeaseIfUnchanged,
  lookupConversationSummary,
  readWatchdogLease,
  writeWatchdogLease
} from "../context/lib/watchdog.js";
import { listRecentConversationIdsFromSummaryDb } from "../context/lib/watchdog-lease.js";
import { resolveDirectConversationId, resolveSessionId } from "../hooks/compile-cache.mjs";
import { evaluatePreToolPayload } from "../hooks/pre-tool-use.mjs";
import { formatCacheAuditMarkdown } from "../scripts/cache-audit.mjs";
import { DEVTOOLS_FILES, RUNTIME_FILES } from "../scripts/install.mjs";
import { syncSharedRuntime } from "../scripts/targets/shared.mjs";
import { closeRuntimeStore, sendSidecarKeepaliveMessage } from "../sidecars/dashboard/server.mjs";
import { selectFallbackRuntimeFiles } from "../sidecars/dashboard/version-update.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function makeCleanChildEnv(extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  for (const key of [
    "ANTIGRAVITY_CONVERSATION_ID",
    "ANTIGRAVITY_ROOT_CONVERSATION_ID",
    "ANTIGRAVITY_PARENT_CONVERSATION_ID",
    "CONVERSATION_ID",
    "ANTIGRAVITY_SESSION_ID"
  ]) {
    if (!(key in extraEnv)) delete env[key];
  }
  return env;
}

function sendMcpStdio(serverRelPath, messages, extraEnv = {}) {
  const input = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
  const res = spawnSync(process.execPath, [path.join(ROOT, serverRelPath)], {
    input,
    encoding: "utf8",
    timeout: 20000,
    env: makeCleanChildEnv(extraEnv)
  });
  assert.equal(res.status, 0, `${serverRelPath} exited ${res.status}: stderr=${res.stderr}`);
  assert.equal(res.stderr, "", `${serverRelPath} must emit 0 bytes stderr`);
  return res.stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function makeFakeDomNode(tagName = "div") {
  const listeners = new Map();
  const children = [];
  const styleProps = new Map();
  const node = {
    tagName: String(tagName).toUpperCase(),
    className: "",
    textContent: "",
    type: "",
    disabled: false,
    dataset: {},
    offsetHeight: 220,
    offsetWidth: 480,
    scrollHeight: 220,
    scrollWidth: 480,
    children,
    style: {
      colorScheme: "",
      width: "",
      setProperty(k, v) {
        styleProps.set(k, v);
      },
      getPropertyValue(k) {
        return styleProps.get(k) || "";
      }
    },
    _styleProps: styleProps,
    _listeners: listeners,
    get firstChild() {
      return children[0] || null;
    },
    appendChild(child) {
      children.push(child);
      return child;
    },
    removeChild(child) {
      const idx = children.indexOf(child);
      if (idx >= 0) children.splice(idx, 1);
      return child;
    },
    addEventListener(evt, fn) {
      if (!listeners.has(evt)) listeners.set(evt, []);
      listeners.get(evt).push(fn);
    },
    click() {
      for (const fn of listeners.get("click") || []) fn();
    }
  };
  return node;
}

function collectDomText(node) {
  let out = node.textContent || "";
  for (const child of node.children || []) {
    out += " " + collectDomText(child);
  }
  return out;
}

function findDomNode(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node.children || []) {
    const found = findDomNode(child, predicate);
    if (found) return found;
  }
  return null;
}

test("v1.9.2-1 (P1+P2+P3): diagnostics.html VM verifies read-only ctx_stats refresh, Safety Monitor diagnosis, parent-source/CSS allowlist, and ui/resource-teardown", async () => {
  const html = fs.readFileSync(path.join(ROOT, "context", "ui", "diagnostics.html"), "utf8");
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch && scriptMatch[1], "diagnostics.html must contain inline script");
  assert.equal(/\bbackground\s*:\s*var\(--/i.test(html), false, "diagnostics.html must use background-color instead of shorthand background: var(...)");

  const rootEl = makeFakeDomNode("div");
  const docEl = makeFakeDomNode("html");
  const posted = [];
  const winListeners = new Map();
  let roDisconnected = false;
  const mockParent = {
    postMessage(msg, targetOrigin) {
      posted.push({ msg: structuredClone(msg), targetOrigin });
    }
  };
  const mockWindow = {
    parent: mockParent,
    addEventListener(evt, fn) {
      if (!winListeners.has(evt)) winListeners.set(evt, []);
      winListeners.get(evt).push(fn);
    },
    removeEventListener(evt, fn) {
      const list = winListeners.get(evt);
      if (!list) return;
      const idx = list.indexOf(fn);
      if (idx >= 0) list.splice(idx, 1);
    }
  };

  const timers = new Map();
  let nextTimerId = 1;
  const ctx = vm.createContext({
    window: mockWindow,
    document: {
      documentElement: docEl,
      getElementById(id) {
        return id === "root" ? rootEl : null;
      },
      createElement(tag) {
        return makeFakeDomNode(tag);
      }
    },
    ResizeObserver: class {
      observe() {}
      disconnect() {
        roDisconnected = true;
      }
    },
    requestAnimationFrame(fn) {
      fn();
      return 1;
    },
    setTimeout(fn) {
      const id = nextTimerId++;
      timers.set(id, fn);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    Map,
    Set,
    Promise,
    Object,
    Array,
    Number,
    String,
    Boolean,
    Math,
    JSON,
    Error,
    RegExp
  });

  vm.runInContext(scriptMatch[1], ctx);

  const dispatchMessage = (data, source = mockParent) => {
    for (const fn of [...(winListeners.get("message") || [])]) {
      fn({ data, source });
    }
  };

  // 1. Initial ui/initialize request sent; spoofed non-parent message must be ignored
  const initReq = posted.find((p) => p.msg.method === "ui/initialize");
  assert.ok(initReq, "diagnostics card must emit ui/initialize");
  dispatchMessage(
    {
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { theme: "dark", styles: { variables: { "--color-background-primary": "#000000" } } }
    },
    { spoofed: true }
  );
  assert.equal(docEl._styleProps.get("--color-background-primary"), undefined, "Non-parent postMessage must be ignored");

  // 2. Host replies to ui/initialize with safe + malicious CSS variables
  dispatchMessage({
    jsonrpc: "2.0",
    id: initReq.msg.id,
    result: {
      hostCapabilities: { serverTools: true },
      hostContext: {
        theme: "dark",
        styles: {
          variables: {
            "--color-background-primary": "#111217",
            "--font-sans": "Inter, sans-serif",
            "--bg-1": "#ff0000",
            "--color-text-primary": "url(https://evil.example/leak)",
            "--color-border-primary": "red; background-image: url(https://evil.example/2)"
          }
        }
      }
    }
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(docEl._styleProps.get("--color-background-primary"), "#111217");
  assert.equal(docEl._styleProps.get("--font-sans"), "Inter, sans-serif");
  assert.equal(docEl._styleProps.get("--bg-1"), undefined, "Internal card CSS variables must not be overridable by host");
  assert.equal(docEl._styleProps.get("--color-text-primary"), undefined, "CSS url(...) values must be rejected");
  assert.equal(docEl._styleProps.get("--color-border-primary"), undefined, "CSS semicolon injection values must be rejected");

  // 3. P1: ctx_stats({ reset: true, sessionId: "s-keep", cwd: "/proj" }) -> clicking Refresh MUST send reset: false
  dispatchMessage({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-input",
    params: { arguments: { reset: true, sessionId: "s-keep", cwd: "/proj", extraIgnored: "x" } }
  });
  dispatchMessage({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: {
      structuredContent: {
        kind: "ctx_stats",
        stats: { sessionId: "s-keep", calls: 1, totalRawBytes: 5000, totalReturnedBytes: 500, keptOutBytes: 4500, tokensKeptOut: 1125, savingsPercent: 90 },
        ghost: {},
        featureRoi: { features: {} }
      }
    }
  });
  const refreshBtn = findDomNode(rootEl, (n) => n.tagName === "BUTTON");
  assert.ok(refreshBtn, "Refresh button must render when serverTools capability is true");
  refreshBtn.click();
  const refreshCall = posted.find((p) => p.msg.method === "tools/call");
  assert.ok(refreshCall, "Clicking Refresh must dispatch tools/call");
  assert.equal(refreshCall.msg.params.name, "ctx_stats");
  assert.deepEqual(refreshCall.msg.params.arguments, { reset: false, sessionId: "s-keep", cwd: "/proj" });

  // End-to-end persistence proof with real ContextModeStore: reset -> add checkpoint -> replay refresh args -> checkpoint survives
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v192-reset-"));
  const store = new ContextModeStore({ dbPath: path.join(tmpDir, "context.db") });
  try {
    store.recordVerificationResult("s-keep", {
      kind: "test",
      command: "npm test",
      passed: true,
      exitCode: 0,
      summary: "ok",
      worktree: tmpDir
    });
    assert.ok(store.getSessionCheckpoint("s-keep")?.lastTest, "Checkpoint must exist before refresh");
    if (refreshCall.msg.params.arguments.reset) {
      store.purge({ scope: "session", sessionId: "s-keep" });
    }
    assert.ok(store.getSessionCheckpoint("s-keep")?.lastTest, "Refresh args must NEVER purge newly recorded checkpoint");
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }

  // Reply to refresh with ctx_doctor payload containing safetyMonitor.diagnosis + recommendedAction
  dispatchMessage({
    jsonrpc: "2.0",
    id: refreshCall.msg.id,
    result: {
      structuredContent: {
        kind: "ctx_doctor",
        doctor: { status: "HEALTHY", allOk: true, dbSizeBytes: 4096, walSizeBytes: 0, totalSources: 2, totalEvents: 5, totalChunksIndexed: 10 },
        features: { cliFilterEnabled: true, readDedupEnabled: true },
        readGuard: { mode: "soft", sourceCutoffBytes: 46080, sourceCutoffSource: "default" },
        safetyMonitor: {
          status: "throttling",
          severity: "high",
          diagnosis: "429 burst detected on safety precheck endpoint",
          recommendedAction: "Batch reads and reduce outside-workspace MCP calls"
        },
        config: { loaded: false, overrides: {} },
        projectFilters: { exists: false },
        runtimes: { node: process.version, platform: process.platform, arch: process.arch }
      }
    }
  });
  await new Promise((r) => setImmediate(r));
  const doctorText = collectDomText(rootEl);
  assert.ok(doctorText.includes("429 burst detected on safety precheck endpoint"), "Doctor card must render safetyMonitor.diagnosis");
  assert.ok(doctorText.includes("Batch reads and reduce outside-workspace MCP calls"), "Doctor card must render safetyMonitor.recommendedAction");

  // 4. P3: trigger an in-flight refresh timer, then ui/resource-teardown must cancel it, disconnect ResizeObserver, unbind listener, and reply {}
  const doctorRefreshBtn = findDomNode(rootEl, (n) => n.tagName === "BUTTON");
  assert.ok(doctorRefreshBtn, "Doctor card must render Refresh button");
  doctorRefreshBtn.click();
  assert.equal(timers.size, 1, "In-flight Refresh RPC must arm a pending timeout before teardown");
  dispatchMessage({ jsonrpc: "2.0", id: 777, method: "ui/resource-teardown", params: {} });
  const teardownReply = posted.find((p) => p.msg.id === 777);
  assert.deepEqual(teardownReply?.msg, { jsonrpc: "2.0", id: 777, result: {} });
  assert.equal(roDisconnected, true, "ui/resource-teardown must disconnect ResizeObserver");
  assert.equal((winListeners.get("message") || []).length, 0, "ui/resource-teardown must remove window message listener");
  assert.equal(timers.size, 0, "ui/resource-teardown must cancel all pending timers");
});

test("v1.9.2-2 (P2): context/server.js strictly enforces SEP-1865 mimeTypes negotiation", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v192-sep1865-"));
  const dbPath = path.join(tmpDir, "context.db");
  try {
    for (const [label, extPayload] of [
      ["missing mimeTypes", {}],
      ["empty mimeTypes", { mimeTypes: [] }],
      ["wrong type mimeTypes", { mimeTypes: "text/html;profile=mcp-app" }],
      ["other mimeTypes", { mimeTypes: ["text/plain"] }]
    ]) {
      const resps = sendMcpStdio(
        "context/server.js",
        [
          {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-11-25",
              capabilities: { extensions: { "io.modelcontextprotocol/ui": extPayload } }
            }
          },
          { jsonrpc: "2.0", id: 2, method: "tools/list" },
          { jsonrpc: "2.0", id: 3, method: "resources/list" }
        ],
        { AGY_DART_DB_PATH: dbPath }
      );
      assert.deepEqual(resps.find((r) => r.id === 1)?.result?.capabilities, { tools: {} }, `Must keep non-UI capabilities for ${label}`);
      assert.equal(resps.find((r) => r.id === 2)?.result?.tools.some((t) => "_meta" in t), false, `Must omit _meta.ui for ${label}`);
      assert.deepEqual(resps.find((r) => r.id === 3)?.result, { resources: [] }, `Must return empty resources for ${label}`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.9.2-3 (P2): conversation-api.js enforces localhost loopback DNS check, wall-clock total deadline, contract/ID validation, and Sidecar 60s unsupported backoff", async () => {
  clearConversationApiBackoff();

  // 1. localhost resolving to non-loopback IP must be rejected before connecting
  const dnsBlocked = await getConversationViaApi("conv-dns", {
    lsAddress: "localhost:54321",
    csrfToken: "secret",
    lookupFn: (_host, _opts, cb) => cb(null, [{ address: "198.51.100.42", family: 4 }])
  });
  assert.equal(dnsBlocked.ok, false);
  assert.equal(dnsBlocked.blockedNonLoopback, true);
  assert.equal(dnsBlocked.error, "non_loopback_dns_rejected");

  let dripTimer = null;
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const id = JSON.parse(body || "{}").conversationId;
      if (id === "conv-empty") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
        return;
      }
      if (id === "conv-wrong-id") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "conv-other", annotations: { archived: false } }));
        return;
      }
      if (id === "conv-drip") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write(" ");
        let n = 0;
        dripTimer = setInterval(() => {
          n += 1;
          if (n >= 20) {
            clearInterval(dripTimer);
            try {
              res.end('{"id":"conv-drip"}');
            } catch {}
            return;
          }
          try {
            res.write(" ");
          } catch {
            clearInterval(dripTimer);
          }
        }, 45);
        res.on("close", () => clearInterval(dripTimer));
        return;
      }
      res.writeHead(501, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: "unimplemented" }));
    });
  });

  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const addr = `127.0.0.1:${srv.address().port}`;
  try {
    // 2. Empty 200 {} and mismatched ID must NOT return ok/found:true
    const emptyRes = await getConversationViaApi("conv-empty", { lsAddress: addr, csrfToken: "tok" });
    assert.equal(emptyRes.ok, false);
    assert.equal(emptyRes.error, "incomplete_conversation_response");

    const mismatchRes = await getConversationViaApi("conv-wrong-id", { lsAddress: addr, csrfToken: "tok" });
    assert.equal(mismatchRes.ok, false);
    assert.equal(mismatchRes.error, "conversation_id_mismatch");

    // 3. Slow-drip response must hit hard wall-clock timeout (~150ms), never run to 900ms
    const t0 = Date.now();
    const dripRes = await getConversationViaApi("conv-drip", { lsAddress: addr, csrfToken: "tok", timeoutMs: 150 });
    const elapsed = Date.now() - t0;
    assert.equal(dripRes.ok, false);
    assert.equal(dripRes.error, "timeout");
    assert.ok(elapsed < 500, `Wall-clock timeout must abort slow-drip promptly, got ${elapsed}ms`);

    // 4. Sidecar sendSidecarKeepaliveMessage shares 60s unsupported backoff across calls
    let apiCalls = 0;
    const unsupportedFn = async () => {
      apiCalls += 1;
      return { ok: false, unsupported: true, statusCode: 501, error: "unimplemented" };
    };
    const mockExec = async (args) => {
      if (args[0] === "get-conversation-metadata") {
        return { response: { conversationMetadata: { metadata: { projectId: "proj-1" } } } };
      }
      return { ok: true };
    };
    const r1 = await sendSidecarKeepaliveMessage("conv-bo-1", "OK", {
      execFn: mockExec,
      allowDefaultSummaryDb: false,
      getConversationFn: unsupportedFn
    });
    const r2 = await sendSidecarKeepaliveMessage("conv-bo-2", "OK", {
      execFn: mockExec,
      allowDefaultSummaryDb: false,
      getConversationFn: unsupportedFn
    });
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.equal(apiCalls, 1, "Second keepalive to unsupported ConversationService must hit 60s backoff");
  } finally {
    if (dripTimer) clearInterval(dripTimer);
    closeRuntimeStore();
    clearConversationApiBackoff();
    srv.closeAllConnections?.();
    await new Promise((r) => srv.close(r));
  }
});

test("v1.9.2-4 (P2): unlimited-history SQLite hardening — 33-row FTS archive check, lock deadline & zero negative-cache poisoning, and indexed/rowid recent query", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v192-sqlite-"));
  const agRoot = path.join(tmpDir, "ag");
  const brainDir = path.join(agRoot, "brain");
  const sumDbPath = path.join(agRoot, "conversation_summaries.db");
  const prevEnv = process.env.AGY_DART_SUMMARY_DB_PATH;
  fs.mkdirSync(brainDir, { recursive: true });
  try {
    // 1. 33 rows in conversations_fts where ONLY row #33 has archived=1
    const db = new DatabaseSync(sumDbPath);
    db.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT,
        workspace_uris TEXT,
        last_modified_time INTEGER
      );
      CREATE TABLE conversations_fts (
        conversation_id TEXT,
        archived INTEGER
      );
    `);
    db.exec("BEGIN");
    db.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?, ?)").run("conv-fts-33", "Old Thread", "[]", 100);
    const insFts = db.prepare("INSERT INTO conversations_fts (conversation_id, archived) VALUES (?, ?)");
    for (let i = 0; i < 32; i += 1) insFts.run("conv-fts-33", 0);
    insFts.run("conv-fts-33", 1);

    // Populate >300 rows without an index on last_modified_time so large-table rowid path is exercised
    const insSum = db.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?, ?)");
    for (let i = 0; i < 320; i += 1) {
      insSum.run(`conv-row-${i}`, `T${i}`, "[]", 1000 + i);
    }
    db.prepare("UPDATE conversation_summaries SET last_modified_time = 999999999 WHERE conversation_id = 'conv-row-0'").run();
    db.exec("COMMIT");

    clearConversationSummaryCache();
    const archRes = lookupConversationSummary("conv-fts-33", { summaryDbPath: sumDbPath, allowDefaultDb: false });
    assert.equal(archRes.found, true);
    assert.equal(archRes.archived, true, "33rd archived row in conversations_fts must not be missed by LIMIT 32 sampling");

    // Large unindexed table (>256 rows) stays O(log N) via rowid DESC instead of full-table temp B-tree sort
    const recentUnindexed = listRecentConversationIdsFromSummaryDb(brainDir, 5);
    assert.equal(recentUnindexed[0], "conv-row-319", "Large unindexed table must use rowid DESC fast path");

    // 2. Exclusive write lock: both lookupConversationSummary and createSummaryDbReader respect tight deadlines
    // AND transient SQLITE_BUSY does NOT poison lookupConversationSummary's negative cache!
    clearConversationSummaryCache();
    db.exec("BEGIN EXCLUSIVE");
    try {
      const t0 = Date.now();
      const lockedLookup = lookupConversationSummary("conv-fts-33", {
        summaryDbPath: sumDbPath,
        allowDefaultDb: false,
        maxWaitMs: 40
      });
      const dtLookup = Date.now() - t0;
      assert.equal(lockedLookup.found, false);
      assert.ok(dtLookup < 800, `Locked lookupConversationSummary must respect shared deadline without 4x retry multiplication, got ${dtLookup}ms`);

      process.env.AGY_DART_SUMMARY_DB_PATH = sumDbPath;
      const t1 = Date.now();
      const reader = createSummaryDbReader(DatabaseSync, { allowDefaultDb: false, maxScanMs: 40 });
      try {
        reader.lookup("conv-fts-33");
      } finally {
        reader.close();
      }
      const dtReader = Date.now() - t1;
      assert.ok(dtReader < 800, `Locked createSummaryDbReader must stay near maxScanMs budget, got ${dtReader}ms`);
    } finally {
      db.exec("COMMIT");
    }

    // Immediately after unlock (without bypassCache), lookupConversationSummary MUST find the row (not serve stale negative cache!)
    const afterUnlock = lookupConversationSummary("conv-fts-33", { summaryDbPath: sumDbPath, allowDefaultDb: false });
    assert.equal(afterUnlock.found, true, "Transient lock error must never be negatively cached");
    assert.equal(afterUnlock.archived, true);

    // 3. Indexed time column takes priority over rowid order when an index exists
    db.exec("CREATE INDEX idx_sum_lmt ON conversation_summaries(last_modified_time)");
    db.close();

    const recent = listRecentConversationIdsFromSummaryDb(brainDir, 5);
    assert.equal(recent[0], "conv-row-0", "Indexed last_modified_time must be selected for ORDER BY DESC");
  } finally {
    clearConversationSummaryCache();
    if (prevEnv === undefined) delete process.env.AGY_DART_SUMMARY_DB_PATH;
    else process.env.AGY_DART_SUMMARY_DB_PATH = prevEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.9.2-5 (P2): atomic CAS lease pruning protects concurrently resumed leases + WAL scan cache invalidation & streaming opendir cap", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v192-cas-wal-"));
  const store = new ContextModeStore({ dbPath: path.join(tmpDir, "context.db") });
  try {
    // 1. Atomic CAS delete preserves lease resumed concurrently between snapshot and prune
    const now = 1_800_000_000_000;
    const oldTs = now - 48 * 60 * 60 * 1000;
    writeWatchdogLease(store, {
      conversationId: "conv-resumed",
      phase: WATCHDOG_PHASES.IDLE,
      subphase: "stopped",
      updatedTs: oldTs
    });
    const staleSnapshot = [readWatchdogLease(store, "conv-resumed")];
    // Simulate concurrent hook resuming the conversation before _pruneExpiredIdleLeases runs
    writeWatchdogLease(store, {
      conversationId: "conv-resumed",
      phase: WATCHDOG_PHASES.LLM_INFLIGHT,
      subphase: "thinking",
      updatedTs: now - 1000
    });
    const wd = new WatchdogMonitor({ getStore: () => store, nowFn: () => now });
    const kept = wd._pruneExpiredIdleLeases(store, staleSnapshot, now);
    assert.equal(kept.length, 1, "Concurrently resumed lease must be preserved in kept list");
    assert.equal(kept[0].phase, WATCHDOG_PHASES.LLM_INFLIGHT);
    assert.equal(readWatchdogLease(store, "conv-resumed")?.phase, WATCHDOG_PHASES.LLM_INFLIGHT);

    // Direct CAS helper deletes truly unchanged expired lease
    writeWatchdogLease(store, {
      conversationId: "conv-truly-old",
      phase: WATCHDOG_PHASES.IDLE,
      subphase: "stopped",
      updatedTs: oldTs
    });
    const delCas = deleteWatchdogLeaseIfUnchanged(store, "conv-truly-old", oldTs, WATCHDOG_PHASES.IDLE);
    assert.equal(delCas.deleted, true);
    assert.equal(readWatchdogLease(store, "conv-truly-old"), null);

    // 2. findTranscriptForConversation(null) cache invalidates on WAL update without touching main DB mtime
    const agRoot = path.join(tmpDir, "ag-wal");
    const brainDir = path.join(agRoot, "brain");
    const logA = path.join(brainDir, "conv-a", ".system_generated", "logs", "transcript.jsonl");
    const logB = path.join(brainDir, "conv-b", ".system_generated", "logs", "transcript.jsonl");
    fs.mkdirSync(path.dirname(logA), { recursive: true });
    fs.mkdirSync(path.dirname(logB), { recursive: true });
    fs.writeFileSync(logA, '{"type":"USER_INPUT"}\n', "utf8");
    const sumDb = path.join(agRoot, "conversation_summaries.db");
    const db = new DatabaseSync(sumDb);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, last_modified_time INTEGER);");
    db.prepare("INSERT INTO conversation_summaries VALUES ('conv-a', 100)").run();
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");

    clearTranscriptScanCache();
    const first = findTranscriptForConversation(null, { extraRoots: [brainDir], includeDefaultRoots: false });
    assert.equal(first, logA);

    // Write conv-b transcript + insert into WAL without checkpointing main DB
    fs.writeFileSync(logB, '{"type":"USER_INPUT"}\n', "utf8");
    const futureSec = Date.now() / 1000 + 5;
    fs.utimesSync(logB, futureSec, futureSec);
    db.prepare("INSERT INTO conversation_summaries VALUES ('conv-b', 200)").run();
    const second = findTranscriptForConversation(null, { extraRoots: [brainDir], includeDefaultRoots: false });
    db.close();
    assert.equal(second, logB, "WAL modification must immediately invalidate transcript scan cache");

    // 3. Tier-2 streaming opendir counts regular files toward maxEntries
    const fileHeavyBrain = path.join(tmpDir, "file-heavy-brain");
    fs.mkdirSync(fileHeavyBrain, { recursive: true });
    for (let i = 0; i < 15; i += 1) {
      fs.writeFileSync(path.join(fileHeavyBrain, `000-junk-${String(i).padStart(2, "0")}.txt`), "x", "utf8");
    }
    const zLog = path.join(fileHeavyBrain, "zzz-conv", ".system_generated", "logs", "transcript.jsonl");
    fs.mkdirSync(path.dirname(zLog), { recursive: true });
    fs.writeFileSync(zLog, '{"type":"USER_INPUT"}\n', "utf8");
    clearTranscriptScanCache();
    const capped = findTranscriptForConversation(null, {
      extraRoots: [fileHeavyBrain],
      includeDefaultRoots: false,
      maxEntries: 5,
      noCache: true
    });
    assert.equal(capped, null, "Streaming Tier-2 scan must count regular files toward maxEntries");
  } finally {
    clearTranscriptScanCache();
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.9.2-6 (P2): read-guard blocks 2 MiB boundary-crossing wide slices & apply_edits(verify) writes failure checkpoint despite 8.8 KB truncation", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v192-guard-fast-"));
  const dbPath = path.join(tmpDir, "context.db");
  const prevDb = process.env.AGY_DART_DB_PATH;
  const prevMode = process.env.AGY_DART_READ_GUARD_MODE;
  process.env.AGY_DART_DB_PATH = dbPath;
  process.env.AGY_DART_READ_GUARD_MODE = "strict";
  try {
    // 1. Create a ~2.4 MB file (~33,500 lines of 75 bytes each); startNear2Mb sits ~18 KB before the 2 MiB scan cap
    const bigFile = path.join(tmpDir, "huge.js");
    const lineBody = "const rowValue = 'abcdefghijklmnopqrstuvwxyz0123456789_padding_line_data';\n"; // 75 bytes
    const lineCount = Math.ceil((2.4 * 1024 * 1024) / lineBody.length);
    fs.writeFileSync(bigFile, lineBody.repeat(lineCount), "utf8");
    const startNear2Mb = Math.floor((2 * 1024 * 1024 - 18000) / lineBody.length);
    // 850-line slice (~63.7 KB): sits between 45 KB cutoff and 90 KB paged cap, crossing the 2 MiB cap
    const resMid = await evaluatePreToolPayload({
      cwd: tmpDir,
      conversationId: "conv-2mb-guard",
      toolCall: { name: "read_file", args: { Path: bigFile, StartLine: startNear2Mb, EndLine: startNear2Mb + 850 } }
    });
    assert.equal(resMid.verdict.decision, "deny", "Wide slice crossing 2 MiB streaming cap must NOT be falsely treated as an exact small slice");

    // 2. apply_edits(verify) across 50 long-path files with failing verify -> 8.8 KB display truncates BEFORE Verify:, yet checkpoint MUST record failure!
    const editWork = path.join(tmpDir, "many-edits");
    const edits = [];
    for (let i = 0; i < 50; i += 1) {
      const idx = String(i).padStart(2, "0");
      const rel = `deep/nested/directory/structure/package_workspace_module_layer/segment_bucket_${idx}/component_handler_service_controller_long_filename_padding_${idx}.txt`;
      const abs = path.join(editWork, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, `line-${i}\n`, "utf8");
      edits.push({ path: rel, hunks: [{ target: `line-${i}`, replacement: `updated-${i}` }] });
    }
    const rpcResps = sendMcpStdio(
      "fast/mcp-server.mjs",
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {} } },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "apply_edits",
            _meta: { conversationId: "conv-50-fail" },
            arguments: {
              cwd: editWork,
              edits,
              verify: "node -e \"console.error('AssertionError: ASSERTION_BOOM_50'); process.exit(1)\""
            }
          }
        }
      ],
      { AGY_DART_DB_PATH: dbPath }
    );
    const applyResp = rpcResps.find((r) => r.id === 2)?.result;
    assert.equal(applyResp?.isError, false);
    assert.equal(
      applyResp?.content?.[0]?.text.includes("Verify ["),
      false,
      "8.8 KB display output must truncate before the Verify: banner to prove structured checkpoint persistence"
    );
    const store = new ContextModeStore({ dbPath });
    try {
      const cp = store.getSessionCheckpoint("conv-50-fail");
      assert.ok(cp?.lastTest, "Failing apply_edits(verify) must record checkpoint even when display text truncates before Verify:");
      assert.equal(cp.lastTest.ok, false);
      assert.equal(cp.lastTest.outcome, "fail");
      assert.ok(String(cp.lastTest.failureExcerpt || "").includes("ASSERTION_BOOM_50"));
    } finally {
      store.close();
    }
  } finally {
    if (prevDb === undefined) delete process.env.AGY_DART_DB_PATH;
    else process.env.AGY_DART_DB_PATH = prevDb;
    if (prevMode === undefined) delete process.env.AGY_DART_READ_GUARD_MODE;
    else process.env.AGY_DART_READ_GUARD_MODE = prevMode;
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.9.2-7 (P2): cache-simulator.js matches cache-analyzer.js on Gemini 4 small-delta 2,050-token tail reprocess (0 false busts)", () => {
  const t0 = new Date("2026-11-27T10:00:00.000Z").toISOString();
  const t1 = new Date("2026-11-27T10:00:20.000Z").toISOString();
  const steps = [
    {
      type: "PLANNER_RESPONSE",
      created_at: t0,
      model: "gemini-4-neon",
      usage: { input_tokens: 6000, cache_read_input_tokens: 0 }
    },
    {
      type: "PLANNER_RESPONSE",
      created_at: t1,
      model: "gemini-4-neon",
      // Added +500 tokens (< 2,050), so Gemini 4 re-processes trailing 2,050 tokens (cacheRead=3950/6000 = 65.8% < 70% BUST_DROP_RATIO)
      usage: { input_tokens: 2550, cache_read_input_tokens: 3950 }
    }
  ];
  const analyzed = analyzeTranscriptCache(steps);
  assert.equal(analyzed.turnsWithUsage, 2);
  assert.equal(analyzed.bustCount, 0, "Analyzer must treat Gemini 4 small-delta tail reprocess as 0 busts");

  const sim = simulateCachePolicies([{ sessionId: "g4-sim", steps }]);
  assert.equal(sim.turnsWithUsage, 2);
  const byId = Object.fromEntries(sim.policies.map((p) => [p.id, p]));
  assert.equal(byId.observed.projectedBusts, 0);
  assert.equal(byId["ttl-5m"].projectedBusts, 0, "ttl-5m replay must report 0 busts on Gemini 4 tail reprocess");
  assert.equal(byId["ttl-1h"].projectedBusts, 0, "ttl-1h replay must report 0 busts on Gemini 4 tail reprocess");
  assert.equal(byId["ttl-5m"].projectedWastedTokens, 0);
  assert.equal(byId["ttl-1h"].projectedWastedTokens, 0);
});

test("v1.9.2-8 (P2+P3): shared runtime prunes retired files on upgrade, fallback manifest includes dsh/ & skips retired SVGs, standalone fast/session-start.mjs works, null-safe helpers, lone-surrogate parity & cache-audit Markdown sums", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v192-p3-"));
  try {
    // 1. syncSharedRuntime upgrade prunes retired v1.9.0 files (2 README + 6 SVG) while keeping devtools if preserved
    const fakeHome = path.join(tmpDir, "home");
    const runtimeDir = path.join(fakeHome, ".agy-dart", "runtime");
    fs.mkdirSync(path.join(runtimeDir, "assets"), { recursive: true });
    const retired = [
      "README.md",
      "README.zh-CN.md",
      "assets/architecture-dark.svg",
      "assets/architecture-light.svg",
      "assets/demo-comparison.svg",
      "assets/architecture-dark.zh-CN.svg",
      "assets/architecture-light.zh-CN.svg",
      "assets/demo-comparison.zh-CN.svg"
    ];
    for (const rel of retired) {
      fs.writeFileSync(path.join(runtimeDir, rel), "old", "utf8");
    }
    fs.writeFileSync(
      path.join(runtimeDir, ".installed-files.json"),
      JSON.stringify([...RUNTIME_FILES, ...retired]),
      "utf8"
    );
    syncSharedRuntime(ROOT, fakeHome, RUNTIME_FILES, { preserveFiles: DEVTOOLS_FILES });
    for (const rel of retired) {
      assert.equal(fs.existsSync(path.join(runtimeDir, rel)), false, `Retired file must be pruned on upgrade: ${rel}`);
    }
    const recorded = JSON.parse(fs.readFileSync(path.join(runtimeDir, ".installed-files.json"), "utf8"));
    assert.equal(recorded.length, RUNTIME_FILES.length, "Shared runtime marker must converge to 64 files");

    // 2. selectFallbackRuntimeFiles includes dsh/plugin.mjs & assets/logo.svg and excludes retired SVGs
    const fakeArchive = new Map([
      ["plugin.json", Buffer.from("{}")],
      ["assets/logo.svg", Buffer.from("<svg/>")],
      ["assets/architecture-dark.svg", Buffer.from("<svg/>")],
      ["assets/demo-comparison.svg", Buffer.from("<svg/>")],
      ["dsh/plugin.mjs", Buffer.from("export {};")],
      ["README.md", Buffer.from("# doc")]
    ]);
    const fallbackSelected = selectFallbackRuntimeFiles(fakeArchive);
    assert.ok(fallbackSelected.includes("dsh/plugin.mjs"), "Fallback manifest must include dsh/plugin.mjs");
    assert.ok(fallbackSelected.includes("assets/logo.svg"), "Fallback manifest must include assets/logo.svg");
    assert.equal(fallbackSelected.includes("assets/architecture-dark.svg"), false);
    assert.equal(fallbackSelected.includes("README.md"), false);

    // 3. Standalone isolated copy of fast/session-start.mjs exits 0 with 0B stderr
    const soloDir = path.join(tmpDir, "solo");
    fs.mkdirSync(soloDir, { recursive: true });
    const soloScript = path.join(soloDir, "session-start.mjs");
    fs.copyFileSync(path.join(ROOT, "fast", "session-start.mjs"), soloScript);
    const soloRun = spawnSync(process.execPath, [soloScript], {
      input: JSON.stringify({ cwd: soloDir }),
      encoding: "utf8",
      timeout: 10000
    });
    assert.equal(soloRun.status, 0, `Standalone fast/session-start.mjs failed: ${soloRun.stderr}`);
    assert.equal(soloRun.stderr, "", "Standalone fast/session-start.mjs must emit 0B stderr");
    assert.doesNotThrow(() => JSON.parse(soloRun.stdout));

    // 4. Null-safe resolveSessionId / resolveDirectConversationId
    assert.equal(resolveSessionId(null, {}), "default");
    assert.equal(resolveDirectConversationId(null, {}), "default");

    // 5. truncateUtf8Safe normalizes lone surrogates identically on fast and truncated paths while preserving valid U+FFFD
    const withLone = "a\uD83Db";
    assert.equal(truncateUtf8Safe(withLone, 100), "a\uFFFDb", "Fast path must normalize lone surrogate to U+FFFD");
    assert.equal(truncateUtf8Safe(withLone, 4), "a\uFFFD", "Truncated path must match fast-path surrogate normalization");
    assert.equal(truncateUtf8Safe("ok\uFFFDend", 5), "ok\uFFFD", "Legitimate U+FFFD must remain preserved");

    // 6. formatCacheAuditMarkdown header addends match estimatedTurn0Tokens
    const md = formatCacheAuditMarkdown({
      score: 100,
      grade: "A",
      scoreBreakdown: { criticalCount: 0, warnCount: 0, infoCount: 0 },
      options: { workspace: ROOT, configDir: tmpDir, live: true },
      totals: {
        rulesAndSkillsTokens: 300,
        mcpSchemaTokens: 1500,
        eagerMcpSchemaTokens: 500,
        lazyMcpCatalogTokens: 1000,
        estimatedTurn0Tokens: 800
      },
      prefix: { items: [], ruleCount: 0, skillCount: 0, totalBytes: 0, totalTokens: 300, thresholds: { totalPrefixWarnTokens: 6000 } },
      mcp: { servers: [] },
      hooks: { pluginCount: 0, activePlugins: [], disabledPlugins: [], entries: [] },
      findings: []
    });
    assert.ok(md.includes("~800 tokens") && md.includes("eager MCP schemas: 500 tok") && md.includes("lazy MCP catalog: 1,000 tok"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
