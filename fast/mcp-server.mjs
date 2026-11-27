// agy-fast MCP Stdio Server (bundled zero-dependency ESM)
import { createHash as createHashNode } from "node:crypto";
import fsSyncNode from "node:fs";
import pathNodeTop from "node:path";
import { performance as perfNode } from "node:perf_hooks";
import { fileURLToPath as fileURLToPathTop } from "node:url";
import { enableVersionedCompileCache } from "../hooks/compile-cache.mjs";
import { getEffectiveConfig } from "../context/lib/config.js";
import { detectSensitiveFile, redactSecrets } from "../context/lib/security.js";
import { stableSortObject } from "../context/lib/stable-json.js";
const FAST_SELF_PATH = pathNodeTop.resolve(fileURLToPathTop(import.meta.url));
const FAST_PLUGIN_ROOT = pathNodeTop.resolve(pathNodeTop.dirname(FAST_SELF_PATH), "..");
const IS_INSTALLED_FAST_PLUGIN_COPY = !fsSyncNode.existsSync(pathNodeTop.join(FAST_PLUGIN_ROOT, ".git"));
const INSTALLED_PLUGIN_PATH_RE =
  /\/(?:\.gemini\/(?:config|antigravity)\/plugins|\.agents\/plugins|\.t3\/userdata\/providers\/antigravity\/[^/]+\/(?:\.gemini\/config\/)?plugins)\/agy-dart(?:\/|$)/i;
const MAX_MCP_CALL_BUDGET_SEC = 170;
const MAX_MCP_CALL_BUDGET_MS = MAX_MCP_CALL_BUDGET_SEC * 1e3;

function normalizeCompareDirFast(dirPath) {
  let resolved = pathNodeTop.resolve(String(dirPath || ""));
  try {
    resolved = fsSyncNode.realpathSync(resolved);
  } catch {}
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isSameOrSubDirFast(candidateNorm, parentNorm) {
  if (!candidateNorm || !parentNorm) return false;
  const rel = pathNodeTop.relative(parentNorm, candidateNorm);
  return (
    rel === "" ||
    (rel !== ".." &&
      !rel.startsWith(`..${pathNodeTop.sep}`) &&
      !rel.startsWith("../") &&
      !pathNodeTop.isAbsolute(rel))
  );
}

const FAST_PLUGIN_ROOT_NORM = normalizeCompareDirFast(FAST_PLUGIN_ROOT);

function isInsideInstalledPluginDir(candidateDir) {
  if (typeof candidateDir !== "string" || !candidateDir.trim()) return false;
  const candNorm = normalizeCompareDirFast(candidateDir);
  const candPosix = candNorm.replace(/\\/g, "/");
  if (INSTALLED_PLUGIN_PATH_RE.test(candPosix)) return true;
  for (const envVar of [process.env.PLUGIN_ROOT, process.env.AGY_PLUGIN_ROOT]) {
    if (typeof envVar === "string" && envVar.trim()) {
      if (isSameOrSubDirFast(candNorm, normalizeCompareDirFast(envVar.trim()))) return true;
    }
  }
  if (IS_INSTALLED_FAST_PLUGIN_COPY && isSameOrSubDirFast(candNorm, FAST_PLUGIN_ROOT_NORM)) {
    return true;
  }
  return false;
}

function resolveDirectoryCandidateFast(raw) {
  if (typeof raw !== "string") return null;
  let candidate = raw.trim();
  if (!candidate) return null;
  if (/^file:\/\//i.test(candidate)) {
    try {
      candidate = fileURLToPathTop(candidate);
    } catch {
      return null;
    }
  }
  if (candidate === "~") {
    candidate = os.homedir();
  } else if (candidate.startsWith("~/") || candidate.startsWith("~\\")) {
    candidate = pathNodeTop.join(os.homedir(), candidate.slice(2));
  }
  try {
    const abs = pathNodeTop.resolve(candidate);
    if (fsSyncNode.statSync(abs).isDirectory()) return abs;
  } catch {}
  return null;
}
function resolveConfiguredWorkspaceFast() {
  try {
    const cfgDir = resolveDirectoryCandidateFast(getEffectiveConfig().defaultCwd);
    if (cfgDir && !isInsideInstalledPluginDir(cfgDir)) return cfgDir;
  } catch {}
  return null;
}
function resolveRootsTimeoutFast(defaultMs) {
  const raw = process.env.AGY_DART_ROOTS_TIMEOUT_MS;
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw.trim());
    if (Number.isFinite(n) && n >= 50 && n <= 15e3) return Math.floor(n);
  }
  return defaultMs;
}
let isSafeRegex = (pattern) => typeof pattern === "string" && pattern.length <= 512;
let filterRulesMod;
try {
  filterRulesMod = await import("../hooks/filter-rules.mjs");
  if (typeof filterRulesMod?.isSafeRegex === "function") {
    isSafeRegex = filterRulesMod.isSafeRegex;
  }
} catch {}
try {
  enableVersionedCompileCache();
} catch {}

// src/protocol/mcp.ts
var SUPPORTED_PROTOCOL_VERSIONS = /* @__PURE__ */ new Set([
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05"
]);
var DEFAULT_PROTOCOL_VERSION = "2025-03-26";
var MAX_JSONRPC_FRAME_BYTES = 16 * 1024 * 1024;
function sliceSafeChars(str, maxUnits) {
  if (maxUnits <= 0 || !str) return "";
  if (str.length <= maxUnits) {
    const last = str.charCodeAt(str.length - 1);
    return last >= 0xd800 && last <= 0xdbff ? str.slice(0, -1) : str;
  }
  let end = maxUnits;
  const prev = str.charCodeAt(end - 1);
  if (prev >= 0xd800 && prev <= 0xdbff) {
    end -= 1;
  }
  return end > 0 ? str.slice(0, end) : "";
}
function checkSensitiveFastPath(absPath) {
  if (!absPath || getEffectiveConfig().sensitiveFileGuard !== "deny") return null;
  const direct = detectSensitiveFile(absPath);
  if (direct.sensitive) return direct;
  try {
    const real = fsSyncNode.realpathSync(absPath);
    if (real !== absPath) {
      const realHit = detectSensitiveFile(real);
      if (realHit.sensitive) return realHit;
    }
  } catch {}
  return null;
}
function makeToolRpcResponse(id, text, isError) {
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: Boolean(isError) } };
}
function buildBoundedToolRpcResponse(id, rawText, isError, maxRpcBytes = 8799) {
  const safeInput = redactSecrets(typeof rawText === "string" ? rawText : String(rawText ?? "")).text;
  const wellFormed = typeof safeInput.toWellFormed === "function" ? safeInput.toWellFormed() : sliceSafeChars(safeInput, safeInput.length);
  const makeEnv = (txt) => makeToolRpcResponse(id, txt, isError);
  const initialEnv = makeEnv(wellFormed);
  if (Buffer.byteLength(JSON.stringify(initialEnv), "utf8") <= maxRpcBytes) {
    return initialEnv;
  }
  const suffix = "\n... [truncated to stay <=8.8KB UTF-8]";
  let lo = 0;
  let hi = Buffer.byteLength(wellFormed, "utf8");
  let best = "";
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cand = `${sliceUtf8Bytes(wellFormed, mid)}${suffix}`;
    if (Buffer.byteLength(JSON.stringify(makeEnv(cand)), "utf8") <= maxRpcBytes) {
      best = cand;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (!best) {
    best = sliceUtf8Bytes(wellFormed, Math.max(0, maxRpcBytes - 160));
  }
  return makeEnv(best);
}
var McpStdioServer = class {
  tools = /* @__PURE__ */ new Map();
  serverName;
  serverVersion;
  inFlight = 0;
  stdinEnded = false;
  onDrainExit;
  initWorkspaceRoot = null;
  vscodeCwdHint = null;
  initSessionId = null;
  clientSupportsRoots = false;
  cachedRootsDir = null;
  rootsQueried = false;
  rootsUnsupported = false;
  rootsTimeoutCount = 0;
  rootsRetryAfterMs = 0;
  rootsEpoch = 0;
  inFlightRootsPromise = null;
  pendingClientRequests = /* @__PURE__ */ new Map();
  nextClientReqSeq = 1;
  writeClientRequest = null;
  lastUseContentLength = false;
  constructor(options) {
    this.serverName = options.name;
    this.serverVersion = options.version;
    const envAntigravityWs = resolveDirectoryCandidateFast(process.env.ANTIGRAVITY_WORKSPACE_ROOT);
    if (envAntigravityWs && !isInsideInstalledPluginDir(envAntigravityWs)) {
      this.initWorkspaceRoot = envAntigravityWs;
    }
    const envVscodeWs = resolveDirectoryCandidateFast(process.env.VSCODE_CWD);
    if (envVscodeWs && !isInsideInstalledPluginDir(envVscodeWs)) {
      this.vscodeCwdHint = envVscodeWs;
    }
  }
  registerTool(definition, handler) {
    this.tools.set(definition.name, { definition, handler });
  }
  cancelPendingClientRequests() {
    for (const [, pending] of this.pendingClientRequests) {
      clearTimeout(pending.timer);
      pending.resolve({ status: "error", dir: null });
    }
    this.pendingClientRequests.clear();
  }
  requestRootsList(timeoutMs = 1e3) {
    if (this.stdinEnded || !this.writeClientRequest) {
      return Promise.resolve({ status: "error", dir: null });
    }
    if (this.inFlightRootsPromise) {
      return this.inFlightRootsPromise;
    }
    this.inFlightRootsPromise = new Promise((resolve) => {
      const reqId = `agy-fast-roots-${this.nextClientReqSeq++}`;
      const timer = setTimeout(() => {
        this.pendingClientRequests.delete(reqId);
        resolve({ status: "timeout", dir: null });
      }, timeoutMs);
      timer.unref();
      this.pendingClientRequests.set(reqId, {
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
          if (Array.isArray(roots)) {
            for (const item of roots) {
              const candidate = resolveDirectoryCandidateFast(item?.uri || item?.path);
              if (candidate && !isInsideInstalledPluginDir(candidate)) {
                resolve({ status: "ok", dir: candidate });
                return;
              }
            }
          }
          resolve({ status: "empty", dir: null });
        }
      });
      this.writeClientRequest({ jsonrpc: "2.0", id: reqId, method: "roots/list" });
    });
    const trackedPromise = this.inFlightRootsPromise.finally(() => {
      if (this.inFlightRootsPromise === trackedPromise) {
        this.inFlightRootsPromise = null;
      }
    });
    this.inFlightRootsPromise = trackedPromise;
    return trackedPromise;
  }
  async resolveWorkspaceRoot({ hostSessionId = null, directConvId = null } = {}) {
    if (this.initWorkspaceRoot) {
      return { dir: this.initWorkspaceRoot, confirmed: true, ambiguousDirs: null };
    }
    if (this.cachedRootsDir) {
      return { dir: this.cachedRootsDir, confirmed: true, ambiguousDirs: null };
    }
    const canQueryRoots = Boolean(this.writeClientRequest && !this.stdinEnded && !this.rootsUnsupported);
    if (this.clientSupportsRoots && canQueryRoots && !this.rootsQueried && Date.now() >= this.rootsRetryAfterMs) {
      const epoch = this.rootsEpoch;
      const res = await this.requestRootsList(resolveRootsTimeoutFast(2500));
      if (this.rootsEpoch === epoch) {
        if (res.status === "ok" && res.dir) {
          this.rootsQueried = true;
          this.cachedRootsDir = res.dir;
          this.rootsTimeoutCount = 0;
          this.rootsRetryAfterMs = 0;
          return { dir: res.dir, confirmed: true, ambiguousDirs: null };
        }
        if (res.status === "error") {
          this.rootsQueried = true;
          this.rootsUnsupported = true;
          this.cachedRootsDir = null;
        } else if (res.status === "empty") {
          this.rootsQueried = true;
          this.cachedRootsDir = null;
        } else if (res.status === "timeout") {
          this.rootsTimeoutCount += 1;
          this.rootsRetryAfterMs = this.rootsTimeoutCount >= 2 ? Date.now() + 3e4 : Date.now();
        }
      } else if (this.rootsQueried && this.cachedRootsDir) {
        return { dir: this.cachedRootsDir, confirmed: true, ambiguousDirs: null };
      }
    }
    const effectiveDirectId = directConvId || this.initSessionId || null;
    const effectiveHostId = hostSessionId || this.initSessionId || null;
    if (effectiveDirectId || effectiveHostId) {
      const sessDir = await lookupFastSessionWorkspace([effectiveDirectId, effectiveHostId]);
      if (sessDir) {
        return { dir: sessDir, confirmed: true, ambiguousDirs: null };
      }
    }
    const configuredWs = resolveConfiguredWorkspaceFast();
    if (configuredWs) {
      return { dir: configuredWs, confirmed: true, ambiguousDirs: null };
    }
    if (this.vscodeCwdHint) {
      return { dir: this.vscodeCwdHint, confirmed: true, ambiguousDirs: null };
    }
    const insidePlugin = isInsideInstalledPluginDir(process.cwd());
    if (!this.clientSupportsRoots && insidePlugin && canQueryRoots && !this.rootsQueried) {
      const epoch = this.rootsEpoch;
      const res = await this.requestRootsList(resolveRootsTimeoutFast(400));
      if (this.rootsEpoch === epoch) {
        this.rootsQueried = true;
        if (res.status === "error") this.rootsUnsupported = true;
        this.cachedRootsDir = res.status === "ok" ? res.dir : null;
      }
      if (res.status === "ok" && res.dir) {
        return { dir: res.dir, confirmed: true, ambiguousDirs: null };
      }
    }
    if (insidePlugin) {
      const activeRes = await lookupFastUniqueActiveWorkspace();
      if (activeRes && activeRes.status === "unique" && activeRes.dir) {
        return { dir: activeRes.dir, confirmed: true, ambiguousDirs: null };
      }
      if (activeRes && activeRes.status === "ambiguous") {
        return { dir: process.cwd(), confirmed: false, ambiguousDirs: activeRes.dirs };
      }
    }
    return { dir: process.cwd(), confirmed: false, ambiguousDirs: null };
  }
  async handleMessage(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request" }
      };
    }
    const msg = raw;
    const hasId = Object.prototype.hasOwnProperty.call(msg, "id") && msg.id !== void 0;
    const id = hasId ? msg.id ?? null : null;
    const method = typeof msg.method === "string" ? msg.method : "";
    if (
      hasId &&
      !method &&
      (Object.prototype.hasOwnProperty.call(msg, "result") ||
        Object.prototype.hasOwnProperty.call(msg, "error"))
    ) {
      const pending = this.pendingClientRequests.get(String(id));
      if (pending) {
        this.pendingClientRequests.delete(String(id));
        pending.resolve(msg);
      }
      return null;
    }
    if (!hasId) {
      if (method === "notifications/roots/list_changed") {
        this.rootsEpoch += 1;
        this.cachedRootsDir = null;
        this.rootsQueried = false;
        this.rootsUnsupported = false;
        this.rootsTimeoutCount = 0;
        this.rootsRetryAfterMs = 0;
        this.inFlightRootsPromise = null;
      }
      return null;
    }
    if (!method) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32600, message: "Invalid Request: missing method" }
      };
    }
    if (method === "initialize") {
      this.clientSupportsRoots = Boolean(
        msg.params?.capabilities &&
          typeof msg.params.capabilities === "object" &&
          msg.params.capabilities.roots
      );
      const initCandidates = [
        ...(Array.isArray(msg.params?.workspaceFolders)
          ? msg.params.workspaceFolders.map((w) => w?.uri || w?.path)
          : []),
        msg.params?.rootUri,
        msg.params?.rootPath
      ];
      for (const cand of initCandidates) {
        const resolved = resolveDirectoryCandidateFast(cand);
        if (resolved && !isInsideInstalledPluginDir(resolved)) {
          this.initWorkspaceRoot = resolved;
          break;
        }
      }
      const initSid = normalizeFastSessionId(msg.params?.sessionId);
      if (initSid) this.initSessionId = initSid;
      const requested = typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion.trim() : "";
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : DEFAULT_PROTOCOL_VERSION;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: this.serverName,
            version: this.serverVersion
          }
        }
      };
    }
    if (method === "ping") {
      return { jsonrpc: "2.0", id, result: {} };
    }
    if (method === "tools/list") {
      const definitions = [...this.tools.values()]
        .map((t) => stableSortObject(t.definition))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return { jsonrpc: "2.0", id, result: { tools: definitions } };
    }
    if (method === "resources/list") {
      return { jsonrpc: "2.0", id, result: { resources: [] } };
    }
    if (method === "resources/templates/list") {
      return { jsonrpc: "2.0", id, result: { resourceTemplates: [] } };
    }
    if (method === "prompts/list") {
      return { jsonrpc: "2.0", id, result: { prompts: [] } };
    }
    if (method === "tools/call") {
      const name = typeof msg.params?.name === "string" ? msg.params.name : "";
      const tool = this.tools.get(name);
      if (!tool) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: `Unknown tool: ${name}` }
        };
      }
      const rawArgs = msg.params?.arguments;
      let args = {};
      if (rawArgs !== void 0 && rawArgs !== null) {
        if (typeof rawArgs === "string") {
          try {
            const parsedArgs = JSON.parse(rawArgs);
            if (!parsedArgs || typeof parsedArgs !== "object" || Array.isArray(parsedArgs)) {
              return {
                jsonrpc: "2.0",
                id,
                error: { code: -32602, message: "Invalid params: 'arguments' must decode to a JSON object" }
              };
            }
            args = parsedArgs;
          } catch {
            return {
              jsonrpc: "2.0",
              id,
              error: { code: -32602, message: "Invalid params: 'arguments' string is not valid JSON" }
            };
          }
        } else if (typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
          args = rawArgs;
        } else {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: "Invalid params: 'arguments' must be a JSON object" }
          };
        }
      }
      const hostSessionId =
        [
          msg.params?._meta?.rootConversationId,
          msg.params?._meta?.parentConversationId,
          msg.params?._meta?.conversationId,
          msg.params?._meta?.sessionId,
          msg.params?.sessionId,
          this.initSessionId,
          process.env.ANTIGRAVITY_ROOT_CONVERSATION_ID,
          process.env.ANTIGRAVITY_PARENT_CONVERSATION_ID,
          process.env.ANTIGRAVITY_CONVERSATION_ID,
          process.env.CONVERSATION_ID
        ]
          .map(normalizeFastSessionId)
          .find(Boolean) ?? null;
      const directConvId =
        [
          msg.params?._meta?.conversationId,
          msg.params?._meta?.sessionId,
          msg.params?.sessionId,
          this.initSessionId,
          process.env.ANTIGRAVITY_CONVERSATION_ID,
          process.env.CONVERSATION_ID
        ]
          .map(normalizeFastSessionId)
          .find(Boolean) ?? null;
      try {
        const res = await tool.handler(args, { server: this, rpcId: id, hostSessionId, directConvId });
        const rpcResp = buildBoundedToolRpcResponse(id, res.text, Boolean(res.isError), DEFAULT_INLINE_MAX_BYTES - 1);
        const finalText = rpcResp.result.content[0].text;
        if (!res.isError && res.telemetry && res.telemetry.rawBytes > 0) {
          try {
            await recordFastSavingsEvent({
              toolName: name,
              telemetry: res.telemetry,
              finalText,
              hostSessionId,
              directConvId
            });
          } catch {}
        }
        if (
          !res.isError &&
          (name === "run_checks" || (name === "apply_edits" && args?.verify && !args?.dryRun))
        ) {
          try {
            await recordFastVerificationCheckpoint({
              toolName: name,
              args,
              finalText,
              verifyResult: res.verifyResult || null,
              worktree:
                res.telemetry?.worktree ||
                res.verifyWorktree ||
                (typeof args?.cwd === "string" && args.cwd.trim() ? args.cwd.trim() : process.cwd()),
              hostSessionId
            });
          } catch {}
        }
        return rpcResp;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return buildBoundedToolRpcResponse(id, `Tool error: ${message}`, true, DEFAULT_INLINE_MAX_BYTES - 1);
      }
    }
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` }
    };
  }
  listen(input = process.stdin, output = process.stdout, onExit) {
    this.onDrainExit = onExit;
    let buffer = Buffer.alloc(0);
    const writeResponse = (payload, useContentLength) => {
      const serialized = JSON.stringify(payload);
      try {
        if (useContentLength) {
          const len = Buffer.byteLength(serialized, "utf8");
          output.write(`Content-Length: ${len}\r
\r
${serialized}`);
        } else {
          output.write(`${serialized}
`);
        }
      } catch {}
    };
    this.writeClientRequest = (reqPayload) => {
      writeResponse(reqPayload, this.lastUseContentLength);
    };
    const dispatchRawJson = (jsonText, useContentLength) => {
      this.lastUseContentLength = Boolean(useContentLength);
      let parsed;
      try {
        parsed = JSON.parse(jsonText);
      } catch {
        writeResponse(
          {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" }
          },
          useContentLength
        );
        return;
      }
      // Fast-flush client responses immediately before counting/queuing batch requests to prevent self-deadlocks
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        Object.prototype.hasOwnProperty.call(parsed, "id") &&
        !parsed.method &&
        (Object.prototype.hasOwnProperty.call(parsed, "result") ||
          Object.prototype.hasOwnProperty.call(parsed, "error"))
      ) {
        this.handleMessage(parsed).catch(() => {});
        return;
      }
      this.inFlight += 1;
      const finish = () => {
        this.inFlight -= 1;
        if (this.stdinEnded && this.inFlight === 0) {
          this.onDrainExit?.();
        }
      };
      if (Array.isArray(parsed)) {
        if (parsed.length === 0) {
          writeResponse(
            {
              jsonrpc: "2.0",
              id: null,
              error: { code: -32600, message: "Invalid Request: empty batch" }
            },
            useContentLength
          );
          finish();
          return;
        }
        Promise.all(parsed.map((item) => this.handleMessage(item))).then((responses) => {
          const nonNull = responses.filter(
            (r) => r !== null
          );
          if (nonNull.length > 0) {
            writeResponse(nonNull, useContentLength);
          }
        }).finally(finish);
        return;
      }
      this.handleMessage(parsed).then((response) => {
        if (response !== null) {
          writeResponse(response, useContentLength);
        }
      }).finally(finish);
    };
    const drainBuffer = () => {
      while (buffer.length > 0) {
        let offset = 0;
        while (offset < buffer.length && (buffer[offset] === 10 || buffer[offset] === 13)) {
          offset++;
        }
        if (offset > 0) {
          buffer = buffer.subarray(offset);
          if (buffer.length === 0) break;
        }
        const headerProbe = buffer.subarray(0, 16).toString("ascii").toLowerCase();
        if (headerProbe.startsWith("content-length:") || headerProbe.startsWith("content-type:")) {
          const crlfIdx = buffer.indexOf("\r\n\r\n");
          const lfIdx = buffer.indexOf("\n\n");
          let sepIdx = -1;
          let sepLen = 4;
          if (crlfIdx !== -1 && (lfIdx === -1 || crlfIdx <= lfIdx)) {
            sepIdx = crlfIdx;
            sepLen = 4;
          } else if (lfIdx !== -1) {
            sepIdx = lfIdx;
            sepLen = 2;
          }
          if (sepIdx === -1) {
            if (buffer.length > 16384) {
              buffer = Buffer.alloc(0);
              writeResponse(
                { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request: oversized header" } },
                true
              );
            }
            break;
          }
          const headerText = buffer.subarray(0, sepIdx).toString("ascii");
          const match = /content-length:\s*(\d+)/i.exec(headerText);
          if (!match) {
            buffer = buffer.subarray(sepIdx + sepLen);
            continue;
          }
          const contentLength = Number.parseInt(match[1], 10);
          if (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > MAX_JSONRPC_FRAME_BYTES) {
            buffer = Buffer.alloc(0);
            writeResponse(
              { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request: frame exceeds size limit" } },
              true
            );
            break;
          }
          const bodyStart = sepIdx + sepLen;
          if (buffer.length < bodyStart + contentLength) {
            break;
          }
          const bodyText = buffer.subarray(bodyStart, bodyStart + contentLength).toString("utf8");
          buffer = buffer.subarray(bodyStart + contentLength);
          dispatchRawJson(bodyText, true);
          continue;
        }
        const newlineIdx = buffer.indexOf(10);
        if (newlineIdx === -1) {
          if (buffer.length > MAX_JSONRPC_FRAME_BYTES) {
            buffer = Buffer.alloc(0);
            writeResponse(
              { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request: frame exceeds size limit" } },
              false
            );
          }
          break;
        }
        const lineBuf = buffer.subarray(0, newlineIdx);
        buffer = buffer.subarray(newlineIdx + 1);
        const line = lineBuf.toString("utf8").trim();
        if (line.length > 0) {
          dispatchRawJson(line, false);
        }
      }
    };
    input.on("data", (chunk) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      buffer = buffer.length === 0 ? buf : Buffer.concat([buffer, buf]);
      drainBuffer();
    });
    input.on("end", () => {
      const remaining = buffer.toString("utf8").trim();
      buffer = Buffer.alloc(0);
      const lowerRem = remaining.toLowerCase();
      if (remaining.length > 0 && !lowerRem.startsWith("content-length:") && !lowerRem.startsWith("content-type:")) {
        dispatchRawJson(remaining, false);
      }
      this.stdinEnded = true;
      this.cancelPendingClientRequests();
      if (this.inFlight === 0) {
        this.onDrainExit?.();
      }
    });
    input.on("error", () => {
      this.stdinEnded = true;
      this.cancelPendingClientRequests();
      if (this.inFlight === 0) {
        this.onDrainExit?.();
      }
    });
  }
};

// src/tools/apply-edits.ts
import { promises as fs2 } from "node:fs";
import path2 from "node:path";

// src/utils/exec-utils.ts
import { spawn, spawnSync } from "node:child_process";
var DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
var WINDOWS_CODEPAGE_LABELS = {
  866: "ibm866",
  874: "windows-874",
  936: "gb18030",
  54936: "gb18030",
  950: "big5",
  932: "shift_jis",
  949: "euc-kr",
  1250: "windows-1250",
  1251: "windows-1251",
  1252: "windows-1252",
  1253: "windows-1253",
  1254: "windows-1254",
  1255: "windows-1255",
  1256: "windows-1256",
  1257: "windows-1257",
  1258: "windows-1258",
  65001: "utf-8"
};
var strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });
var cachedWindowsFallbackEncoding;
var fallbackDecoderCache = /* @__PURE__ */ new Map();
function parseWindowsCodePage(output) {
  const match = /\b(\d{3,5})\b/.exec(output);
  if (!match) return null;
  const cp = Number.parseInt(match[1], 10);
  const mapped = WINDOWS_CODEPAGE_LABELS[cp];
  return mapped && mapped !== "utf-8" ? mapped : null;
}
function stripTrailingIncompleteUtf8(buf) {
  if (buf.length === 0) return buf;
  let i = buf.length - 1;
  const minIdx = Math.max(0, buf.length - 4);
  while (i >= minIdx && (buf[i] & 192) === 128) {
    i--;
  }
  if (i < minIdx) return buf;
  const lead = buf[i];
  if ((lead & 128) === 0) return buf;
  let expectedLen = 0;
  if ((lead & 224) === 192) expectedLen = 2;
  else if ((lead & 240) === 224) expectedLen = 3;
  else if ((lead & 248) === 240) expectedLen = 4;
  else return buf;
  return buf.length - i < expectedLen ? buf.subarray(0, i) : buf;
}
function getWindowsSystem32Binary(name) {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || "";
  if (systemRoot) {
    return {
      bin: path.join(systemRoot, "System32", name),
      cwd: systemRoot
    };
  }
  return { bin: name, cwd: process.cwd() };
}
function getWindowsFallbackEncoding() {
  if (cachedWindowsFallbackEncoding !== void 0) {
    return cachedWindowsFallbackEncoding;
  }
  try {
    const { bin: chcpBin, cwd } = getWindowsSystem32Binary("chcp.com");
    const res = spawnSync(chcpBin, [], {
      cwd,
      encoding: "latin1",
      timeout: 1500,
      windowsHide: true
    });
    if (!res.error && res.status === 0) {
      const mapped = parseWindowsCodePage(res.stdout || "");
      if (mapped) {
        cachedWindowsFallbackEncoding = mapped;
        return cachedWindowsFallbackEncoding;
      }
    }
  } catch {
  }
  cachedWindowsFallbackEncoding = null;
  return null;
}
function decodeProcessOutput(buf, truncated = false, fallbackEncoding) {
  if (buf.length === 0) return "";
  const candidate = truncated ? stripTrailingIncompleteUtf8(buf) : buf;
  try {
    return strictUtf8Decoder.decode(candidate);
  } catch {
    const label = fallbackEncoding ?? (process.platform === "win32" ? getWindowsFallbackEncoding() : null);
    if (!label || label === "utf-8") {
      return buf.toString("utf8");
    }
    try {
      let decoder = fallbackDecoderCache.get(label);
      if (!decoder) {
        decoder = new TextDecoder(label);
        fallbackDecoderCache.set(label, decoder);
      }
      return decoder.decode(buf);
    } catch {
      return buf.toString("utf8");
    }
  }
}
function killChildTree(pid, detached) {
  if (!pid) return;
  if (process.platform === "win32") {
    const fallbackKill = () => {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
      }
    };
    try {
      const sysRoot = process.env.SystemRoot || process.env.WINDIR;
      const taskkillBin = sysRoot ? path2.join(sysRoot, "System32", "taskkill.exe") : "taskkill";
      const killer = spawn(taskkillBin, ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true
      });
      killer.on("error", fallbackKill);
      killer.unref();
    } catch {
      fallbackKill();
    }
    return;
  }
  try {
    if (detached) {
      process.kill(-pid, "SIGTERM");
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
  }
  setTimeout(() => {
    try {
      if (detached) {
        process.kill(-pid, "SIGKILL");
      } else {
        process.kill(pid, "SIGKILL");
      }
    } catch {
    }
  }, 400).unref();
}
function execBinaryAsync(bin, args, options) {
  return spawnAndCollect(bin, args, false, options);
}
var WINDOWS_PS_DOUBLE_QUOTABLE_VAR_RE = /(?<![\\`])(?:\$env:[A-Za-z_][A-Za-z0-9_]*|\$(?:LASTEXITCODE|PSVersionTable|PSScriptRoot|PROFILE)\b)/i;
var WINDOWS_PS_UNQUOTED_SYNTAX_RE = /(?<![\\`])\$(?:HOME|PWD|null|true|false|_)\b|\$\([^)]|@\(|(?:^|[;\r\n])\s*\$[A-Za-z_][A-Za-z0-9_]*\s*=/im;
var WINDOWS_PS_CMDLET_RE = /(?:^|[;|&({\r\n]\s*)(?:Get|Set|New|Remove|Test|Select|Where|ForEach|Sort|Group|Measure|Compare|ConvertTo|ConvertFrom|Export|Import|Invoke|Start|Stop|Restart|Wait|Read|Write|Out|Format|Resolve|Join|Split|Copy|Move|Rename|Clear|Add|Push|Pop|Enable|Disable)-[A-Z][A-Za-z0-9]*\b(?!-)/;
var EXPLICIT_POWERSHELL_INVOCATION_RE = /^\s*(?:["']?)(?:pwsh|powershell)(?:\.exe)?(?:["']?)(?:\s|$)/i;
var PS_NON_INVOCATION_TAIL_RE = /^(?:[|;&+}=),*?]|(?:[1-6*])?>|-(?:c|i)?(?:eq|ne|gt|ge|lt|le|like|notlike|match|notmatch|replace|split|join|in|notin|contains|notcontains|is|isnot|as|and|or|xor|shl|shr|band|bor|bxor)\b|-f\b|$)/i;
var PS_UTF8_PREFIX = "try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}; $OutputEncoding = [System.Text.UTF8Encoding]::new($false);";
function stripQuotedSpans(command, stripDoubleQuotes) {
  let out = "";
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];
    if (quote === "'") {
      if (ch === "'") {
        if (next === "'") {
          i++;
        } else {
          quote = null;
          out += " ";
        }
      }
      continue;
    }
    if (quote === '"') {
      if ((ch === "\\" || ch === "`") && next === '"') {
        i++;
        if (!stripDoubleQuotes) out += ch + next;
        continue;
      }
      if (ch === '"') {
        if (next === '"') {
          i++;
          if (!stripDoubleQuotes) out += '""';
        } else {
          quote = null;
          out += stripDoubleQuotes ? " " : '"';
        }
        continue;
      }
      if (!stripDoubleQuotes) out += ch;
      continue;
    }
    if (ch === "'") {
      quote = "'";
      out += " ";
      continue;
    }
    if (ch === '"') {
      quote = '"';
      out += stripDoubleQuotes ? " " : '"';
      continue;
    }
    out += ch;
  }
  return out;
}
function needsPowerShellOnWindows(command) {
  if (!command || EXPLICIT_POWERSHELL_INVOCATION_RE.test(command)) {
    return false;
  }
  const withoutSingle = stripQuotedSpans(command, false);
  if (WINDOWS_PS_DOUBLE_QUOTABLE_VAR_RE.test(withoutSingle)) {
    return true;
  }
  const unquoted = stripQuotedSpans(command, true);
  return WINDOWS_PS_UNQUOTED_SYNTAX_RE.test(unquoted) || WINDOWS_PS_CMDLET_RE.test(unquoted);
}
function formatPowerShellCommand(command) {
  const trimmed = command.trim();
  if (!trimmed || trimmed[0] !== '"' && trimmed[0] !== "'") {
    return command;
  }
  const quote = trimmed[0];
  let idx = 1;
  while (idx < trimmed.length) {
    if (quote === '"' && trimmed[idx] === "`" && idx + 1 < trimmed.length) {
      idx += 2;
      continue;
    }
    if (trimmed[idx] === quote) {
      if (trimmed[idx + 1] === quote) {
        idx += 2;
        continue;
      }
      const afterQuote = trimmed.slice(idx + 1);
      if (!/^\s+/.test(afterQuote)) {
        return command;
      }
      const rest = afterQuote.trimStart();
      if (rest && !PS_NON_INVOCATION_TAIL_RE.test(rest)) {
        return `& ${trimmed}`;
      }
      return command;
    }
    idx++;
  }
  return command;
}
function buildPowerShellUtf8Command(command) {
  return `${PS_UTF8_PREFIX} ${formatPowerShellCommand(command)}`;
}
var cachedWindowsPowerShell;
var cachedWindowsPowerShellExecPath = null;
var pendingWindowsPowerShellProbe = null;
async function defaultProbeWindowsShell(bin) {
  const { bin: whereBin, cwd } = getWindowsSystem32Binary("where.exe");
  const exeQuery = bin.toLowerCase().endsWith(".exe") ? bin : `${bin}.exe`;
  const whereRes = await execBinaryAsync(whereBin, [exeQuery], {
    cwd,
    timeoutMs: 2e3,
    maxOutputBytes: 4096
  });
  if (!whereRes.error && !whereRes.timedOut) {
    if (whereRes.exitCode !== 0) return false;
    const resolved = whereRes.stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => /\.exe$/i.test(line));
    if (!resolved) return false;
    cachedWindowsPowerShellExecPath = resolved;
    return true;
  }
  const res = await execBinaryAsync(
    exeQuery,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"],
    {
      cwd,
      timeoutMs: 3e3,
      maxOutputBytes: 4096
    }
  );
  if (!res.error && !res.timedOut && res.exitCode === 0) {
    cachedWindowsPowerShellExecPath = exeQuery;
    return true;
  }
  return false;
}
async function resolveWindowsPowerShell(probe = defaultProbeWindowsShell) {
  if (cachedWindowsPowerShell !== void 0) {
    return cachedWindowsPowerShell;
  }
  if (pendingWindowsPowerShellProbe) {
    return pendingWindowsPowerShellProbe;
  }
  pendingWindowsPowerShellProbe = (async () => {
    try {
      cachedWindowsPowerShellExecPath = null;
      if (await probe("pwsh")) {
        cachedWindowsPowerShell = "pwsh";
        return cachedWindowsPowerShell;
      }
      cachedWindowsPowerShellExecPath = null;
      if (await probe("powershell.exe")) {
        cachedWindowsPowerShell = "powershell.exe";
        return cachedWindowsPowerShell;
      }
      cachedWindowsPowerShellExecPath = null;
      cachedWindowsPowerShell = null;
      return null;
    } finally {
      pendingWindowsPowerShellProbe = null;
    }
  })();
  return pendingWindowsPowerShellProbe;
}
async function runShellCommandAsync(command, options) {
  if (process.platform === "win32") {
    if (needsPowerShellOnWindows(command)) {
      const psBin = await resolveWindowsPowerShell();
      if (psBin) {
        const utf8Command = buildPowerShellUtf8Command(command);
        return spawnAndCollect(
          cachedWindowsPowerShellExecPath ?? psBin,
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", utf8Command],
          false,
          options
        );
      }
    }
    return spawnAndCollect(command, [], true, options);
  }
  return spawnAndCollect(command, [], true, options);
}
function captureProcessStream(stream, limit, keepFailureTail) {
  const chunks = [];
  let captured = 0;
  let overflow = 0;
  // One inline response fits in 8.8 KB. Keep extra space for log filtering.
  const tailCapacity = Math.min(Math.floor(limit / 2), 16 * 1024);
  let ring;
  stream.on("data", chunk => {
    const take = Math.min(chunk.length, limit - captured);
    if (take > 0) {
      chunks.push(chunk.subarray(0, take));
      captured += take;
    }
    const excess = chunk.length - take;
    if (!excess) return;
    if (keepFailureTail && tailCapacity) {
      ring ??= Buffer.allocUnsafe(tailCapacity);
      const length = Math.min(excess, tailCapacity);
      const offset = (overflow + excess - length) % tailCapacity;
      const split = Math.min(length, tailCapacity - offset);
      chunk.copy(ring, offset, chunk.length - length, chunk.length - length + split);
      if (split < length) chunk.copy(ring, 0, chunk.length - length + split);
    }
    overflow += excess;
  });
  return {
    get truncated() { return overflow > 0; },
    text(failed) {
      const head = Buffer.concat(chunks, captured);
      if (!failed || !ring) return decodeProcessOutput(head, overflow > 0);
      const cursor = overflow % tailCapacity;
      const tail = overflow >= tailCapacity
        ? Buffer.concat([ring.subarray(cursor), ring.subarray(0, cursor)])
        : Buffer.concat([head.subarray(captured - tailCapacity + overflow), ring.subarray(0, overflow)]);
      // The split can fall in the middle of a UTF-8 sequence. Only strip the
      // continuation bytes if the rest decodes as UTF-8 (Windows also uses legacy encodings).
      let start = 0;
      while (start < Math.min(3, tail.length) && (tail[start] & 192) === 128) start++;
      let endText;
      try { endText = strictUtf8Decoder.decode(tail.subarray(start)); }
      catch { endText = decodeProcessOutput(tail); }
      return decodeProcessOutput(head.subarray(0, captured - tailCapacity), true) +
        "\n... [process output omitted] ...\n" + endText;
    }
  };
}
function spawnAndCollect(commandOrBin, args, shell, options) {
  const startMs = Date.now();
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const detached = process.platform !== "win32";
  return new Promise((resolve) => {
    let timedOut = false;
    let settled = false;
    let child;
    try {
      child = spawn(commandOrBin, args, {
        cwd: options.cwd,
        shell,
        detached,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: options.env ?? process.env
      });
    } catch (err) {
      resolve({
        exitCode: null,
        signal: null,
        timedOut: false,
        durationMs: Date.now() - startMs,
        stdout: "",
        stderr: "",
        truncated: false,
        error: err instanceof Error ? err.message : String(err)
      });
      return;
    }
    const stdout = captureProcessStream(child.stdout, maxOutputBytes, options.keepFailureTail);
    const stderr = captureProcessStream(child.stderr, maxOutputBytes, options.keepFailureTail);
    let settleFallbackTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      killChildTree(child.pid, detached);
      settleFallbackTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(null, "SIGKILL");
      }, 1500);
      settleFallbackTimer.unref();
    }, Math.max(100, options.timeoutMs));
    timer.unref();
    const finish = (exitCode, signal, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (settleFallbackTimer) clearTimeout(settleFallbackTimer);
      resolve({
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - startMs,
        stdout: stdout.text(exitCode !== 0 || timedOut),
        stderr: stderr.text(exitCode !== 0 || timedOut),
        truncated: stdout.truncated || stderr.truncated,
        error
      });
    };
    child.on("error", (err) => {
      finish(null, null, err.message);
    });
    child.on("close", (code, signal) => {
      finish(code, signal);
    });
  });
}
var cachedRgAvailable = null;
async function isRipgrepAvailable() {
  if (cachedRgAvailable !== null) return cachedRgAvailable;
  const res = await execBinaryAsync("rg", ["--version"], {
    cwd: process.cwd(),
    timeoutMs: 2e3,
    maxOutputBytes: 4096
  });
  cachedRgAvailable = !res.error && res.exitCode === 0;
  return cachedRgAvailable;
}

// src/utils/fs-utils.ts
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
var DEFAULT_IGNORE_DIRS = /* @__PURE__ */ new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".cache",
  ".turbo",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".gradle",
  ".idea",
  "vendor"
]);
function expandHome(inputPath) {
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}
function resolvePath(inputPath, baseDir) {
  let raw = inputPath.trim();
  if (/^file:\/\//i.test(raw)) {
    try {
      raw = fileURLToPathTop(raw);
    } catch {}
  }
  const expanded = expandHome(raw);
  const root = baseDir ? path.resolve(expandHome(baseDir)) : process.cwd();
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(root, expanded);
}
async function resolveToolWorkspaceCwd(rawCwd, serverOrOptions) {
  let rawStr = typeof rawCwd === "string" ? rawCwd.trim() : "";
  if (rawStr && /^file:\/\//i.test(rawStr)) {
    try {
      rawStr = fileURLToPathTop(rawStr);
    } catch {}
  }
  const expandedRaw = rawStr ? expandHome(rawStr) : "";
  if (expandedRaw && path.isAbsolute(expandedRaw)) {
    return { cwd: path.normalize(expandedRaw), error: null };
  }
  const isServerDirect = Boolean(
    serverOrOptions && typeof serverOrOptions.resolveWorkspaceRoot === "function"
  );
  const server = isServerDirect ? serverOrOptions : serverOrOptions?.server;
  const hostSessionId = isServerDirect ? null : serverOrOptions?.hostSessionId || null;
  const directConvId = isServerDirect ? null : serverOrOptions?.directConvId || null;
  let wsState;
  if (server) {
    wsState = await server.resolveWorkspaceRoot({ hostSessionId, directConvId });
  } else {
    const cfgWs = resolveConfiguredWorkspaceFast();
    wsState = cfgWs
      ? { dir: cfgWs, confirmed: true, ambiguousDirs: null }
      : { dir: process.cwd(), confirmed: false, ambiguousDirs: null };
  }
  const { dir: baseRoot, confirmed, ambiguousDirs } = wsState;
  const resolved = expandedRaw ? resolvePath(expandedRaw, baseRoot) : resolvePath(baseRoot);
  if (!confirmed && isInsideInstalledPluginDir(resolved)) {
    if (Array.isArray(ambiguousDirs) && ambiguousDirs.length > 1) {
      return {
        cwd: null,
        error: `Error: Workspace root could not be determined (${ambiguousDirs.length} active workspaces detected; server cwd is inside plugin directory '${resolved}'). Pass the active workspace absolute path in 'cwd'.`
      };
    }
    return {
      cwd: null,
      error: `Error: Workspace root could not be determined (server cwd is inside plugin directory '${resolved}'). Pass the active workspace absolute path in 'cwd'.`
    };
  }
  return { cwd: resolved, error: null };
}
function toPosixPath(p) {
  return p.split(path.sep).join("/");
}
function isLikelyBinary(buf) {
  const limit = Math.min(buf.length, 8192);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}
async function readTextFile(filePath, maxBytes = 10 * 1024 * 1024) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    throw new Error(`Not a regular file: ${filePath}`);
  }
  if (stat.size > maxBytes) {
    throw new Error(
      `File exceeds maximum size (${stat.size} bytes > ${maxBytes} bytes): ${filePath}`
    );
  }
  const buf = await fs.readFile(filePath);
  if (isLikelyBinary(buf)) {
    throw new Error(`Binary file cannot be read as text: ${filePath}`);
  }
  const content = buf.toString("utf8");
  let crlfCount = 0;
  let lfCount = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") {
      if (i > 0 && content[i - 1] === "\r") crlfCount++;
      else lfCount++;
    }
  }
  const eol = crlfCount > lfCount ? "\r\n" : "\n";
  return { content, eol, crlfCount, lfCount, size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode & 4095, rawBuffer: buf };
}
function compileGlobFragment(normalized, depth, state) {
  let re = "";
  let i = 0;
  let localStars = 0;
  while (i < normalized.length) {
    const ch = normalized[i];
    if (ch === "*") {
      let starEnd = i + 1;
      while (starEnd < normalized.length && normalized[starEnd] === "*") {
        starEnd += 1;
      }
      const starCount = starEnd - i;
      localStars += 1;
      if (localStars > 8) {
        throw new Error(`Glob pattern exceeds max wildcard complexity: '${normalized}'`);
      }
      if (starCount >= 2) {
        if (normalized[starEnd] === "/") {
          re += "(?:.*/)?";
          i = starEnd + 1;
        } else {
          re += ".*";
          i = starEnd;
        }
      } else {
        re += "[^/]*";
        i = starEnd;
      }
    } else if (ch === "?") {
      re += "[^/]";
      i += 1;
    } else if (ch === "[") {
      const close = normalized.indexOf("]", i + 1);
      if (close === -1) {
        re += "\\[";
        i += 1;
      } else {
        let inner = normalized.slice(i + 1, close).replace(/\\/g, "\\\\");
        if (inner.startsWith("!")) inner = "^" + inner.slice(1);
        re += `[${inner}]`;
        i = close + 1;
      }
    } else if (ch === "{") {
      const close = findMatchingBrace(normalized, i);
      if (close === -1) {
        re += "\\{";
        i += 1;
      } else {
        if (depth >= 3) {
          throw new Error(`Glob pattern exceeds max brace nesting depth (3): '${normalized}'`);
        }
        const parts = splitBraceAlternatives(normalized.slice(i + 1, close));
        let maxSubStars = 0;
        const compiledSet = /* @__PURE__ */ new Set();
        for (const part of parts) {
          const subRes = compileGlobFragment(part, depth + 1, state);
          if (subRes.stars > maxSubStars) maxSubStars = subRes.stars;
          compiledSet.add(subRes.re);
        }
        const uniqSubs = [...compiledSet];
        state.branches *= Math.max(1, uniqSubs.length);
        if (state.branches > 32) {
          throw new Error(`Glob pattern exceeds max brace expansion limit (32): '${normalized}'`);
        }
        if (maxSubStars > 0 && uniqSubs.length > 1) {
          state.wildcardBraceGroups += 1;
          if (state.wildcardBraceGroups > 2) {
            throw new Error(`Glob pattern exceeds max wildcard brace groups (2): '${normalized}'`);
          }
        }
        localStars += maxSubStars;
        if (localStars > 8) {
          throw new Error(`Glob pattern exceeds max wildcard complexity: '${normalized}'`);
        }
        re += uniqSubs.length === 1 ? uniqSubs[0] : `(?:${uniqSubs.join("|")})`;
        i = close + 1;
      }
    } else if (".+^$()|\\".includes(ch)) {
      re += "\\" + ch;
      i += 1;
    } else {
      re += ch;
      i += 1;
    }
  }
  return { re, stars: localStars };
}
function globToRegExp(pattern) {
  if (typeof pattern !== "string" || pattern.length > 512) {
    throw new Error("Invalid glob pattern: exceeds max length (512)");
  }
  const normalized = pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  const state = { branches: 1, wildcardBraceGroups: 0 };
  const { re } = compileGlobFragment(normalized, 0, state);
  try {
    return new RegExp(`^${re}$`);
  } catch (err) {
    throw new Error(
      `Invalid glob pattern '${pattern}': ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
function findMatchingBrace(str, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < str.length; i++) {
    if (str[i] === "{") depth++;
    else if (str[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
function splitBraceAlternatives(inner) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inner.slice(start));
  return parts;
}
async function walkFiles(rootDir, options = {}) {
  const maxFiles = options.maxFiles ?? 5e3;
  const maxDepth = options.maxDepth ?? 32;
  const includeHidden = options.includeHidden ?? false;
  const ignoreDirs = options.ignoreDirs ?? DEFAULT_IGNORE_DIRS;
  const fileFilter = options.fileFilter;
  const files = [];
  let truncated = false;
  async function visit(dir, relDir, depth) {
    if (truncated || depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const subdirs = [];
    for (const entry of entries) {
      if (truncated) return;
      const name = entry.name;
      if (!includeHidden && name.startsWith(".")) {
        if (!(entry.isDirectory() && name === ".agents")) {
          continue;
        }
      }
      const absPath = path.join(dir, name);
      const relPosix = relDir ? `${relDir}/${name}` : name;
      if (entry.isDirectory()) {
        if (ignoreDirs.has(name)) continue;
        subdirs.push({ abs: absPath, rel: relPosix });
      } else if (entry.isFile()) {
        if (fileFilter && !fileFilter(relPosix)) continue;
        files.push(relPosix);
        if (files.length >= maxFiles) {
          truncated = true;
          return;
        }
      }
    }
    const batchSize = 8;
    for (let i = 0; i < subdirs.length && !truncated; i += batchSize) {
      const slice = subdirs.slice(i, i + batchSize);
      await Promise.all(slice.map((sub) => visit(sub.abs, sub.rel, depth + 1)));
    }
  }
  await visit(rootDir, "", 0);
  return { files, truncated };
}

// src/utils/output-filter.ts
var ANSI_REGEX = (
  // eslint-disable-next-line no-control-regex
  /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[@-Z\\-_])/g
);
function stripAnsi(text) {
  return text.replace(ANSI_REGEX, "");
}
function normalizeTerminalOutput(raw) {
  const clean = stripAnsi(raw).replace(/\r\n/g, "\n");
  return clean.split("\n").map((line) => {
    if (!line.includes("\r")) return line;
    const parts = line.split("\r").filter((p) => p.length > 0);
    return parts[parts.length - 1] ?? "";
  }).join("\n").trimEnd();
}
var DEFAULT_INLINE_MAX_BYTES = 8800;
function sliceUtf8Bytes(text, maxBytes) {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let bytes = 0;
  let endIndex = 0;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i);
    const unitLen = cp > 65535 ? 2 : 1;
    const chBytes = cp <= 127 ? 1 : cp <= 2047 ? 2 : cp <= 65535 ? 3 : 4;
    if (bytes + chBytes > maxBytes) break;
    bytes += chBytes;
    i += unitLen;
    endIndex = i;
  }
  return text.slice(0, endIndex);
}
function truncateWithByteNotice(text, maxBytes) {
  if (maxBytes <= 0) return "";
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= maxBytes) return text;
  if (maxBytes < 56) {
    if (maxBytes <= 3) return sliceUtf8Bytes(text, maxBytes);
    return `${sliceUtf8Bytes(text, maxBytes - 3)}...`;
  }
  const maxNoticeBytes = Buffer.byteLength(
    `
... [truncated: showed ${totalBytes} of ${totalBytes} bytes]`,
    "utf8"
  );
  const cutoffBytes = Math.max(0, maxBytes - maxNoticeBytes);
  let slice = sliceUtf8Bytes(text, cutoffBytes);
  const lastNewline = slice.lastIndexOf("\n");
  if (lastNewline > 0 && Buffer.byteLength(slice.slice(0, lastNewline), "utf8") > cutoffBytes * 0.6) {
    slice = slice.slice(0, lastNewline);
  }
  const shownBytes = Buffer.byteLength(slice, "utf8");
  const result = `${slice}
... [truncated: showed ${shownBytes} of ${totalBytes} bytes]`;
  return Buffer.byteLength(result, "utf8") <= maxBytes ? result : sliceUtf8Bytes(result, maxBytes);
}
function truncateWithNotice(text, maxChars) {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return sliceSafeChars(text, text.length);
  if (maxChars < 48) {
    if (maxChars <= 3) return sliceSafeChars(text, maxChars);
    return `${sliceSafeChars(text, maxChars - 3)}...`;
  }
  const maxNoticeLen = `
... [truncated: showed ${text.length} of ${text.length} chars]`.length;
  const cutoff = Math.max(0, maxChars - maxNoticeLen);
  let slice = sliceSafeChars(text, cutoff);
  const lastNewline = slice.lastIndexOf("\n");
  if (lastNewline > cutoff * 0.6) {
    slice = sliceSafeChars(slice, lastNewline);
  }
  const result = `${slice}
... [truncated: showed ${slice.length} of ${text.length} chars]`;
  return result.length <= maxChars ? result : sliceSafeChars(result, maxChars);
}
function fitSectionsToBudget(sections, maxChars, separator = "\n\n") {
  if (sections.length === 0 || maxChars <= 0) return "";
  const joined = sections.join(separator);
  if (joined.length <= maxChars) return joined;
  const sepTotal = separator.length * (sections.length - 1);
  if (sepTotal >= maxChars) {
    return truncateWithNotice(joined, maxChars);
  }
  let remainingBudget = maxChars - sepTotal;
  const budgets = new Array(sections.length).fill(0);
  const order = sections.map((s, idx) => ({ idx, len: s.length })).sort((a, b) => a.len - b.len);
  for (let i = 0; i < order.length; i++) {
    const remainingCount = order.length - i;
    const share = Math.floor(remainingBudget / remainingCount);
    const item = order[i];
    if (item.len <= share) {
      budgets[item.idx] = item.len;
      remainingBudget -= item.len;
    } else {
      for (let j = i; j < order.length; j++) {
        const rem = order.length - j;
        const alloc = Math.floor(remainingBudget / rem);
        budgets[order[j].idx] = alloc;
        remainingBudget -= alloc;
      }
      break;
    }
  }
  const fitted = sections.map((sec, idx) => truncateWithNotice(sec, budgets[idx] ?? 0)).join(separator);
  return fitted.length <= maxChars ? fitted : truncateWithNotice(fitted, maxChars);
}
function fitSectionsToByteBudget(sections, maxChars, maxBytes, separator = "\n\n") {
  const charFitted = fitSectionsToBudget(sections, maxChars, separator);
  if (maxBytes === void 0 || Buffer.byteLength(charFitted, "utf8") <= maxBytes) {
    return charFitted;
  }
  const sepBytes = Buffer.byteLength(separator, "utf8") * (sections.length - 1);
  if (sepBytes >= maxBytes) {
    return truncateWithByteNotice(charFitted, maxBytes);
  }
  let remainingBytes = maxBytes - sepBytes;
  const byteBudgets = new Array(sections.length).fill(0);
  const order = sections.map((s, idx) => ({ idx, bytes: Buffer.byteLength(s, "utf8") })).sort((a, b) => a.bytes - b.bytes);
  for (let i = 0; i < order.length; i++) {
    const remainingCount = order.length - i;
    const share = Math.floor(remainingBytes / remainingCount);
    const item = order[i];
    if (item.bytes <= share) {
      byteBudgets[item.idx] = item.bytes;
      remainingBytes -= item.bytes;
    } else {
      for (let j = i; j < order.length; j++) {
        const rem = order.length - j;
        const alloc = Math.floor(remainingBytes / rem);
        byteBudgets[order[j].idx] = alloc;
        remainingBytes -= alloc;
      }
      break;
    }
  }
  let fitted = sections.map((sec, idx) => truncateWithByteNotice(sec, byteBudgets[idx] ?? 0)).join(separator);
  if (fitted.length > maxChars) {
    fitted = truncateWithNotice(fitted, maxChars);
  }
  return Buffer.byteLength(fitted, "utf8") <= maxBytes ? fitted : truncateWithByteNotice(fitted, maxBytes);
}
var ERROR_LINE_PATTERN = /(?:\berr!|\b(?:error|fail|failed|failing|exception|traceback|panic|fatal|assertion|syntaxerror|typeerror|referenceerror|zoderror|validationerror|ts\d{4}|e\d{4}|cannot find|not found|unexpected|undefined)\b|caused by:|application failed to start|compilation error|<<<\s*(?:failure|error)|找不到符号|符号:|位置:)/i;
var ROOT_CAUSE_HEADER_PATTERN = /(?:^\s*(?:description|action):|caused by:|application failed to start|⎯+\s*failed tests|compilation error)/i;
var JSON_INFO_LOG_PATTERNS = [
  /^\s*\{"level":(?:10|20|30)\b/,
  /^\s*\{[^}]*"level"\s*:\s*"(?:trace|debug|info)"/i
];
var ALWAYS_NOISE_LINE_PATTERNS = [
  /^\[ERROR\]\s*(?:To see the full stack trace|Re-run Maven using the -X|For more information about the errors|\[Help \d+\]|->\s*\[Help \d+\])/i,
  /^\(node:\d+\)\s*ExperimentalWarning:/,
  /^\(Use `node --trace-warnings/
];
var FAILURE_PROTECT_PATTERN = /\b(?:error|fail(?:ed|ure|ing)?|exception|fatal|assert(?:ion)?|panic|traceback)\b|[A-Za-z]+(?:Error|Exception)\b|\berr!|✖|✗/i;
var PASS_PROGRESS_NOISE_PATTERNS = [
  /^\s*[✔✓]\s*/,
  /^\s*---\s*PASS:/,
  /^\s*ok\s+\d+\b/,
  /^\s*npm\s+warn\s+deprecated\b/i,
  /\blooking for funding\b/i
];
function isFailureNoiseLine(line) {
  if (ALWAYS_NOISE_LINE_PATTERNS.some((re) => re.test(line))) return true;
  if (JSON_INFO_LOG_PATTERNS.some((re) => re.test(line))) {
    return !/"statusCode"\s*:\s*5\d\d|\b(?:error|exception|failed|fatal)\b/i.test(line);
  }
  if (FAILURE_PROTECT_PATTERN.test(line)) return false;
  if (PASS_PROGRESS_NOISE_PATTERNS.some((re) => re.test(line))) return true;
  return false;
}
var SUMMARY_LINE_PATTERN = /\b(passed|tests?|specs?|suites?|ok|warnings?|errors?|built in|compiled|done in|finished)\b/i;
function isRecognizedTestCheck(command, cwd) {
  if (typeof filterRulesMod?.compactPassingTestOutput !== "function") return false;
  const id = filterRulesMod.matchFilterRule(command, { cwd, builtinOnly: true })?.rule.id;
  return id === "test-runner" || id === "playwright";
}
function formatCompactCommandOutput(params) {
  const out = normalizeTerminalOutput(params.stdout);
  const err = normalizeTerminalOutput(params.stderr);
  const combined = [out, err].filter(Boolean).join("\n");
  if (params.error) {
    if (params.retainFailureEnds) return `spawn error: ${params.error}`;
    return truncateWithNotice(`spawn error: ${params.error}`, params.maxChars);
  }
  if (params.timedOut) {
    if (params.retainFailureEnds) return combined ? `TIMED OUT\n${combined}` : "TIMED OUT (no output)";
    const tail = getTailLines(combined, 20);
    return truncateWithNotice(
      tail ? `TIMED OUT
${tail}` : "TIMED OUT (no output)",
      params.maxChars
    );
  }
  if (params.exitCode === 0) {
    if (!combined) return "OK";
    if (params.passingTest) return filterRulesMod.compactPassingTestOutput(combined, params.maxBytes, params.maxChars);
    const lines2 = combined.split("\n").map((l) => l.trim()).filter(Boolean);
    const summaryLines = lines2.filter((l) => SUMMARY_LINE_PATTERN.test(l));
    const picked = summaryLines.length > 0 ? summaryLines.slice(-2) : lines2.length <= 2 ? lines2 : [lines2[lines2.length - 1]];
    return truncateWithNotice(picked.join(" | "), Math.min(params.maxChars, 320));
  }
  const rawLines = combined.split("\n");
  const filteredLines = rawLines.filter((line) => !isFailureNoiseLine(line));
  const lines = filteredLines.length > 0 ? filteredLines : rawLines;
  const cleanedCombined = lines.join("\n");
  if (cleanedCombined.length <= params.maxChars) {
    return cleanedCombined || `Exited with code ${params.exitCode ?? "unknown"}`;
  }
  const keepIndices = /* @__PURE__ */ new Set();
  if (params.retainFailureEnds) keepIndices.add(0);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (ROOT_CAUSE_HEADER_PATTERN.test(line)) {
      const from = Math.max(0, i - 1);
      const to = Math.min(lines.length - 1, i + 8);
      for (let j = from; j <= to; j++) keepIndices.add(j);
    } else if (ERROR_LINE_PATTERN.test(line)) {
      const from = Math.max(0, i - 1);
      const to = Math.min(lines.length - 1, i + 3);
      for (let j = from; j <= to; j++) keepIndices.add(j);
    }
  }
  const tailStart = Math.max(0, lines.length - 12);
  for (let i = tailStart; i < lines.length; i++) {
    keepIndices.add(i);
  }
  const sorted = [...keepIndices].sort((a, b) => a - b);
  const outLines = [];
  let prev = -1;
  for (const idx of sorted) {
    if (prev !== -1 && idx > prev + 1) {
      outLines.push(`... (${idx - prev - 1} lines omitted) ...`);
    }
    outLines.push(lines[idx]);
    prev = idx;
  }
  const diagnostic = outLines.join("\n");
  return params.retainFailureEnds ? diagnostic : truncateWithNotice(diagnostic, params.maxChars);
}
function getTailLines(text, count) {
  if (!text) return "";
  const lines = text.split("\n");
  return lines.slice(-count).join("\n");
}

// src/tools/apply-edits.ts
function computeLineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      starts.push(i + 1);
    }
  }
  return starts;
}
function offsetToLine(lineStarts, offset) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo <= hi) {
    const mid = lo + hi >> 1;
    if (lineStarts[mid] <= offset) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return Math.max(1, hi + 1);
}
function getLineWindowOffsets(text, lineStarts, startLine, endLine) {
  if (startLine !== void 0 && (typeof startLine !== "number" || !Number.isFinite(startLine) || startLine < 1)) {
    throw new Error(`Invalid startLine: ${String(startLine)} (must be integer >= 1)`);
  }
  if (endLine !== void 0 && (typeof endLine !== "number" || !Number.isFinite(endLine) || endLine < 1)) {
    throw new Error(`Invalid endLine: ${String(endLine)} (must be integer >= 1)`);
  }
  const totalLines = lineStarts.length;
  const sLine = startLine !== void 0 ? Math.trunc(startLine) : 1;
  const eLine = endLine !== void 0 ? Math.min(totalLines, Math.trunc(endLine)) : totalLines;
  if (sLine > totalLines) {
    return { windowStart: text.length, windowEnd: text.length };
  }
  if (eLine < sLine) {
    throw new Error(`Invalid line range: startLine (${sLine}) > endLine (${eLine})`);
  }
  const windowStart = lineStarts[sLine - 1];
  const windowEnd = eLine < totalLines ? lineStarts[eLine] : text.length;
  return { windowStart, windowEnd };
}
var MAX_NEARBY_LINES = 26;
function formatNearbyLines(text, startLine, endLine) {
  const lines = text.split("\n");
  if (startLine === void 0 && endLine === void 0) return "";
  const from = Math.max(1, (startLine ?? endLine ?? 1) - 2);
  const rawTo = Math.min(lines.length, (endLine ?? startLine ?? 1) + 2);
  const truncated = rawTo - from + 1 > MAX_NEARBY_LINES;
  const to = truncated ? from + MAX_NEARBY_LINES - 1 : rawTo;
  const snippet = [];
  for (let ln = from; ln <= to; ln++) {
    const lineText = lines[ln - 1] ?? "";
    snippet.push(
      `    ${ln}: ${lineText.length > 160 ? `${sliceSafeChars(lineText, 157)}...` : sliceSafeChars(lineText, lineText.length)}`
    );
  }
  const extra = truncated ? `
    ... (${rawTo - to} more lines in range omitted)` : "";
  return `
  Nearby lines (${from}-${to}):
${snippet.join("\n")}${extra}`;
}
function extractLineTokens(trimmedLine) {
  const tokens = trimmedLine.match(/[A-Za-z0-9_$]{3,}|[\u4e00-\u9fff]{2,}/g);
  if (tokens && tokens.length > 0) return tokens;
  return trimmedLine.split(/\s+/).map((s) => s.trim()).filter((s) => s.length >= 2);
}
function findClosestRegionSnippet(normalizedContent, normTarget, rangeStartLine, rangeEndLine) {
  const fileLines = normalizedContent.split("\n");
  if (fileLines.length === 0) return "";
  const targetLines = normTarget.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (targetLines.length === 0) return "";
  const firstAnchor = targetLines.find((l) => l.length >= 6) ?? targetLines[0];
  let longestAnchor = targetLines[0];
  for (const tl of targetLines) {
    if (tl.length > longestAnchor.length) longestAnchor = tl;
  }
  const anchors = [firstAnchor];
  if (longestAnchor !== firstAnchor) anchors.push(longestAnchor);
  const lastAnchor = targetLines[targetLines.length - 1];
  if (lastAnchor.length >= 6 && !anchors.includes(lastAnchor)) {
    anchors.push(lastAnchor);
  }
  const primaryTokens = new Set(extractLineTokens(firstAnchor));
  const longestTokens = new Set(extractLineTokens(longestAnchor));
  const trimmedFileLines = fileLines.map((l) => l.trim());
  let bestIdx = -1;
  let bestScore = 0;
  const scanStart = Math.max(0, (rangeStartLine ?? 1) - 1);
  const scanEnd = Math.min(
    trimmedFileLines.length - 1,
    (rangeEndLine ?? trimmedFileLines.length) - 1
  );
  for (let i = scanStart; i <= scanEnd; i++) {
    const line = trimmedFileLines[i];
    if (!line) continue;
    let score = 0;
    if (line === firstAnchor) {
      score += 10;
    } else if (firstAnchor.length >= 8 && (line.includes(firstAnchor) || firstAnchor.includes(line))) {
      score += 6;
    } else if (primaryTokens.size > 0) {
      const lineTokens = extractLineTokens(line);
      let hits = 0;
      for (const tok of lineTokens) {
        if (primaryTokens.has(tok)) hits += 1;
      }
      if (hits >= 2 || hits >= 1 && primaryTokens.size <= 2 && hits === primaryTokens.size) {
        score += 4 * (hits / primaryTokens.size);
      }
    }
    if (longestAnchor !== firstAnchor) {
      if (line === longestAnchor) {
        score += 8;
      } else if (longestAnchor.length >= 10 && line.includes(longestAnchor)) {
        score += 5;
      } else if (longestTokens.size >= 2) {
        const lineTokens = extractLineTokens(line);
        let hits = 0;
        for (const tok of lineTokens) {
          if (longestTokens.has(tok)) hits += 1;
        }
        if (hits >= 2) {
          score += 3 * (hits / longestTokens.size);
        }
      }
    }
    if (score >= 2 && targetLines.length > 1) {
      const lookahead = Math.min(targetLines.length, 6);
      for (let k = 1; k < lookahead && i + k < trimmedFileLines.length; k++) {
        const nextLine = trimmedFileLines[i + k];
        const tgtLine = targetLines[k];
        if (nextLine && tgtLine && (nextLine === tgtLine || tgtLine.length >= 8 && nextLine.includes(tgtLine))) {
          score += 3;
        }
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  if (bestIdx < 0 || bestScore < 2.5) return "";
  const span = Math.min(Math.max(targetLines.length, 4), 8);
  const from = Math.max(1, bestIdx + 1 - 2);
  const to = Math.min(fileLines.length, Math.min(from + 13, bestIdx + 1 + span + 2));
  const snippet = [];
  for (let ln = from; ln <= to; ln++) {
    const lineText = fileLines[ln - 1] ?? "";
    snippet.push(
      `    ${ln}: ${lineText.length > 160 ? `${sliceSafeChars(lineText, 157)}...` : sliceSafeChars(lineText, lineText.length)}`
    );
  }
  return `
  Closest match near line ${bestIdx + 1} (lines ${from}-${to}):
${snippet.join("\n")}`;
}
function planHunksForContent(normalizedContent, hunks, displayPath) {
  const lineStarts = computeLineStarts(normalizedContent);
  const spans = [];
  const errors = [];
  for (let idx = 0; idx < hunks.length; idx++) {
    const hunk = hunks[idx];
    if (typeof hunk.target !== "string" || hunk.target.length === 0) {
      errors.push(`${displayPath} hunk #${idx + 1}: 'target' must be a non-empty string`);
      continue;
    }
    if (typeof hunk.replacement !== "string") {
      errors.push(`${displayPath} hunk #${idx + 1}: 'replacement' must be a string`);
      continue;
    }
    const normTarget = hunk.target.replace(/\r\n/g, "\n");
    const normReplacement = hunk.replacement.replace(/\r\n/g, "\n");
    let windowStart = 0;
    let windowEnd = normalizedContent.length;
    try {
      const win = getLineWindowOffsets(
        normalizedContent,
        lineStarts,
        hunk.startLine,
        hunk.endLine
      );
      windowStart = win.windowStart;
      windowEnd = win.windowEnd;
    } catch (err) {
      errors.push(
        `${displayPath} hunk #${idx + 1}: ${err instanceof Error ? err.message : String(err)}`
      );
      continue;
    }
    const foundOffsets = [];
    let pos = windowStart;
    while (pos <= windowEnd - normTarget.length) {
      const found = normalizedContent.indexOf(normTarget, pos);
      if (found === -1 || found + normTarget.length > windowEnd) break;
      foundOffsets.push(found);
      pos = found + Math.max(1, normTarget.length);
    }
    if (foundOffsets.length === 0) {
      const hasRange = hunk.startLine !== void 0 || hunk.endLine !== void 0;
      const rangeNote = hasRange ? ` within lines ${hunk.startLine ?? 1}-${hunk.endLine ?? lineStarts.length}` : "";
      let hint = "";
      if (hasRange) {
        const globalOffsets = [];
        let gPos = 0;
        while (gPos <= normalizedContent.length - normTarget.length && globalOffsets.length < 5) {
          const found = normalizedContent.indexOf(normTarget, gPos);
          if (found === -1) break;
          globalOffsets.push(found);
          gPos = found + Math.max(1, normTarget.length);
        }
        if (globalOffsets.length > 0) {
          const hitLines = globalOffsets.map((o) => `L${offsetToLine(lineStarts, o)}`).join(", ");
          hint = ` Exact match found outside range at ${hitLines} \u2014 adjust startLine/endLine or omit them.`;
        } else {
          const effStart = hunk.startLine ?? 1;
          const effEnd = hunk.endLine ?? lineStarts.length;
          if (effEnd - effStart + 1 > MAX_NEARBY_LINES - 4) {
            hint = findClosestRegionSnippet(normalizedContent, normTarget, effStart, effEnd) || findClosestRegionSnippet(normalizedContent, normTarget) || formatNearbyLines(normalizedContent, effStart, effEnd);
          } else {
            hint = formatNearbyLines(normalizedContent, hunk.startLine, hunk.endLine);
          }
        }
      } else {
        hint = findClosestRegionSnippet(normalizedContent, normTarget);
      }
      errors.push(
        `${displayPath} hunk #${idx + 1}: target text not found${rangeNote}.${hint}`
      );
      continue;
    }
    if (foundOffsets.length > 1 && !hunk.replaceAll) {
      const lines = foundOffsets.slice(0, 10).map((o) => offsetToLine(lineStarts, o)).join(", ");
      errors.push(
        `${displayPath} hunk #${idx + 1}: target matched ${foundOffsets.length} times (lines: ${lines}). Provide startLine/endLine, more surrounding context, or set replaceAll: true.`
      );
      continue;
    }
    for (const start of foundOffsets) {
      spans.push({
        start,
        end: start + normTarget.length,
        replacement: normReplacement,
        hunkIndex: idx
      });
    }
  }
  if (errors.length > 0) {
    return { newNormalized: normalizedContent, appliedMatches: 0, errors };
  }
  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < spans.length; i++) {
    const prev = spans[i - 1];
    const curr = spans[i];
    if (curr.start < prev.end) {
      const line = offsetToLine(lineStarts, curr.start);
      errors.push(
        `${displayPath}: hunk #${prev.hunkIndex + 1} and hunk #${curr.hunkIndex + 1} overlap near line ${line}.`
      );
    }
  }
  if (errors.length > 0) {
    return { newNormalized: normalizedContent, appliedMatches: 0, errors };
  }
  const pieces = [];
  let cursor = 0;
  for (const span of spans) {
    pieces.push(normalizedContent.slice(cursor, span.start));
    pieces.push(span.replacement);
    cursor = span.end;
  }
  pieces.push(normalizedContent.slice(cursor));
  return {
    newNormalized: pieces.join(""),
    spans,
    appliedMatches: spans.length,
    errors: []
  };
}
function applySpansPreservingEol(rawContent, spans, dominantEol) {
  const normToRaw = [];
  for (let r = 0; r < rawContent.length; r++) {
    normToRaw.push(r);
    if (rawContent[r] === "\r" && rawContent[r + 1] === "\n") {
      r++;
    }
  }
  normToRaw.push(rawContent.length);
  const pieces = [];
  let cursor = 0;
  for (const span of spans) {
    pieces.push(rawContent.slice(normToRaw[cursor], normToRaw[span.start]));
    const rep = dominantEol === "\r\n" ? span.replacement.replace(/\n/g, "\r\n") : span.replacement;
    pieces.push(rep);
    cursor = span.end;
  }
  pieces.push(rawContent.slice(normToRaw[cursor]));
  return pieces.join("");
}
function countLines(text) {
  if (!text) return 0;
  const end = text.endsWith("\n") ? text.length - 1 : text.length;
  if (end === 0) return 1;
  let count = 1;
  for (let i = 0; i < end; i++) {
    if (text[i] === "\n") count++;
  }
  return count;
}
async function commitPlannedWrites(plans) {
  const written = [];
  const RENAME_FALLBACK_CODES = new Set(["EXDEV", "EPERM", "EACCES", "EBUSY"]);
  try {
    for (const plan of plans) {
      const target = plan.writeTargetPath;
      const dir = path2.dirname(target);
      await fs2.mkdir(dir, { recursive: true });
      const tmpPath = `${target}.agy-fast-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        await fs2.writeFile(tmpPath, plan.newContent, "utf8");
        if (plan.originalMode !== null && process.platform !== "win32") {
          await fs2.chmod(tmpPath, plan.originalMode);
        }
      } catch (tmpErr) {
        try {
          await fs2.unlink(tmpPath);
        } catch {
        }
        throw tmpErr;
      }
      try {
        await fs2.rename(tmpPath, target);
        written.push(plan);
      } catch (renameErr) {
        try {
          await fs2.unlink(tmpPath);
        } catch {
        }
        if (!renameErr || !RENAME_FALLBACK_CODES.has(renameErr.code)) {
          throw renameErr;
        }
        written.push(plan);
        await fs2.writeFile(target, plan.newContent, "utf8");
        if (plan.originalMode !== null && process.platform !== "win32") {
          try {
            await fs2.chmod(target, plan.originalMode);
          } catch {
          }
        }
      }
    }
  } catch (err) {
    for (let i = written.length - 1; i >= 0; i--) {
      const item = written[i];
      const target = item.writeTargetPath;
      try {
        if (item.existed && item.originalBuffer !== null) {
          await fs2.writeFile(target, item.originalBuffer);
          if (item.originalMode !== null && process.platform !== "win32") {
            await fs2.chmod(target, item.originalMode);
          }
        } else if (item.existed && item.originalSymlinkTarget !== null && item.originalSymlinkTarget !== void 0) {
          try {
            await fs2.unlink(target);
          } catch {
          }
          await fs2.symlink(item.originalSymlinkTarget, target);
        } else if (!item.existed) {
          await fs2.unlink(target);
        }
      } catch {
      }
    }
    throw err;
  }
}
async function runApplyEdits(input, options = {}) {
  const callDeadline = perfNode.now() + (options.budgetMs ?? MAX_MCP_CALL_BUDGET_MS);
  let editsList = input.edits;
  if (typeof editsList === "string") {
    const trimmed = editsList.trim();
    try {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) {
        return {
          text: "Error: 'edits' JSON string must decode to a non-empty array of file edit objects.",
          isError: true
        };
      }
      editsList = parsed;
    } catch (err) {
      return {
        text: `Error: 'edits' must be an array or valid JSON array string (${err instanceof Error ? err.message : String(err)}).`,
        isError: true
      };
    }
  }
  if (!Array.isArray(editsList)) {
    return {
      text: "Error: 'edits' must be a non-empty array of file edit objects.",
      isError: true
    };
  }
  const hasCorruptedElement =
    editsList.length === 0 ||
    editsList.some((entry) => entry === null || typeof entry !== "object" || Array.isArray(entry));
  if (hasCorruptedElement) {
    return {
      text:
        "Error [HOST_SERIALIZATION_CORRUPTION]: 'edits' must be a non-empty array of file edit objects, " +
        "but arrived empty or with corrupted non-object elements (known Antigravity call_mcp_tool nested-array serialization bug). " +
        "Do NOT retry apply_edits in this turn — immediately fall back to built-in parallel edit_file / write_file calls.",
      isError: true
    };
  }
  if (editsList.length > 50) {
    return {
      text: "Error: 'edits' supports at most 50 file entries per call.",
      isError: true
    };
  }
  let verifySpec;
  const verify = input.verify;
  if (typeof verify === "string") {
    if (verify.trim()) verifySpec = { command: verify };
  } else if (verify !== undefined) {
    if (!verify || typeof verify !== "object" || Array.isArray(verify)) {
      return { text: "Validation failed (0 files modified): 'verify' must be a command string or an object.", isError: true };
    }
    if (typeof verify.command !== "string" || !verify.command.trim()) {
      return { text: "Validation failed (0 files modified): 'verify.command' must be a non-empty string.", isError: true };
    }
    if (verify.cwd !== undefined && typeof verify.cwd !== "string") {
      return { text: "Validation failed (0 files modified): 'verify.cwd' must be a string.", isError: true };
    }
    verifySpec = { command: verify.command, cwd: verify.cwd, timeoutSec: verify.timeoutSec };
  }
  const wsRes = await resolveToolWorkspaceCwd(input.cwd, options);
  if (wsRes.error) {
    return { text: wsRes.error, isError: true };
  }
  const baseCwd = wsRes.cwd;
  const mergedByPath = /* @__PURE__ */ new Map();
  const errors = [];
  for (let i = 0; i < editsList.length; i++) {
    const entry = editsList[i];
    if (!entry || typeof entry.path !== "string" || !entry.path.trim()) {
      errors.push(`edits[${i}]: 'path' must be a non-empty string`);
      continue;
    }
    const absPath = resolvePath(entry.path, baseCwd);
    let writeTargetPath = absPath;
    try {
      writeTargetPath = await fs2.realpath(absPath);
    } catch {
    }
    const relPath = toPosixPath(path2.relative(baseCwd, absPath)) || path2.basename(absPath);
    const sens = checkSensitiveFastPath(absPath) || checkSensitiveFastPath(writeTargetPath);
    if (sens) {
      errors.push(
        `${relPath}: blocked sensitive file (${sens.reason}) because sensitiveFileGuard is set to 'deny'`
      );
      continue;
    }
    const hasCreate = typeof entry.create === "string";
    const hasHunks = Array.isArray(entry.hunks) && entry.hunks.length > 0;
    if (!hasCreate && !hasHunks) {
      errors.push(`${relPath}: must specify either non-empty 'hunks' or 'create'`);
      continue;
    }
    if (hasCreate && hasHunks) {
      errors.push(`${relPath}: cannot specify both 'create' and 'hunks' on the same entry`);
      continue;
    }
    const mergeKey = normalizeFileCacheKey(writeTargetPath);
    const existing = mergedByPath.get(mergeKey);
    if (!existing) {
      mergedByPath.set(mergeKey, {
        absPath,
        writeTargetPath,
        relPath,
        create: hasCreate ? entry.create : void 0,
        overwrite: entry.overwrite,
        hunks: hasHunks ? [...entry.hunks] : []
      });
    } else {
      if (hasCreate || existing.create !== void 0) {
        errors.push(`${relPath}: duplicate entries cannot mix 'create' with other edits`);
        continue;
      }
      existing.hunks.push(...entry.hunks);
    }
  }
  if (errors.length > 0) {
    return {
      text: truncateWithByteNotice(
        `Validation failed (0 files modified):
- ${errors.join("\n- ")}`,
        DEFAULT_INLINE_MAX_BYTES
      ),
      isError: true
    };
  }
  const plans = [];
  for (const item of mergedByPath.values()) {
    if (item.create !== void 0) {
      let exists = false;
      let originalBuffer = null;
      let originalMode = null;
      let originalSymlinkTarget = null;
      let lstatRes = null;
      try {
        lstatRes = await fs2.lstat(item.writeTargetPath);
      } catch (err) {
        if (!err || err.code !== "ENOENT") {
          errors.push(`${item.relPath}: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
      }
      if (lstatRes) {
        exists = true;
        let st = lstatRes;
        if (lstatRes.isSymbolicLink()) {
          try {
            st = await fs2.stat(item.writeTargetPath);
          } catch (err) {
            if (!item.overwrite) {
              errors.push(
                `${item.relPath}: file already exists (set overwrite: true to replace it)`
              );
              continue;
            }
            if (err && err.code !== "ENOENT") {
              errors.push(`${item.relPath}: ${err instanceof Error ? err.message : String(err)}`);
              continue;
            }
            st = null;
            try {
              originalSymlinkTarget = await fs2.readlink(item.writeTargetPath);
            } catch {
              originalSymlinkTarget = null;
            }
          }
        }
        if (st && st.isDirectory()) {
          errors.push(`${item.relPath}: target path is a directory`);
          continue;
        }
        if (!item.overwrite) {
          errors.push(
            `${item.relPath}: file already exists (set overwrite: true to replace it)`
          );
          continue;
        }
        if (st) {
          originalMode = st.mode & 4095;
          try {
            originalBuffer = await fs2.readFile(item.writeTargetPath);
          } catch (err) {
            errors.push(`${item.relPath}: ${err instanceof Error ? err.message : String(err)}`);
            continue;
          }
        }
      }
      const oldLines = originalBuffer ? countLines(originalBuffer.toString("utf8")) : 0;
      const newLines = countLines(item.create);
      plans.push({
        absPath: item.absPath,
        writeTargetPath: item.writeTargetPath,
        relPath: item.relPath,
        existed: exists,
        originalBuffer,
        originalMode,
        originalSymlinkTarget,
        newContent: item.create,
        hunkCount: 1,
        lineDelta: newLines - oldLines,
        created: !exists
      });
      continue;
    }
    let fileData;
    try {
      fileData = await readTextFile(item.writeTargetPath);
    } catch (err) {
      errors.push(
        `${item.relPath}: ${err instanceof Error ? err.message : String(err)}`
      );
      continue;
    }
    const normalizedOriginal = fileData.content.replace(/\r\n/g, "\n");
    const planned = planHunksForContent(normalizedOriginal, item.hunks, item.relPath);
    if (planned.errors.length > 0) {
      errors.push(...planned.errors);
      continue;
    }
    const finalContent = fileData.crlfCount > 0 && fileData.lfCount > 0 ? applySpansPreservingEol(fileData.content, planned.spans, fileData.eol) : fileData.eol === "\r\n" ? planned.newNormalized.replace(/\n/g, "\r\n") : planned.newNormalized;
    const lineDelta = countLines(planned.newNormalized) - countLines(normalizedOriginal);
    plans.push({
      absPath: item.absPath,
      writeTargetPath: item.writeTargetPath,
      relPath: item.relPath,
      existed: true,
      originalBuffer: fileData.rawBuffer,
      originalMode: fileData.mode,
      newContent: finalContent,
      hunkCount: planned.appliedMatches,
      lineDelta,
      created: false
    });
  }
  const bestEffort = Boolean(input.bestEffort);
  if (errors.length > 0 && (!bestEffort || plans.length === 0)) {
    const prefix = bestEffort ? "Edit aborted (0 files modified):" : "Atomic edit aborted (0 files modified):";
    return {
      text: truncateWithByteNotice(
        `${prefix}
- ${errors.join("\n- ")}`,
        DEFAULT_INLINE_MAX_BYTES
      ),
      isError: true
    };
  }
  if (!input.dryRun) {
    try {
      await commitPlannedWrites(plans);
    } catch (err) {
      await invalidateFileCaches(plans.flatMap((p) => [p.absPath, p.writeTargetPath]));
      return {
        text: truncateWithByteNotice(
          `Write failed (changes rolled back): ${err instanceof Error ? err.message : String(err)}`,
          DEFAULT_INLINE_MAX_BYTES
        ),
        isError: true
      };
    }
    await invalidateFileCaches(plans.flatMap((p) => [p.absPath, p.writeTargetPath]));
  }
  const summaryLines = plans.map((p) => {
    const deltaStr = p.lineDelta >= 0 ? `+${p.lineDelta}` : `${p.lineDelta}`;
    const action = p.created ? "created" : `updated (${p.hunkCount} match${p.hunkCount === 1 ? "" : "es"})`;
    return `- ${p.relPath}: ${action}, lines ${deltaStr}`;
  });
  if (bestEffort && errors.length > 0) {
    const totalFiles = mergedByPath.size;
    const failedFileCount = Math.max(1, totalFiles - plans.length);
    const partialHeader = input.dryRun ? `Partial dry-run (${plans.length}/${totalFiles} file(s) valid; ${failedFileCount} file(s) failed):` : `Partial edit applied (${plans.length}/${totalFiles} file(s) written; ${failedFileCount} file(s) failed \u2014 do NOT re-send applied files):`;
    const partialParts = [
      partialHeader,
      `Applied:
${summaryLines.join("\n")}`,
      `Failed (fix only these):
- ${errors.join("\n- ")}`
    ];
    if (!input.dryRun && verifySpec) {
      partialParts.push(
        "Verify skipped because failed file(s) remain; fix only the failed file(s) and re-run verify."
      );
    }
    return {
      text: truncateWithByteNotice(
        partialParts.join("\n\n"),
        DEFAULT_INLINE_MAX_BYTES
      ),
      isError: true
    };
  }
  const header = input.dryRun ? `Dry run validated ${plans.length} file(s) (0 files modified):` : `Applied edits to ${plans.length} file(s):`;
  const parts = [`${header}
${summaryLines.join("\n")}`];
  let verifyResult = null;
  if (!input.dryRun && verifySpec) {
    const verifyCwd = verifySpec.cwd ? resolvePath(verifySpec.cwd, baseCwd) : baseCwd;
    const requestedTimeoutMs =
      clampIntWithDefault(
        verifySpec.timeoutSec ?? input.verifyTimeoutSec,
        60,
        1,
        MAX_MCP_CALL_BUDGET_SEC
      ) * 1e3;
    const remainingMs = callDeadline - perfNode.now();
    if (remainingMs < 500) {
      parts.push(
        `\nVerify [NOT RUN: ${MAX_MCP_CALL_BUDGET_SEC}s MCP call budget exhausted] \`${verifySpec.command}\``
      );
    } else {
      const timeoutMs = Math.max(100, Math.min(requestedTimeoutMs, Math.floor(remainingMs)));
      const maxVerifyChars = clampIntWithDefault(
        input.maxVerifyChars,
        4e3,
        300,
        7500
      );
      const res = await runShellCommandAsync(verifySpec.command, {
        cwd: verifyCwd,
        timeoutMs
      });
      BATCH_SEARCH_CACHE.clear();
      const status = res.timedOut ? "TIMEOUT" : res.exitCode === 0 ? "PASS" : `FAIL (exit ${res.exitCode ?? "err"})`;
      const verifyHeader = `\nVerify [${status} in ${res.durationMs}ms] \`${verifySpec.command}\`:\n`;
      const verifyBytes = DEFAULT_INLINE_MAX_BYTES - Buffer.byteLength(parts.join("\n")) - 1 - Buffer.byteLength(verifyHeader);
      const formatted = formatCompactCommandOutput({
        stdout: res.stdout,
        stderr: res.stderr,
        exitCode: res.exitCode,
        timedOut: res.timedOut,
        error: res.error,
        maxChars: maxVerifyChars,
        maxBytes: Math.max(0, verifyBytes),
        passingTest: res.exitCode === 0 && isRecognizedTestCheck(verifySpec.command, verifyCwd)
      });
      const combinedVerifyOutput = [
        normalizeTerminalOutput(res.stdout),
        normalizeTerminalOutput(res.stderr),
        res.error ? `spawn error: ${res.error}` : ""
      ]
        .filter(Boolean)
        .join("\n");
      verifyResult = {
        command: verifySpec.command,
        exitCode: res.exitCode,
        timedOut: Boolean(res.timedOut),
        error: res.error || "",
        durationMs: res.durationMs || 0,
        status,
        summaryLine: `Verify [${status} in ${res.durationMs}ms] \`${verifySpec.command}\`:`,
        output: combinedVerifyOutput || formatted
      };
      parts.push(verifyHeader + formatted);
    }
  }
  const outText = parts.join("\n");
  const finalText = truncateWithByteNotice(outText, DEFAULT_INLINE_MAX_BYTES);
  return {
    text: finalText,
    isError: false,
    ...(verifySpec && !input.dryRun ? { verifyWorktree: baseCwd, ...(verifyResult ? { verifyResult } : {}) } : {})
  };
}

// src/tools/batch-search.ts
import { promises as fs3 } from "node:fs";
import path3 from "node:path";
var READONLY_GIT_SUBCOMMANDS = /* @__PURE__ */ new Set([
  "status",
  "diff",
  "log",
  "show",
  "branch",
  "rev-parse",
  "ls-files",
  "blame",
  "shortlog",
  "describe",
  "tag",
  "remote"
]);
var SAFE_GIT_CONFIG_ARGS = Object.freeze([
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=",
  "-c",
  "diff.external=",
  "-c",
  "gpg.program=false",
  "-c",
  "gpg.openpgp.program=false",
  "-c",
  "gpg.ssh.program=false",
  "-c",
  "gpg.x509.program=false"
]);
var FORBIDDEN_GIT_GLOBAL_FLAGS = /* @__PURE__ */ new Set([
  "-c",
  "--config",
  "--config-env",
  "--exec-path",
  "--ext-diff",
  "--textconv",
  "--no-index",
  "--contents",
  "--output",
  "--exec",
  "--upload-pack",
  "--git-dir",
  "--work-tree"
]);
var ALLOWED_BRANCH_BOOL_FLAGS = /* @__PURE__ */ new Set([
  "--all",
  "--remotes",
  "--verbose",
  "--list",
  "--show-current",
  "--no-abbrev",
  "--no-color",
  "--ignore-case",
  "--omit-empty",
  "--no-column",
  "--quiet"
]);
var ALLOWED_BRANCH_OPTARG_FLAGS = /* @__PURE__ */ new Set([
  "--abbrev",
  "--color",
  "--column"
]);
var ALLOWED_BRANCH_OPTIONAL_VALUE_FLAGS = /* @__PURE__ */ new Set([
  "--merged",
  "--no-merged",
  "--contains",
  "--no-contains"
]);
var ALLOWED_BRANCH_VALUE_FLAGS = /* @__PURE__ */ new Set([
  "--points-at",
  "--sort",
  "--format"
]);
var ALLOWED_BRANCH_SHORT_CHARS = /* @__PURE__ */ new Set(["a", "r", "v", "l", "q", "i"]);
var ALLOWED_TAG_BOOL_FLAGS = /* @__PURE__ */ new Set([
  "--list",
  "--no-color",
  "--ignore-case",
  "--omit-empty",
  "--no-column"
]);
var ALLOWED_TAG_OPTARG_FLAGS = /* @__PURE__ */ new Set([
  "--color",
  "--column"
]);
var ALLOWED_TAG_OPTIONAL_VALUE_FLAGS = /* @__PURE__ */ new Set([
  "--merged",
  "--no-merged",
  "--contains",
  "--no-contains",
  "--points-at"
]);
var ALLOWED_TAG_VALUE_FLAGS = /* @__PURE__ */ new Set([
  "--sort",
  "--format"
]);
var ALLOWED_TAG_SHORT_CHARS = /* @__PURE__ */ new Set(["l", "i"]);
var ALLOWED_REMOTE_SUBCOMMANDS = /* @__PURE__ */ new Set(["show", "get-url"]);
function tokenizeArgs(input) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escape = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (escape) {
      current += ch;
      escape = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      const next = input[i + 1];
      if (quote === '"') {
        if (next === '"' || (next === "\\" && input[i + 2] === '"')) {
          escape = true;
          continue;
        }
      } else if (next === '"' || next === "'" || (next !== void 0 && /\s/.test(next))) {
        escape = true;
        continue;
      }
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (quote) {
    throw new Error("Unterminated quote in git query");
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}
function validateReadonlyGitArgs(pattern) {
  const rawTokens = tokenizeArgs(pattern.trim());
  const tokens = rawTokens[0] === "git" ? rawTokens.slice(1) : rawTokens;
  if (tokens.length === 0) {
    throw new Error("Empty git query. Example: 'status --short' or 'log -n 5 --oneline'");
  }
  const subcmd = tokens[0];
  if (subcmd.startsWith("-")) {
    throw new Error(
      `Git query must start with a read-only subcommand (got '${subcmd}')`
    );
  }
  if (!READONLY_GIT_SUBCOMMANDS.has(subcmd)) {
    throw new Error(
      `Git subcommand '${subcmd}' is not allowed in batch_search (read-only only: ${[...READONLY_GIT_SUBCOMMANDS].join(", ")})`
    );
  }
  const rest = tokens.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const prev = i > 0 ? rest[i - 1] : "";
    const isSortOrFormatVal = prev === "--sort" || prev === "--format";
    const flagName = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (
      FORBIDDEN_GIT_GLOBAL_FLAGS.has(flagName) ||
      flagName.startsWith("--ext") ||
      flagName.startsWith("--textc") ||
      arg.startsWith("--output=") ||
      (!isSortOrFormatVal && arg.startsWith("-c") && arg.length > 2)
    ) {
      throw new Error(`Flag '${arg}' is not allowed in read-only git query`);
    }
  }
  if (subcmd === "status") {
    for (const arg of rest) {
      if (arg === "--") break;
      if (
        arg === "--verbose" ||
        arg.startsWith("--verbose=") ||
        (arg.startsWith("-") && !arg.startsWith("--") && arg.slice(1).includes("v"))
      ) {
        throw new Error(`Flag '${arg}' is not allowed in read-only git status query`);
      }
    }
  }
  if (subcmd === "branch") {
    let hasListFlag = false;
    let expectValueFor = null;
    let optionalValueFor = null;
    for (const arg of rest) {
      if (expectValueFor) {
        if (arg.startsWith("-") && expectValueFor !== "--sort" && expectValueFor !== "--format") {
          throw new Error(`Flag '${arg}' is not allowed as value for '${expectValueFor}' in read-only git branch query`);
        }
        expectValueFor = null;
        continue;
      }
      if (optionalValueFor) {
        optionalValueFor = null;
        if (!arg.startsWith("-")) {
          continue;
        }
      }
      if (arg === "--") {
        if (!hasListFlag) {
          throw new Error(
            "Positional branch arguments are only allowed with --list in read-only mode"
          );
        }
        break;
      }
      if (arg.startsWith("--")) {
        const eqIdx = arg.indexOf("=");
        const flagName = eqIdx !== -1 ? arg.slice(0, eqIdx) : arg;
        if (eqIdx !== -1) {
          if (
            !ALLOWED_BRANCH_OPTARG_FLAGS.has(flagName) &&
            !ALLOWED_BRANCH_OPTIONAL_VALUE_FLAGS.has(flagName) &&
            !ALLOWED_BRANCH_VALUE_FLAGS.has(flagName)
          ) {
            throw new Error(`Flag '${arg}' is not allowed in read-only git branch query`);
          }
        } else if (ALLOWED_BRANCH_OPTARG_FLAGS.has(flagName)) {
          // PARSE_OPT_OPTARG flags without '=' never consume a separate token in git
        } else if (ALLOWED_BRANCH_OPTIONAL_VALUE_FLAGS.has(flagName)) {
          optionalValueFor = flagName;
        } else if (ALLOWED_BRANCH_VALUE_FLAGS.has(flagName)) {
          expectValueFor = flagName;
        } else if (!ALLOWED_BRANCH_BOOL_FLAGS.has(flagName)) {
          throw new Error(`Flag '${arg}' is not allowed in read-only git branch query`);
        }
        if (flagName === "--list") hasListFlag = true;
      } else if (arg.startsWith("-") && arg.length > 1) {
        for (const ch of arg.slice(1)) {
          if (!ALLOWED_BRANCH_SHORT_CHARS.has(ch)) {
            throw new Error(`Flag '${arg}' is not allowed in read-only git branch query`);
          }
          if (ch === "l") hasListFlag = true;
        }
      } else if (!hasListFlag) {
        throw new Error(
          `Positional branch argument '${arg}' is only allowed with --list in read-only mode`
        );
      }
    }
  } else if (subcmd === "tag") {
    let allowsPositionals = false;
    let expectValueFor = null;
    let optionalValueFor = null;
    for (const arg of rest) {
      if (expectValueFor) {
        if (arg.startsWith("-") && expectValueFor !== "--sort" && expectValueFor !== "--format") {
          throw new Error(`Flag '${arg}' is not allowed as value for '${expectValueFor}' in read-only git tag query`);
        }
        expectValueFor = null;
        continue;
      }
      if (optionalValueFor) {
        optionalValueFor = null;
        if (!arg.startsWith("-")) {
          continue;
        }
      }
      if (arg === "--") {
        if (!allowsPositionals) {
          throw new Error(
            "Positional tag arguments are only allowed with --list in read-only mode"
          );
        }
        break;
      }
      if (arg.startsWith("--")) {
        const eqIdx = arg.indexOf("=");
        const flagName = eqIdx !== -1 ? arg.slice(0, eqIdx) : arg;
        if (eqIdx !== -1) {
          if (
            !ALLOWED_TAG_OPTARG_FLAGS.has(flagName) &&
            !ALLOWED_TAG_OPTIONAL_VALUE_FLAGS.has(flagName) &&
            !ALLOWED_TAG_VALUE_FLAGS.has(flagName)
          ) {
            throw new Error(`Flag '${arg}' is not allowed in read-only git tag query`);
          }
        } else if (ALLOWED_TAG_OPTARG_FLAGS.has(flagName)) {
          // PARSE_OPT_OPTARG flags without '=' never consume a separate token in git
        } else if (ALLOWED_TAG_OPTIONAL_VALUE_FLAGS.has(flagName)) {
          optionalValueFor = flagName;
        } else if (ALLOWED_TAG_VALUE_FLAGS.has(flagName)) {
          expectValueFor = flagName;
        } else if (!ALLOWED_TAG_BOOL_FLAGS.has(flagName)) {
          throw new Error(`Flag '${arg}' is not allowed in read-only git tag query`);
        }
        if (flagName === "--list") {
          allowsPositionals = true;
        }
      } else if (arg.startsWith("-") && arg.length > 1) {
        if (/^-n\d*$/.test(arg)) {
          allowsPositionals = true;
        } else {
          for (const ch of arg.slice(1)) {
            if (!ALLOWED_TAG_SHORT_CHARS.has(ch)) {
              throw new Error(`Flag '${arg}' is not allowed in read-only git tag query`);
            }
            if (ch === "l") allowsPositionals = true;
          }
        }
      } else if (!allowsPositionals) {
        throw new Error(
          `Positional tag argument '${arg}' is only allowed with --list in read-only mode`
        );
      }
    }
  } else if (subcmd === "remote") {
    let remoteSubcmd = null;
    let hasOfflineFlag = false;
    for (const arg of rest) {
      if (!remoteSubcmd) {
        if (arg === "-v" || arg === "--verbose") continue;
        if (arg.startsWith("-")) {
          throw new Error(`Flag '${arg}' is not allowed in read-only git remote query`);
        }
        if (!ALLOWED_REMOTE_SUBCOMMANDS.has(arg)) {
          throw new Error(`Mutating git remote subcommand '${arg}' is not allowed`);
        }
        remoteSubcmd = arg;
      } else if (arg.startsWith("-")) {
        const okFlag = remoteSubcmd === "show" && arg === "-n" || remoteSubcmd === "get-url" && (arg === "--push" || arg === "--all");
        if (!okFlag) {
          throw new Error(
            `Flag '${arg}' is not allowed for read-only git remote ${remoteSubcmd}`
          );
        }
        if (arg === "-n") hasOfflineFlag = true;
      } else {
        if (!/^[A-Za-z0-9._-]+$/.test(arg) || arg === "." || arg === "..") {
          throw new Error(
            `Remote name '${arg}' is invalid or disallowed URL/path in read-only git remote ${remoteSubcmd}`
          );
        }
      }
    }
    if (remoteSubcmd === "show" && !hasOfflineFlag) {
      const showIdx = rest.indexOf("show");
      if (showIdx !== -1) rest.splice(showIdx + 1, 0, "-n");
    }
  }
  if (subcmd === "diff" || subcmd === "log" || subcmd === "show" || subcmd === "shortlog") {
    return ["--no-pager", subcmd, "--no-ext-diff", "--no-textconv", ...rest];
  }
  if (subcmd === "blame") {
    return ["--no-pager", subcmd, "--no-textconv", ...rest];
  }
  return ["--no-pager", subcmd, ...rest];
}
// src/utils/fuzzy-match.ts
function findContiguousIndex(haystack, needle) {
  const maxStart = haystack.length - needle.length;
  for (let start = 0; start <= maxStart; start++) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[start + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return start;
  }
  return -1;
}
function isAscii(text) {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) return false;
  }
  return true;
}
function subsequenceCost(needle, haystack) {
  if (!needle) return 2147483647;
  if (isAscii(needle) && isAscii(haystack)) {
    const query2 = needle.toLowerCase();
    const lowered2 = haystack.toLowerCase();
    const contiguousAt2 = lowered2.indexOf(query2);
    if (contiguousAt2 >= 0) {
      return contiguousAt2 === 0 ? -100 : -60 + Math.min(25, contiguousAt2);
    }
    let cursor2 = 0;
    let first2 = -1;
    let last2 = -1;
    const hLen = lowered2.length;
    for (let i = 0; i < query2.length; i++) {
      const targetCode = query2.charCodeAt(i);
      while (cursor2 < hLen && lowered2.charCodeAt(cursor2) !== targetCode) cursor2++;
      if (cursor2 === hLen) return void 0;
      if (first2 < 0) first2 = cursor2;
      last2 = cursor2++;
    }
    return Math.max(0, last2 - first2 + 1 - query2.length) - (first2 === 0 ? 20 : 0);
  }
  const lowered = [...haystack.toLowerCase()];
  const query = [...needle.toLowerCase()];
  const contiguousAt = findContiguousIndex(lowered, query);
  if (contiguousAt >= 0) {
    return contiguousAt === 0 ? -100 : -60 + Math.min(25, contiguousAt);
  }
  let cursor = 0;
  let first = -1;
  let last = -1;
  for (const ch of query) {
    while (cursor < lowered.length && lowered[cursor] !== ch) cursor++;
    if (cursor === lowered.length) return void 0;
    if (first < 0) first = cursor;
    last = cursor++;
  }
  return Math.max(0, last - first + 1 - query.length) - (first === 0 ? 20 : 0);
}
function scoreSubsequence(query, target) {
  const cost = subsequenceCost(query, target);
  return cost === void 0 ? -1 : Math.max(1, 1e3 - cost);
}
function fuzzyScorePath(query, candidatePosix) {
  const trimmed = query.trim().replace(/\\/g, "/");
  if (!trimmed) return -1;
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const slashIdx = candidatePosix.lastIndexOf("/");
  const basename = slashIdx === -1 ? candidatePosix : candidatePosix.slice(slashIdx + 1);
  let totalScore = 0;
  for (const token of tokens) {
    const fullScore = scoreSubsequence(token, candidatePosix);
    if (fullScore < 0) return -1;
    const baseScore = !token.includes("/") ? scoreSubsequence(token, basename) : -1;
    totalScore += baseScore >= 0 ? Math.max(fullScore, baseScore + 45) : fullScore;
    if (basename.toLowerCase() === token.toLowerCase()) totalScore += 60;
  }
  return totalScore;
}
function rankFuzzyPaths(query, candidates, maxResults) {
  const scored = [];
  for (const candidate of candidates) {
    const score = fuzzyScorePath(query, candidate);
    if (score >= 0) scored.push({ path: candidate, score });
  }
  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    matches: scored.slice(0, maxResults),
    totalMatched: scored.length
  };
}
var FILE_TYPE_GLOBS = {
  ts: ["*.ts", "*.tsx", "*.mts", "*.cts"],
  typescript: ["*.ts", "*.tsx", "*.mts", "*.cts"],
  js: ["*.js", "*.jsx", "*.mjs", "*.cjs"],
  javascript: ["*.js", "*.jsx", "*.mjs", "*.cjs"],
  py: ["*.py", "*.pyi"],
  python: ["*.py", "*.pyi"],
  go: ["*.go"],
  gd: ["*.gd"],
  gdscript: ["*.gd"],
  rust: ["*.rs"],
  rs: ["*.rs"],
  java: ["*.java"],
  kt: ["*.kt", "*.kts"],
  kotlin: ["*.kt", "*.kts"],
  c: ["*.c", "*.h"],
  cpp: ["*.cc", "*.cpp", "*.cxx", "*.hpp", "*.hh", "*.hxx", "*.h"],
  cs: ["*.cs"],
  csharp: ["*.cs"],
  swift: ["*.swift"],
  rb: ["*.rb"],
  ruby: ["*.rb"],
  php: ["*.php"],
  css: ["*.css", "*.scss", "*.sass", "*.less"],
  html: ["*.html", "*.htm"],
  vue: ["*.vue"],
  svelte: ["*.svelte"],
  md: ["*.md", "*.mdx", "*.markdown"],
  markdown: ["*.md", "*.mdx", "*.markdown"],
  json: ["*.json", "*.jsonc"],
  yaml: ["*.yml", "*.yaml"],
  yml: ["*.yml", "*.yaml"],
  toml: ["*.toml"],
  xml: ["*.xml"],
  sql: ["*.sql"],
  sh: ["*.sh", "*.bash", "*.zsh"],
  shell: ["*.sh", "*.bash", "*.zsh"]
};
function resolveFileTypeGlobs(fileType) {
  if (fileType === void 0) return null;
  if (typeof fileType !== "string") throw new Error("fileType must be a string");
  const key = fileType.trim().toLowerCase().replace(/^\./, "");
  if (!key) return null;
  const mapped = FILE_TYPE_GLOBS[key];
  if (Object.hasOwn(FILE_TYPE_GLOBS, key)) return mapped;
  if (/^[a-z0-9]+$/i.test(key)) return [`*.${key}`];
  throw new Error(`Unsupported fileType '${fileType}'`);
}
function fileTypeMatcher(fileType) {
  const matchers = (resolveFileTypeGlobs(fileType) ?? []).map(globToRegExp);
  return (file) => matchers.length === 0 || matchers.some((matcher) => matcher.test(path3.basename(file)));
}
async function runTextOrRegexWithRg(query, searchRoot, baseCwd) {
  const maxResults = clampInt(query.maxResults ?? 40, 1, 200);
  const contextLines = clampInt(query.contextLines ?? 0, 0, 5);
  const summary = query.outputMode === "count" || query.outputMode === "files_with_matches";
  const typeGlobs = resolveFileTypeGlobs(query.fileType);
  const matchesType = fileTypeMatcher(query.fileType);
  const fileStat = await fs3.stat(searchRoot);
  const isFileTarget = fileStat.isFile();
  if (isFileTarget) {
    if (checkSensitiveFastPath(searchRoot) || (typeGlobs && !matchesType(searchRoot))) {
      return { files: [], totalMatches: 0, truncated: false };
    }
    if (fileStat.size > 2 * 1024 * 1024) {
      return { files: [], totalMatches: 0, truncated: false };
    }
    if (query.glob) {
      const negated = query.glob.startsWith("!");
      const rawGlob = negated ? query.glob.slice(1) : query.glob;
      const globRe = globToRegExp(rawGlob);
      const relPosix = relativeFile(baseCwd, searchRoot);
      const matched = globRe.test(relPosix) || globRe.test(path3.basename(searchRoot));
      if (negated ? matched : !matched) {
        return { files: [], totalMatches: 0, truncated: false };
      }
    }
    const fh = await fs3.open(searchRoot, "r");
    try {
      const head = Buffer.alloc(Math.min(fileStat.size, 8192));
      const { bytesRead } = await fh.read(head, 0, head.length, 0);
      if (isLikelyBinary(head.subarray(0, bytesRead))) {
        return { files: [], totalMatches: 0, truncated: false };
      }
    } finally {
      await fh.close();
    }
  }
  const perFileCap = isFileTarget ? maxResults : Math.min(maxResults, 50);
  const args = ["--no-config", "--no-messages", "--max-filesize", "2M", "--crlf"];
  if (query.multiline) args.push("--multiline", "--multiline-dotall");
  if (typeGlobs) {
    for (const glob of typeGlobs) args.push("--type-add", `agyfilter:${glob}`);
    args.push("--type", "agyfilter");
  }
  if (query.type === "text") {
    args.push("--fixed-strings");
  }
  if (query.caseSensitive === false) {
    args.push("--ignore-case");
  }
  if (query.glob) {
    if (query.glob.startsWith(".") || query.glob.includes("/.")) args.push("--hidden");
    args.push(`--glob=${query.glob}`);
  }
  const normRoot = toPosixPath(searchRoot);
  for (const dir of [
    "node_modules",
    ".git",
    "dist",
    "build",
    "target",
    "coverage",
    "__pycache__",
    ".venv",
    ".next"
  ]) {
    if (!normRoot.split("/").includes(dir)) {
      args.push(`--glob=!**/${dir}/**`);
    }
  }
  const runRg = async (runArgs, opts) => {
    const res = await execBinaryAsync("rg", runArgs, {
      cwd: baseCwd,
      timeoutMs: 15e3,
      maxOutputBytes: 2 * 1024 * 1024
    });
    if (res.error) {
      throw new Error(`rg spawn error: ${res.error}`);
    }
    if (res.exitCode === 2 && !(opts?.allowPartialError && !res.stderr.trim())) {
      throw new Error(res.stderr.trim() || `rg failed for pattern: ${query.pattern}`);
    }
    return res;
  };
  const cutShort = (res) => res.truncated || res.timedOut || res.exitCode === null;
  if (summary) {
    const res = await runRg([
      ...args,
      ...query.outputMode === "count" ? [query.multiline ? "--count-matches" : "--count", "--with-filename", "--null"] : ["--files-with-matches", "--null"],
      "--",
      query.pattern,
      searchRoot
    ]);
    const files2 = [];
    const out = res.stdout;
    let pos = 0;
    while (pos < out.length) {
      const nul = out.indexOf("\0", pos);
      if (nul === -1) break;
      const rawFile = out.slice(pos, nul);
      let count = 0;
      if (query.outputMode === "count") {
        const nl = out.indexOf("\n", nul + 1);
        if (nl === -1) break;
        const rawCount = out.slice(nul + 1, nl).trim();
        count = Number(rawCount);
        pos = nl + 1;
      } else {
        pos = nul + 1;
      }
      if (!rawFile || !matchesType(rawFile) || checkSensitiveFastPath(path3.resolve(baseCwd, rawFile))) continue;
      files2.push({ file: relativeFile(baseCwd, rawFile), lines: [], count: Number.isFinite(count) ? count : 0 });
    }
    files2.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
    return {
      files: files2.slice(0, maxResults),
      totalMatches: 0,
      truncated: files2.length > maxResults || cutShort(res)
    };
  }
  const maxCountArgs = query.multiline ? [] : ["--max-count", String(perFileCap + 1)];
  let chosen;
  let truncated = false;
  if (isFileTarget) {
    chosen = [
      {
        rawFile: searchRoot,
        relFile: relativeFile(baseCwd, searchRoot),
        count: Number.POSITIVE_INFINITY
      }
    ];
  } else {
    const counts = await runRg([
      ...args,
      ...maxCountArgs,
      "--count",
      "--with-filename",
      "--null",
      "--",
      query.pattern,
      searchRoot
    ]);
    const counted = [];
    for (const record of counts.stdout.split("\n").slice(0, -1)) {
      const sep = record.lastIndexOf("\0");
      const count = Number(record.slice(sep + 1));
      if (sep <= 0 || !Number.isInteger(count) || count <= 0) continue;
      const rawFile = record.slice(0, sep);
      if (!matchesType(rawFile) || checkSensitiveFastPath(path3.resolve(baseCwd, rawFile))) continue;
      counted.push({ rawFile, relFile: relativeFile(baseCwd, rawFile), count });
    }
    counted.sort((a, b) => a.relFile < b.relFile ? -1 : a.relFile > b.relFile ? 1 : 0);
    chosen = [];
    let coveredMatches = 0;
    for (const item of counted) {
      if (coveredMatches >= maxResults) break;
      chosen.push(item);
      coveredMatches += query.multiline ? item.count : Math.min(item.count, perFileCap);
    }
    truncated = cutShort(counts) || chosen.length < counted.length;
    if (chosen.length === 0) {
      return { files: [], totalMatches: 0, truncated };
    }
  }
  const toRgArgPath = (rawFile) => {
    const rel = path3.relative(baseCwd, rawFile);
    const chosenPath = rel && !rel.startsWith("..") && !path3.isAbsolute(rel) ? rel : rawFile;
    return chosenPath === "-" ? `.${path3.sep}-` : chosenPath;
  };
  const rgChunks = [];
  let currentChunk = [];
  let currentChunkChars = 0;
  const maxArgChars = 2e4;
  for (const item of chosen) {
    const argPath = toRgArgPath(item.rawFile);
    const est = argPath.length + 3;
    if (currentChunk.length > 0 && currentChunkChars + est > maxArgChars) {
      rgChunks.push(currentChunk);
      currentChunk = [];
      currentChunkChars = 0;
    }
    currentChunk.push(argPath);
    currentChunkChars += est;
  }
  if (currentChunk.length > 0) rgChunks.push(currentChunk);
  const byFile = /* @__PURE__ */ new Map();
  for (const chunk of rgChunks) {
    const res = await runRg(
      [
        ...args,
        ...maxCountArgs,
        "--json",
        ...contextLines > 0 ? ["-C", String(contextLines)] : [],
        "--",
        query.pattern,
        ...chunk
      ],
      { allowPartialError: !isFileTarget }
    );
    if (cutShort(res)) truncated = true;
    for (const rawLine of res.stdout.split("\n")) {
      if (!rawLine.trim()) continue;
      let ev;
      try {
        ev = JSON.parse(rawLine);
      } catch {
        continue;
      }
      if (ev.type !== "match" && ev.type !== "context") continue;
      const rawFile = ev.data?.path?.text ?? (ev.data?.path?.bytes ? Buffer.from(ev.data.path.bytes, "base64").toString("utf8") : void 0);
      const lineNumber = ev.data?.line_number;
      const rawBuf = ev.data?.lines?.bytes ? Buffer.from(ev.data.lines.bytes, "base64") : null;
      const rawText = ev.data?.lines?.text ?? (rawBuf ? rawBuf.toString("utf8") : "");
      if (!rawFile || typeof lineNumber !== "number") continue;
      const relFile = relativeFile(baseCwd, rawFile);
      let lineMap = byFile.get(relFile);
      if (!lineMap) {
        lineMap = /* @__PURE__ */ new Map();
        byFile.set(relFile, lineMap);
      }
      const isMatch = ev.type === "match";
      const lineText = rawText.replace(/\r?\n$/, "");
      const segments = isMatch && query.multiline ? lineText.split(/\r?\n/) : [lineText];
      // rg's offsets are UTF-8 bytes within the entire event, including CRLF.
      // Only long matching lines need conversion to JavaScript string offsets.
      const submatches = ev.data.submatches ?? [];
      const bytes = isMatch && submatches.length && segments.some(s => s.length > SEARCH_LINE_CHARS)
        ? rawBuf ?? Buffer.from(rawText)
        : null;
      let byteStart = 0;
      let hitIndex = 0;
      for (const [offset, text] of segments.entries()) {
        const line = lineNumber + offset;
        const entry = { lineNumber: line, text, isMatch };
        if (bytes) {
          const lf = bytes.indexOf(10, byteStart);
          const byteEnd = lf === -1 ? bytes.length : lf;
          while (hitIndex < submatches.length &&
                 submatches[hitIndex].start < byteStart && submatches[hitIndex].end <= byteStart) {
            hitIndex++;
          }
          const hit = submatches[hitIndex];
          if (text.length > SEARCH_LINE_CHARS && hit && hit.start <= byteEnd) {
            const from = Math.max(byteStart, hit.start);
            const to = Math.min(byteEnd, hit.end);
            entry.matchStart = bytes.toString("utf8", byteStart, from).length;
            entry.matchEnd = entry.matchStart + bytes.toString("utf8", from, to).length;
          }
          byteStart = byteEnd + 1;
        }
        if (!lineMap.get(line)?.isMatch) lineMap.set(line, entry);
      }
    }
  }
  const files = [];
  let totalMatches = 0;
  for (const { relFile, count } of chosen) {
    if (totalMatches >= maxResults) {
      truncated = true;
      break;
    }
    const fileCap = query.multiline ? maxResults : Math.min(count, perFileCap);
    const budget = Math.min(fileCap, maxResults - totalMatches);
    const sorted = [...byFile.get(relFile)?.values() ?? []].sort(
      (a, b) => a.lineNumber - b.lineNumber
    );
    const lines = [];
    let kept = 0;
    let lastKeptMatchLine = -1;
    for (const line of sorted) {
      if (line.isMatch) {
        if (kept === budget) {
          truncated = true;
          if (lastKeptMatchLine !== -1 && line.lineNumber <= lastKeptMatchLine + contextLines) {
            lines.push({ lineNumber: line.lineNumber, text: line.text, isMatch: false });
          }
          continue;
        }
        kept += 1;
        lastKeptMatchLine = line.lineNumber;
        lines.push(line);
      } else if (kept < budget || line.lineNumber <= lastKeptMatchLine + contextLines) {
        lines.push(line);
      }
    }
    if (kept === 0) continue;
    files.push({ file: relFile, lines });
    totalMatches += kept;
  }
  return { files, totalMatches, truncated };
}
function* multilineMatches(content, regex) {
  let previousEnd = -1;
  for (const match of content.matchAll(regex)) {
    const start = match.index;
    if (start === content.length && (content.length === 0 || content.endsWith("\n"))) break;
    if (match[0] === "") {
      if (start === previousEnd || content[start - 1] === "\r" && content[start] === "\n") continue;
    }
    previousEnd = start + match[0].length;
    yield match;
  }
}
function multilineMatchLines(content, regex, limit) {
  const results = [];
  let line = 0;
  let lineStart = 0;
  let nextBreak = content.indexOf("\n");
  for (const match of multilineMatches(content, regex)) {
    const start = match.index;
    const end = start + Math.max(0, match[0].length - 1);
    while (nextBreak !== -1 && nextBreak < start) {
      line++;
      lineStart = nextBreak + 1;
      nextBreak = content.indexOf("\n", lineStart);
    }
    while (true) {
      if (results.at(-1)?.lineIndex !== line) {
        results.push({
          lineIndex: line,
          matchStart: Math.max(0, start - lineStart),
          matchEnd: Math.max(0, start + match[0].length - lineStart)
        });
      }
      if (results.length >= limit) return results;
      if (nextBreak === -1 || nextBreak >= end) break;
      line++;
      lineStart = nextBreak + 1;
      nextBreak = content.indexOf("\n", lineStart);
    }
  }
  return results;
}
async function runTextOrRegexWithNode(query, searchRoot, baseCwd) {
  const maxResults = clampInt(query.maxResults ?? 40, 1, 200);
  const contextLines = clampInt(query.contextLines ?? 0, 0, 5);
  const flags = (query.caseSensitive === false ? "i" : "") + (query.multiline ? "gmsu" : "");
  let regex;
  if (query.type === "regex") {
    if (!isSafeRegex(query.pattern)) throw new Error("Unsafe regex: rejected to prevent catastrophic backtracking");
    try {
      regex = new RegExp(query.pattern, flags);
    } catch (err) {
      if (flags.includes("u")) {
        try {
          regex = new RegExp(query.pattern, flags.replace("u", ""));
        } catch {
          throw new Error(
            `Invalid regex '${query.pattern}': ${err instanceof Error ? err.message : String(err)}`
          );
        }
      } else {
        throw new Error(
          `Invalid regex '${query.pattern}': ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  } else {
    const escaped = query.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    regex = new RegExp(escaped, flags);
  }
  const summary = query.outputMode === "count" || query.outputMode === "files_with_matches";
  const matchesType = fileTypeMatcher(query.fileType);
  let discoveryTruncated = false;
  const globNegated = Boolean(query.glob && query.glob.startsWith("!"));
  const rawGlob = query.glob ? globNegated ? query.glob.slice(1) : query.glob : null;
  const globRegex = rawGlob ? globToRegExp(rawGlob) : null;
  const globMatchesFile = (relPosix) => {
    if (!matchesType(relPosix)) return false;
    if (!globRegex) return true;
    let matched = globRegex.test(relPosix);
    if (!matched && !rawGlob.includes("/")) {
      const base = relPosix.split("/").pop() ?? relPosix;
      matched = globRegex.test(base);
    }
    return globNegated ? !matched : matched;
  };
  const stat = await fs3.stat(searchRoot);
  const perFileCap = stat.isFile() ? maxResults : Math.min(maxResults, 50);
  let targetFiles;
  if (stat.isFile()) {
    const relPosix = toPosixPath(path3.relative(baseCwd, searchRoot)) || path3.basename(searchRoot);
    targetFiles = globMatchesFile(relPosix) ? [searchRoot] : [];
  } else {
    const includeHidden = Boolean(
      rawGlob && !globNegated && (rawGlob.startsWith(".") || rawGlob.includes("/."))
    );
    const walked = await walkFiles(searchRoot, {
      maxFiles: 8e3,
      includeHidden,
      fileFilter: globMatchesFile
    });
    discoveryTruncated = walked.truncated;
    targetFiles = walked.files.map((rel) => path3.join(searchRoot, rel));
    targetFiles.sort((a, b) => {
      const ra = relativeFile(baseCwd, a);
      const rb = relativeFile(baseCwd, b);
      return ra < rb ? -1 : ra > rb ? 1 : 0;
    });
  }
  const files = [];
  let totalMatches = 0;
  let truncated = false;
  const buildFileMatches = (relFile, allLines, keptMatches) => {
    const lineMap = /* @__PURE__ */ new Map();
    for (const { lineIndex: mIdx, matchStart, matchEnd } of keptMatches) {
      const from = Math.max(0, mIdx - contextLines);
      const to = Math.min(allLines.length - 1, mIdx + contextLines);
      for (let j = from; j <= to; j++) {
        const ln = j + 1;
        const prev = lineMap.get(ln);
        if (j === mIdx) {
          if (!prev?.isMatch) {
            lineMap.set(ln, {
              lineNumber: ln,
              text: allLines[j],
              isMatch: true,
              matchStart,
              matchEnd
            });
          }
        } else if (!prev) {
          lineMap.set(ln, {
            lineNumber: ln,
            text: allLines[j],
            isMatch: false
          });
        }
      }
    }
    return {
      file: relFile,
      lines: [...lineMap.values()].sort((a, b) => a.lineNumber - b.lineNumber)
    };
  };
  const batchSize = 16;
  let anyFileTruncated = false;
  for (let i = 0; i < targetFiles.length && !truncated; i += batchSize) {
    const batch = targetFiles.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (absFile) => {
        try {
          if (checkSensitiveFastPath(absFile)) return null;
          const st = await fs3.stat(absFile);
          if (st.size > 2 * 1024 * 1024) return null;
          const buf = await fs3.readFile(absFile);
          if (isLikelyBinary(buf)) return null;
          const content = buf.toString("utf8");
          const lines = content.split(/\r?\n/);
          if (lines.length > 0 && lines.at(-1) === "") lines.pop();
          const relFile = relativeFile(baseCwd, absFile);
          let matchedLines = [];
          let count = 0;
          let fileTruncated = false;
          if (query.multiline && summary) {
            for (const _match of multilineMatches(content, regex)) {
              count++;
              if (query.outputMode === "files_with_matches") break;
            }
          } else if (query.multiline) {
            matchedLines = multilineMatchLines(content, regex, maxResults + 1);
            count = matchedLines.length;
          } else {
            for (let idx = 0; idx < lines.length; idx++) {
              const line = lines[idx];
              const hit = summary ? regex.test(line) : regex.exec(line);
              if (!hit) continue;
              count++;
              if (query.outputMode === "files_with_matches") break;
              if (summary) continue;
              if (matchedLines.length === perFileCap) {
                fileTruncated = true;
                break;
              }
              matchedLines.push({ lineIndex: idx, matchStart: hit.index, matchEnd: hit.index + hit[0].length });
            }
          }
          return count ? { relFile, lines, matchedLines, count, fileTruncated } : null;
        } catch {
          return null;
        }
      })
    );
    for (const item of results) {
      if (!item) continue;
      if (summary) {
        if (files.length === maxResults) {
          truncated = true;
          break;
        }
        files.push({ file: item.relFile, lines: [], count: item.count });
        continue;
      }
      if (item.fileTruncated) {
        anyFileTruncated = true;
      }
      if (totalMatches + item.matchedLines.length > maxResults) {
        const remaining = maxResults - totalMatches;
        if (remaining > 0) {
          const kept = item.matchedLines.slice(0, remaining);
          files.push(buildFileMatches(item.relFile, item.lines, kept));
          totalMatches += kept.length;
        }
        truncated = true;
        break;
      }
      files.push(buildFileMatches(item.relFile, item.lines, item.matchedLines));
      totalMatches += item.matchedLines.length;
    }
  }
  return {
    files,
    totalMatches,
    truncated: truncated || anyFileTruncated || (summary || query.multiline === true) && discoveryTruncated
  };
}
function relativeFile(baseCwd, file) {
  return toPosixPath(path3.relative(baseCwd, path3.resolve(baseCwd, file))) || path3.basename(file);
}
async function runFuzzyQuery(query, searchRoot, baseCwd, isFileTarget) {
  const pattern = query.pattern.trim();
  if (!pattern) throw new Error("Fuzzy pattern must not be blank");
  const matchesType = fileTypeMatcher(query.fileType);
  const maxResults = clampInt(query.maxResults ?? 30, 1, 200);
  const walked = isFileTarget ? { files: [searchRoot], truncated: false } : await walkFiles(searchRoot, { maxFiles: 8e3, fileFilter: matchesType });
  const candidates = walked.files.filter(matchesType).map((file) => relativeFile(baseCwd, path3.resolve(searchRoot, file)));
  const { matches, totalMatched } = rankFuzzyPaths(pattern, candidates, maxResults);
  const body = matches.map((match) => match.path).join("\n") || "(no files matched)";
  const footer = walked.truncated || totalMatched > maxResults ? `
... [truncated; showing ${matches.length} files]` : "";
  return body + footer;
}
function buildGlobFallbackPlan(pattern) {
  if (!pattern.includes("{") && pattern.includes("|")) {
    const terms = pattern.split("|").map((part) => part.trim()).filter(Boolean);
    if (terms.length >= 2) {
      const termMatchers = terms.map((term) => {
        const hasGlobMeta = /[*?[\]{}]/.test(term);
        if (hasGlobMeta) {
          try {
            const re = globToRegExp(term);
            const matchBase = !term.includes("/");
            return (relPosix, base) => re.test(relPosix) || matchBase && re.test(base);
          } catch {
          }
        }
        const needle = term.toLowerCase();
        return (relPosix) => relPosix.toLowerCase().includes(needle);
      });
      const allBare = terms.every((t) => !/[*?[\]{}/]/.test(t));
      const label = allBare ? `**/*{${terms.join(",")}}*` : `{${terms.join(",")}}`;
      return {
        match: (relPosix, base) => termMatchers.some((fn) => fn(relPosix, base)),
        matchedNote: `[note: exact glob matched 0 files; auto-expanded regex '|' to "${label}" (glob uses * and {a,b}, not |)]`,
        emptyMessage: "(no files matched; hint: glob uses * and {a,b}, not regex |)"
      };
    }
  }
  if (/^[A-Za-z0-9_-]+$/.test(pattern)) {
    const needle = pattern.toLowerCase();
    return {
      match: (relPosix) => relPosix.toLowerCase().includes(needle),
      matchedNote: `[note: exact glob "${pattern}" matched 0 files; showing case-insensitive path matches for "*${pattern}*"]`,
      emptyMessage: "(no files matched)"
    };
  }
  return null;
}
async function formatGlobWalkResult(walked, searchRoot, baseCwd, maxResults, sortBy, notePrefix, statsCtx = null) {
  const relPrefix = toPosixPath(path3.relative(baseCwd, searchRoot));
  const sortedFiles = [...walked.files].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  if (sortBy === "mtime") {
    const mtimes = /* @__PURE__ */ new Map();
    for (let i = 0; i < sortedFiles.length; i += 32) {
      await Promise.all(sortedFiles.slice(i, i + 32).map(async (file) => {
        const stat = await fs3.lstat(path3.join(searchRoot, file)).catch(() => void 0);
        mtimes.set(file, stat?.mtimeMs ?? -Infinity);
      }));
    }
    sortedFiles.sort((a, b) => mtimes.get(b) - mtimes.get(a) || (a < b ? -1 : a > b ? 1 : 0));
  }
  const items = sortedFiles.slice(0, maxResults).map((f) => {
    if (!relPrefix || relPrefix === ".") return f;
    return `${relPrefix}/${f}`;
  });
  const truncated = walked.truncated || sortedFiles.length > maxResults;
  const header = notePrefix ? `${notePrefix}
` : "";
  if (!truncated) {
    return `${header}${items.join("\n")}`;
  }
  const omitted = sortedFiles.slice(maxResults);
  const dirCounts = /* @__PURE__ */ new Map();
  let omittedBytes = 0;
  const relBasePrefix = relPrefix && relPrefix !== "." ? `${relPrefix}/` : "";
  for (const f of omitted) {
    omittedBytes += Buffer.byteLength(relBasePrefix ? `${relBasePrefix}${f}` : f, "utf8") + 1;
    const slash = f.indexOf("/");
    const bucket = slash === -1 ? "(root)" : `${f.slice(0, slash)}/`;
    dirCounts.set(bucket, (dirCounts.get(bucket) ?? 0) + 1);
  }
  const topDirs = [...dirCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6).map(([dir, cnt]) => `${dir} (${cnt})`);
  const totalLabel = walked.truncated ? `${walked.files.length}+` : String(walked.files.length);
  const dirSummary = topDirs.length > 0 ? `; omitted dirs: ${topDirs.join(", ")}` : "";
  const suffix = `
... [truncated at ${maxResults} of ${totalLabel} files${dirSummary}]`;
  if (statsCtx && omitted.length > 0) {
    const suffixBytes = Buffer.byteLength(suffix, "utf8");
    if (omittedBytes > suffixBytes) {
      statsCtx.extraCompactedBytes += omittedBytes - suffixBytes;
    }
  }
  return `${header}${items.join("\n")}${suffix}`;
}
async function runGlobQuery(query, searchRoot, baseCwd, isFileTarget, trackCtx = null, statsCtx = null) {
  const maxResults = clampInt(query.maxResults ?? 80, 1, 300);
  const pattern = (query.pattern.trim() || "**/*").replace(/\\/g, "/");
  const matcher = globToRegExp(pattern);
  const matchBasename = !pattern.includes("/");
  const includeHidden = pattern.startsWith(".") || pattern.includes("/.");
  const recordGlobPaths = (relList) => {
    if (!trackCtx) return;
    for (const rel of relList) {
      if (trackCtx.matchedAbsPaths.size >= MAX_SEARCH_TRACKED_FILES) break;
      trackCtx.matchedAbsPaths.add(path3.join(searchRoot, rel));
    }
  };
  if (isFileTarget) {
    const rel = toPosixPath(path3.relative(baseCwd, searchRoot)) || path3.basename(searchRoot);
    const base = path3.basename(searchRoot);
    const matched = matcher.test(rel) || matchBasename && matcher.test(base);
    if (matched) {
      if (trackCtx && trackCtx.matchedAbsPaths.size < MAX_SEARCH_TRACKED_FILES) {
        trackCtx.matchedAbsPaths.add(searchRoot);
      }
      return rel;
    }
    const fallback2 = buildGlobFallbackPlan(pattern);
    if (fallback2) {
      if (fallback2.match(rel, base)) {
        if (trackCtx && trackCtx.matchedAbsPaths.size < MAX_SEARCH_TRACKED_FILES) {
          trackCtx.matchedAbsPaths.add(searchRoot);
        }
        return `${fallback2.matchedNote}
${rel}`;
      }
      return fallback2.emptyMessage;
    }
    return "(no files matched)";
  }
  const scanLimit = Math.max(maxResults + 1, 2e3);
  const walked = await walkFiles(searchRoot, {
    maxFiles: scanLimit,
    includeHidden,
    fileFilter: (relPosix) => {
      if (matcher.test(relPosix)) return true;
      if (matchBasename) {
        const base = relPosix.split("/").pop() ?? relPosix;
        return matcher.test(base);
      }
      return false;
    }
  });
  if (walked.files.length > 0) {
    recordGlobPaths(walked.files);
    return formatGlobWalkResult(walked, searchRoot, baseCwd, maxResults, query.sortBy, void 0, statsCtx);
  }
  const fallback = buildGlobFallbackPlan(pattern);
  if (fallback) {
    const fallbackWalked = await walkFiles(searchRoot, {
      maxFiles: scanLimit,
      includeHidden,
      fileFilter: (relPosix) => {
        const base = relPosix.split("/").pop() ?? relPosix;
        return fallback.match(relPosix, base);
      }
    });
    if (fallbackWalked.files.length > 0) {
      recordGlobPaths(fallbackWalked.files);
      return formatGlobWalkResult(
        fallbackWalked,
        searchRoot,
        baseCwd,
        maxResults,
        query.sortBy,
        fallback.matchedNote,
        statsCtx
      );
    }
    return fallback.emptyMessage;
  }
  return "(no files matched)";
}
async function runGitQuery(query, searchRoot) {
  const gitArgs = validateReadonlyGitArgs(query.pattern);
  const res = await execBinaryAsync(
    "git",
    [...SAFE_GIT_CONFIG_ARGS, ...gitArgs],
    {
      cwd: searchRoot,
      timeoutMs: 1e4,
      maxOutputBytes: 512 * 1024
    }
  );
  if (res.error) {
    throw new Error(`git execution error: ${res.error}`);
  }
  if (res.timedOut) {
    throw new Error("git query timed out");
  }
  if (res.exitCode !== 0) {
    const msg = (res.stderr || res.stdout).trim();
    throw new Error(msg || `git exited with code ${res.exitCode}`);
  }
  const out = res.stdout.trimEnd();
  return out || "(empty output)";
}
const SEARCH_LINE_CHARS = 240;

function formatSearchLine({ text, isMatch, matchStart, matchEnd }) {
  const prefix = sliceSafeChars(text, SEARCH_LINE_CHARS);
  if (text.length <= SEARCH_LINE_CHARS) return prefix;
  if (!isMatch || matchStart === undefined || (matchStart < prefix.length && matchEnd <= prefix.length)) {
    return prefix + "...";
  }

  // A multiline span may begin on a newline or continue past the end of this line.
  const from = Math.min(matchStart, text.length);
  const span = Math.min(matchEnd, text.length) - from;
  const lead = Math.max(0, Math.floor((SEARCH_LINE_CHARS - span) / 2));
  let start = Math.max(0, Math.min(from - lead, text.length - SEARCH_LINE_CHARS));
  const end = Math.min(text.length, start + SEARCH_LINE_CHARS);
  const first = text.charCodeAt(start);
  if (start > 0 && first >= 0xdc00 && first <= 0xdfff) start += start === from ? -1 : 1;
  const snippet = sliceSafeChars(text.slice(start, end), end - start);
  return (start ? "..." : "") + snippet + (start + snippet.length < text.length ? "..." : "");
}

function formatFileMatches(files, totalMatches, truncated, statsCtx = null) {
  if (files.length === 0) {
    return "(no matches)";
  }
  const blocks = [];
  for (const fm of files) {
    const lines = fm.lines.map((l) => {
      const sep = l.isMatch ? ":" : "-";
      const formatted = formatSearchLine(l);
      if (statsCtx && typeof l.text === "string" && l.text.length > SEARCH_LINE_CHARS) {
        const rawLineBytes = Buffer.byteLength(l.text, "utf8");
        const fmtLineBytes = Buffer.byteLength(formatted, "utf8");
        if (rawLineBytes > fmtLineBytes) {
          statsCtx.extraCompactedBytes += rawLineBytes - fmtLineBytes;
        }
      }
      return `  ${l.lineNumber}${sep} ${formatted}`;
    });
    blocks.push(`${fm.file}
${lines.join("\n")}`);
  }
  const footer = truncated ? `
... [truncated at ${totalMatches} matches]` : "";
  return `${blocks.join("\n")}${footer}`;
}
var MAX_SEARCH_CACHE_ENTRIES = 32;
var DEFAULT_SEARCH_CACHE_TTL_MS = 15e3;
var MAX_SEARCH_TRACKED_FILES = 32;
var MAX_SEARCH_TRACKED_DIRS = 16;
var BATCH_SEARCH_CACHE = /* @__PURE__ */ new Map();
function getSearchCacheTtlMs() {
  const cfgVal = getEffectiveConfig().searchCacheTtlMs;
  if (!Number.isFinite(cfgVal)) return DEFAULT_SEARCH_CACHE_TTL_MS;
  if (cfgVal <= 0) return 0;
  return Math.min(Math.trunc(cfgVal), 3e5);
}
async function statFingerprintPart(targetPath) {
  try {
    const st = await fs3.stat(targetPath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "-";
  }
}
async function resolveGitDirFast(baseCwd) {
  let dir = baseCwd;
  for (let depth = 0; depth < 4; depth++) {
    const dotGit = path3.join(dir, ".git");
    try {
      const st = await fs3.stat(dotGit);
      if (st.isDirectory()) return dotGit;
      if (st.isFile() && st.size < 4096) {
        const raw = await fs3.readFile(dotGit, "utf8");
        const m = /^gitdir:\s*(.+)$/im.exec(raw.trim());
        if (m && m[1]) {
          return path3.resolve(dir, m[1].trim());
        }
      }
      return null;
    } catch {
      const parent = path3.dirname(dir);
      if (!parent || parent === dir) break;
      dir = parent;
    }
  }
  return null;
}
async function computeSubtreeStatSummary(rootDir, maxDirs = 24, maxFiles = 160) {
  let dirCount = 0;
  let fileCount = 0;
  let maxMtime = 0;
  let totalSize = 0;
  const queue = [{ dir: rootDir, depth: 0 }];
  while (queue.length > 0 && dirCount < maxDirs && fileCount <= maxFiles) {
    const { dir, depth } = queue.shift();
    dirCount += 1;
    let entries;
    try {
      entries = await fs3.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || DEFAULT_IGNORE_DIRS.has(e.name)) continue;
      const abs = path3.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 3 && queue.length + dirCount < maxDirs) {
          queue.push({ dir: abs, depth: depth + 1 });
        }
        try {
          const dst = await fs3.stat(abs);
          if (dst.mtimeMs > maxMtime) maxMtime = dst.mtimeMs;
        } catch {}
      } else if (e.isFile()) {
        fileCount += 1;
        if (fileCount <= maxFiles) {
          try {
            const fst = await fs3.stat(abs);
            if (fst.mtimeMs > maxMtime) maxMtime = fst.mtimeMs;
            totalSize += fst.size;
          } catch {}
        }
      }
    }
  }
  return `${dirCount}:${fileCount}:${maxMtime}:${totalSize}`;
}
async function computeWorktreeFingerprint(baseCwd, queries) {
  try {
    const targets = [baseCwd];
    const gitDir = await resolveGitDirFast(baseCwd);
    if (gitDir) {
      targets.push(path3.join(gitDir, "index"));
      targets.push(path3.join(gitDir, "HEAD"));
      targets.push(path3.join(gitDir, "logs", "HEAD"));
    }
    try {
      const dbPath = resolveOutlineDbPath();
      if (dbPath) {
        targets.push(dbPath);
        targets.push(`${dbPath}-wal`);
      }
    } catch {}
    const extraPaths = /* @__PURE__ */ new Set();
    const scanRoots = /* @__PURE__ */ new Set([baseCwd]);
    for (const q of queries) {
      if (q && typeof q.path === "string" && q.path.trim()) {
        const rp = resolvePath(q.path, baseCwd);
        extraPaths.add(rp);
        scanRoots.add(rp);
      }
    }
    const sortedExtra = [...extraPaths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const p of sortedExtra) {
      targets.push(p);
    }
    const [parts, subtreeSummaries] = await Promise.all([
      Promise.all(targets.map((t) => statFingerprintPart(t))),
      Promise.all([...scanRoots].slice(0, 4).map((r) => computeSubtreeStatSummary(r)))
    ]);
    return `${parts.join("|")}#${subtreeSummaries.join(",")}`;
  } catch {
    return "";
  }
}
async function areTrackedFilesFresh(trackedFiles) {
  if (!Array.isArray(trackedFiles) || trackedFiles.length === 0) return true;
  const checks = await Promise.all(
    trackedFiles.map(async (f) => {
      try {
        const st = await fs3.stat(f.absPath);
        return st.mtimeMs === f.mtimeMs && st.size === f.size;
      } catch {
        return false;
      }
    })
  );
  return checks.every(Boolean);
}
async function collectSmallDirProbePaths(baseCwd, queries, maxFiles = 24) {
  try {
    const roots = /* @__PURE__ */ new Set();
    for (const q of queries) {
      if (q && typeof q.path === "string" && q.path.trim()) {
        roots.add(resolvePath(q.path, baseCwd));
      } else {
        roots.add(baseCwd);
      }
    }
    const found = /* @__PURE__ */ new Set();
    for (const root of roots) {
      let st;
      try {
        st = await fs3.stat(root);
      } catch {
        continue;
      }
      if (st.isFile()) {
        found.add(root);
        if (found.size > maxFiles) return [];
        continue;
      }
      if (!st.isDirectory()) continue;
      let entries;
      try {
        entries = await fs3.readdir(root, { withFileTypes: true });
      } catch {
        continue;
      }
      if (entries.length > 48) return [];
      const subdirs = [];
      for (const entry of entries) {
        if (entry.name.startsWith(".") || DEFAULT_IGNORE_DIRS.has(entry.name)) continue;
        const abs = path3.join(root, entry.name);
        if (entry.isFile()) {
          found.add(abs);
          if (found.size > maxFiles) return [];
        } else if (entry.isDirectory()) {
          subdirs.push(abs);
        }
      }
      if (subdirs.length > 12) return [];
      for (const sub of subdirs) {
        let subEntries;
        try {
          subEntries = await fs3.readdir(sub, { withFileTypes: true });
        } catch {
          continue;
        }
        if (subEntries.length > 48) return [];
        for (const se of subEntries) {
          if (se.name.startsWith(".") || DEFAULT_IGNORE_DIRS.has(se.name)) continue;
          if (se.isFile()) {
            found.add(path3.join(sub, se.name));
            if (found.size > maxFiles) return [];
          }
        }
      }
    }
    return [...found];
  } catch {
    return [];
  }
}
async function snapshotTrackedFiles(absPathsSet, baseCwd = "") {
  if (!absPathsSet || absPathsSet.size === 0) return [];
  const fileList = [...absPathsSet].slice(0, MAX_SEARCH_TRACKED_FILES);
  const normBase = baseCwd ? normalizeFileCacheKey(baseCwd) : "";
  const parentDirs = /* @__PURE__ */ new Set();
  for (const absPath of fileList) {
    if (parentDirs.size >= MAX_SEARCH_TRACKED_DIRS) break;
    const dir = path3.dirname(absPath);
    if (dir && dir !== absPath && normalizeFileCacheKey(dir) !== normBase) {
      parentDirs.add(dir);
    }
  }
  const targets = [
    ...fileList.map((absPath) => ({ absPath, expectDir: false })),
    ...[...parentDirs].map((absPath) => ({ absPath, expectDir: true }))
  ];
  const results = await Promise.all(
    targets.map(async ({ absPath, expectDir }) => {
      try {
        const st = await fs3.stat(absPath);
        if (expectDir ? !st.isDirectory() : !st.isFile()) return null;
        return { absPath, mtimeMs: st.mtimeMs, size: st.size };
      } catch {
        return null;
      }
    })
  );
  return results.filter(Boolean);
}
async function executeSingleQuery(query, index, baseCwd, useRg, trackCtx = null, statsCtx = null) {
  const header = `## Query ${index + 1} [${query.type}] ${query.pattern}${query.path ? ` (in ${query.path})` : ""}`;
  try {
    if (!query.pattern || typeof query.pattern !== "string") {
      throw new Error("Query 'pattern' must be a non-empty string");
    }
    if (query.multiline !== void 0 && typeof query.multiline !== "boolean") {
      throw new Error("multiline must be a boolean");
    }
    if (query.outputMode !== void 0 && !["content", "files_with_matches", "count"].includes(query.outputMode)) {
      throw new Error("Invalid outputMode");
    }
    if (query.sortBy !== void 0 && !["path", "mtime"].includes(query.sortBy)) {
      throw new Error("Invalid sortBy");
    }
    if (query.glob) query = { ...query, glob: query.glob.replace(/\\/g, "/") };
    const searchRoot = query.path ? resolvePath(query.path, baseCwd) : baseCwd;
    let targetStat;
    try {
      targetStat = await fs3.stat(searchRoot);
    } catch {
      throw new Error(`Path does not exist: ${query.path || baseCwd}`);
    }
    if (query.type === "git") {
      const gitCwd = targetStat.isFile() ? path3.dirname(searchRoot) : searchRoot;
      const out = await runGitQuery(query, gitCwd);
      return `${header}
${out}`;
    }
    if (query.type === "fuzzy") {
      const out = await runFuzzyQuery(query, searchRoot, baseCwd, targetStat.isFile());
      return `${header}\n${out}`;
    }
    if (query.type === "glob") {
      const out = await runGlobQuery(query, searchRoot, baseCwd, targetStat.isFile(), trackCtx, statsCtx);
      return `${header}
${out}`;
    }
    if (query.type === "text" || query.type === "regex") {
      let res;
      if (useRg) {
        try {
          res = await runTextOrRegexWithRg(query, searchRoot, baseCwd);
        } catch (err) {
          if (err instanceof Error && err.message.startsWith("rg spawn error:")) {
            res = await runTextOrRegexWithNode(query, searchRoot, baseCwd);
          } else {
            throw err;
          }
        }
      } else {
        res = await runTextOrRegexWithNode(query, searchRoot, baseCwd);
      }
      if (trackCtx && Array.isArray(res.files)) {
        for (const fm of res.files) {
          if (trackCtx.matchedAbsPaths.size >= MAX_SEARCH_TRACKED_FILES) break;
          if (fm && fm.file) {
            trackCtx.matchedAbsPaths.add(path3.resolve(baseCwd, fm.file));
          }
        }
      }
      if (query.outputMode === "count" || query.outputMode === "files_with_matches") {
        const lines = res.files.map(({ file, count }) => query.outputMode === "count"
          ? `${file}: ${count} ${query.multiline ? "matches" : "matching lines"}` : file);
        if (res.truncated) lines.push(`... [truncated; showing ${res.files.length} files]`);
        return `${header}\n${lines.join("\n") || "(no matches)"}`;
      }
      return `${header}
${formatFileMatches(res.files, res.totalMatches, res.truncated, statsCtx)}`;
    }
    throw new Error(`Unsupported query type: ${String(query.type)}`);
  } catch (err) {
    if (trackCtx) trackCtx.hasError = true;
    return `${header}
ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
}
function coerceArrayToolField(rawVal, fieldName, { allowSingleString = false, optional = true } = {}) {
  if (rawVal === void 0 || rawVal === null) {
    return optional
      ? { items: [], error: null }
      : { items: null, error: `Error: '${fieldName}' must be a non-empty array.` };
  }
  if (Array.isArray(rawVal)) {
    return { items: rawVal, error: null };
  }
  if (typeof rawVal === "string") {
    const trimmed = rawVal.trim();
    if (!trimmed) {
      return optional
        ? { items: [], error: null }
        : { items: null, error: `Error: '${fieldName}' must be a non-empty array.` };
    }
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return { items: parsed, error: null };
        }
      } catch (err) {
        return {
          items: null,
          error: `Error: '${fieldName}' JSON string is invalid (${err instanceof Error ? err.message : String(err)}).`
        };
      }
    }
    if (allowSingleString) {
      return { items: [trimmed], error: null };
    }
  }
  return {
    items: null,
    error: `Error: '${fieldName}' must be an array${allowSingleString ? " or string" : ""}.`
  };
}
async function runBatchSearch(input, options = {}) {
  const coercedQueries = coerceArrayToolField(input.queries, "queries", { optional: false });
  if (coercedQueries.error || !coercedQueries.items || coercedQueries.items.length === 0) {
    return {
      text: coercedQueries.error || "Error: 'queries' must be a non-empty array of search queries.",
      isError: true
    };
  }
  const queriesList = coercedQueries.items;
  if (queriesList.length > 20) {
    return {
      text: "Error: 'queries' supports at most 20 queries per call.",
      isError: true
    };
  }
  const wsRes = await resolveToolWorkspaceCwd(input.cwd, options);
  if (wsRes.error) {
    return { text: wsRes.error, isError: true };
  }
  const baseCwd = wsRes.cwd;
  try {
    const st = await fs3.stat(baseCwd);
    if (!st.isDirectory()) {
      return { text: `Error: cwd is not a directory: ${baseCwd}`, isError: true };
    }
  } catch {
    return { text: `Error: cwd does not exist: ${baseCwd}`, isError: true };
  }
  const maxChars = clampInt(input.maxChars ?? 8500, 500, DEFAULT_INLINE_MAX_BYTES);
  const maxBytes = DEFAULT_INLINE_MAX_BYTES;
  // Git state, fuzzy rankings and mtime ordering depend on candidates outside the tracked result set.
  const bypassCache = queriesList.some((q) => q?.type === "git" || q?.type === "fuzzy" || q?.sortBy === "mtime");
  const ttlMs = bypassCache ? 0 : getSearchCacheTtlMs();
  let cacheKey = null;
  const queryTypesKey = [...new Set(queriesList.map((q) => String(q?.type || "text")))].sort().join(",");
  const queryPathSummary = redactSecrets(
    queriesList
      .slice(0, 3)
      .map((q) => `${q?.type || "text"}:${String(q?.pattern || "").slice(0, 32)}`)
      .join(", ")
  ).text.slice(0, 120);
  if (ttlMs > 0) {
    const worktreeFp = await computeWorktreeFingerprint(baseCwd, queriesList);
    const canonicalQueriesJson = JSON.stringify(stableSortObject(queriesList));
    cacheKey = `${normalizeFileCacheKey(baseCwd)}|${maxChars}|${Boolean(options.forceNodeFallback)}|${canonicalQueriesJson}|${worktreeFp}`;
    const cached = BATCH_SEARCH_CACHE.get(cacheKey);
    if (cached) {
      const now = Date.now();
      if (now - cached.createdAt <= ttlMs && await areTrackedFilesFresh(cached.trackedFiles)) {
        BATCH_SEARCH_CACHE.delete(cacheKey);
        BATCH_SEARCH_CACHE.set(cacheKey, cached);
        return {
          text: cached.text,
          isError: false,
          telemetry: {
            kind: "fast_search",
            key: queryTypesKey,
            path: queryPathSummary,
            worktree: baseCwd,
            rawBytes: cached.rawBytes ?? Buffer.byteLength(cached.text, "utf8"),
            ok: 1
          }
        };
      }
      BATCH_SEARCH_CACHE.delete(cacheKey);
    }
  }
  const needsTextSearch = queriesList.some(
    (q) => q.type === "text" || q.type === "regex"
  );
  const useRg = needsTextSearch && !options.forceNodeFallback && await isRipgrepAvailable();
  const trackCtx = ttlMs > 0 ? { matchedAbsPaths: /* @__PURE__ */ new Set(), hasError: false } : null;
  const statsCtx = { extraCompactedBytes: 0 };
  const sections = await Promise.all(
    queriesList.map((q, idx) => executeSingleQuery(q, idx, baseCwd, useRg, trackCtx, statsCtx))
  );
  const rawJoinedSectionsBytes = Buffer.byteLength(sections.join("\n\n"), "utf8");
  const rawSearchBytes = rawJoinedSectionsBytes + statsCtx.extraCompactedBytes;
  const resultText = fitSectionsToByteBudget(sections, maxChars, maxBytes, "\n\n");
  if (cacheKey && trackCtx && !trackCtx.hasError) {
    try {
      if (trackCtx.matchedAbsPaths.size === 0) {
        const probePaths = await collectSmallDirProbePaths(baseCwd, queriesList, 24);
        for (const p of probePaths) trackCtx.matchedAbsPaths.add(p);
      }
      const trackedFiles = await snapshotTrackedFiles(trackCtx.matchedAbsPaths, baseCwd);
      if (trackedFiles.length > 0) {
        if (BATCH_SEARCH_CACHE.has(cacheKey)) {
          BATCH_SEARCH_CACHE.delete(cacheKey);
        } else if (BATCH_SEARCH_CACHE.size >= MAX_SEARCH_CACHE_ENTRIES) {
          const oldestKey = BATCH_SEARCH_CACHE.keys().next().value;
          if (oldestKey !== void 0) BATCH_SEARCH_CACHE.delete(oldestKey);
        }
        BATCH_SEARCH_CACHE.set(cacheKey, {
          createdAt: Date.now(),
          text: resultText,
          rawBytes: rawSearchBytes,
          trackedFiles
        });
      }
    } catch {
      // Fail-open cache populate
    }
  }
  return {
    text: resultText,
    isError: false,
    telemetry: {
      kind: "fast_search",
      key: queryTypesKey,
      path: queryPathSummary,
      worktree: baseCwd,
      rawBytes: rawSearchBytes,
      ok: 1
    }
  };
}
function clampInt(val, min, max) {
  if (!Number.isFinite(val)) return min;
  return Math.max(min, Math.min(max, Math.trunc(val)));
}
function clampIntWithDefault(val, def, min, max) {
  const n = typeof val === "number" ? val : typeof val === "string" && val.trim() !== "" ? Number(val) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

// src/tools/read-slices.ts
import { extractSymbolsFromLines, renderOutlineWithinBudget, computeWaterFillBudgets, OUTLINE_SCHEMA_VERSION } from "../context/lib/code-outline.js";
import path4 from "node:path";
var MAX_OUTLINES = 40;
var MAX_SLICE_FILES = 30;
var MAX_OUTLINE_CACHE_ENTRIES = 128;
var OUTLINE_SYMBOL_CACHE = /* @__PURE__ */ new Map();
var MAX_OUTLINE_L1_EVICTED_TRACK = 512;
var OUTLINE_L1_EVICTED_KEYS = /* @__PURE__ */ new Set();
var MAX_SLICE_CACHE_TOTAL_BYTES = 4 * 1024 * 1024;
var MAX_SLICE_CACHE_FILE_BYTES = 256 * 1024;
var SLICE_LINES_CACHE = /* @__PURE__ */ new Map();
var sliceLinesCacheBytes = 0;
var outlineDbStore = null;
var outlineDbInitPromise = null;
var outlineDbDisabled = false;
var sqliteWarningFilterInstalled = false;
function installSqliteWarningFilter() {
  if (sqliteWarningFilterInstalled) return;
  sqliteWarningFilterInstalled = true;
  try {
    const origEmitWarning = process.emitWarning.bind(process);
    process.emitWarning = (warning, ...args) => {
      const msg = typeof warning === "string" ? warning : String(warning?.message || "");
      const type = typeof args[0] === "string" ? args[0] : (args[0]?.type || warning?.name || "");
      if (/ExperimentalWarning/i.test(String(type)) && /sqlite/i.test(msg)) {
        return;
      }
      return origEmitWarning(warning, ...args);
    };
  } catch {
  }
}
function isOutlineDbDisabled() {
  return outlineDbDisabled || !getEffectiveConfig().outlineDb;
}
function resolveOutlineDbPath() {
  const cfgDb = getEffectiveConfig().dbPath;
  if (cfgDb) return cfgDb;
  return path.join(os.homedir(), ".agy-dart", "context.db");
}
async function getOutlineDbStore() {
  if (isOutlineDbDisabled()) return null;
  if (outlineDbStore) return outlineDbStore;
  if (!outlineDbInitPromise) {
    outlineDbInitPromise = (async () => {
      installSqliteWarningFilter();
      try {
        const mod = await import("../context/lib/store.js");
        const store = new mod.ContextModeStore();
        store.open();
        outlineDbStore = store;
        return store;
      } catch {
        outlineDbDisabled = true;
        return null;
      }
    })();
  }
  return outlineDbInitPromise;
}
var fastTelemetryStore = null;
var fastTelemetryDbPath = "";
var fastTelemetryInitPromise = null;
var fastReceiptsModPromise = null;
function loadFastReceiptsMod() {
  if (!fastReceiptsModPromise) {
    fastReceiptsModPromise = import("../context/lib/execution-receipts.js").catch(() => null);
  }
  return fastReceiptsModPromise;
}
function normalizeFastSessionId(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (
    !trimmed ||
    trimmed.length > 128 ||
    /[\x00-\x1f\x7f\\/]/.test(trimmed) ||
    /^(?:default|all|app|lifetime|__unbound__)$/i.test(trimmed) ||
    /^workspace:/i.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
}
async function getFastTelemetryStore() {
  const targetDbPath = resolveOutlineDbPath();
  if (outlineDbStore && outlineDbStore.dbPath === targetDbPath) {
    return outlineDbStore;
  }
  if (fastTelemetryStore && fastTelemetryDbPath === targetDbPath) {
    return fastTelemetryStore;
  }
  if (fastTelemetryStore && fastTelemetryDbPath !== targetDbPath) {
    closeFastTelemetryStore();
  }
  if (!fastTelemetryInitPromise) {
    fastTelemetryInitPromise = (async () => {
      installSqliteWarningFilter();
      try {
        const mod = await import("../context/lib/store.js");
        const st = new mod.ContextModeStore({ dbPath: targetDbPath, hookMode: true, maxBusyRetries: 4, maxRetryDeadlineMs: 800 });
        st.open();
        fastTelemetryStore = st;
        fastTelemetryDbPath = targetDbPath;
        return st;
      } catch {
        return null;
      } finally {
        fastTelemetryInitPromise = null;
      }
    })();
  }
  return fastTelemetryInitPromise;
}
function closeFastTelemetryStore() {
  if (fastTelemetryStore) {
    try {
      fastTelemetryStore.close();
    } catch {}
    fastTelemetryStore = null;
  }
  fastTelemetryDbPath = "";
  fastTelemetryInitPromise = null;
}
async function getExistingFastWorkspaceStore() {
  const targetDbPath = resolveOutlineDbPath();
  if (!targetDbPath || !fsSyncNode.existsSync(targetDbPath)) return null;
  return getFastTelemetryStore();
}
async function lookupFastSessionWorkspace(sessionIds = []) {
  try {
    const store = await getExistingFastWorkspaceStore();
    if (!store || typeof store.resolveSessionWorkspace !== "function") return null;
    const dir = store.resolveSessionWorkspace(sessionIds, { pluginRootNorm: FAST_PLUGIN_ROOT_NORM });
    return dir && !isInsideInstalledPluginDir(dir) ? dir : null;
  } catch {
    return null;
  }
}
async function lookupFastUniqueActiveWorkspace() {
  try {
    const store = await getExistingFastWorkspaceStore();
    if (!store || typeof store.resolveUniqueActiveWorkspace !== "function") return null;
    const res = store.resolveUniqueActiveWorkspace({ pluginRootNorm: FAST_PLUGIN_ROOT_NORM });
    if (res && res.status === "unique" && res.dir && !isInsideInstalledPluginDir(res.dir)) {
      return res;
    }
    if (res && res.status === "ambiguous") {
      return res;
    }
    return null;
  } catch {
    return null;
  }
}
async function recordFastSavingsEvent({ toolName, telemetry, finalText, hostSessionId = null, directConvId = null }) {
  if (!telemetry || !Number.isFinite(telemetry.rawBytes) || telemetry.rawBytes <= 0) return;
  const returnedBytes = Buffer.byteLength(typeof finalText === "string" ? finalText : "", "utf8");
  // Strictly non-inflated: record only when raw input/output genuinely exceeded returned bytes.
  if (telemetry.rawBytes <= returnedBytes) return;
  const store = await getFastTelemetryStore();
  if (!store) return;
  const worktree = telemetry.worktree || process.cwd();
  const receiptsMod = await loadFastReceiptsMod();
  const claimFingerprint =
    typeof receiptsMod?.fastToolFingerprint === "function"
      ? receiptsMod.fastToolFingerprint(toolName, finalText)
      : null;
  if (hostSessionId) {
    const rootSid =
      typeof store.resolveRootSessionId === "function"
        ? store.resolveRootSessionId(hostSessionId)
        : hostSessionId;
    store.recordEvent({
      sessionId: rootSid,
      worktree,
      agent: "antigravity",
      kind: telemetry.kind,
      tool: toolName,
      key: telemetry.key || null,
      path: telemetry.path || null,
      ok: telemetry.ok ?? 1,
      bytes: telemetry.rawBytes,
      body: "",
      sandboxBytes: telemetry.rawBytes,
      returnedBytes,
      claimFingerprint,
      claimedConv: directConvId || rootSid
    });
    return;
  }
  let anonSessionId = "default";
  if (worktree) {
    try {
      const canonicalDir = fsSyncNode.realpathSync.native(worktree);
      anonSessionId = "workspace:" + createHashNode("sha256").update(canonicalDir).digest("hex");
    } catch {}
  }
  store.recordEvent({
    sessionId: anonSessionId,
    worktree,
    agent: "antigravity",
    kind: telemetry.kind,
    tool: toolName,
    key: telemetry.key || null,
    path: telemetry.path || null,
    ok: telemetry.ok ?? 1,
    bytes: telemetry.rawBytes,
    body: "",
    sandboxBytes: telemetry.rawBytes,
    returnedBytes,
    claimFingerprint
  });
}
var fastPostToolVerifyModPromise = null;
var fastFilterRulesModPromise = null;
function loadFastPostToolVerifyMod() {
  if (!fastPostToolVerifyModPromise) {
    fastPostToolVerifyModPromise = import("../hooks/post-tool-use.mjs").catch(() => null);
  }
  return fastPostToolVerifyModPromise;
}
function loadFastFilterRulesMod() {
  if (!fastFilterRulesModPromise) {
    fastFilterRulesModPromise = import("../hooks/filter-rules.mjs").catch(() => null);
  }
  return fastFilterRulesModPromise;
}
async function recordFastVerificationCheckpoint({
  toolName,
  args = {},
  finalText = "",
  verifyResult = null,
  worktree = process.cwd(),
  hostSessionId = null
}) {
  const signalSourceText =
    verifyResult && typeof verifyResult === "object" && typeof verifyResult.summaryLine === "string"
      ? `${verifyResult.summaryLine}\n${String(verifyResult.output || "")}`
      : finalText;
  if (!signalSourceText || typeof signalSourceText !== "string") return;
  const postMod = await loadFastPostToolVerifyMod();
  if (typeof postMod?.extractVerificationSignal !== "function") return;
  const verifySignal = postMod.extractVerificationSignal(toolName, args, signalSourceText);
  if (!verifySignal) return;
  const store = await getFastTelemetryStore();
  if (!store || typeof store.recordVerificationResult !== "function") return;

  let targetSessionId = "default";
  if (hostSessionId) {
    targetSessionId =
      typeof store.resolveRootSessionId === "function"
        ? store.resolveRootSessionId(hostSessionId)
        : hostSessionId;
  } else if (worktree) {
    const uniquePrimarySid =
      typeof store.resolveUniqueActivePrimarySessionForWorkspace === "function"
        ? store.resolveUniqueActivePrimarySessionForWorkspace(worktree, {
            pluginRootNorm: FAST_PLUGIN_ROOT_NORM
          })
        : "";
    if (uniquePrimarySid) {
      targetSessionId = uniquePrimarySid;
    } else {
      try {
        const canonicalDir = fsSyncNode.realpathSync.native(worktree);
        targetSessionId = "workspace:" + createHashNode("sha256").update(canonicalDir).digest("hex");
      } catch {}
    }
  }

  const safeCommand = redactSecrets(verifySignal.command || "").text;
  const safeSummary = redactSecrets(verifySignal.summary || "").text;
  const redactCmdEntries = (list) =>
    Array.isArray(list)
      ? list.map((item) => ({
          name: redactSecrets(String(item?.name || "")).text,
          command: redactSecrets(String(item?.command || "")).text
        }))
      : undefined;
  let safeFailureExcerpt = "";
  if (!verifySignal.passed && verifySignal.failureSection) {
    const filterRulesMod = await loadFastFilterRulesMod();
    if (typeof filterRulesMod?.extractFailureExcerpt === "function") {
      safeFailureExcerpt = filterRulesMod.extractFailureExcerpt(
        redactSecrets(verifySignal.failureSection).text
      );
    }
  }
  const { failureSection: _ignoredSection, ...cleanVerifySignal } = verifySignal;
  store.recordVerificationResult(targetSessionId, {
    ...cleanVerifySignal,
    command: safeCommand,
    summary: safeSummary,
    ...(Array.isArray(cleanVerifySignal.batchCommands)
      ? { batchCommands: redactCmdEntries(cleanVerifySignal.batchCommands) }
      : {}),
    ...(Array.isArray(cleanVerifySignal.failedCommands)
      ? { failedCommands: redactCmdEntries(cleanVerifySignal.failedCommands) }
      : {}),
    ...(Array.isArray(cleanVerifySignal.passedCommands)
      ? { passedCommands: redactCmdEntries(cleanVerifySignal.passedCommands) }
      : {}),
    failureExcerpt: safeFailureExcerpt,
    worktree
  });
}
function closeOutlineDbStore() {
  if (outlineDbStore) {
    try {
      outlineDbStore.close();
    } catch {
    }
    outlineDbStore = null;
  }
  outlineDbInitPromise = null;
}
function setOutlineL1Cache(cacheKey, entry) {
  OUTLINE_L1_EVICTED_KEYS.delete(cacheKey);
  if (OUTLINE_SYMBOL_CACHE.has(cacheKey)) {
    OUTLINE_SYMBOL_CACHE.delete(cacheKey);
  } else if (OUTLINE_SYMBOL_CACHE.size >= MAX_OUTLINE_CACHE_ENTRIES) {
    const oldestKey = OUTLINE_SYMBOL_CACHE.keys().next().value;
    if (oldestKey !== void 0) {
      OUTLINE_SYMBOL_CACHE.delete(oldestKey);
      if (OUTLINE_L1_EVICTED_KEYS.size >= MAX_OUTLINE_L1_EVICTED_TRACK) {
        const oldestEvicted = OUTLINE_L1_EVICTED_KEYS.values().next().value;
        if (oldestEvicted !== void 0) OUTLINE_L1_EVICTED_KEYS.delete(oldestEvicted);
      }
      OUTLINE_L1_EVICTED_KEYS.add(oldestKey);
    }
  }
  OUTLINE_SYMBOL_CACHE.set(cacheKey, entry);
}
function normalizeFileCacheKey(absPath) {
  return process.platform === "win32" ? absPath.toLowerCase() : absPath;
}
function deleteSliceCacheKey(cacheKey) {
  const prev = SLICE_LINES_CACHE.get(cacheKey);
  if (!prev) return;
  SLICE_LINES_CACHE.delete(cacheKey);
  sliceLinesCacheBytes = Math.max(0, sliceLinesCacheBytes - prev.byteWeight);
}
function setSliceCacheEntry(cacheKey, entry) {
  const size = Number(entry?.size ?? 0);
  if (!Number.isFinite(size) || size > MAX_SLICE_CACHE_FILE_BYTES) {
    deleteSliceCacheKey(cacheKey);
    return false;
  }
  const byteWeight = Math.max(1, size);
  deleteSliceCacheKey(cacheKey);
  while (sliceLinesCacheBytes + byteWeight > MAX_SLICE_CACHE_TOTAL_BYTES && SLICE_LINES_CACHE.size > 0) {
    const oldestKey = SLICE_LINES_CACHE.keys().next().value;
    if (oldestKey === void 0) break;
    deleteSliceCacheKey(oldestKey);
  }
  SLICE_LINES_CACHE.set(cacheKey, {
    mtimeMs: entry.mtimeMs,
    size,
    byteWeight,
    lines: entry.lines
  });
  sliceLinesCacheBytes += byteWeight;
  return true;
}
async function invalidateFileCaches(absPaths) {
  BATCH_SEARCH_CACHE.clear();
  if (!Array.isArray(absPaths)) return;
  const validPaths = [];
  for (const p of absPaths) {
    if (!p || typeof p !== "string") continue;
    validPaths.push(p);
    const key = normalizeFileCacheKey(p);
    OUTLINE_SYMBOL_CACHE.delete(key);
    OUTLINE_L1_EVICTED_KEYS.delete(key);
    deleteSliceCacheKey(key);
  }
  if (validPaths.length === 0 || isOutlineDbDisabled()) return;
  try {
    let store = outlineDbStore;
    if (!store) {
      const dbPath = resolveOutlineDbPath();
      const exists = await fs.access(dbPath).then(() => true).catch(() => false);
      if (exists) {
        store = await getOutlineDbStore();
      }
    }
    if (store) {
      store.deleteOutlineCache(validPaths);
    }
  } catch {
    // Strictly fail-open
  }
}
var SLICE_TRUNCATION_TIP = "\n[tip: MCP responses are hard-capped <=8.8KB inline; for >150 lines across files, use parallel read_file(StartLine, EndLine) (46KB/call, 0 remote check)]";
var OUTLINE_BATCH_TIP = "\n[tip: outlining >20 files splits the 8.8KB cap thinly; batch 10-20 files per call for fuller outlines]";
function parseFlatLineRangeSpec(rawSpec) {
  if (typeof rawSpec !== "string" || !rawSpec.trim()) {
    throw new Error("lineRanges entry must be a non-empty string in 'path:start-end[,start2-end2]' format");
  }
  const trimmed = rawSpec.trim();
  const match =
    /^(.*):\s*([Ll]?\d+(?:\s*-\s*[Ll]?\d+)?(?:\s*,\s*[Ll]?\d+(?:\s*-\s*[Ll]?\d+)?)*)$/.exec(trimmed);
  if (!match || !match[1] || !match[1].trim()) {
    throw new Error(`Invalid lineRanges entry '${trimmed}': expected 'path:start-end[,start2-end2]'`);
  }
  const filePath = match[1].trim();
  if (process.platform === "win32" && /^[A-Za-z]$/.test(filePath)) {
    throw new Error(`Invalid lineRanges entry '${trimmed}': missing file path after Windows drive letter`);
  }
  const parseLineToken = (tok) => Number.parseInt(tok.trim().replace(/^[Ll]/, ""), 10);
  const ranges = match[2].split(",").map((part) => {
    const seg = part.trim();
    const dashIdx = seg.indexOf("-");
    if (dashIdx === -1) {
      const lineNum = parseLineToken(seg);
      if (!Number.isSafeInteger(lineNum) || lineNum < 1) {
        throw new Error(`Invalid 1-based line number '${seg}' in '${trimmed}'`);
      }
      return [lineNum, lineNum];
    }
    const start = parseLineToken(seg.slice(0, dashIdx));
    const end = parseLineToken(seg.slice(dashIdx + 1));
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < 1) {
      throw new Error(`Line numbers must be >= 1 in '${trimmed}'`);
    }
    if (start > end) {
      throw new Error(`startLine (${start}) > endLine (${end}) in '${trimmed}'`);
    }
    return [start, end];
  });
  return { path: filePath, ranges };
}
async function runReadSlices(input, options = {}) {
  const outlinesCoerced = coerceArrayToolField(input.outlines, "outlines", { allowSingleString: true });
  if (outlinesCoerced.error) return { text: outlinesCoerced.error, isError: true };
  const slicesCoerced = coerceArrayToolField(input.slices, "slices", { allowSingleString: false });
  if (slicesCoerced.error) return { text: slicesCoerced.error, isError: true };
  const lineRangesCoerced = coerceArrayToolField(input.lineRanges, "lineRanges", { allowSingleString: true });
  if (lineRangesCoerced.error) return { text: lineRangesCoerced.error, isError: true };
  const outlines = outlinesCoerced.items;
  const rawSlices = slicesCoerced.items;
  const rawLineRanges = lineRangesCoerced.items;
  if (rawLineRanges.length > MAX_SLICE_FILES) {
    return {
      text: `Error: limits exceeded (max ${MAX_SLICE_FILES} lineRanges entries per call).`,
      isError: true
    };
  }
  const parsedLineRanges = [];
  for (let i = 0; i < rawLineRanges.length; i++) {
    try {
      parsedLineRanges.push(parseFlatLineRangeSpec(rawLineRanges[i]));
    } catch (err) {
      return {
        text: `Error in lineRanges[${i}]: ${err instanceof Error ? err.message : String(err)}`,
        isError: true
      };
    }
  }
  const slices = [...rawSlices, ...parsedLineRanges];
  if (outlines.length === 0 && slices.length === 0) {
    return {
      text: "Error: provide at least one entry in 'outlines', 'slices', or 'lineRanges'.",
      isError: true
    };
  }
  if (outlines.length > MAX_OUTLINES || slices.length > MAX_SLICE_FILES) {
    return {
      text: `Error: limits exceeded (max ${MAX_OUTLINES} outlines and ${MAX_SLICE_FILES} slice files per call).`,
      isError: true
    };
  }
  const wsRes = await resolveToolWorkspaceCwd(input.cwd, options);
  if (wsRes.error) {
    return { text: wsRes.error, isError: true };
  }
  const baseCwd = wsRes.cwd;
  const maxChars = clampIntWithDefault(
    input.maxChars,
    8500,
    1e3,
    DEFAULT_INLINE_MAX_BYTES
  );
  const maxBytes = DEFAULT_INLINE_MAX_BYTES;
  const fileCache = /* @__PURE__ */ new Map();
  const normalizeCacheKey = normalizeFileCacheKey;
  async function loadLines(absPath, { useSliceCache = false, existingStat = null } = {}) {
    const key = normalizeCacheKey(absPath);
    const cachedInCall = fileCache.get(key);
    if (cachedInCall) {
      if (useSliceCache) {
        setSliceCacheEntry(key, cachedInCall);
      }
      return cachedInCall;
    }
    if (useSliceCache) {
      const stat = existingStat ?? await fs.stat(absPath);
      if (!stat.isFile()) {
        throw new Error(`Not a regular file: ${absPath}`);
      }
      const crossCached = SLICE_LINES_CACHE.get(key);
      if (crossCached && crossCached.mtimeMs === stat.mtimeMs && crossCached.size === stat.size) {
        SLICE_LINES_CACHE.delete(key);
        SLICE_LINES_CACHE.set(key, crossCached);
        const entry2 = { lines: crossCached.lines, size: crossCached.size, mtimeMs: crossCached.mtimeMs };
        fileCache.set(key, entry2);
        return entry2;
      }
    }
    const data = await readTextFile(absPath);
    const lines = data.content.replace(/\r\n/g, "\n").split("\n");
    const entry = { lines, size: data.size, mtimeMs: data.mtimeMs };
    fileCache.set(key, entry);
    if (useSliceCache) {
      setSliceCacheEntry(key, entry);
    }
    return entry;
  }
  const sections = [];
  const measuredFiles = /* @__PURE__ */ new Map();
  const measuredRelPaths = [];
  const recordMeasuredFile = (cacheKey, size, relPath) => {
    if (!Number.isFinite(size) || size <= 0) return;
    if (!measuredFiles.has(cacheKey)) {
      measuredFiles.set(cacheKey, size);
      if (relPath && measuredRelPaths.length < 4) measuredRelPaths.push(relPath);
    } else if (size > measuredFiles.get(cacheKey)) {
      measuredFiles.set(cacheKey, size);
    }
  };
  if (outlines.length > 0) {
    const outlineResults = await Promise.all(
      outlines.map(async (rawPath) => {
        const absPath = resolvePath(rawPath, baseCwd);
        const cacheKey = normalizeCacheKey(absPath);
        const relPath = toPosixPath(path4.relative(baseCwd, absPath)) || path4.basename(absPath);
        try {
          const sens = checkSensitiveFastPath(absPath);
          if (sens) {
            throw new Error(
              `Blocked reading sensitive file '${path4.basename(absPath)}' (${sens.reason}) because sensitiveFileGuard is set to 'deny'.`
            );
          }
          const stat = await fs.stat(absPath);
          if (!stat.isFile()) {
            throw new Error(`Not a regular file: ${absPath}`);
          }
          let lineCount;
          let symbols;
          const cached = OUTLINE_SYMBOL_CACHE.get(cacheKey);
          if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
            OUTLINE_SYMBOL_CACHE.delete(cacheKey);
            OUTLINE_SYMBOL_CACHE.set(cacheKey, cached);
            lineCount = cached.lineCount;
            symbols = cached.symbols;
          } else {
            const wasEvictedFromL1 = OUTLINE_L1_EVICTED_KEYS.delete(cacheKey);
            let l2Hit = null;
            const dbStore = await getOutlineDbStore();
            if (dbStore && !wasEvictedFromL1) {
              try {
                l2Hit = dbStore.getOutlineCache(absPath, stat.mtimeMs, stat.size, OUTLINE_SCHEMA_VERSION);
              } catch {
                l2Hit = null;
              }
            }
            if (l2Hit) {
              lineCount = l2Hit.lineCount;
              symbols = l2Hit.symbols;
              setOutlineL1Cache(cacheKey, {
                mtimeMs: stat.mtimeMs,
                size: stat.size,
                lineCount,
                symbols
              });
            } else {
              const { lines, size, mtimeMs } = await loadLines(absPath, { useSliceCache: false, existingStat: stat });
              lineCount = lines.length;
              symbols = extractSymbolsFromLines(absPath, lines);
              const effMtime = mtimeMs ?? stat.mtimeMs;
              const effSize = size ?? stat.size;
              setOutlineL1Cache(cacheKey, {
                mtimeMs: effMtime,
                size: effSize,
                lineCount,
                symbols
              });
              if (dbStore) {
                try {
                  dbStore.setOutlineCache(absPath, effMtime, effSize, lineCount, symbols, { version: OUTLINE_SCHEMA_VERSION });
                } catch {
                  // Strictly fail-open
                }
              }
            }
          }
          const fullPreview = renderOutlineWithinBudget(relPath, lineCount, symbols, null, outlines.length);
          recordMeasuredFile(cacheKey, stat.size, relPath);
          return { ok: true, relPath, lineCount, symbols, fullPreview };
        } catch (err) {
          if (err && err.code === "ENOENT") {
            OUTLINE_SYMBOL_CACHE.delete(cacheKey);
            deleteSliceCacheKey(cacheKey);
            if (outlineDbStore) {
              try {
                outlineDbStore.deleteOutlineCache(absPath);
              } catch {
              }
            }
          }
          const errText = `## Outline: ${relPath}\nERROR: ${err instanceof Error ? err.message : String(err)}`;
          return { ok: false, relPath, fullPreview: errText };
        }
      })
    );
    const outlinePoolBudget =
      slices.length > 0
        ? Math.max(600, Math.floor(maxChars * 0.55))
        : Math.max(600, maxChars - Math.max(0, outlines.length - 1) * 2);
    const naturalLengths = outlineResults.map((r) => Buffer.byteLength(r.fullPreview));
    const waterBudgets = computeWaterFillBudgets(naturalLengths, outlinePoolBudget, 160);
    for (let i = 0; i < outlineResults.length; i++) {
      const r = outlineResults[i];
      if (!r.ok) {
        sections.push(r.fullPreview);
      } else {
        sections.push(
          renderOutlineWithinBudget(r.relPath, r.lineCount, r.symbols, waterBudgets[i], outlines.length)
        );
      }
    }
  }
  if (slices.length > 0) {
    const sliceResults = await Promise.all(
      slices.map(async (req) => {
        if (!req || typeof req.path !== "string" || !req.path.trim()) {
          return "## Slice: (invalid)\nERROR: 'path' must be a non-empty string";
        }
        const absPath = resolvePath(req.path, baseCwd);
        const cacheKey = normalizeCacheKey(absPath);
        const relPath = toPosixPath(path4.relative(baseCwd, absPath)) || path4.basename(absPath);
        if (!Array.isArray(req.ranges) || req.ranges.length === 0) {
          return `## Slice: ${relPath}
ERROR: 'ranges' must be a non-empty array of [startLine, endLine] pairs`;
        }
        try {
          const sens = checkSensitiveFastPath(absPath);
          if (sens) {
            throw new Error(
              `Blocked reading sensitive file '${path4.basename(absPath)}' (${sens.reason}) because sensitiveFileGuard is set to 'deny'.`
            );
          }
          const { lines, size } = await loadLines(absPath, { useSliceCache: true });
          const totalLines = lines.length;
          const blocks = [];
          let validRanges = 0;
          for (const range of req.ranges) {
            if (!Array.isArray(range) || range.length < 2) {
              blocks.push("ERROR: each range must be [startLine, endLine]");
              continue;
            }
            const rawStart = Math.trunc(Number(range[0]));
            const rawEnd = Math.trunc(Number(range[1]));
            if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) {
              blocks.push(`ERROR: invalid range [${String(range[0])}, ${String(range[1])}]`);
              continue;
            }
            const start = Math.max(1, rawStart);
            const end = Math.min(totalLines, rawEnd);
            if (start > totalLines) {
              blocks.push(
                `--- L${rawStart}-L${rawEnd} (out of bounds; file has ${totalLines} lines) ---`
              );
              continue;
            }
            if (end < start) {
              blocks.push(
                `ERROR: startLine (${rawStart}) > endLine (${rawEnd})`
              );
              continue;
            }
            const width = String(end).length;
            const snippet = [`--- L${start}-L${end} (of ${totalLines}) ---`];
            for (let ln = start; ln <= end; ln++) {
              const num = String(ln).padStart(width, " ");
              snippet.push(`${num}: ${lines[ln - 1] ?? ""}`);
            }
            blocks.push(snippet.join("\n"));
            validRanges += 1;
          }
          if (validRanges > 0) {
            recordMeasuredFile(cacheKey, size, relPath);
          }
          return `## Slice: ${relPath} (${totalLines} lines)
${blocks.join("\n")}`;
        } catch (err) {
          if (err && err.code === "ENOENT") {
            OUTLINE_SYMBOL_CACHE.delete(cacheKey);
            deleteSliceCacheKey(cacheKey);
            if (outlineDbStore) {
              try {
                outlineDbStore.deleteOutlineCache(absPath);
              } catch {
              }
            }
          }
          return `## Slice: ${relPath}
ERROR: ${err instanceof Error ? err.message : String(err)}`;
        }
      })
    );
    sections.push(...sliceResults);
  }
  let fullFileRawBytes = 0;
  for (const sz of measuredFiles.values()) {
    fullFileRawBytes += sz;
  }
  const sliceModeKey = outlines.length > 0 && slices.length > 0 ? "outline+slice" : outlines.length > 0 ? "outline" : "slice";
  const sliceTelemetry = {
    kind: "fast_slice",
    key: sliceModeKey,
    path: redactSecrets(measuredRelPaths.join(", ")).text.slice(0, 120),
    worktree: baseCwd,
    rawBytes: fullFileRawBytes,
    ok: 1
  };
  const rawJoined = sections.join("\n\n");
  const rawBytes = Buffer.byteLength(rawJoined, "utf8");
  const isOverBudget = rawJoined.length > maxChars || rawBytes > maxBytes;
  const activeTip = isOverBudget && slices.length > 0 ? SLICE_TRUNCATION_TIP : isOverBudget && outlines.length > 20 ? OUTLINE_BATCH_TIP : null;
  if (activeTip && maxChars > activeTip.length + 200) {
    const tipBytes = Buffer.byteLength(activeTip, "utf8");
    const body = fitSectionsToByteBudget(
      sections,
      maxChars - activeTip.length,
      maxBytes - tipBytes,
      "\n\n"
    );
    return {
      text: `${body}${activeTip}`,
      isError: false,
      telemetry: sliceTelemetry
    };
  }
  return {
    text: fitSectionsToByteBudget(sections, maxChars, maxBytes, "\n\n"),
    isError: false,
    telemetry: sliceTelemetry
  };
}

// src/tools/run-checks.ts
import { promises as fs4 } from "node:fs";
function escapedTextBytes(text) {
  return Buffer.byteLength(JSON.stringify(text)) - 2;
}
function fitCheckText(text, maxChars, maxBytes, keepTail = false) {
  if (text.length <= maxChars && escapedTextBytes(text) <= maxBytes) return text;
  const limit = Math.max(0, Math.min(maxChars, maxBytes));
  const marker = limit >= 64 ? "\n... [truncated] ...\n" : limit >= 6 ? "..." : "";
  let lo = 0;
  let hi = Math.min(text.length, limit - marker.length);
  let fitted = marker;
  while (lo <= hi) {
    const size = Math.floor((lo + hi) / 2);
    const headSize = keepTail ? Math.floor(size / 2) : size;
    let tailStart = text.length - (size - headSize);
    const firstUnit = text.charCodeAt(tailStart);
    if (firstUnit >= 0xdc00 && firstUnit <= 0xdfff) tailStart++;
    const candidate = sliceSafeChars(text, headSize) + marker + text.slice(tailStart);
    if (escapedTextBytes(candidate) <= maxBytes) {
      fitted = candidate;
      lo = size + 1;
    } else {
      hi = size - 1;
    }
  }
  return fitted;
}
async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIdx = 0;
  async function runWorker() {
    while (true) {
      const idx = nextIdx++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx]);
    }
  }
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}
async function runChecks(input, options = {}) {
  const callDeadline = perfNode.now() + (options.budgetMs ?? MAX_MCP_CALL_BUDGET_MS);
  const coercedCmds = coerceArrayToolField(input.commands, "commands", { allowSingleString: true, optional: false });
  if (coercedCmds.error || !coercedCmds.items || coercedCmds.items.length === 0) {
    return {
      text: coercedCmds.error || "Error: 'commands' must be a non-empty array of check commands.",
      isError: true
    };
  }
  const commandsList = coercedCmds.items;
  if (commandsList.length > 12) {
    return {
      text: "Error: 'commands' supports at most 12 commands per call.",
      isError: true
    };
  }
  const wsRes = await resolveToolWorkspaceCwd(input.cwd, options);
  if (wsRes.error) {
    return { text: wsRes.error, isError: true };
  }
  const baseCwd = wsRes.cwd;
  try {
    const st = await fs4.stat(baseCwd);
    if (!st.isDirectory()) {
      return { text: `Error: cwd is not a directory: ${baseCwd}`, isError: true };
    }
  } catch {
    return { text: `Error: cwd does not exist: ${baseCwd}`, isError: true };
  }
  const concurrency = clampInt2(input.concurrency ?? 4, 1, 8);
  const defaultTimeoutSec = clampInt2(input.timeoutSec ?? 60, 1, MAX_MCP_CALL_BUDGET_SEC);
  const outputMode = input.outputMode === "full" ? "full" : "compact";
  const maxChars = clampInt2(input.maxChars ?? 8e3, 500, DEFAULT_INLINE_MAX_BYTES);
  const maxBytes = DEFAULT_INLINE_MAX_BYTES;
  const budgetSecDisplay =
    options.budgetMs !== void 0
      ? Math.max(1, Math.round(options.budgetMs / 1e3))
      : MAX_MCP_CALL_BUDGET_SEC;
  const normalized = [];
  for (let i = 0; i < commandsList.length; i++) {
    const raw = commandsList[i];
    const spec = typeof raw === "string" ? { command: raw } : raw;
    if (!spec || typeof spec.command !== "string" || !spec.command.trim()) {
      return {
        text: `Error: commands[${i}] must contain a non-empty 'command' string.`,
        isError: true
      };
    }
    const cmdCwd = spec.cwd ? resolvePath(spec.cwd, baseCwd) : baseCwd;
    if (spec.cwd) {
      try {
        const st = await fs4.stat(cmdCwd);
        if (!st.isDirectory()) {
          return {
            text: `Error: commands[${i}].cwd is not a directory: ${cmdCwd}`,
            isError: true
          };
        }
      } catch {
        return {
          text: `Error: commands[${i}].cwd does not exist: ${cmdCwd}`,
          isError: true
        };
      }
    }
    const cmdTimeoutSec = clampInt2(
      spec.timeoutSec ?? defaultTimeoutSec,
      1,
      MAX_MCP_CALL_BUDGET_SEC
    );
    normalized.push({
      index: i,
      name: spec.name?.trim() || `check-${i + 1}`,
      command: spec.command.trim(),
      cwd: cmdCwd,
      timeoutMs: cmdTimeoutSec * 1e3
    });
  }
  const wallStart = Date.now();
  const outcomes = await mapWithConcurrency(
    normalized,
    concurrency,
    async (spec) => {
      const remainingMs = callDeadline - perfNode.now();
      if (remainingMs < 500) {
        return {
          spec,
          skippedForBudget: true,
          passed: false,
          result: {
            exitCode: null,
            signal: null,
            timedOut: false,
            durationMs: 0,
            stdout: "",
            stderr: "",
            truncated: false,
            error: null
          }
        };
      }
      const effectiveTimeoutMs = Math.max(100, Math.min(spec.timeoutMs, Math.floor(remainingMs)));
      const result = await runShellCommandAsync(spec.command, {
        cwd: spec.cwd,
        keepFailureTail: true,
        timeoutMs: effectiveTimeoutMs
      });
      const passed = !result.error && !result.timedOut && result.exitCode === 0;
      return { spec, skippedForBudget: false, result, passed };
    }
  );
  BATCH_SEARCH_CACHE.clear();
  const wallMs = Date.now() - wallStart;
  const passedCount = outcomes.filter((o) => o.passed).length;
  const failedCount = outcomes.length - passedCount;
  const summaryHeader = failedCount === 0 ? `Checks: ${passedCount}/${outcomes.length} passed (wall: ${wallMs}ms)` : `Checks: ${passedCount}/${outcomes.length} passed, ${failedCount} failed (wall: ${wallMs}ms)`;
  const usableChars = Math.max(200, maxChars - summaryHeader.length - 4);
  const preFormatted = outcomes.map(({ spec, skippedForBudget, result, passed }) => {
    if (skippedForBudget) {
      const msg = `[NOT RUN: ${budgetSecDisplay}s MCP call budget exhausted]`;
      const block = `## [SKIPPED] ${spec.name}\n$ ${spec.command}\n${msg}`;
      return { skippedForBudget: true, passed: false, naturalLen: block.length, fixedBlock: block };
    }
    const badge = result.error ? "ERROR" : result.timedOut ? "TIMEOUT" : passed ? "PASS" : `FAIL (exit ${result.exitCode ?? "err"})`;
    if (outputMode === "full") {
      const combined = [
        normalizeTerminalOutput(result.stdout),
        normalizeTerminalOutput(result.stderr)
      ].filter(Boolean).join("\n");
      const rawBody = result.error ? `spawn error: ${result.error}` : combined || "(no output)";
      const headerPrefix = `## [${badge}] ${spec.name} (${result.durationMs}ms)\n$ ${spec.command}\n`;
      return {
        skippedForBudget: false,
        passed,
        badge,
        headerPrefix,
        rawBody,
        naturalLen: headerPrefix.length + rawBody.length
      };
    }
    const passingTest = passed && isRecognizedTestCheck(spec.command, spec.cwd);
    const maxProbe = passed && !passingTest ? 300 : usableChars;
    const rawCompact = formatCompactCommandOutput({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      error: result.error,
      maxChars: maxProbe,
      maxBytes,
      retainFailureEnds: !passed,
      passingTest
    });
    const headerPrefix = passed
      ? `- [PASS ${result.durationMs}ms] ${spec.name} (\`${spec.command}\`): `
      : `## [${badge} ${result.durationMs}ms] ${spec.name}\n$ ${spec.command}\n`;
    return {
      skippedForBudget: false,
      passed,
      badge,
      headerPrefix,
      rawBody: rawCompact,
      passingTest,
      naturalLen: headerPrefix.length + rawCompact.length
    };
  });
  const separator = "\n\n";
  const bodyChars = maxChars - summaryHeader.length - separator.length * outcomes.length;
  // Quotes, backslashes and line breaks take extra bytes in the final JSON-RPC frame.
  const rpcOverhead = options.rpcId === undefined ? 0 :
    Buffer.byteLength(JSON.stringify(makeToolRpcResponse(options.rpcId, "", false))) + 1;
  const bodyBytes = maxBytes - rpcOverhead - escapedTextBytes(summaryHeader) - escapedTextBytes(separator) * outcomes.length;
  const charBudgets = computeWaterFillBudgets(preFormatted.map((p) => p.naturalLen), bodyChars);
  const byteBudgets = computeWaterFillBudgets(
    preFormatted.map((p) => escapedTextBytes(p.fixedBlock ?? p.headerPrefix + p.rawBody)), bodyBytes
  );
  const blocks = preFormatted.map((pre, idx) => {
    const chars = charBudgets[idx];
    const bytes = byteBudgets[idx];
    if (pre.skippedForBudget) return fitCheckText(pre.fixedBlock, chars, bytes, true);
    if (pre.naturalLen <= chars && escapedTextBytes(pre.headerPrefix + pre.rawBody) <= bytes) {
      return pre.headerPrefix + pre.rawBody;
    }
    // A long command line should not consume the entire allowance of a failed check.
    const reservedChars = pre.passed ? 0 : Math.min(Math.floor(chars / 2), pre.rawBody.length);
    const reservedBytes = pre.passed ? 0 : Math.min(Math.floor(bytes / 2), escapedTextBytes(pre.rawBody));
    const prefix = fitCheckText(pre.headerPrefix, chars - reservedChars, bytes - reservedBytes);
    const bodyCharLimit = chars - prefix.length;
    const bodyByteLimit = bytes - escapedTextBytes(prefix);
    const body = pre.passingTest ? formatCompactCommandOutput({
      ...outcomes[idx].result, passingTest: true, maxChars: bodyCharLimit, maxBytes: bodyByteLimit
    }) : pre.rawBody;
    return prefix + fitCheckText(body, bodyCharLimit, bodyByteLimit, !pre.passed);
  });
  let totalCheckRawBytes = 0;
  for (const { skippedForBudget, result } of outcomes) {
    if (skippedForBudget || result.error) continue;
    const rawOut = (result.stdout || "").replace(/\r\n/g, "\n");
    const rawErr = (result.stderr || "").replace(/\r\n/g, "\n");
    const combinedRaw = rawOut + (rawErr ? (rawOut && !rawOut.endsWith("\n") ? "\n" : "") + rawErr : "");
    totalCheckRawBytes += Buffer.byteLength(combinedRaw, "utf8");
  }
  const checkPathSummary = redactSecrets(
    normalized
      .slice(0, 3)
      .map((s) => s.name || s.command)
      .join(", ")
  ).text.slice(0, 120);
  const text = [summaryHeader, ...blocks].join(separator);
  return {
    text,
    isError: false,
    telemetry: {
      kind: "fast_check",
      key: outputMode,
      path: checkPathSummary,
      worktree: baseCwd,
      rawBytes: totalCheckRawBytes,
      ok: failedCount === 0 ? 1 : 0
    }
  };
}
function clampInt2(val, min, max) {
  if (!Number.isFinite(val)) return min;
  return Math.max(min, Math.min(max, Math.trunc(val)));
}

// src/mcp-server.ts
var SERVER_VERSION = "0.2.2";
function createAgyFastServer() {
  const server = new McpStdioServer({
    name: "agy-fast",
    version: SERVER_VERSION
  });
  server.registerTool(
    {
      name: "batch_search",
      description: "Batch file or read-only git searches (pass cwd).",
      inputSchema: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          queries: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["text", "regex", "glob", "fuzzy", "git"] },
                pattern: { type: "string" },
                path: { type: "string" },
                glob: { type: "string" },
                caseSensitive: { type: "boolean" },
                fileType: { type: "string" },
                multiline: { type: "boolean" },
                outputMode: { type: "string", enum: ["content", "files_with_matches", "count"] },
                sortBy: { type: "string", enum: ["path", "mtime"] },
                contextLines: { type: "integer", minimum: 0, maximum: 5 },
                maxResults: { type: "integer", minimum: 1, maximum: 200 }
              },
              required: ["type", "pattern"]
            }
          },
          maxChars: { type: "integer", minimum: 500, maximum: 8800 }
        },
        required: ["queries"]
      }
    },
    (args, ctx) => runBatchSearch(args, ctx)
  );
  server.registerTool(
    {
      name: "apply_edits",
      description: "Atomic edits (pass cwd). Group hunks by path; bestEffort skips bad files; verify runs after write.",
      inputSchema: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          edits: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                hunks: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      target: { type: "string" },
                      replacement: { type: "string" },
                      startLine: { type: "integer", minimum: 1 },
                      endLine: { type: "integer", minimum: 1 },
                      replaceAll: { type: "boolean" }
                    },
                    required: ["target", "replacement"]
                  }
                },
                create: { type: "string" },
                overwrite: { type: "boolean" }
              },
              required: ["path"]
            }
          },
          dryRun: { type: "boolean" },
          bestEffort: { type: "boolean" },
          verify: { type: "string" },
          verifyTimeoutSec: { type: "integer", minimum: 1, maximum: 170 },
          maxVerifyChars: { type: "integer", minimum: 300, maximum: 7500 }
        },
        required: ["edits"]
      }
    },
    (args, ctx) => runApplyEdits(args, ctx)
  );
  server.registerTool(
    {
      name: "read_slices",
      description: "Outline files or read lineRanges like 'path:1-5,9-12' (pass cwd).",
      inputSchema: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          outlines: {
            type: "array",
            maxItems: 40,
            items: { type: "string" }
          },
          slices: {
            type: "array",
            maxItems: 30,
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                ranges: {
                  type: "array",
                  minItems: 1,
                  items: {
                    type: "array",
                    minItems: 2,
                    maxItems: 2,
                    items: { type: "integer", minimum: 1 }
                  }
                }
              },
              required: ["path", "ranges"]
            }
          },
          lineRanges: {
            type: "array",
            maxItems: 30,
            items: { type: "string" }
          },
          maxChars: { type: "integer", minimum: 1e3, maximum: 8800 }
        }
      }
    },
    (args, ctx) => runReadSlices(args, ctx)
  );
  server.registerTool(
    {
      name: "run_checks",
      description: "Run independent shell checks concurrently (pass cwd).",
      inputSchema: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          commands: {
            type: "array",
            minItems: 1,
            maxItems: 12,
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                command: { type: "string" },
                cwd: { type: "string" },
                timeoutSec: { type: "integer", minimum: 1, maximum: 170 }
              },
              required: ["command"]
            }
          },
          concurrency: { type: "integer", minimum: 1, maximum: 8 },
          timeoutSec: { type: "integer", minimum: 1, maximum: 170 },
          outputMode: {
            type: "string",
            enum: ["compact", "full"]
          },
          maxChars: { type: "integer", minimum: 500, maximum: 8800 }
        },
        required: ["commands"]
      }
    },
    (args, ctx) => runChecks(args, ctx)
  );
  return server;
}
function main() {
  process.stdout.on("error", (err) => {
    if (err && (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED")) return;
  });
  const server = createAgyFastServer();
  const exitImmediately = () => {
    closeOutlineDbStore();
    closeFastTelemetryStore();
    process.exit(0);
  };
  let flushing = false;
  const flushAndExit = () => {
    if (flushing) return;
    flushing = true;
    closeOutlineDbStore();
    closeFastTelemetryStore();
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
  };
  process.on("SIGINT", exitImmediately);
  process.on("SIGTERM", exitImmediately);
  if (process.platform === "win32") {
    process.on("SIGBREAK", exitImmediately);
  }
  process.on("exit", () => {
    closeOutlineDbStore();
    closeFastTelemetryStore();
  });
  server.listen(process.stdin, process.stdout, flushAndExit);
}
const isDirectFastRun = Boolean(
  process.argv[1] &&
    normalizeCompareDirFast(process.argv[1]) === normalizeCompareDirFast(FAST_SELF_PATH)
);
if (isDirectFastRun) {
  main();
}
export {
  SAFE_GIT_CONFIG_ARGS,
  computeWaterFillBudgets,
  createAgyFastServer,
  isInsideInstalledPluginDir,
  parseFlatLineRangeSpec,
  runApplyEdits,
  runBatchSearch,
  runChecks,
  runReadSlices,
  validateReadonlyGitArgs
};
