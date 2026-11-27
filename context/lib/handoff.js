/**
 * agy-dart Cache-Friendly Session Handoff Brief Generator
 * Clean-room zero-dependency ESM implementation inspired by
 * lennartschoch/opencode-cache-compact & the-cybersapien/claude-cache.
 *
 * Produces a strictly byte-bounded, UTF-8/CJK-safe Markdown handoff brief
 * capturing workspace git state, structured session checkpoint, recent FTS5
 * source handles, live KV-cache snapshot, and a post-compaction resume cue.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  extractStepText,
  findPreferredTranscriptForConversation,
  isSafeConversationId,
  isSubagentStep,
  readTranscriptHeadTailFixed,
  resolveConversationBrainDir,
  resolveConversationOwnedFile
} from "./cache-analyzer.js";
import { isSecretRedactionEnabled, redactSecrets } from "./security.js";
import { isHeadlessWorkerPrompt, isTtlKeepalivePrompt } from "./watchdog-lease.js";
import { isFailureAnchorLine } from "../../hooks/filter-rules.mjs";

const DEFAULT_MAX_BYTES = 5800;
const GIT_TIMEOUT_MS = 500;
const GIT_TOTAL_BUDGET_MS = 1200;
const MAX_DIFF_STAT_LINES = 16;
const MAX_DIFF_STAT_BYTES = 1200;
const MAX_UNTRACKED_ITEMS = 10;
const MAX_UNTRACKED_BYTES = 400;
const MAX_RECENT_COMMITS = 3;
const MAX_RECENT_COMMITS_BYTES = 320;
const MAX_INITIAL_USER_BYTES = 280;
const MAX_RECENT_USER_BYTES = 220;
const TASK_MD_MAX_READ_BYTES = 24 * 1024;
const MAX_TASK_ITEMS = 8;
const MAX_TASK_ITEM_BYTES = 140;
const MAX_FAILURE_EXCERPT_LINES = 5;
const MAX_FAILURE_EXCERPT_BYTES = 500;
const NEXT_STEP_LINE = "Call ctx_resume({}) after /compact or paste this brief into a fresh session.";

const RESERVED_CONVERSATION_IDS = new Set([
  "",
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
const SUBAGENT_MSG_WRAPPER_RE =
  /\[Message\]\s+timestamp=\S+\s+sender=[0-9a-f-]{8,}|<original_task>|<subagent_reminder>|\brunning as a subagent,\s*invoked by a caller agent\b/i;
const CONTROL_COMMAND_RE =
  /^\/(?:compact|clear|reset|help|status|model|exit|quit|new|undo|redo|branch|effort|resume|stop|cancel|continue|keepalive|grill-me|plan|goal|boost|run-workflow|swarm|browser|generative_ui)(?:\s|$)/i;
const BARE_SLASH_CMD_RE = /^\/[a-z][a-z0-9_-]*$/i;
const BRAIN_ARTIFACT_NAMES = Object.freeze(["task.md", "implementation_plan.md", "walkthrough.md"]);

/** Strictly truncate a string to <= maxBytes UTF-8 bytes without splitting multi-byte chars or surrogate pairs */
export function truncateUtf8Safe(text, maxBytes) {
  if (!text) return "";
  const limit = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : 0;
  if (limit === 0) return "";
  const str = String(text);
  const buf = Buffer.from(str, "utf8");
  if (buf.length <= limit) return str;
  let cut = limit;
  // Back up if landing in the middle of a multi-byte UTF-8 sequence (continuation bytes: 10xxxxxx)
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) {
    cut -= 1;
  }
  // Verify the final UTF-8 code point ending at `cut` is complete by inspecting its lead byte length
  // (avoids stripping legitimate user-typed U+FFFD characters encoded as EF BF BD)
  if (cut > 0) {
    let lastLead = cut - 1;
    while (lastLead > 0 && (buf[lastLead] & 0xc0) === 0x80) {
      lastLead -= 1;
    }
    const lead = buf[lastLead];
    let expectedLen = 1;
    if ((lead & 0xe0) === 0xc0) expectedLen = 2;
    else if ((lead & 0xf0) === 0xe0) expectedLen = 3;
    else if ((lead & 0xf8) === 0xf0) expectedLen = 4;
    if (cut - lastLead < expectedLen) {
      cut = lastLead;
    }
  }
  let out = buf.subarray(0, cut).toString("utf8");
  if (out.length > 0) {
    const lastCode = out.charCodeAt(out.length - 1);
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
      out = out.slice(0, -1);
    }
  }
  return out;
}

function formatBytesCompact(bytes) {
  const b = Number(bytes || 0);
  if (!Number.isFinite(b) || b <= 0) return "0 B";
  if (b < 1024) return `${Math.round(b)} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
}

function formatTokensK(tokens) {
  const n = Number(tokens || 0);
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  return `${Math.round(n / 1000)}k`;
}

function toFiniteNumber(val) {
  if (val === null || val === undefined || typeof val === "boolean") return null;
  if (typeof val === "string" && val.trim() === "") return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

function isUncPath(p) {
  if (!p || typeof p !== "string") return false;
  return /^[\\/]{2}/.test(p.trim());
}

function formatUsdCompact(val) {
  const n = toFiniteNumber(val);
  if (n === null) return null;
  if (n === 0) return "$0.00";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs < 0.01) return `${sign}$${abs.toFixed(4)}`;
  return `${sign}$${abs.toFixed(2)}`;
}

function formatDurationCompact(sec) {
  const s = Math.max(0, Math.round(Number(sec || 0)));
  if (s < 60) return `${s}s`;
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r > 0 ? `${m}m ${r}s` : `${m}m`;
}

function sanitizeInline(val, maxBytes = 240) {
  if (val === null || val === undefined) return "";
  const flat = String(val).replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return Buffer.byteLength(flat, "utf8") > maxBytes ? `${truncateUtf8Safe(flat, Math.max(8, maxBytes - 3))}...` : flat;
}

function flattenPreRedacted(val, maxBytes = 240) {
  if (val === null || val === undefined) return "";
  let s = String(val);
  if (typeof s.toWellFormed === "function") {
    s = s.toWellFormed();
  }
  const flat = s
    .replace(/[\r\n\t\x00-\x1f\x7f-\x9f]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!flat) return "";
  if (Buffer.byteLength(flat, "utf8") <= maxBytes) return flat;
  const suffix = maxBytes >= 16 ? "..." : "";
  const bodyCap = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  return `${truncateUtf8Safe(flat, bodyCap)}${suffix}`;
}

function redactAndFlatten(val, maxBytes = 240) {
  if (val === null || val === undefined) return "";
  const redacted = redactSecrets(String(val)).text;
  return flattenPreRedacted(redacted, maxBytes);
}

function wrapInlineCode(text) {
  const s = String(text ?? "");
  const runs = s.match(/`+/g) || [];
  const maxRun = runs.reduce((m, r) => Math.max(m, r.length), 0);
  const delim = "`".repeat(maxRun + 1);
  const needsPad = s.startsWith("`") || s.endsWith("`") || (s.startsWith(" ") && s.endsWith(" ") && s.trim().length > 0);
  return needsPad ? `${delim} ${s} ${delim}` : `${delim}${s}${delim}`;
}

/**
 * Wrap multiline content in a dynamically sized backtick fence that cannot be broken by
 * any backtick sequence occurring inside the content.
 */
export function wrapSafeFence(content, lang = "text") {
  const normalized = String(content ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const runs = normalized.match(/`+/g) || [];
  const maxRun = runs.reduce((m, r) => Math.max(m, r.length), 0);
  const fence = "`".repeat(Math.max(3, maxRun + 1));
  return `${fence}${lang}\n${normalized}\n${fence}`;
}

function detectOpenFence(markdown) {
  if (!markdown || typeof markdown !== "string") return null;
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let open = null;
  for (const rawLine of lines) {
    // Strip optional blockquote prefixes and up to 3 leading spaces
    const stripped = rawLine.replace(/^(?:\s{0,3}>\s?)*\s{0,3}/, "");
    if (!open) {
      const m = stripped.match(/^(`{3,}|~{3,})(.*)$/);
      if (m) {
        const ch = m[1][0];
        const len = m[1].length;
        const info = m[2] || "";
        // In CommonMark, backtick fence info strings cannot contain backticks
        if (ch === "`" && info.includes("`")) continue;
        open = { char: ch, len };
      }
    } else {
      const closeRe = open.char === "`" ? new RegExp(`^\`{${open.len},}\\s*$`) : new RegExp(`^~{${open.len},}\\s*$`);
      if (closeRe.test(stripped)) {
        open = null;
      }
    }
  }
  return open;
}

/** Returns true if Markdown contains an unclosed backtick or tilde fenced code block. */
export function hasUnclosedFence(markdown) {
  return detectOpenFence(markdown) !== null;
}

function ensureClosedFencesWithinBudget(markdown, budget) {
  let out = markdown;
  if (Buffer.byteLength(out, "utf8") > budget) {
    out = truncateUtf8Safe(out, budget);
  }
  for (let pass = 0; pass < 6; pass += 1) {
    const open = detectOpenFence(out);
    if (!open) return out;
    const closeFence = `\n${open.char.repeat(open.len)}`;
    const closeBytes = Buffer.byteLength(closeFence, "utf8");
    if (budget <= closeBytes) {
      const lines = out.split("\n");
      while (lines.length > 0 && detectOpenFence(lines.join("\n")) !== null) {
        lines.pop();
      }
      return truncateUtf8Safe(lines.join("\n"), budget);
    }
    if (Buffer.byteLength(out, "utf8") + closeBytes <= budget) {
      return `${out}${closeFence}`;
    }
    const nextTrimmed = truncateUtf8Safe(out, budget - closeBytes);
    const nextOpen = detectOpenFence(nextTrimmed);
    if (!nextOpen) return nextTrimmed;
    const nextClose = `\n${nextOpen.char.repeat(nextOpen.len)}`;
    const nextCloseBytes = Buffer.byteLength(nextClose, "utf8");
    if (Buffer.byteLength(nextTrimmed, "utf8") + nextCloseBytes <= budget) {
      return `${nextTrimmed}${nextClose}`;
    }
    if (nextTrimmed === out) break;
    out = nextTrimmed;
  }
  // Fallback: drop trailing lines until no fence remains open
  const lines = out.split("\n");
  while (lines.length > 0 && detectOpenFence(lines.join("\n")) !== null) {
    lines.pop();
  }
  return truncateUtf8Safe(lines.join("\n"), budget);
}

function isReservedOrAggregateId(id) {
  if (typeof id !== "string") return true;
  return RESERVED_CONVERSATION_IDS.has(id.trim().toLowerCase());
}

function isConfirmedSpecificId(id) {
  if (typeof id !== "string") return false;
  const trimmed = id.trim();
  return Boolean(trimmed && !isReservedOrAggregateId(trimmed) && isSafeConversationId(trimmed));
}

function isExistingDirectory(dirPath) {
  if (!dirPath || typeof dirPath !== "string") return false;
  const trimmed = dirPath.trim();
  if (!trimmed || trimmed.includes("\0") || isUncPath(trimmed)) return false;
  const resolved = path.resolve(trimmed);
  if (isUncPath(resolved)) return false;
  try {
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return false;
    const real = fs.realpathSync(resolved);
    if (isUncPath(real)) return false;
    return true;
  } catch {
    return false;
  }
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
  const resolved = path.resolve(dirPath);
  const root = path.parse(resolved).root;
  if (root) {
    const isFsRoot = process.platform === "win32"
      ? resolved.toLowerCase() === root.toLowerCase()
      : resolved === root;
    if (isFsRoot) return true;
  }
  let realResolved = resolved;
  try {
    realResolved = resolveCanonicalPath(resolved);
    const realRoot = path.parse(realResolved).root;
    if (realRoot) {
      const isRealFsRoot = process.platform === "win32"
        ? realResolved.toLowerCase() === realRoot.toLowerCase()
        : realResolved === realRoot;
      if (isRealFsRoot) return true;
    }
  } catch {}
  const home = path.resolve(os.homedir());
  let realHome = home;
  try {
    realHome = resolveCanonicalPath(home);
  } catch {}
  const inside = (cand, anc) => {
    const nc = process.platform === "win32" ? cand.toLowerCase() : cand;
    const na = process.platform === "win32" ? anc.toLowerCase() : anc;
    const rel = path.relative(na, nc);
    return (
      rel === "" ||
      (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !rel.startsWith("../") && !path.isAbsolute(rel))
    );
  };
  return (
    inside(home, resolved) ||
    inside(realHome, resolved) ||
    inside(home, realResolved) ||
    inside(realHome, realResolved)
  );
}

export function isSafeWorkspaceDir(dirPath) {
  if (!dirPath || typeof dirPath !== "string") return false;
  const trimmed = dirPath.trim();
  if (!trimmed || trimmed.includes("\0") || isUncPath(trimmed) || !path.isAbsolute(trimmed)) {
    return false;
  }
  if (!isExistingDirectory(trimmed)) return false;
  const resolved = path.resolve(trimmed);
  return !isUnsafeBroadRoot(resolved);
}

const SAFE_GIT_BASE_ARGS = Object.freeze([
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

function createGitDeadline(totalMs = GIT_TOTAL_BUDGET_MS, monoNsFn = process.hrtime.bigint) {
  const budgetMs = Number.isFinite(Number(totalMs)) && Number(totalMs) >= 0 ? Math.floor(Number(totalMs)) : GIT_TOTAL_BUDGET_MS;
  const startNs = monoNsFn();
  const deadlineNs = startNs + BigInt(budgetMs) * 1_000_000n;
  return {
    budgetMs,
    remainingMs() {
      const diffNs = deadlineNs - monoNsFn();
      if (diffNs <= 0n) return 0;
      return Math.floor(Number(diffNs) / 1_000_000);
    },
    isExpired() {
      return monoNsFn() > deadlineNs;
    },
    elapsedMs() {
      const diffNs = monoNsFn() - startNs;
      return diffNs > 0n ? Math.floor(Number(diffNs) / 1_000_000) : 0;
    }
  };
}

const GIT_LOCALE_ENV_KEYS = new Set(["LC_ALL", "LANG", "LANGUAGE", "LC_MESSAGES"]);
const GIT_REPO_OVERRIDE_ENV_KEYS = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_SUPER_PREFIX",
  "GIT_PREFIX",
  "GIT_NAMESPACE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_QUARANTINE_PATH",
  "GIT_SHALLOW_FILE",
  "GIT_GRAFT_FILE",
  "GIT_REPLACE_REF_BASE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_EXTERNAL_DIFF",
  "GIT_LITERAL_PATHSPECS",
  "GIT_GLOB_PATHSPECS",
  "GIT_NOGLOB_PATHSPECS",
  "GIT_ICASE_PATHSPECS"
]);
const GIT_CONFIG_INDEXED_ENV_RE = /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/;

export function buildGitReadOnlyEnv(baseEnv = process.env) {
  const env = {};
  for (const [key, val] of Object.entries(baseEnv || {})) {
    if (val === undefined) continue;
    const upper = key.toUpperCase();
    if (
      GIT_LOCALE_ENV_KEYS.has(upper) ||
      GIT_REPO_OVERRIDE_ENV_KEYS.has(upper) ||
      GIT_CONFIG_INDEXED_ENV_RE.test(upper)
    ) {
      continue;
    }
    env[key] = val;
  }
  env.LC_ALL = "C";
  env.LANG = "C";
  env.LANGUAGE = "C";
  return Object.freeze(env);
}

function runGitReadOnly(args, workDir, { deadline = null, gitExecFn = null } = {}) {
  let timeoutMs = GIT_TIMEOUT_MS;
  if (deadline) {
    const rem = deadline.remainingMs();
    if (rem <= 0) {
      return { ok: false, timedOut: true, stdout: "", stderr: "git budget exhausted" };
    }
    timeoutMs = Math.min(GIT_TIMEOUT_MS, rem);
  }
  try {
    const fullArgs = [...SAFE_GIT_BASE_ARGS, ...args];
    const res =
      typeof gitExecFn === "function"
        ? gitExecFn(fullArgs, { cwd: workDir, timeout: timeoutMs })
        : spawnSync("git", fullArgs, {
            cwd: workDir,
            encoding: "utf8",
            timeout: timeoutMs,
            windowsHide: true,
            maxBuffer: 1024 * 1024,
            env: buildGitReadOnlyEnv(process.env)
          });
    const expired = Boolean(deadline && deadline.isExpired());
    const timedOut = Boolean(
      res?.timedOut ||
        res?.error?.code === "ETIMEDOUT" ||
        res?.signal === "SIGTERM" ||
        res?.signal === "SIGKILL" ||
        expired
    );
    if (timedOut) {
      return {
        ok: false,
        timedOut: true,
        stdout: "",
        stderr: String(res?.stderr || res?.error?.message || (expired ? "git budget exhausted" : ""))
      };
    }
    if (!res || res.error || res.status !== 0) {
      return {
        ok: false,
        timedOut: false,
        stdout: "",
        stderr: String(res?.stderr || res?.error?.message || "")
      };
    }
    return { ok: true, timedOut: false, stdout: String(res.stdout || ""), stderr: String(res.stderr || "") };
  } catch {
    return { ok: false, timedOut: Boolean(deadline && deadline.isExpired()), stdout: "", stderr: "" };
  }
}

function boundDiffStat(rawStat) {
  if (!rawStat || typeof rawStat !== "string") return "";
  const lines = rawStat
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) return "";

  let selected = lines;
  if (lines.length > MAX_DIFF_STAT_LINES) {
    const summaryLine = lines[lines.length - 1];
    const headCount = MAX_DIFF_STAT_LINES - 2;
    const omitted = lines.length - 1 - headCount;
    selected = [...lines.slice(0, headCount), `... (+${omitted} more file(s))`, summaryLine];
  }

  const joined = selected.join("\n");
  if (Buffer.byteLength(joined, "utf8") <= MAX_DIFF_STAT_BYTES) return joined;
  return `${truncateUtf8Safe(joined, MAX_DIFF_STAT_BYTES - 16)}\n... [truncated]`;
}

const VALID_PORCELAIN_STATUS_CODES = new Set([" ", "M", "T", "A", "D", "R", "C", "U", "?", "!"]);
const VISIBLE_PATH_CHAR_RE = /[^\s\x00-\x1f\x7f-\x9f]/;

function defaultFormatUntrackedPath(entryPath) {
  return redactAndFlatten(entryPath.replace(/\\/g, "/"), 160);
}

export function parseStatusPorcelainBZ(stdout, { formatUntrackedPath } = {}) {
  const result = {
    hasBranchHeader: false,
    isComplete: false,
    branch: "",
    isUnborn: false,
    isDetached: false,
    hasTrackedChanges: false,
    hasStagedChanges: false,
    dirtyEntryCount: 0,
    untracked: [],
    untrackedTotalCount: 0
  };
  if (!stdout || typeof stdout !== "string") return result;

  const formatPath =
    typeof formatUntrackedPath === "function" ? formatUntrackedPath : defaultFormatUntrackedPath;
  const endsWithNul = stdout.endsWith("\0");
  const tokens = stdout.split("\0");
  const tokenCount = endsWithNul ? tokens.length - 1 : tokens.length;
  const items = [];
  let usedBytes = 0;
  let itemsBudgetFull = false;
  let untrackedTotalCount = 0;
  let hasMalformedRecord = false;
  for (let i = 0; i < tokenCount; i++) {
    const tok = tokens[i];
    if (!tok) {
      hasMalformedRecord = true;
      continue;
    }
    if (i === 0 && tok.startsWith("## ")) {
      result.hasBranchHeader = true;
      const header = tok.slice(3).trim();
      if (/^HEAD\s+\(no branch\)$/i.test(header)) {
        result.isDetached = true;
      } else {
        const unbornMatch = header.match(/^(?:No commits yet on|Initial commit on)\s+(\S+)$/i);
        if (unbornMatch) {
          result.isUnborn = true;
          result.branch = unbornMatch[1];
        } else {
          const beforeRemote = header.split("...")[0].trim();
          result.branch = beforeRemote.split(/\s+/)[0] || "";
        }
      }
      continue;
    }
    if (tok.length < 4) {
      hasMalformedRecord = true;
      continue;
    }
    const x = tok[0];
    const y = tok[1];
    const sep = tok[2];
    const invalidSpecialPair =
      ((x === "?" || y === "?") && !(x === "?" && y === "?")) ||
      ((x === "!" || y === "!") && !(x === "!" && y === "!"));
    if (
      sep !== " " ||
      !VALID_PORCELAIN_STATUS_CODES.has(x) ||
      !VALID_PORCELAIN_STATUS_CODES.has(y) ||
      (x === " " && y === " ") ||
      invalidSpecialPair
    ) {
      hasMalformedRecord = true;
      continue;
    }
    const entryPath = tok.slice(3);
    if (x === "?" && y === "?") {
      result.dirtyEntryCount += 1;
      if (!VISIBLE_PATH_CHAR_RE.test(entryPath)) {
        continue;
      }
      if (!itemsBudgetFull && items.length < MAX_UNTRACKED_ITEMS) {
        const cleaned = formatPath(entryPath);
        if (cleaned) {
          untrackedTotalCount += 1;
          const itemBytes = Buffer.byteLength(cleaned, "utf8") + (items.length > 0 ? 2 : 0);
          if (usedBytes + itemBytes > MAX_UNTRACKED_BYTES) {
            if (items.length === 0) {
              items.push(truncateUtf8Safe(cleaned, MAX_UNTRACKED_BYTES));
            }
            itemsBudgetFull = true;
          } else {
            items.push(cleaned);
            usedBytes += itemBytes;
            if (items.length >= MAX_UNTRACKED_ITEMS) {
              itemsBudgetFull = true;
            }
          }
        }
      } else {
        untrackedTotalCount += 1;
      }
      continue;
    }
    if (x === "!" && y === "!") continue;
    // Tracked entry: staged+unstaged on same path (e.g. MM) is one record; rename/copy consumes second NUL path
    result.dirtyEntryCount += 1;
    result.hasTrackedChanges = true;
    if (x !== " ") result.hasStagedChanges = true;
    // Porcelain v1 -z emits a second NUL-terminated source path for renames/copies
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      if (i + 1 >= tokens.length - (endsWithNul ? 1 : 0) || !tokens[i + 1]) {
        hasMalformedRecord = true;
      } else {
        i += 1;
      }
    }
  }

  result.isComplete = Boolean(result.hasBranchHeader && endsWithNul && !hasMalformedRecord);
  result.untracked = items;
  result.untrackedTotalCount = untrackedTotalCount;
  return result;
}

const FULL_GIT_OID_RE = /^[0-9a-f]{40,64}$/i;

function parseRecentCommitsWithHead(stdout) {
  if (!stdout || typeof stdout !== "string") return { headOid: "", recentCommits: [] };
  const redacted = redactSecrets(stdout).text;
  const rawLines = redacted
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  let headOid = "";
  const formattedLines = [];
  for (const rawLine of rawLines) {
    if (formattedLines.length >= MAX_RECENT_COMMITS) break;
    const tabIdx = rawLine.indexOf("\t");
    if (tabIdx > 0) {
      const candOid = rawLine.slice(0, tabIdx).trim();
      const subject = rawLine.slice(tabIdx + 1);
      if (FULL_GIT_OID_RE.test(candOid)) {
        const lowerOid = candOid.toLowerCase();
        if (!headOid) headOid = lowerOid;
        const display = flattenPreRedacted(`${lowerOid.slice(0, 7)} ${subject}`, 140);
        if (display) formattedLines.push(display);
        continue;
      }
    }
    const fallback = flattenPreRedacted(rawLine, 140);
    if (fallback) formattedLines.push(fallback);
  }
  const out = [];
  let usedBytes = 0;
  for (const line of formattedLines) {
    const sepBytes = out.length > 0 ? 1 : 0;
    const rem = MAX_RECENT_COMMITS_BYTES - usedBytes - sepBytes;
    if (rem <= 0) break;
    if (Buffer.byteLength(line, "utf8") <= rem) {
      out.push(line);
      usedBytes += sepBytes + Buffer.byteLength(line, "utf8");
    } else if (rem >= 20) {
      const cut = `${truncateUtf8Safe(line, rem - 3)}...`;
      out.push(cut);
      usedBytes += sepBytes + Buffer.byteLength(cut, "utf8");
      break;
    } else {
      break;
    }
  }
  return { headOid, recentCommits: out };
}

function inspectGitWorkspace(
  cwd,
  { includeExtended = false, gitBudgetMs = GIT_TOTAL_BUDGET_MS, gitExecFn = null, monoNsFn = process.hrtime.bigint } = {}
) {
  const empty = {
    validDir: false,
    isGit: false,
    branch: "",
    headOid: "",
    headState: "unknown",
    dirtyEntryCount: null,
    diffStat: "",
    untracked: [],
    untrackedTotalCount: 0,
    recentCommits: [],
    timedOut: false
  };
  if (!isExistingDirectory(cwd)) {
    return empty;
  }
  const resolved = path.resolve(cwd.trim());
  const deadline = createGitDeadline(gitBudgetMs, monoNsFn);
  const runOpts = { deadline, gitExecFn };

  let isGit = false;
  let branch = "";
  let headOid = "";
  let headState = "unknown";
  let dirtyEntryCount = null;
  let timedOut = false;
  let untracked = [];
  let untrackedTotalCount = 0;
  let recentCommits = [];
  let statusUsedForHeader = false;
  let statusHasTrackedChanges = true;
  let statusHasStagedChanges = true;
  let statusIsUnborn = false;
  let statusIsDetached = false;

  if (includeExtended) {
    // Fast path for `agent` mode: single `status --porcelain=v1 -b -z --untracked-files=normal`
    // obtains branch, unborn/detached state, dirty entry count, and untracked files in one spawn
    // (saving 1-3 git spawns on Windows).
    const statusRes = runGitReadOnly(
      ["-c", "core.quotepath=false", "status", "--porcelain=v1", "-b", "-z", "--untracked-files=normal"],
      resolved,
      runOpts
    );
    if (statusRes.timedOut) timedOut = true;
    if (statusRes.ok) {
      const parsed = parseStatusPorcelainBZ(statusRes.stdout);
      untracked = parsed.untracked;
      untrackedTotalCount = parsed.untrackedTotalCount;
      if (parsed.isComplete && !statusRes.timedOut) {
        dirtyEntryCount = parsed.dirtyEntryCount;
      }
      if (parsed.hasBranchHeader) {
        isGit = true;
        statusUsedForHeader = true;
        statusHasTrackedChanges = parsed.isComplete ? parsed.hasTrackedChanges : true;
        statusHasStagedChanges = parsed.isComplete ? parsed.hasStagedChanges : true;
        statusIsUnborn = parsed.isUnborn;
        statusIsDetached = parsed.isDetached;
        if (parsed.isUnborn) {
          headState = "unborn";
          branch = parsed.branch || "HEAD";
        } else if (parsed.isDetached) {
          // Defer short-OID branch formatting until `git log` returns the full HEAD OID (avoids an extra spawn)
          branch = "HEAD";
        } else {
          branch = parsed.branch || "HEAD";
        }
      }
    } else if (!timedOut && /not a git repository/i.test(statusRes.stderr)) {
      return { ...empty, validDir: true, isGit: false, timedOut: false };
    }
  }

  if (!statusUsedForHeader && !timedOut) {
    const sym = runGitReadOnly(["symbolic-ref", "--short", "HEAD"], resolved, runOpts);
    if (sym.timedOut) timedOut = true;
    if (sym.ok && sym.stdout.trim()) {
      isGit = true;
      branch = sym.stdout.trim();
    } else if (!timedOut && !/not a git repository/i.test(sym.stderr)) {
      const rev = runGitReadOnly(["rev-parse", "--short", "HEAD"], resolved, runOpts);
      if (rev.timedOut) timedOut = true;
      if (rev.ok && rev.stdout.trim()) {
        isGit = true;
        branch = `detached@${rev.stdout.trim()}`;
      } else if (!timedOut) {
        const inside = runGitReadOnly(["rev-parse", "--is-inside-work-tree"], resolved, runOpts);
        if (inside.timedOut) timedOut = true;
        if (inside.ok && inside.stdout.trim() === "true") {
          isGit = true;
          branch = "HEAD";
        }
      }
    }
  }

  if (!isGit) {
    return { ...empty, validDir: true, isGit: false, timedOut };
  }

  // Prefer diff against HEAD (captures both staged & unstaged working-tree edits); fall back cleanly for unborn repos
  const diffBaseFlags = ["-c", "core.quotepath=false", "diff", "--no-ext-diff", "--no-textconv", "--stat", "--stat-width=80"];
  let diffRes = { ok: false, stdout: "", timedOut: false };
  if (!timedOut) {
    if (statusUsedForHeader && statusIsUnborn) {
      if (statusHasStagedChanges) {
        diffRes = runGitReadOnly([...diffBaseFlags, "--cached"], resolved, runOpts);
        if (diffRes.timedOut) timedOut = true;
      }
    } else if (!statusUsedForHeader || statusHasTrackedChanges) {
      diffRes = runGitReadOnly([...diffBaseFlags, "HEAD"], resolved, runOpts);
      if (diffRes.timedOut) timedOut = true;
      if (!diffRes.ok && !timedOut) {
        diffRes = runGitReadOnly([...diffBaseFlags, "--cached"], resolved, runOpts);
        if (diffRes.timedOut) timedOut = true;
        if ((!diffRes.ok || !diffRes.stdout.trim()) && !timedOut) {
          diffRes = runGitReadOnly(diffBaseFlags, resolved, runOpts);
          if (diffRes.timedOut) timedOut = true;
        }
      }
    }
  }

  if (includeExtended && !timedOut && !statusIsUnborn) {
    const logRes = runGitReadOnly(
      ["log", "-n", String(MAX_RECENT_COMMITS), "--format=%H%x09%s", "--no-decorate"],
      resolved,
      runOpts
    );
    if (logRes.timedOut) timedOut = true;
    if (logRes.ok && logRes.stdout) {
      const parsedLog = parseRecentCommitsWithHead(logRes.stdout);
      recentCommits = parsedLog.recentCommits;
      if (parsedLog.headOid) {
        headOid = parsedLog.headOid;
        headState = "commit";
      }
    }
  }

  if (statusIsDetached) {
    if (headOid) {
      branch = `detached@${headOid.slice(0, 7)}`;
    } else if (!timedOut) {
      const rev = runGitReadOnly(["rev-parse", "--short", "HEAD"], resolved, runOpts);
      if (rev.timedOut) timedOut = true;
      if (rev.ok && rev.stdout.trim()) {
        branch = `detached@${rev.stdout.trim()}`;
      }
    }
  }

  return {
    validDir: true,
    isGit: true,
    branch,
    headOid,
    headState,
    dirtyEntryCount,
    diffStat: diffRes.ok ? boundDiffStat(redactSecrets(diffRes.stdout).text) : "",
    untracked,
    untrackedTotalCount,
    recentCommits,
    timedOut
  };
}

/**
 * Infer a valid existing workspace directory from SQLite checkpoints, indexed sources, or recent events.
 * Strictly fail-open: returns "" if no existing directory can be inferred.
 */
export function inferWorkspaceFromStore(store, sessionId = "default", sinceTs = null) {
  if (!store) return "";
  try {
    if (typeof store.open === "function") store.open();
    if (!store.db) return "";
    const sid = sessionId || "default";
    const isAll = sid === "all" || sid === "lifetime";
    const sinceNum = sid === "app" ? toFiniteNumber(sinceTs) : null;
    const isApp = sinceNum !== null;
    const sinceIso = isApp ? new Date(sinceNum).toISOString() : null;

    const queries = [
      () =>
        isAll
          ? store.db
              .prepare("SELECT worktree FROM session_checkpoints WHERE worktree != '' ORDER BY updated_ts DESC LIMIT 3")
              .all()
          : isApp
            ? store.db
                .prepare("SELECT worktree FROM session_checkpoints WHERE worktree != '' AND updated_ts >= ? ORDER BY updated_ts DESC LIMIT 3")
                .all(sinceNum)
            : store.db
                .prepare("SELECT worktree FROM session_checkpoints WHERE session_id = ? AND worktree != '' LIMIT 1")
                .all(sid),
      () =>
        isAll
          ? store.db
              .prepare("SELECT worktree FROM sources WHERE worktree != '' ORDER BY created_ts DESC LIMIT 3")
              .all()
          : isApp
            ? store.db
                .prepare("SELECT worktree FROM sources WHERE worktree != '' AND (created_ts >= ? OR created_at >= ?) ORDER BY created_ts DESC LIMIT 3")
                .all(sinceNum, sinceIso)
            : store.db
                .prepare("SELECT worktree FROM sources WHERE session_id = ? AND worktree != '' ORDER BY created_ts DESC LIMIT 3")
                .all(sid),
      () =>
        isAll
          ? store.db
              .prepare("SELECT worktree FROM events WHERE worktree != '' ORDER BY seq DESC LIMIT 3")
              .all()
          : isApp
            ? store.db
                .prepare("SELECT worktree FROM events WHERE worktree != '' AND created_at >= ? ORDER BY seq DESC LIMIT 3")
                .all(sinceIso)
            : store.db
                .prepare("SELECT worktree FROM events WHERE session_id = ? AND worktree != '' ORDER BY seq DESC LIMIT 3")
                .all(sid)
    ];

    for (const run of queries) {
      try {
        const rows = run();
        for (const row of rows || []) {
          if (row?.worktree && isExistingDirectory(row.worktree)) {
            const resolved = path.resolve(row.worktree);
            if (!isUnsafeBroadRoot(resolved)) {
              return resolved;
            }
          }
        }
      } catch {
        // Ignore missing table/column on partial or mock stores
      }
    }
  } catch {
    // Fail-open
  }
  return "";
}

function formatStructuredVerificationSummary(rec) {
  if (!rec || typeof rec !== "object") return "";
  const exitNum = toFiniteNumber(rec.exitCode);
  if (rec.ok) {
    return exitNum !== null ? `passed (exit ${exitNum})` : "passed";
  }
  return exitNum !== null ? `failed (exit ${exitNum})` : "failed";
}

function formatVerificationLine(label, rec, { allowRawSummary = true } = {}) {
  if (!rec || typeof rec !== "object") return "";
  const status = rec.ok ? "PASS" : "FAIL";
  const exitNum = toFiniteNumber(rec.exitCode);
  const exitPart = exitNum !== null ? ` (exit ${exitNum})` : "";
  const cmdPart = rec.command ? ` \`${sanitizeInline(rec.command, 120)}\`` : "";
  const rawSummary = allowRawSummary ? rec.summary : formatStructuredVerificationSummary(rec);
  const summaryPart = rawSummary ? ` — ${sanitizeInline(rawSummary, 180)}` : "";
  const srcPart = rec.sourceId ? ` [sourceId: \`${sanitizeInline(rec.sourceId, 64)}\`]` : "";
  return `- **${label}**: ${status}${exitPart}${cmdPart}${summaryPart}${srcPart}`;
}

function hasCacheSnapshot(cacheDiag) {
  if (!cacheDiag || typeof cacheDiag !== "object") return false;
  if (cacheDiag.transcriptFound === false) return false;
  return Boolean(
    cacheDiag.turnsWithUsage > 0 ||
      cacheDiag.currentContextTokens > 0 ||
      cacheDiag.currentModel ||
      (cacheDiag.compactAdvice && cacheDiag.compactAdvice !== "none") ||
      (cacheDiag.cacheTemperature && cacheDiag.cacheTemperature !== "cold") ||
      Number(cacheDiag.weightedHitRate || 0) > 0 ||
      Number(cacheDiag.estimatedSavedUsd || 0) !== 0
  );
}

function parseIsoTimeMs(val) {
  if (!val || typeof val !== "string") return null;
  const ms = Date.parse(val);
  return Number.isFinite(ms) ? ms : null;
}

function extractValidUserMessage(step, windowTag, orderIdx) {
  if (!step || typeof step !== "object") return null;
  const rawType = typeof step.type === "string" ? step.type.trim().toUpperCase() : "";
  if (
    rawType === "PLANNER_RESPONSE" ||
    rawType === "SYSTEM_MESSAGE" ||
    rawType === "TOOL_RESULT" ||
    rawType === "TOOL_CALL" ||
    rawType === "ERROR_MESSAGE" ||
    rawType.startsWith("SUBAGENT")
  ) {
    return null;
  }
  if (rawType && rawType !== "USER_INPUT" && rawType !== "USER" && rawType !== "USER_MESSAGE") {
    return null;
  }
  if (!rawType) {
    const role = typeof step.role === "string" ? step.role.trim().toLowerCase() : "";
    if (role !== "user") return null;
  }
  if (isSubagentStep(step)) return null;

  const rawText =
    extractStepText(step.user_input) ||
    extractStepText(step.userInput) ||
    extractStepText(step.content) ||
    extractStepText(step.text);
  if (!rawText || !rawText.trim()) return null;
  if (
    isHeadlessWorkerPrompt(rawText) ||
    isTtlKeepalivePrompt(rawText) ||
    SUBAGENT_MSG_WRAPPER_RE.test(rawText)
  ) {
    return null;
  }

  // Strip Antigravity system-message preamble & <SYSTEM_MESSAGE> blocks BEFORE checking for <USER_REQUEST>
  // so hook/wakeup notices never leak partial preamble text ("The following is a") or internal tags as user intent.
  const withoutSystem = rawText
    .replace(/The following is a <SYSTEM_MESSAGE> not actually sent by the user\.[^\n]*/gi, " ")
    .replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/gi, " ");
  let unwrapped = withoutSystem;
  const reqMatches = [...withoutSystem.matchAll(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/gi)];
  if (reqMatches.length > 0) {
    unwrapped = reqMatches
      .map((m) => (m[1] || "").trim())
      .filter(Boolean)
      .join("\n");
  }
  const trimmed = unwrapped.trim();
  if (!trimmed) return null;
  if (
    isHeadlessWorkerPrompt(trimmed) ||
    isTtlKeepalivePrompt(trimmed) ||
    SUBAGENT_MSG_WRAPPER_RE.test(trimmed)
  ) {
    return null;
  }
  if (!trimmed.includes("\n") && (CONTROL_COMMAND_RE.test(trimmed) || BARE_SLASH_CMD_RE.test(trimmed))) {
    return null;
  }

  const redactedFull = redactSecrets(trimmed).text;
  const normKey = redactedFull.replace(/\s+/g, " ").trim();
  if (!normKey) return null;

  return {
    rawRedacted: redactedFull,
    normKey,
    tsMs: parseIsoTimeMs(step.created_at ?? step.timestamp ?? step.createdAt),
    stepIndex: toFiniteNumber(step.step_index ?? step.stepIndex),
    windowTag,
    orderIdx
  };
}

function extractUserIntentForConversation(conversationId, brainRoots = [], convDirInfo = null) {
  const empty = {
    transcriptPath: null,
    initialRequest: null,
    recentMessages: [],
    readStats: null
  };
  if (!isConfirmedSpecificId(conversationId)) return empty;
  const txPath = findPreferredTranscriptForConversation(conversationId, {
    extraRoots: brainRoots,
    convDirInfo
  });
  if (!txPath) return empty;

  const readRes = readTranscriptHeadTailFixed(txPath, { headBytes: 65536, tailBytes: 131072 });
  const readStats = {
    headBytesRead: readRes.headBytesRead,
    tailBytesRead: readRes.tailBytesRead,
    totalBytesRead: readRes.totalBytesRead,
    fileSize: readRes.fileSize,
    overlapped: readRes.overlapped
  };

  let initialRaw = null;
  for (let i = 0; i < readRes.headSteps.length; i++) {
    const msg = extractValidUserMessage(readRes.headSteps[i], "head", i);
    if (msg) {
      initialRaw = msg;
      break;
    }
  }

  const initialRequest = initialRaw
    ? {
        text: redactAndFlatten(initialRaw.rawRedacted, MAX_INITIAL_USER_BYTES),
        normKey: initialRaw.normKey,
        stepIndex: initialRaw.stepIndex,
        tsMs: initialRaw.tsMs,
        source: "transcript:head"
      }
    : null;

  const tailValid = [];
  for (let i = 0; i < readRes.tailSteps.length; i++) {
    const msg = extractValidUserMessage(readRes.tailSteps[i], "tail", i);
    if (msg) tailValid.push(msg);
  }
  tailValid.sort((a, b) => {
    if (a.tsMs !== null && b.tsMs !== null && a.tsMs !== b.tsMs) return a.tsMs - b.tsMs;
    if (a.stepIndex !== null && b.stepIndex !== null && a.stepIndex !== b.stepIndex) return a.stepIndex - b.stepIndex;
    return a.orderIdx - b.orderIdx;
  });

  const seenNorm = new Set();
  const pickedReverse = [];
  for (let i = tailValid.length - 1; i >= 0 && pickedReverse.length < 2; i--) {
    const m = tailValid[i];
    if (seenNorm.has(m.normKey)) continue;
    if (
      initialRequest &&
      (m.normKey === initialRequest.normKey ||
        (m.stepIndex !== null && initialRequest.stepIndex !== null && m.stepIndex === initialRequest.stepIndex))
    ) {
      continue;
    }
    seenNorm.add(m.normKey);
    pickedReverse.push({
      text: redactAndFlatten(m.rawRedacted, MAX_RECENT_USER_BYTES),
      normKey: m.normKey,
      stepIndex: m.stepIndex,
      tsMs: m.tsMs,
      source: "transcript:tail"
    });
  }

  return {
    transcriptPath: txPath,
    initialRequest,
    recentMessages: pickedReverse.reverse(),
    readStats
  };
}

function readTaskMdPartial(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, "r");
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    const totalSize = stat.size;
    const toRead = Math.min(totalSize, TASK_MD_MAX_READ_BYTES);
    if (toRead <= 0) {
      return {
        partial: false,
        bytesRead: 0,
        fileSize: totalSize,
        doneCount: 0,
        inProgressCount: 0,
        pendingCount: 0,
        openItems: [],
        totalOpenInSample: 0
      };
    }
    const buf = Buffer.allocUnsafe(toRead);
    let bytesRead = 0;
    while (bytesRead < toRead) {
      const n = fs.readSync(fd, buf, bytesRead, toRead - bytesRead, bytesRead);
      if (n <= 0) break;
      bytesRead += n;
    }
    const partial = totalSize > TASK_MD_MAX_READ_BYTES || bytesRead < totalSize;
    const sliceBuf = buf.subarray(0, bytesRead);
    let rawSliceText;
    if (partial) {
      const lastNl = sliceBuf.lastIndexOf(0x0a);
      if (lastNl >= 0) {
        rawSliceText = sliceBuf.subarray(0, lastNl + 1).toString("utf8");
      } else {
        // Trim any split trailing multi-byte UTF-8 sequence on raw buffer before decoding
        let end = sliceBuf.length;
        if (end > 0) {
          let lastLead = end - 1;
          while (lastLead > 0 && (sliceBuf[lastLead] & 0xc0) === 0x80) {
            lastLead -= 1;
          }
          const lead = sliceBuf[lastLead];
          let expectedLen = 1;
          if ((lead & 0xe0) === 0xc0) expectedLen = 2;
          else if ((lead & 0xf0) === 0xe0) expectedLen = 3;
          else if ((lead & 0xf8) === 0xf0) expectedLen = 4;
          if (end - lastLead < expectedLen) {
            end = lastLead;
          }
        }
        rawSliceText = sliceBuf.subarray(0, end).toString("utf8");
      }
    } else {
      rawSliceText = sliceBuf.toString("utf8");
    }
    const rawText = redactSecrets(rawSliceText).text;
    let doneCount = 0;
    let inProgressCount = 0;
    let pendingCount = 0;
    let totalOpenInSample = 0;
    const activeCandidates = [];
    const pendingCandidates = [];
    const lines = rawText.replace(/\r\n/g, "\n").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\s*(?:[-*+]|\d+[.)])\s*\[([ xX/])\]\s+(.*)$/);
      if (!m) continue;
      const mark = m[1];
      if (mark === "x" || mark === "X") {
        doneCount += 1;
        continue;
      }
      const rawBody = m[2];
      const hasBody = rawBody.replace(/[\r\n\t\x00-\x1f\x7f-\x9f]+/g, " ").trim().length > 0;
      if (mark === "/") {
        inProgressCount += 1;
        if (hasBody) {
          totalOpenInSample += 1;
          if (activeCandidates.length < MAX_TASK_ITEMS) {
            activeCandidates.push({ marker: "/", raw: rawBody, lineIdx: i });
          }
        }
      } else {
        pendingCount += 1;
        if (hasBody) {
          totalOpenInSample += 1;
          if (pendingCandidates.length < MAX_TASK_ITEMS) {
            pendingCandidates.push({ marker: " ", raw: rawBody, lineIdx: i });
          }
        }
      }
    }
    const remainingSlots = Math.max(0, MAX_TASK_ITEMS - activeCandidates.length);
    const selectedRaw = [
      ...activeCandidates,
      ...pendingCandidates.slice(0, remainingSlots)
    ].sort((a, b) => a.lineIdx - b.lineIdx);
    const openItems = selectedRaw
      .map((it) => ({
        marker: it.marker,
        text: /[\x00-\x1f\x7f-\x9f]/.test(it.raw)
          ? redactAndFlatten(it.raw, MAX_TASK_ITEM_BYTES)
          : flattenPreRedacted(it.raw, MAX_TASK_ITEM_BYTES),
        lineIdx: it.lineIdx
      }))
      .filter((it) => it.text.length > 0);
    return {
      partial,
      bytesRead,
      fileSize: totalSize,
      doneCount,
      inProgressCount,
      pendingCount,
      openItems,
      totalOpenInSample
    };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function inspectBrainArtifactsForConversation(conversationId, brainRoots = [], sharedConvDirInfo = null) {
  const empty = { artifacts: [], tasks: null };
  if (!isConfirmedSpecificId(conversationId)) return empty;
  const convDirInfo = sharedConvDirInfo || resolveConversationBrainDir(conversationId, brainRoots);
  if (!convDirInfo) return empty;

  const artifacts = [];
  let tasks = null;

  for (const fileName of BRAIN_ARTIFACT_NAMES) {
    const owned = resolveConversationOwnedFile(convDirInfo, [fileName]);
    if (!owned) continue;
    const displayPath = redactAndFlatten(owned.path.replace(/\\/g, "/"), 240);
    const mtimeIso = new Date(owned.stat.mtimeMs).toISOString();
    artifacts.push({
      name: fileName,
      path: displayPath,
      mtime: mtimeIso,
      size: owned.stat.size
    });
    if (fileName === "task.md") {
      const parsed = readTaskMdPartial(owned.path);
      if (parsed) {
        tasks = { ...parsed, path: displayPath };
      }
    }
  }

  return { artifacts, tasks };
}

function normalizeFailureExcerptForBrief(rawExcerpt) {
  if (typeof rawExcerpt !== "string" || !rawExcerpt.trim()) return "";
  const redacted = redactSecrets(rawExcerpt).text;
  const lines = redacted
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, " ").trim())
    .filter(Boolean)
    .slice(0, MAX_FAILURE_EXCERPT_LINES);
  if (lines.length === 0) return "";
  const joined = lines.join("\n");
  if (Buffer.byteLength(joined, "utf8") <= MAX_FAILURE_EXCERPT_BYTES) return joined;
  return truncateUtf8Safe(joined, MAX_FAILURE_EXCERPT_BYTES).trimEnd();
}

function pickFirstErrorLineFromExcerpt(excerpt) {
  if (typeof excerpt !== "string" || !excerpt.trim()) return "";
  const lines = excerpt
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return "";
  if (/^not\s+ok\b/i.test(lines[0]) && lines.length > 1) {
    const diagLine =
      lines.slice(1).find((l) => /^(?:error|message)\s*:/i.test(l)) ||
      lines.slice(1).find((l) => isFailureAnchorLine(l, { includeTimeout: true })) ||
      lines[1];
    if (diagLine) {
      const joined = `${lines[0]} — ${diagLine}`;
      if (Buffer.byteLength(joined, "utf8") <= 160) {
        return redactAndFlatten(joined, 160);
      }
      const casePart = redactAndFlatten(lines[0], 72);
      const sep = " — ";
      const rem = Math.max(24, 160 - Buffer.byteLength(casePart + sep, "utf8"));
      return redactAndFlatten(`${casePart}${sep}${redactAndFlatten(diagLine, rem)}`, 160);
    }
  }
  for (const line of lines) {
    if (isFailureAnchorLine(line, { includeTimeout: true })) {
      return redactAndFlatten(line, 160);
    }
  }
  return redactAndFlatten(lines[0], 160);
}

function hasPersistedCheckpointRecord(checkpoint) {
  if (!checkpoint || typeof checkpoint !== "object") return false;
  if (typeof checkpoint.updatedAt === "string" && checkpoint.updatedAt.trim().length > 0) {
    return true;
  }
  if (typeof checkpoint.updated_at === "string" && checkpoint.updated_at.trim().length > 0) {
    return true;
  }
  if (Number.isFinite(Number(checkpoint.updatedTs)) && Number(checkpoint.updatedTs) > 0) {
    return true;
  }
  if (Array.isArray(checkpoint.modifiedFiles) && checkpoint.modifiedFiles.filter(Boolean).length > 0) {
    return true;
  }
  if (toFiniteNumber(checkpoint.modifiedFileCount) > 0) {
    return true;
  }
  if (checkpoint.lastTest && typeof checkpoint.lastTest === "object") {
    return true;
  }
  if (checkpoint.lastBuild && typeof checkpoint.lastBuild === "object") {
    return true;
  }
  return false;
}

function formatVerificationLineSafe(label, rec, { allowRawSummary = true } = {}) {
  if (!rec || typeof rec !== "object") return "";
  const status = rec.ok ? "PASS" : "FAIL";
  const exitNum = toFiniteNumber(rec.exitCode);
  const exitPart = exitNum !== null ? ` (exit ${exitNum})` : "";
  const cmdClean = rec.command ? redactAndFlatten(rec.command, 120) : "";
  const cmdPart = cmdClean ? ` ${wrapInlineCode(cmdClean)}` : "";
  const rawSummary = allowRawSummary ? rec.summary : formatStructuredVerificationSummary(rec);
  const sumClean = rawSummary ? redactAndFlatten(rawSummary, 180) : "";
  const summaryPart = sumClean ? ` — ${sumClean}` : "";
  const srcClean = rec.sourceId ? redactAndFlatten(rec.sourceId, 64) : "";
  const srcPart = srcClean ? ` [sourceId: ${wrapInlineCode(srcClean)}]` : "";
  return `- **${label}**: ${status}${exitPart}${cmdPart}${summaryPart}${srcPart}`;
}

function isAlertingSafetyContext(safetyContext) {
  if (!safetyContext || typeof safetyContext !== "object") return false;
  const st = String(safetyContext.status || "").toLowerCase();
  const sev = String(safetyContext.severity || "").toLowerCase();
  return (
    st === "429_avalanche" ||
    st === "heavy_burst_or_sticky" ||
    st === "approaching_quota" ||
    sev === "warn" ||
    sev === "critical"
  );
}

function buildSafetyAdvisoryLines(safetyContext) {
  if (!isAlertingSafetyContext(safetyContext)) return [];
  const status = redactAndFlatten(String(safetyContext.status || "alert"), 32);
  const sev = redactAndFlatten(String(safetyContext.severity || "warn").toUpperCase(), 16);
  const w = safetyContext.window || safetyContext;
  const precheck = toFiniteNumber(w.precheckCount) ?? 0;
  const limit = toFiniteNumber(w.precheckLimit) ?? 4400;
  const heavy = toFiniteNumber(w.heavyReviewCount) ?? 0;
  const heavyAvg = toFiniteNumber(w.heavyAvgChars) ?? 0;
  const falseAlarms = toFiniteNumber(w.heavyTriggeredFalse ?? w.heavyFalseAlarmCount) ?? 0;
  const rate429 = toFiniteNumber(w.rateLimit429Count) ?? 0;
  const fallbacks = toFiniteNumber(w.fallbackEscalationCount) ?? 0;
  const hiddenPct = toFiniteNumber(safetyContext.streamRequests?.hiddenSharePct ?? safetyContext.hiddenStreamSharePct);
  const metrics = [`5h prechecks: ${precheck}/${limit}`];
  if (rate429 > 0 || fallbacks > 0) metrics.push(`429/fallback: ${rate429}/${fallbacks}`);
  if (heavy > 0) {
    metrics.push(
      `heavy reviews: ${heavy} (avg ${Math.round(heavyAvg / 1000)}K chars${falseAlarms > 0 ? `, ${falseAlarms} false alarms` : ""})`
    );
  }
  if (hiddenPct !== null) metrics.push(`hidden stream share: ${hiddenPct}%`);
  const lines = [
    `- **Alert**: \`${status}\` (${sev}) — ${metrics.join(" | ")}`
  ];
  const diag = redactAndFlatten(safetyContext.summaryEn || safetyContext.diagnosis || "", 200);
  if (diag) {
    lines.push(`- **Diagnosis**: ${diag}`);
  }
  lines.push(
    "- **Mitigation**: Start in a fresh conversation window to break long-trajectory / sticky re-review chains; keep outside-workspace reads on native `read_file` (`allowed_tool`, 0 cloud review)."
  );
  return lines;
}

function buildAgentHandoffBrief({
  store = null,
  sessionId = "default",
  cwd = "",
  maxBytes = DEFAULT_MAX_BYTES,
  sinceTs = null,
  stallContext = null,
  safetyContext = null,
  conversationId = "",
  conversationConfirmed = false,
  scope = "conversation",
  brainRoots = [],
  gitExecFn = null,
  gitBudgetMs = GIT_TOTAL_BUDGET_MS,
  monoNsFn = process.hrtime.bigint,
  nowFn = Date.now
} = {}) {
  const rawScope = typeof scope === "string" && scope.trim() ? scope.trim() : "conversation";
  const parsedMax = Number(maxBytes);
  const budget = Number.isFinite(parsedMax) && parsedMax > 0 ? Math.floor(parsedMax) : DEFAULT_MAX_BYTES;
  const rawCwd = typeof cwd === "string" ? cwd.trim() : "";

  const confirmedConversation = Boolean(
    rawScope === "conversation" && conversationConfirmed === true && isConfirmedSpecificId(conversationId)
  );
  const confirmedConvId = confirmedConversation ? conversationId.trim() : "";
  const rawNow = typeof nowFn === "function" ? nowFn() : Date.now();
  const sampledAtMs = Number.isFinite(Number(rawNow)) ? Number(rawNow) : Date.now();
  const sampledAt = confirmedConversation ? new Date(sampledAtMs).toISOString() : "";

  const rawSid = typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : "default";
  const effectiveSid = confirmedConversation
    ? isConfirmedSpecificId(rawSid)
      ? rawSid
      : confirmedConvId
    : rawSid;
  const confirmedCheckpointSessionId =
    confirmedConversation && isConfirmedSpecificId(effectiveSid) ? effectiveSid : "";
  const secretRedactionEnabled = isSecretRedactionEnabled();

  const gitInfo = inspectGitWorkspace(rawCwd, {
    includeExtended: true,
    gitBudgetMs,
    gitExecFn,
    monoNsFn
  });
  const gitHeadStatus = confirmedConversation
    ? gitInfo.isGit && gitInfo.headState === "commit" && gitInfo.headOid
      ? "commit"
      : gitInfo.isGit && gitInfo.headState === "unborn"
        ? "unborn"
        : "unknown"
    : "";
  const gitHead = gitHeadStatus === "commit" ? gitInfo.headOid : "";
  const gitDirtyEntries =
    confirmedConversation &&
    gitInfo.isGit &&
    typeof gitInfo.dirtyEntryCount === "number" &&
    Number.isFinite(gitInfo.dirtyEntryCount)
      ? gitInfo.dirtyEntryCount
      : null;

  let checkpoint = null;
  let resumeState = null;

  if (store && typeof store.getSessionCheckpoint === "function") {
    try {
      checkpoint = store.getSessionCheckpoint(effectiveSid);
    } catch {
      checkpoint = null;
    }
  }
  if (store && typeof store.getResumeState === "function") {
    try {
      const resumeSince = toFiniteNumber(sinceTs);
      const resumeOpts = resumeSince !== null ? { sinceTs: resumeSince } : {};
      resumeState = store.getResumeState(effectiveSid, 5, resumeOpts);
    } catch {
      resumeState = null;
    }
  }
  if (!hasPersistedCheckpointRecord(checkpoint) && hasPersistedCheckpointRecord(resumeState?.sessionCheckpoint)) {
    checkpoint = resumeState.sessionCheckpoint;
  }
  const hasPersistedCheckpoint = Boolean(
    confirmedConversation && confirmedCheckpointSessionId && hasPersistedCheckpointRecord(checkpoint)
  );

  // Strictly gate transcript user intent & brain artifacts to confirmed conversations only;
  // resolve brain dir ONCE so transcript and artifacts always share the exact same root.
  const sharedConvDirInfo = confirmedConversation
    ? resolveConversationBrainDir(confirmedConvId, brainRoots)
    : null;
  const userIntent =
    confirmedConversation && sharedConvDirInfo
      ? extractUserIntentForConversation(confirmedConvId, brainRoots, sharedConvDirInfo)
      : { transcriptPath: null, initialRequest: null, recentMessages: [], readStats: null };
  const brainInfo =
    confirmedConversation && sharedConvDirInfo
      ? inspectBrainArtifactsForConversation(confirmedConvId, brainRoots, sharedConvDirInfo)
      : { artifacts: [], tasks: null };

  const modifiedFiles = Array.isArray(checkpoint?.modifiedFiles) ? checkpoint.modifiedFiles.filter(Boolean) : [];
  const cpModCount = toFiniteNumber(checkpoint?.modifiedFileCount);
  const modifiedFileCount = cpModCount !== null ? Math.max(modifiedFiles.length, cpModCount) : modifiedFiles.length;
  const lastTest = checkpoint?.lastTest || null;
  const lastBuild = checkpoint?.lastBuild || null;
  const recentSources = Array.isArray(resumeState?.recentSources) ? resumeState.recentSources.slice(0, 5) : [];

  const summaryParts = [];
  const safeWorkspace = rawCwd ? redactAndFlatten(rawCwd.replace(/\\/g, "/"), 220) : "";
  const safeBranch = gitInfo.isGit && gitInfo.branch ? redactAndFlatten(gitInfo.branch, 120) : "";
  if (safeBranch) summaryParts.push(`branch=${redactAndFlatten(safeBranch, 48)}`);

  // Core Header
  const headerLines = ["# agy-dart Handoff Brief"];
  if (confirmedConversation) {
    headerLines.push(`- **Conversation**: ${wrapInlineCode(redactAndFlatten(confirmedConvId, 96))}`);
    if (hasPersistedCheckpoint && confirmedCheckpointSessionId !== confirmedConvId) {
      headerLines.push(`- **Checkpoint Session**: ${wrapInlineCode(redactAndFlatten(confirmedCheckpointSessionId, 96))}`);
    }
  } else {
    headerLines.push(`- **Scope**: ${wrapInlineCode(redactAndFlatten(rawScope, 32))} (overview)`);
  }
  if (safeWorkspace) {
    headerLines.push(`- **Workspace**: ${wrapInlineCode(safeWorkspace)}`);
  }
  if (safeBranch) {
    headerLines.push(`- **Git Branch**: ${wrapInlineCode(safeBranch)}`);
  }
  if (confirmedConversation) {
    const headDisplay =
      gitHeadStatus === "commit"
        ? wrapInlineCode(gitHead)
        : gitHeadStatus === "unborn"
          ? "`No commits yet / 尚无提交`"
          : "`Unknown / 未知`";
    const dirtyDisplay =
      gitDirtyEntries !== null ? wrapInlineCode(String(gitDirtyEntries)) : "`Unknown / 未知`";
    headerLines.push(
      `- **Git Snapshot** (UTC ${wrapInlineCode(sampledAt)}): HEAD ${headDisplay} | Dirty Entries (\`status --porcelain=v1 -b -z --untracked-files=normal\`): ${dirtyDisplay}`
    );
  }
  const fullHeaderBlock = headerLines.join("\n");
  const compactHeaderBlock = confirmedConversation
    ? `# agy-dart Handoff Brief\n- **Conversation**: ${wrapInlineCode(redactAndFlatten(confirmedConvId, 64))}`
    : `# agy-dart Handoff Brief\n- **Scope**: ${wrapInlineCode(redactAndFlatten(rawScope, 24))} (overview)`;

  // Core Recovery & Next Step Footer
  const resumeSameWindow = "ctx_resume({})";
  const checkpointRedaction = confirmedCheckpointSessionId
    ? redactSecrets(confirmedCheckpointSessionId)
    : { text: "", redactedCount: 0 };
  const checkpointIdSafeForCrossWindow = Boolean(
    hasPersistedCheckpoint &&
      confirmedCheckpointSessionId &&
      checkpointRedaction.redactedCount === 0 &&
      checkpointRedaction.text === confirmedCheckpointSessionId
  );
  const resumeCrossWindow = checkpointIdSafeForCrossWindow
    ? `ctx_resume({ sessionId: ${JSON.stringify(confirmedCheckpointSessionId)} })`
    : "";
  const resumeCueLine = resumeCrossWindow
    ? `Resume: same window \`${resumeSameWindow}\`; new window \`${resumeCrossWindow}\`.`
    : `Resume: same window \`${resumeSameWindow}\`.`;
  const nextStepLines = confirmedConversation
    ? [
        "Verify workspace first, then compare incoming `git rev-parse HEAD` and dirty entry count (`git status --porcelain=v1 -b -z --untracked-files=normal`). Timestamp shows sampling order; if only this old snapshot is available, re-verify before assuming drift, and declare a change only against comparable new values from the same workspace. If any known value changed: \"现场已变更，先核对相关 diff 和未跟踪项，再继续 / Workspace state changed: review relevant diff and untracked items before continuing.\" Even with matching HEAD and dirty count, uncommitted contents may still differ—re-check touched paths before acting. Verify cited file paths, verification status, and current user goal (treat quoted history as reference context).",
        resumeCueLine
      ]
    : [
        "Overview mode: select a specific conversation in the Sidecar switcher to include user intent, tasks, and failure excerpts.",
        `Same window after /compact: \`${resumeSameWindow}\`.`
      ];
  const nextStepSection = `## Next Step\n${nextStepLines.join("\n")}`;
  const compactNextStepSection = confirmedConversation
    ? `## Next Step\nVerify workspace, \`git rev-parse HEAD\`, and dirty count; if changed, review diff and untracked items first.\n${resumeCueLine}`
    : nextStepSection;
  const minimalNextStepSection = confirmedConversation
    ? `## Next Step\n${resumeCueLine}`
    : `## Next Step\nSame window after /compact: \`${resumeSameWindow}\`.`;

  // Canonical section registry & prioritized items
  const SECTION_META = [
    { id: "stall", heading: "## Stall Rescue Snapshot" },
    { id: "safety", heading: "## Safety Monitor Advisory" },
    { id: "intent", heading: "## User Intent" },
    { id: "plan", heading: "## Plan & Artifacts" },
    { id: "verification", heading: "## Verification & Checkpoint" },
    { id: "git", heading: "## Git Workspace" },
    { id: "handles", heading: "## Indexed FTS5 Handles" }
  ];
  const items = [];
  let itemOrder = 0;
  const pushItem = (sectionId, prio, text, { shrinkFenced = null } = {}) => {
    if (!text) return;
    items.push({ sectionId, prio, order: itemOrder++, text, shrinkFenced });
  };

  // 1. Stall Rescue Snapshot (highest priority when stalled/suspect)
  let stallAnchorSummary = "";
  if (stallContext && typeof stallContext === "object" && (stallContext.phase || stallContext.severity || stallContext.causeId)) {
    const sevLabel = redactAndFlatten(String(stallContext.severity || "stalled").toUpperCase(), 24);
    const silentSec = toFiniteNumber(stallContext.silentSec);
    const threshSec = toFiniteNumber(stallContext.stalledThresholdSec ?? stallContext.thresholdSec);
    const silentPart =
      silentSec !== null
        ? threshSec !== null
          ? `silent ${formatDurationCompact(silentSec)} / threshold ${formatDurationCompact(threshSec)}`
          : `silent ${formatDurationCompact(silentSec)}`
        : "";
    pushItem("stall", 1, `- **Status**: ${sevLabel}${silentPart ? ` (${silentPart})` : ""} *(source: \`watchdog\`)*`);
    if (stallContext.phase) {
      const subPart = stallContext.subphase ? ` (${redactAndFlatten(stallContext.subphase, 48)})` : "";
      const ctxTok = toFiniteNumber(stallContext.contextTokens);
      const ctxPart = ctxTok !== null && ctxTok > 0 ? ` · ${formatTokensK(ctxTok)} tok` : "";
      const modelPart = stallContext.model ? ` · ${wrapInlineCode(redactAndFlatten(stallContext.model, 64))}` : "";
      pushItem("stall", 2, `- **Phase**: ${wrapInlineCode(redactAndFlatten(stallContext.phase, 32))}${subPart}${ctxPart}${modelPart}`);
    }
    if (stallContext.causeLabel || stallContext.causeId) {
      const cLabel = redactAndFlatten(stallContext.causeLabel || stallContext.causeId, 120);
      const cIdPart =
        stallContext.causeId && stallContext.causeLabel
          ? ` (${wrapInlineCode(redactAndFlatten(stallContext.causeId, 48))})`
          : "";
      pushItem("stall", 3, `- **Suspected Cause**: ${cLabel}${cIdPart}`);
      stallAnchorSummary = `${sevLabel}: ${cLabel}${silentPart ? ` (${silentPart})` : ""}`;
    } else {
      stallAnchorSummary = `${sevLabel}${silentPart ? ` (${silentPart})` : ""}`;
    }
    const toolName = stallContext.activeTool || stallContext.lastCompletedTool || "";
    const toolSummary = stallContext.activeToolSummary || "";
    if (toolName || toolSummary) {
      const toolLabel = toolName ? wrapInlineCode(redactAndFlatten(toolName, 64)) : "`tool`";
      const sumPart = toolSummary ? ` — ${wrapInlineCode(redactAndFlatten(toolSummary, 160))}` : "";
      pushItem("stall", 4, `- **Last Tool / Command**: ${toolLabel}${sumPart}`);
    }
    // Never include lastUserInput in unconfirmed/aggregate overview
    if (confirmedConversation && stallContext.lastUserInput) {
      pushItem("stall", 5, `- **Last User Input**: > [watchdog] ${redactAndFlatten(stallContext.lastUserInput, 220)}`);
    }
    if (Array.isArray(stallContext.tips) && stallContext.tips.length > 0) {
      const cleanTips = stallContext.tips
        .filter((tip) => typeof tip === "string" && tip.trim())
        .slice(0, 2)
        .map((tip, i) => `  ${i + 1}. ${redactAndFlatten(tip, 220)}`);
      if (cleanTips.length > 0) {
        pushItem("stall", 6, `- **Troubleshooting**:\n${cleanTips.join("\n")}`);
      }
    }
    summaryParts.unshift(`stall=${redactAndFlatten(String(stallContext.severity || "stalled").toLowerCase(), 16)}`);
  }

  // 1b. Optional Safety Monitor Advisory (Issue #1886 — only when actively alerting)
  if (isAlertingSafetyContext(safetyContext)) {
    const safetyLines = buildSafetyAdvisoryLines(safetyContext);
    for (let i = 0; i < safetyLines.length; i++) {
      pushItem("safety", 20 + i, safetyLines[i]);
    }
    summaryParts.push(`safety=${redactAndFlatten(String(safetyContext.status || "alert"), 24)}`);
  }

  // 2. User Intent (confirmed conversation only)
  if (confirmedConversation) {
    const recents = userIntent.recentMessages || [];
    if (userIntent.initialRequest) {
      const prio = recents.length === 0 ? 10 : 28;
      pushItem("intent", prio, `> [transcript:head] **Initial Request**: ${userIntent.initialRequest.text}`);
    }
    for (let i = 0; i < recents.length; i++) {
      const isLatest = i === recents.length - 1;
      const prio = isLatest ? 10 : 34;
      const label = isLatest ? "**Latest User Message**" : "**Recent User Message**";
      pushItem("intent", prio, `> [transcript:tail] ${label}: ${recents[i].text}`);
    }
  }

  // 3. Plan & Artifacts (confirmed conversation only)
  const openTasks = brainInfo.tasks?.openItems || [];
  if (confirmedConversation && (brainInfo.artifacts.length > 0 || brainInfo.tasks)) {
    if (brainInfo.tasks) {
      const tInfo = brainInfo.tasks;
      const partialTag = tInfo.partial ? "partial read / 已读部分 (first 24 KB)" : "full read";
      pushItem(
        "plan",
        24,
        `- **Tasks** (${partialTag}; in-progress: ${tInfo.inProgressCount}, pending: ${tInfo.pendingCount}, done: ${tInfo.doneCount}) *(source: \`brain:task.md\`)*`
      );
      for (let i = 0; i < openTasks.length; i++) {
        const item = openTasks[i];
        const prio = i === 0 ? 15 : 38 + i;
        pushItem("plan", prio, `> [brain:task.md] - [${item.marker}] ${item.text}`);
      }
      if (openTasks.length > 0) {
        summaryParts.push(`${tInfo.inProgressCount + tInfo.pendingCount} open tasks${tInfo.partial ? " (partial)" : ""}`);
      }
    }
    if (brainInfo.artifacts.length > 0) {
      const artLines = brainInfo.artifacts.map(
        (a) => `- ${wrapInlineCode(a.name)}: ${wrapInlineCode(a.path)} (mtime: ${a.mtime})`
      );
      pushItem("plan", 52, artLines.join("\n"));
    }
  }

  // 4. Verification & Checkpoint (NEVER calls store.getSourceChunks())
  const failingAnchors = [];
  const passingAnchors = [];
  const pushVerification = (label, rec, isTest) => {
    const line = formatVerificationLineSafe(label, rec, { allowRawSummary: confirmedConversation });
    if (!line) return;
    const isFail = !rec.ok;
    const prio = isFail ? (isTest ? 12 : 14) : isTest ? 46 : 48;
    pushItem("verification", prio, line);
    summaryParts.push(`${isTest ? "test" : "build"}=${rec.ok ? "PASS" : "FAIL"}`);
    if (confirmedConversation && isFail) {
      const excerpt = normalizeFailureExcerptForBrief(rec.failureExcerpt || "");
      const srcTag = isTest ? "checkpoint:lastTest" : "checkpoint:lastBuild";
      const srcIdClean = rec.sourceId ? redactAndFlatten(rec.sourceId, 64) : "";
      if (excerpt) {
        const prefix = `> [${srcTag}${srcIdClean ? ` · sourceId:${srcIdClean}` : ""}]`;
        const fullBlock = `${prefix}\n${wrapSafeFence(excerpt, "text")}`;
        pushItem("verification", prio + 1, fullBlock, {
          shrinkFenced: { prefix, content: excerpt, lang: "text" }
        });
      }
      failingAnchors.push({
        kind: isTest ? "test" : "build",
        command: redactAndFlatten(rec.command || "", 120),
        summary: redactAndFlatten(rec.summary || "", 160),
        sourceId: srcIdClean,
        firstErrorLine: pickFirstErrorLineFromExcerpt(excerpt)
      });
    } else if (confirmedConversation && !isFail) {
      passingAnchors.push({
        kind: isTest ? "test" : "build",
        command: redactAndFlatten(rec.command || "", 120),
        summary: redactAndFlatten(rec.summary || "", 160),
        sourceId: rec.sourceId ? redactAndFlatten(rec.sourceId, 64) : ""
      });
    }
  };
  pushVerification("Last Test", lastTest, true);
  pushVerification("Last Build", lastBuild, false);

  const modifiedFileAnchors = confirmedConversation
    ? modifiedFiles.slice(0, 8).map((f) => redactAndFlatten(f, 160)).filter(Boolean)
    : [];
  if (modifiedFiles.length > 0) {
    const shown = modifiedFiles.slice(0, 12).map((f) => wrapInlineCode(redactAndFlatten(f, 160)));
    const extra = modifiedFileCount > shown.length ? ` (+${modifiedFileCount - shown.length} more)` : "";
    pushItem("verification", 50, `- **Modified Files (${modifiedFileCount})**: ${shown.join(", ")}${extra}`);
    summaryParts.push(`${modifiedFileCount} modified`);
  }

  // 5. Git Workspace (diff stat, untracked, branch history)
  if (gitInfo.timedOut) {
    pushItem("git", 56, `- **Git Status**: timed out after ${gitBudgetMs}ms budget (partial workspace state)`);
  }
  if (gitInfo.isGit && gitInfo.diffStat) {
    const diffFence = wrapSafeFence(gitInfo.diffStat, "text");
    pushItem("git", 58, `- **Diff Stat**:\n${diffFence}`, {
      shrinkFenced: { prefix: "- **Diff Stat**:", content: gitInfo.diffStat, lang: "text" }
    });
  }
  if (gitInfo.isGit && gitInfo.untracked.length > 0) {
    const extraUntracked =
      gitInfo.untrackedTotalCount > gitInfo.untracked.length
        ? ` (+${gitInfo.untrackedTotalCount - gitInfo.untracked.length} more)`
        : "";
    const listStr = gitInfo.untracked.map((u) => wrapInlineCode(u)).join(", ");
    pushItem("git", 62, `- **Untracked (${gitInfo.untrackedTotalCount})**: ${listStr}${extraUntracked}`);
  }
  if (gitInfo.isGit && gitInfo.recentCommits.length > 0) {
    const commitLines = gitInfo.recentCommits.map((c) => `> [git:branch-history] ${c}`);
    pushItem("git", 66, `- **Branch History (recent commits / 分支历史)**:\n${commitLines.join("\n")}`);
  }

  // 6. Indexed FTS5 Handles
  for (let i = 0; i < recentSources.length; i++) {
    const src = recentSources[i];
    const id = redactAndFlatten(src?.id ?? src?.sourceId ?? "", 80);
    const label = redactAndFlatten(src?.label || "untitled", 160);
    const sz = formatBytesCompact(src?.bytes_total ?? src?.bytesTotal ?? 0);
    const chunks = Number(src?.chunk_count ?? src?.chunkCount ?? 0);
    const chunkNote = chunks > 0 ? `, ${chunks} ${chunks === 1 ? "chunk" : "chunks"}` : "";
    pushItem("handles", 72 + i, `- ${wrapInlineCode(id)} — ${label} (${sz}${chunkNote})`);
  }
  if (recentSources.length > 0) {
    summaryParts.push(`${recentSources.length} FTS5 ${recentSources.length === 1 ? "source" : "sources"}`);
  }

  const assembleDocument = (headerStr, selectedMap, truncNoticeStr, footerStr) => {
    const parts = [headerStr];
    for (const sec of SECTION_META) {
      const list = selectedMap.get(sec.id);
      if (!list || list.length === 0) continue;
      // Preserve logical order within each section
      const ordered = list.slice().sort((a, b) => a.order - b.order);
      parts.push(`${sec.heading}\n${ordered.map((x) => x.text).join("\n")}`);
    }
    if (truncNoticeStr) parts.push(truncNoticeStr);
    if (footerStr) parts.push(footerStr);
    return parts.join("\n\n");
  };

  // Fast path: full document fits within budget
  const allBySection = new Map();
  for (const it of items) {
    if (!allBySection.has(it.sectionId)) allBySection.set(it.sectionId, []);
    allBySection.get(it.sectionId).push(it);
  }
  const fullMarkdown = assembleDocument(fullHeaderBlock, allBySection, "", nextStepSection);

  let markdown = fullMarkdown;
  let truncated = false;

  if (Buffer.byteLength(fullMarkdown, "utf8") > budget) {
    truncated = true;
    const truncNotice = `... [truncated to <=${budget} B]`;

    // Choose header & footer tier that guarantees room for complete recovery commands whenever possible
    let chosenHeader = fullHeaderBlock;
    let chosenFooter = nextStepSection;
    let chosenNotice = truncNotice;

    const minReserve = (h, n, f) => Buffer.byteLength([h, n, f].filter(Boolean).join("\n\n"), "utf8");
    const minContentHeadroom = budget >= 1000 ? 180 : budget >= 500 ? 120 : 0;

    if (minReserve(chosenHeader, chosenNotice, chosenFooter) + minContentHeadroom > budget) {
      if (minReserve(fullHeaderBlock, chosenNotice, compactNextStepSection) + minContentHeadroom <= budget) {
        chosenHeader = fullHeaderBlock;
        chosenFooter = compactNextStepSection;
      } else if (minReserve(compactHeaderBlock, chosenNotice, nextStepSection) + minContentHeadroom <= budget) {
        chosenHeader = compactHeaderBlock;
        chosenFooter = nextStepSection;
      } else if (minReserve(compactHeaderBlock, chosenNotice, compactNextStepSection) <= budget) {
        chosenHeader = compactHeaderBlock;
        chosenFooter = compactNextStepSection;
      } else if (minReserve(compactHeaderBlock, chosenNotice, minimalNextStepSection) <= budget) {
        chosenHeader = compactHeaderBlock;
        chosenFooter = minimalNextStepSection;
      } else if (minReserve("# agy-dart Handoff Brief", "", minimalNextStepSection) <= budget) {
        chosenHeader = "# agy-dart Handoff Brief";
        chosenNotice = "";
        chosenFooter = minimalNextStepSection;
      } else {
        // Extreme tiny budget (e.g. 90 B or 320 B with long sessionId): minimal safe fragment
        const tinyResume = resumeCrossWindow ? `Resume: \`${resumeCrossWindow}\`` : `Resume: \`${resumeSameWindow}\``;
        const tinyCandidate =
          Buffer.byteLength(`# agy-dart Handoff Brief\n${tinyResume}`, "utf8") <= budget
            ? `# agy-dart Handoff Brief\n${tinyResume}`
            : Buffer.byteLength(`# agy-dart Handoff Brief\n\`${resumeSameWindow}\``, "utf8") <= budget
              ? `# agy-dart Handoff Brief\n\`${resumeSameWindow}\``
              : fullMarkdown;
        markdown = ensureClosedFencesWithinBudget(tinyCandidate, budget);
        chosenHeader = "";
      }
    }

    if (chosenHeader) {
      const selectedBySection = new Map();
      const sortedItems = items.slice().sort((a, b) => (a.prio !== b.prio ? a.prio - b.prio : a.order - b.order));

      const tryMeasureWith = (sectionId, order, text) => {
        const list = selectedBySection.get(sectionId) || [];
        const nextList = [...list, { order, text }];
        const nextMap = new Map(selectedBySection);
        nextMap.set(sectionId, nextList);
        const doc = assembleDocument(chosenHeader, nextMap, chosenNotice, chosenFooter);
        return { bytes: Buffer.byteLength(doc, "utf8"), doc, nextList };
      };

      for (const it of sortedItems) {
        const fullTry = tryMeasureWith(it.sectionId, it.order, it.text);
        if (fullTry.bytes <= budget) {
          selectedBySection.set(it.sectionId, fullTry.nextList);
          continue;
        }
        // Try line-by-line shrinking for fenced blocks (failure excerpts / diff stat) keeping fence closed
        if (it.shrinkFenced) {
          const rawLines = it.shrinkFenced.content.split("\n");
          let fitted = null;
          for (let keep = rawLines.length - 1; keep >= 1; keep--) {
            const subContent = rawLines.slice(0, keep).join("\n");
            const cand = `${it.shrinkFenced.prefix}\n${wrapSafeFence(subContent, it.shrinkFenced.lang)}`;
            const attempt = tryMeasureWith(it.sectionId, it.order, cand);
            if (attempt.bytes <= budget) {
              fitted = attempt.nextList;
              break;
            }
          }
          if (!fitted && rawLines.length > 0) {
            // Try clipping single first line inside closed fence accounting for exact backtick run width
            const lineRuns = rawLines[0].match(/`+/g) || [];
            const maxFenceLen = Math.max(3, lineRuns.reduce((m, r) => Math.max(m, r.length), 0) + 1);
            const dummyFence = "`".repeat(maxFenceLen);
            const emptyTemplate = `${it.shrinkFenced.prefix}\n${dummyFence}${it.shrinkFenced.lang}\n\n${dummyFence}`;
            const baseEmpty = tryMeasureWith(it.sectionId, it.order, emptyTemplate);
            const availForLine = budget - baseEmpty.bytes;
            if (availForLine >= 16) {
              const clippedLine = truncateUtf8Safe(rawLines[0], availForLine);
              if (clippedLine) {
                const cand = `${it.shrinkFenced.prefix}\n${wrapSafeFence(clippedLine, it.shrinkFenced.lang)}`;
                const attempt = tryMeasureWith(it.sectionId, it.order, cand);
                if (attempt.bytes <= budget) {
                  fitted = attempt.nextList;
                }
              }
            }
          }
          if (fitted) {
            selectedBySection.set(it.sectionId, fitted);
          }
        }
      }

      markdown = assembleDocument(chosenHeader, selectedBySection, chosenNotice, chosenFooter);
      markdown = ensureClosedFencesWithinBudget(markdown, budget);
    }
  }

  // Final hard guard: strict <= budget, valid UTF-8, closed fences
  if (Buffer.byteLength(markdown, "utf8") > budget || hasUnclosedFence(markdown)) {
    markdown = ensureClosedFencesWithinBudget(markdown, budget);
  }

  const bytes = Buffer.byteLength(markdown, "utf8");
  const rawSummary =
    summaryParts.length > 0
      ? summaryParts.join(" | ")
      : confirmedConversation
        ? `conv=${redactAndFlatten(confirmedConvId, 48)}`
        : `scope=${redactAndFlatten(rawScope, 32)}`;
  const summary = redactAndFlatten(rawSummary, 240);

  // Sanitized structured anchors for Sidecar secondary button ("Copy Handoff Prompt")
  const anchors = confirmedConversation
    ? {
        confirmed: true,
        conversationId: redactAndFlatten(confirmedConvId, 96),
        sessionId: hasPersistedCheckpoint ? redactAndFlatten(confirmedCheckpointSessionId, 96) : "",
        sampledAt,
        workspace: safeWorkspace,
        branch: safeBranch,
        gitHead,
        gitHeadStatus,
        gitDirtyEntries,
        artifacts: brainInfo.artifacts.map((a) => ({
          name: a.name,
          path: a.path,
          mtime: a.mtime
        })),
        nextTasks: openTasks.slice(0, 3).map((t) => `[${t.marker}] ${t.text}`),
        modifiedFiles: modifiedFileAnchors,
        modifiedFileCount: modifiedFileAnchors.length > 0 ? Math.max(modifiedFileCount, modifiedFileAnchors.length) : 0,
        failingChecks: failingAnchors,
        passingChecks: passingAnchors,
        recentSources: recentSources.slice(0, 3).map((s) => ({
          id: redactAndFlatten(s?.id ?? s?.sourceId ?? "", 80),
          label: redactAndFlatten(s?.label || "untitled", 120)
        })),
        stallSummary: stallAnchorSummary,
        resumeSameWindow,
        resumeCrossWindow
      }
    : {
        confirmed: false,
        conversationId: "",
        sessionId: "",
        sampledAt: "",
        workspace: "",
        branch: "",
        gitHead: "",
        gitHeadStatus: "",
        gitDirtyEntries: null,
        artifacts: [],
        nextTasks: [],
        modifiedFiles: [],
        modifiedFileCount: 0,
        failingChecks: [],
        passingChecks: [],
        recentSources: [],
        stallSummary: "",
        resumeSameWindow,
        resumeCrossWindow: ""
      };

  return {
    mode: "agent",
    scope: rawScope,
    confirmedConversation,
    conversationId: confirmedConvId,
    secretRedactionEnabled,
    sampledAt,
    markdown,
    summary,
    bytes,
    truncated,
    anchors,
    resumeCommand: resumeCrossWindow || resumeSameWindow,
    readStats: userIntent.readStats,
    gitTimedOut: gitInfo.timedOut
  };
}

/**
 * Build a compact, cache-friendly Markdown handoff brief for `/compact` or session switches.
 * Strictly bounded to `<= maxBytes` UTF-8 bytes without broken multi-byte characters.
 */
export function buildHandoffBrief({
  store = null,
  sessionId = "default",
  cwd = "",
  cacheDiag = null,
  maxBytes = DEFAULT_MAX_BYTES,
  sinceTs = null,
  stallContext = null,
  safetyContext = null,
  mode = "full",
  conversationId = "",
  conversationConfirmed = undefined,
  scope = "conversation",
  brainRoots = [],
  gitExecFn = null,
  gitBudgetMs = GIT_TOTAL_BUDGET_MS,
  monoNsFn = process.hrtime.bigint,
  nowFn = Date.now
} = {}) {
  if (mode === "agent") {
    return buildAgentHandoffBrief({
      store,
      sessionId,
      cwd,
      maxBytes,
      sinceTs,
      stallContext,
      safetyContext,
      conversationId,
      conversationConfirmed: conversationConfirmed === true,
      scope,
      brainRoots,
      gitExecFn,
      gitBudgetMs,
      monoNsFn,
      nowFn
    });
  }

  const rawScope = typeof scope === "string" && scope.trim() ? scope.trim() : "conversation";
  const isOverviewFull = rawScope !== "conversation" || conversationConfirmed === false;

  const sid = typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : "default";
  const parsedMax = Number(maxBytes);
  const budget = Number.isFinite(parsedMax) && parsedMax > 0 ? Math.floor(parsedMax) : DEFAULT_MAX_BYTES;
  const rawCwd = typeof cwd === "string" ? cwd.trim() : "";

  const gitInfo = inspectGitWorkspace(rawCwd, {
    includeExtended: false,
    gitBudgetMs,
    gitExecFn,
    monoNsFn
  });

  let checkpoint = null;
  let resumeState = null;

  if (store && typeof store.getSessionCheckpoint === "function") {
    try {
      checkpoint = store.getSessionCheckpoint(sid);
    } catch {
      checkpoint = null;
    }
  }
  if (store && typeof store.getResumeState === "function") {
    try {
      const resumeSince = toFiniteNumber(sinceTs);
      const resumeOpts = resumeSince !== null ? { sinceTs: resumeSince } : {};
      resumeState = store.getResumeState(sid, 5, resumeOpts);
    } catch {
      resumeState = null;
    }
  }
  if (!checkpoint && resumeState?.sessionCheckpoint) {
    checkpoint = resumeState.sessionCheckpoint;
  }

  const modifiedFiles = Array.isArray(checkpoint?.modifiedFiles) ? checkpoint.modifiedFiles.filter(Boolean) : [];
  const cpModCount = toFiniteNumber(checkpoint?.modifiedFileCount);
  const modifiedFileCount = cpModCount !== null ? Math.max(modifiedFiles.length, cpModCount) : modifiedFiles.length;
  const lastTest = checkpoint?.lastTest || null;
  const lastBuild = checkpoint?.lastBuild || null;
  const recentSources = Array.isArray(resumeState?.recentSources) ? resumeState.recentSources.slice(0, 5) : [];

  const sections = [];
  const summaryParts = [];

  // 1. Header & workspace metadata
  const headerLines = ["# agy-dart Handoff Brief", `- **Session**: \`${sanitizeInline(sid, 96)}\``];
  if (rawCwd) {
    headerLines.push(`- **Workspace**: \`${sanitizeInline(rawCwd.replace(/\\/g, "/"), 220)}\``);
  }
  if (gitInfo.isGit && gitInfo.branch) {
    headerLines.push(`- **Git Branch**: \`${sanitizeInline(gitInfo.branch, 120)}\``);
    summaryParts.push(`branch=${sanitizeInline(gitInfo.branch, 48)}`);
  }
  sections.push(headerLines.join("\n"));

  // 1b. Optional Stall Rescue Snapshot (pre-generated by Sidecar Stall Watchdog when stalled/suspect)
  if (stallContext && typeof stallContext === "object" && (stallContext.phase || stallContext.severity || stallContext.causeId)) {
    const stallLines = [];
    const sevLabel = String(stallContext.severity || "stalled").toUpperCase();
    const silentSec = toFiniteNumber(stallContext.silentSec);
    const threshSec = toFiniteNumber(stallContext.stalledThresholdSec ?? stallContext.thresholdSec);
    const silentPart = silentSec !== null
      ? (threshSec !== null ? `silent ${formatDurationCompact(silentSec)} / threshold ${formatDurationCompact(threshSec)}` : `silent ${formatDurationCompact(silentSec)}`)
      : "";
    stallLines.push(`- **Status**: ${sanitizeInline(sevLabel, 24)}${silentPart ? ` (${silentPart})` : ""}`);
    if (stallContext.phase) {
      const subPart = stallContext.subphase ? ` (${sanitizeInline(stallContext.subphase, 48)})` : "";
      const ctxTok = toFiniteNumber(stallContext.contextTokens);
      const ctxPart = ctxTok !== null && ctxTok > 0 ? ` · ${formatTokensK(ctxTok)} tok` : "";
      const modelPart = stallContext.model ? ` · \`${sanitizeInline(stallContext.model, 64)}\`` : "";
      stallLines.push(`- **Phase**: \`${sanitizeInline(stallContext.phase, 32)}\`${subPart}${ctxPart}${modelPart}`);
    }
    if (stallContext.causeLabel || stallContext.causeId) {
      const cLabel = sanitizeInline(stallContext.causeLabel || stallContext.causeId, 120);
      const cIdPart = stallContext.causeId && stallContext.causeLabel ? ` (\`${sanitizeInline(stallContext.causeId, 48)}\`)` : "";
      stallLines.push(`- **Suspected Cause**: ${cLabel}${cIdPart}`);
    }
    const toolName = stallContext.activeTool || stallContext.lastCompletedTool || "";
    const toolSummary = stallContext.activeToolSummary || "";
    if (toolName || toolSummary) {
      const toolLabel = toolName ? `\`${sanitizeInline(toolName, 64)}\`` : "`tool`";
      const sumPart = toolSummary ? ` — \`${sanitizeInline(toolSummary, 160)}\`` : "";
      stallLines.push(`- **Last Tool / Command**: ${toolLabel}${sumPart}`);
    }
    if (!isOverviewFull && stallContext.lastUserInput) {
      stallLines.push(`- **Last User Input**: ${sanitizeInline(stallContext.lastUserInput, 220)}`);
    }
    if (Array.isArray(stallContext.tips) && stallContext.tips.length > 0) {
      const cleanTips = stallContext.tips
        .filter((tip) => typeof tip === "string" && tip.trim())
        .slice(0, 2)
        .map((tip, i) => `  ${i + 1}. ${sanitizeInline(tip, 220)}`);
      if (cleanTips.length > 0) {
        stallLines.push(`- **Troubleshooting**:\n${cleanTips.join("\n")}`);
      }
    }
    if (stallLines.length > 0) {
      sections.push(`## Stall Rescue Snapshot\n${stallLines.join("\n")}`);
      summaryParts.unshift(`stall=${sanitizeInline(String(stallContext.severity || "stalled").toLowerCase(), 16)}`);
    }
  }

  // 1c. Optional Safety Monitor Advisory (only when alerting)
  if (isAlertingSafetyContext(safetyContext)) {
    const safetyLines = buildSafetyAdvisoryLines(safetyContext);
    if (safetyLines.length > 0) {
      sections.push(`## Safety Monitor Advisory\n${safetyLines.join("\n")}`);
      summaryParts.push(`safety=${sanitizeInline(String(safetyContext.status || "alert"), 24)}`);
    }
  }

  // 2. Bounded git diff --stat
  if (gitInfo.isGit && gitInfo.diffStat) {
    sections.push(`## Git Diff Stat\n\`\`\`text\n${gitInfo.diffStat}\n\`\`\``);
  }

  // 3. Structured session checkpoint (modified files, last test, last build)
  const cpLines = [];
  if (modifiedFiles.length > 0) {
    const shown = modifiedFiles.slice(0, 12).map((f) => `\`${sanitizeInline(f, 160)}\``);
    const extra = modifiedFileCount > shown.length ? ` (+${modifiedFileCount - shown.length} more)` : "";
    cpLines.push(`- **Modified Files (${modifiedFileCount})**: ${shown.join(", ")}${extra}`);
    summaryParts.push(`${modifiedFileCount} modified`);
  }
  const testLine = formatVerificationLine("Last Test", lastTest, { allowRawSummary: !isOverviewFull });
  if (testLine) {
    cpLines.push(testLine);
    summaryParts.push(`test=${lastTest.ok ? "PASS" : "FAIL"}`);
  }
  const buildLine = formatVerificationLine("Last Build", lastBuild, { allowRawSummary: !isOverviewFull });
  if (buildLine) {
    cpLines.push(buildLine);
    summaryParts.push(`build=${lastBuild.ok ? "PASS" : "FAIL"}`);
  }
  if (cpLines.length > 0) {
    sections.push(`## Session Checkpoint\n${cpLines.join("\n")}`);
  }

  // 4. Recent indexed FTS5 handles
  if (recentSources.length > 0) {
    const srcLines = recentSources.map((src) => {
      const id = sanitizeInline(src?.id ?? src?.sourceId ?? "", 80);
      const label = sanitizeInline(src?.label || "untitled", 160);
      const sz = formatBytesCompact(src?.bytes_total ?? src?.bytesTotal ?? 0);
      const chunks = Number(src?.chunk_count ?? src?.chunkCount ?? 0);
      const chunkNote = chunks > 0 ? `, ${chunks} ${chunks === 1 ? "chunk" : "chunks"}` : "";
      return `- \`${id}\` — ${label} (${sz}${chunkNote})`;
    });
    sections.push(`## Indexed FTS5 Handles\n${srcLines.join("\n")}`);
    summaryParts.push(`${recentSources.length} FTS5 ${recentSources.length === 1 ? "source" : "sources"}`);
  }

  // 5. Live KV-cache snapshot
  if (hasCacheSnapshot(cacheDiag)) {
    const kvLines = [];
    const model = sanitizeInline(cacheDiag.currentModel || cacheDiag.modelProfile?.id || "", 96);
    const ctxTok = Number(cacheDiag.currentContextTokens || 0);
    const winTok = Number(cacheDiag.modelProfile?.windowTokens || 0);
    const temp = sanitizeInline(cacheDiag.cacheTemperature || "cold", 32);
    const advice = sanitizeInline(cacheDiag.compactAdvice || "none", 48);
    const hitRate = toFiniteNumber(cacheDiag.weightedHitRate);
    const savedUsd = formatUsdCompact(cacheDiag.estimatedSavedUsd);

    const row1 = [];
    if (model) row1.push(`**Model**: \`${model}\``);
    if (ctxTok > 0) {
      const ctxStr = winTok > 0
        ? `${formatTokensK(ctxTok)} / ${formatTokensK(winTok)} (${Math.round((ctxTok / winTok) * 100)}%)`
        : `${formatTokensK(ctxTok)} tok`;
      row1.push(`**Context**: ${ctxStr}`);
    }
    if (row1.length > 0) kvLines.push(`- ${row1.join(" | ")}`);

    const row2 = [];
    if (temp) row2.push(`**Cache**: ${temp.toUpperCase()}`);
    if (hitRate !== null) row2.push(`**Hit Rate**: ${(hitRate * 100).toFixed(1)}%`);
    if (advice) row2.push(`**Advice**: \`${advice}\``);
    if (savedUsd !== null) {
      row2.push(`**Est. Saved**: ${savedUsd}`);
    }
    if (cacheDiag.ttlStatus && cacheDiag.ttlStatus !== "cold") {
      const ttlRem = toFiniteNumber(cacheDiag.ttlRemainingSec);
      const ttlDetail =
        cacheDiag.ttlStatus === "expired"
          ? "expired"
          : ttlRem !== null
            ? `${formatDurationCompact(ttlRem)} left`
            : cacheDiag.ttlStatus;
      row2.push(`**TTL**: ${ttlDetail}`);
    }
    if (row2.length > 0) kvLines.push(`- ${row2.join(" | ")}`);

    if (kvLines.length > 0) {
      sections.push(`## KV-Cache Snapshot\n${kvLines.join("\n")}`);
      const ctxPart = ctxTok > 0 ? `ctx=${formatTokensK(ctxTok)}` : "";
      const tempPart = temp ? temp : "";
      if (ctxPart || tempPart) {
        summaryParts.push([ctxPart, tempPart ? `(${tempPart})` : ""].filter(Boolean).join(" "));
      }
    }
  }

  // 6. Actionable next step
  const nextStepSection = `## Next Step\n${NEXT_STEP_LINE}`;

  const rawBody = sections.join("\n\n");
  const redactedBody = redactSecrets(rawBody).text;
  const fullMarkdown = `${redactedBody}\n\n${nextStepSection}`;

  let markdown = fullMarkdown;
  let truncated = false;

  if (Buffer.byteLength(fullMarkdown, "utf8") > budget) {
    truncated = true;
    const footerBlock = `\n\n... [truncated to <=${budget} B]\n\n${nextStepSection}`;
    const footerBytes = Buffer.byteLength(footerBlock, "utf8");

    if (budget > footerBytes + 32) {
      const bodyBudget = budget - footerBytes;
      let cutBody = truncateUtf8Safe(redactedBody, bodyBudget);
      // Prefer breaking cleanly on a newline if it preserves at least 60% of available body budget
      const lastNl = cutBody.lastIndexOf("\n");
      if (lastNl > 0 && Buffer.byteLength(cutBody.slice(0, lastNl), "utf8") >= Math.floor(bodyBudget * 0.6)) {
        cutBody = cutBody.slice(0, lastNl).trimEnd();
      }
      // Close an unclosed fenced code block if truncation happened mid-fence
      const fenceCount = (cutBody.match(/^```/gm) || []).length;
      if (fenceCount % 2 === 1) {
        const closeFence = "\n```";
        const closeBytes = Buffer.byteLength(closeFence, "utf8");
        if (Buffer.byteLength(cutBody, "utf8") + closeBytes <= bodyBudget) {
          cutBody += closeFence;
        } else {
          cutBody = `${truncateUtf8Safe(cutBody, Math.max(0, bodyBudget - closeBytes))}${closeFence}`;
        }
      }
      markdown = `${cutBody}${footerBlock}`;
    } else {
      // Extreme tiny maxBytes budget: hard UTF-8 safe cap
      markdown = truncateUtf8Safe(fullMarkdown, budget);
    }

    // Final hard invariant guard
    if (Buffer.byteLength(markdown, "utf8") > budget || hasUnclosedFence(markdown)) {
      markdown = ensureClosedFencesWithinBudget(markdown, budget);
    }
  }

  const bytes = Buffer.byteLength(markdown, "utf8");
  const rawSummary = summaryParts.length > 0 ? summaryParts.join(" | ") : `session=${sanitizeInline(sid, 48)}`;
  const summary = redactSecrets(rawSummary).text;

  return {
    markdown,
    summary,
    bytes,
    truncated
  };
}
