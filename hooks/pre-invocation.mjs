#!/usr/bin/env node
/**
 * agy-dart PreInvocation hook:
 * Fast (<5ms) tail scan of transcript.jsonl for server-side KV-cache protection.
 * Uses Antigravity's zero-prefix-pollution UI-only `metadata.user_markdown`
 * (with empty `systemMessage: ""`) so alerts never mutate the model prompt prefix.
 * Inline `metadata.user_markdown` step emission is opt-in (`cacheWatchInlineAlerts`,
 * default `false`) to avoid Antigravity host `utils.ScrubInternalFields` panics on
 * `map<string, string>` metadata (upstream google-antigravity/antigravity-cli#1394 & #1845),
 * while keeping all non-banner bookkeeping (compaction invalidation, TTL calibration,
 * receipt claims, turn sequence, and Sidecar/desktop watchdog leases) active.
 */
import { executionReceiptsFromSteps, fastToolClaimsFromSteps } from "../context/lib/execution-receipts.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { enableVersionedCompileCache } from "./compile-cache.mjs";
import { getConfigSnapshot } from "../context/lib/config.js";

const CONTEXT_WARN_TOKENS = 130000;
const CONTEXT_CRITICAL_TOKENS = 160000;

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

function extractPreInvocationPayloadCwd(payload = {}) {
  if (!payload || typeof payload !== "object") return "";
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

function formatDuration(sec) {
  const sAll = Math.max(0, Math.round(Number(sec || 0)));
  if (sAll < 60) return `${sAll}s`;
  if (sAll >= 3600) {
    const h = Math.floor(sAll / 3600);
    const m = Math.floor((sAll % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const m = Math.floor(sAll / 60);
  const s = sAll % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function formatK(tokens) {
  return `${Math.round(tokens / 1000)}k`;
}

function formatUsdShort(usd) {
  const n = Number(usd);
  if (!Number.isFinite(n) || Math.abs(n) < 0.005) return "";
  return n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`;
}

function estimateColdReprefillHint(diag, isZh = false) {
  const pricePer1M = diag.inputPricePer1M ?? diag.modelProfile?.inputPer1M;
  const writeMult =
    Number.isFinite(diag.cacheWriteMultiplier) && diag.cacheWriteMultiplier >= 1
      ? diag.cacheWriteMultiplier
      : 1;
  const estColdUsd =
    Number.isFinite(pricePer1M) && pricePer1M > 0 && diag.currentContextTokens > 0
      ? (diag.currentContextTokens / 1e6) * pricePer1M * writeMult
      : 0;
  const coldUsdStr = formatUsdShort(estColdUsd);
  if (!coldUsdStr) return "";
  return isZh ? `（冷重算预计约 ${coldUsdStr}）` : ` (~${coldUsdStr} cold re-prefill)`;
}

function collectSessionSubprojectPaths(store, targetConvId, rootSessionId) {
  if (!store) return { worktree: "", paths: [] };
  let worktree = "";
  const modifiedPaths = [];
  const candidateSids = [targetConvId];
  if (rootSessionId && rootSessionId !== "default" && rootSessionId !== targetConvId) {
    candidateSids.push(rootSessionId);
  }
  try {
    if (typeof store.getSessionCheckpoint === "function") {
      for (const sid of candidateSids) {
        if (!sid || sid === "default") continue;
        const cp = store.getSessionCheckpoint(sid);
        if (cp) {
          if (!worktree && typeof cp.worktree === "string" && cp.worktree.trim()) {
            worktree = cp.worktree.trim();
          }
          if (Array.isArray(cp.modifiedFiles) && cp.modifiedFiles.length > 0) {
            for (const f of cp.modifiedFiles) {
              const p = typeof f === "string" ? f : f?.path;
              if (typeof p === "string" && p.trim()) modifiedPaths.push(p.trim());
            }
            if (modifiedPaths.length > 0) break;
          }
        }
      }
    }
  } catch {}
  if (modifiedPaths.length > 0) {
    return { worktree, paths: modifiedPaths };
  }

  const readPaths = [];
  try {
    if (store.db && targetConvId && targetConvId !== "default") {
      const rows = store.db
        .prepare("SELECT DISTINCT file_path FROM file_reads WHERE session_id = ? ORDER BY read_ts DESC LIMIT 12")
        .all(targetConvId);
      for (const r of rows || []) {
        if (r && typeof r.file_path === "string" && r.file_path.trim()) {
          readPaths.push(r.file_path.trim());
        }
      }
    }
  } catch {}
  return { worktree, paths: readPaths };
}

function formatChatWindowBadge(workspaceLabel = "", convTitle = "", isZh = false) {
  const safeWs = typeof workspaceLabel === "string" ? workspaceLabel.replace(/[`\r\n]/g, "").trim() : "";
  const safeTitle = typeof convTitle === "string" ? convTitle.replace(/[\r\n]/g, "").trim() : "";
  if (safeWs && safeTitle) {
    return isZh ? ` · **窗口 \`${safeWs}\`（${safeTitle}）**` : ` · **Window \`${safeWs}\` (${safeTitle})**`;
  }
  if (safeWs) {
    return isZh ? ` · **窗口 \`${safeWs}\`**` : ` · **Window \`${safeWs}\`**`;
  }
  if (safeTitle) {
    return isZh ? ` · **（${safeTitle}）**` : ` · **(${safeTitle})**`;
  }
  return "";
}

export function evaluateCacheAlerts(
  diag,
  { sessionId, store, invocationNum = null, lang = null, isBackgroundWakeup = false }
) {
  const alerts = [];
  if (!diag || diag.turnsWithUsage === 0) return alerts;
  const resolvedLang =
    lang === "zh" || lang === "en"
      ? lang
      : typeof store?.getUiLang === "function"
        ? store.getUiLang()
        : "en";
  const isZh = resolvedLang === "zh";

  const parsedInvNum =
    invocationNum !== undefined && invocationNum !== null && invocationNum !== "" && typeof invocationNum !== "boolean"
      ? Number(invocationNum)
      : NaN;
  const isMidTurnContinuation =
    Number.isFinite(parsedInvNum) && parsedInvNum >= 1 && diag.inToolLoop !== false;

  const wmKey = `cache_alert:${sessionId}:watermark`;
  const ttlKey = `cache_alert:${sessionId}:ttl_turn`;
  const ttlExpiringKey = `cache_alert:${sessionId}:ttl_expiring_turn`;
  const mediaKey = `cache_alert:${sessionId}:media`;
  const loopKey = `cache_alert:${sessionId}:loop`;
  const getAlertMeta = (k, def = "") =>
    typeof store.getTimedMeta === "function" ? store.getTimedMeta(k, def) : store.getMeta(k, def);
  const setAlertMeta = (k, v) =>
    typeof store.setTimedMeta === "function" ? store.setTimedMeta(k, v) : store.setMeta(k, v);

  const prevWm = getAlertMeta(wmKey, "");
  const effectiveWarn = diag.warnTokens || CONTEXT_WARN_TOKENS;
  const effectiveCrit = diag.criticalTokens || CONTEXT_CRITICAL_TOKENS;
  const winSource = diag.windowSource || diag.modelProfile?.windowSource;
  const winSourceTag = winSource === "transcript" || winSource === "explicit" ? ` [${winSource}]` : "";
  const pctUsed = diag.modelProfile?.windowTokens
    ? Math.round((diag.contextUtilization || diag.currentContextTokens / diag.modelProfile.windowTokens) * 100)
    : 0;
  const windowLabel = diag.modelProfile?.windowTokens
    ? isZh
      ? `，占 ${formatK(diag.modelProfile.windowTokens)} 窗口 ${pctUsed}%${winSourceTag}`
      : `, ${pctUsed}% of ${formatK(diag.modelProfile.windowTokens)}${winSourceTag}`
    : "";
  const savedUsdStr = diag.estimatedSavedUsd >= 0.01 ? formatUsdShort(diag.estimatedSavedUsd) : "";
  const wastedUsdStr = diag.estimatedWastedUsd >= 0.01 ? formatUsdShort(diag.estimatedWastedUsd) : "";
  const needsHandoffCue =
    diag.compactAdvice === "critical_compact" || diag.compactAdvice === "opportunistic_cold_compact";

  const checkStatus = diag.checkStatus && typeof diag.checkStatus === "object" ? diag.checkStatus : null;
  const latestCheck = checkStatus?.latestCheck || null;
  const latestRealFailure = checkStatus?.latestRealFailure || null;
  const unresolvedFailures = Array.isArray(checkStatus?.unresolvedFailures) ? checkStatus.unresolvedFailures : [];
  const latestIsTimeout = latestCheck?.outcome === "timeout";
  const hasActiveCheckFailure = Boolean(
    latestCheck?.outcome === "fail" ||
      unresolvedFailures.length > 0 ||
      (diag.loopWatch?.editFailOscillations || 0) >= 2
  );
  const suppressDelayHotCache = Boolean(latestIsTimeout || hasActiveCheckFailure);
  const timeoutKey = `cache_alert:${sessionId}:check_timeout`;
  let emittedCriticalWatermark = false;

  // 1. Context Watermark alert (fires once per threshold crossing: ok -> warn -> critical)
  if (diag.watermark === "critical" && prevWm !== "critical") {
    emittedCriticalWatermark = true;
    setAlertMeta(wmKey, "critical");
    const hitPct = (diag.weightedHitRate * 100).toFixed(0);
    if (isZh) {
      const wasteHint = wastedUsdStr ? `，重填浪费约 ${wastedUsdStr}` : "";
      const handoffHint = needsHandoffCue ? "先复制右侧面板「**交接简报**」，记下做到哪儿，再执行 `/compact`" : "建议在当前任务阶段收尾后执行 `/compact`";
      alerts.push(
        `这段对话快满了（当前 **${formatK(diag.currentContextTokens)} tokens**，告急水位 >= ${formatK(effectiveCrit)}${windowLabel}，缓存命中率 ${hitPct}%${wasteHint}）。${handoffHint}，随后调用 \`ctx_resume\`。`
      );
    } else {
      const wasteHint = wastedUsdStr ? `, ~${wastedUsdStr} wasted` : "";
      const handoffHint = needsHandoffCue ? "Copy Sidecar **Handoff Brief** first before `/compact`" : "Consider `/compact` at the next milestone";
      alerts.push(
        `This conversation is nearly full (**${formatK(diag.currentContextTokens)} tokens**, critical watermark >= ${formatK(effectiveCrit)}${windowLabel}, cache hit ${hitPct}%${wasteHint}). ${handoffHint}, then call \`ctx_resume\`.`
      );
    }
  } else if (diag.watermark === "warn" && prevWm !== "warn" && prevWm !== "critical") {
    if (diag.compactAdvice === "opportunistic_cold_compact" && (isMidTurnContinuation || isBackgroundWakeup)) {
      // Suppress cold-compact handoff banner during mid-turn tool execution loops or background subagent wakeups
    } else if (diag.compactAdvice === "delay_hot_cache" && suppressDelayHotCache) {
      // Never emit "delay /compact, keep going" alongside a failing or timed-out check even when hit rate is high
    } else {
      setAlertMeta(wmKey, "warn");
      const hitPct = (diag.weightedHitRate * 100).toFixed(0);
      if (diag.compactAdvice === "delay_hot_cache" && !suppressDelayHotCache) {
        const tempRaw = String(diag.cacheTemperature || "warm").toLowerCase();
        if (isZh) {
          const tempZh = tempRaw === "hot" ? "热缓存" : "温缓存";
          const savedHint = savedUsdStr ? `，已省约 ${savedUsdStr}` : "";
          alerts.push(
            `当前上下文已达 **${formatK(diag.currentContextTokens)} tokens**（**${tempZh}**，命中率 ${hitPct}%${savedHint}${windowLabel}）。缓存正热时建议**暂缓 \`/compact\`** 以免触发全量冷重算；请继续通过 \`agy-dart_fast\` / \`ctx_execute\` 控制单次工具输出体积。`
          );
        } else {
          const tempLabel = tempRaw.toUpperCase();
          const savedHint = savedUsdStr ? `, ~${savedUsdStr} saved` : "";
          alerts.push(
            `Context reached **${formatK(diag.currentContextTokens)} tokens** (cache **${tempLabel}**, hit ${hitPct}%${savedHint}${windowLabel}). **Delay \`/compact\`** while cache is hot to avoid re-prefill; keep tool outputs compact via \`agy-dart_fast\` / \`ctx_execute\`.`
          );
        }
      } else if (diag.compactAdvice === "opportunistic_cold_compact") {
        alerts.push(
          isZh
            ? `当前上下文已达 **${formatK(diag.currentContextTokens)} tokens**（偏高水位 >= ${formatK(effectiveWarn)}${windowLabel}，缓存已冷）。当前适合复制右侧面板「**交接简报**」后执行 \`/compact\`，再调用 \`ctx_resume\`。`
            : `Context reached **${formatK(diag.currentContextTokens)} tokens** (high watermark >= ${formatK(effectiveWarn)}${windowLabel}, cache cold). Good moment for Sidecar **Handoff Brief** + \`/compact\`, then \`ctx_resume\`.`
        );
      } else {
        alerts.push(
          isZh
            ? `当前上下文已达 **${formatK(diag.currentContextTokens)} tokens**（偏高水位 >= ${formatK(effectiveWarn)}${windowLabel}，缓存命中率 ${hitPct}%）。请继续通过 \`agy-dart_fast\` / \`ctx_execute\` 保持输出精简。`
            : `Context reached **${formatK(diag.currentContextTokens)} tokens** (high watermark >= ${formatK(effectiveWarn)}${windowLabel}, cache hit ${hitPct}%). Keep outputs compact via \`agy-dart_fast\` / \`ctx_execute\`.`
        );
      }
    }
  } else if (diag.watermark === "ok") {
    if (prevWm) {
      // Reset watermark state after compaction
      store.deleteMeta(wmKey);
    }
    const wmDesktopKey = `cache_alert:${sessionId}:wm_desktop`;
    if (getAlertMeta(wmDesktopKey, "")) {
      store.deleteMeta(wmDesktopKey);
    }
  }

  // 2. Idle Prompt-Cache TTL expiry & proactive expiring alerts (once per idle episode, human turn entry only)
  const ttlMinContext = Math.max(60000, diag.coldCompactTokens || 60000);
  if (!isMidTurnContinuation && !isBackgroundWakeup) {
    if (diag.ttlStatus === "expired" && diag.currentContextTokens >= ttlMinContext && diag.lastPlannerAt) {
      const lastAlertedTurn = getAlertMeta(ttlKey, "");
      if (lastAlertedTurn !== diag.lastPlannerAt) {
        setAlertMeta(ttlKey, diag.lastPlannerAt);
        const costHint = estimateColdReprefillHint(diag, isZh);
        if (isZh) {
          const ttlSourceZh =
            diag.ttlSource === "empirical"
              ? "实证校准 "
              : diag.ttlSource === "explicit"
                ? "自定义 "
                : "";
          const compactTailZh = needsHandoffCue
            ? "若准备压缩，建议先复制右侧面板「**交接简报**」再执行 `/compact`，随后调用 `ctx_resume`。"
            : "若准备切换任务，适合顺手执行 `/compact`。";
          alerts.push(
            `已空闲 **${formatDuration(diag.idleSeconds)}**（超过 ${ttlSourceZh}${formatDuration(diag.cacheTtlSec)} 缓存 TTL），当前上下文 **${formatK(diag.currentContextTokens)} tokens**${costHint}——下一轮将触发冷重填。${compactTailZh}`
          );
        } else {
          const ttlSourceTag =
            diag.ttlSource === "empirical"
              ? " calibrated"
              : diag.ttlSource === "explicit"
                ? " configured"
                : "";
          const compactTail = needsHandoffCue
            ? "Good moment to copy Sidecar **Handoff Brief** + `/compact`, then `ctx_resume`."
            : "Good moment to `/compact` if switching tasks.";
          alerts.push(
            `Idle **${formatDuration(diag.idleSeconds)}** (>${formatDuration(diag.cacheTtlSec)}${ttlSourceTag} KV-cache TTL) at **${formatK(diag.currentContextTokens)} tokens**${costHint} — next turn will re-prefill cold. ${compactTail}`
          );
        }
      }
    } else if (diag.ttlStatus === "expiring" && diag.currentContextTokens >= ttlMinContext && diag.lastPlannerAt) {
      const lastAlertedExpiring = getAlertMeta(ttlExpiringKey, "");
      if (lastAlertedExpiring !== diag.lastPlannerAt) {
        setAlertMeta(ttlExpiringKey, diag.lastPlannerAt);
        const remSec = Math.max(0, Math.round(Number(diag.ttlRemainingSec ?? 0)));
        const remLabel = remSec <= 60 ? `${remSec}s` : formatDuration(remSec);
        const costHint = estimateColdReprefillHint(diag, isZh);
        alerts.push(
          isZh
            ? `**${formatK(diag.currentContextTokens)} tokens** 热缓存将在 **${remLabel}** 后过期${costHint}——尽快发送下一句可续热，或在过期后复制右侧面板「**交接简报**」执行 \`/compact\`。`
            : `KV-cache expiring in **${remLabel}** at **${formatK(diag.currentContextTokens)} tokens**${costHint} — send your next turn soon to stay warm, or copy Sidecar **Handoff Brief** before \`/compact\`.`
        );
      }
    }
  }

  // 3. Multimodal high-context TTFT cliff warning (once per session)
  if (diag.totalMediaCount > 0 && diag.currentContextTokens >= 150000) {
    const alreadyAlerted = getAlertMeta(mediaKey, "");
    if (!alreadyAlerted) {
      setAlertMeta(mediaKey, "1");
      alerts.push(
        isZh
          ? `当前 **${formatK(diag.currentContextTokens)} tokens** 会话中包含 **${diag.totalMediaCount} 个图片/多模态附件**（首字延迟可能放大 3–7 倍）。建议将截图检查委派给纯文本子代理或执行 \`/compact\`。`
          : `${diag.totalMediaCount} media/image item(s) active in a **${formatK(diag.currentContextTokens)}-token** session (3–7x TTFT cliff risk). Delegate screenshot checks to a text-only subagent or \`/compact\`.`
      );
    }
  }

  // 4. Latest check timeout notice (aligned with dashboard guidance; never inflates oscillation)
  if (latestIsTimeout) {
    if (!emittedCriticalWatermark && diag.watermark !== "critical") {
      const timeoutStamp = `${latestCheck.stepIndex ?? ""}:${latestCheck.name || ""}:${latestCheck.at || ""}`;
      if (getAlertMeta(timeoutKey, "") !== timeoutStamp) {
        setAlertMeta(timeoutKey, timeoutStamp);
        if (isZh) {
          const priorHint = latestRealFailure?.name
            ? `（上一次未解决报错：\`${latestRealFailure.name}\`）`
            : "";
          alerts.push(`检查超时，结果还不知道。可以重跑这项检查。${priorHint}`);
        } else {
          const priorHint = latestRealFailure?.name
            ? ` (Previous unresolved failure: \`${latestRealFailure.name}\`)`
            : "";
          alerts.push(`Check timed out — outcome is still unknown. You can re-run this check.${priorHint}`);
        }
      }
    }
  } else if (getAlertMeta(timeoutKey, "")) {
    store.deleteMeta(timeoutKey);
  }

  // 5. Doom-loop / edit<->fail oscillation convergence alert (fires once per escalation level, resets on convergence)
  const lw = diag.loopWatch;
  if (lw && (lw.status === "warn" || lw.status === "critical")) {
    const suppressOscForTimeoutOrCritical =
      emittedCriticalWatermark ||
      diag.watermark === "critical" ||
      (latestIsTimeout && lw.reason === "edit_fail_oscillation");
    if (!suppressOscForTimeoutOrCritical) {
      const prevLoop = getAlertMeta(loopKey, "");
      const shouldEmit =
        (lw.status === "critical" && prevLoop !== "critical") ||
        (lw.status === "warn" && prevLoop !== "warn" && prevLoop !== "critical");
      if (shouldEmit) {
        setAlertMeta(loopKey, lw.status);
        const details = [];
        if (lw.editFailOscillations >= 2) {
          const hasFiles = Array.isArray(lw.oscillatingFiles) && lw.oscillatingFiles.length > 0;
          if (isZh) {
            const filesPartZh = hasFiles ? `（\`${lw.oscillatingFiles.join("`, `")}\`）` : "";
            const roundsZh = lw.editFailOscillations === 2 ? "两轮" : `${lw.editFailOscillations} 轮`;
            details.push(`这个文件${filesPartZh}改了${roundsZh}，检查都没过`);
          } else {
            const filesPart = hasFiles ? ` on \`${lw.oscillatingFiles.join("`, `")}\`` : "";
            details.push(`**${lw.editFailOscillations}x edit↔fail oscillation**${filesPart}`);
          }
        }
        const hasRepeat = lw.reason === "repeat_loop" || lw.reason === "repeat_and_oscillation";
        if (hasRepeat && lw.maxRepeatCount >= 3) {
          if (isZh) {
            const callPartZh = lw.topRepeatedCall ? `（\`${lw.topRepeatedCall}\` ×${lw.maxRepeatCount}）` : `（×${lw.maxRepeatCount}）`;
            details.push(`**${Math.round((lw.repeatRate || 0) * 100)}% 重复工具调用**${callPartZh}`);
          } else {
            const callPart = lw.topRepeatedCall ? ` (\`${lw.topRepeatedCall}\` ×${lw.maxRepeatCount})` : ` (×${lw.maxRepeatCount})`;
            details.push(`**${Math.round((lw.repeatRate || 0) * 100)}% tool repeat rate**${callPart}`);
          }
        }
        if (isZh) {
          const zhText =
            lw.editFailOscillations >= 2 && !hasRepeat
              ? `${details.join(" + ")}。先看最近一次报错。`
              : `死循环收敛监控（${lw.status.toUpperCase()}）：${details.join(" + ")}。先看最近一次报错，暂停重复打补丁。`;
          alerts.push(zhText);
        } else {
          alerts.push(
            `Convergence watch (${lw.status.toUpperCase()}): ${details.join(" + ")}. Inspect the latest error first before editing again.`
          );
        }
      }
    }
  } else if (lw && lw.status === "ok" && getAlertMeta(loopKey, "")) {
    store.deleteMeta(loopKey);
  }

  return alerts;
}

async function main() {
  const cfgSnapshot = getConfigSnapshot();
  const effectiveCfg = cfgSnapshot.values;
  const resolvedDbPath = effectiveCfg.dbPath || path.join(os.homedir(), ".agy-dart", "context.db");
  const watchdogExplicit = effectiveCfg.stallWatchdog && cfgSnapshot.sources.stallWatchdog !== "default";
  const ttlNotifyExplicit = effectiveCfg.ttlDesktopNotify && cfgSnapshot.sources.ttlDesktopNotify !== "default";
  const ttlKeepaliveCfgExplicit =
    !(cfgSnapshot.sources.ttlKeepalive === "env" && effectiveCfg.ttlKeepalive === false) &&
    (cfgSnapshot.sources.ttlKeepaliveMaxCount === "env"
      ? Number(effectiveCfg.ttlKeepaliveMaxCount) >= 1
      : cfgSnapshot.sources.ttlKeepalive === "env"
        ? Boolean(effectiveCfg.ttlKeepalive)
        : (cfgSnapshot.sources.ttlKeepalive !== "default" ||
            cfgSnapshot.sources.ttlKeepaliveMaxCount !== "default") &&
          Boolean(effectiveCfg.ttlKeepalive) &&
          Number(effectiveCfg.ttlKeepaliveMaxCount ?? 1) >= 1);
  const watermarkNotifyExplicit =
    effectiveCfg.watermarkDesktopNotify === true && cfgSnapshot.sources.watermarkDesktopNotify !== "default";
  const dbExists = fs.existsSync(resolvedDbPath);
  const needExistingDbWork =
    !effectiveCfg.cacheWatch &&
    !effectiveCfg.diffRead &&
    (effectiveCfg.readDedup ||
      effectiveCfg.stallWatchdog ||
      effectiveCfg.ttlDesktopNotify ||
      effectiveCfg.ttlKeepalive ||
      effectiveCfg.watermarkDesktopNotify === true ||
      dbExists) &&
    dbExists;
  if (
    !effectiveCfg.cacheWatch &&
    !effectiveCfg.diffRead &&
    !watchdogExplicit &&
    !ttlNotifyExplicit &&
    !ttlKeepaliveCfgExplicit &&
    !watermarkNotifyExplicit &&
    !needExistingDbWork
  ) {
    process.stdout.write("{}\n");
    return;
  }

  const raw = (await readStdin()).trim();
  if (!raw) {
    process.stdout.write("{}\n");
    return;
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.stdout.write("{}\n");
    return;
  }

  const sessionId = resolveSessionId(payload);
  const directConvId = resolveDirectConversationId(payload);
  enableVersionedCompileCache();

  let store = null;

  try {
    const [storeMod, cacheAnalyzerMod, watchdogLeaseMod] = await Promise.all([
      import("../context/lib/store.js"),
      import("../context/lib/cache-analyzer.js"),
      effectiveCfg.cacheWatch ||
      effectiveCfg.stallWatchdog ||
      effectiveCfg.ttlDesktopNotify ||
      effectiveCfg.ttlKeepalive ||
      ttlKeepaliveCfgExplicit ||
      effectiveCfg.watermarkDesktopNotify === true ||
      dbExists
        ? import("../context/lib/watchdog-lease.js")
        : Promise.resolve(null)
    ]);
    const ContextModeStore = storeMod.ContextModeStore;

    // Hook mode: bounded SQLite busy timeout & deadline so external write locks fail-open in <1s
    store = new ContextModeStore({ hookMode: true, maxBusyRetries: 4, maxRetryDeadlineMs: 800 });

    const {
      analyzeTranscriptCache,
      extractStepText,
      findTranscriptForConversation,
      isSlashCompactText,
      readTranscriptTail
    } = cacheAnalyzerMod;

    const targetConvId = directConvId && directConvId !== "default" ? directConvId : sessionId;
    const isSubagentConv = Boolean(directConvId && directConvId !== "default" && directConvId !== sessionId);

    // Advance per-conversation turn sequence on genuine LLM turns when readDedup or diffRead is active
    // (deferred past auto-keepalive detection so background TTL keepalives never age readDedup/diffRead windows).
    let currentTurnSeq = 0;
    let bumpedTurnSeq = false;
    const ensureTurnSeqBumped = () => {
      if (bumpedTurnSeq) return currentTurnSeq;
      if ((effectiveCfg.diffRead || effectiveCfg.readDedup) && directConvId && directConvId !== "default") {
        try {
          currentTurnSeq = store.bumpConversationTurnSeq(directConvId);
          bumpedTurnSeq = true;
        } catch {}
      }
      return currentTurnSeq;
    };

    // Parse initialNumSteps & invocationNum for rollback detection and idempotent `/compact` invalidation
    const rawInitialSteps = payload.initialNumSteps ?? payload.initial_num_steps;
    const initialNumSteps =
      rawInitialSteps !== undefined &&
      rawInitialSteps !== null &&
      rawInitialSteps !== "" &&
      typeof rawInitialSteps !== "boolean" &&
      Number.isFinite(Number(rawInitialSteps)) &&
      Number(rawInitialSteps) >= 0
        ? Math.floor(Number(rawInitialSteps))
        : null;
    const rawInvNum = payload?.invocationNum ?? payload?.invocation_num ?? null;
    const parsedInvNum =
      rawInvNum !== undefined && rawInvNum !== null && rawInvNum !== "" && typeof rawInvNum !== "boolean"
        ? Number(rawInvNum)
        : NaN;
    const isMidTurnContinuation = Number.isFinite(parsedInvNum) && parsedInvNum >= 1;
    const isExplicitTurnEntry = Number.isFinite(parsedInvNum) && parsedInvNum === 0;

    // 1. Detect initialNumSteps rollback (trajectory rewind/reset -> immediate invalidation)
    if (initialNumSteps !== null && targetConvId && targetConvId !== "default") {
      try {
        const stepsKey = `compact_invalidated:steps:${targetConvId}`;
        const rawPrevSteps = store.getTimedMeta(stepsKey, "");
        const prevSteps = rawPrevSteps !== "" && Number.isFinite(Number(rawPrevSteps)) ? Math.floor(Number(rawPrevSteps)) : null;
        if (prevSteps !== null && initialNumSteps < prevSteps) {
          store.invalidateFileReads(targetConvId, null);
          store.deleteMeta(`compact_invalidated:tx_stat:${targetConvId}`);
          store.deleteMeta(`compact_invalidated:cmd:${targetConvId}`);
        }
        if (prevSteps !== initialNumSteps) {
          store.setTimedMeta(stepsKey, String(initialNumSteps));
        }
      } catch {}
    }

    const rawLastUserInput =
      payload.lastUserInput ??
      payload.last_user_input ??
      payload.common?.lastUserInput ??
      payload.common?.last_user_input ??
      "";

    let transcriptPath =
      (typeof payload.transcriptPath === "string" && payload.transcriptPath.trim()) ||
      (typeof payload.transcript_path === "string" && payload.transcript_path.trim()) ||
      (typeof payload.common?.transcriptPath === "string" && payload.common.transcriptPath.trim()) ||
      (typeof payload.common?.transcript_path === "string" && payload.common.transcript_path.trim()) ||
      "";
    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      if (targetConvId && targetConvId !== "default") {
        transcriptPath =
          watchdogLeaseMod?.resolveCandidateTranscriptPath?.(targetConvId, {
            allowDefaultDb: Boolean(process.env.AGY_DART_SUMMARY_DB_PATH) || cfgSnapshot.sources.dbPath === "default"
          }) ||
          findTranscriptForConversation(targetConvId, { exactOnly: true }) ||
          "";
      }
    }

    let preReadExistingLease = null;
    let didPreReadExistingLease = false;
    const resolvePreDiagWorkspaceCwd = () => {
      try {
        const directPayloadCwd = watchdogLeaseMod?.extractPayloadWorkspaceRoot
          ? watchdogLeaseMod.extractPayloadWorkspaceRoot(payload)
          : typeof payload.cwd === "string"
            ? payload.cwd.trim()
            : "";
        if (directPayloadCwd) return directPayloadCwd;
      } catch {}
      if (targetConvId && targetConvId !== "default") {
        if ((dbExists || store.db) && typeof watchdogLeaseMod?.readWatchdogLease === "function") {
          try {
            didPreReadExistingLease = true;
            preReadExistingLease = watchdogLeaseMod.readWatchdogLease(store, targetConvId);
            if (preReadExistingLease?.cwd) return preReadExistingLease.cwd;
          } catch {}
        }
        if ((dbExists || store.db) && typeof store.getSessionCheckpoint === "function") {
          try {
            const candidateSids = [targetConvId];
            if (sessionId && sessionId !== "default" && sessionId !== targetConvId) {
              candidateSids.push(sessionId);
            }
            for (const sid of candidateSids) {
              const cp = store.getSessionCheckpoint(sid);
              if (cp && typeof cp.worktree === "string" && cp.worktree.trim()) {
                return cp.worktree.trim();
              }
            }
          } catch {}
        }
        if (typeof watchdogLeaseMod?.lookupConversationSummary === "function") {
          try {
            const allowDefaultSummaryDb =
              Boolean(process.env.AGY_DART_SUMMARY_DB_PATH) || cfgSnapshot.sources.dbPath === "default";
            const quickSummary = watchdogLeaseMod.lookupConversationSummary(targetConvId, {
              payload,
              transcriptPath,
              allowDefaultDb: allowDefaultSummaryDb,
              checkSubagent: false
            });
            if (quickSummary?.cwd) return quickSummary.cwd;
          } catch {}
        }
      }
      return "";
    };

    let diag = null;
    let loadedSteps = [];
    let txStatMtimeMs = 0;
    let txStatSize = 0;
    if (transcriptPath && fs.existsSync(transcriptPath)) {
      let txStatSig = "";
      try {
        const txStat = fs.statSync(transcriptPath);
        if (txStat.isFile() && txStat.size > 0) {
          txStatMtimeMs = txStat.mtimeMs;
          txStatSize = txStat.size;
          txStatSig = `${txStat.size}:${Math.round(txStat.mtimeMs)}:${transcriptPath}`;
        }
      } catch {}

      const steps = readTranscriptTail(transcriptPath, 131072, { minUsageSteps: 2 });
      loadedSteps = steps;
      if (steps.length > 0) {
        const preDiagWorkspaceCwd = resolvePreDiagWorkspaceCwd();
        const diagOpts = {
          conversationId: targetConvId && targetConvId !== "default" ? targetConvId : ""
        };
        if (preDiagWorkspaceCwd) diagOpts.workspaceCwd = preDiagWorkspaceCwd;
        if (effectiveCfg.cacheTtlSec !== null) diagOpts.ttlSec = effectiveCfg.cacheTtlSec;
        if (effectiveCfg.windowTokens !== null) diagOpts.windowTokens = effectiveCfg.windowTokens;
        if (effectiveCfg.warnTokens !== null) diagOpts.warnTokens = effectiveCfg.warnTokens;
        if (effectiveCfg.criticalTokens !== null) diagOpts.criticalTokens = effectiveCfg.criticalTokens;
        if (dbExists || store.db) {
          try {
            diagOpts.historicalTtlByProfile = store.getAllModelTtlCalibrations();
          } catch {}
        }
        diag = analyzeTranscriptCache(steps, diagOpts);

        if (
          diag.ttlObservations &&
          Object.keys(diag.ttlObservations).length > 0 &&
          targetConvId &&
          targetConvId !== "default"
        ) {
          try {
            const prevTxSig = store.getTimedMeta(`compact_invalidated:tx_stat:${targetConvId}`, "");
            if (!txStatSig || prevTxSig !== txStatSig) {
              store.recordModelTtlObservations(diag.ttlObservations, targetConvId);
            }
          } catch {}
        }

        // Auto-invalidate file_reads & file_snapshots on any compaction/pruning event even when cacheWatch is off or paused.
        // Uses unified latestCompactionEvent (compaction bust, decoupled shrink / mild prune, explicit compact step, `/compact`)
        // and preserves any post-compaction reads when explicit stepIndex is known.
        const compactEvent = diag.latestCompactionEvent;
        if (compactEvent && compactEvent.stamp) {
          const lastCompactKey = `compact_invalidated:${targetConvId}`;
          if (store.getTimedMeta(lastCompactKey, "") !== compactEvent.stamp) {
            if (compactEvent.hasExplicitStepIndex && Number.isFinite(compactEvent.stepIndex)) {
              store.invalidateFileReadsBefore(targetConvId, { maxStep: compactEvent.stepIndex });
            } else {
              store.invalidateFileReads(targetConvId, null);
            }
            store.setTimedMeta(lastCompactKey, compactEvent.stamp);
          }
        }
        if (txStatSig && targetConvId && targetConvId !== "default") {
          try {
            store.setTimedMeta(`compact_invalidated:tx_stat:${targetConvId}`, txStatSig);
          } catch {}
        }
      }
    }

    // Resolve window/subproject identity, official short conversation title & authoritative subagent status once per PreInvocation
    let resolvedWorkspaceLabel = "";
    let resolvedConvTitle = "";
    let resolvedCwd = "";
    let resolvedParentConvId = "";
    let detectedSubagent = isSubagentConv;
    let subprojectPaths = [];
    let existingLease = null;
    if (watchdogLeaseMod) {
      if (
        !detectedSubagent &&
        (watchdogLeaseMod.isSubagentLeasePayload?.(payload) ||
          (typeof rawLastUserInput === "string" && watchdogLeaseMod.isHeadlessWorkerPrompt?.(rawLastUserInput)))
      ) {
        detectedSubagent = true;
      }
      if (targetConvId && targetConvId !== "default") {
        try {
          existingLease = didPreReadExistingLease
            ? preReadExistingLease
            : (dbExists || store.db) && typeof watchdogLeaseMod.readWatchdogLease === "function"
              ? watchdogLeaseMod.readWatchdogLease(store, targetConvId)
              : null;
          if (existingLease?.isSubagent) {
            detectedSubagent = true;
          }
          if (existingLease?.parentConversationId && existingLease.parentConversationId !== targetConvId) {
            resolvedParentConvId = existingLease.parentConversationId;
            detectedSubagent = true;
          }
          const allowDefaultSummaryDb =
            Boolean(process.env.AGY_DART_SUMMARY_DB_PATH) || cfgSnapshot.sources.dbPath === "default";
          const hasGenuineTurn0HumanInput = Boolean(
            !isMidTurnContinuation &&
              !existingLease &&
              typeof rawLastUserInput === "string" &&
              rawLastUserInput.trim() &&
              !watchdogLeaseMod.isHeadlessWorkerPrompt?.(rawLastUserInput) &&
              !watchdogLeaseMod.isTtlKeepalivePrompt?.(rawLastUserInput)
          );
          const summary = watchdogLeaseMod.lookupConversationSummary
            ? watchdogLeaseMod.lookupConversationSummary(targetConvId, {
                payload,
                transcriptPath,
                allowDefaultDb: allowDefaultSummaryDb,
                checkSubagent: !detectedSubagent && !existingLease?.convTitle,
                allowUntitledCustomAgent: !hasGenuineTurn0HumanInput
              })
            : { title: "", cwd: "", isSubagent: false, parentConversationId: "" };
          resolvedConvTitle = summary.title || existingLease?.convTitle || "";
          if (summary.isSubagent) {
            detectedSubagent = true;
          }
          if (summary.parentConversationId && summary.parentConversationId !== targetConvId) {
            resolvedParentConvId = summary.parentConversationId;
            detectedSubagent = true;
          }
          if (!detectedSubagent && !resolvedConvTitle) {
            if (
              loadedSteps.length > 0 &&
              watchdogLeaseMod.detectSubagentFromTranscriptSteps?.(loadedSteps, {
                isFromStart: txStatSize > 0 && txStatSize <= 131072
              })
            ) {
              detectedSubagent = true;
            } else if (
              transcriptPath &&
              (!existingLease || txStatSize > 131072) &&
              watchdogLeaseMod.detectSubagentFromTranscriptFile?.(transcriptPath)
            ) {
              detectedSubagent = true;
            }
          }
          const payloadCwd = watchdogLeaseMod.extractPayloadWorkspaceRoot
            ? watchdogLeaseMod.extractPayloadWorkspaceRoot(payload)
            : payload.cwd || "";
          resolvedCwd = payloadCwd || summary.cwd || existingLease?.cwd || "";

          if (dbExists || store.db) {
            const activity = collectSessionSubprojectPaths(store, targetConvId, sessionId);
            subprojectPaths = activity.paths;
            if (!resolvedCwd && activity.worktree) {
              resolvedCwd = activity.worktree;
            }
          }
          if (resolvedCwd && watchdogLeaseMod.formatWorkspaceWindowLabel) {
            const computedWs = watchdogLeaseMod.formatWorkspaceWindowLabel(resolvedCwd, subprojectPaths);
            const sameWs = watchdogLeaseMod.isSameWorkspacePath
              ? watchdogLeaseMod.isSameWorkspacePath(existingLease?.cwd || "", resolvedCwd)
              : existingLease?.cwd === resolvedCwd;
            if (
              existingLease?.workspaceLabel &&
              sameWs &&
              computedWs &&
              existingLease.workspaceLabel.toLowerCase().startsWith(`${computedWs.toLowerCase()}/`)
            ) {
              resolvedWorkspaceLabel = existingLease.workspaceLabel;
            } else {
              resolvedWorkspaceLabel = computedWs || existingLease?.workspaceLabel || "";
            }
          } else if (existingLease?.workspaceLabel) {
            resolvedWorkspaceLabel = existingLease.workspaceLabel;
          }
        } catch {}
      }
    }

    // Claim context receipts (ctx_execute/ctx_index/ctx_batch) & agy-dart_fast savings under unified rootSessionId
    if ((dbExists || store.db) && loadedSteps.length > 0) {
      try {
        const rawRootCandidate =
          sessionId && sessionId !== "default" && sessionId !== targetConvId
            ? sessionId
            : resolvedParentConvId || targetConvId;
        const claimOwner =
          typeof store.resolveRootSessionId === "function"
            ? store.resolveRootSessionId(rawRootCandidate)
            : rawRootCandidate;
        store.claimExecutionReceipts(claimOwner, executionReceiptsFromSteps(loadedSteps));
        const fastClaims = fastToolClaimsFromSteps(loadedSteps);
        if (fastClaims.length > 0 && typeof store.claimFastToolClaims === "function") {
          const isFullTranscript = txStatSize > 0 && txStatSize <= 131072;
          let windowStartIso = "";
          if (!isFullTranscript) {
            let earliestMs = Infinity;
            for (const c of fastClaims) {
              if (Number.isFinite(c.completedAtMs) && c.completedAtMs < earliestMs) {
                earliestMs = c.completedAtMs;
              }
            }
            if (Number.isFinite(earliestMs)) {
              windowStartIso = new Date(earliestMs - 120000).toISOString();
            }
          }
          store.claimFastToolClaims(claimOwner, fastClaims, {
            directConvId: targetConvId,
            windowStartIso,
            isFullTranscript
          });
        }
      } catch {} // A busy database can be retried on the next invocation.
    }

    // Record Sidecar Stall Watchdog / Idle TTL / Watermark execution lease (isolated by direct conversationId)
    const watchdogActive = Boolean(
      effectiveCfg.stallWatchdog &&
        (typeof store.isWatchdogEnabled !== "function" || store.isWatchdogEnabled())
    );
    const desktopStallNotifyActive = Boolean(
      watchdogActive &&
        (effectiveCfg.watchdogDesktopNotify ||
          ((dbExists || store.db) &&
            typeof store.isWatchdogDesktopNotifyEnabled === "function" &&
            store.isWatchdogDesktopNotifyEnabled()))
    );
    const ttlNotifyActive = Boolean(
      effectiveCfg.ttlDesktopNotify ||
        ((dbExists || store.db) &&
          typeof store.isTtlDesktopNotifyEnabled === "function" &&
          store.isTtlDesktopNotifyEnabled())
    );
    // Migrate any pending empty-tab (`__unbound__`) keepalive setting onto a brand-new Turn-0 primary conversation
    if (
      (dbExists || store.db) &&
      !detectedSubagent &&
      !isMidTurnContinuation &&
      !existingLease &&
      targetConvId &&
      targetConvId !== "default" &&
      typeof store.claimPendingUnboundTtlKeepalive === "function" &&
      !loadedSteps.some((s) => String(s?.type || "").toUpperCase() === "PLANNER_RESPONSE")
    ) {
      try {
        store.claimPendingUnboundTtlKeepalive(targetConvId);
      } catch {}
    }

    let ttlKeepaliveExplicit = false;
    if (!detectedSubagent) {
      if (cfgSnapshot.sources.ttlKeepalive === "env" && effectiveCfg.ttlKeepalive === false) {
        ttlKeepaliveExplicit = false;
      } else {
        const convKaState =
          (dbExists || store.db) &&
          targetConvId &&
          targetConvId !== "default" &&
          typeof store.getTtlKeepaliveState === "function"
            ? store.getTtlKeepaliveState(targetConvId)
            : null;
        if (convKaState && typeof convKaState.enabled === "boolean") {
          ttlKeepaliveExplicit = convKaState.enabled;
        } else if (convKaState && typeof convKaState.maxCount === "number" && convKaState.maxCount >= 1) {
          ttlKeepaliveExplicit = true;
        } else if (cfgSnapshot.sources.ttlKeepaliveMaxCount === "env") {
          ttlKeepaliveExplicit = Number(effectiveCfg.ttlKeepaliveMaxCount) >= 1;
        } else if (cfgSnapshot.sources.ttlKeepalive === "env") {
          ttlKeepaliveExplicit = Boolean(effectiveCfg.ttlKeepalive);
        } else if (
          (dbExists || store.db) &&
          typeof store.hasExplicitGlobalTtlKeepaliveMaxCount === "function" &&
          store.hasExplicitGlobalTtlKeepaliveMaxCount()
        ) {
          ttlKeepaliveExplicit = store.getGlobalTtlKeepaliveMaxCount() >= 1;
        } else if (
          cfgSnapshot.sources.ttlKeepalive !== "default" ||
          cfgSnapshot.sources.ttlKeepaliveMaxCount !== "default"
        ) {
          ttlKeepaliveExplicit =
            Boolean(effectiveCfg.ttlKeepalive) && Number(effectiveCfg.ttlKeepaliveMaxCount ?? 1) >= 1;
        }
      }
    }
    const watermarkNotifyActive =
      effectiveCfg.watermarkDesktopNotify === true ||
      (effectiveCfg.watermarkDesktopNotify === null && (ttlNotifyActive || desktopStallNotifyActive));

    // Detect auto-keepalive & background subagent/task wakeup vs genuine user turn so real user messages reset keepalive count -> 0/N.
    // Note: `agentapi send-message` and subagent `send_message` inject a SYSTEM_MESSAGE step without clearing/replacing `payload.lastUserInput`
    // (which still holds the PREVIOUS turn's user prompt), so we MUST always scan trailing steps after the last
    // PLANNER_RESPONSE first rather than skipping transcript inspection when `rawLastUserInput` is non-empty.
    let isKeepaliveTurn = false;
    let isBackgroundWakeup = false;
    if (!detectedSubagent && targetConvId && targetConvId !== "default" && watchdogLeaseMod) {
      try {
        const checkKeepalive = watchdogLeaseMod.isTtlKeepalivePrompt;
        const trimmedRawInput = typeof rawLastUserInput === "string" ? rawLastUserInput.trim() : "";
        const matchedDirectKeepalive = Boolean(checkKeepalive && checkKeepalive(trimmedRawInput));
        let matchedKeepaliveInTrailingSteps = false;
        let sawUserStepAfterPlanner = false;
        let sawSystemStepAfterPlanner = false;
        let priorCompletedUserText = "";
        if (loadedSteps.length > 0) {
          // Inspect steps after the last PLANNER_RESPONSE without breaking early so a real USER_INPUT
          // alongside a SYSTEM_MESSAGE keepalive is NEVER misclassified as a pure keepalive turn;
          // also capture the latest pre-PLANNER_RESPONSE USER_INPUT for un-flushed stale-input fallback.
          let passedLastPlanner = false;
          for (let idx = loadedSteps.length - 1; idx >= 0; idx--) {
            const stp = loadedSteps[idx];
            if (!stp || typeof stp !== "object") continue;
            const stType = String(stp.type || "").toUpperCase();
            if (stType === "PLANNER_RESPONSE") {
              passedLastPlanner = true;
              continue;
            }
            if (!passedLastPlanner) {
              if (!matchedDirectKeepalive && (stType === "USER_INPUT" || stType === "SYSTEM_MESSAGE")) {
                const sysObj = stp.systemMessage || stp.system_message;
                const isUiOnlySys = Boolean(
                  sysObj && typeof sysObj === "object" && sysObj.systemMessage === "" && sysObj.metadata?.user_markdown
                );
                if (isUiOnlySys) continue;
                const extracted = String(
                  extractStepText ? extractStepText(stp.user_input ?? stp.content ?? stp.text) : (stp.user_input ?? stp.content ?? "")
                ).trim();
                if (!extracted) continue;
                if (checkKeepalive && checkKeepalive(extracted)) {
                  matchedKeepaliveInTrailingSteps = true;
                } else if (stType === "USER_INPUT") {
                  sawUserStepAfterPlanner = true;
                } else if (stType === "SYSTEM_MESSAGE") {
                  sawSystemStepAfterPlanner = true;
                }
              }
            } else if (stType === "USER_INPUT") {
              const rawPrior = String(
                extractStepText ? extractStepText(stp.user_input ?? stp.content ?? stp.text) : (stp.user_input ?? stp.content ?? "")
              ).trim();
              if (rawPrior && !(checkKeepalive && checkKeepalive(rawPrior))) {
                const reqMatch = rawPrior.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
                priorCompletedUserText = (reqMatch ? reqMatch[1] : rawPrior).trim();
                break;
              }
            }
          }
        }
        const kaState =
          (dbExists || store.db) && typeof store.getTtlKeepaliveState === "function"
            ? store.getTtlKeepaliveState(targetConvId)
            : null;
        const sanitizedRawInput =
          trimmedRawInput && typeof watchdogLeaseMod.sanitizeWatchdogText === "function"
            ? watchdogLeaseMod.sanitizeWatchdogText(rawLastUserInput, 240)
            : trimmedRawInput;
        const sanitizedPriorTxInput =
          priorCompletedUserText && typeof watchdogLeaseMod.sanitizeWatchdogText === "function"
            ? watchdogLeaseMod.sanitizeWatchdogText(priorCompletedUserText, 240)
            : priorCompletedUserText;
        const isStaleCarryOverInput =
          !trimmedRawInput ||
          Boolean(existingLease?.lastUserInput && sanitizedRawInput === existingLease.lastUserInput) ||
          Boolean(!existingLease?.lastUserInput && sanitizedPriorTxInput && sanitizedRawInput === sanitizedPriorTxInput);

        if (matchedDirectKeepalive || (matchedKeepaliveInTrailingSteps && !sawUserStepAfterPlanner)) {
          isKeepaliveTurn = true;
          if (!isMidTurnContinuation && typeof store.setTtlKeepaliveState === "function") {
            const nowAckMs = Date.now();
            const ackDelayMs = kaState?.lastSentTs > 0 ? nowAckMs - kaState.lastSentTs : 0;
            if (
              kaState?.pendingAck &&
              ackDelayMs > 0 &&
              ackDelayMs <= 30_000 &&
              typeof store.recordTtlKeepaliveDeliveryMs === "function"
            ) {
              store.recordTtlKeepaliveDeliveryMs(ackDelayMs);
            }
            if (kaState?.pendingAck || !kaState?.inKeepaliveTurn) {
              store.setTtlKeepaliveState(targetConvId, {
                pendingAck: false,
                inKeepaliveTurn: true,
                updatedTs: nowAckMs
              });
            }
          }
        } else if (
          !isMidTurnContinuation &&
          !sawUserStepAfterPlanner &&
          isStaleCarryOverInput &&
          kaState?.pendingAck &&
          Date.now() - (kaState.lastSentTs || 0) <= 90_000
        ) {
          isKeepaliveTurn = true;
          if (typeof store.setTtlKeepaliveState === "function") {
            const nowAckMs = Date.now();
            const ackDelayMs = kaState.lastSentTs > 0 ? nowAckMs - kaState.lastSentTs : 0;
            if (ackDelayMs > 0 && ackDelayMs <= 30_000 && typeof store.recordTtlKeepaliveDeliveryMs === "function") {
              store.recordTtlKeepaliveDeliveryMs(ackDelayMs);
            }
            store.setTtlKeepaliveState(targetConvId, {
              pendingAck: false,
              inKeepaliveTurn: true,
              updatedTs: nowAckMs
            });
          }
        }

        if (
          !isMidTurnContinuation &&
          !isKeepaliveTurn &&
          !sawUserStepAfterPlanner &&
          isStaleCarryOverInput &&
          (sawSystemStepAfterPlanner || existingLease?.subphase === "stopped_bg_pending")
        ) {
          isBackgroundWakeup = true;
        }

        if (
          !isKeepaliveTurn &&
          !isMidTurnContinuation &&
          isBackgroundWakeup &&
          kaState?.inKeepaliveTurn &&
          typeof store.setTtlKeepaliveState === "function"
        ) {
          store.setTtlKeepaliveState(targetConvId, { inKeepaliveTurn: false, updatedTs: Date.now() });
        } else if (
          !isKeepaliveTurn &&
          !isBackgroundWakeup &&
          !isMidTurnContinuation &&
          kaState &&
          (kaState.usedCount > 0 ||
            kaState.pendingAck ||
            kaState.coldMissTripped ||
            kaState.inKeepaliveTurn ||
            Boolean(kaState.lastDispatchId) ||
            Boolean(kaState.pendingColdCheckId) ||
            kaState.lastIdleAnchorTs > 0 ||
            kaState.lastSentTs > 0 ||
            kaState.lastAttemptTs > 0 ||
            Boolean(kaState.lastError)) &&
          typeof store.resetTtlKeepaliveState === "function"
        ) {
          store.resetTtlKeepaliveState(targetConvId);
        } else if (
          !isKeepaliveTurn &&
          !isMidTurnContinuation &&
          kaState &&
          (typeof kaState.enabled === "boolean" || typeof kaState.maxCount === "number") &&
          Date.now() - (kaState.updatedTs || 0) > 3600_000 &&
          typeof store.setTtlKeepaliveState === "function"
        ) {
          store.setTtlKeepaliveState(targetConvId, { updatedTs: Date.now() });
        }
      } catch {}
    }

    // 2. Immediate `/compact` command detection via lastUserInput (idempotent via initialNumSteps;
    //    skipped on SYSTEM_MESSAGE keepalive / background wakeup turns where `lastUserInput` may still hold a prior `/compact`).
    if (
      !isKeepaliveTurn &&
      !isBackgroundWakeup &&
      typeof rawLastUserInput === "string" &&
      rawLastUserInput.trim() &&
      targetConvId &&
      targetConvId !== "default"
    ) {
      try {
        const cmdKey = `compact_invalidated:cmd:${targetConvId}`;
        if (isSlashCompactText(rawLastUserInput)) {
          if (!isMidTurnContinuation) {
            const cmdText = rawLastUserInput.trim().slice(0, 128);
            let prevCmd = null;
            const rawPrevCmd = store.getTimedMeta(cmdKey, "");
            if (rawPrevCmd) {
              try {
                prevCmd = JSON.parse(rawPrevCmd);
              } catch {}
            }
            const alreadyStamped = Boolean(
              prevCmd &&
                prevCmd.text === cmdText &&
                (initialNumSteps !== null ? prevCmd.initialNumSteps === initialNumSteps : !isExplicitTurnEntry)
            );
            if (!alreadyStamped) {
              ensureTurnSeqBumped();
              store.invalidateFileReads(targetConvId, null);
              store.setTimedMeta(
                cmdKey,
                JSON.stringify({
                  text: cmdText,
                  initialNumSteps,
                  stepIdx: null,
                  turnSeq: currentTurnSeq,
                  ts: Date.now()
                })
              );
            }
          }
        } else {
          // Non-compact user turn resets cmd stamp so a subsequent `/compact` always triggers cleanly
          if (store.getTimedMeta(cmdKey, "")) {
            store.deleteMeta(cmdKey);
          }
        }
      } catch {}
    }

    if (!isKeepaliveTurn) {
      ensureTurnSeqBumped();
    }

    const preInvWorkspaceCwd = resolvedCwd || extractPreInvocationPayloadCwd(payload);
    if (
      !isKeepaliveTurn &&
      preInvWorkspaceCwd &&
      targetConvId &&
      targetConvId !== "default" &&
      typeof store.recordSessionWorkspace === "function"
    ) {
      try {
        store.recordSessionWorkspace(targetConvId, preInvWorkspaceCwd, {
          rootSessionId:
            sessionId && sessionId !== targetConvId
              ? sessionId
              : resolvedParentConvId || sessionId,
          active: true,
          source: "PreInvocation"
        });
      } catch {}
    }

    if (
      (watchdogActive || ttlNotifyActive || ttlKeepaliveExplicit || watermarkNotifyActive || isKeepaliveTurn) &&
      targetConvId &&
      targetConvId !== "default" &&
      watchdogLeaseMod?.recordHookLeaseTransition
    ) {
      try {
        watchdogLeaseMod.recordHookLeaseTransition(store, "PreInvocation", payload, {
          directConvId: targetConvId,
          rootSessionId:
            sessionId && sessionId !== targetConvId
              ? sessionId
              : resolvedParentConvId || sessionId,
          parentConversationId: resolvedParentConvId,
          isSubagent: detectedSubagent,
          isKeepaliveTurn,
          isBackgroundWakeup,
          cwd: resolvedCwd || payload.cwd || "",
          workspaceLabel: resolvedWorkspaceLabel,
          convTitle: resolvedConvTitle,
          modifiedOrReadPaths: subprojectPaths,
          transcriptPath,
          transcriptMtimeMs: txStatMtimeMs,
          transcriptSize: txStatSize,
          contextTokens: diag?.currentContextTokens || 0,
          windowTokens: diag?.modelProfile?.windowTokens || 0,
          warnTokens: diag?.warnTokens || 0,
          criticalTokens: diag?.criticalTokens || 0,
          watermark: diag?.watermark || "",
          mediaCount: diag?.totalMediaCount || 0,
          model: diag?.currentModel || "",
          cacheTtlSec: diag?.cacheTtlSec || 0,
          ttlSource: diag?.ttlSource || ""
        });
      } catch {}
    }

    // Preserve dual-side desktop watermark reset after /compact even when inline chat banners are disabled
    if (
      diag &&
      diag.watermark === "ok" &&
      targetConvId &&
      targetConvId !== "default" &&
      (dbExists || store.db)
    ) {
      try {
        const wmDesktopKey = `cache_alert:${targetConvId}:wm_desktop`;
        const prevWmDesktop =
          typeof store.getTimedMeta === "function"
            ? store.getTimedMeta(wmDesktopKey, "")
            : store.getMeta(wmDesktopKey, "");
        if (prevWmDesktop) {
          store.deleteMeta(wmDesktopKey);
        }
      } catch {}
    }

    // Inherit parent pause state for subagents, while isolating alert suppression keys per direct conversation.
    // Inline `metadata.user_markdown` step emission is gated behind explicit opt-in (`cacheWatchInlineAlerts`)
    // to prevent host-side `proto_utils.go:34` panics on Antigravity builds affected by upstream #1394/#1845.
    if (
      isKeepaliveTurn ||
      !effectiveCfg.cacheWatch ||
      !effectiveCfg.cacheWatchInlineAlerts ||
      store.isPaused(sessionId) ||
      (isSubagentConv && store.isPaused(targetConvId)) ||
      !diag
    ) {
      store.close();
      store = null;
      process.stdout.write("{}\n");
      return;
    }

    const uiLang =
      typeof store.getUiLang === "function" ? store.getUiLang() : effectiveCfg.uiLang || "en";
    const alerts = evaluateCacheAlerts(diag, {
      sessionId: targetConvId,
      store,
      invocationNum: payload?.invocationNum ?? payload?.invocation_num ?? null,
      lang: uiLang,
      isBackgroundWakeup
    });
    store.close();
    store = null;

    if (alerts.length === 0) {
      process.stdout.write("{}\n");
      return;
    }

    const isZhUi = uiLang === "zh";
    const prefixBadge = isZhUi ? "[agy-dart 缓存守卫]" : "[agy-dart KV-Cache Watch]";
    const windowBadge = formatChatWindowBadge(resolvedWorkspaceLabel, resolvedConvTitle, isZhUi);
    const markdown = alerts.map((a) => `> **${prefixBadge}**${windowBadge} ${a}`).join("\n");
    // Zero-prefix-pollution UI-only step: systemMessage is "" so the model receives 0 tokens!
    process.stdout.write(
      JSON.stringify({
        injectSteps: [
          {
            systemMessage: {
              systemMessage: "",
              metadata: {
                user_markdown: markdown
              }
            }
          }
        ]
      }) + "\n"
    );
  } catch {
    if (store) {
      try {
        store.close();
      } catch {}
    }
    process.stdout.write("{}\n");
  }
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
    process.stdout.write("{}\n");
  });
}
