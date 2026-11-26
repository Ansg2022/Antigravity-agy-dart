import { createHash } from "node:crypto";

export const CONTEXT_RECEIPT_TOOLS = new Set(["ctx_execute", "ctx_index", "ctx_batch"]);
export const FAST_SAVINGS_TOOLS = new Set(["read_slices", "run_checks", "batch_search"]);

const TIMESTAMP_HEADER_BLOCK_RE = /^(?:(?:Created At|Completed At):[^\r\n]*\r?\n)+/;
const FAST_FINGERPRINT_PREFIX_CHARS = 2048;

function stripHostNamespace(name) {
  if (typeof name !== "string") return "";
  const trimmed = name.trim();
  const colonIdx = trimmed.lastIndexOf(":");
  return colonIdx >= 0 ? trimmed.slice(colonIdx + 1) : trimmed;
}

function unquoteScalar(val) {
  if (typeof val !== "string") return "";
  const trimmed = val.trim();
  if (trimmed.length >= 2 && trimmed[0] === '"' && trimmed[trimmed.length - 1] === '"') {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

const CONTEXT_RECEIPT_TOOL_RE = /^(?:mcp_+agy[-_]dart_context_+)?(ctx_execute|ctx_index|ctx_batch)$/;
const FAST_SAVINGS_TOOL_RE = /^(?:mcp_+agy[-_]dart_fast_+)?(read_slices|run_checks|batch_search)$/;

// Antigravity can JSON-quote individual wrapper arguments in a transcript.
export function isContextExecution(call) {
  const bare = stripHostNamespace(call?.name || "");
  if (CONTEXT_RECEIPT_TOOL_RE.test(bare)) {
    return true;
  }
  if (bare !== "call_mcp_tool") return false;
  const args = call.args || {};
  const server = unquoteScalar(args.ServerName ?? args.serverName);
  const tool = unquoteScalar(args.ToolName ?? args.toolName);
  return (server === "agy-dart_context" || server === "agy_dart_context") && CONTEXT_RECEIPT_TOOLS.has(tool);
}

export function extractFastSavingsToolName(call) {
  const bare = stripHostNamespace(call?.name || "");
  const directMatch = FAST_SAVINGS_TOOL_RE.exec(bare);
  if (directMatch) return directMatch[1];
  if (bare !== "call_mcp_tool") return null;
  const args = call.args || {};
  const server = unquoteScalar(args.ServerName ?? args.serverName);
  const tool = unquoteScalar(args.ToolName ?? args.toolName);
  if ((server === "agy-dart_fast" || server === "agy_dart_fast") && FAST_SAVINGS_TOOLS.has(tool)) {
    return tool;
  }
  return null;
}

export function stripTranscriptTimestamps(text) {
  if (typeof text !== "string") return "";
  return text.replace(TIMESTAMP_HEADER_BLOCK_RE, "");
}

export function extractTimestampWindowMs(text) {
  if (typeof text !== "string") return { createdAtMs: null, completedAtMs: null };
  const headerMatch = TIMESTAMP_HEADER_BLOCK_RE.exec(text);
  if (!headerMatch) return { createdAtMs: null, completedAtMs: null };
  let minCreated = null;
  let maxCompleted = null;
  let maxCreated = null;
  for (const line of headerMatch[0].split(/\r?\n/)) {
    const m = /^(Completed At|Created At):\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    const ms = Date.parse(m[2].trim());
    if (!Number.isFinite(ms)) continue;
    if (m[1] === "Completed At") {
      if (maxCompleted === null || ms > maxCompleted) maxCompleted = ms;
    } else {
      if (minCreated === null || ms < minCreated) minCreated = ms;
      if (maxCreated === null || ms > maxCreated) maxCreated = ms;
    }
  }
  return {
    createdAtMs: minCreated,
    completedAtMs: maxCompleted ?? maxCreated
  };
}

export function extractCompletedAtMs(text) {
  return extractTimestampWindowMs(text).completedAtMs;
}

export function fastToolFingerprint(toolName, text) {
  const bare = stripHostNamespace(toolName || "");
  const m = FAST_SAVINGS_TOOL_RE.exec(bare);
  const canonical = m ? m[1] : "";
  if (!canonical || typeof text !== "string" || !text) return null;
  const body = stripTranscriptTimestamps(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const prefix = body.slice(0, FAST_FINGERPRINT_PREFIX_CHARS).trimEnd();
  if (!prefix) return null;
  return "fast:" + createHash("sha256").update(`${canonical}\0${prefix}`, "utf8").digest("hex").slice(0, 32);
}

// Put the receipt first in the result so even the host's truncated transcript retains it.
// Match the outer result only. A receipt quoted inside stdout is unrelated.
export function executionReceiptFromText(text) {
  if (typeof text !== "string") return null;
  return /^(?:(?:Created At|Completed At):[^\r\n]*\r?\n)*\s*\{\s*"executionReceipt"\s*:\s*"([0-9a-f]{32})"\s*,/.exec(text)?.[1] ?? null;
}

export function executionReceiptsFromSteps(steps) {
  const expected = new Set();
  const receipts = [];
  if (!Array.isArray(steps)) return receipts;
  for (const step of steps) {
    const index = step?.step_index ?? step?.stepIndex;
    if (!Number.isSafeInteger(index)) continue;
    if (step.type === "PLANNER_RESPONSE") {
      expected.clear();
      if (Array.isArray(step.tool_calls)) {
        step.tool_calls.forEach((call, offset) => {
          if (isContextExecution(call)) expected.add(index + offset + 1);
        });
      }
    } else if (step.type === "GENERIC" && expected.delete(index)) {
      const receipt = executionReceiptFromText(step.content);
      if (receipt) receipts.push(receipt);
    }
  }
  return receipts;
}

export function fastToolClaimsFromSteps(steps) {
  const expected = new Map();
  const claims = [];
  if (!Array.isArray(steps)) return claims;
  for (const step of steps) {
    const index = step?.step_index ?? step?.stepIndex;
    if (!Number.isSafeInteger(index)) continue;
    if (step.type === "PLANNER_RESPONSE") {
      expected.clear();
      if (Array.isArray(step.tool_calls)) {
        step.tool_calls.forEach((call, offset) => {
          const fastTool = extractFastSavingsToolName(call);
          if (fastTool) expected.set(index + offset + 1, fastTool);
        });
      }
    } else if (step.type === "GENERIC" && expected.has(index)) {
      const fastTool = expected.get(index);
      expected.delete(index);
      const fingerprint = fastToolFingerprint(fastTool, step.content);
      if (!fingerprint) continue;
      const { createdAtMs: headerCreatedMs, completedAtMs: headerCompletedMs } = extractTimestampWindowMs(step.content);
      const stepMs = typeof step.created_at === "string" ? Date.parse(step.created_at) : NaN;
      const fallbackMs = Number.isFinite(stepMs) ? stepMs : null;
      const createdAtMs = headerCreatedMs ?? fallbackMs;
      const completedAtMs = headerCompletedMs ?? fallbackMs;
      claims.push({
        tool: fastTool,
        fingerprint,
        stepIndex: index,
        createdAtMs,
        completedAtMs
      });
    }
  }
  return claims;
}
