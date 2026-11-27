import http from "node:http";

const CONVERSATION_API_METHOD_GET = "/product.v1.ConversationService/GetConversation";
const DEFAULT_CONVERSATION_API_TIMEOUT_MS = 1500;
const MAX_CONVERSATION_API_RESPONSE_BYTES = 256 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function isSafeApiConversationId(raw) {
  if (typeof raw !== "string") return false;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 128) return false;
  if (trimmed === "." || trimmed === ".." || trimmed.includes("..")) return false;
  return /^[A-Za-z0-9._-]+$/.test(trimmed);
}

/**
 * Strictly validate an Antigravity Language Server address (`host:port`).
 * Permits ONLY loopback addresses (`127.0.0.1`, `localhost`, `[::1]`) with a valid TCP port
 * so `x-antigravity-csrf-token` can never be transmitted off-machine.
 */
export function parseLoopbackLsAddress(rawAddress) {
  if (typeof rawAddress !== "string") return null;
  const trimmed = rawAddress.trim();
  if (!trimmed || trimmed.length > 128) return null;
  // Reject schemes, paths, query strings, fragments, whitespace, or userinfo.
  if (/[/?#@\s\\]/.test(trimmed)) return null;

  let hostname = "";
  let portStr = "";
  if (trimmed.startsWith("[")) {
    const closeIdx = trimmed.indexOf("]");
    if (closeIdx <= 1 || trimmed[closeIdx + 1] !== ":") return null;
    hostname = trimmed.slice(1, closeIdx).toLowerCase();
    portStr = trimmed.slice(closeIdx + 2);
  } else {
    const firstColon = trimmed.indexOf(":");
    const lastColon = trimmed.lastIndexOf(":");
    if (firstColon <= 0 || firstColon !== lastColon) return null;
    hostname = trimmed.slice(0, firstColon).toLowerCase();
    portStr = trimmed.slice(firstColon + 1);
  }

  if (!LOOPBACK_HOSTS.has(hostname)) return null;
  if (!/^\d{1,5}$/.test(portStr)) return null;
  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  const hostHeader = hostname === "::1" ? `[::1]:${port}` : `${hostname}:${port}`;
  return { hostname, port, hostHeader };
}

export function isConversationServiceConfigured(env = process.env) {
  if (!env || typeof env !== "object") return false;
  const addr = parseLoopbackLsAddress(env.ANTIGRAVITY_LS_ADDRESS);
  const token = typeof env.ANTIGRAVITY_CSRF_TOKEN === "string" ? env.ANTIGRAVITY_CSRF_TOKEN.trim() : "";
  return Boolean(addr && token);
}

function cleanStr(val, maxLen = 256) {
  if (typeof val !== "string") return "";
  return val.trim().slice(0, maxLen);
}

/**
 * Normalize a `product.v1.ConversationService` Conversation payload into a uniform shape.
 */
export function normalizeConversationApiRecord(raw, requestedId = "") {
  const conv =
    raw && typeof raw === "object" && raw.conversation && typeof raw.conversation === "object"
      ? raw.conversation
      : raw && typeof raw === "object"
        ? raw
        : {};
  const metadata = conv.metadata && typeof conv.metadata === "object" ? conv.metadata : {};
  const annotations = conv.annotations && typeof conv.annotations === "object" ? conv.annotations : {};
  const state = conv.state && typeof conv.state === "object" ? conv.state : {};

  const id = cleanStr(conv.id || requestedId, 128);
  const parentConversationId = cleanStr(
    metadata.parentConversationId ?? metadata.parent_conversation_id ?? "",
    128
  );
  const rootConversationId = cleanStr(
    metadata.rootConversationId ?? metadata.root_conversation_id ?? "",
    128
  );
  const projectId = cleanStr(metadata.projectId ?? metadata.project_id ?? "", 128);
  const title = cleanStr(annotations.title || state.summary || "", 120);
  const archived = annotations.archived === true;
  const runState = cleanStr(state.runState ?? state.run_state ?? "", 64);
  const isRunning = runState === "RUN_STATE_RUNNING";
  const isCancelling = runState === "RUN_STATE_CANCELLING";
  const isSubagent = Boolean(
    (parentConversationId && parentConversationId !== id) ||
      (rootConversationId && rootConversationId !== id)
  );
  const updateTime = cleanStr(state.updateTime ?? state.update_time ?? "", 64);

  return {
    id,
    title,
    projectId,
    parentConversationId,
    rootConversationId,
    isSubagent,
    archived,
    runState,
    isRunning,
    isCancelling,
    updateTime
  };
}

/**
 * Query Antigravity's official Connect HTTP+JSON `product.v1.ConversationService/GetConversation`.
 * Strictly loopback-only, short-timeout, and fail-open (never throws).
 */
export function getConversationViaApi(conversationId, options = {}) {
  const safeId = typeof conversationId === "string" ? conversationId.trim() : "";
  if (!isSafeApiConversationId(safeId)) {
    return Promise.resolve({ ok: false, unavailable: true, error: "invalid_conversation_id" });
  }

  const env = options.env && typeof options.env === "object" ? options.env : process.env;
  const rawAddress =
    typeof options.lsAddress === "string" && options.lsAddress.trim()
      ? options.lsAddress.trim()
      : typeof env?.ANTIGRAVITY_LS_ADDRESS === "string"
        ? env.ANTIGRAVITY_LS_ADDRESS.trim()
        : "";
  const rawToken =
    typeof options.csrfToken === "string" && options.csrfToken.trim()
      ? options.csrfToken.trim()
      : typeof env?.ANTIGRAVITY_CSRF_TOKEN === "string"
        ? env.ANTIGRAVITY_CSRF_TOKEN.trim()
        : "";

  if (!rawAddress || !rawToken) {
    return Promise.resolve({ ok: false, unavailable: true, error: "not_configured" });
  }

  const parsedAddr = parseLoopbackLsAddress(rawAddress);
  if (!parsedAddr) {
    return Promise.resolve({
      ok: false,
      unavailable: true,
      blockedNonLoopback: true,
      error: "non_loopback_address_rejected"
    });
  }

  const timeoutMs =
    Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) >= 100
      ? Math.min(10000, Math.floor(Number(options.timeoutMs)))
      : DEFAULT_CONVERSATION_API_TIMEOUT_MS;

  const body = JSON.stringify({ conversationId: safeId });

  return new Promise((resolve) => {
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };

    let req;
    try {
      req = http.request(
        {
          hostname: parsedAddr.hostname,
          port: parsedAddr.port,
          path: CONVERSATION_API_METHOD_GET,
          method: "POST",
          agent: false,
          headers: {
            Host: parsedAddr.hostHeader,
            "Content-Type": "application/json",
            "Connect-Protocol-Version": "1",
            "x-antigravity-csrf-token": rawToken,
            "Content-Length": Buffer.byteLength(body)
          }
        },
        (res) => {
          const statusCode = Number(res.statusCode || 0);
          const chunks = [];
          let totalBytes = 0;
          let oversized = false;

          res.on("data", (chunk) => {
            if (oversized) return;
            totalBytes += chunk.length;
            if (totalBytes > MAX_CONVERSATION_API_RESPONSE_BYTES) {
              oversized = true;
              res.destroy();
              finish({ ok: false, statusCode, error: "response_too_large" });
              return;
            }
            chunks.push(chunk);
          });

          res.on("end", () => {
            if (oversized) return;
            const rawText = Buffer.concat(chunks).toString("utf8").trim();
            let parsed = null;
            if (rawText) {
              try {
                parsed = JSON.parse(rawText);
              } catch {}
            }

            if (statusCode === 200) {
              if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                finish({ ok: false, statusCode, error: "invalid_json_response" });
                return;
              }
              const norm = normalizeConversationApiRecord(parsed, safeId);
              finish({
                ok: true,
                found: Boolean(norm.id),
                statusCode,
                ...norm
              });
              return;
            }

            const connectCode = typeof parsed?.code === "string" ? parsed.code.trim().toLowerCase() : "";
            if (statusCode === 404 && connectCode === "not_found") {
              finish({ ok: true, found: false, statusCode });
              return;
            }
            if (
              statusCode === 404 ||
              statusCode === 405 ||
              statusCode === 501 ||
              connectCode === "unimplemented"
            ) {
              finish({
                ok: false,
                unsupported: true,
                statusCode,
                error: connectCode || `http_${statusCode}`
              });
              return;
            }

            finish({
              ok: false,
              statusCode,
              error: connectCode || `http_${statusCode}`
            });
          });

          res.on("error", (err) => {
            finish({ ok: false, statusCode, error: err?.code || err?.message || "response_error" });
          });
        }
      );

      req.setTimeout(timeoutMs, () => {
        try {
          req.destroy();
        } catch {}
        finish({ ok: false, error: "timeout" });
      });

      req.on("error", (err) => {
        finish({ ok: false, error: err?.code || err?.message || "request_error" });
      });

      req.end(body);
    } catch (err) {
      finish({ ok: false, error: err?.message || "request_init_error" });
    }
  });
}
