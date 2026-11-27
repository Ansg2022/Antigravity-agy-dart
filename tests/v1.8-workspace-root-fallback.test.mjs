import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { getConfigSnapshot, resetConfigCache } from "../context/lib/config.js";
import { ContextModeStore, SESSION_WORKSPACE_PREFIX } from "../context/lib/store.js";
import { handleStopPayload } from "../hooks/stop.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function makeTmpDir(prefix = "agy-v18-ws-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanTmpDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {}
}

const BASE_CLEAN_ENV = {
  ANTIGRAVITY_CONVERSATION_ID: "",
  ANTIGRAVITY_PARENT_CONVERSATION_ID: "",
  ANTIGRAVITY_ROOT_CONVERSATION_ID: "",
  CONVERSATION_ID: "",
  ANTIGRAVITY_SUBAGENT: "",
  ANTIGRAVITY_WORKSPACE_ROOT: "",
  VSCODE_CWD: "",
  AGY_DART_WORKSPACE: "",
  AGY_DART_DEFAULT_CWD: "",
  AGY_DART_DISABLE_COMPILE_CACHE: "1",
  AGY_DART_ROOTS_TIMEOUT_MS: "120"
};

function createBidirectionalMcpClient(scriptPath, { cwd = ROOT, env = {}, onServerRequest = null } = {}) {
  const child = spawn(process.execPath, [scriptPath], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, ...BASE_CLEAN_ENV, ...env }
  });
  let stderr = "";
  let buf = "";
  const pending = new Map();
  const serverRequests = [];
  let nextId = 1;

  child.stderr.on("data", (d) => {
    stderr += d.toString("utf8");
  });

  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg && typeof msg.method === "string" && msg.id !== undefined) {
        serverRequests.push(msg);
        if (typeof onServerRequest === "function") {
          Promise.resolve(onServerRequest(msg)).then((reply) => {
            if (reply !== undefined) {
              child.stdin.write(JSON.stringify(reply) + "\n");
            }
          });
        }
        continue;
      }
      if (msg && msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, timer } = pending.get(msg.id);
        clearTimeout(timer);
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });

  return {
    serverRequests,
    getStderr: () => stderr,
    sendRaw(obj) {
      child.stdin.write(JSON.stringify(obj) + "\n");
    },
    request(method, params, timeoutMs = 8000) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP request '${method}' timed out. stderr=${stderr}`));
        }, timeoutMs);
        timer.unref();
        pending.set(id, { resolve, timer });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
    close() {
      return new Promise((resolve) => {
        const killTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {}
          resolve();
        }, 2000);
        killTimer.unref();
        child.once("close", () => {
          clearTimeout(killTimer);
          resolve();
        });
        try {
          child.stdin.end();
        } catch {
          resolve();
        }
      });
    }
  };
}

function runHook(relPath, payload, env = {}) {
  const res = spawnSync(process.execPath, [path.join(ROOT, relPath)], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    windowsHide: true,
    timeout: 8000,
    env: { ...process.env, ...BASE_CLEAN_ENV, ...env }
  });
  assert.equal(res.status, 0, `${relPath} failed: ${res.stderr}`);
  return JSON.parse((res.stdout || "{}").trim() || "{}");
}

function installRuntimeCopy(installDir, dbPath, cfgPath) {
  const ins = spawnSync(
    process.execPath,
    [path.join(ROOT, "scripts", "install.mjs"), "install", "--target", installDir],
    {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, ...BASE_CLEAN_ENV, AGY_DART_DB_PATH: dbPath, AGY_DART_CONFIG_PATH: cfgPath }
    }
  );
  assert.equal(ins.status, 0, `${ins.stdout}\n${ins.stderr}`);
}

test("Issue #6-1: SessionStart -> anonymous fast/context MCP omitted-cwd succeeds on Turn 1 and tracks window switches without MCP restart", async () => {
  const tmpDir = makeTmpDir("agy-iss6-switch-");
  try {
    const installDir = path.join(tmpDir, "installed-agy-dart");
    const wsA = path.join(tmpDir, "ws-alpha");
    const wsB = path.join(tmpDir, "ws-beta");
    const dbPath = path.join(tmpDir, "context.db");
    const cfgPath = path.join(tmpDir, "config.json");
    fs.mkdirSync(wsA, { recursive: true });
    fs.mkdirSync(wsB, { recursive: true });
    fs.writeFileSync(path.join(wsA, "alpha.txt"), "ALPHA_ONLY_NEEDLE\n", "utf8");
    fs.writeFileSync(path.join(wsB, "beta.txt"), "BETA_ONLY_NEEDLE\n", "utf8");

    installRuntimeCopy(installDir, dbPath, cfgPath);

    const commonEnv = {
      AGY_DART_DB_PATH: dbPath,
      AGY_DART_CONFIG_PATH: cfgPath,
      PLUGIN_ROOT: installDir
    };

    // 1. SessionStart fires for Window A (no roots/list support on host)
    runHook(
      "hooks/session-start.mjs",
      { conversationId: "conv-win-a", workspacePaths: [wsA], cwd: wsA, hookEventName: "SessionStart" },
      commonEnv
    );

    const fastClient = createBidirectionalMcpClient(path.join(installDir, "fast", "mcp-server.mjs"), {
      cwd: installDir,
      env: commonEnv,
      onServerRequest: () => undefined // Antigravity ignores server-initiated roots/list
    });
    const ctxClient = createBidirectionalMcpClient(path.join(installDir, "context", "server.js"), {
      cwd: installDir,
      env: commonEnv,
      onServerRequest: () => undefined
    });

    try {
      await fastClient.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "antigravity-sim", version: "2.35.2" }
      });
      await ctxClient.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "antigravity-sim", version: "2.35.2" }
      });

      // Verify fast tools/list cues cwd on all 4 tools while staying within Turn-0 schema budget
      const listResp = await fastClient.request("tools/list", {});
      for (const tool of listResp.result.tools) {
        assert.match(tool.description, /\bcwd\b/i, `${tool.name} description should mention cwd`);
      }

      // First batch_search WITHOUT cwd succeeds immediately against wsA!
      const searchA = await fastClient.request("tools/call", {
        name: "batch_search",
        arguments: { queries: [{ type: "text", pattern: "ALPHA_ONLY_NEEDLE" }] }
      });
      assert.equal(searchA.result.isError, false, searchA.result.content[0].text);
      assert.ok(searchA.result.content[0].text.includes("alpha.txt"));

      // First context ctx_index with relative path WITHOUT cwd also resolves wsA!
      const ctxIdxA = await ctxClient.request("tools/call", {
        name: "ctx_index",
        arguments: { path: "alpha.txt" }
      });
      assert.equal(ctxIdxA.result.isError, false, ctxIdxA.result.content[0].text);
      assert.match(ctxIdxA.result.content[0].text, /Indexed/);

      // 2. Window A finishes turn (Stop -> idle), Window B starts (SessionStart -> active)
      runHook(
        "hooks/stop.mjs",
        { conversationId: "conv-win-a", terminationReason: "NO_TOOL_CALL", fullyIdle: true },
        commonEnv
      );
      runHook(
        "hooks/session-start.mjs",
        { conversationId: "conv-win-b", workspacePaths: [wsB], cwd: wsB, hookEventName: "SessionStart" },
        commonEnv
      );

      // Same persistent fast MCP server resolves wsB (never stale-cached on wsA!)
      const searchB = await fastClient.request("tools/call", {
        name: "batch_search",
        arguments: { queries: [{ type: "text", pattern: "BETA_ONLY_NEEDLE" }] }
      });
      assert.equal(searchB.result.isError, false, searchB.result.content[0].text);
      assert.ok(searchB.result.content[0].text.includes("beta.txt"));
    } finally {
      await fastClient.close();
      await ctxClient.close();
    }
  } finally {
    cleanTmpDir(tmpDir);
  }
});

test("Issue #6-2: Multi-window active ambiguity fails fast on anonymous calls while named session lookup still succeeds", async () => {
  const tmpDir = makeTmpDir("agy-iss6-ambig-");
  try {
    const installDir = path.join(tmpDir, "installed-agy-dart");
    const wsA = path.join(tmpDir, "ws-one");
    const wsB = path.join(tmpDir, "ws-two");
    const dbPath = path.join(tmpDir, "context.db");
    const cfgPath = path.join(tmpDir, "config.json");
    fs.mkdirSync(wsA, { recursive: true });
    fs.mkdirSync(wsB, { recursive: true });
    fs.writeFileSync(path.join(wsA, "one.txt"), "MARKER_ONE\n", "utf8");
    fs.writeFileSync(path.join(wsB, "two.txt"), "MARKER_TWO\n", "utf8");

    installRuntimeCopy(installDir, dbPath, cfgPath);

    const commonEnv = {
      AGY_DART_DB_PATH: dbPath,
      AGY_DART_CONFIG_PATH: cfgPath,
      PLUGIN_ROOT: installDir
    };

    // Both Window A and Window B are simultaneously active!
    runHook("hooks/session-start.mjs", { conversationId: "conv-one", workspacePaths: [wsA], cwd: wsA }, commonEnv);
    runHook("hooks/session-start.mjs", { conversationId: "conv-two", workspacePaths: [wsB], cwd: wsB }, commonEnv);

    const fastClient = createBidirectionalMcpClient(path.join(installDir, "fast", "mcp-server.mjs"), {
      cwd: installDir,
      env: commonEnv,
      onServerRequest: () => undefined
    });
    const ctxClient = createBidirectionalMcpClient(path.join(installDir, "context", "server.js"), {
      cwd: installDir,
      env: commonEnv,
      onServerRequest: () => undefined
    });

    try {
      await fastClient.request("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
      await ctxClient.request("initialize", { protocolVersion: "2024-11-05", capabilities: {} });

      // Anonymous batch_search MUST fail fast (no cross-workspace leak)
      const ambigSearch = await fastClient.request("tools/call", {
        name: "batch_search",
        arguments: { queries: [{ type: "glob", pattern: "*.txt" }] }
      });
      assert.equal(ambigSearch.result.isError, true);
      assert.match(ambigSearch.result.content[0].text, /Workspace root could not be determined/);
      assert.match(ambigSearch.result.content[0].text, /2 active workspaces detected/);

      // Anonymous apply_edits MUST fail fast and write nothing in either workspace or plugin dir
      const ambigEdit = await fastClient.request("tools/call", {
        name: "apply_edits",
        arguments: { edits: [{ path: "should-not-exist.txt", create: "nope" }] }
      });
      assert.equal(ambigEdit.result.isError, true);
      assert.match(ambigEdit.result.content[0].text, /Workspace root could not be determined/);
      assert.equal(fs.existsSync(path.join(wsA, "should-not-exist.txt")), false);
      assert.equal(fs.existsSync(path.join(wsB, "should-not-exist.txt")), false);
      assert.equal(fs.existsSync(path.join(installDir, "should-not-exist.txt")), false);

      // Anonymous context ctx_execute MUST also fail fast
      const ambigCtx = await ctxClient.request("tools/call", {
        name: "ctx_execute",
        arguments: { language: "javascript", code: "console.log(process.cwd())" }
      });
      assert.equal(ambigCtx.result.isError, true);
      assert.match(ambigCtx.result.content[0].text, /Workspace root could not be determined/);

      // Named _meta.conversationId calls resolve each window unambiguously even during multi-window concurrency!
      const namedA = await fastClient.request("tools/call", {
        name: "batch_search",
        arguments: { queries: [{ type: "text", pattern: "MARKER_ONE" }] },
        _meta: { conversationId: "conv-one" }
      });
      assert.equal(namedA.result.isError, false, namedA.result.content[0].text);
      assert.ok(namedA.result.content[0].text.includes("one.txt"));

      const namedB = await fastClient.request("tools/call", {
        name: "batch_search",
        arguments: { queries: [{ type: "text", pattern: "MARKER_TWO" }] },
        _meta: { conversationId: "conv-two" }
      });
      assert.equal(namedB.result.isError, false, namedB.result.content[0].text);
      assert.ok(namedB.result.content[0].text.includes("two.txt"));
    } finally {
      await fastClient.close();
      await ctxClient.close();
    }
  } finally {
    cleanTmpDir(tmpDir);
  }
});

test("Issue #6-3: stallWatchdog=false still records/clears session_workspace, stale TTL expires, and unsafe dirs are rejected", async () => {
  const tmpDir = makeTmpDir("agy-iss6-ttl-");
  try {
    const wsA = path.join(tmpDir, "ws-valid");
    const fakePluginDir = path.join(tmpDir, ".gemini", "config", "plugins", "agy-dart");
    const dbPath = path.join(tmpDir, "context.db");
    const cfgPath = path.join(tmpDir, "config.json");
    fs.mkdirSync(wsA, { recursive: true });
    fs.mkdirSync(fakePluginDir, { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify({ stallWatchdog: false, cacheWatch: false }), "utf8");

    const env = { AGY_DART_DB_PATH: dbPath, AGY_DART_CONFIG_PATH: cfgPath };

    // SessionStart + PreInvocation with stallWatchdog: false still maintain session_workspace
    runHook("hooks/session-start.mjs", { conversationId: "conv-no-wd", workspacePaths: [wsA], cwd: wsA }, env);
    runHook("hooks/pre-invocation.mjs", { conversationId: "conv-no-wd", workspacePaths: [wsA], cwd: wsA }, env);

    const store = new ContextModeStore({ dbPath });
    try {
      const activeBeforeStop = store.resolveUniqueActiveWorkspace();
      assert.equal(activeBeforeStop.status, "unique");
      assert.equal(activeBeforeStop.dir, path.resolve(wsA));

      // handleStopPayload with stallWatchdog=false still marks session_workspace idle while preserving reason="disabled"
      const stopRes = await handleStopPayload(
        { conversationId: "conv-no-wd", terminationReason: "NO_TOOL_CALL", fullyIdle: true },
        { store, effectiveCfg: { stallWatchdog: false, ttlDesktopNotify: false, ttlKeepalive: false, watermarkDesktopNotify: false } }
      );
      assert.equal(stopRes.reason, "disabled");
      assert.equal(store.resolveUniqueActiveWorkspace().status, "none");
      // Named lookup still retains the conversation's cwd even after Stop
      assert.equal(store.resolveSessionWorkspace(["conv-no-wd"]), path.resolve(wsA));

      // Reject installed plugin dir, home dir, and filesystem root
      assert.equal(store.recordSessionWorkspace("conv-bad-1", fakePluginDir), null);
      assert.equal(store.recordSessionWorkspace("conv-bad-2", os.homedir()), null);
      assert.equal(store.recordSessionWorkspace("conv-bad-3", path.parse(wsA).root), null);

      // Expired active entry (>10m old) does NOT match
      const staleTs = Date.now() - 15 * 60 * 1000;
      store.recordSessionWorkspace("conv-stale", wsA, { active: true, nowMs: staleTs, source: "PreInvocation" });
      assert.equal(store.resolveUniqueActiveWorkspace().status, "none");
      assert.equal(store.getMeta(`${SESSION_WORKSPACE_PREFIX}conv-stale`) !== null, true);
    } finally {
      store.close();
    }
  } finally {
    cleanTmpDir(tmpDir);
  }
});

test("Issue #6-4: AGY_DART_WORKSPACE env var & config.json defaultCwd overrides (env > config, plugin-dir rejected, dynamic reload)", async () => {
  const tmpDir = makeTmpDir("agy-iss6-override-");
  try {
    const installDir = path.join(tmpDir, "installed-agy-dart");
    const wsCfg = path.join(tmpDir, "ws-from-config");
    const wsEnv = path.join(tmpDir, "ws-from-env");
    const dbPath = path.join(tmpDir, "override.db");
    const cfgPath = path.join(tmpDir, "config.json");
    fs.mkdirSync(wsCfg, { recursive: true });
    fs.mkdirSync(wsEnv, { recursive: true });
    fs.writeFileSync(path.join(wsCfg, "cfg-file.txt"), "CFG_OVERRIDE_MARKER\n", "utf8");
    fs.writeFileSync(path.join(wsEnv, "env-file.txt"), "ENV_OVERRIDE_MARKER\n", "utf8");

    installRuntimeCopy(installDir, dbPath, cfgPath);

    // Verify config.js provenance tracking
    fs.writeFileSync(cfgPath, JSON.stringify({ defaultCwd: wsCfg }), "utf8");
    resetConfigCache();
    const snapCfg = getConfigSnapshot({ configPath: cfgPath, env: {} });
    assert.equal(snapCfg.values.defaultCwd, wsCfg);
    assert.equal(snapCfg.sources.defaultCwd, "config");

    const snapEnv = getConfigSnapshot({ configPath: cfgPath, env: { AGY_DART_WORKSPACE: wsEnv } });
    assert.equal(snapEnv.values.defaultCwd, wsEnv);
    assert.equal(snapEnv.sources.defaultCwd, "env");

    // 4A. config.json defaultCwd resolves omitted cwd in fast MCP (0 roots/list wait!)
    const fastCfg = createBidirectionalMcpClient(path.join(installDir, "fast", "mcp-server.mjs"), {
      cwd: installDir,
      env: { AGY_DART_DB_PATH: dbPath, AGY_DART_CONFIG_PATH: cfgPath, PLUGIN_ROOT: installDir },
      onServerRequest: () => undefined
    });
    try {
      await fastCfg.request("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
      const resCfg = await fastCfg.request("tools/call", {
        name: "batch_search",
        arguments: { queries: [{ type: "text", pattern: "CFG_OVERRIDE_MARKER" }] }
      });
      assert.equal(resCfg.result.isError, false, resCfg.result.content[0].text);
      assert.ok(resCfg.result.content[0].text.includes("cfg-file.txt"));
      assert.equal(fastCfg.serverRequests.length, 0, "Explicit defaultCwd on non-roots host must skip futile roots/list probe");

      // Dynamic reload: pointing defaultCwd at installDir MUST be rejected by PLUGIN_ROOT guard!
      fs.writeFileSync(cfgPath, JSON.stringify({ defaultCwd: installDir }), "utf8");
      const futureMs = Date.now() + 2000;
      fs.utimesSync(cfgPath, futureMs / 1000, futureMs / 1000);
      const resBad = await fastCfg.request("tools/call", {
        name: "batch_search",
        arguments: { queries: [{ type: "glob", pattern: "*.json" }] }
      });
      assert.equal(resBad.result.isError, true);
      assert.match(resBad.result.content[0].text, /Workspace root could not be determined/);
    } finally {
      await fastCfg.close();
    }

    // 4B. AGY_DART_WORKSPACE env var overrides config.json defaultCwd in both fast and context MCP
    fs.writeFileSync(cfgPath, JSON.stringify({ defaultCwd: wsCfg }), "utf8");
    const fastEnv = createBidirectionalMcpClient(path.join(installDir, "fast", "mcp-server.mjs"), {
      cwd: installDir,
      env: {
        AGY_DART_DB_PATH: dbPath,
        AGY_DART_CONFIG_PATH: cfgPath,
        PLUGIN_ROOT: installDir,
        AGY_DART_WORKSPACE: wsEnv
      },
      onServerRequest: () => undefined
    });
    try {
      await fastEnv.request("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
      const resEnv = await fastEnv.request("tools/call", {
        name: "batch_search",
        arguments: { queries: [{ type: "text", pattern: "ENV_OVERRIDE_MARKER" }] }
      });
      assert.equal(resEnv.result.isError, false, resEnv.result.content[0].text);
      assert.ok(resEnv.result.content[0].text.includes("env-file.txt"));
    } finally {
      await fastEnv.close();
    }
  } finally {
    resetConfigCache();
    cleanTmpDir(tmpDir);
  }
});

test("Issue #6-5: Capability-aware roots/list retries after cold-start timeout when client supports roots, but caches JSON-RPC error immediately", async () => {
  const tmpDir = makeTmpDir("agy-iss6-roots-retry-");
  try {
    const installDir = path.join(tmpDir, "installed-agy-dart");
    const wsA = path.join(tmpDir, "ws-slow-roots");
    const dbPath = path.join(tmpDir, "roots-retry.db");
    const cfgPath = path.join(tmpDir, "config.json");
    fs.mkdirSync(wsA, { recursive: true });
    fs.writeFileSync(path.join(wsA, "ready.txt"), "SLOW_ROOTS_READY\n", "utf8");

    installRuntimeCopy(installDir, dbPath, cfgPath);

    // 5A. clientSupportsRoots=true: 1st roots/list times out, 2nd succeeds -> must NOT permanently cache timeout!
    let attempt = 0;
    const slowClient = createBidirectionalMcpClient(path.join(installDir, "fast", "mcp-server.mjs"), {
      cwd: installDir,
      env: {
        AGY_DART_DB_PATH: dbPath,
        AGY_DART_CONFIG_PATH: cfgPath,
        PLUGIN_ROOT: installDir,
        AGY_DART_ROOTS_TIMEOUT_MS: "120"
      },
      onServerRequest: (req) => {
        if (req.method !== "roots/list") return undefined;
        attempt += 1;
        if (attempt === 1) {
          // Drop first response to simulate slow cold-start timeout
          return undefined;
        }
        return {
          jsonrpc: "2.0",
          id: req.id,
          result: { roots: [{ uri: pathToFileURL(wsA).href, name: "ws" }] }
        };
      }
    });
    try {
      await slowClient.request("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: { roots: { listChanged: true } },
        clientInfo: { name: "slow-roots-host", version: "1.0" }
      });

      const first = await slowClient.request("tools/call", {
        name: "batch_search",
        arguments: { queries: [{ type: "text", pattern: "SLOW_ROOTS_READY" }] }
      });
      assert.equal(first.result.isError, true);
      assert.match(first.result.content[0].text, /Workspace root could not be determined/);

      // Second call retries roots/list and succeeds!
      const second = await slowClient.request("tools/call", {
        name: "batch_search",
        arguments: { queries: [{ type: "text", pattern: "SLOW_ROOTS_READY" }] }
      });
      assert.equal(second.result.isError, false, second.result.content[0].text);
      assert.ok(second.result.content[0].text.includes("ready.txt"));
      assert.equal(slowClient.serverRequests.length, 2);

      // Third call reuses cached root (no 3rd roots/list request)
      const third = await slowClient.request("tools/call", {
        name: "batch_search",
        arguments: { queries: [{ type: "text", pattern: "SLOW_ROOTS_READY" }] }
      });
      assert.equal(third.result.isError, false);
      assert.equal(slowClient.serverRequests.length, 2);
    } finally {
      await slowClient.close();
    }

    // 5B. Explicit JSON-RPC -32601 error marks rootsUnsupported immediately (no retry spam)
    const errClient = createBidirectionalMcpClient(path.join(installDir, "fast", "mcp-server.mjs"), {
      cwd: installDir,
      env: { AGY_DART_DB_PATH: dbPath, AGY_DART_CONFIG_PATH: cfgPath, PLUGIN_ROOT: installDir },
      onServerRequest: (req) => ({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32601, message: "Method not found" }
      })
    });
    try {
      await errClient.request("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: { roots: {} },
        clientInfo: { name: "no-roots-method-host", version: "1.0" }
      });
      const r1 = await errClient.request("tools/call", {
        name: "batch_search",
        arguments: { queries: [{ type: "glob", pattern: "*.txt" }] }
      });
      const r2 = await errClient.request("tools/call", {
        name: "batch_search",
        arguments: { queries: [{ type: "glob", pattern: "*.txt" }] }
      });
      assert.equal(r1.result.isError, true);
      assert.equal(r2.result.isError, true);
      assert.equal(errClient.serverRequests.length, 1, "Explicit JSON-RPC error must cache rootsUnsupported without retrying");
    } finally {
      await errClient.close();
    }
  } finally {
    cleanTmpDir(tmpDir);
  }
});
