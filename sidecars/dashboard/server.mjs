import { suppressSqliteExperimentalWarning } from "../../hooks/compile-cache.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import os from "node:os";
import { execFile, execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getEffectiveConfig } from "../../context/lib/config.js";
import { executionReceiptsFromSteps, fastToolClaimsFromSteps } from "../../context/lib/execution-receipts.js";
import { buildHandoffBrief, inferWorkspaceFromStore } from "../../context/lib/handoff.js";
import {
  DEFAULT_STALE_LEASE_MS,
  WatchdogMonitor,
  collectChildSubagentActivity,
  classifyTranscriptGenesisFile,
  inspectLatestTurnInSteps,
  isHeadlessWorkerPrompt,
  isKeepaliveTurnFlushedForRound,
  isSameWorkspacePath,
  isTrajectoryMetadataSubagent,
  listWatchdogLeases,
  lookupConversationSummary,
  readWatchdogLease,
  readWatchdogTranscriptTail,
  resolveCandidateTranscriptPath,
  resolveTrustedCheckpointSessionId,
  WATCHDOG_PHASES,
  writeWatchdogLeaseIfUnchanged
} from "../../context/lib/watchdog.js";
import {
  analyzeTranscriptCache,
  computeCacheWarmth,
  CONTEXT_CRITICAL_TOKENS,
  CONTEXT_WARN_TOKENS,
  createEmptyContextComposition,
  createEmptyDriftBreakdown,
  createEmptySubagentBreakdown,
  DEFAULT_CACHE_TTL_SEC,
  findTranscriptForConversation,
  isSafeConversationId,
  MIN_CACHEABLE_CONTEXT_TOKENS,
  parseTranscriptLines,
  readTranscriptTail,
  resolveModelProfile
} from "../../context/lib/cache-analyzer.js";

// Dynamically load store.js AFTER suppressSqliteExperimentalWarning() runs so Node 22 does not emit
// `ExperimentalWarning: SQLite` during static ESM builtin linking before compile-cache.mjs executes.
suppressSqliteExperimentalWarning();
const { ContextModeStore, FILE_CATEGORIES } = await import("../../context/lib/store.js");

const __selfPath = path.resolve(fileURLToPath(import.meta.url));
const __dirname = path.dirname(__selfPath);
const HTML_FILE = path.join(__dirname, "index.html");
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const OVERSIZED_BODY_DRAIN_TIMEOUT_MS = 5_000;
const SIDECAR_CSRF_TOKEN = crypto.randomBytes(24).toString("hex");

let _runtimeStore = null;
let _appStartTime = null;
let _hostStartTime = null;
let _runtimeInitialized = false;
let _watchdogMonitor = null;
const _convProjectIdCache = new Map();

function runAgentApiAsync(args, { projectId = "", timeoutMs = 12000 } = {}) {
  const exe = process.env.ANTIGRAVITY_AGENTAPI_EXE;
  const file = exe || "agentapi";
  const execArgs = exe ? ["agentapi", ...args] : args;
  const env = projectId ? { ...process.env, ANTIGRAVITY_PROJECT_ID: projectId } : process.env;
  return new Promise((resolve, reject) => {
    execFile(
      file,
      execArgs,
      { encoding: "utf8", timeout: timeoutMs, windowsHide: true, env },
      (err, stdout) => {
        if (err) return reject(err);
        const trimmed = String(stdout || "").trim();
        if (!trimmed) return resolve({});
        try {
          resolve(JSON.parse(trimmed));
        } catch {
          resolve({ raw: trimmed });
        }
      }
    );
  });
}

function isDefaultRuntimeStoreDb(store) {
  if (typeof process.env.AGY_DART_SUMMARY_DB_PATH === "string" && process.env.AGY_DART_SUMMARY_DB_PATH.trim()) {
    return true;
  }
  if (store && typeof store.dbPath === "string" && store.dbPath.trim()) {
    return isSameWorkspacePath(store.dbPath, path.join(os.homedir(), ".agy-dart", "context.db"));
  }
  return false;
}

function localConversationIdentity(conversationId, { store = null, transcriptPath = "", allowDefaultDb = null } = {}) {
  const activeStore = store || _runtimeStore;
  const lease = activeStore ? readWatchdogLease(activeStore, conversationId) : null;
  if (lease) {
    if (
      lease.isSubagent ||
      (lease.parentConversationId && lease.parentConversationId !== conversationId) ||
      (lease.rootSessionId && lease.rootSessionId !== conversationId) ||
      (lease.lastUserInput && isHeadlessWorkerPrompt(lease.lastUserInput))
    ) {
      return "subagent";
    }
  }
  const effectiveAllowDefaultDb = allowDefaultDb !== null ? Boolean(allowDefaultDb) : isDefaultRuntimeStoreDb(activeStore);
  const txPath =
    transcriptPath ||
    lease?.transcriptPath ||
    resolveCandidateTranscriptPath(conversationId, { allowDefaultDb: effectiveAllowDefaultDb });
  let summary;
  if (effectiveAllowDefaultDb || txPath) {
    summary = lookupConversationSummary(conversationId, {
      transcriptPath: txPath,
      allowDefaultDb: effectiveAllowDefaultDb,
      checkSubagent: true
    });
    if (summary.isSubagent) return "subagent";
  }
  const genesis = classifyTranscriptGenesisFile(txPath);
  if (genesis !== "unknown") return genesis;
  return summary?.found ? "human" : "unknown";
}

function isSidecarConversationSubagent(conversationId, options = {}) {
  if (!isSafeConversationId(conversationId) || conversationId === "__unbound__") return false;
  const store = options.store || _runtimeStore;
  if (_watchdogMonitor && store) {
    return _watchdogMonitor._isConversationSubagent(store, conversationId);
  }
  return localConversationIdentity(conversationId, options) === "subagent";
}

function isSidecarConversationKilled(conversationId, { store = null, transcriptPath = "", allowDefaultDb = null } = {}) {
  if (!conversationId || conversationId === "__unbound__" || !isSafeConversationId(conversationId)) {
    return false;
  }
  const activeStore = store || _runtimeStore;
  const effectiveAllowDefaultDb = allowDefaultDb !== null ? Boolean(allowDefaultDb) : isDefaultRuntimeStoreDb(activeStore);
  const lease = activeStore ? readWatchdogLease(activeStore, conversationId) : null;
  const txPath = transcriptPath || lease?.transcriptPath || "";
  if (!effectiveAllowDefaultDb && !txPath) return false;
  const summary = lookupConversationSummary(conversationId, {
    transcriptPath: txPath,
    allowDefaultDb: effectiveAllowDefaultDb
  });
  return Boolean(summary.killed);
}

export async function sendSidecarKeepaliveMessage(
  conversationId,
  message,
  { execFn = runAgentApiAsync, allowDefaultSummaryDb = null } = {}
) {
  if (!isSafeConversationId(conversationId) || /^-/.test(conversationId) || conversationId === "__unbound__") {
    return { ok: false, error: "invalid_conversation_id" };
  }
  const cleanMsg = String(message || "").trim();
  if (!cleanMsg) {
    return { ok: false, error: "empty_message" };
  }
  const localIdentity = localConversationIdentity(conversationId, { allowDefaultDb: allowDefaultSummaryDb });
  if (localIdentity === "subagent") {
    _convProjectIdCache.delete(conversationId);
    return { ok: false, skippedSubagent: true, error: "subagent_keepalive_suppressed" };
  }
  if (isSidecarConversationKilled(conversationId, { allowDefaultDb: allowDefaultSummaryDb })) {
    _convProjectIdCache.delete(conversationId);
    return { ok: false, skippedKilled: true, error: "killed_conversation_keepalive_suppressed" };
  }

  const cachedProjectId = _convProjectIdCache.get(conversationId) || "";
  let projectId = "";
  let hasMetadata = false;
  try {
    const metaRes = await execFn(["get-conversation-metadata", conversationId], { timeoutMs: 8000 });
    const metaEvent = metaRes?.response?.conversationMetadata || metaRes?.response?.conversation_metadata;
    const metaObj = metaEvent?.metadata && typeof metaEvent.metadata === "object" ? metaEvent.metadata : metaEvent || {};
    hasMetadata = Boolean(metaEvent && typeof metaObj === "object" && !Array.isArray(metaObj) && Object.keys(metaObj).length);
    if (isTrajectoryMetadataSubagent(conversationId, metaEvent || metaObj)) {
      _convProjectIdCache.delete(conversationId);
      return { ok: false, skippedSubagent: true, error: "subagent_keepalive_suppressed" };
    }
    if (
      metaObj.killed === true ||
      metaEvent?.killed === true ||
      (Number.isFinite(Number(metaObj.killed)) && Number(metaObj.killed) > 0) ||
      (Number.isFinite(Number(metaEvent?.killed)) && Number(metaEvent?.killed) > 0)
    ) {
      _convProjectIdCache.delete(conversationId);
      return { ok: false, skippedKilled: true, error: "killed_conversation_keepalive_suppressed" };
    }
    const resolvedId = metaObj.projectId || metaObj.project_id || "";
    if (typeof resolvedId === "string" && resolvedId.trim()) {
      projectId = resolvedId.trim();
      if (_convProjectIdCache.size >= 100 && !_convProjectIdCache.has(conversationId)) {
        const oldest = _convProjectIdCache.keys().next().value;
        if (oldest !== undefined) _convProjectIdCache.delete(oldest);
      }
      _convProjectIdCache.set(conversationId, projectId);
    }
  } catch {
    // A locally identified primary chat can still use its cached or ambient project.
  }
  if (!hasMetadata && localIdentity === "unknown") {
    return { ok: false, error: "conversation_identity_unavailable" };
  }
  if (!projectId) {
    projectId = cachedProjectId || process.env.ANTIGRAVITY_PROJECT_ID || "";
  }

  try {
    const res = await execFn(["send-message", conversationId, cleanMsg], { projectId, timeoutMs: 12000 });
    if (res && res.error) {
      return { ok: false, error: String(res.error) };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err || "send_message_failed") };
  }
}

function getHostStartTime() {
  if (_hostStartTime !== null) return _hostStartTime;
  _hostStartTime = 0;
  if (process.platform === "win32") {
    try {
      const out = execSync(
        'powershell -NoProfile -Command "(Get-Process -Name language_server*, Antigravity -ErrorAction SilentlyContinue | Measure-Object -Property StartTime -Minimum).Minimum.ToUniversalTime().ToString(\'yyyy-MM-ddTHH:mm:ss.fffZ\')"',
        { encoding: "utf8", timeout: 3000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }
      );
      const parsed = new Date(out.trim()).getTime();
      if (Number.isFinite(parsed) && parsed > 0) _hostStartTime = parsed;
    } catch {}
  }
  return _hostStartTime;
}

function getAppStartTime() {
  return _appStartTime ??= getHostStartTime() || (Date.now() - Math.round(process.uptime() * 1000));
}

export function stopWatchdogMonitor() {
  if (_watchdogMonitor) {
    try {
      _watchdogMonitor.stop();
    } catch {}
    _watchdogMonitor = null;
  }
}

export function getWatchdogMonitor(options = {}) {
  if (!_watchdogMonitor) {
    _watchdogMonitor = new WatchdogMonitor({
      getStore: () => getRuntimeStore(),
      // Only a known host restart can invalidate a lease that predates the dashboard.
      getAppStartTime: getHostStartTime,
      ...options
    });
  }
  return _watchdogMonitor;
}

export function closeRuntimeStore() {
  stopWatchdogMonitor();
  _convProjectIdCache.clear();
  claimedTranscriptStatCache.clear();
  if (_runtimeStore) {
    try {
      _runtimeStore.close();
    } catch {}
    _runtimeStore = null;
  }
  _runtimeInitialized = false;
}

function getRuntimeStore() {
  if (!_runtimeStore) {
    _runtimeStore = new ContextModeStore();
  }
  if (!_runtimeInitialized) {
    _runtimeInitialized = true;
    const startTs = getAppStartTime();
    // Clear session-level overrides on app session restart & scrub legacy global keepalive keys
    try {
      const recordedSessionTime = _runtimeStore.getMeta("app_session_start_time");
      if (!recordedSessionTime || recordedSessionTime !== String(startTs)) {
        _runtimeStore.clearSessionOverrides();
        _runtimeStore.setMeta("app_session_start_time", String(startTs));
      }
      _runtimeStore.sanitizeModelTtlState?.();
    } catch {}
  }
  return _runtimeStore;
}

const LOCAL_HOST_RE = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i;
const LOCAL_ORIGIN_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i;

export function isAllowedHostHeader(hostHeader) {
  if (typeof hostHeader !== "string") return false;
  return LOCAL_HOST_RE.test(hostHeader.trim());
}

export function isAllowedOriginHeader(originHeader, hostHeader = null) {
  if (originHeader === undefined || originHeader === null || originHeader === "") return true;
  if (typeof originHeader !== "string") return false;
  const trimmed = originHeader.trim();
  if (!LOCAL_ORIGIN_RE.test(trimmed)) return false;
  try {
    const originUrl = new URL(trimmed);
    if (originUrl.protocol !== "http:") return false;
    if (typeof hostHeader === "string" && hostHeader.trim()) {
      const reqHostUrl = new URL(`http://${hostHeader.trim()}`);
      if (originUrl.hostname.toLowerCase() !== reqHostUrl.hostname.toLowerCase()) return false;
      const originPort = originUrl.port || "80";
      const hostPort = reqHostUrl.port || "80";
      if (originPort !== hostPort) return false;
    }
  } catch {
    return false;
  }
  return true;
}

export function isAllowedRefererHeader(refererHeader, hostHeader = null) {
  if (refererHeader === undefined || refererHeader === null || refererHeader === "") return true;
  if (typeof refererHeader !== "string") return false;
  const trimmed = refererHeader.trim();
  if (!trimmed) return true;
  try {
    const refUrl = new URL(trimmed);
    return isAllowedOriginHeader(refUrl.origin, hostHeader);
  } catch {
    return false;
  }
}

export function isCrossSiteFetchHeader(secFetchSite, { allowSameSite = false } = {}) {
  if (secFetchSite === undefined || secFetchSite === null) return false;
  if (typeof secFetchSite !== "string") return true;
  const normalized = secFetchSite.trim().toLowerCase();
  if (!normalized || normalized === "same-origin" || normalized === "none") return false;
  if (allowSameSite && normalized === "same-site") return false;
  return true;
}

export function isJsonContentType(contentType) {
  return typeof contentType === "string" && /^application\/json(?:\s*;|$)/i.test(contentType.trim());
}

export function timingSafeTokenMatch(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string" || !provided || !expected) {
    return false;
  }
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function discardOversizedBody(req) {
  req.resume();
  if (req.complete || req.destroyed) return;
  // Let a normal upload finish after the 413, but bound time spent draining an unfinished one.
  const timer = setTimeout(() => {
    if (!req.complete && !req.destroyed) req.destroy();
  }, OVERSIZED_BODY_DRAIN_TIMEOUT_MS);
  timer.unref();
  const cancelTimer = () => clearTimeout(timer);
  req.once("end", cancelTimer);
  req.once("close", cancelTimer);
}

export function readBoundedJsonBody(req, maxBytes = MAX_REQUEST_BODY_BYTES) {
  return new Promise((resolve) => {
    const rawContentLen = req.headers?.["content-length"];
    if (rawContentLen !== undefined) {
      const declaredLen = Number(rawContentLen);
      if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
        req.on("error", () => {});
        discardOversizedBody(req);
        resolve({ ok: false, status: 413, error: `Request body exceeds ${Math.round(maxBytes / 1024)} KB limit` });
        return;
      }
    }
    const chunks = [];
    let totalBytes = 0;
    let settled = false;
    let overflowed = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    req.on("data", (chunk) => {
      if (overflowed) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      totalBytes += buf.length;
      if (totalBytes > maxBytes) {
        overflowed = true;
        chunks.length = 0;
        discardOversizedBody(req);
        finish({ ok: false, status: 413, error: `Request body exceeds ${Math.round(maxBytes / 1024)} KB limit` });
        return;
      }
      chunks.push(buf);
    });

    req.on("end", () => {
      if (overflowed || settled) return;
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        finish({ ok: true, data: {} });
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          finish({ ok: false, status: 400, error: "Request body must be a JSON object" });
          return;
        }
        finish({ ok: true, data: parsed });
      } catch (err) {
        finish({ ok: false, status: 400, error: err instanceof Error ? err.message : "Invalid JSON body" });
      }
    });

    req.on("error", (err) => {
      finish({ ok: false, status: 400, error: err instanceof Error ? err.message : "Request stream error" });
    });

    req.on("aborted", () => {
      finish({ ok: false, status: 400, error: "Request stream aborted" });
    });

    req.on("close", () => {
      if (!settled && !req.complete) {
        finish({ ok: false, status: 400, error: "Request stream closed prematurely" });
      }
    });
  });
}

let cachedPkgVersion = null;
let cachedHtmlTemplate = { mtimeMs: -1, size: -1, withVer: "" };

function getPackageVersion() {
  if (cachedPkgVersion) return cachedPkgVersion;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"));
    if (pkg.version) {
      cachedPkgVersion = pkg.version;
      return cachedPkgVersion;
    }
  } catch {}
  return "1.6.0";
}

function getRenderedHtml(csrfToken = SIDECAR_CSRF_TOKEN) {
  let withVer = cachedHtmlTemplate.withVer;
  try {
    const st = fs.statSync(HTML_FILE);
    if (!withVer || st.mtimeMs !== cachedHtmlTemplate.mtimeMs || st.size !== cachedHtmlTemplate.size) {
      const raw = fs.readFileSync(HTML_FILE, "utf8");
      const ver = getPackageVersion();
      withVer = raw.replace('id="dashboard-version">--</span>', `id="dashboard-version">v${ver}</span>`);
      cachedHtmlTemplate = { mtimeMs: st.mtimeMs, size: st.size, withVer };
    }
  } catch {
    const raw = fs.readFileSync(HTML_FILE, "utf8");
    const ver = getPackageVersion();
    withVer = raw.replace('id="dashboard-version">--</span>', `id="dashboard-version">v${ver}</span>`);
  }
  const tokenMeta = `  <meta name="agy-dart-token" content="${csrfToken}">\n</head>`;
  return withVer.includes("</head>") ? withVer.replace("</head>", tokenMeta) : withVer;
}

const MAX_SEARCH_QUERIES = 20;
const MAX_SEARCH_QUERY_CHARS = 256;

function isUncPath(p) {
  return typeof p === "string" && /^[\\/]{2}/.test(p.trim());
}

function validateStringFields(data, fields) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: true };
  for (const field of fields) {
    const val = data[field];
    if (val !== undefined && val !== null && typeof val !== "string") {
      return { ok: false, error: `Field '${field}' must be a string` };
    }
  }
  return { ok: true };
}

function validateAndNormalizeSearchInput(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, error: "Request body must be a JSON object" };
  }
  if (data.queries !== undefined) {
    if (!Array.isArray(data.queries)) {
      return { ok: false, error: "Field 'queries' must be an array of strings" };
    }
    if (data.queries.length > MAX_SEARCH_QUERIES) {
      return { ok: false, error: `At most ${MAX_SEARCH_QUERIES} search queries are allowed per request` };
    }
    const queries = [];
    for (const q of data.queries) {
      if (typeof q !== "string") {
        return { ok: false, error: "Each item in 'queries' must be a string" };
      }
      queries.push(q.slice(0, MAX_SEARCH_QUERY_CHARS));
    }
    return { ok: true, queries };
  }
  if (data.query !== undefined && data.query !== null && typeof data.query !== "string") {
    return { ok: false, error: "Field 'query' must be a string" };
  }
  return { ok: true, queries: [typeof data.query === "string" ? data.query.slice(0, MAX_SEARCH_QUERY_CHARS) : ""] };
}

function resolveTargetSession(data, defaultConvId = "default") {
  const safeSessionId = typeof data?.sessionId === "string" ? data.sessionId : "";
  const safeConvId = typeof data?.conversationId === "string" ? data.conversationId : "";
  const rawScope = typeof data?.scope === "string" && data.scope.trim() ? data.scope.trim() : "";
  const scope =
    rawScope === "all"
      ? "lifetime"
      : rawScope === "session"
        ? "app"
        : rawScope || (safeSessionId === "all" ? "lifetime" : safeSessionId === "app" ? "app" : "conversation");
  const convId =
    safeConvId ||
    (safeSessionId && safeSessionId !== "all" && safeSessionId !== "app" ? safeSessionId : defaultConvId || "default");
  let targetSid = convId;
  if (scope === "lifetime" || scope === "all") targetSid = "all";
  else if (scope === "app" || scope === "session") targetSid = "app";
  return { scope, convId, targetSid };
}

const claimedTranscriptStatCache = new Map(); // `${dbPath}|${txPath}` -> `${mtimeMs}:${size}`
const MAX_CLAIMED_TX_CACHE_ENTRIES = 128;

function setClaimedTranscriptCache(cacheKey, statSig) {
  if (claimedTranscriptStatCache.has(cacheKey)) {
    claimedTranscriptStatCache.delete(cacheKey);
  } else if (claimedTranscriptStatCache.size >= MAX_CLAIMED_TX_CACHE_ENTRIES) {
    const oldest = claimedTranscriptStatCache.keys().next().value;
    if (oldest !== undefined) claimedTranscriptStatCache.delete(oldest);
  }
  claimedTranscriptStatCache.set(cacheKey, statSig);
}

function syncTranscriptClaimsForSteps(store, transcriptOwner, steps, { isFullTranscript = true } = {}) {
  if (!store || !transcriptOwner || !Array.isArray(steps) || steps.length === 0) return true;
  let rootOwner = transcriptOwner;
  try {
    if (typeof store.resolveRootSessionId === "function") {
      rootOwner = store.resolveRootSessionId(transcriptOwner);
    }
  } catch {
    return false;
  }
  let ok = true;
  try {
    store.claimExecutionReceipts(rootOwner, executionReceiptsFromSteps(steps));
  } catch {
    ok = false;
  }
  try {
    const fastClaims = fastToolClaimsFromSteps(steps);
    if (fastClaims.length > 0 && typeof store.claimFastToolClaims === "function") {
      let windowStartIso = "";
      if (!isFullTranscript) {
        let earliestMs = Infinity;
        for (const c of fastClaims) {
          const t = Number.isFinite(c.createdAtMs) ? c.createdAtMs : c.completedAtMs;
          if (Number.isFinite(t) && t < earliestMs) {
            earliestMs = t;
          }
        }
        if (Number.isFinite(earliestMs)) {
          windowStartIso = new Date(earliestMs - 120000).toISOString();
        }
      }
      store.claimFastToolClaims(rootOwner, fastClaims, {
        directConvId: transcriptOwner,
        windowStartIso,
        isFullTranscript
      });
    }
  } catch {
    ok = false;
  }
  return ok;
}

function syncConversationFamilyTranscripts(store, convId) {
  if (
    !store ||
    !convId ||
    convId === "default" ||
    convId === "all" ||
    convId === "app" ||
    convId === "lifetime" ||
    convId === "__unbound__" ||
    !isSafeConversationId(convId)
  ) {
    return;
  }
  try {
    const rootId = typeof store.resolveRootSessionId === "function" ? store.resolveRootSessionId(convId) : convId;
    const familySet = new Set(
      typeof store.getSessionFamilyIds === "function" ? store.getSessionFamilyIds(rootId) : [rootId]
    );
    familySet.add(convId);
    const leases = listWatchdogLeases(store);
    const candidates = new Map(); // cid -> { txPath, updatedTs }
    for (const lease of leases) {
      if (!lease || !lease.conversationId) continue;
      const cid = lease.conversationId;
      const leaseRoot = lease.rootSessionId || lease.parentConversationId || cid;
      if (!familySet.has(cid) && leaseRoot !== rootId && lease.parentConversationId !== rootId) continue;
      if (lease.transcriptPath && typeof lease.transcriptPath === "string") {
        candidates.set(cid, { txPath: lease.transcriptPath, updatedTs: Number(lease.updatedTs || 0) });
      }
    }
    if (!candidates.has(rootId)) {
      const rootTx =
        resolveCandidateTranscriptPath(rootId, { allowDefaultDb: isDefaultRuntimeStoreDb(store) }) ||
        findTranscriptForConversation(rootId, { exactOnly: true });
      if (rootTx) candidates.set(rootId, { txPath: rootTx, updatedTs: Date.now() });
    }
    const sorted = Array.from(candidates.entries())
      .sort((a, b) => b[1].updatedTs - a[1].updatedTs)
      .slice(0, 12);
    for (const [cid, info] of sorted) {
      const txPath = info.txPath;
      if (!txPath || !fs.existsSync(txPath)) continue;
      let st;
      try {
        st = fs.statSync(txPath);
        if (!st.isFile() || st.size <= 0) continue;
      } catch {
        continue;
      }
      const cacheKey = `${store.dbPath || ""}|${rootId}|${txPath}`;
      const statSig = `${st.mtimeMs}:${st.size}`;
      if (claimedTranscriptStatCache.get(cacheKey) === statSig) continue;
      const isFull = st.size <= 2 * 1024 * 1024;
      const steps = isFull
        ? parseTranscriptLines(fs.readFileSync(txPath, "utf8"))
        : readTranscriptTail(txPath, 524288);
      if (syncTranscriptClaimsForSteps(store, cid, steps, { isFullTranscript: isFull })) {
        setClaimedTranscriptCache(cacheKey, statSig);
      }
    }
  } catch {}
}

function getStatsPayload(data, defaultConvId = "default") {
  const store = getRuntimeStore();
  const appStartTime = getAppStartTime();
  const { scope, convId, targetSid } = resolveTargetSession(data, defaultConvId);
  const isLifetimeScope = scope === "lifetime" || scope === "all";
  const isAppScope = scope === "app" || scope === "session";
  const effectiveConvId =
    !isLifetimeScope && !isAppScope && typeof store.resolveRootSessionId === "function"
      ? store.resolveRootSessionId(convId)
      : convId;
  const statsTargetSid = isLifetimeScope ? "all" : isAppScope ? "app" : effectiveConvId;
  let stats;
  if (isLifetimeScope) {
    stats = store.getStats("all");
  } else if (isAppScope) {
    stats = store.getStats("app", { sinceTs: appStartTime });
  } else {
    syncConversationFamilyTranscripts(store, effectiveConvId);
    stats = store.getStats(effectiveConvId);
  }

  stats.scope = scope;
  stats.conversationId = convId;
  stats.appStartTime = appStartTime;
  stats.conversationCutoffBytes = store.getCutoff(convId);
  stats.appCutoffBytes = store.getCutoff("app");
  stats.globalCutoffBytes = store.getCutoff(null);
  stats.hasConversationCutoffOverride = store.hasCutoffOverride(convId);
  stats.hasAppCutoffOverride = store.hasCutoffOverride("app");
  stats.cutoffBytes = isLifetimeScope
    ? stats.globalCutoffBytes
    : (isAppScope ? stats.appCutoffBytes : stats.conversationCutoffBytes);

  stats.conversationExemptExtensions = store.getExemptExtensions(convId);
  stats.appExemptExtensions = store.getExemptExtensions("app");
  stats.globalExemptExtensions = store.getExemptExtensions(null);
  stats.exemptExtensions = isLifetimeScope
    ? stats.globalExemptExtensions
    : (isAppScope ? stats.appExemptExtensions : stats.conversationExemptExtensions);

  stats.fileCategories = Object.values(FILE_CATEGORIES);
  stats.conversationExemptCategories = store.getExemptCategories(convId);
  stats.appExemptCategories = store.getExemptCategories("app");
  stats.globalExemptCategories = store.getExemptCategories(null);
  stats.exemptCategories = isLifetimeScope
    ? stats.globalExemptCategories
    : (isAppScope ? stats.appExemptCategories : stats.conversationExemptCategories);

  stats.conversationCustomExtensions = store.getCustomExemptExtensions(convId);
  stats.appCustomExtensions = store.getCustomExemptExtensions("app");
  stats.globalCustomExtensions = store.getCustomExemptExtensions(null);
  stats.customExtensions = isLifetimeScope
    ? stats.globalCustomExtensions
    : (isAppScope ? stats.appCustomExtensions : stats.conversationCustomExtensions);

  // Sandbox preview cap is double cutoff, hard-capped at 8100 B to prevent Antigravity MCP output.txt spills
  const effCfg = getEffectiveConfig();
  const cfgMaxOutputBytes = effCfg.maxOutputBytes || 8100;
  stats.sandboxCapBytes = Math.min(
    8100,
    stats.cutoffBytes > 0
      ? stats.cutoffBytes * 2
      : cfgMaxOutputBytes
  );
  stats.readGuardMode = effCfg.readGuardMode || "soft";
  stats.noiseMaxReadBytes = effCfg.noiseMaxReadBytes ?? 16384;
  stats.reviewMaxReadBytes = effCfg.reviewMaxReadBytes ?? 131072;
  stats.shellDumpMaxBytes = effCfg.shellDumpMaxBytes ?? 16384;
  if (typeof store.getCutoffInfo === "function") {
    stats.cutoffSource = store.getCutoffInfo(isLifetimeScope ? null : targetSid).source;
  }
  stats.isPaused = store.isPaused(targetSid);
  stats.cliFilterEnabled = store.isCliFilterEnabled(targetSid);
  stats.readDedupEnabled = store.isReadDedupEnabled(targetSid);
  const sinceOpts = scope === "app" || scope === "session" ? { sinceTs: appStartTime } : {};
  stats.ghost = store.getGhostStats(statsTargetSid, sinceOpts);
  stats.featureRoi = store.getFeatureRoi(statsTargetSid, { ...sinceOpts, ghost: stats.ghost });
  try {
    stats.starPrompt = store.evaluateStarPrompt({ markTriggered: true });
  } catch {}

  stats.version = getPackageVersion();

  return stats;
}

const LATEST_SCAN_TTL_MS = 10000;
let cachedLatestScan = { ts: 0, path: null };
const parsedDiagCache = new Map(); // key -> { mtimeMs, size, ttlSec, diag }

function parseSafeMaxAgeDays(raw, fallback = 14) {
  if (raw === undefined || raw === null) return fallback;
  const trimmed = String(raw).trim();
  if (!trimmed) return fallback;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function parseOptionalPositiveNumber(raw) {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = String(raw).trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function refreshWallClockTtl(diag, explicitTtlSec) {
  const nowMs = Date.now();
  if (!diag || !diag.lastPlannerAt) return diag ? { ...diag, serverNowMs: nowMs } : diag;
  const safeTtl =
    parseOptionalPositiveNumber(explicitTtlSec) ??
    parseOptionalPositiveNumber(diag.cacheTtlSec) ??
    DEFAULT_CACHE_TTL_SEC;
  const lastMs = Date.parse(diag.lastPlannerAt);
  if (!Number.isFinite(lastMs)) return { ...diag, serverNowMs: nowMs };
  const idleSeconds = Math.max(0, Math.round((nowMs - lastMs) / 1000));
  const ttlRemainingSec = Math.max(0, safeTtl - idleSeconds);
  const currentContextTokens = diag.currentContextTokens || 0;
  let ttlStatus = "cold";
  if (currentContextTokens >= MIN_CACHEABLE_CONTEXT_TOKENS) {
    if (idleSeconds >= safeTtl) ttlStatus = "expired";
    else if (ttlRemainingSec <= 60) ttlStatus = "expiring";
    else ttlStatus = "warm";
  }
  const { cacheTemperature, compactAdvice } = computeCacheWarmth({
    currentContextTokens,
    idleSeconds,
    ttlSec: safeTtl,
    weightedHitRate: diag.weightedHitRate || 0,
    criticalTokens: diag.criticalTokens || CONTEXT_CRITICAL_TOKENS,
    coldCompactTokens: diag.coldCompactTokens || 60000,
    delayHotMinTokens: diag.delayHotMinTokens || 30000
  });
  return {
    ...diag,
    cacheTtlSec: safeTtl,
    idleSeconds,
    ttlRemainingSec,
    ttlStatus,
    cacheTemperature,
    compactAdvice,
    serverNowMs: nowMs
  };
}

function formatCalibrationCacheStamp(historicalMap) {
  if (!historicalMap || typeof historicalMap !== "object") return "";
  const keys = Object.keys(historicalMap).sort();
  if (keys.length === 0) return "";
  return keys.map((k) => `${k}:${historicalMap[k]?.updatedTs || 0}`).join(",");
}

function inferConvIdFromTranscriptPath(transcriptPath, fallbackConvId = "") {
  if (fallbackConvId && fallbackConvId !== "default" && fallbackConvId !== "all" && fallbackConvId !== "app") {
    return fallbackConvId;
  }
  if (!transcriptPath || typeof transcriptPath !== "string") return "";
  // .../brain/<convId>/.system_generated/logs/transcript.jsonl
  const logDir = path.dirname(transcriptPath);
  const sysDir = path.dirname(logDir);
  if (path.basename(sysDir) === ".system_generated") {
    const candidate = path.basename(path.dirname(sysDir));
    if (candidate && isSafeConversationId(candidate)) return candidate;
  }
  return "";
}

function isUnboundSidecarHostRequest(data = {}) {
  const rawExplicitConv = typeof data?.conversationId === "string" ? data.conversationId.trim() : "";
  if (rawExplicitConv === "__unbound__") return true;
  if (data?.fromSidecarHost !== true) return false;
  return !rawExplicitConv;
}

function isSidecarConversationActive(conversationId, store, nowMs = Date.now()) {
  if (!conversationId || conversationId === "__unbound__" || conversationId === "default" || !store) {
    return false;
  }
  try {
    if (typeof store.isWatchdogEnabled === "function" && !store.isWatchdogEnabled()) {
      return false;
    }
    const leases = listWatchdogLeases(store);
    if (!Array.isArray(leases) || leases.length === 0) return false;
    const { childHeartbeatByParent, activeChildParents } = collectChildSubagentActivity(leases, {
      nowMs,
      maxAgeMs: DEFAULT_STALE_LEASE_MS
    });
    if (activeChildParents.has(conversationId)) return true;
    const lease = leases.find((l) => l && l.conversationId === conversationId) || null;
    if (!lease || (lease.phase === "IDLE" && lease.subphase !== "stopped_bg_pending")) {
      return false;
    }
    const latestHb = Math.max(
      Number(lease.lastHeartbeatTs || 0),
      Number(lease.updatedTs || 0),
      Number(childHeartbeatByParent.get(conversationId) || 0)
    );
    if (latestHb <= 0 || nowMs - latestHb > DEFAULT_STALE_LEASE_MS) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function getCacheDiagPayload(data, defaultConvId = "default") {
  const unboundHostTab = isUnboundSidecarHostRequest(data);
  const { scope, convId } = resolveTargetSession(data, unboundHostTab ? "default" : defaultConvId);
  const cfg = getEffectiveConfig();
  const store = getRuntimeStore();
  const ttlDesktopNotifyEnabled = store.isTtlDesktopNotifyEnabled();
  const globalTtlKeepaliveMaxCount = store.getGlobalTtlKeepaliveMaxCount();
  const fallbackTtlKeepaliveMaxCount = store.getFallbackNonZeroKeepaliveMaxCount();
  const globalTtlKeepaliveMinContextPct = store.getGlobalTtlKeepaliveMinContextPct();
  const deliveryLatencyMs = store.getTtlKeepaliveDeliveryMs();
  const isSpecificConvForKa = Boolean(
    convId && convId !== "default" && convId !== "all" && convId !== "app"
  );
  const kaConvId = unboundHostTab ? "__unbound__" : isSpecificConvForKa ? convId : "";
  const isExplicitSubagentForKa = Boolean(
    kaConvId &&
      kaConvId !== "__unbound__" &&
      isSidecarConversationSubagent(kaConvId, { store })
  );
  const kaState =
    !isExplicitSubagentForKa && kaConvId
      ? store.getTtlKeepaliveState(kaConvId)
      : { usedCount: 0, coldMissTripped: false, lastSentTs: 0, lastError: "" };
  const initialCustomOverride = Boolean(
    !isExplicitSubagentForKa && kaConvId && store.hasCustomTtlKeepaliveOverride(kaConvId)
  );
  const defaultWindowTokens = resolveModelProfile(null).windowTokens;
  const ttlKeepalive = {
    conversationId: kaConvId,
    enabled: isExplicitSubagentForKa ? false : store.isTtlKeepaliveEnabled(kaConvId || null),
    supported: !isExplicitSubagentForKa,
    isSubagent: isExplicitSubagentForKa,
    maxCount: store.getTtlKeepaliveMaxCount(kaConvId || null),
    globalMaxCount: globalTtlKeepaliveMaxCount,
    fallbackMaxCount: fallbackTtlKeepaliveMaxCount,
    minContextPct: globalTtlKeepaliveMinContextPct,
    minContextTokens: initialCustomOverride
      ? 0
      : Math.round((defaultWindowTokens * globalTtlKeepaliveMinContextPct) / 100),
    windowTokens: defaultWindowTokens,
    isCustomOverride: initialCustomOverride,
    usedCount: kaState.usedCount,
    coldMissTripped: Boolean(kaState.coldMissTripped),
    deliveryLatencyMs,
    leadSec: Math.min(180, Math.max(10, Math.floor(Number(cfg.ttlKeepaliveLeadSec) || 60))),
    lastSentTs: kaState.lastSentTs || 0,
    lastError: kaState.lastError || ""
  };
  const rawTtl = data.ttl !== undefined && data.ttl !== "" ? data.ttl : cfg.cacheTtlSec;
  const explicitTtlSec = parseOptionalPositiveNumber(rawTtl);
  const envWindowTokens = parseOptionalPositiveNumber(cfg.windowTokens);
  const envWarnTokens = parseOptionalPositiveNumber(cfg.warnTokens);
  const envCritTokens = parseOptionalPositiveNumber(cfg.criticalTokens);
  const isSpecificConv = scope === "conversation" && convId && convId !== "default" && convId !== "all" && convId !== "app";
  let transcriptPath = null;
  if (unboundHostTab && scope === "conversation") {
    transcriptPath = null;
  } else if (isSpecificConv) {
    transcriptPath = isSafeConversationId(convId)
      ? findTranscriptForConversation(convId, { exactOnly: true })
      : null;
    if (!transcriptPath) {
      const leaseTx = readWatchdogLease(store, convId)?.transcriptPath;
      if (leaseTx && typeof leaseTx === "string" && !isUncPath(leaseTx) && fs.existsSync(leaseTx)) {
        transcriptPath = leaseTx;
      }
    }
  } else {
    const now = Date.now();
    if (now - cachedLatestScan.ts < LATEST_SCAN_TTL_MS && cachedLatestScan.path && fs.existsSync(cachedLatestScan.path)) {
      transcriptPath = cachedLatestScan.path;
    } else {
      transcriptPath = findTranscriptForConversation(null);
      cachedLatestScan = { ts: now, path: transcriptPath };
    }
  }
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    const defProfile = resolveModelProfile(null);
    const effectiveWindow = envWindowTokens ?? defProfile.windowTokens;
    const windowSource = envWindowTokens !== undefined ? "explicit" : "profile";
    const ttlSource = explicitTtlSec !== undefined ? "explicit" : "profile";
    const effTtl = explicitTtlSec ?? defProfile.ttlSec;
    const conversationActive = isSpecificConv ? isSidecarConversationActive(convId, store) : false;
    const noTxKeepalive = {
      ...ttlKeepalive,
      windowTokens: effectiveWindow,
      minContextTokens: ttlKeepalive.isCustomOverride
        ? 0
        : Math.round((effectiveWindow * globalTtlKeepaliveMinContextPct) / 100)
    };
    return {
      ok: true,
      transcriptFound: false,
      scope,
      conversationId: convId,
      conversationActive,
      serverNowMs: Date.now(),
      ttlDesktopNotifyEnabled,
      globalTtlKeepaliveMaxCount,
      fallbackTtlKeepaliveMaxCount,
      globalTtlKeepaliveMinContextPct,
      ttlKeepalive: noTxKeepalive,
      cacheTtlSec: effTtl,
      ttlSource,
      ttlCalibration: {
        origin: ttlSource,
        profileId: defProfile.id,
        warmSamples: 0,
        coldSamples: 0,
        maxWarmGapSec: null,
        minColdMissGapSec: null,
        estimatedTtlSec: effTtl,
        confidence: ttlSource === "explicit" ? "high" : "low"
      },
      maxWarmHitGapSec: null,
      ttlStatus: "cold",
      cacheTemperature: "cold",
      compactAdvice: "none",
      estimatedCostSavingsPct: 0,
      estimatedInputCostUsd: 0,
      estimatedSavedUsd: 0,
      estimatedWastedUsd: 0,
      cacheCreationTokensTotal: 0,
      thinkingTokensTotal: 0,
      cacheWriteMultiplier: defProfile.cacheWriteMultiplier,
      windowSource,
      watermark: "ok",
      warnTokens: envWarnTokens ?? Math.round(effectiveWindow * 0.65),
      criticalTokens: envCritTokens ?? Math.round(effectiveWindow * 0.80),
      contextUtilization: 0,
      modelProfile: {
        id: defProfile.id,
        windowTokens: effectiveWindow,
        windowSource,
        defaultTtlSec: defProfile.ttlSec,
        cacheDiscountRate: defProfile.cacheDiscountRate,
        inputPer1M: defProfile.inputPer1M,
        cacheWriteMultiplier: defProfile.cacheWriteMultiplier,
        cacheWrite1hMultiplier: defProfile.cacheWrite1hMultiplier
      },
      weightedHitRate: 0,
      avgTurnHitRate: 0,
      currentContextTokens: 0,
      peakContextTokens: 0,
      bustCount: 0,
      bustsByCause: {
        ttl_idle_expiry: 0,
        model_switch: 0,
        compaction_or_truncation: 0,
        system_injection: 0,
        multimodal_media: 0,
        prefix_drift: 0
      },
      driftBreakdown: createEmptyDriftBreakdown(),
      wastedTokensTotal: 0,
      duplicateReadCount: 0,
      loopWatch: {
        status: "ok",
        windowSize: 0,
        repeatRate: 0,
        maxRepeatCount: 0,
        topRepeatedCall: null,
        editFailOscillations: 0,
        oscillatingFiles: [],
        reason: null
      },
      contextComposition: createEmptyContextComposition(),
      subagentBreakdown: createEmptySubagentBreakdown(),
      recentTurns: [],
      topContextDeltas: [],
      recentBusts: []
    };
  }
  try {
    const st = fs.statSync(transcriptPath);
    const resolvedObsConvId = inferConvIdFromTranscriptPath(transcriptPath, isSpecificConv ? convId : "");
    let effectiveTtlKeepalive = ttlKeepalive;
    if (isSpecificConvForKa && isSafeConversationId(kaConvId) && !isExplicitSubagentForKa) {
      if (isSidecarConversationSubagent(kaConvId, { store, transcriptPath })) {
        effectiveTtlKeepalive = {
          ...ttlKeepalive,
          enabled: false,
          supported: false,
          isSubagent: true,
          isCustomOverride: false,
          minContextTokens: 0,
          usedCount: 0,
          coldMissTripped: false,
          lastSentTs: 0,
          lastError: ""
        };
      }
    } else if (!unboundHostTab && !isSpecificConvForKa && resolvedObsConvId) {
      const obsIsSubagent = isSidecarConversationSubagent(resolvedObsConvId, { store, transcriptPath });
      const fallbackPrimaryConvId = obsIsSubagent
        ? getWatchdogMonitor().getStatus({ scope, refresh: false })?.ttlKeepalive?.conversationId || ""
        : resolvedObsConvId;
      if (fallbackPrimaryConvId) {
        const resolvedKa = store.getTtlKeepaliveState(fallbackPrimaryConvId);
        const resolvedCustom = store.hasCustomTtlKeepaliveOverride(fallbackPrimaryConvId);
        effectiveTtlKeepalive = {
          ...ttlKeepalive,
          conversationId: fallbackPrimaryConvId,
          enabled: store.isTtlKeepaliveEnabled(fallbackPrimaryConvId),
          supported: true,
          isSubagent: false,
          maxCount: store.getTtlKeepaliveMaxCount(fallbackPrimaryConvId),
          isCustomOverride: resolvedCustom,
          usedCount: resolvedKa.usedCount,
          coldMissTripped: Boolean(resolvedKa.coldMissTripped),
          lastSentTs: resolvedKa.lastSentTs || 0,
          lastError: resolvedKa.lastError || ""
        };
      }
    }
    const historicalTtlByProfile = store.getAllModelTtlCalibrations();
    const calStamp = formatCalibrationCacheStamp(historicalTtlByProfile);
    const baseKeyPrefix = `${transcriptPath}:${explicitTtlSec ?? "auto"}:${envWindowTokens ?? ""}:${envWarnTokens ?? ""}:${envCritTokens ?? ""}`;
    const cacheKey = `${baseKeyPrefix}:${calStamp}`;
    const cached = parsedDiagCache.get(cacheKey);
    let diag;
    let parsedSteps = null;
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      diag = refreshWallClockTtl(cached.diag, explicitTtlSec);
    } else {
      const isFullTranscript = st.size <= 2 * 1024 * 1024;
      const steps = isFullTranscript
        ? parseTranscriptLines(fs.readFileSync(transcriptPath, "utf8"))
        : readTranscriptTail(transcriptPath, 524288);
      parsedSteps = steps;
      const transcriptOwner = inferConvIdFromTranscriptPath(transcriptPath);
      if (transcriptOwner && transcriptOwner === resolvedObsConvId) {
        const rootOwner =
          typeof store.resolveRootSessionId === "function"
            ? store.resolveRootSessionId(transcriptOwner)
            : transcriptOwner;
        if (syncTranscriptClaimsForSteps(store, transcriptOwner, steps, { isFullTranscript })) {
          setClaimedTranscriptCache(`${store.dbPath || ""}|${rootOwner}|${transcriptPath}`, `${st.mtimeMs}:${st.size}`);
        }
        syncConversationFamilyTranscripts(store, transcriptOwner);
      }
      const nowMs = Date.now();
      const obsConvId = resolvedObsConvId;
      const diagOpts = {
        nowMs,
        historicalTtlByProfile,
        conversationId: obsConvId
      };
      if (explicitTtlSec !== undefined) diagOpts.ttlSec = explicitTtlSec;
      if (envWindowTokens !== undefined) diagOpts.windowTokens = envWindowTokens;
      if (envWarnTokens !== undefined) diagOpts.warnTokens = envWarnTokens;
      if (envCritTokens !== undefined) diagOpts.criticalTokens = envCritTokens;
      diag = analyzeTranscriptCache(steps, diagOpts);
      let finalCalStamp = calStamp;
      if (diag.ttlObservations && Object.keys(diag.ttlObservations).length > 0) {
        const recRes = store.recordModelTtlObservations(diag.ttlObservations, obsConvId, nowMs);
        if (recRes && recRes.updatedProfiles > 0) {
          finalCalStamp = formatCalibrationCacheStamp(store.getAllModelTtlCalibrations(nowMs));
        }
      }
      if (parsedDiagCache.size > 16) parsedDiagCache.clear();
      parsedDiagCache.set(`${baseKeyPrefix}:${finalCalStamp}`, {
        mtimeMs: st.mtimeMs,
        size: st.size,
        ttlSec: explicitTtlSec,
        diag
      });
      diag = { ...diag, serverNowMs: nowMs };
    }

    // Layer-2 post-flush cold-miss circuit breaker & live window-token threshold sync
    const kaTargetForDiag = effectiveTtlKeepalive.conversationId;
    if (
      kaTargetForDiag &&
      kaTargetForDiag !== "__unbound__" &&
      !effectiveTtlKeepalive.isSubagent &&
      kaTargetForDiag === resolvedObsConvId
    ) {
      const liveKa = store.getTtlKeepaliveState(kaTargetForDiag);
      if (
        liveKa.usedCount >= 1 &&
        !liveKa.pendingAck &&
        !liveKa.inKeepaliveTurn &&
        (liveKa.lastColdCheckUsed || 0) < liveKa.usedCount
      ) {
        const tailToCheck = parsedSteps || readWatchdogTranscriptTail(transcriptPath, 32768).steps;
        const info = inspectLatestTurnInSteps(tailToCheck);
        if (isKeepaliveTurnFlushedForRound(info, liveKa)) {
          const nextColdTripped = Boolean(liveKa.coldMissTripped || info.cacheReadTokens === 0);
          store.setTtlKeepaliveState(kaTargetForDiag, {
            coldMissTripped: nextColdTripped,
            lastColdCheckUsed: liveKa.usedCount,
            updatedTs: Date.now()
          });
          effectiveTtlKeepalive = { ...effectiveTtlKeepalive, coldMissTripped: nextColdTripped };
        }
      }
      if (diag?.currentContextTokens > 0) {
        try {
          const idleLease = readWatchdogLease(store, kaTargetForDiag);
          if (
            idleLease &&
            idleLease.phase === WATCHDOG_PHASES.IDLE &&
            !idleLease.isSubagent &&
            Number(idleLease.contextTokens || 0) === 0
          ) {
            const parsedLastPlannerMs = diag.lastPlannerAt ? Date.parse(diag.lastPlannerAt) : NaN;
            const anchorTs = idleLease.idleAnchorTs || idleLease.updatedTs || 0;
            const syncedOriginTs =
              Number.isFinite(parsedLastPlannerMs) &&
              parsedLastPlannerMs > 0 &&
              anchorTs > 0 &&
              parsedLastPlannerMs <= anchorTs &&
              anchorTs - parsedLastPlannerMs <= 30 * 60 * 1000
                ? Math.floor(parsedLastPlannerMs)
                : idleLease.cacheOriginTs;
            writeWatchdogLeaseIfUnchanged(store, idleLease.updatedTs, idleLease.phase, {
              ...idleLease,
              contextTokens: Math.floor(Number(diag.currentContextTokens)),
              ...(Number(diag.modelProfile?.windowTokens) > 0
                ? { windowTokens: Math.floor(Number(diag.modelProfile.windowTokens)) }
                : {}),
              ...(diag.currentModel ? { model: diag.currentModel } : {}),
              ...(syncedOriginTs > 0 ? { cacheOriginTs: syncedOriginTs } : {})
            });
          }
        } catch {}
      }
    }
    const resolvedWinTokens =
      Number(diag?.modelProfile?.windowTokens) > 0
        ? Math.floor(Number(diag.modelProfile.windowTokens))
        : defaultWindowTokens;
    effectiveTtlKeepalive = {
      ...effectiveTtlKeepalive,
      windowTokens: resolvedWinTokens,
      minContextTokens: effectiveTtlKeepalive.isCustomOverride
        ? 0
        : Math.round((resolvedWinTokens * globalTtlKeepaliveMinContextPct) / 100)
    };

    const activeTargetConvId = resolvedObsConvId || (isSpecificConv ? convId : "");
    const conversationActive = isSidecarConversationActive(activeTargetConvId, store);
    if (
      conversationActive &&
      diag.watermark !== "critical" &&
      diag.compactAdvice === "opportunistic_cold_compact"
    ) {
      diag = { ...diag, compactAdvice: "none" };
    }
    return {
      ok: true,
      transcriptFound: true,
      scope,
      conversationId: convId,
      resolvedConversationId: resolvedObsConvId || convId,
      conversationActive,
      ttlDesktopNotifyEnabled,
      globalTtlKeepaliveMaxCount,
      fallbackTtlKeepaliveMaxCount,
      globalTtlKeepaliveMinContextPct,
      ttlKeepalive: effectiveTtlKeepalive,
      ...diag,
      driftBreakdown: diag.driftBreakdown ?? createEmptyDriftBreakdown(),
      contextComposition: diag.contextComposition ?? createEmptyContextComposition(),
      subagentBreakdown: diag.subagentBreakdown ?? createEmptySubagentBreakdown(),
      serverNowMs: diag.serverNowMs ?? Date.now()
    };
  } catch (err) {
    return {
      ok: false,
      transcriptFound: false,
      serverNowMs: Date.now(),
      driftBreakdown: createEmptyDriftBreakdown(),
      recentBusts: [],
      contextComposition: createEmptyContextComposition(),
      subagentBreakdown: createEmptySubagentBreakdown(),
      error: err?.message || String(err)
    };
  }
}

function collectKnownWorktrees(store, sessionId = "default", sinceTs = null) {
  if (!store) return [];
  const roots = new Set();
  try {
    if (typeof store.open === "function") store.open();
    if (!store.db) return [];
    const sid = sessionId || "default";
    const isAll = sid === "all" || sid === "lifetime";
    const isApp = sid === "app" && sinceTs !== null && sinceTs !== undefined && Number.isFinite(Number(sinceTs));
    const sinceNum = isApp ? Number(sinceTs) : null;
    const sinceIso = isApp ? new Date(sinceNum).toISOString() : null;

    const queries = [
      () =>
        isAll
          ? store.db
              .prepare("SELECT DISTINCT worktree FROM session_checkpoints WHERE worktree != '' ORDER BY updated_ts DESC LIMIT 20")
              .all()
          : isApp
            ? store.db
                .prepare("SELECT DISTINCT worktree FROM session_checkpoints WHERE worktree != '' AND updated_ts >= ? ORDER BY updated_ts DESC LIMIT 20")
                .all(sinceNum)
            : store.db
                .prepare("SELECT DISTINCT worktree FROM session_checkpoints WHERE session_id = ? AND worktree != '' LIMIT 10")
                .all(sid),
      () =>
        isAll
          ? store.db
              .prepare("SELECT DISTINCT worktree FROM sources WHERE worktree != '' ORDER BY created_ts DESC LIMIT 20")
              .all()
          : isApp
            ? store.db
                .prepare("SELECT DISTINCT worktree FROM sources WHERE worktree != '' AND (created_ts >= ? OR created_at >= ?) ORDER BY created_ts DESC LIMIT 20")
                .all(sinceNum, sinceIso)
            : store.db
                .prepare("SELECT DISTINCT worktree FROM sources WHERE session_id = ? AND worktree != '' ORDER BY created_ts DESC LIMIT 20")
                .all(sid),
      () =>
        isAll
          ? store.db
              .prepare("SELECT DISTINCT worktree FROM events WHERE worktree != '' ORDER BY seq DESC LIMIT 20")
              .all()
          : isApp
            ? store.db
                .prepare("SELECT DISTINCT worktree FROM events WHERE worktree != '' AND created_at >= ? ORDER BY seq DESC LIMIT 20")
                .all(sinceIso)
            : store.db
                .prepare("SELECT DISTINCT worktree FROM events WHERE session_id = ? AND worktree != '' ORDER BY seq DESC LIMIT 20")
                .all(sid)
    ];

    for (const run of queries) {
      try {
        for (const row of run() || []) {
          if (row?.worktree && typeof row.worktree === "string") {
            const raw = row.worktree.trim();
            if (!raw || raw.includes("\0") || isUncPath(raw) || !path.isAbsolute(raw)) {
              continue;
            }
            const resolved = path.resolve(raw);
            if (!isUncPath(resolved) && !isUnsafeBroadRoot(resolved)) {
              roots.add(resolved);
            }
          }
        }
      } catch {}
    }
  } catch {}
  return Array.from(roots);
}

function isFilesystemRoot(dirPath) {
  const resolved = path.resolve(dirPath);
  const root = path.parse(resolved).root;
  if (!root) return false;
  return process.platform === "win32"
    ? resolved.toLowerCase() === root.toLowerCase()
    : resolved === root;
}

function isPathInsideRoot(candidatePath, rootPath) {
  const normCand = process.platform === "win32" ? candidatePath.toLowerCase() : candidatePath;
  const normRoot = process.platform === "win32" ? rootPath.toLowerCase() : rootPath;
  const rel = path.relative(normRoot, normCand);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !rel.startsWith("../") && !path.isAbsolute(rel))
  );
}

function resolveCanonicalPath(p) {
  const real = typeof fs.realpathSync.native === "function"
    ? fs.realpathSync.native(p)
    : fs.realpathSync(p);
  if (process.platform === "win32") {
    const driveMatch = real.match(/^\\\\\?\\([a-zA-Z]:\\.*)$/);
    if (driveMatch) return driveMatch[1];
  }
  return real;
}

function isUnsafeBroadRoot(dirPath) {
  if (isUncPath(dirPath)) return true;
  if (isFilesystemRoot(dirPath)) return true;
  const resolved = path.resolve(dirPath);
  if (isUncPath(resolved)) return true;
  let realResolved = resolved;
  try {
    realResolved = resolveCanonicalPath(resolved);
    if (isUncPath(realResolved) || isFilesystemRoot(realResolved)) return true;
  } catch {}
  const home = path.resolve(os.homedir());
  let realHome = home;
  try {
    realHome = resolveCanonicalPath(home);
  } catch {}
  // Reject os.homedir() itself and any ancestor directory of os.homedir() (e.g. C:\Users, /Users, /home),
  // including Windows 8.3 short-name aliases (e.g. C:\Users\ADMINI~1)
  return (
    isPathInsideRoot(home, resolved) ||
    isPathInsideRoot(realHome, resolved) ||
    isPathInsideRoot(home, realResolved) ||
    isPathInsideRoot(realHome, realResolved)
  );
}

/**
 * Strictly whitelist explicit `cwd` parameters for `/api/handoff` against known workspace roots
 * recorded in SQLite. Blocks UNC paths (including Windows mixed-slash UNC `/\host\share`), relative paths,
 * filesystem roots, home/ancestor directories, arbitrary external directories, and symlink/junction escapes
 * before touching the filesystem or spawning `git`.
 */
export function resolveAllowedHandoffCwd(rawCwd, knownRoots = []) {
  if (typeof rawCwd !== "string") return "";
  const trimmed = rawCwd.trim();
  if (!trimmed || trimmed.includes("\0")) return "";
  if (isUncPath(trimmed)) return "";
  if (!path.isAbsolute(trimmed)) return "";
  const resolvedCandidate = path.resolve(trimmed);
  if (isUncPath(resolvedCandidate) || isUnsafeBroadRoot(resolvedCandidate)) return "";

  for (const rawRoot of knownRoots) {
    if (!rawRoot || typeof rawRoot !== "string") continue;
    const trimmedRoot = rawRoot.trim();
    if (!trimmedRoot || trimmedRoot.includes("\0") || isUncPath(trimmedRoot)) {
      continue;
    }
    if (!path.isAbsolute(trimmedRoot)) continue;
    const resolvedRoot = path.resolve(trimmedRoot);
    if (isUncPath(resolvedRoot) || isUnsafeBroadRoot(resolvedRoot)) continue;
    const mayBeWinShortAlias =
      process.platform === "win32" && (resolvedCandidate.includes("~") || resolvedRoot.includes("~"));
    if (!isPathInsideRoot(resolvedCandidate, resolvedRoot) && !mayBeWinShortAlias) continue;
    try {
      const canonicalRoot = resolveCanonicalPath(resolvedRoot);
      if (isUncPath(canonicalRoot) || isUnsafeBroadRoot(canonicalRoot)) continue;
      const canonicalCand = resolveCanonicalPath(resolvedCandidate);
      if (isUncPath(canonicalCand) || isUnsafeBroadRoot(canonicalCand)) continue;
      if (isPathInsideRoot(canonicalCand, canonicalRoot) && fs.statSync(canonicalCand).isDirectory()) {
        return fs.realpathSync(resolvedCandidate);
      }
    } catch {
      // Unresolvable or non-directory -> reject
    }
  }
  return "";
}

const RESERVED_CONFIRMED_CONV_IDS = new Set([
  "default",
  "all",
  "lifetime",
  "app",
  "__unbound__",
  "unknown",
  "none",
  "null",
  "undefined"
]);

function validateHandoffMode(rawMode, { allowAgent = true } = {}) {
  if (rawMode === undefined) {
    return { ok: true, mode: "full" };
  }
  if (typeof rawMode !== "string") {
    return { ok: false, error: "Field 'mode' must be a string ('full' or 'agent')" };
  }
  if (rawMode === "full") {
    return { ok: true, mode: "full" };
  }
  if (rawMode === "agent") {
    if (!allowAgent) {
      return { ok: false, error: "Handoff mode 'agent' requires POST with application/json" };
    }
    return { ok: true, mode: "agent" };
  }
  return { ok: false, error: "Invalid 'mode' value: expected 'full' or 'agent'" };
}

function validateOptionalBooleanField(data, fieldName) {
  if (data && data[fieldName] !== undefined && typeof data[fieldName] !== "boolean") {
    return { ok: false, error: `Field '${fieldName}' must be a boolean` };
  }
  return { ok: true };
}

function resolveConfirmedConversation(data = {}, defaultConvId = "default") {
  const unboundHostTab = isUnboundSidecarHostRequest(data);
  const safeSessionId = typeof data?.sessionId === "string" ? data.sessionId.trim() : "";
  const explicitConvId = typeof data?.conversationId === "string" ? data.conversationId.trim() : "";
  const safeDefaultConv = typeof defaultConvId === "string" ? defaultConvId.trim() : "";
  const rawScope = typeof data?.scope === "string" && data.scope.trim() ? data.scope.trim() : "";
  const scope =
    rawScope === "all"
      ? "lifetime"
      : rawScope === "session"
        ? "app"
        : rawScope || (safeSessionId === "all" ? "lifetime" : safeSessionId === "app" ? "app" : "conversation");

  // Rich conversation attribution ONLY accepts explicit conversationId > native defaultConvId;
  // NEVER falls back to checkpoint sessionId.
  const attributedConv = unboundHostTab ? "" : explicitConvId || safeDefaultConv || "default";
  const isSpecificConv = Boolean(
    attributedConv &&
      !RESERVED_CONFIRMED_CONV_IDS.has(attributedConv.toLowerCase()) &&
      isSafeConversationId(attributedConv)
  );
  const confirmed = Boolean(
    scope === "conversation" &&
      !unboundHostTab &&
      data?.conversationConfirmed !== false &&
      isSpecificConv
  );
  const convId = unboundHostTab ? "__unbound__" : attributedConv || "default";
  const targetSid =
    scope === "lifetime" || scope === "all"
      ? "all"
      : scope === "app" || scope === "session"
        ? "app"
        : unboundHostTab
          ? "__unbound__"
          : convId;
  const hasExplicitSessionOnly = Boolean(
    scope === "conversation" &&
      !unboundHostTab &&
      !isSpecificConv &&
      safeSessionId &&
      safeSessionId !== "all" &&
      safeSessionId !== "app"
  );
  const hasExplicitReservedOrUnsafeConv = Boolean(
    !unboundHostTab &&
      !isSpecificConv &&
      explicitConvId &&
      explicitConvId.toLowerCase() !== "default"
  );

  return {
    scope,
    convId,
    targetSid,
    unboundHostTab,
    confirmed,
    confirmedConversationId: confirmed ? attributedConv : "",
    hasExplicitSessionOnly,
    hasExplicitReservedOrUnsafeConv
  };
}

function buildStructuredVerificationSummary(slot) {
  if (!slot || typeof slot !== "object") return "";
  const exitNum =
    slot.exitCode !== null &&
    slot.exitCode !== undefined &&
    typeof slot.exitCode !== "boolean" &&
    String(slot.exitCode).trim() !== "" &&
    Number.isFinite(Number(slot.exitCode))
      ? Number(slot.exitCode)
      : null;
  if (slot.ok) {
    return exitNum !== null ? `passed (exit ${exitNum})` : "passed";
  }
  return exitNum !== null ? `failed (exit ${exitNum})` : "failed";
}

function stripResumeFailureExcerpts(resumeRes) {
  if (!resumeRes || typeof resumeRes !== "object") return resumeRes;
  const cp = resumeRes.sessionCheckpoint;
  if (!cp || typeof cp !== "object") return resumeRes;
  const stripSlot = (slot) => {
    if (!slot || typeof slot !== "object") return slot;
    const copy = { ...slot };
    delete copy.failureExcerpt;
    delete copy.firstErrorLine;
    delete copy.excerpt;
    delete copy.stderr;
    delete copy.error;
    copy.summary = buildStructuredVerificationSummary(copy);
    return copy;
  };
  return {
    ...resumeRes,
    sessionCheckpoint: {
      ...cp,
      lastTest: stripSlot(cp.lastTest),
      lastBuild: stripSlot(cp.lastBuild)
    }
  };
}

function getResumePayload(data = {}, defaultConvId = "default") {
  const store = getRuntimeStore();
  const appStartTime = getAppStartTime();
  const {
    scope,
    convId,
    unboundHostTab,
    confirmed,
    confirmedConversationId,
    hasExplicitSessionOnly,
    hasExplicitReservedOrUnsafeConv
  } = resolveConfirmedConversation(data, defaultConvId);
  const explicitRawSid = typeof data?.sessionId === "string" ? data.sessionId.trim() : "";
  let res;
  if (scope === "lifetime" || scope === "all") {
    res = store.getResumeState("all", 10);
  } else if (scope === "app" || scope === "session") {
    res = store.getResumeState("app", 10, { sinceTs: appStartTime });
  } else if (unboundHostTab || hasExplicitSessionOnly || hasExplicitReservedOrUnsafeConv) {
    res = store.getResumeState("__unbound__", 10);
  } else if (confirmed && confirmedConversationId) {
    const trustedSid =
      resolveTrustedCheckpointSessionId(store, confirmedConversationId, explicitRawSid) || convId;
    res = store.getResumeState(trustedSid, 10);
  } else {
    res = store.getResumeState(convId, 10);
  }
  return confirmed ? res : stripResumeFailureExcerpts(res);
}

function getSourceChunksPayload(data = {}) {
  const store = getRuntimeStore();
  if (typeof data.sourceId !== "string" || !data.sourceId.trim()) {
    return { ok: false, sourceId: null, chunks: [] };
  }
  const sourceId = data.sourceId;
  return { ok: true, sourceId, chunks: store.getSourceChunks(sourceId) };
}

function getHandoffPayload(data = {}, defaultConvId = "default") {
  const store = getRuntimeStore();
  const appStartTime = getAppStartTime();
  const mode = data?.mode === "agent" ? "agent" : "full";
  const {
    scope,
    convId,
    targetSid,
    unboundHostTab,
    confirmed,
    confirmedConversationId,
    hasExplicitSessionOnly,
    hasExplicitReservedOrUnsafeConv
  } = resolveConfirmedConversation(data, defaultConvId);
  const sinceTs = scope === "app" || scope === "session" ? appStartTime : null;

  const explicitRawSid = typeof data?.sessionId === "string" ? data.sessionId.trim() : "";
  const isIsolatedUnconfirmed =
    scope === "conversation" &&
    !confirmed &&
    (unboundHostTab ||
      data?.conversationConfirmed === false ||
      hasExplicitSessionOnly ||
      hasExplicitReservedOrUnsafeConv);

  let effectiveCheckpointSid = targetSid;
  if (confirmed && confirmedConversationId) {
    effectiveCheckpointSid =
      resolveTrustedCheckpointSessionId(store, confirmedConversationId, explicitRawSid) ||
      confirmedConversationId;
  } else if (isIsolatedUnconfirmed) {
    effectiveCheckpointSid = "__unbound__";
  }

  const rawCwd = typeof data.cwd === "string" ? data.cwd.trim() : "";
  const skipWorkspaceInference = isIsolatedUnconfirmed || (scope === "conversation" && !confirmed && mode === "agent");
  const cwd = skipWorkspaceInference
    ? ""
    : rawCwd
      ? resolveAllowedHandoffCwd(rawCwd, collectKnownWorktrees(store, effectiveCheckpointSid, sinceTs))
      : inferWorkspaceFromStore(store, effectiveCheckpointSid, sinceTs);
  const rawMaxBytes = parseOptionalPositiveNumber(data.maxBytes);
  const maxBytes = rawMaxBytes !== undefined
    ? Math.min(16384, Math.max(256, Math.floor(rawMaxBytes)))
    : 5800;

  // Skip KV-cache diag recompute in `agent` mode (drawer does not render KV-cache section);
  // in `full` mode align cache-diag attribution strictly with the resolved conversation/checkpoint.
  let cacheDiag = null;
  if (mode !== "agent") {
    try {
      const cacheDiagInput = {
        ...data,
        scope,
        conversationId: confirmed
          ? confirmedConversationId
          : isIsolatedUnconfirmed
            ? "__unbound__"
            : scope === "conversation" && convId !== "default"
              ? convId
              : "",
        sessionId: effectiveCheckpointSid
      };
      const diag = getCacheDiagPayload(cacheDiagInput, confirmed ? confirmedConversationId : "default");
      if (diag && diag.ok && diag.transcriptFound) {
        cacheDiag = diag;
      }
    } catch {}
  }

  const rawStallConvId = typeof data?.stallConversationId === "string" ? data.stallConversationId.trim() : "";
  const hasExplicitStallConvId = Boolean(rawStallConvId);
  const validStallConvId =
    hasExplicitStallConvId &&
    !RESERVED_CONFIRMED_CONV_IDS.has(rawStallConvId.toLowerCase()) &&
    isSafeConversationId(rawStallConvId)
      ? rawStallConvId
      : "";

  const monitor = getWatchdogMonitor();
  let stallContext = null;
  if (data.includeStall !== false) {
    try {
      if (confirmed && confirmedConversationId) {
        monitor.tick();
        stallContext = monitor.getStallContextForConversation(confirmedConversationId, { includeUserInput: true });
      } else if (scope !== "conversation") {
        monitor.tick();
        if (hasExplicitStallConvId) {
          const targetedStall = validStallConvId
            ? monitor.getStallContextForConversation(validStallConvId, { includeUserInput: false })
            : null;
          stallContext = targetedStall ? { ...targetedStall, lastUserInput: "" } : null;
        } else {
          const topStall = monitor.getTopAlertingStallContext();
          stallContext = topStall ? { ...topStall, lastUserInput: "" } : null;
        }
      }
    } catch {}
  }

  const brief = buildHandoffBrief({
    store,
    mode,
    conversationId: confirmedConversationId,
    conversationConfirmed: confirmed,
    scope,
    sessionId: effectiveCheckpointSid,
    cwd,
    cacheDiag,
    maxBytes,
    sinceTs,
    stallContext,
    brainRoots: Array.isArray(monitor?.brainRoots) ? monitor.brainRoots : []
  });

  const responseConvId = unboundHostTab
    ? typeof data?.conversationId === "string" && data.conversationId.trim() === "__unbound__"
      ? "__unbound__"
      : ""
    : hasExplicitSessionOnly || hasExplicitReservedOrUnsafeConv
      ? ""
      : convId;

  const payload = {
    ok: true,
    scope,
    conversationId: responseConvId,
    sessionId: effectiveCheckpointSid,
    hasStallContext: Boolean(stallContext),
    markdown: brief.markdown,
    summary: brief.summary,
    bytes: brief.bytes,
    truncated: brief.truncated
  };

  if (mode === "agent") {
    payload.mode = "agent";
    payload.confirmedConversation = brief.confirmedConversation;
    payload.secretRedactionEnabled = brief.secretRedactionEnabled !== false;
    payload.anchors = brief.anchors;
    payload.sampledAt = brief.sampledAt || "";
    payload.resumeCommand = brief.resumeCommand;
    payload.incidentKey = stallContext?.incidentKey || "";
    if (hasExplicitStallConvId && scope !== "conversation" && stallContext?.conversationId) {
      payload.stallConversationId = stallContext.conversationId;
    }
  }

  return payload;
}

function getWatchdogPayload(data = {}, defaultConvId = "default") {
  const { scope, convId, unboundHostTab, confirmed, hasExplicitSessionOnly, hasExplicitReservedOrUnsafeConv } =
    resolveConfirmedConversation(data, defaultConvId);
  const monitor = getWatchdogMonitor();
  const targetConv =
    unboundHostTab || hasExplicitSessionOnly
      ? "__unbound__"
      : hasExplicitReservedOrUnsafeConv
        ? (scope === "conversation" ? "__unbound__" : "")
        : convId && convId !== "default"
          ? convId
          : "";
  const status = monitor.getStatus({
    conversationId: targetConv,
    scope,
    refresh: true,
    includeRichRescue: confirmed
  });
  return {
    ...status,
    scope,
    conversationId: unboundHostTab
      ? (typeof data?.conversationId === "string" && data.conversationId.trim() === "__unbound__" ? "__unbound__" : "")
      : hasExplicitSessionOnly || hasExplicitReservedOrUnsafeConv
        ? ""
        : convId
  };
}

function handleWatchdogActionMutation(data = {}, defaultConvId = "default") {
  if (data.fromSidecarHost !== undefined && typeof data.fromSidecarHost !== "boolean") {
    return { ok: false, status: 400, error: "Field 'fromSidecarHost' must be a boolean" };
  }
  if (data.conversationConfirmed !== undefined && typeof data.conversationConfirmed !== "boolean") {
    return { ok: false, status: 400, error: "Field 'conversationConfirmed' must be a boolean" };
  }
  const store = getRuntimeStore();
  const monitor = getWatchdogMonitor();
  const { scope, convId, unboundHostTab, confirmed, hasExplicitSessionOnly, hasExplicitReservedOrUnsafeConv } =
    resolveConfirmedConversation(data, defaultConvId);
  const targetConv =
    !unboundHostTab && !hasExplicitSessionOnly && !hasExplicitReservedOrUnsafeConv && convId && convId !== "default"
      ? convId
      : "";
  const statusTargetConv =
    unboundHostTab || hasExplicitSessionOnly
      ? "__unbound__"
      : hasExplicitReservedOrUnsafeConv
        ? (scope === "conversation" ? "__unbound__" : "")
        : targetConv;
  const getScopedStatus = (opts) => ({ ...monitor.getStatus(opts), scope });
  const action = typeof data.action === "string" && data.action.trim() ? data.action.trim() : "";

  if (action === "ack" || action === "snooze") {
    const res = monitor.acknowledge(targetConv, data.snoozeSec);
    if (!res.ok) return { ok: false, status: 400, error: res.error };
    return { ...res, status: getScopedStatus({ conversationId: statusTargetConv, scope, refresh: false, includeRichRescue: confirmed }) };
  }
  if (action === "clear" || action === "markIdle") {
    const res = monitor.markIdle(targetConv, "user_marked_idle");
    if (!res.ok) return { ok: false, status: 400, error: res.error };
    return { ...res, status: getScopedStatus({ conversationId: statusTargetConv, scope, refresh: false, includeRichRescue: confirmed }) };
  }
  if (action === "setEnabled") {
    const cur = store.isWatchdogEnabled();
    const next =
      data.enabled !== undefined ? (data.enabled === true || data.enabled === "true" || data.enabled === "1") : !cur;
    store.setWatchdogEnabled(next);
    const effective = store.isWatchdogEnabled();
    if (!effective) {
      monitor.clearActiveLeasesOnDisable();
    }
    return {
      ok: true,
      enabled: effective,
      status: getScopedStatus({ conversationId: statusTargetConv, scope, refresh: true, includeRichRescue: confirmed })
    };
  }
  if (action === "setDesktopNotify") {
    const cur = store.isWatchdogDesktopNotifyEnabled();
    const next =
      data.enabled !== undefined ? (data.enabled === true || data.enabled === "true" || data.enabled === "1") : !cur;
    store.setWatchdogDesktopNotifyEnabled(next);
    const effective = store.isWatchdogDesktopNotifyEnabled();
    return {
      ok: true,
      desktopNotifyEnabled: effective,
      status: getScopedStatus({ conversationId: statusTargetConv, scope, refresh: true, includeRichRescue: confirmed })
    };
  }
  if (action === "setTtlDesktopNotify") {
    const cur = store.isTtlDesktopNotifyEnabled();
    const next =
      data.enabled !== undefined ? (data.enabled === true || data.enabled === "true" || data.enabled === "1") : !cur;
    store.setTtlDesktopNotifyEnabled(next);
    const effective = store.isTtlDesktopNotifyEnabled();
    return {
      ok: true,
      ttlDesktopNotifyEnabled: effective,
      status: getScopedStatus({ conversationId: statusTargetConv, scope, refresh: true, includeRichRescue: confirmed })
    };
  }
  if (action === "setGlobalTtlKeepalive") {
    const rawMax = data.maxCount;
    const invalidType =
      rawMax === undefined ||
      rawMax === null ||
      typeof rawMax === "boolean" ||
      typeof rawMax === "object" ||
      (typeof rawMax === "string" && rawMax.trim() === "");
    const parsedMax = invalidType ? NaN : Number(rawMax);
    if (!Number.isFinite(parsedMax) || !Number.isInteger(parsedMax) || parsedMax < 0 || parsedMax > 20) {
      return { ok: false, status: 400, error: "Invalid 'maxCount' value: expected integer between 0 and 20" };
    }
    store.setGlobalTtlKeepaliveMaxCount(parsedMax);
    const effectiveGlobal = store.getGlobalTtlKeepaliveMaxCount();
    const fallbackMax = store.getFallbackNonZeroKeepaliveMaxCount();
    return {
      ok: true,
      globalTtlKeepaliveMaxCount: effectiveGlobal,
      fallbackTtlKeepaliveMaxCount: fallbackMax,
      status: getScopedStatus({ conversationId: statusTargetConv, scope, refresh: true, includeRichRescue: confirmed })
    };
  }
  if (action === "setTtlKeepaliveMinContextPct") {
    const rawPct = data.minContextPct !== undefined ? data.minContextPct : data.pct;
    const invalidType =
      rawPct === undefined ||
      rawPct === null ||
      typeof rawPct === "boolean" ||
      typeof rawPct === "object" ||
      (typeof rawPct === "string" && rawPct.trim() === "");
    const parsedPct = invalidType ? NaN : Number(rawPct);
    if (!Number.isFinite(parsedPct) || !Number.isInteger(parsedPct) || parsedPct < 0 || parsedPct > 100) {
      return {
        ok: false,
        status: 400,
        error: "Invalid 'minContextPct' value: expected integer between 0 and 100"
      };
    }
    store.setGlobalTtlKeepaliveMinContextPct(parsedPct);
    const effectivePct = store.getGlobalTtlKeepaliveMinContextPct();
    return {
      ok: true,
      globalTtlKeepaliveMinContextPct: effectivePct,
      status: getScopedStatus({ conversationId: statusTargetConv, scope, refresh: true, includeRichRescue: confirmed })
    };
  }
  if (
    action === "setTtlKeepalive" ||
    action === "resetTtlKeepalive" ||
    action === "resetTtlKeepaliveOverride"
  ) {
    const rawExplicitConv = typeof data.conversationId === "string" ? data.conversationId.trim() : "";
    const hasExplicitEmptyConv = typeof data.conversationId === "string" && rawExplicitConv === "";
    const isReservedConv =
      rawExplicitConv === "" ||
      rawExplicitConv === "default" ||
      rawExplicitConv === "all" ||
      rawExplicitConv === "lifetime" ||
      rawExplicitConv === "app";
    if (!isReservedConv && rawExplicitConv !== "__unbound__" && !isSafeConversationId(rawExplicitConv)) {
      return { ok: false, status: 400, error: "Invalid 'conversationId' value" };
    }
    const kaConv =
      unboundHostTab
        ? "__unbound__"
        : !hasExplicitEmptyConv && targetConv && isSafeConversationId(targetConv)
          ? targetConv
          : monitor.getStatus({ scope, refresh: false, includeRichRescue: false })?.ttlKeepalive?.conversationId || "__unbound__";
    const kaRichAllowed = Boolean(confirmed && kaConv === targetConv && kaConv !== "__unbound__");

    if (kaConv !== "__unbound__" && monitor._isConversationSubagent(store, kaConv)) {
      try {
        store.deleteMeta(`cache:ttl_keepalive_state:${kaConv}`);
      } catch {}
      return {
        ok: true,
        conversationId: kaConv,
        isSubagent: true,
        ttlKeepaliveEnabled: false,
        ttlKeepaliveMaxCount: store.getTtlKeepaliveMaxCount(null),
        status: getScopedStatus({ conversationId: kaConv, scope, refresh: true, includeRichRescue: kaRichAllowed })
      };
    }

    if (action === "resetTtlKeepaliveOverride" || (action === "setTtlKeepalive" && data.followGlobal === true)) {
      store.clearTtlKeepaliveOverride(kaConv);
      return {
        ok: true,
        conversationId: kaConv,
        isCustomOverride: false,
        ttlKeepaliveEnabled: store.isTtlKeepaliveEnabled(kaConv),
        ttlKeepaliveMaxCount: store.getTtlKeepaliveMaxCount(kaConv),
        status: getScopedStatus({ conversationId: kaConv, scope, refresh: true, includeRichRescue: kaRichAllowed })
      };
    }

    if (action === "setTtlKeepalive") {
      const wasEnabledBefore = store.isTtlKeepaliveEnabled(kaConv);
      if (data.maxCount !== undefined) {
        const rawMax = data.maxCount;
        const invalidType =
          rawMax === null ||
          typeof rawMax === "boolean" ||
          typeof rawMax === "object" ||
          (typeof rawMax === "string" && rawMax.trim() === "");
        const parsedMax = invalidType ? NaN : Number(rawMax);
        if (!Number.isFinite(parsedMax) || !Number.isInteger(parsedMax) || parsedMax < 1 || parsedMax > 20) {
          return { ok: false, status: 400, error: "Invalid 'maxCount' value: expected integer between 1 and 20" };
        }
        store.setTtlKeepaliveMaxCount(parsedMax, kaConv);
        if (data.enabled === undefined && !wasEnabledBefore) {
          store.setTtlKeepaliveEnabled(true, kaConv);
        }
      }
      if (data.enabled !== undefined) {
        const next = data.enabled === true || data.enabled === "true" || data.enabled === "1";
        store.setTtlKeepaliveEnabled(next, kaConv);
      } else if (data.maxCount === undefined) {
        const cur = store.isTtlKeepaliveEnabled(kaConv);
        store.setTtlKeepaliveEnabled(!cur, kaConv);
      }
      if (data.resetCount === true && kaConv) {
        store.resetTtlKeepaliveState(kaConv);
      }
      return {
        ok: true,
        conversationId: kaConv,
        isCustomOverride: store.hasCustomTtlKeepaliveOverride(kaConv),
        ttlKeepaliveEnabled: store.isTtlKeepaliveEnabled(kaConv),
        ttlKeepaliveMaxCount: store.getTtlKeepaliveMaxCount(kaConv),
        status: getScopedStatus({ conversationId: kaConv, scope, refresh: true, includeRichRescue: kaRichAllowed })
      };
    }

    store.resetTtlKeepaliveState(kaConv);
    return {
      ok: true,
      conversationId: kaConv,
      status: getScopedStatus({ conversationId: kaConv, scope, refresh: true, includeRichRescue: kaRichAllowed })
    };
  }
  if (action === "setUiLang") {
    const requested = typeof data.lang === "string" ? data.lang.trim().toLowerCase() : "";
    if (requested !== "zh" && requested !== "en") {
      return { ok: false, status: 400, error: "Invalid 'lang' value: expected 'zh' or 'en'" };
    }
    store.setUiLang(requested);
    const info = store.getUiLangInfo();
    return {
      ok: true,
      uiLang: info.lang,
      uiLangSource: info.source,
      status: getScopedStatus({ conversationId: statusTargetConv, scope, refresh: false, includeRichRescue: confirmed })
    };
  }
  if (action === "focusConversation") {
    if (data.skipOsFocus !== undefined && typeof data.skipOsFocus !== "boolean") {
      return { ok: false, status: 400, error: "Field 'skipOsFocus' must be a boolean" };
    }
    const hasExplicitConv = data.conversationId !== undefined && data.conversationId !== null;
    const explicitConv = typeof data.conversationId === "string" ? data.conversationId.trim() : "";
    const res = monitor.focusConversation(hasExplicitConv ? explicitConv : targetConv, {
      source: "sidecar_ui",
      skipOsFocus: data.skipOsFocus === true
    });
    if (!res.ok) return { ok: false, status: 400, error: res.error };
    const focusRichAllowed = Boolean(
      scope === "conversation" &&
        !unboundHostTab &&
        data.conversationConfirmed !== false &&
        res.conversationId &&
        !RESERVED_CONFIRMED_CONV_IDS.has(res.conversationId.toLowerCase()) &&
        isSafeConversationId(res.conversationId)
    );
    return {
      ...res,
      status: getScopedStatus({ conversationId: res.conversationId, scope, refresh: false, includeRichRescue: focusRichAllowed })
    };
  }
  if (action === "ackJump") {
    const res = monitor.acknowledgePendingJump(data.jumpId);
    if (!res.ok) return { ok: false, status: 400, error: res.error };
    return {
      ...res,
      status: getScopedStatus({ conversationId: statusTargetConv, scope, refresh: false, includeRichRescue: confirmed })
    };
  }
  if (action === "tick") {
    return getScopedStatus({ conversationId: statusTargetConv, scope, refresh: true, includeRichRescue: confirmed });
  }
  return {
    ok: false,
    status: 400,
    error:
      "Invalid watchdog action: expected 'ack', 'snooze', 'clear', 'markIdle', 'setEnabled', 'setDesktopNotify', 'setTtlDesktopNotify', 'setTtlKeepalive', 'setGlobalTtlKeepalive', 'setTtlKeepaliveMinContextPct', 'resetTtlKeepalive', 'resetTtlKeepaliveOverride', 'setUiLang', 'focusConversation', 'ackJump', or 'tick'"
  };
}

export function isSameFilePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => {
    const resolved = path.resolve(String(p));
    let real = resolved;
    try {
      real = fs.realpathSync(resolved);
    } catch {}
    return process.platform === "win32" ? real.toLowerCase() : real;
  };
  return norm(a) === norm(b);
}

/**
 * Only allow SidecarApp mode when ANTIGRAVITY_SIDECAR_UI_TOKEN is explicitly non-empty
 * (sidecar_sdk fails open on authentication when its token is empty/missing).
 */
export function shouldUseSidecarApp(env = process.env, hasSidecarApp = true) {
  return Boolean(
    hasSidecarApp &&
      typeof env?.ANTIGRAVITY_LS_ADDRESS === "string" && env.ANTIGRAVITY_LS_ADDRESS.trim() &&
      typeof env?.ANTIGRAVITY_CSRF_TOKEN === "string" && env.ANTIGRAVITY_CSRF_TOKEN.trim() &&
      typeof env?.ANTIGRAVITY_SIDECAR_WEB_PORT === "string" && env.ANTIGRAVITY_SIDECAR_WEB_PORT.trim() &&
      typeof env?.ANTIGRAVITY_SIDECAR_UI_TOKEN === "string" && env.ANTIGRAVITY_SIDECAR_UI_TOKEN.trim() &&
      env?.SIDECAR_FORCE_HTTP !== "1"
  );
}

/**
 * Resolve standalone HTTP port: prefer explicit PORT, then host-assigned
 * ANTIGRAVITY_SIDECAR_WEB_PORT (so fail-closed sidecar fallback doesn't collide on 8765),
 * and finally default to 8765.
 */
export function resolveStandalonePort(env = process.env) {
  for (const raw of [env?.PORT, env?.ANTIGRAVITY_SIDECAR_WEB_PORT]) {
    if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 65535) {
      return raw === 0 ? 0 : raw;
    }
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (/^\d+$/.test(trimmed)) {
        const parsed = Number(trimmed);
        if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535) {
          return parsed;
        }
      }
    }
  }
  return 8765;
}

const isDirectRun = Boolean(process.argv[1] && isSameFilePath(process.argv[1], __selfPath));

function parseStrictCutoffBytes(raw) {
  if (raw === "none" || raw === 0 || raw === "0") return 0;
  if (typeof raw === "number") {
    if (Number.isInteger(raw) && raw >= 0 && raw <= 64 * 1024 * 1024) return raw;
    return null;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (/^\d{1,9}$/.test(trimmed)) {
      const n = Number(trimmed);
      if (Number.isSafeInteger(n) && n >= 0 && n <= 64 * 1024 * 1024) return n;
    }
    return null;
  }
  return null;
}

function handleCutoffMutation(data, defaultConvId = "default") {
  const store = getRuntimeStore();
  const { scope, targetSid, convId } = resolveTargetSession(data, defaultConvId);
  const cutoffBytes = parseStrictCutoffBytes(data?.cutoff);
  if (cutoffBytes === null) {
    return { ok: false, status: 400, error: "Invalid 'cutoff' value: must be a non-negative integer or 'none'" };
  }
  const saved = store.setCutoff(cutoffBytes, targetSid);
  return {
    ok: true,
    cutoffBytes: saved,
    scope,
    sessionId: targetSid,
    globalCutoffBytes: store.getCutoff(null),
    appCutoffBytes: store.getCutoff("app"),
    conversationCutoffBytes: store.getCutoff(convId)
  };
}

function handleSearchPayload(data, queries, defaultConvId = "default") {
  const store = getRuntimeStore();
  const rawSourceId = typeof data?.sourceId === "string" && data.sourceId.trim() ? data.sourceId.trim() : null;
  const { scope, convId } = resolveTargetSession(data, defaultConvId);
  if (scope === "lifetime" || scope === "all") {
    return store.search({ queries, sourceId: rawSourceId, scope: "all", limit: 5 });
  }
  if (scope === "app" || scope === "session") {
    const appStart = getAppStartTime();
    const res = store.search({ queries, sourceId: rawSourceId, scope: "all", limit: 20 });
    if (!Array.isArray(res.hits) || res.hits.length === 0) return res;
    const uniqueIds = Array.from(new Set(res.hits.map((h) => h && h.sourceId).filter(Boolean)));
    const createdMap = new Map();
    if (uniqueIds.length > 0) {
      try {
        const placeholders = uniqueIds.map(() => "?").join(",");
        const rows = store.db
          .prepare(`SELECT id, created_ts FROM sources WHERE id IN (${placeholders})`)
          .all(...uniqueIds);
        for (const row of rows) {
          createdMap.set(row.id, Number(row.created_ts));
        }
      } catch {}
    }
    const allowedHits = res.hits.filter((h) => {
      const ts = createdMap.get(h.sourceId);
      return ts === undefined || ts >= appStart;
    });
    const sliced = allowedHits.slice(0, 5);
    return {
      ...res,
      hits: sliced,
      totalMatches: allowedHits.length,
      returned: sliced.length,
      limit: 5
    };
  }
  return store.search({
    queries,
    sourceId: rawSourceId,
    sessionId: convId,
    scope: "session",
    limit: 5
  });
}

function handleExemptionsMutation(data, defaultConvId = "default") {
  const store = getRuntimeStore();
  const { scope, targetSid } = resolveTargetSession(data, defaultConvId);
  const action = data.action || "get";
  if (action === "toggleCategory" && data.category) {
    store.toggleExemptCategory(
      data.category,
      data.enabled !== undefined ? (data.enabled === true || data.enabled === "true" || data.enabled === "1") : null,
      targetSid
    );
  } else if (action === "setCategories" && Array.isArray(data.categories)) {
    store.setExemptCategories(data.categories, targetSid);
  } else if (action === "add" && data.ext) {
    store.addCustomExemptExtension(data.ext, targetSid);
  } else if (action === "remove" && data.ext) {
    store.removeCustomExemptExtension(data.ext, targetSid);
  } else if (action === "reset") {
    store.setExemptCategories(null, targetSid);
    store.setCustomExemptExtensions([], targetSid);
  } else if (action === "set" && Array.isArray(data.extensions)) {
    store.setExemptExtensions(data.extensions, targetSid);
  }
  return {
    ok: true,
    exemptCategories: store.getExemptCategories(targetSid),
    customExtensions: store.getCustomExemptExtensions(targetSid),
    exemptExtensions: store.getExemptExtensions(targetSid),
    scope,
    sessionId: targetSid
  };
}

function handleToggleActiveMutation(data, defaultConvId = "default") {
  const store = getRuntimeStore();
  const { scope, targetSid } = resolveTargetSession(data, defaultConvId);
  const current = store.isPaused(targetSid);
  const newPaused =
    data.paused !== undefined ? (data.paused === true || data.paused === "true" || data.paused === "1") : !current;
  const saved = store.setPaused(newPaused, targetSid);
  return { ok: true, isPaused: saved, scope, sessionId: targetSid };
}

function handlePurgeMutation(data, defaultConvId = "default") {
  const store = getRuntimeStore();
  const appStartTime = getAppStartTime();
  const { scope, convId } = resolveTargetSession(data, defaultConvId);
  if (scope === "lifetime" || scope === "all") {
    return store.purge({ scope: "all" });
  } else if (scope === "app" || scope === "session") {
    return store.purge({ scope: "app", sinceTs: appStartTime });
  }
  return store.purge({ scope: "session", sessionId: convId });
}

function handleMaintenanceMutation(data) {
  const store = getRuntimeStore();
  const action = data.action || "prune";
  const maxAgeDays = parseSafeMaxAgeDays(data.maxAgeDays, 14);
  const vacuum = action === "vacuum" || data.vacuum === true || data.vacuum === "true" || data.vacuum === "1";
  return store.pruneByTtl({ maxAgeDays, vacuum });
}

function handleFeatureToggleMutation(isCli, data, defaultConvId = "default") {
  const store = getRuntimeStore();
  const { scope, targetSid } = resolveTargetSession(data, defaultConvId);
  const cur = isCli ? store.isCliFilterEnabled(targetSid) : store.isReadDedupEnabled(targetSid);
  const next = data.enabled !== undefined ? (data.enabled === true || data.enabled === "true" || data.enabled === "1") : !cur;
  const saved = isCli ? store.setCliFilterEnabled(next, targetSid) : store.setReadDedupEnabled(next, targetSid);
  return { ok: true, [isCli ? "cliFilterEnabled" : "readDedupEnabled"]: saved, scope, sessionId: targetSid };
}

const STAR_PROMPT_ALLOWED_KEYS = new Set(["state"]);
const STAR_PROMPT_ALLOWED_STATES = new Set(["clicked", "dismissed", "copied_cli"]);

function handleStarPromptMutation(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, status: 400, error: "Request body must be a JSON object" };
  }
  for (const key of Object.keys(data)) {
    if (!STAR_PROMPT_ALLOWED_KEYS.has(key)) {
      return { ok: false, status: 400, error: `Unexpected field '${key}' in request body` };
    }
  }
  if (typeof data.state !== "string" || !STAR_PROMPT_ALLOWED_STATES.has(data.state)) {
    return {
      ok: false,
      status: 400,
      error: "Invalid 'state' value: expected 'clicked', 'dismissed', or 'copied_cli'"
    };
  }
  const store = getRuntimeStore();
  const res = store.setStarPromptState(data.state);
  if (!res.ok) {
    return { ok: false, status: 400, error: res.error };
  }
  return { ok: true, starPrompt: store.evaluateStarPrompt({ markTriggered: false }) };
}

function sendJson(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  res.end(JSON.stringify(payload));
}

const READ_ENDPOINTS = new Set([
  "/api/stats",
  "/api/doctor",
  "/api/resume",
  "/api/source-chunks",
  "/api/cache-diag",
  "/api/handoff",
  "/api/watchdog"
]);

const MUTATING_ENDPOINTS = new Set([
  "/api/cutoff",
  "/api/exemptions",
  "/api/toggle-active",
  "/api/paused",
  "/api/purge",
  "/api/maintenance",
  "/api/cli-filter",
  "/api/read-dedup",
  "/api/watchdog/action",
  "/api/star-prompt"
]);

export function createStandaloneServer({
  csrfToken = crypto.randomBytes(24).toString("hex"),
  maxBodyBytes = MAX_REQUEST_BODY_BYTES,
  watchdogOptions = null
} = {}) {
  getRuntimeStore();
  const monitor = getWatchdogMonitor(watchdogOptions || {});
  monitor.start();
  const srv = http.createServer(async (req, res) => {
    try {
      // 1. Anti-DNS-rebinding Host validation & anti-CSRF Origin/Sec-Fetch-Site validation
      if (!isAllowedHostHeader(req.headers.host)) {
        sendJson(res, 403, { error: "Forbidden host header" });
        return;
      }

      let url;
      try {
        url = new URL(req.url, `http://${req.headers.host}`);
      } catch {
        sendJson(res, 400, { error: "Invalid request URL" });
        return;
      }

      const isHtmlEntry = req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html");
      const isPreloadStub = req.method === "GET" && url.pathname === "/preload.js";
      if (
        !isAllowedOriginHeader(req.headers.origin, req.headers.host) ||
        !isAllowedRefererHeader(req.headers.referer, req.headers.host) ||
        isCrossSiteFetchHeader(req.headers["sec-fetch-site"], { allowSameSite: isHtmlEntry || isPreloadStub })
      ) {
        sendJson(res, 403, { error: "Cross-origin request blocked" });
        return;
      }

      if (isPreloadStub) {
        res.writeHead(200, {
          "Content-Type": "application/javascript; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store"
        });
        res.end("/* standalone http mode */\n");
        return;
      }

      if (isHtmlEntry) {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
          "Content-Security-Policy": "frame-ancestors 'none'",
          "Cache-Control": "no-store"
        });
        res.end(getRenderedHtml(csrfToken));
        return;
      }

      // 2. Enforce POST-only method semantics on /api/search and mutating endpoints first
      //    so cross-site <img> GET attacks explicitly return 405 Method Not Allowed (Allow: POST).
      if ((url.pathname === "/api/search" || MUTATING_ENDPOINTS.has(url.pathname)) && req.method !== "POST") {
        sendJson(
          res,
          405,
          {
            error:
              url.pathname === "/api/search"
                ? "Method Not Allowed: use POST with application/json"
                : "Method Not Allowed: mutating endpoints require POST"
          },
          { Allow: "POST" }
        );
        return;
      }

      // 3. Require per-server random X-Agy-Dart-Token on EVERY standalone /api/* endpoint (GET and POST)
      if (url.pathname.startsWith("/api/")) {
        if (!timingSafeTokenMatch(req.headers["x-agy-dart-token"], csrfToken)) {
          sendJson(res, 403, { error: "Invalid or missing X-Agy-Dart-Token" });
          return;
        }
      }

      // 4. Authenticated read-only API endpoints (POST JSON used by UI + authenticated GET with X-Agy-Dart-Token)
      if (READ_ENDPOINTS.has(url.pathname)) {
        if (req.method !== "GET" && req.method !== "POST") {
          sendJson(res, 405, { error: "Method Not Allowed: use POST with application/json" }, { Allow: "POST, GET" });
          return;
        }
        let data = Object.fromEntries(url.searchParams.entries());
        if (req.method === "POST") {
          if (!isJsonContentType(req.headers["content-type"])) {
            sendJson(res, 415, { error: "Content-Type must be application/json" });
            return;
          }
          const parsed = await readBoundedJsonBody(req, maxBodyBytes);
          if (!parsed.ok) {
            sendJson(res, parsed.status, { error: parsed.error });
            return;
          }
          data = { ...data, ...parsed.data };
        }
        const fieldCheck = validateStringFields(data, ["scope", "conversationId", "stallConversationId", "sessionId", "sourceId", "cwd"]);
        if (!fieldCheck.ok) {
          sendJson(res, 400, { error: fieldCheck.error });
          return;
        }
        if (url.pathname === "/api/stats") {
          sendJson(res, 200, getStatsPayload(data));
          return;
        }
        if (url.pathname === "/api/doctor") {
          sendJson(res, 200, getRuntimeStore().doctor());
          return;
        }
        if (url.pathname === "/api/resume") {
          for (const bf of ["fromSidecarHost", "conversationConfirmed"]) {
            const bCheck = validateOptionalBooleanField(data, bf);
            if (!bCheck.ok) {
              sendJson(res, 400, { error: bCheck.error });
              return;
            }
          }
          sendJson(res, 200, getResumePayload(data));
          return;
        }
        if (url.pathname === "/api/source-chunks") {
          sendJson(res, 200, getSourceChunksPayload(data));
          return;
        }
        if (url.pathname === "/api/cache-diag") {
          if (data.fromSidecarHost !== undefined && typeof data.fromSidecarHost !== "boolean") {
            sendJson(res, 400, { error: "Field 'fromSidecarHost' must be a boolean" });
            return;
          }
          sendJson(res, 200, getCacheDiagPayload(data));
          return;
        }
        if (url.pathname === "/api/handoff") {
          for (const bf of ["fromSidecarHost", "conversationConfirmed"]) {
            const bCheck = validateOptionalBooleanField(data, bf);
            if (!bCheck.ok) {
              sendJson(res, 400, { error: bCheck.error });
              return;
            }
          }
          const modeCheck = validateHandoffMode(data.mode, { allowAgent: req.method === "POST" });
          if (!modeCheck.ok) {
            sendJson(res, 400, { error: modeCheck.error });
            return;
          }
          sendJson(res, 200, getHandoffPayload({ ...data, mode: modeCheck.mode }));
          return;
        }
        if (url.pathname === "/api/watchdog") {
          for (const bf of ["fromSidecarHost", "conversationConfirmed"]) {
            const bCheck = validateOptionalBooleanField(data, bf);
            if (!bCheck.ok) {
              sendJson(res, 400, { error: bCheck.error });
              return;
            }
          }
          sendJson(res, 200, getWatchdogPayload(data));
          return;
        }
      }

      // 5. POST-only /api/search (authenticated read-only FTS5 query, bounded JSON body)
      if (url.pathname === "/api/search") {
        if (!isJsonContentType(req.headers["content-type"])) {
          sendJson(res, 415, { error: "Content-Type must be application/json" });
          return;
        }
        const parsed = await readBoundedJsonBody(req, maxBodyBytes);
        if (!parsed.ok) {
          sendJson(res, parsed.status, { error: parsed.error });
          return;
        }
        const searchCheck = validateAndNormalizeSearchInput(parsed.data);
        if (!searchCheck.ok) {
          sendJson(res, 400, { error: searchCheck.error });
          return;
        }
        const searchFieldCheck = validateStringFields(parsed.data, ["sourceId", "conversationId", "sessionId", "scope"]);
        if (!searchFieldCheck.ok) {
          sendJson(res, 400, { error: searchFieldCheck.error });
          return;
        }
        sendJson(res, 200, handleSearchPayload(parsed.data, searchCheck.queries));
        return;
      }

      // 6. Mutating endpoints: strictly POST + application/json + per-server CSRF token + <= 64 KB body
      if (MUTATING_ENDPOINTS.has(url.pathname)) {
        if (!isJsonContentType(req.headers["content-type"])) {
          sendJson(res, 415, { error: "Content-Type must be application/json" });
          return;
        }
        const parsed = await readBoundedJsonBody(req, maxBodyBytes);
        if (!parsed.ok) {
          sendJson(res, parsed.status, { error: parsed.error });
          return;
        }
        const data = parsed.data;
        const mutFieldCheck = validateStringFields(data, [
          "scope",
          "conversationId",
          "sessionId",
          "action",
          "category",
          "ext",
          "jumpId"
        ]);
        if (!mutFieldCheck.ok) {
          sendJson(res, 400, { error: mutFieldCheck.error });
          return;
        }
        if (url.pathname === "/api/cutoff") {
          const cutoffRes = handleCutoffMutation(data);
          if (cutoffRes.ok === false && cutoffRes.status) {
            sendJson(res, cutoffRes.status, { error: cutoffRes.error });
          } else {
            sendJson(res, 200, cutoffRes);
          }
        } else if (url.pathname === "/api/toggle-active" || url.pathname === "/api/paused") {
          sendJson(res, 200, handleToggleActiveMutation(data));
        } else if (url.pathname === "/api/exemptions") {
          sendJson(res, 200, handleExemptionsMutation(data));
        } else if (url.pathname === "/api/purge") {
          sendJson(res, 200, handlePurgeMutation(data));
        } else if (url.pathname === "/api/maintenance") {
          sendJson(res, 200, handleMaintenanceMutation(data));
        } else if (url.pathname === "/api/cli-filter" || url.pathname === "/api/read-dedup") {
          sendJson(res, 200, handleFeatureToggleMutation(url.pathname === "/api/cli-filter", data));
        } else if (url.pathname === "/api/watchdog/action") {
          const wdRes = handleWatchdogActionMutation(data);
          if (wdRes.ok === false && wdRes.status) {
            sendJson(res, wdRes.status, { error: wdRes.error });
          } else {
            sendJson(res, 200, wdRes);
          }
        } else if (url.pathname === "/api/star-prompt") {
          const spRes = handleStarPromptMutation(data);
          if (spRes.ok === false && spRes.status) {
            sendJson(res, spRes.status, { error: spRes.error });
          } else {
            sendJson(res, 200, spRes);
          }
        }
        return;
      }

      res.writeHead(404, { "X-Content-Type-Options": "nosniff" });
      res.end("Not Found");
    } catch {
      if (!res.headersSent) {
        sendJson(res, 500, { error: "Internal server error" });
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });
  srv.on("close", () => {
    closeRuntimeStore();
  });
  return srv;
}

if (isDirectRun) {
  let SidecarApp = null;
  let SidecarResponse = null;

  try {
    const userSdkPath = path.join(os.homedir(), ".gemini", "config", "node_modules", "sidecar_sdk", "index.mjs");
    const sdkModule = await import(pathToFileURL(userSdkPath).href);
    SidecarApp = sdkModule.SidecarApp;
    SidecarResponse = sdkModule.Response || null;
  } catch {
    try {
      const sdkModule = await import("sidecar_sdk");
      SidecarApp = sdkModule.SidecarApp;
      SidecarResponse = sdkModule.Response || null;
    } catch {
      // Standalone fallback
    }
  }

  const isSidecarEnv = shouldUseSidecarApp(process.env, Boolean(SidecarApp));

  if (
    !isSidecarEnv &&
    SidecarApp &&
    typeof process.env.ANTIGRAVITY_LS_ADDRESS === "string" && process.env.ANTIGRAVITY_LS_ADDRESS.trim() &&
    typeof process.env.ANTIGRAVITY_CSRF_TOKEN === "string" && process.env.ANTIGRAVITY_CSRF_TOKEN.trim() &&
    typeof process.env.ANTIGRAVITY_SIDECAR_WEB_PORT === "string" && process.env.ANTIGRAVITY_SIDECAR_WEB_PORT.trim() &&
    process.env.SIDECAR_FORCE_HTTP !== "1" &&
    !(typeof process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN === "string" && process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN.trim())
  ) {
    console.error(
      "[agy-dart sidecar] ANTIGRAVITY_SIDECAR_UI_TOKEN is missing/empty; refusing fail-open SidecarApp mode and falling back to authenticated standalone HTTP server."
    );
  }

  if (isSidecarEnv) {
    const extraWatchFile =
      typeof process.env.AGY_DART_SIDECAR_WATCH_FILE === "string" && process.env.AGY_DART_SIDECAR_WATCH_FILE.trim()
        ? [path.resolve(process.env.AGY_DART_SIDECAR_WATCH_FILE.trim())]
        : [];
    const watchedBackendFiles = [
      __selfPath,
      path.resolve(__dirname, "../../context/lib/handoff.js"),
      path.resolve(__dirname, "../../context/lib/watchdog.js"),
      path.resolve(__dirname, "../../context/lib/watchdog-lease.js"),
      path.resolve(__dirname, "../../context/lib/store.js"),
      path.resolve(__dirname, "../../context/lib/store/settings-maintenance.js"),
      path.resolve(__dirname, "../../context/lib/cache-analyzer.js"),
      path.resolve(__dirname, "../../context/lib/config.js"),
      ...extraWatchFile
    ];
    const snapshotSidecarMtimes = () =>
      watchedBackendFiles
        .map((fp) => {
          try {
            return Math.round(fs.statSync(fp).mtimeMs);
          } catch {
            return 0;
          }
        })
        .join("|");

    getRuntimeStore();
    const app = new SidecarApp();
    const monitor = getWatchdogMonitor({
      keepaliveSendFn: ({ conversationId, message }) => sendSidecarKeepaliveMessage(conversationId, message)
    });
    monitor.start();

    let shuttingDown = false;
    const shutdownCleanly = async (code = 0) => {
      if (shuttingDown) return;
      shuttingDown = true;
      closeRuntimeStore();
      try {
        await app.close?.();
      } catch {}
      process.exit(code);
    };
    process.once("SIGTERM", () => {
      void shutdownCleanly(0);
    });
    process.once("SIGINT", () => {
      void shutdownCleanly(0);
    });

    if (process.env.AGY_DART_DISABLE_SIDECAR_AUTORELOAD !== "1") {
      const bootMtimeSig = snapshotSidecarMtimes();
      const rawPoll = Number(process.env.AGY_DART_SIDECAR_RELOAD_POLL_MS);
      const reloadPollMs = Number.isFinite(rawPoll) && rawPoll >= 150 ? Math.floor(rawPoll) : 3000;
      const reloadTimer = setInterval(() => {
        if (shuttingDown) return;
        if (monitor._keepaliveInFlight && monitor._keepaliveInFlight.size > 0) return;
        const nextSig = snapshotSidecarMtimes();
        if (nextSig !== bootMtimeSig && !nextSig.split("|").includes("0")) {
          clearInterval(reloadTimer);
          // sidecar.json configures `"restart_policy": "always"`, so exiting 0 lets
          // Antigravity's language_server respawn server.mjs with updated ESM code automatically.
          void shutdownCleanly(0);
        }
      }, reloadPollMs);
      reloadTimer.unref?.();
    }

    const makeBadRequest = (error) =>
      SidecarResponse
        ? new SidecarResponse(JSON.stringify({ error }), { contentType: "application/json", status: 400 })
        : { ok: false, error };

    app.page("/", () => {
      const html = getRenderedHtml(SIDECAR_CSRF_TOKEN);
      if (SidecarResponse) {
        return new SidecarResponse(html, {
          contentType: "text/html; charset=utf-8",
          status: 200,
          headers: {
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff"
          }
        });
      }
      return html;
    });

    registerSidecarRoutes(app);

    await app.run();
    console.log(`[agy-dart sidecar] registered and running`);
  } else {
    const port = resolveStandalonePort(process.env);
    const server = createStandaloneServer({
      watchdogOptions: {
        keepaliveSendFn: ({ conversationId, message }) => sendSidecarKeepaliveMessage(conversationId, message)
      }
    });
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const boundPort = typeof addr === "object" && addr ? addr.port : port;
      console.log(`[agy-dart dashboard] standalone server listening at http://127.0.0.1:${boundPort}`);
    });
  }
}

export function registerSidecarRoutes(app) {
  const makeBadRequest = (msg) => {
    const err = new Error(msg);
    err.statusCode = 400;
    return { ok: false, status: 400, error: msg };
  };
  const normalizeSidecarBody = (raw) => {
    if (raw === undefined) return {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    return raw;
  };

  // ALL /api/* routes are POST-only in SidecarApp mode because sidecar_sdk only enforces
  // X-Sidecar-Token validation for non-GET requests (blocks unauthenticated GET / DNS-rebinding reads).
  app.api("/api/stats", (rawData) => {
    const data = normalizeSidecarBody(rawData);
    if (!data) return makeBadRequest("Request body must be a JSON object");
    const check = validateStringFields(data, ["scope", "conversationId", "sessionId"]);
    if (!check.ok) return makeBadRequest(check.error);
    return getStatsPayload(data, app.config?.conversationId);
  }, "POST");
  app.api("/api/doctor", (rawData) => {
    if (rawData !== undefined && normalizeSidecarBody(rawData) === null) {
      return makeBadRequest("Request body must be a JSON object");
    }
    return getRuntimeStore().doctor();
  }, "POST");
  app.api("/api/resume", (rawData) => {
    const data = normalizeSidecarBody(rawData);
    if (!data) return makeBadRequest("Request body must be a JSON object");
    const check = validateStringFields(data, ["scope", "conversationId", "sessionId"]);
    if (!check.ok) return makeBadRequest(check.error);
    for (const bf of ["fromSidecarHost", "conversationConfirmed"]) {
      const bCheck = validateOptionalBooleanField(data, bf);
      if (!bCheck.ok) return makeBadRequest(bCheck.error);
    }
    return getResumePayload(data, app.config?.conversationId);
  }, "POST");
  app.api("/api/source-chunks", (rawData) => {
    const data = normalizeSidecarBody(rawData);
    if (!data) return makeBadRequest("Request body must be a JSON object");
    const check = validateStringFields(data, ["sourceId"]);
    if (!check.ok) return makeBadRequest(check.error);
    return getSourceChunksPayload(data);
  }, "POST");
  app.api("/api/cache-diag", (rawData) => {
    const data = normalizeSidecarBody(rawData);
    if (!data) return makeBadRequest("Request body must be a JSON object");
    const check = validateStringFields(data, ["scope", "conversationId", "sessionId"]);
    if (!check.ok) return makeBadRequest(check.error);
    if (data.fromSidecarHost !== undefined && typeof data.fromSidecarHost !== "boolean") {
      return makeBadRequest("Field 'fromSidecarHost' must be a boolean");
    }
    return getCacheDiagPayload(data, app.config?.conversationId);
  }, "POST");
  app.api("/api/handoff", (rawData) => {
    const data = normalizeSidecarBody(rawData);
    if (!data) return makeBadRequest("Request body must be a JSON object");
    const check = validateStringFields(data, ["scope", "conversationId", "stallConversationId", "sessionId", "cwd"]);
    if (!check.ok) return makeBadRequest(check.error);
    for (const bf of ["fromSidecarHost", "conversationConfirmed"]) {
      const bCheck = validateOptionalBooleanField(data, bf);
      if (!bCheck.ok) return makeBadRequest(bCheck.error);
    }
    const modeCheck = validateHandoffMode(data.mode, { allowAgent: true });
    if (!modeCheck.ok) return makeBadRequest(modeCheck.error);
    return getHandoffPayload({ ...data, mode: modeCheck.mode }, app.config?.conversationId);
  }, "POST");
  app.api("/api/search", (rawData) => {
    const data = normalizeSidecarBody(rawData);
    if (!data) return makeBadRequest("Request body must be a JSON object");
    const searchCheck = validateAndNormalizeSearchInput(data);
    if (!searchCheck.ok) return makeBadRequest(searchCheck.error);
    const fieldCheck = validateStringFields(data, ["sourceId", "conversationId", "sessionId", "scope"]);
    if (!fieldCheck.ok) return makeBadRequest(fieldCheck.error);
    return handleSearchPayload(data, searchCheck.queries, app.config?.conversationId);
  }, "POST");
  app.api("/api/cutoff", (rawData) => {
    const data = normalizeSidecarBody(rawData);
    if (!data) return makeBadRequest("Request body must be a JSON object");
    const check = validateStringFields(data, ["scope", "conversationId", "sessionId"]);
    if (!check.ok) return makeBadRequest(check.error);
    const res = handleCutoffMutation(data, app.config?.conversationId);
    if (res.ok === false) return makeBadRequest(res.error);
    return res;
  }, "POST");
  app.api("/api/exemptions", (rawData) => {
    const data = normalizeSidecarBody(rawData);
    if (!data) return makeBadRequest("Request body must be a JSON object");
    const check = validateStringFields(data, ["scope", "conversationId", "sessionId", "action", "category", "ext"]);
    if (!check.ok) return makeBadRequest(check.error);
    return handleExemptionsMutation(data, app.config?.conversationId);
  }, "POST");
  app.api("/api/toggle-active", (rawData) => {
    const data = normalizeSidecarBody(rawData);
    if (!data) return makeBadRequest("Request body must be a JSON object");
    const check = validateStringFields(data, ["scope", "conversationId", "sessionId"]);
    if (!check.ok) return makeBadRequest(check.error);
    return handleToggleActiveMutation(data, app.config?.conversationId);
  }, "POST");
  app.api("/api/paused", (rawData) => {
    const data = normalizeSidecarBody(rawData);
    if (!data) return makeBadRequest("Request body must be a JSON object");
    const check = validateStringFields(data, ["scope", "conversationId", "sessionId"]);
    if (!check.ok) return makeBadRequest(check.error);
    return handleToggleActiveMutation(data, app.config?.conversationId);
  }, "POST");
  app.api("/api/purge", (rawData) => {
    const data = normalizeSidecarBody(rawData);
    if (!data) return makeBadRequest("Request body must be a JSON object");
    const check = validateStringFields(data, ["scope", "conversationId", "sessionId"]);
    if (!check.ok) return makeBadRequest(check.error);
    return handlePurgeMutation(data, app.config?.conversationId);
  }, "POST");
  app.api("/api/maintenance", (rawData) => {
    const data = normalizeSidecarBody(rawData);
    if (!data) return makeBadRequest("Request body must be a JSON object");
    return handleMaintenanceMutation(data);
  }, "POST");
  app.api("/api/cli-filter", (rawData) => {
    const data = normalizeSidecarBody(rawData);
    if (!data) return makeBadRequest("Request body must be a JSON object");
    const check = validateStringFields(data, ["scope", "conversationId", "sessionId"]);
    if (!check.ok) return makeBadRequest(check.error);
    return handleFeatureToggleMutation(true, data, app.config?.conversationId);
  }, "POST");
  app.api("/api/read-dedup", (rawData) => {
    const data = normalizeSidecarBody(rawData);
    if (!data) return makeBadRequest("Request body must be a JSON object");
    const check = validateStringFields(data, ["scope", "conversationId", "sessionId"]);
    if (!check.ok) return makeBadRequest(check.error);
    return handleFeatureToggleMutation(false, data, app.config?.conversationId);
  }, "POST");
  app.api("/api/watchdog", (rawData) => {
    const data = normalizeSidecarBody(rawData);
    if (!data) return makeBadRequest("Request body must be a JSON object");
    const check = validateStringFields(data, ["scope", "conversationId", "sessionId"]);
    if (!check.ok) return makeBadRequest(check.error);
    for (const bf of ["fromSidecarHost", "conversationConfirmed"]) {
      const bCheck = validateOptionalBooleanField(data, bf);
      if (!bCheck.ok) return makeBadRequest(bCheck.error);
    }
    return getWatchdogPayload(data, app.config?.conversationId);
  }, "POST");
  app.api("/api/watchdog/action", (rawData) => {
    const data = normalizeSidecarBody(rawData);
    if (!data) return makeBadRequest("Request body must be a JSON object");
    const check = validateStringFields(data, ["scope", "conversationId", "sessionId", "action", "jumpId"]);
    if (!check.ok) return makeBadRequest(check.error);
    const res = handleWatchdogActionMutation(data, app.config?.conversationId);
    if (res.ok === false) return makeBadRequest(res.error);
    return res;
  }, "POST");
  app.api("/api/star-prompt", (rawData) => {
    const data = normalizeSidecarBody(rawData);
    if (!data) return makeBadRequest("Request body must be a JSON object");
    const res = handleStarPromptMutation(data);
    if (res.ok === false) return makeBadRequest(res.error);
    return res;
  }, "POST");
}
