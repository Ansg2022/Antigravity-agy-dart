#!/usr/bin/env node
/**
 * agy-dart Stop hook (v1.4.0):
 * Lightweight (<5ms), fail-open lifecycle hook that marks the per-conversation
 * Sidecar Stall Watchdog lease (`watchdog_lease:<directConvId>`) as `IDLE`
 * when an agent turn completes cleanly.
 *
 * Strictly zero-prefix-pollution (emits `{"decision":"allow"}\n`, 0 bytes stderr)
 * and never creates a brand-new SQLite DB when none exists.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { enableVersionedCompileCache } from "./compile-cache.mjs";
import { getConfigSnapshot, getEffectiveConfig } from "../context/lib/config.js";

const STOP_ALLOW_OUTPUT = '{"decision":"allow"}\n';

function readStdin(timeoutMs = 1000) {
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

function resolveSessionId(payload = {}) {
  return (
    payload.rootConversationId ||
    payload.root_conversation_id ||
    payload.common?.rootConversationId ||
    payload.common?.root_conversation_id ||
    payload.parentConversationId ||
    payload.parent_conversation_id ||
    payload.common?.parentConversationId ||
    payload.common?.parent_conversation_id ||
    payload.conversationId ||
    payload.conversation_id ||
    payload.common?.conversationId ||
    payload.common?.conversation_id ||
    payload.sessionId ||
    payload.session_id ||
    process.env.ANTIGRAVITY_ROOT_CONVERSATION_ID ||
    process.env.ANTIGRAVITY_PARENT_CONVERSATION_ID ||
    process.env.ANTIGRAVITY_CONVERSATION_ID ||
    "default"
  );
}

function resolveDirectConversationId(payload = {}) {
  return (
    payload.conversationId ||
    payload.conversation_id ||
    payload.common?.conversationId ||
    payload.common?.conversation_id ||
    payload.sessionId ||
    payload.session_id ||
    process.env.ANTIGRAVITY_CONVERSATION_ID ||
    "default"
  );
}

export async function handleStopPayload(payload = {}, options = {}) {
  const safePayload = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const safeOptions = options && typeof options === "object" && !Array.isArray(options) ? options : {};
  const effectiveCfg = safeOptions.effectiveCfg || getEffectiveConfig();
  const directConvId = resolveDirectConversationId(safePayload);
  if (!directConvId || directConvId === "default") {
    return { updated: false, reason: "no_conversation_id" };
  }
  const resolvedDbPath = safeOptions.dbPath || effectiveCfg.dbPath || path.join(os.homedir(), ".agy-dart", "context.db");
  if (!safeOptions.store && !fs.existsSync(resolvedDbPath)) {
    return { updated: false, reason: "no_db" };
  }

  let ownedStore = null;
  try {
    const {
      computeCausalTurnLlmFloorTs,
      detectSubagentFromTranscriptFile,
      inspectLatestTurnInSteps,
      isHeadlessWorkerPrompt,
      isKeepaliveTurnFlushedForRound,
      isSubagentLeasePayload,
      lookupConversationSummary,
      readWatchdogLease,
      readWatchdogTranscriptTail,
      recordHookLeaseTransition,
      resolveCandidateTranscriptPath,
      WATCHDOG_PHASES
    } = await import("../context/lib/watchdog-lease.js");
    let store = safeOptions.store || null;
    if (!store) {
      const { ContextModeStore } = await import("../context/lib/store.js");
      ownedStore = new ContextModeStore({
        dbPath: resolvedDbPath,
        hookMode: true,
        maxBusyRetries: 4,
        maxRetryDeadlineMs: 800
      });
      store = ownedStore;
    }
    const watchdogActive = Boolean(
      effectiveCfg.stallWatchdog &&
        (typeof store.isWatchdogEnabled !== "function" || store.isWatchdogEnabled())
    );
    const ttlNotifyActive = Boolean(
      typeof store.isTtlDesktopNotifyEnabled === "function"
        ? store.isTtlDesktopNotifyEnabled()
        : effectiveCfg.ttlDesktopNotify
    );
    const cfgSnap = safeOptions.cfgSnapshot || getConfigSnapshot();
    const sessionId = resolveSessionId(safePayload);
    const existing = readWatchdogLease(store, directConvId);
    const rawLastInput =
      typeof (safePayload.lastUserInput ?? safePayload.last_user_input ?? safePayload.common?.lastUserInput) === "string"
        ? String(safePayload.lastUserInput ?? safePayload.last_user_input ?? safePayload.common?.lastUserInput)
        : "";
    let detectedSubagent = Boolean(
      safeOptions.isSubagent ||
        existing?.isSubagent ||
        (sessionId && sessionId !== "default" && sessionId !== directConvId) ||
        isSubagentLeasePayload(safePayload) ||
        isHeadlessWorkerPrompt(rawLastInput)
    );
    let resolvedParentConvId = existing?.parentConversationId || "";
    let resolvedSummaryTitle = "";
    const allowDefaultSummaryDb =
      Boolean(process.env.AGY_DART_SUMMARY_DB_PATH) ||
      Boolean(safeOptions.summaryDbPath) ||
      cfgSnap.sources.dbPath === "default";
    let txPath =
      existing?.transcriptPath ||
      (typeof safePayload.transcriptPath === "string" && safePayload.transcriptPath.trim()) ||
      (typeof safePayload.transcript_path === "string" && safePayload.transcript_path.trim()) ||
      (typeof safePayload.common?.transcriptPath === "string" && safePayload.common.transcriptPath.trim()) ||
      (typeof safePayload.common?.transcript_path === "string" && safePayload.common.transcript_path.trim()) ||
      "";
    if (!txPath && !detectedSubagent && !existing?.convTitle) {
      txPath = resolveCandidateTranscriptPath(directConvId, {
        summaryDbPath: safeOptions.summaryDbPath || "",
        allowDefaultDb: allowDefaultSummaryDb
      });
    }
    if (!detectedSubagent && !existing?.convTitle) {
      if (allowDefaultSummaryDb || txPath) {
        try {
          const summary = lookupConversationSummary(directConvId, {
            payload: safePayload,
            transcriptPath: txPath,
            summaryDbPath: safeOptions.summaryDbPath || "",
            allowDefaultDb: allowDefaultSummaryDb,
            checkSubagent: true
          });
          if (summary.isSubagent) detectedSubagent = true;
          if (summary.parentConversationId && summary.parentConversationId !== directConvId) {
            resolvedParentConvId = summary.parentConversationId;
            detectedSubagent = true;
          }
          if (summary.title) resolvedSummaryTitle = summary.title;
        } catch {}
      }
      if (!detectedSubagent && !resolvedSummaryTitle && txPath) {
        try {
          if (detectSubagentFromTranscriptFile(txPath)) {
            detectedSubagent = true;
          }
        } catch {}
      }
    }
    let ttlKeepaliveExplicit = false;
    let convKaState = null;
    if (!detectedSubagent) {
      convKaState =
        typeof store.getTtlKeepaliveState === "function" ? store.getTtlKeepaliveState(directConvId) : null;
      if (cfgSnap.sources.ttlKeepalive === "env" && cfgSnap.values.ttlKeepalive === false) {
        ttlKeepaliveExplicit = false;
      } else {
        if (convKaState && typeof convKaState.enabled === "boolean") {
          ttlKeepaliveExplicit = convKaState.enabled;
        } else if (convKaState && typeof convKaState.maxCount === "number" && convKaState.maxCount >= 1) {
          ttlKeepaliveExplicit = true;
        } else if (cfgSnap.sources.ttlKeepaliveMaxCount === "env") {
          ttlKeepaliveExplicit = Number(cfgSnap.values.ttlKeepaliveMaxCount) >= 1;
        } else if (cfgSnap.sources.ttlKeepalive === "env") {
          ttlKeepaliveExplicit = Boolean(cfgSnap.values.ttlKeepalive);
        } else if (
          typeof store.hasExplicitGlobalTtlKeepaliveMaxCount === "function" &&
          store.hasExplicitGlobalTtlKeepaliveMaxCount()
        ) {
          ttlKeepaliveExplicit = store.getGlobalTtlKeepaliveMaxCount() >= 1;
        } else if (
          cfgSnap.sources.ttlKeepalive !== "default" ||
          cfgSnap.sources.ttlKeepaliveMaxCount !== "default"
        ) {
          ttlKeepaliveExplicit =
            Boolean(cfgSnap.values.ttlKeepalive) && Number(cfgSnap.values.ttlKeepaliveMaxCount ?? 1) >= 1;
        }
      }
      if (!txPath && (convKaState?.inKeepaliveTurn || convKaState?.pendingAck)) {
        txPath = resolveCandidateTranscriptPath(directConvId, {
          summaryDbPath: safeOptions.summaryDbPath || "",
          allowDefaultDb: allowDefaultSummaryDb
        });
      }
    }
    const watermarkNotifyActive =
      effectiveCfg.watermarkDesktopNotify === true ||
      (effectiveCfg.watermarkDesktopNotify === null && ttlNotifyActive);
    const hasManualOrPendingKeepalive = Boolean(
      convKaState &&
        (convKaState.inKeepaliveTurn || convKaState.pendingAck || convKaState.pendingColdCheckId)
    );
    if (
      !watchdogActive &&
      !ttlNotifyActive &&
      !ttlKeepaliveExplicit &&
      !watermarkNotifyActive &&
      !hasManualOrPendingKeepalive
    ) {
      if (typeof store.markSessionWorkspaceIdle === "function") {
        try {
          const stopTs = Number.isFinite(safeOptions.nowMs) ? Math.floor(safeOptions.nowMs) : Date.now();
          store.markSessionWorkspaceIdle(directConvId, { nowMs: stopTs, source: "Stop" });
        } catch {}
      }
      if (!existing || existing.phase === WATCHDOG_PHASES.IDLE) {
        return { updated: false, reason: "disabled" };
      }
    }
    let stopModifiedPaths = [];
    if (
      existing?.cwd &&
      (!existing.workspaceLabel || !existing.workspaceLabel.includes("/")) &&
      typeof store.getSessionCheckpoint === "function"
    ) {
      try {
        const cp = store.getSessionCheckpoint(directConvId) || store.getSessionCheckpoint(sessionId);
        if (Array.isArray(cp?.modifiedFiles)) {
          stopModifiedPaths = cp.modifiedFiles
            .map((f) => (typeof f === "string" ? f : f?.path || ""))
            .filter(Boolean);
        }
      } catch {}
    }

    let stopCacheOriginTs = 0;
    let stopContextTokens = -1;
    let stopWindowTokens = 0;
    let stopModel = "";
    const nowStopMs = Number.isFinite(safeOptions.nowMs) ? Math.floor(safeOptions.nowMs) : Date.now();
    const pendingCheckToken =
      convKaState?.lastDispatchId ||
      (convKaState?.lastSentTs > 0 ? `ts:${convKaState.lastSentTs}:${convKaState.usedCount || 0}` : "");
    const expectedKaOwnership = convKaState
      ? {
          lastDispatchId: convKaState.lastDispatchId || "",
          lastDispatchMode: convKaState.lastDispatchMode || "",
          lastSentTs: convKaState.lastSentTs || 0,
          lastIdleAnchorTs: convKaState.lastIdleAnchorTs || 0,
          usedCount: convKaState.usedCount || 0,
          lastColdCheckUsed: convKaState.lastColdCheckUsed || 0,
          inKeepaliveTurn: Boolean(convKaState.inKeepaliveTurn),
          pendingAck: Boolean(convKaState.pendingAck),
          pendingColdCheckId: convKaState.pendingColdCheckId || "",
          lastColdCheckedId: convKaState.lastColdCheckedId || ""
        }
      : null;
    const writeKeepaliveStateIfOwned = (buildPatch, { requireInKeepaliveTurn = false } = {}) => {
      if (!expectedKaOwnership || typeof store.setTtlKeepaliveState !== "function") return false;
      const applyWrite = () => {
        const curKa =
          typeof store.getTtlKeepaliveState === "function"
            ? store.getTtlKeepaliveState(directConvId)
            : convKaState;
        if (
          !curKa ||
          (requireInKeepaliveTurn && !curKa.inKeepaliveTurn) ||
          (curKa.lastDispatchId || "") !== expectedKaOwnership.lastDispatchId ||
          (curKa.lastDispatchMode || "") !== expectedKaOwnership.lastDispatchMode ||
          (curKa.lastSentTs || 0) !== expectedKaOwnership.lastSentTs ||
          (curKa.lastIdleAnchorTs || 0) !== expectedKaOwnership.lastIdleAnchorTs ||
          (curKa.usedCount || 0) !== expectedKaOwnership.usedCount ||
          (curKa.lastColdCheckUsed || 0) !== expectedKaOwnership.lastColdCheckUsed ||
          Boolean(curKa.inKeepaliveTurn) !== expectedKaOwnership.inKeepaliveTurn ||
          Boolean(curKa.pendingAck) !== expectedKaOwnership.pendingAck ||
          (curKa.pendingColdCheckId || "") !== expectedKaOwnership.pendingColdCheckId ||
          (curKa.lastColdCheckedId || "") !== expectedKaOwnership.lastColdCheckedId
        ) {
          return false;
        }
        const patch = buildPatch(curKa);
        if (!patch || typeof patch !== "object") return false;
        store.setTtlKeepaliveState(directConvId, patch);
        return true;
      };
      if (typeof store._withWriteTx === "function") {
        if (typeof store.open === "function") store.open();
        return Boolean(store._withWriteTx(applyWrite));
      }
      return Boolean(applyWrite());
    };
    const markPendingColdCheckOnExit = () => {
      if (convKaState?.inKeepaliveTurn) {
        writeKeepaliveStateIfOwned(
          () => ({
            inKeepaliveTurn: false,
            ...(pendingCheckToken ? { pendingColdCheckId: pendingCheckToken } : {}),
            updatedTs: nowStopMs
          }),
          { requireInKeepaliveTurn: true }
        );
      }
    };
    if (!detectedSubagent && txPath) {
      try {
        const { steps: tailSteps, mtimeMs: tailMtimeMs } = readWatchdogTranscriptTail(txPath, 32768);
        if (tailSteps.length > 0) {
          const info = inspectLatestTurnInSteps(tailSteps);
          const turnFloorTs = existing?.startedTs > 0 ? existing.startedTs : 0;
          const causalLlmFloorTs = computeCausalTurnLlmFloorTs(existing, nowStopMs);
          const plannerInCurrentTurn = Boolean(
            info.hasPlanner &&
              !info.hasPromptAfterLastPlanner &&
              (info.prefillTs > 0
                ? (turnFloorTs === 0 || info.prefillTs >= turnFloorTs - 5_000) &&
                  info.prefillTs <= nowStopMs + 5_000 &&
                  nowStopMs - info.prefillTs <= 30 * 60 * 1000
                : turnFloorTs === 0 || tailMtimeMs >= turnFloorTs - 2_000)
          );
          const finalPlannerFlushedForTurn = Boolean(
            plannerInCurrentTurn &&
              !info.hasToolContinuationAfterLastPlanner &&
              (info.prefillTs <= 0 || causalLlmFloorTs === 0 || info.prefillTs >= causalLlmFloorTs - 5_000)
          );
          if (plannerInCurrentTurn) {
            if (info.contextTokens > 0) stopContextTokens = info.contextTokens;
            if (info.maxTokens > 0) stopWindowTokens = info.maxTokens;
            if (info.model) stopModel = info.model;
          }
          if (finalPlannerFlushedForTurn && info.prefillTs > 0) {
            stopCacheOriginTs = info.prefillTs;
          }
          const hasUncheckedKeepaliveDispatch = Boolean(
            convKaState &&
              (convKaState.inKeepaliveTurn ||
                convKaState.pendingAck ||
                (convKaState.lastDispatchId && convKaState.lastDispatchId !== convKaState.lastColdCheckedId) ||
                (convKaState.usedCount > 0 && (convKaState.lastColdCheckUsed || 0) < convKaState.usedCount))
          );
          const wasKeepaliveTurn = Boolean(
            convKaState?.inKeepaliveTurn ||
              (finalPlannerFlushedForTurn && info.precededByKeepalivePrompt && hasUncheckedKeepaliveDispatch)
          );
          if (wasKeepaliveTurn && convKaState && typeof store.setTtlKeepaliveState === "function") {
            const matchesCurrentRound =
              finalPlannerFlushedForTurn && isKeepaliveTurnFlushedForRound(info, convKaState);
            if (matchesCurrentRound && info.cacheReadReported === true) {
              const isColdMiss = info.cacheReadTokens === 0;
              writeKeepaliveStateIfOwned((curKa) => ({
                inKeepaliveTurn: false,
                pendingAck: false,
                pendingColdCheckId: "",
                ...(pendingCheckToken ? { lastColdCheckedId: pendingCheckToken } : {}),
                lastColdCheckUsed: Math.max(curKa.usedCount || 0, curKa.lastColdCheckUsed || 0),
                ...(curKa.coldMissTripped || isColdMiss ? { coldMissTripped: true } : {}),
                updatedTs: nowStopMs
              }));
            } else {
              markPendingColdCheckOnExit();
            }
          }
        } else {
          markPendingColdCheckOnExit();
        }
      } catch {
        try {
          markPendingColdCheckOnExit();
        } catch {}
      }
    } else if (!detectedSubagent) {
      try {
        markPendingColdCheckOnExit();
      } catch {}
    }

    const stopLeaseOptions = {
      directConvId,
      rootSessionId:
        sessionId && sessionId !== directConvId
          ? sessionId
          : resolvedParentConvId || sessionId,
      parentConversationId: resolvedParentConvId,
      isSubagent: detectedSubagent,
      cwd: safePayload.cwd || safePayload.common?.cwd || "",
      ...(Number.isFinite(safeOptions.nowMs) ? { nowMs: safeOptions.nowMs } : {}),
      ...(txPath && !existing?.transcriptPath ? { transcriptPath: txPath } : {}),
      ...(resolvedSummaryTitle ? { convTitle: resolvedSummaryTitle } : {}),
      ...(stopModifiedPaths.length > 0 ? { modifiedOrReadPaths: stopModifiedPaths } : {}),
      ...(stopCacheOriginTs > 0 ? { cacheOriginTs: stopCacheOriginTs } : {}),
      ...(stopContextTokens > 0 ? { contextTokens: stopContextTokens } : {}),
      ...(stopWindowTokens > 0 ? { windowTokens: stopWindowTokens } : {}),
      ...(stopModel ? { model: stopModel } : {}),
      ...(safeOptions.stopReason !== undefined ? { stopReason: safeOptions.stopReason } : {}),
      ...(safeOptions.fullyIdle !== undefined ? { fullyIdle: safeOptions.fullyIdle } : {}),
      ...(safeOptions.error !== undefined ? { error: safeOptions.error } : {})
    };
    const commitStopLease = () => {
      const curLease = readWatchdogLease(store, directConvId);
      if (existing && !curLease) {
        return { skipped: true, reason: "lease_deleted", lease: null };
      }
      if (!existing && curLease) {
        return { skipped: true, reason: "superseded_by_newer_turn", lease: curLease };
      }
      if (existing && curLease) {
        const supersededByNewerTurn = Boolean(
          (curLease.startedTs || 0) !== (existing.startedTs || 0) ||
            (existing.phase !== WATCHDOG_PHASES.IDLE && curLease.phase === WATCHDOG_PHASES.IDLE) ||
            (existing.phase !== WATCHDOG_PHASES.IDLE &&
              Boolean(existing.lastUserInput) &&
              Boolean(curLease.lastUserInput) &&
              curLease.lastUserInput !== existing.lastUserInput) ||
            (curLease.phase === WATCHDOG_PHASES.IDLE &&
              (curLease.idleAnchorTs || 0) > (existing.idleAnchorTs || 0)) ||
            (existing.phase === WATCHDOG_PHASES.IDLE &&
              (curLease.phase !== WATCHDOG_PHASES.IDLE ||
                (curLease.subphase || "") !== (existing.subphase || "") ||
                (curLease.stopReason || "") !== (existing.stopReason || "") ||
                (curLease.idleAnchorTs || 0) !== (existing.idleAnchorTs || 0) ||
                (curLease.updatedTs || 0) !== (existing.updatedTs || 0) ||
                (curLease.phaseChangedTs || 0) !== (existing.phaseChangedTs || 0) ||
                (curLease.hookEvent || "") !== (existing.hookEvent || "")))
        );
        if (supersededByNewerTurn) {
          return { skipped: true, reason: "superseded_by_newer_turn", lease: curLease };
        }
      }
      return { skipped: false, lease: recordHookLeaseTransition(store, "Stop", safePayload, stopLeaseOptions) };
    };
    const leaseCommit =
      typeof store._withWriteTx === "function"
        ? (typeof store.open === "function" ? store.open() : undefined, store._withWriteTx(commitStopLease))
        : commitStopLease();
    if (leaseCommit.skipped) {
      return { updated: false, reason: leaseCommit.reason || "superseded_by_newer_turn", lease: leaseCommit.lease };
    }
    if (typeof store.markSessionWorkspaceIdle === "function") {
      try {
        store.markSessionWorkspaceIdle(directConvId, { nowMs: nowStopMs, source: "Stop" });
      } catch {}
    }
    return { updated: Boolean(leaseCommit.lease), lease: leaseCommit.lease };
  } catch {
    return { updated: false, reason: "fail_open" };
  } finally {
    if (ownedStore) {
      try {
        ownedStore.close();
      } catch {}
    }
  }
}

async function main() {
  enableVersionedCompileCache();
  const cfgSnapshot = getConfigSnapshot();
  const effectiveCfg = cfgSnapshot.values;
  const resolvedDbPath = effectiveCfg.dbPath || path.join(os.homedir(), ".agy-dart", "context.db");
  if (!fs.existsSync(resolvedDbPath)) {
    process.stdout.write(STOP_ALLOW_OUTPUT);
    return;
  }

  const raw = (await readStdin()).trim();
  if (!raw) {
    process.stdout.write(STOP_ALLOW_OUTPUT);
    return;
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.stdout.write(STOP_ALLOW_OUTPUT);
    return;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    process.stdout.write(STOP_ALLOW_OUTPUT);
    return;
  }

  await handleStopPayload(payload, { effectiveCfg, cfgSnapshot });
  process.stdout.write(STOP_ALLOW_OUTPUT);
}

const __selfPath = path.resolve(fileURLToPath(import.meta.url));
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
    process.stdout.write(STOP_ALLOW_OUTPUT);
  });
}
