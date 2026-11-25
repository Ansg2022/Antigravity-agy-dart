/**
 * Compliant quota snapshot ingestion (official Antigravity CLI `statusLine` stdin JSON)
 * and local 5-hour / 7-day rolling transcript usage aggregation for agy-dart.
 *
 * Security boundary:
 * - Zero external dependencies (Node built-ins only)
 * - Zero process scraping, port scanning, credential extraction, or undocumented RPC calls
 * - Strict canonical-path containment for local transcript directories
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  extractStepTokenUsage,
  getAntigravityBrainRoots,
  isSafeConversationId,
  parseTranscriptLines
} from "./cache-analyzer.js";
import { resolveModelProfile, roundUsd } from "./cache/profiles.js";

export const QUOTA_STATUSLINE_META_KEY = "quota:statusline_snapshot";
export const MAX_STATUSLINE_STDIN_BYTES = 256 * 1024;
export const MAX_QUOTA_BUCKETS = 24;
export const WINDOW_5H_MS = 5 * 60 * 60 * 1000;
export const WINDOW_7D_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_LOCAL_USAGE_MAX_FILES = 160;
export const DEFAULT_LOCAL_USAGE_MAX_FILE_BYTES = 24 * 1024 * 1024;

const LIVE_FRESHNESS_SEC = 15 * 60;
const STALE_FRESHNESS_SEC = 2 * 60 * 60;
const RATE_LIMIT_RE =
  /\b429\b|RESOURCE_EXHAUSTED|rate[_\s-]?limit|quota[_\s-]?(?:exceeded|exhausted|limit|reached)|too\s+many\s+requests/i;
const PREFERRED_TRANSCRIPT_REL_PATHS = Object.freeze([
  [".system_generated", "logs", "transcript.jsonl"],
  [".system_generated", "transcript.jsonl"],
  ["transcript.jsonl"],
  [".system_generated", "logs", "transcript_full.jsonl"],
  [".system_generated", "transcript_full.jsonl"],
  ["transcript_full.jsonl"]
]);

const BUCKET_PRIORITY = new Map([
  ["gemini-5h", 1],
  ["gemini-weekly", 2],
  ["3p-5h", 3],
  ["3p-weekly", 4]
]);

function cleanShortString(val, maxLen = 128) {
  if (typeof val !== "string") return "";
  return val
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .trim()
    .slice(0, maxLen);
}

function toFiniteNumber(val) {
  if (typeof val === "number" && Number.isFinite(val)) return val;
  if (typeof val === "string" && val.trim() !== "") {
    const n = Number(val);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

function parseIsoOrEpochMs(val) {
  if (typeof val === "number" && Number.isFinite(val) && val > 0) {
    return val < 1e12 ? Math.round(val * 1000) : Math.round(val);
  }
  if (typeof val === "string" && val.trim()) {
    const t = Date.parse(val.trim());
    if (Number.isFinite(t) && t > 0) return t;
  }
  return null;
}

export function classifyBucketFamily(bucketId) {
  const s = String(bucketId || "").toLowerCase();
  if (/^(?:gemini|google)/.test(s) || s.includes("gemini")) return "gemini";
  if (/^(?:3p|third[-_]?party|claude|anthropic|openai|gpt)/.test(s) || /(?:3p|claude|gpt)/.test(s)) return "3p";
  return "other";
}

export function classifyBucketWindow(bucketId) {
  const s = String(bucketId || "").toLowerCase();
  if (/(?:^|[-_\s])5h(?:$|[-_\s])|5[-_\s]?hour/.test(s)) return "5h";
  if (/(?:^|[-_\s])(?:7d|weekly|week)(?:$|[-_\s])/.test(s)) return "weekly";
  return "other";
}

export function formatBucketLabel(bucketId, family = null, windowKind = null) {
  const fam = family || classifyBucketFamily(bucketId);
  const win = windowKind || classifyBucketWindow(bucketId);
  if (fam === "gemini" && win === "5h") return "Gemini 5h";
  if (fam === "gemini" && win === "weekly") return "Gemini Weekly";
  if (fam === "3p" && win === "5h") return "3P 5h";
  if (fam === "3p" && win === "weekly") return "3P Weekly";
  const cleaned = cleanShortString(bucketId, 48);
  if (!cleaned) return "Quota";
  return cleaned
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => {
      if (part.toLowerCase() === "3p") return "3P";
      if (part.toLowerCase() === "5h") return "5h";
      if (part.toLowerCase() === "7d") return "7d";
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

export function formatResetDuration(seconds) {
  const sec = toFiniteNumber(seconds);
  if (sec === null || sec < 0) return "--";
  if (sec === 0) return "reset";
  const totalMin = Math.ceil(sec / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`;
  return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
}

function normalizeSingleBucket(rawId, rawEntry, capturedAtMs) {
  if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) return null;
  const id = cleanShortString(rawId || rawEntry.id || rawEntry.bucket_id || rawEntry.bucketId, 64);
  if (!id) return null;

  let remainingFraction = toFiniteNumber(rawEntry.remaining_fraction ?? rawEntry.remainingFraction);
  if (remainingFraction === null) {
    const remPct = toFiniteNumber(rawEntry.remaining_percentage ?? rawEntry.remainingPercentage);
    if (remPct !== null) {
      remainingFraction = remPct / 100;
    } else {
      const remAmt = toFiniteNumber(rawEntry.remaining_amount ?? rawEntry.remainingAmount ?? rawEntry.remaining);
      const limAmt = toFiniteNumber(rawEntry.limit_amount ?? rawEntry.limitAmount ?? rawEntry.limit);
      if (remAmt !== null && limAmt !== null && limAmt > 0) {
        remainingFraction = remAmt / limAmt;
      }
    }
  }
  if (remainingFraction === null) return null;
  remainingFraction = clamp(remainingFraction, 0, 1);

  const resetInRaw = toFiniteNumber(rawEntry.reset_in_seconds ?? rawEntry.resetInSeconds);
  const resetInSeconds = resetInRaw !== null && resetInRaw >= 0 ? Math.round(resetInRaw) : null;
  let resetAtMs = parseIsoOrEpochMs(rawEntry.reset_time ?? rawEntry.resetTime ?? rawEntry.resetAtMs);
  if (resetAtMs === null && resetInSeconds !== null) {
    resetAtMs = capturedAtMs + resetInSeconds * 1000;
  }
  const resetTime = resetAtMs !== null ? new Date(resetAtMs).toISOString() : null;

  const remainingAmount = toFiniteNumber(rawEntry.remaining_amount ?? rawEntry.remainingAmount);
  const limitAmount = toFiniteNumber(rawEntry.limit_amount ?? rawEntry.limitAmount);
  const family = classifyBucketFamily(id);
  const windowKind = classifyBucketWindow(id);
  const label = cleanShortString(rawEntry.label, 64) || formatBucketLabel(id, family, windowKind);

  return {
    id,
    label,
    family,
    window: windowKind,
    remainingFraction: Math.round(remainingFraction * 10000) / 10000,
    resetTime,
    resetAtMs,
    ...(remainingAmount !== null ? { remainingAmount } : {}),
    ...(limitAmount !== null && limitAmount > 0 ? { limitAmount } : {})
  };
}

/**
 * Validate and normalize an official Antigravity CLI `statusLine` stdin payload (or stored snapshot).
 * Returns null if the input is malformed or contains neither quota buckets nor recognized status metadata.
 */
export function normalizeStatusLineQuotaPayload(raw, { nowMs = Date.now() } = {}) {
  if (raw === null || raw === undefined) return null;
  let obj = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed || Buffer.byteLength(trimmed, "utf8") > MAX_STATUSLINE_STDIN_BYTES) return null;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;

  const capturedAtMs = parseIsoOrEpochMs(obj.capturedAtMs ?? obj.captured_at ?? obj.capturedAt) ?? Math.round(nowMs);
  const product = cleanShortString(obj.product, 64);
  const version = cleanShortString(obj.version, 64);
  const agentState = cleanShortString(obj.agent_state ?? obj.agentState, 64);

  let model = null;
  if (typeof obj.model === "string") {
    const name = cleanShortString(obj.model, 128);
    if (name) model = { id: name, displayName: name, effort: "" };
  } else if (obj.model && typeof obj.model === "object" && !Array.isArray(obj.model)) {
    const id = cleanShortString(obj.model.id, 128);
    const displayName = cleanShortString(obj.model.display_name ?? obj.model.displayName ?? id, 128);
    const effort = cleanShortString(obj.model.effort, 32);
    if (id || displayName) {
      model = { id: id || displayName, displayName: displayName || id, effort };
    }
  }

  let contextWindow = null;
  const rawCtx = obj.context_window ?? obj.contextWindow;
  if (rawCtx && typeof rawCtx === "object" && !Array.isArray(rawCtx)) {
    const used = toFiniteNumber(rawCtx.used_percentage ?? rawCtx.usedPercentage);
    const rem = toFiniteNumber(rawCtx.remaining_percentage ?? rawCtx.remainingPercentage);
    if (used !== null || rem !== null) {
      const clampedUsed = used !== null ? clamp(used, 0, 100) : clamp(100 - rem, 0, 100);
      const clampedRem = rem !== null ? clamp(rem, 0, 100) : clamp(100 - clampedUsed, 0, 100);
      contextWindow = {
        usedPercentage: Math.round(clampedUsed * 100) / 100,
        remainingPercentage: Math.round(clampedRem * 100) / 100
      };
    }
  }

  const buckets = [];
  const seenIds = new Set();
  const rawQuota = obj.quota ?? obj.buckets;
  if (Array.isArray(rawQuota)) {
    for (const entry of rawQuota) {
      if (buckets.length >= MAX_QUOTA_BUCKETS) break;
      const norm = normalizeSingleBucket(entry?.id ?? entry?.bucket_id, entry, capturedAtMs);
      if (norm && !seenIds.has(norm.id)) {
        seenIds.add(norm.id);
        buckets.push(norm);
      }
    }
  } else if (rawQuota && typeof rawQuota === "object") {
    for (const [k, v] of Object.entries(rawQuota)) {
      if (buckets.length >= MAX_QUOTA_BUCKETS) break;
      const norm = normalizeSingleBucket(k, v, capturedAtMs);
      if (norm && !seenIds.has(norm.id)) {
        seenIds.add(norm.id);
        buckets.push(norm);
      }
    }
  }

  buckets.sort((a, b) => {
    const pa = BUCKET_PRIORITY.get(a.id.toLowerCase()) ?? 99;
    const pb = BUCKET_PRIORITY.get(b.id.toLowerCase()) ?? 99;
    if (pa !== pb) return pa - pb;
    return a.id.localeCompare(b.id);
  });

  const hasRecognizedMetadata = Boolean(product || model || contextWindow || obj.quota !== undefined);
  if (buckets.length === 0 && !hasRecognizedMetadata) return null;

  return {
    schemaVersion: 1,
    source: "cli_statusline",
    capturedAtMs,
    capturedAt: new Date(capturedAtMs).toISOString(),
    product: product || "antigravity",
    version,
    agentState,
    model,
    contextWindow,
    buckets
  };
}

/**
 * Project a stored statusLine snapshot onto current wall-clock time (live reset countdowns & freshness).
 */
export function projectQuotaSnapshot(snapshot, { nowMs = Date.now() } = {}) {
  const normalized = snapshot?.schemaVersion === 1 && Array.isArray(snapshot.buckets)
    ? snapshot
    : normalizeStatusLineQuotaPayload(snapshot, { nowMs });

  if (!normalized || normalized.buckets.length === 0) {
    return {
      available: false,
      source: "cli_statusline",
      freshness: "empty",
      ageSec: null,
      capturedAtMs: normalized?.capturedAtMs ?? null,
      capturedAt: normalized?.capturedAt ?? null,
      product: normalized?.product || "antigravity",
      version: normalized?.version || "",
      agentState: normalized?.agentState || "",
      model: normalized?.model || null,
      contextWindow: normalized?.contextWindow || null,
      overallSeverity: "none",
      lowestBucket: null,
      buckets: []
    };
  }

  const ageSec = Math.max(0, Math.round((nowMs - normalized.capturedAtMs) / 1000));
  const projectedBuckets = normalized.buckets.map((b) => {
    const remainingPercent = Math.round(clamp(b.remainingFraction, 0, 1) * 1000) / 10;
    const remainingResetSec =
      typeof b.resetAtMs === "number" && Number.isFinite(b.resetAtMs)
        ? Math.max(0, Math.round((b.resetAtMs - nowMs) / 1000))
        : null;
    const isResetElapsed =
      typeof b.resetAtMs === "number" && Number.isFinite(b.resetAtMs) && b.resetAtMs <= nowMs;
    const severity = remainingPercent < 20 ? "critical" : remainingPercent < 50 ? "warn" : "ok";
    return {
      ...b,
      remainingPercent,
      remainingResetSec,
      resetCountdownLabel: remainingResetSec !== null ? formatResetDuration(remainingResetSec) : "--",
      isResetElapsed,
      severity
    };
  });

  const timedBuckets = projectedBuckets.filter((b) => typeof b.resetAtMs === "number" && Number.isFinite(b.resetAtMs));
  const allResetsElapsed = timedBuckets.length > 0 && timedBuckets.every((b) => b.isResetElapsed);

  let freshness = "live";
  if (ageSec > STALE_FRESHNESS_SEC || allResetsElapsed) {
    freshness = "stale";
  } else if (ageSec > LIVE_FRESHNESS_SEC) {
    freshness = "aging";
  }

  let lowestBucket = projectedBuckets[0];
  for (const b of projectedBuckets) {
    if (b.remainingFraction < lowestBucket.remainingFraction) lowestBucket = b;
  }

  return {
    available: true,
    source: normalized.source || "cli_statusline",
    freshness,
    ageSec,
    capturedAtMs: normalized.capturedAtMs,
    capturedAt: normalized.capturedAt,
    product: normalized.product || "antigravity",
    version: normalized.version || "",
    agentState: normalized.agentState || "",
    model: normalized.model || null,
    contextWindow: normalized.contextWindow || null,
    overallSeverity: lowestBucket ? lowestBucket.severity : "ok",
    lowestBucket: lowestBucket
      ? {
          id: lowestBucket.id,
          label: lowestBucket.label,
          remainingPercent: lowestBucket.remainingPercent,
          severity: lowestBucket.severity
        }
      : null,
    buckets: projectedBuckets
  };
}

/**
 * Persist a normalized official statusLine quota snapshot into ContextModeStore `meta`.
 * Preserves existing buckets if an incoming CLI tick omits quota buckets transiently.
 */
export function saveStatusLineQuotaSnapshot(store, rawPayload, { nowMs = Date.now() } = {}) {
  if (!store || typeof store.setMeta !== "function") {
    return { saved: false, snapshot: null };
  }
  const normalized = normalizeStatusLineQuotaPayload(rawPayload, { nowMs });
  if (!normalized) {
    return { saved: false, snapshot: null };
  }

  let toStore = normalized;
  if (normalized.buckets.length === 0) {
    const existing = readStatusLineQuotaSnapshot(store, { nowMs });
    if (existing && existing.buckets.length > 0) {
      toStore = {
        ...existing,
        model: normalized.model || existing.model,
        contextWindow: normalized.contextWindow || existing.contextWindow,
        agentState: normalized.agentState || existing.agentState
      };
    }
  }

  store.setMeta(QUOTA_STATUSLINE_META_KEY, JSON.stringify(toStore));
  return { saved: true, snapshot: toStore };
}

/**
 * Read the last persisted official statusLine quota snapshot from ContextModeStore `meta`.
 */
export function readStatusLineQuotaSnapshot(store, { nowMs = Date.now() } = {}) {
  if (!store || typeof store.getMeta !== "function") return null;
  try {
    const raw = store.getMeta(QUOTA_STATUSLINE_META_KEY, null);
    if (!raw) return null;
    return normalizeStatusLineQuotaPayload(raw, { nowMs });
  } catch {
    return null;
  }
}

/**
 * Render a concise single-line terminal status string for Antigravity CLI `statusLine` stdout.
 */
export function formatStatusLineOutput(snapshot, { nowMs = Date.now() } = {}) {
  const projected = projectQuotaSnapshot(snapshot, { nowMs });
  const parts = ["agy-dart"];

  if (projected.model?.displayName) {
    parts.push(projected.model.displayName);
  }
  if (projected.contextWindow && Number.isFinite(projected.contextWindow.usedPercentage)) {
    parts.push(`Ctx ${Math.round(projected.contextWindow.usedPercentage)}%`);
  }

  if (projected.buckets.length > 0) {
    const modelStr = String(projected.model?.displayName || projected.model?.id || "").toLowerCase();
    const preferFamily = /(?:claude|sonnet|opus|haiku|gpt|openai|anthropic)/.test(modelStr) ? "3p" : "gemini";
    let selected = projected.buckets.filter((b) => b.family === preferFamily);
    if (selected.length === 0) selected = projected.buckets;
    for (const b of selected.slice(0, 2)) {
      const winTag = b.window === "5h" ? "5h" : b.window === "weekly" ? "7d" : b.label;
      const pctStr = `${Math.round(b.remainingPercent)}%`;
      const resetSuffix = b.remainingResetSec !== null ? ` (${b.resetCountdownLabel})` : "";
      parts.push(`${winTag} ${pctStr}${resetSuffix}`);
    }
  }

  return parts.join(" | ").replace(/[\r\n]+/g, " ");
}

export function getDefaultCliSettingsPath() {
  return path.join(os.homedir(), ".gemini", "antigravity-cli", "settings.json");
}

export function getDefaultStatusLineBackupPath() {
  return path.join(os.homedir(), ".agy-dart", "statusline-backup.json");
}

function normalizePosixSlashes(p) {
  return String(p || "").replace(/\\/g, "/");
}

function formatCommandPathArg(rawPath) {
  const posix = normalizePosixSlashes(rawPath);
  if (/[\s"&|<>^()'`;$]/.test(posix)) {
    return `"${posix.replace(/"/g, '\\"')}"`;
  }
  return posix;
}

function expandLeadingTilde(p) {
  if (typeof p !== "string") return "";
  const s = p.trim();
  if (s === "~") return os.homedir();
  if (s.startsWith("~/") || s.startsWith("~\\")) {
    return path.join(os.homedir(), s.slice(2));
  }
  return s;
}

function sameFsPath(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a.trim() || !b.trim()) return false;
  const na = path.resolve(a.trim());
  const nb = path.resolve(b.trim());
  return process.platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

function splitSimpleCommandTokens(commandStr) {
  if (typeof commandStr !== "string" || !commandStr.trim()) return [];
  const tokens = [];
  let cur = "";
  let quote = "";
  for (let i = 0; i < commandStr.length; i += 1) {
    const ch = commandStr[i];
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < commandStr.length && (commandStr[i + 1] === '"' || commandStr[i + 1] === "\\")) {
        cur += commandStr[i + 1];
        i += 1;
        continue;
      }
      if (ch === quote) {
        quote = "";
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur.length > 0) {
        tokens.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur.length > 0) tokens.push(cur);
  return tokens;
}

function isNodeExecutableToken(tok) {
  if (typeof tok !== "string" || !tok.trim()) return false;
  const base = path.basename(tok.trim()).toLowerCase();
  return base === "node" || base === "node.exe";
}

function isAgyDartStatusLinePath(scriptPath, pluginRoot = null) {
  if (typeof scriptPath !== "string" || !scriptPath.trim()) return false;
  const expanded = expandLeadingTilde(scriptPath);
  if (pluginRoot) {
    const expected = path.join(path.resolve(pluginRoot), "hooks", "statusline.mjs");
    if (sameFsPath(expanded, expected)) return true;
  }
  const posix = normalizePosixSlashes(path.resolve(expanded)).toLowerCase();
  return posix.endsWith("/agy-dart/hooks/statusline.mjs");
}

function parseNodeStatusLineCommand(commandStr, pluginRoot = null) {
  const tokens = splitSimpleCommandTokens(commandStr);
  if (tokens.length < 2 || !isNodeExecutableToken(tokens[0])) {
    return { isNode: false, isAgyDart: false, scriptPath: "", chainedScriptPath: "" };
  }
  const rawScript = tokens[1];
  if (!rawScript || rawScript.startsWith("-")) {
    return { isNode: false, isAgyDart: false, scriptPath: "", chainedScriptPath: "" };
  }
  const scriptPath = path.resolve(expandLeadingTilde(rawScript));
  const isAgyDart = isAgyDartStatusLinePath(scriptPath, pluginRoot);
  let chainedScriptPath = "";
  const extraTokens = tokens.slice(2);
  if (isAgyDart) {
    for (let i = 0; i < extraTokens.length; i += 1) {
      const arg = extraTokens[i];
      if (arg === "--chain-script" && i + 1 < extraTokens.length) {
        chainedScriptPath = path.resolve(expandLeadingTilde(extraTokens[i + 1]));
        break;
      }
      if (arg.startsWith("--chain-script=")) {
        chainedScriptPath = path.resolve(expandLeadingTilde(arg.slice("--chain-script=".length)));
        break;
      }
    }
    return { isNode: true, isAgyDart: true, scriptPath, chainedScriptPath };
  }
  // Only auto-chain simple single-script Node statusLine commands (`node <script>`) without extra custom flags
  if (extraTokens.length > 0) {
    return { isNode: false, isAgyDart: false, scriptPath: "", chainedScriptPath: "" };
  }
  return { isNode: true, isAgyDart: false, scriptPath, chainedScriptPath: "" };
}

/**
 * Inspect an existing Antigravity CLI `settings.json` statusLine entry without modifying disk.
 */
export function inspectExistingCliStatusLine(settingsPath = getDefaultCliSettingsPath(), { pluginRoot = null } = {}) {
  const resolvedSettings = path.resolve(expandLeadingTilde(settingsPath || getDefaultCliSettingsPath()));
  if (!fs.existsSync(resolvedSettings)) {
    return {
      exists: false,
      parseError: null,
      settingsPath: resolvedSettings,
      rawSettings: null,
      statusLine: null,
      kind: "none",
      existingCommand: "",
      existingScriptPath: "",
      chainedScriptPath: ""
    };
  }
  let parsed;
  try {
    const rawText = fs.readFileSync(resolvedSettings, "utf8").replace(/^\uFEFF/, "");
    parsed = rawText.trim() ? JSON.parse(rawText) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("settings.json root must be a JSON object");
    }
  } catch (err) {
    return {
      exists: true,
      parseError: err instanceof Error ? err.message : String(err),
      settingsPath: resolvedSettings,
      rawSettings: null,
      statusLine: null,
      kind: "invalid_json",
      existingCommand: "",
      existingScriptPath: "",
      chainedScriptPath: ""
    };
  }

  const sl = parsed.statusLine && typeof parsed.statusLine === "object" && !Array.isArray(parsed.statusLine)
    ? parsed.statusLine
    : null;
  const cmd = typeof sl?.command === "string" ? sl.command.trim() : "";
  if (!sl || !cmd) {
    return {
      exists: true,
      parseError: null,
      settingsPath: resolvedSettings,
      rawSettings: parsed,
      statusLine: sl,
      kind: "none",
      existingCommand: cmd,
      existingScriptPath: "",
      chainedScriptPath: ""
    };
  }

  const nodeInfo = parseNodeStatusLineCommand(cmd, pluginRoot);
  if (nodeInfo.isAgyDart) {
    return {
      exists: true,
      parseError: null,
      settingsPath: resolvedSettings,
      rawSettings: parsed,
      statusLine: sl,
      kind: "agy_dart",
      existingCommand: cmd,
      existingScriptPath: nodeInfo.scriptPath,
      chainedScriptPath: nodeInfo.chainedScriptPath
    };
  }
  if (nodeInfo.isNode && nodeInfo.scriptPath) {
    return {
      exists: true,
      parseError: null,
      settingsPath: resolvedSettings,
      rawSettings: parsed,
      statusLine: sl,
      kind: "other_node",
      existingCommand: cmd,
      existingScriptPath: nodeInfo.scriptPath,
      chainedScriptPath: ""
    };
  }
  return {
    exists: true,
    parseError: null,
    settingsPath: resolvedSettings,
    rawSettings: parsed,
    statusLine: sl,
    kind: "other_command",
    existingCommand: cmd,
    existingScriptPath: "",
    chainedScriptPath: ""
  };
}

function writeJsonFileAtomic(targetPath, obj) {
  const resolved = path.resolve(targetPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const tmpPath = `${resolved}.tmp.${process.pid}.${Date.now()}`;
  const serialized = JSON.stringify(obj, null, 2) + "\n";
  try {
    fs.writeFileSync(tmpPath, serialized, "utf8");
    fs.renameSync(tmpPath, resolved);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
    throw err;
  }
}

/**
 * Build a ready-to-copy `~/.gemini/antigravity-cli/settings.json` snippet pointing to `hooks/statusline.mjs`.
 * Automatically detects an existing Node statusLine plugin and produces a non-destructive `--chain-script` snippet.
 */
export function buildStatusLineSetupInfo(pluginRoot, { settingsPath = null } = {}) {
  const resolvedRoot =
    typeof pluginRoot === "string" && pluginRoot.trim()
      ? path.resolve(pluginRoot.trim())
      : path.join(os.homedir(), ".gemini", "config", "plugins", "agy-dart");
  const scriptPath = path.join(resolvedRoot, "hooks", "statusline.mjs");
  const formattedScript = formatCommandPathArg(scriptPath);
  const effectiveSettingsPath = settingsPath || getDefaultCliSettingsPath();
  const inspected = inspectExistingCliStatusLine(effectiveSettingsPath, { pluginRoot: resolvedRoot });

  let mode = "standalone";
  let chainedScriptPath = "";
  let stackWithDefault = true;
  let padding = undefined;

  if (inspected.kind === "agy_dart") {
    mode = "already_configured";
    chainedScriptPath = inspected.chainedScriptPath || "";
    if (typeof inspected.statusLine?.stack_with_default === "boolean") {
      stackWithDefault = inspected.statusLine.stack_with_default;
    }
    if (Number.isInteger(inspected.statusLine?.padding) && inspected.statusLine.padding >= 0) {
      padding = inspected.statusLine.padding;
    }
  } else if (inspected.kind === "other_node" && inspected.existingScriptPath) {
    mode = "chain";
    chainedScriptPath = inspected.existingScriptPath;
    if (typeof inspected.statusLine?.stack_with_default === "boolean") {
      stackWithDefault = inspected.statusLine.stack_with_default;
    }
    if (Number.isInteger(inspected.statusLine?.padding) && inspected.statusLine.padding >= 0) {
      padding = inspected.statusLine.padding;
    }
  } else if (inspected.kind === "other_command") {
    mode = "manual_non_node";
  }

  const command = chainedScriptPath
    ? `node ${formattedScript} --chain-script ${formatCommandPathArg(chainedScriptPath)}`
    : `node ${formattedScript}`;
  const snippetObj = {
    statusLine: {
      type: "command",
      command,
      enabled: true,
      ...(padding !== undefined ? { padding } : {}),
      stack_with_default: stackWithDefault
    }
  };
  return {
    settingsPath: inspected.settingsPath,
    scriptPath,
    command,
    mode,
    alreadyConfigured: inspected.kind === "agy_dart",
    chainedScriptPath,
    existingCommand: inspected.existingCommand || "",
    enableCommand: `node ${formattedScript} --enable`,
    disableCommand: `node ${formattedScript} --disable`,
    snippetJson: JSON.stringify(snippetObj, null, 2),
    appHint: "Settings > Models",
    cliHint: "/usage"
  };
}

/**
 * Enable the official Antigravity CLI `statusLine` bridge in `~/.gemini/antigravity-cli/settings.json`.
 * Preserves unrelated settings keys, backs up any prior `statusLine` entry, and auto-chains existing Node statusLine scripts.
 */
export function enableCliStatusLineBridge({
  pluginRoot = null,
  settingsPath = getDefaultCliSettingsPath(),
  receiptPath = getDefaultStatusLineBackupPath(),
  force = false
} = {}) {
  const resolvedRoot =
    typeof pluginRoot === "string" && pluginRoot.trim()
      ? path.resolve(pluginRoot.trim())
      : path.join(os.homedir(), ".gemini", "config", "plugins", "agy-dart");
  const scriptPath = path.join(resolvedRoot, "hooks", "statusline.mjs");
  const formattedScript = formatCommandPathArg(scriptPath);
  const resolvedReceipt = path.resolve(expandLeadingTilde(receiptPath || getDefaultStatusLineBackupPath()));
  const inspected = inspectExistingCliStatusLine(settingsPath, { pluginRoot: resolvedRoot });

  if (inspected.parseError) {
    return {
      ok: false,
      error: "invalid_settings_json",
      settingsPath: inspected.settingsPath,
      message: `Cannot parse ${inspected.settingsPath}: ${inspected.parseError}`
    };
  }

  if (inspected.kind === "other_command" && !force) {
    return {
      ok: false,
      error: "existing_non_node_statusline",
      settingsPath: inspected.settingsPath,
      existingCommand: inspected.existingCommand,
      message:
        `Existing custom non-Node statusLine detected (${inspected.existingCommand}). ` +
        `Re-run with --force to replace it (a lossless backup will be saved for --disable).`
    };
  }

  let chainedScriptPath = "";
  let mode = "standalone";
  if (inspected.kind === "agy_dart") {
    mode = "already_configured";
    chainedScriptPath = inspected.chainedScriptPath || "";
  } else if (inspected.kind === "other_node" && inspected.existingScriptPath) {
    mode = "chain";
    chainedScriptPath = inspected.existingScriptPath;
  } else if (inspected.kind === "other_command" && force) {
    mode = "replaced_with_backup";
  }

  // Save original statusLine backup once before taking ownership (idempotent across repeated --enable)
  if (inspected.kind !== "agy_dart") {
    let keepExistingReceipt = false;
    try {
      if (fs.existsSync(resolvedReceipt)) {
        const prev = JSON.parse(fs.readFileSync(resolvedReceipt, "utf8"));
        if (prev && sameFsPath(prev.settingsPath, inspected.settingsPath) && prev.version === 1) {
          keepExistingReceipt = true;
        }
      }
    } catch {}
    if (!keepExistingReceipt) {
      writeJsonFileAtomic(resolvedReceipt, {
        version: 1,
        savedAt: new Date().toISOString(),
        settingsPath: inspected.settingsPath,
        hadStatusLine: Boolean(inspected.statusLine),
        previousStatusLine: inspected.statusLine ? { ...inspected.statusLine } : null
      });
    }
  }

  const command = chainedScriptPath
    ? `node ${formattedScript} --chain-script ${formatCommandPathArg(chainedScriptPath)}`
    : `node ${formattedScript}`;

  const prevSl = inspected.statusLine || {};
  const nextStatusLine = {
    ...prevSl,
    type: "command",
    command,
    enabled: true,
    stack_with_default:
      typeof prevSl.stack_with_default === "boolean"
        ? prevSl.stack_with_default
        : mode === "standalone" || mode === "replaced_with_backup"
  };

  const nextSettings = {
    ...(inspected.rawSettings || {}),
    statusLine: nextStatusLine
  };
  writeJsonFileAtomic(inspected.settingsPath, nextSettings);

  return {
    ok: true,
    mode,
    alreadyConfigured: inspected.kind === "agy_dart",
    settingsPath: inspected.settingsPath,
    receiptPath: resolvedReceipt,
    command,
    chainedScriptPath
  };
}

/**
 * Disable the agy-dart CLI `statusLine` bridge and losslessly restore any previously configured `statusLine`.
 * Refuses to modify `settings.json` if `statusLine` is currently owned by another tool.
 */
export function disableCliStatusLineBridge({
  pluginRoot = null,
  settingsPath = getDefaultCliSettingsPath(),
  receiptPath = getDefaultStatusLineBackupPath()
} = {}) {
  const resolvedRoot =
    typeof pluginRoot === "string" && pluginRoot.trim()
      ? path.resolve(pluginRoot.trim())
      : null;
  const resolvedReceipt = path.resolve(expandLeadingTilde(receiptPath || getDefaultStatusLineBackupPath()));
  const inspected = inspectExistingCliStatusLine(settingsPath, { pluginRoot: resolvedRoot });

  if (!inspected.exists) {
    return { ok: true, changed: false, reason: "settings_missing", settingsPath: inspected.settingsPath };
  }
  if (inspected.parseError) {
    return {
      ok: false,
      changed: false,
      error: "invalid_settings_json",
      settingsPath: inspected.settingsPath,
      message: `Cannot parse ${inspected.settingsPath}: ${inspected.parseError}`
    };
  }
  if (inspected.kind !== "agy_dart") {
    return { ok: true, changed: false, reason: "not_managed_by_agy_dart", settingsPath: inspected.settingsPath };
  }

  let receipt = null;
  try {
    if (fs.existsSync(resolvedReceipt)) {
      const parsed = JSON.parse(fs.readFileSync(resolvedReceipt, "utf8"));
      if (parsed && parsed.version === 1 && sameFsPath(parsed.settingsPath, inspected.settingsPath)) {
        receipt = parsed;
      }
    }
  } catch {}

  const nextSettings = { ...(inspected.rawSettings || {}) };
  let restored = false;

  if (receipt) {
    if (receipt.hadStatusLine && receipt.previousStatusLine && typeof receipt.previousStatusLine === "object") {
      nextSettings.statusLine = { ...receipt.previousStatusLine };
      restored = true;
    } else {
      delete nextSettings.statusLine;
    }
  } else if (inspected.chainedScriptPath) {
    nextSettings.statusLine = {
      ...(inspected.statusLine || {}),
      type: "command",
      command: `node ${formatCommandPathArg(inspected.chainedScriptPath)}`
    };
    restored = true;
  } else {
    delete nextSettings.statusLine;
  }

  writeJsonFileAtomic(inspected.settingsPath, nextSettings);
  try {
    if (fs.existsSync(resolvedReceipt)) fs.unlinkSync(resolvedReceipt);
  } catch {}

  return {
    ok: true,
    changed: true,
    restored,
    settingsPath: inspected.settingsPath
  };
}

// ---------------------------------------------------------------------------
// Local Rolling 5h / 7d Transcript Spend Aggregation (App + IDE + CLI)
// ---------------------------------------------------------------------------

function isUncPath(p) {
  if (typeof p !== "string") return false;
  return /^\\\\|^\/\//.test(p);
}

function isStrictPathInside(childPath, parentPath) {
  const normParent = process.platform === "win32" ? parentPath.toLowerCase() : parentPath;
  const normChild = process.platform === "win32" ? childPath.toLowerCase() : childPath;
  const rel = path.relative(normParent, normChild);
  return Boolean(rel && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !rel.startsWith("../") && !path.isAbsolute(rel));
}

function classifyModelFamily(modelName) {
  const s = String(modelName || "").toLowerCase();
  if (!s) return "other";
  if (/(?:gemini|neon|carbon|argon|hydrogen|google)/.test(s)) return "gemini";
  if (/(?:claude|anthropic|sonnet|opus|haiku)/.test(s)) return "claude";
  if (/(?:gpt|openai|\bo[134](?:[-_/\s.]|$))/.test(s)) return "gpt";
  return "other";
}

function estimateStepReferenceUsd(usage, modelName) {
  const profile = resolveModelProfile(modelName);
  const inputPrice = profile.inputPer1M || 2.5;
  const discount = profile.cacheDiscountRate ?? 0.9;
  const writeMult = profile.cacheWriteMultiplier ?? 1.0;
  const write1hMult = profile.cacheWrite1hMultiplier ?? writeMult;
  const outputPrice = inputPrice * 4;

  const cacheCreate1h = usage.cacheCreation1hTokens || 0;
  const cacheCreate5m = Math.max(0, (usage.cacheCreationTokens || 0) - cacheCreate1h);

  const cost =
    ((usage.inputTokens || 0) * inputPrice +
      cacheCreate5m * inputPrice * writeMult +
      cacheCreate1h * inputPrice * write1hMult +
      (usage.cacheReadTokens || 0) * inputPrice * (1 - discount) +
      ((usage.outputTokens || 0) + (usage.thinkingTokens || 0)) * outputPrice) /
    1_000_000;
  return Number.isFinite(cost) && cost > 0 ? cost : 0;
}

function isRateLimitErrorStep(step) {
  if (!step || typeof step !== "object") return false;
  const status = String(step.status || "").toUpperCase();
  const type = String(step.type || "").toUpperCase();
  const hasExplicitErrField = Boolean(step.error || step.error_message || step.errorMessage);
  if (status !== "ERROR" && type !== "ERROR_MESSAGE" && !hasExplicitErrField) {
    return false;
  }
  const fields = [step.error, step.error_message, step.errorMessage];
  if (status === "ERROR" || type === "ERROR_MESSAGE") {
    fields.push(step.content, step.message);
  }
  for (const f of fields) {
    if (typeof f === "string" && f.length > 0) {
      if (RATE_LIMIT_RE.test(f.slice(0, 1024))) return true;
    } else if (f && typeof f === "object") {
      try {
        const serialized = JSON.stringify(f).slice(0, 1024);
        if (RATE_LIMIT_RE.test(serialized)) return true;
      } catch {}
    }
  }
  return false;
}

function resolveSafePreferredTranscript(rootReal, convName) {
  if (!isSafeConversationId(convName)) return null;
  const convPath = path.join(rootReal, convName);
  let convReal;
  try {
    const lst = fs.lstatSync(convPath);
    if (lst.isSymbolicLink() || !lst.isDirectory()) return null;
    convReal = fs.realpathSync(convPath);
    if (isUncPath(convReal) || !isStrictPathInside(convReal, rootReal)) return null;
  } catch {
    return null;
  }

  for (const segs of PREFERRED_TRANSCRIPT_REL_PATHS) {
    const cand = path.join(convReal, ...segs);
    try {
      const lst = fs.lstatSync(cand);
      if (lst.isSymbolicLink()) continue;
      const realFile = fs.realpathSync(cand);
      if (isUncPath(realFile) || !isStrictPathInside(realFile, convReal)) continue;
      const st = fs.statSync(realFile);
      if (st.isFile()) {
        return { convReal, filePath: realFile, stat: st };
      }
    } catch {
      // Try next preferred path
    }
  }
  return null;
}

function readTranscriptBounded(filePath, fileSize, maxFileBytes) {
  if (fileSize <= 0) return "";
  if (fileSize <= maxFileBytes) {
    return fs.readFileSync(filePath, "utf8");
  }
  let fd = null;
  try {
    fd = fs.openSync(filePath, "r");
    const startOffset = Math.max(0, fileSize - maxFileBytes);
    const len = fileSize - startOffset;
    const buf = Buffer.allocUnsafe(len);
    const bytesRead = fs.readSync(fd, buf, 0, len, startOffset);
    let text = buf.subarray(0, bytesRead).toString("utf8");
    const firstNl = text.indexOf("\n");
    if (startOffset > 0 && firstNl >= 0) {
      text = text.slice(firstNl + 1);
    }
    return text;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function parseTranscriptUsageRecords(filePath, stat, maxFileBytes) {
  const content = readTranscriptBounded(filePath, stat.size, maxFileBytes);
  const steps = parseTranscriptLines(content);
  const records = [];
  const rateLimits = [];
  let lastModel = "";
  let lastTsMs = null;

  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    const explicitTs = parseIsoOrEpochMs(step.created_at ?? step.createdAt ?? step.timestamp);
    if (explicitTs !== null) lastTsMs = explicitTs;
    const tsMs = explicitTs ?? lastTsMs ?? Math.round(stat.mtimeMs);

    if (typeof step.model === "string" && step.model.trim()) {
      lastModel = step.model.trim();
    }

    if (isRateLimitErrorStep(step)) {
      rateLimits.push(tsMs);
    }

    const usage = extractStepTokenUsage(step);
    const totalTokens =
      usage.inputTokens +
      usage.cacheReadTokens +
      usage.cacheCreationTokens +
      usage.outputTokens +
      usage.thinkingTokens;
    if (totalTokens <= 0) continue;

    const modelForStep = (typeof step.model === "string" && step.model.trim()) || lastModel;
    const family = classifyModelFamily(modelForStep);
    const nonCachedTokens =
      usage.inputTokens + usage.cacheCreationTokens + usage.outputTokens + usage.thinkingTokens;
    const estimatedUsd = estimateStepReferenceUsd(usage, modelForStep);

    records.push({
      tsMs,
      family,
      uncachedInputTokens: usage.inputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      outputTokens: usage.outputTokens,
      thinkingTokens: usage.thinkingTokens,
      totalTokens,
      nonCachedTokens,
      estimatedUsd
    });
  }

  return { records, rateLimits };
}

function createEmptyFamilyBuckets() {
  const mk = () => ({
    turns: 0,
    totalTokens: 0,
    nonCachedTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    estimatedUsd: 0
  });
  return {
    gemini: mk(),
    claude: mk(),
    gpt: mk(),
    other: mk()
  };
}

function createEmptyWindowSummary(windowMs) {
  return {
    windowMs,
    turns: 0,
    sessions: 0,
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    totalTokens: 0,
    nonCachedTokens: 0,
    estimatedUsd: 0,
    rateLimitHits: 0,
    lastRateLimitAtMs: null,
    byFamily: createEmptyFamilyBuckets()
  };
}

function addRecordToWindow(win, rec) {
  win.turns += 1;
  win.uncachedInputTokens += rec.uncachedInputTokens;
  win.cacheReadTokens += rec.cacheReadTokens;
  win.cacheCreationTokens += rec.cacheCreationTokens;
  win.outputTokens += rec.outputTokens;
  win.thinkingTokens += rec.thinkingTokens;
  win.totalTokens += rec.totalTokens;
  win.nonCachedTokens += rec.nonCachedTokens;
  win.estimatedUsd += rec.estimatedUsd;

  const fam = win.byFamily[rec.family] || win.byFamily.other;
  fam.turns += 1;
  fam.totalTokens += rec.totalTokens;
  fam.nonCachedTokens += rec.nonCachedTokens;
  fam.cacheReadTokens += rec.cacheReadTokens;
  fam.outputTokens += rec.outputTokens;
  fam.estimatedUsd += rec.estimatedUsd;
}

function finalizeWindowUsd(win) {
  win.estimatedUsd = roundUsd(win.estimatedUsd);
  for (const fam of Object.values(win.byFamily)) {
    fam.estimatedUsd = roundUsd(fam.estimatedUsd);
  }
}

function formatHourBinLabel(tsMs) {
  const d = new Date(tsMs);
  return `${String(d.getHours()).padStart(2, "0")}:00`;
}

function formatDayBinLabel(tsMs) {
  const d = new Date(tsMs);
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Aggregate local 5-hour and 7-day rolling token consumption and rate-limit signals across
 * sanctioned Antigravity brain transcript directories.
 */
export function collectLocalRollingUsage({
  roots = null,
  extraRoots = [],
  includeDefaultRoots = true,
  nowMs = Date.now(),
  cache = null,
  maxFiles = DEFAULT_LOCAL_USAGE_MAX_FILES,
  maxFileBytes = DEFAULT_LOCAL_USAGE_MAX_FILE_BYTES
} = {}) {
  const rawRoots = Array.isArray(roots)
    ? roots
    : includeDefaultRoots
      ? getAntigravityBrainRoots(extraRoots)
      : Array.isArray(extraRoots)
        ? extraRoots
        : [];

  const cutoff7d = nowMs - WINDOW_7D_MS;
  const cutoff5h = nowMs - WINDOW_5H_MS;
  const futureSlackMs = nowMs + 60_000;

  const candidateFiles = [];
  const seenConvs = new Set();
  const seenRoots = new Set();

  for (const r of rawRoots) {
    if (typeof r !== "string" || !r.trim() || r.includes("\0") || isUncPath(r) || !path.isAbsolute(r)) continue;
    let rootReal;
    try {
      rootReal = fs.realpathSync(path.resolve(r.trim()));
      if (isUncPath(rootReal)) continue;
    } catch {
      continue;
    }
    const rootKey = process.platform === "win32" ? rootReal.toLowerCase() : rootReal;
    if (seenRoots.has(rootKey)) continue;
    seenRoots.add(rootKey);

    let entries;
    try {
      entries = fs.readdirSync(rootReal, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const found = resolveSafePreferredTranscript(rootReal, entry.name);
      if (!found) continue;
      const convKey = process.platform === "win32" ? found.convReal.toLowerCase() : found.convReal;
      if (seenConvs.has(convKey)) continue;
      seenConvs.add(convKey);
      if (found.stat.mtimeMs < cutoff7d) continue;
      candidateFiles.push(found);
    }
  }

  candidateFiles.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  const boundedFiles = candidateFiles.slice(0, Math.max(1, maxFiles));

  const window5h = createEmptyWindowSummary(WINDOW_5H_MS);
  const window7d = createEmptyWindowSummary(WINDOW_7D_MS);

  const hourStepMs = 60 * 60 * 1000;
  const hourlyBuckets = Array.from({ length: 5 }, (_, idx) => {
    const startMs = cutoff5h + idx * hourStepMs;
    return {
      startMs,
      endMs: startMs + hourStepMs,
      label: formatHourBinLabel(startMs),
      totalTokens: 0,
      nonCachedTokens: 0,
      turns: 0
    };
  });

  const dayStepMs = 24 * 60 * 60 * 1000;
  const dailyBuckets = Array.from({ length: 7 }, (_, idx) => {
    const startMs = cutoff7d + idx * dayStepMs;
    return {
      startMs,
      endMs: startMs + dayStepMs,
      label: formatDayBinLabel(startMs),
      totalTokens: 0,
      nonCachedTokens: 0,
      turns: 0
    };
  });

  const activeCacheKeys = new Set();
  let cacheHits = 0;
  let parsedFiles = 0;

  for (const item of boundedFiles) {
    const cacheKey = process.platform === "win32" ? item.filePath.toLowerCase() : item.filePath;
    activeCacheKeys.add(cacheKey);

    let parsed = null;
    if (cache instanceof Map) {
      const cached = cache.get(cacheKey);
      if (cached && cached.mtimeMs === item.stat.mtimeMs && cached.size === item.stat.size) {
        parsed = cached;
        cacheHits += 1;
      }
    }

    if (!parsed) {
      try {
        const fresh = parseTranscriptUsageRecords(item.filePath, item.stat, maxFileBytes);
        parsed = { mtimeMs: item.stat.mtimeMs, size: item.stat.size, ...fresh };
        parsedFiles += 1;
        if (cache instanceof Map) {
          cache.set(cacheKey, parsed);
        }
      } catch {
        continue;
      }
    }

    let touched5h = false;
    let touched7d = false;

    for (const rec of parsed.records) {
      if (rec.tsMs > futureSlackMs || rec.tsMs < cutoff7d) continue;
      touched7d = true;
      addRecordToWindow(window7d, rec);

      const dayIdx = clamp(Math.floor((rec.tsMs - cutoff7d) / dayStepMs), 0, 6);
      dailyBuckets[dayIdx].totalTokens += rec.totalTokens;
      dailyBuckets[dayIdx].nonCachedTokens += rec.nonCachedTokens;
      dailyBuckets[dayIdx].turns += 1;

      if (rec.tsMs >= cutoff5h) {
        touched5h = true;
        addRecordToWindow(window5h, rec);
        const hourIdx = clamp(Math.floor((rec.tsMs - cutoff5h) / hourStepMs), 0, 4);
        hourlyBuckets[hourIdx].totalTokens += rec.totalTokens;
        hourlyBuckets[hourIdx].nonCachedTokens += rec.nonCachedTokens;
        hourlyBuckets[hourIdx].turns += 1;
      }
    }

    for (const rlTs of parsed.rateLimits) {
      if (rlTs > futureSlackMs || rlTs < cutoff7d) continue;
      window7d.rateLimitHits += 1;
      if (window7d.lastRateLimitAtMs === null || rlTs > window7d.lastRateLimitAtMs) {
        window7d.lastRateLimitAtMs = rlTs;
      }
      if (rlTs >= cutoff5h) {
        window5h.rateLimitHits += 1;
        if (window5h.lastRateLimitAtMs === null || rlTs > window5h.lastRateLimitAtMs) {
          window5h.lastRateLimitAtMs = rlTs;
        }
      }
    }

    if (touched5h) window5h.sessions += 1;
    if (touched7d) window7d.sessions += 1;
  }

  if (cache instanceof Map && cache.size > 300) {
    for (const key of cache.keys()) {
      if (!activeCacheKeys.has(key)) cache.delete(key);
    }
  }

  finalizeWindowUsd(window5h);
  finalizeWindowUsd(window7d);

  return {
    available: window7d.turns > 0 || window7d.rateLimitHits > 0,
    isLocalEstimate: true,
    computedAtMs: Math.round(nowMs),
    scannedSessions: boundedFiles.length,
    cacheHits,
    parsedFiles,
    window5h,
    window7d,
    hourlyBuckets,
    dailyBuckets,
    rateLimitHits5h: window5h.rateLimitHits,
    rateLimitHits7d: window7d.rateLimitHits,
    lastRateLimitAtMs: window7d.lastRateLimitAtMs
  };
}
