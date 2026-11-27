#!/usr/bin/env node
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { enableVersionedCompileCache } from "../hooks/compile-cache.mjs";

try {
  enableVersionedCompileCache();
} catch {}

const [{ stableSortObject }, { ContextModeStore }, { createTools, normalizeSessionId }, { getEffectiveConfig }, handoffMod] = await Promise.all([
  import("./lib/stable-json.js"),
  import("./lib/store.js"),
  import("./lib/tools.js"),
  import("./lib/config.js"),
  import("./lib/handoff.js").catch(() => ({}))
]);
const inferWorkspaceFromStore =
  typeof handoffMod?.inferWorkspaceFromStore === "function" ? handoffMod.inferWorkspaceFromStore : null;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..");
const IS_INSTALLED_PLUGIN_COPY = !fs.existsSync(path.join(PLUGIN_ROOT, ".git"));
let pkgVersion = "1.6.0";
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "package.json"), "utf8"));
  if (pkg.version) pkgVersion = pkg.version;
} catch {}

const INSTALLED_PLUGIN_PATH_RE =
  /\/(?:\.gemini\/(?:config|antigravity)\/plugins|\.agents\/plugins|\.t3\/userdata\/providers\/antigravity\/[^/]+\/(?:\.gemini\/config\/)?plugins)\/agy-dart(?:\/|$)/i;

function normalizeCompareDir(dirPath) {
  let resolved = path.resolve(String(dirPath || ""));
  try {
    resolved = fs.realpathSync(resolved);
  } catch {}
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isSameOrSubDir(candidateNorm, parentNorm) {
  if (!candidateNorm || !parentNorm) return false;
  const rel = path.relative(parentNorm, candidateNorm);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !rel.startsWith("../") && !path.isAbsolute(rel))
  );
}

const PLUGIN_ROOT_NORM = normalizeCompareDir(PLUGIN_ROOT);

function isInsideInstalledPluginDir(candidateDir) {
  if (typeof candidateDir !== "string" || !candidateDir.trim()) return false;
  const candNorm = normalizeCompareDir(candidateDir);
  const candPosix = candNorm.replace(/\\/g, "/");
  if (INSTALLED_PLUGIN_PATH_RE.test(candPosix)) return true;
  for (const envVar of [process.env.PLUGIN_ROOT, process.env.AGY_PLUGIN_ROOT]) {
    if (typeof envVar === "string" && envVar.trim()) {
      if (isSameOrSubDir(candNorm, normalizeCompareDir(envVar.trim()))) return true;
    }
  }
  if (IS_INSTALLED_PLUGIN_COPY && isSameOrSubDir(candNorm, PLUGIN_ROOT_NORM)) {
    return true;
  }
  return false;
}

function resolveDirectoryCandidate(raw) {
  if (typeof raw !== "string") return null;
  let candidate = raw.trim();
  if (!candidate) return null;
  if (/^file:\/\//i.test(candidate)) {
    try {
      candidate = fileURLToPath(candidate);
    } catch {
      return null;
    }
  }
  if (candidate === "~") {
    candidate = os.homedir();
  } else if (candidate.startsWith("~/") || candidate.startsWith("~\\")) {
    candidate = path.join(os.homedir(), candidate.slice(2));
  }
  try {
    const abs = path.resolve(candidate);
    if (fs.statSync(abs).isDirectory()) return abs;
  } catch {}
  return null;
}

function resolveConfiguredWorkspace() {
  try {
    const cfgDir = resolveDirectoryCandidate(getEffectiveConfig().defaultCwd);
    if (cfgDir && !isInsideInstalledPluginDir(cfgDir)) return cfgDir;
  } catch {}
  return null;
}

function resolveRootsTimeoutCtx(defaultMs) {
  const raw = process.env.AGY_DART_ROOTS_TIMEOUT_MS;
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw.trim());
    if (Number.isFinite(n) && n >= 50 && n <= 15000) return Math.floor(n);
  }
  return defaultMs;
}

function resolveSingleWorkspace(candidates) {
  const roots = new Map();
  for (const raw of candidates) {
    const dir = resolveDirectoryCandidate(raw);
    if (dir && !isInsideInstalledPluginDir(dir)) roots.set(normalizeCompareDir(dir), dir);
  }
  return roots.size === 1 ? roots.values().next().value : null;
}

function isExplicitAbsoluteCwdArg(raw) {
  if (typeof raw !== "string") return false;
  let s = raw.trim();
  while (s.length >= 2) {
    const q = s[0];
    if ((q === '"' || q === "'") && s[s.length - 1] === q) {
      const inner = s.slice(1, -1);
      if (inner.includes(q)) break;
      s = inner.trim();
      continue;
    }
    break;
  }
  if (!s) return false;
  if (/^file:\/\//i.test(s)) {
    try {
      return path.isAbsolute(fileURLToPath(s));
    } catch {
      return false;
    }
  }
  if (
    s === "~" ||
    s.startsWith("~/") ||
    s.startsWith("~\\") ||
    /^(?:\$\{(?:env:)?(?:TMPDIR|TEMP|TMP|HOME|USERPROFILE|LOCALAPPDATA)\}|\$(?:env:)?(?:TMPDIR|TEMP|TMP|HOME|USERPROFILE|LOCALAPPDATA)|%(?:TEMP|TMP|HOME|USERPROFILE|LOCALAPPDATA)%)(?=$|[\\/])/i.test(s)
  ) {
    return true;
  }
  return path.isAbsolute(s);
}

const store = new ContextModeStore();
const envWorkspaceDir = resolveDirectoryCandidate(process.env.ANTIGRAVITY_WORKSPACE_ROOT);
// VS Code may launch several projects from the same directory. It is a path
// hint for a known conversation, never the owner of anonymous project data.
const launchCwd = resolveDirectoryCandidate(process.env.VSCODE_CWD) || process.cwd();
let currentCwd = envWorkspaceDir || launchCwd;
let explicitWorkspaceConfigured = Boolean(envWorkspaceDir && !isInsideInstalledPluginDir(envWorkspaceDir));
let clientSupportsRoots = false;
let cachedRootsDir = null;
let rootsQueried = false;
let rootsUnsupported = false;
let rootsTimeoutCount = 0;
let rootsRetryAfterMs = 0;
let rootsEpoch = 0;
let inFlightRootsPromise = null;
let nextRootsReqSeq = 1;
const pendingClientRequests = new Map();
let initSessionId = null;
const callContext = new AsyncLocalStorage();

function resolveHostSessionId() {
  return (
    callContext.getStore()?.sessionId ||
    initSessionId ||
    normalizeSessionId(process.env.ANTIGRAVITY_ROOT_CONVERSATION_ID) ||
    normalizeSessionId(process.env.ANTIGRAVITY_PARENT_CONVERSATION_ID) ||
    normalizeSessionId(process.env.ANTIGRAVITY_CONVERSATION_ID) ||
    normalizeSessionId(process.env.CONVERSATION_ID)
  );
}

function resolveDirectConversationIdForCall() {
  return (
    callContext.getStore()?.directConversationId ||
    callContext.getStore()?.sessionId ||
    initSessionId ||
    normalizeSessionId(process.env.ANTIGRAVITY_CONVERSATION_ID) ||
    normalizeSessionId(process.env.CONVERSATION_ID)
  );
}

function resolveActiveWorkspaceState() {
  if (explicitWorkspaceConfigured) {
    return { cwd: currentCwd, confirmed: true, located: true };
  }
  if (cachedRootsDir) {
    return { cwd: cachedRootsDir, confirmed: true, located: true };
  }
  const insidePlugin = isInsideInstalledPluginDir(currentCwd);
  const hostSessionId = resolveHostSessionId();
  const directConvId = resolveDirectConversationIdForCall();
  const hasExistingStore = Boolean(store.db || fs.existsSync(store.dbPath));
  if (insidePlugin && (hostSessionId || directConvId)) {
    if (hasExistingStore && typeof store.resolveSessionWorkspace === "function") {
      const sessDir = store.resolveSessionWorkspace([directConvId, hostSessionId], {
        pluginRootNorm: PLUGIN_ROOT_NORM
      });
      if (sessDir && !isInsideInstalledPluginDir(sessDir)) {
        return { cwd: sessDir, confirmed: true, located: true };
      }
    }
    if (hostSessionId && inferWorkspaceFromStore) {
      const inferred = inferWorkspaceFromStore(store, hostSessionId);
      if (inferred && !isInsideInstalledPluginDir(inferred)) {
        return { cwd: inferred, confirmed: true, located: true };
      }
    }
  }
  const configuredDir = resolveConfiguredWorkspace();
  if (configuredDir) {
    return { cwd: configuredDir, confirmed: true, located: true };
  }
  if (
    insidePlugin &&
    !hostSessionId &&
    !directConvId &&
    hasExistingStore &&
    typeof store.resolveUniqueActiveWorkspace === "function"
  ) {
    const activeRes = store.resolveUniqueActiveWorkspace({ pluginRootNorm: PLUGIN_ROOT_NORM });
    if (activeRes.status === "unique" && activeRes.dir && !isInsideInstalledPluginDir(activeRes.dir)) {
      return { cwd: activeRes.dir, confirmed: true, located: true };
    }
    if (activeRes.status === "ambiguous") {
      return { cwd: currentCwd, confirmed: false, ambiguousDirs: activeRes.dirs };
    }
  }
  return { cwd: currentCwd, confirmed: !insidePlugin && Boolean(hostSessionId) };
}

function resolveActiveWorkspaceCwd() {
  return resolveActiveWorkspaceState().cwd;
}

const adoptedWorkspaces = new Set();

function resolveSessionIdForCall(cwd, { optional = false } = {}) {
  const hostSessionId = resolveHostSessionId();
  if (hostSessionId) {
    try {
      return typeof store.resolveRootSessionId === "function"
        ? store.resolveRootSessionId(hostSessionId)
        : hostSessionId;
    } catch {
      return hostSessionId;
    }
  }
  const wsState = resolveActiveWorkspaceState();
  const located =
    explicitWorkspaceConfigured ||
    cachedRootsDir ||
    callContext.getStore()?.explicitPath ||
    Boolean(wsState?.located && normalizeCompareDir(wsState.cwd) === normalizeCompareDir(cwd));
  if (!located || !handoffMod.isSafeWorkspaceDir?.(cwd) || isInsideInstalledPluginDir(cwd)) {
    if (optional) return null;
    throw new Error("Workspace root could not be determined for anonymous session data. Pass the active workspace absolute path in 'cwd'.");
  }
  const canonicalDir = fs.realpathSync.native(cwd);
  const id = "workspace:" + createHash("sha256").update(canonicalDir).digest("hex");
  if (!adoptedWorkspaces.has(cwd)) {
    store.adoptLegacyWorkspaceData(cwd, id);
    adoptedWorkspaces.add(cwd);
  }
  return id;
}

const tools = createTools({
  store,
  getCwd: resolveActiveWorkspaceCwd,
  getWorkspaceState: resolveActiveWorkspaceState,
  getSessionId: resolveSessionIdForCall,
  getDirectConversationId: () =>
    callContext.getStore()?.directConversationId ||
    callContext.getStore()?.sessionId ||
    initSessionId ||
    normalizeSessionId(process.env.ANTIGRAVITY_CONVERSATION_ID) ||
    normalizeSessionId(process.env.CONVERSATION_ID)
});

// Deterministic, compact Turn-0 tool schemas (keeps server KV-cache prefix lean and stable)
const RAW_TOOL_DEFINITIONS = [
  {
    name: "ctx_batch",
    description: "Run shell commands in order. Index output and return a preview or query hits.",
    inputSchema: {
      type: "object",
      properties: {
        commands: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
        queries: { type: "array", items: { type: "string" } }
      },
      required: ["commands"]
    }
  },
  {
    name: "ctx_doctor",
    description: "Check database, settings and runtime health.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" }
      }
    }
  },
  {
    name: "ctx_execute",
    description: "Filter large data with code. Return a preview and index the output. Give intent first. For >5 lines use a conversation scratch dir (or OS temp) and pass file + args.",
    inputSchema: {
      type: "object",
      properties: {
        intent: { type: "string" },
        language: { type: "string", enum: ["javascript", "nodejs", "python", "shell", "powershell", "cmd"] },
        code: { type: "string" },
        file: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
        sessionId: { type: "string" },
        timeoutSec: { type: "integer", minimum: 1, maximum: 300 }
      }
    }
  },
  {
    name: "ctx_index",
    description: "Index a file, URL or text for ctx_search.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        path: { type: "string" },
        url: { type: "string" },
        content: { type: "string" },
        label: { type: "string" }
      }
    }
  },
  {
    name: "ctx_purge",
    description: "Delete indexed data in scope (default: session).",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        scope: { type: "string", enum: ["session", "worktree", "all", "stale"] },
        sessionId: { type: "string" },
        olderThanDays: { type: "integer" },
        vacuum: { type: "boolean" }
      }
    }
  },
  {
    name: "ctx_resume",
    description: "Recover session state after /compact or fetch an event by seq.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        seq: { type: "integer" },
        sessionId: { type: "string" }
      }
    }
  },
  {
    name: "ctx_search",
    description: "Find ranked snippets in indexed sources.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        queries: { type: "array", items: { type: "string" } },
        sourceId: { type: "string" },
        scope: { type: "string", enum: ["session", "worktree", "all"] },
        limit: { type: "integer" },
        offset: { type: "integer" }
      },
      required: ["queries"]
    }
  },
  {
    name: "ctx_stats",
    description: "Report context savings. reset purges session data.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        reset: { type: "boolean" },
        sessionId: { type: "string" }
      }
    }
  }
];

export const TOOL_DEFINITIONS = Object.freeze(
  RAW_TOOL_DEFINITIONS
    .map((def) => stableSortObject(def))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
);

process.stdout.on("error", (err) => {
  if (err && (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED")) return;
});

function sendJsonRpc(obj) {
  try {
    process.stdout.write(JSON.stringify(obj) + "\n");
  } catch {}
}

function requestClientRootsList(timeoutMs = 1000) {
  if (stdinClosed) return Promise.resolve({ status: "error", dir: null });
  if (inFlightRootsPromise) return inFlightRootsPromise;
  inFlightRootsPromise = new Promise((resolve) => {
    const reqId = `agy-ctx-roots-${nextRootsReqSeq++}`;
    const timer = setTimeout(() => {
      pendingClientRequests.delete(reqId);
      resolve({ status: "timeout", dir: null });
    }, timeoutMs);
    timer.unref();
    pendingClientRequests.set(reqId, {
      timer,
      resolve: (respMsg) => {
        clearTimeout(timer);
        if (respMsg && typeof respMsg === "object" && Object.prototype.hasOwnProperty.call(respMsg, "status")) {
          resolve(respMsg);
          return;
        }
        if (respMsg && typeof respMsg === "object" && Object.prototype.hasOwnProperty.call(respMsg, "error")) {
          resolve({ status: "error", dir: null });
          return;
        }
        const roots = respMsg?.result?.roots;
        const dir = Array.isArray(roots) ? resolveSingleWorkspace(roots.map(item => item?.uri || item?.path)) : null;
        resolve(dir ? { status: "ok", dir } : { status: "empty", dir: null });
      }
    });
    sendJsonRpc({ jsonrpc: "2.0", id: reqId, method: "roots/list" });
  });
  const trackedPromise = inFlightRootsPromise.finally(() => {
    if (inFlightRootsPromise === trackedPromise) {
      inFlightRootsPromise = null;
    }
  });
  inFlightRootsPromise = trackedPromise;
  return trackedPromise;
}

function sendResponse(id, result) {
  sendJsonRpc({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message, data) {
  sendJsonRpc({
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) }
  });
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

let inFlightCalls = 0;
let stdinClosed = false;
let shuttingDown = false;

function cancelPendingClientRequests() {
  for (const [, pending] of pendingClientRequests) {
    clearTimeout(pending.timer);
    pending.resolve({ status: "error", dir: null });
  }
  pendingClientRequests.clear();
}

function gracefulFlushAndExit() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    store.close();
  } catch {}
  const forceTimer = setTimeout(() => {
    process.exit(0);
  }, 150);
  forceTimer.unref();
  try {
    process.stdout.end(() => {
      clearTimeout(forceTimer);
      process.exit(0);
    });
  } catch {
    process.exit(0);
  }
}

function maybeCloseStoreOnDrain() {
  if (stdinClosed && inFlightCalls === 0) {
    gracefulFlushAndExit();
  }
}

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch (err) {
    sendError(null, -32700, "Parse error", String(err));
    return;
  }

  if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
    sendError(null, -32600, "Invalid Request", "JSON-RPC message must be a JSON object");
    return;
  }

  const { id, method, params } = msg;
  const hasId = id !== undefined && id !== null;
  if (
    hasId &&
    !method &&
    (Object.prototype.hasOwnProperty.call(msg, "result") ||
      Object.prototype.hasOwnProperty.call(msg, "error"))
  ) {
    const pending = pendingClientRequests.get(String(id));
    if (pending) {
      pendingClientRequests.delete(String(id));
      pending.resolve(msg);
    }
    return;
  }
  if (!hasId) {
    if (method === "notifications/roots/list_changed") {
      explicitWorkspaceConfigured = false;
      currentCwd = launchCwd;
      rootsEpoch += 1;
      cachedRootsDir = null;
      rootsQueried = false;
      rootsUnsupported = false;
      rootsTimeoutCount = 0;
      rootsRetryAfterMs = 0;
      inFlightRootsPromise = null;
    }
    return;
  }

  inFlightCalls += 1;
  try {
    switch (method) {
      case "initialize": {
        clientSupportsRoots = Boolean(
          params?.capabilities && typeof params.capabilities === "object" && params.capabilities.roots
        );
        const initCandidates = [
          ...(Array.isArray(params?.workspaceFolders)
            ? params.workspaceFolders.map((w) => w?.uri || w?.path)
            : []),
          params?.rootUri,
          params?.rootPath
        ];
        if (initCandidates.some(Boolean)) {
          const resolved = resolveSingleWorkspace(initCandidates);
          currentCwd = resolved || launchCwd;
          explicitWorkspaceConfigured = Boolean(resolved);
        }
        const initSid = normalizeSessionId(params?.sessionId);
        if (initSid) initSessionId = initSid;
        sendResponse(id, {
          protocolVersion: params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: {
            name: "agy-dart-context",
            version: pkgVersion
          }
        });
        break;
      }

      case "ping": {
        sendResponse(id, {});
        break;
      }

      case "tools/list": {
        sendResponse(id, { tools: TOOL_DEFINITIONS });
        break;
      }

      case "tools/call": {
        const toolName = params?.name;
        const rawToolArgs = params?.arguments;
        let toolArgs = {};
        if (rawToolArgs !== undefined && rawToolArgs !== null) {
          if (typeof rawToolArgs === "string") {
            try {
              const parsedArgs = JSON.parse(rawToolArgs);
              if (!parsedArgs || typeof parsedArgs !== "object" || Array.isArray(parsedArgs)) {
                sendError(id, -32602, "Invalid params: 'arguments' must decode to a JSON object");
                break;
              }
              toolArgs = parsedArgs;
            } catch {
              sendError(id, -32602, "Invalid params: 'arguments' string is not valid JSON");
              break;
            }
          } else if (typeof rawToolArgs === "object" && !Array.isArray(rawToolArgs)) {
            toolArgs = rawToolArgs;
          } else {
            sendError(id, -32602, "Invalid params: 'arguments' must be a JSON object");
            break;
          }
        }
        const shouldQueryRootsCtx =
          !explicitWorkspaceConfigured &&
          !cachedRootsDir &&
          !rootsQueried &&
          !rootsUnsupported &&
          !stdinClosed &&
          !isExplicitAbsoluteCwdArg(toolArgs.cwd) &&
          (clientSupportsRoots
            ? Date.now() >= rootsRetryAfterMs
            : isInsideInstalledPluginDir(currentCwd) && !resolveConfiguredWorkspace());
        if (shouldQueryRootsCtx) {
          const epoch = rootsEpoch;
          const timeoutMs = resolveRootsTimeoutCtx(clientSupportsRoots ? 2500 : 400);
          const rootsRes = await requestClientRootsList(timeoutMs);
          if (rootsEpoch !== epoch) {
            sendResponse(id, {
              isError: true,
              content: [{ type: "text", text: "Workspace roots changed during this call. Retry with the active workspace in 'cwd'." }]
            });
            break;
          }
          if (rootsRes.status === "ok" && rootsRes.dir) {
            rootsQueried = true;
            cachedRootsDir = rootsRes.dir;
            rootsTimeoutCount = 0;
            rootsRetryAfterMs = 0;
          } else if (rootsRes.status === "error") {
            rootsQueried = true;
            rootsUnsupported = true;
            cachedRootsDir = null;
          } else if (rootsRes.status === "empty" || !clientSupportsRoots) {
            rootsQueried = true;
            cachedRootsDir = null;
          } else if (rootsRes.status === "timeout") {
            rootsTimeoutCount += 1;
            rootsRetryAfterMs = rootsTimeoutCount >= 2 ? Date.now() + 30000 : Date.now();
          }
        }
        // Strictly per-call session isolation via AsyncLocalStorage: never mutate process-global
        // session state across concurrent conversations sharing one long-lived MCP stdio server.
        const hostIds = [
          params?._meta?.rootConversationId,
          params?._meta?.parentConversationId,
          params?._meta?.conversationId,
          params?._meta?.sessionId,
          params?.sessionId
        ];
        const argumentIds = [toolArgs.sessionId, toolArgs.conversationId];
        // The host owns execution/index/batch attribution. Other tools support explicit cross-session queries.
        const isHostAttributed = toolName === "ctx_execute" || toolName === "ctx_index" || toolName === "ctx_batch";
        const candidates = isHostAttributed ? [...hostIds, ...argumentIds] : [...argumentIds, ...hostIds];
        const callSessionId = candidates.map(normalizeSessionId).find(Boolean) ?? null;
        const callDirectConvId =
          [
            toolArgs.conversationId,
            toolArgs.sessionId,
            params?._meta?.conversationId,
            params?._meta?.sessionId,
            params?.sessionId
          ]
            .map(normalizeSessionId)
            .find(Boolean) ?? null;

        if (typeof toolName !== "string" || !Object.hasOwn(tools, toolName)) {
          sendError(id, -32601, `Unknown tool: ${toolName}`);
          break;
        }

        try {
          const result = await callContext.run(
            {
              sessionId: callSessionId, directConversationId: callDirectConvId,
              explicitPath: isExplicitAbsoluteCwdArg(toolArgs.cwd) ||
                (toolName === "ctx_index" && !toolArgs.cwd && isExplicitAbsoluteCwdArg(toolArgs.path))
            },
            () => tools[toolName](toolArgs)
          );
          sendResponse(id, {
            content: [
              {
                type: "text",
                text: typeof result === "string" ? result : JSON.stringify(result, null, 2)
              }
            ],
            isError: false
          });
        } catch (toolErr) {
          sendResponse(id, {
            content: [
              {
                type: "text",
                text: `Tool error (${toolName}): ${toolErr.message || String(toolErr)}`
              }
            ],
            isError: true
          });
        }
        break;
      }

      default: {
        sendError(id, -32601, `Method not found: ${method}`);
        break;
      }
    }
  } catch (handlerErr) {
    sendError(id, -32603, "Internal server error", String(handlerErr));
  } finally {
    inFlightCalls = Math.max(0, inFlightCalls - 1);
    maybeCloseStoreOnDrain();
  }
});

rl.on("close", () => {
  stdinClosed = true;
  cancelPendingClientRequests();
  maybeCloseStoreOnDrain();
});

const exitImmediately = () => {
  try {
    store.close();
  } catch {}
  process.exit(0);
};

process.on("SIGINT", exitImmediately);
process.on("SIGTERM", exitImmediately);
if (process.platform === "win32") {
  process.on("SIGBREAK", exitImmediately);
}
