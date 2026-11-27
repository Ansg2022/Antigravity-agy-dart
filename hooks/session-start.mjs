#!/usr/bin/env node
/**
 * agy-dart unified SessionStart hook:
 * - Resets transient session overrides & runs lightweight daily DB TTL maintenance
 * - Produces a strictly deterministic, KV-cache prefix-stable systemMessage:
 *   1. Stable workspace context header
 *   2. Semi-static workspace structure + git-HEAD-cached import hotspot hubs
 *   3. Volatile git branch / working-tree status last
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { enableVersionedCompileCache } from "./compile-cache.mjs";
import { getEffectiveConfig } from "../context/lib/config.js";
import { buildWorkspaceSnapshot } from "../fast/session-start.mjs";

const __selfPath = path.resolve(fileURLToPath(import.meta.url));

export const STATIC_COOP_NOTE = "agy-dart active: workspace context";

function readStdin(timeoutMs = 1500) {
  return new Promise((resolve) => {
    let data = "";
    let settled = false;
    const onData = (chunk) => {
      data += chunk;
    };
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.off("data", onData);
      process.stdin.off("end", done);
      process.stdin.off("error", done);
      try {
        process.stdin.pause();
        process.stdin.unref?.();
      } catch {}
      resolve(data);
    };
    const timer = setTimeout(done, timeoutMs);
    timer.unref();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}

function parseHookPayload(rawInput) {
  if (!rawInput) return null;
  if (typeof rawInput === "object") return rawInput;
  try {
    const parsed = JSON.parse(rawInput);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function nonEmptyString(val) {
  return typeof val === "string" && val.trim().length > 0 ? val.trim() : "";
}

const SUBAGENT_ROLE_RE =
  /(?:^|[-_\s/])(?:sub[-_]?agent|worker|research(?:er)?|verifier|review(?:er)?|explor(?:er|e)|audit(?:or)?|investigat(?:or)?|browser|image[-_]?generator)(?:$|[-_\s/])|^(?:DeepCoder|DeepInvestigator)[A-Za-z0-9_-]*$/i;
const PRIMARY_HOST_AGENT_NAME_RE = /^(?:antigravity|main|default|primary|chat|user|assistant|cascade)$/i;

/**
 * Detect whether a SessionStart hook payload / environment belongs to a subagent or swarm worker.
 */
export function isSubagentPayload(payload, env = process.env) {
  const e = env && typeof env === "object" ? env : {};
  if (nonEmptyString(e.ANTIGRAVITY_PARENT_CONVERSATION_ID)) return true;
  const envSubagent = nonEmptyString(e.ANTIGRAVITY_SUBAGENT).toLowerCase();
  if (envSubagent === "1" || envSubagent === "true") return true;

  const p = parseHookPayload(payload);
  if (!p) return false;
  const common = p.common && typeof p.common === "object" && !Array.isArray(p.common) ? p.common : null;
  const meta = p.metadata && typeof p.metadata === "object" && !Array.isArray(p.metadata) ? p.metadata : null;

  for (const bag of [p, common, meta]) {
    if (!bag) continue;
    if (bag.subagent === true || bag.isSubagent === true || bag.is_subagent === true) return true;
    if (nonEmptyString(bag.subagentId) || nonEmptyString(bag.subagent_id)) return true;
    const spec = bag.subagentSpec ?? bag.subagent_spec ?? null;
    if (spec && typeof spec === "object" && !Array.isArray(spec) && Object.keys(spec).length > 0) return true;
    const depth = Number(bag.nestingDepth ?? bag.nesting_depth);
    if (Number.isFinite(depth) && depth > 0) return true;
    if (
      nonEmptyString(bag.parentConversationId) ||
      nonEmptyString(bag.parent_conversation_id) ||
      nonEmptyString(bag.parentSessionId) ||
      nonEmptyString(bag.parent_session_id)
    ) {
      return true;
    }
  }

  const isBattle = Boolean(
    p.isBattleMode || p.is_battle_mode || common?.isBattleMode || common?.is_battle_mode || meta?.isBattleModeFork
  );
  const rootId =
    nonEmptyString(p.rootConversationId) ||
    nonEmptyString(p.root_conversation_id) ||
    nonEmptyString(common?.rootConversationId) ||
    nonEmptyString(common?.root_conversation_id) ||
    nonEmptyString(meta?.rootConversationId) ||
    nonEmptyString(meta?.root_conversation_id) ||
    nonEmptyString(e.ANTIGRAVITY_ROOT_CONVERSATION_ID);
  const convId =
    nonEmptyString(p.conversationId) ||
    nonEmptyString(p.conversation_id) ||
    nonEmptyString(common?.conversationId) ||
    nonEmptyString(common?.conversation_id) ||
    nonEmptyString(p.sessionId) ||
    nonEmptyString(p.session_id) ||
    nonEmptyString(e.ANTIGRAVITY_CONVERSATION_ID);
  if (!isBattle && rootId && convId && rootId !== convId) {
    return true;
  }

  const roleCandidates = [
    p.role,
    p.agentRole,
    p.agent_role,
    p.agentType,
    p.agent_type,
    p.agentName,
    p.agent_name,
    p.sessionType,
    p.session_type,
    p.sessionKind,
    p.session_kind,
    common?.agentName,
    common?.agent_name,
    common?.role,
    meta?.role,
    meta?.agentRole,
    meta?.agent_role,
    meta?.agentType,
    meta?.agent_type,
    meta?.agentName,
    meta?.agent_name
  ];
  for (const candidate of roleCandidates) {
    const text = nonEmptyString(candidate);
    if (text && !PRIMARY_HOST_AGENT_NAME_RE.test(text) && (text.toLowerCase() === "self" || SUBAGENT_ROLE_RE.test(text))) {
      return true;
    }
  }

  return false;
}

function resolveWorkspaceDir(rawOrPayload) {
  const payload = parseHookPayload(rawOrPayload);
  if (!payload) return "";
  if (typeof payload.cwd === "string" && payload.cwd.trim()) return payload.cwd.trim();
  const lists = [payload.workspacePaths, payload.workspace_paths, payload.workspaceRoots, payload.workspace_roots];
  for (const list of lists) {
    if (Array.isArray(list)) {
      for (const item of list) {
        const raw = typeof item === "string" ? item : item?.uri || item?.path || "";
        if (typeof raw === "string" && raw.trim()) return raw.trim();
      }
    }
  }
  return "";
}

function resolveSessionIds(rawOrPayload, env = process.env) {
  const p = parseHookPayload(rawOrPayload) || {};
  const common = p.common && typeof p.common === "object" && !Array.isArray(p.common) ? p.common : null;
  const meta = p.metadata && typeof p.metadata === "object" && !Array.isArray(p.metadata) ? p.metadata : null;
  const e = env && typeof env === "object" ? env : {};
  const convId =
    nonEmptyString(p.conversationId) ||
    nonEmptyString(p.conversation_id) ||
    nonEmptyString(common?.conversationId) ||
    nonEmptyString(common?.conversation_id) ||
    nonEmptyString(p.sessionId) ||
    nonEmptyString(p.session_id) ||
    nonEmptyString(e.ANTIGRAVITY_CONVERSATION_ID);
  const rootSessionId =
    nonEmptyString(p.rootConversationId) ||
    nonEmptyString(p.root_conversation_id) ||
    nonEmptyString(common?.rootConversationId) ||
    nonEmptyString(common?.root_conversation_id) ||
    nonEmptyString(meta?.rootConversationId) ||
    nonEmptyString(meta?.root_conversation_id) ||
    nonEmptyString(p.parentConversationId) ||
    nonEmptyString(p.parent_conversation_id) ||
    nonEmptyString(common?.parentConversationId) ||
    nonEmptyString(common?.parent_conversation_id) ||
    nonEmptyString(e.ANTIGRAVITY_ROOT_CONVERSATION_ID) ||
    nonEmptyString(e.ANTIGRAVITY_PARENT_CONVERSATION_ID) ||
    convId;
  return { convId, rootSessionId };
}

/**
 * Reorder workspace snapshot sections for maximum LLM KV-cache prefix stability:
 *   Static note -> Workspace header -> Project -> Layout -> Core hubs -> Volatile Git status.
 * When `options.omitVolatileGit === true`, all volatile Git lines are omitted so parent sessions,
 * new sessions, and concurrent subagents share a 100% byte-identical Turn-0 KV-cache prefix.
 */
export function assemblePrefixStableStartup(snapshotText, hotspotsLine = "", options = {}) {
  if (!snapshotText) {
    return hotspotsLine ? `${STATIC_COOP_NOTE}\n${hotspotsLine}` : "";
  }

  const omitVolatileGit = Boolean(options?.omitVolatileGit);
  const lines = snapshotText.replace(/\r\n/g, "\n").split("\n");
  const headerLines = [];
  const projectLines = [];
  const layoutLines = [];
  const gitLines = [];
  const otherLines = [];

  let section = "header";
  for (const line of lines) {
    if (line.startsWith("[agy-dart startup snapshot]") || line.startsWith("[agy-fast startup snapshot]")) {
      section = "header";
      headerLines.push(line);
    } else if (line.startsWith("Git:") || line.startsWith("Working tree:") || line.startsWith("Modified (") || line.startsWith("Recent commits:")) {
      section = "git";
      gitLines.push(line);
    } else if (line.startsWith("Project:")) {
      section = "project";
      projectLines.push(line);
    } else if (line.startsWith("Layout (")) {
      section = "layout";
      layoutLines.push(line);
    } else if (section === "git") {
      gitLines.push(line);
    } else if (section === "project") {
      projectLines.push(line);
    } else if (section === "layout") {
      layoutLines.push(line);
    } else if (section === "header" && headerLines.length === 0) {
      headerLines.push(line);
    } else {
      otherLines.push(line);
    }
  }

  const ordered = [
    STATIC_COOP_NOTE,
    ...headerLines,
    ...projectLines,
    ...layoutLines,
    ...(hotspotsLine ? [hotspotsLine] : []),
    ...otherLines,
    ...(omitVolatileGit ? [] : gitLines)
  ].filter((l) => l !== "");

  return ordered.join("\n");
}

async function main() {
  enableVersionedCompileCache();
  const rawInput = (await readStdin()).trim();
  const payload = parseHookPayload(rawInput);
  const workspaceDir = resolveWorkspaceDir(payload);
  const effectiveCfg = getEffectiveConfig();
  const isSubagent = isSubagentPayload(payload, process.env);
  const stablePrefixOnly =
    effectiveCfg.stablePrefixOnly === true ||
    (!effectiveCfg.subagentIncludeGit && isSubagent);

  // Run SQLite maintenance + repo hubs concurrently with in-process workspace snapshot
  // (0 extra Node child spawn, and 0 git.exe spawns when stablePrefixOnly / subagent is active)
  const [hotspotsLine, snapshotText] = await Promise.all([
    (async () => {
      let store = null;
      try {
        const [{ ContextModeStore }, { getCachedRepoHotspots }] = await Promise.all([
          import("../context/lib/store.js"),
          import("../context/lib/repo-skeleton.js")
        ]);
        store = new ContextModeStore({ hookMode: true });
        if (!isSubagent) {
          store.clearSessionOverrides();
          store.maybeRunDailyMaintenance(14);
        }
        const { convId, rootSessionId } = resolveSessionIds(payload, process.env);
        if (workspaceDir && convId && typeof store.recordSessionWorkspace === "function") {
          store.recordSessionWorkspace(convId, workspaceDir, {
            rootSessionId: rootSessionId || convId,
            active: true,
            source: "SessionStart"
          });
        }
        if (workspaceDir && effectiveCfg.repoHubs) {
          return getCachedRepoHotspots(workspaceDir, store, { maxFiles: 120, maxHubs: 5 }) || "";
        }
      } catch {
        // Non-blocking: never block session start on DB error
      } finally {
        if (store) {
          try {
            store.close();
          } catch {}
        }
      }
      return "";
    })(),
    (async () => {
      if (!rawInput || !workspaceDir) return "";
      try {
        return (
          (await buildWorkspaceSnapshot(workspaceDir, {
            maxChars: 800,
            topLevelOnly: true,
            gitTimeoutMs: 800,
            omitGit: stablePrefixOnly
          })) || ""
        );
      } catch {
        return "";
      }
    })()
  ]);

  const mergedText = assemblePrefixStableStartup(snapshotText, hotspotsLine, {
    omitVolatileGit: stablePrefixOnly
  });

  if (!mergedText) {
    process.stdout.write("{}\n");
    return;
  }
  const isBridge =
    payload?.hook_event_name === "SessionStart" ||
    process.env.AGY_DART_HOOK_PROTOCOL === "claude-code";
  if (isBridge) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: mergedText
        }
      }) + "\n"
    );
    return;
  }
  process.stdout.write(
    JSON.stringify({
      injectSteps: [
        {
          systemMessage: {
            systemMessage: mergedText
          }
        }
      ]
    }) + "\n"
  );
}

function isSameFilePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => {
    const resolved = path.resolve(p);
    let real = resolved;
    try {
      real = fs.realpathSync(resolved);
    } catch {}
    return process.platform === "win32" ? real.toLowerCase() : real;
  };
  return norm(a) === norm(b);
}
const isDirectRun = Boolean(process.argv[1] && isSameFilePath(process.argv[1], __selfPath));
if (isDirectRun) {
  main().catch(() => {
    process.stdout.write(JSON.stringify({}) + "\n");
  });
}
