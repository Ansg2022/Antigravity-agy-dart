import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resetConfigCache } from "../context/lib/config.js";
import { ContextModeStore } from "../context/lib/store.js";
import {
  SAFE_GIT_CONFIG_ARGS,
  computeWaterFillBudgets,
  isInsideInstalledPluginDir,
  parseFlatLineRangeSpec,
  runApplyEdits,
  runBatchSearch,
  runChecks,
  runReadSlices,
  validateReadonlyGitArgs
} from "../fast/mcp-server.mjs";
import { buildWorkspaceSnapshot } from "../fast/session-start.mjs";
import {
  buildHookBootstrapCommand,
  buildMcpConfigObject,
  discoverExtraHostPluginTargets
} from "../scripts/install.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function makeTmpDir(prefix = "agy-v16-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanTmpDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {}
}

/**
 * Interactive bidirectional JSON-RPC stdio client supporting server-initiated
 * requests such as `roots/list` as well as client notifications.
 */
function createBidirectionalMcpClient(scriptPath, { cwd = ROOT, env = {}, onServerRequest = null } = {}) {
  const child = spawn(process.execPath, [scriptPath], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, ...env }
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
    request(method, params, timeoutMs = 5000) {
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

test("v1.6-1: Cross-workspace hooks.json polyglot bootstrapper runs all 5 hooks across PLUGIN_ROOT, .agents/plugins, and HOME, and fails open cleanly", () => {
  const tmpDir = makeTmpDir("agy-v16-hooks-");
  try {
    const hooksCfg = JSON.parse(fs.readFileSync(path.join(ROOT, "hooks.json"), "utf8"));
    const lc = hooksCfg["agy-dart-lifecycle"];
    const foreignWs = path.join(tmpDir, "foreign-workspace");
    const dbPath = path.join(tmpDir, "hooks.db");
    fs.mkdirSync(foreignWs, { recursive: true });
    fs.writeFileSync(path.join(foreignWs, "package.json"), '{"name":"demo-ws"}\n', "utf8");

    const baseEnv = {
      ...process.env,
      PLUGIN_ROOT: ROOT,
      AGY_DART_DB_PATH: dbPath,
      AGY_DART_CONFIG_PATH: path.join(tmpDir, "nonexistent.json"),
      ANTIGRAVITY_PARENT_CONVERSATION_ID: "",
      ANTIGRAVITY_SUBAGENT: ""
    };

    // 1A. Execute SessionStart via both `shell: true` AND non-verbatim `cmd /c` (or `sh -c`) from foreign CWD
    const ssCmd = lc.SessionStart[0].command;
    const ssInput = JSON.stringify({
      cwd: foreignWs,
      workspacePaths: [foreignWs],
      hookEventName: "SessionStart"
    });
    const ssShell = spawnSync(ssCmd, {
      shell: true,
      cwd: foreignWs,
      input: ssInput,
      encoding: "utf8",
      timeout: 6000,
      windowsHide: true,
      env: baseEnv
    });
    assert.equal(ssShell.status, 0, ssShell.stderr);
    assert.equal(ssShell.stderr, "");
    const ssOut = JSON.parse(ssShell.stdout.trim());
    assert.ok(ssOut.injectSteps?.[0]?.systemMessage?.systemMessage?.includes("demo-ws"));

    if (process.platform === "win32") {
      const ssCmdExe = spawnSync("cmd", ["/c", ssCmd], {
        cwd: foreignWs,
        input: ssInput,
        encoding: "utf8",
        timeout: 6000,
        windowsHide: true,
        env: baseEnv
      });
      assert.equal(ssCmdExe.status, 0, ssCmdExe.stderr);
      assert.ok(JSON.parse(ssCmdExe.stdout.trim()).injectSteps?.length === 1);
    }

    // 1B. Verify PreToolUse, PostToolUse, PreInvocation, and Stop all trigger main() from foreign CWD
    const bigFile = path.join(foreignWs, "huge.log");
    fs.writeFileSync(bigFile, "ERROR line\n".repeat(3000), "utf8");

    const preCmd = lc.PreToolUse[0].hooks[0].command;
    const preRes = spawnSync(preCmd, {
      shell: true,
      cwd: foreignWs,
      input: JSON.stringify({
        conversationId: "boot-conv-1",
        cwd: foreignWs,
        toolCall: { name: "read_file", args: { Path: bigFile } }
      }),
      encoding: "utf8",
      timeout: 6000,
      windowsHide: true,
      env: baseEnv
    });
    assert.equal(preRes.status, 0, preRes.stderr);
    assert.equal(JSON.parse(preRes.stdout.trim()).decision, "deny", "PreToolUse must actively guard >16KB .log from foreign CWD");

    const postCmd = lc.PostToolUse[0].hooks[0].command;
    const postRes = spawnSync(postCmd, {
      shell: true,
      cwd: foreignWs,
      input: JSON.stringify({
        conversationId: "boot-conv-1",
        cwd: foreignWs,
        toolCall: { name: "write_file", args: { Path: path.join(foreignWs, "src.js") } },
        toolResponse: "ok"
      }),
      encoding: "utf8",
      timeout: 6000,
      windowsHide: true,
      env: baseEnv
    });
    assert.equal(postRes.status, 0, postRes.stderr);
    assert.deepEqual(JSON.parse(postRes.stdout.trim()), {});

    const preInvCmd = lc.PreInvocation[0].command;
    const preInvRes = spawnSync(preInvCmd, {
      shell: true,
      cwd: foreignWs,
      input: JSON.stringify({ conversationId: "boot-conv-1", cwd: foreignWs, lastUserInput: "hello" }),
      encoding: "utf8",
      timeout: 6000,
      windowsHide: true,
      env: baseEnv
    });
    assert.equal(preInvRes.status, 0, preInvRes.stderr);
    assert.equal(typeof JSON.parse(preInvRes.stdout.trim()), "object");

    const stopCmd = lc.Stop[0].command;
    const stopRes = spawnSync(stopCmd, {
      shell: true,
      cwd: foreignWs,
      input: JSON.stringify({ conversationId: "boot-conv-1", terminationReason: "IDLE_READY", fullyIdle: true }),
      encoding: "utf8",
      timeout: 6000,
      windowsHide: true,
      env: baseEnv
    });
    assert.equal(stopRes.status, 0, stopRes.stderr);
    assert.deepEqual(JSON.parse(stopRes.stdout.trim()), { decision: "allow" });

    // 1C. Discovery via ancestor `.agents/plugins/agy-dart` without PLUGIN_ROOT
    const projRoot = path.join(tmpDir, "monorepo");
    const nestedDir = path.join(projRoot, "packages", "web");
    fs.mkdirSync(nestedDir, { recursive: true });
    const projInstall = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts", "install.mjs"), "install", "--project", projRoot],
      { encoding: "utf8", windowsHide: true, env: { ...baseEnv, PLUGIN_ROOT: "" } }
    );
    assert.equal(projInstall.status, 0, `${projInstall.stdout}\n${projInstall.stderr}`);

    const stopFromNested = spawnSync(stopCmd, {
      shell: true,
      cwd: nestedDir,
      input: JSON.stringify({ conversationId: "nested-1", fullyIdle: true }),
      encoding: "utf8",
      timeout: 6000,
      windowsHide: true,
      env: {
        ...baseEnv,
        PLUGIN_ROOT: "",
        AGY_PLUGIN_ROOT: "",
        USERPROFILE: path.join(tmpDir, "empty-home"),
        HOME: path.join(tmpDir, "empty-home")
      }
    });
    assert.equal(stopFromNested.status, 0, stopFromNested.stderr);
    assert.deepEqual(JSON.parse(stopFromNested.stdout.trim()), { decision: "allow" });

    // 1D. Missing plugin fail-open -> `{}` with exit 0 and empty stderr
    const ghostCmd = buildHookBootstrapCommand("nonexistent-ghost-plugin", "./hooks/stop.mjs");
    const ghostRes = spawnSync(ghostCmd, {
      shell: true,
      cwd: foreignWs,
      input: "{}",
      encoding: "utf8",
      timeout: 6000,
      windowsHide: true,
      env: { ...baseEnv, PLUGIN_ROOT: "", AGY_PLUGIN_ROOT: "" }
    });
    assert.equal(ghostRes.status, 0);
    assert.equal(ghostRes.stderr, "");
    assert.deepEqual(JSON.parse(ghostRes.stdout.trim()), {});
  } finally {
    cleanTmpDir(tmpDir);
  }
});

test("anonymous MCP sessions isolate new and legacy data by workspace", async () => {
  const dir = makeTmpDir();
  const db = path.join(dir, "contexts.db");
  const editorCwd = path.join(dir, "editor-launch");
  const projects = ["alpha", "beta"].map(name => path.join(dir, name));
  const seed = new ContextModeStore({ dbPath: db });
  let roots = [];
  let client;
  try {
    fs.mkdirSync(editorCwd);
    fs.writeFileSync(path.join(editorCwd, "editor-note.txt"), "editor launch marker");
    for (const worktree of projects) {
      fs.mkdirSync(worktree);
      seed.indexContent({ sessionId: "default", worktree, content: "legacytoken " + path.basename(worktree) });
      seed.recordEvent({ sessionId: "default", worktree, kind: "index", body: path.basename(worktree) });
    }
    seed.close();
    client = createBidirectionalMcpClient(path.join(ROOT, "context/server.js"), {
      cwd: dir,
      onServerRequest: req => ({ jsonrpc: "2.0", id: req.id, result: { roots: roots.map(uri => ({ uri })) } }),
      env: {
        AGY_DART_DB_PATH: db, AGY_DART_CONFIG_PATH: path.join(dir, "config.json"),
        ANTIGRAVITY_CONVERSATION_ID: "", ANTIGRAVITY_ROOT_CONVERSATION_ID: "",
        ANTIGRAVITY_PARENT_CONVERSATION_ID: "", CONVERSATION_ID: "", ANTIGRAVITY_WORKSPACE_ROOT: "", VSCODE_CWD: editorCwd
      }
    });
    await client.request("initialize", { capabilities: { roots: { listChanged: true } } });
    const call = async (name, args) => {
      const { result } = await client.request("tools/call", { name, arguments: args });
      assert.equal(result.isError, false, result.content[0].text);
      return JSON.parse(result.content[0].text);
    };
    for (const name of ["ctx_search", "ctx_purge", "ctx_resume", "ctx_stats"]) {
      const { result } = await client.request("tools/call", { name, arguments: { sessionId: "default" } });
      assert.equal(result.isError, true, name);
      assert.match(result.content[0].text, /Workspace root could not be determined/);
    }
    const named = await client.request("tools/call", {
      name: "ctx_index", arguments: { path: "editor-note.txt" }, _meta: { conversationId: "editor-session" }
    });
    assert.equal(named.result.isError, false, named.result.content[0].text);
    const [a, b] = projects;
    const [indexedA] = await Promise.all(projects.map(cwd =>
      call("ctx_index", { cwd, content: "newtoken " + path.basename(cwd) })));
    for (const cwd of projects) {
      for (const query of ["newtoken", "legacytoken"]) {
        const { hits } = await call("ctx_search", { cwd, queries: [query] });
        assert.equal(hits.length, 1);
        assert.ok(hits[0].snippet.includes(path.basename(cwd)), hits[0].snippet);
      }
      const resumed = await call("ctx_resume", { cwd });
      assert.equal(resumed.recentEvents.length, 2);
      assert.equal(resumed.recentSources.length, 2);
    }
    const foreign = await call("ctx_search", { cwd: b, queries: ["newtoken"], sourceId: indexedA.sourceId });
    assert.equal(foreign.totalMatches, 0);
    const setRoots = dirs => {
      roots = dirs.map(dir => pathToFileURL(dir).href);
      client.sendRaw({ jsonrpc: "2.0", method: "notifications/roots/list_changed" });
    };
    setRoots([a, b]);
    assert.equal((await client.request("tools/call", { name: "ctx_purge" })).result.isError, true);
    for (const cwd of projects) {
      setRoots([cwd]);
      const { hits } = await call("ctx_search", { queries: ["legacytoken"] });
      assert.equal(hits.length, 1);
      assert.ok(hits[0].snippet.includes(path.basename(cwd)));
    }
    await call("ctx_index", { cwd: a, content: "namedtoken", sessionId: "ordinary-session" });
    await call("ctx_purge", { cwd: a });
    assert.equal((await call("ctx_resume", { cwd: a })).recentSources.length, 0);
    assert.equal((await call("ctx_resume", { cwd: b })).recentSources.length, 2);
    assert.equal((await call("ctx_search", { sessionId: "ordinary-session", queries: ["namedtoken"] })).totalMatches, 1);
    await call("ctx_stats", { cwd: b, reset: true });
    assert.equal((await call("ctx_resume", { cwd: b })).recentEvents.length, 0);
  } finally {
    if (client) await client.close();
    seed.close();
    cleanTmpDir(dir);
  }
});

test("v1.6-2: Dual MCP servers (fast + context) lazy roots/list, list_changed invalidation, zero-latency explicit cwd & PLUGIN_ROOT Fail-Fast guard", async () => {
  const tmpDir = makeTmpDir("agy-v16-roots-");
  try {
    const installDir = path.join(tmpDir, "installed-agy-dart");
    const wsA = path.join(tmpDir, "workspace-alpha");
    const wsB = path.join(tmpDir, "workspace-beta");
    const dbPath = path.join(tmpDir, "roots.db");
    fs.mkdirSync(wsA, { recursive: true });
    fs.mkdirSync(wsB, { recursive: true });
    fs.writeFileSync(path.join(wsA, "alpha.txt"), "ALPHA_WORKSPACE_MARKER\n", "utf8");
    fs.writeFileSync(path.join(wsB, "beta.txt"), "BETA_WORKSPACE_MARKER\n", "utf8");

    const ins = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts", "install.mjs"), "install", "--target", installDir],
      {
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, AGY_DART_DB_PATH: dbPath, AGY_DART_CONFIG_PATH: path.join(tmpDir, "cfg.json") }
      }
    );
    assert.equal(ins.status, 0, `${ins.stdout}\n${ins.stderr}`);

    const cleanEnv = {
      AGY_DART_DB_PATH: dbPath,
      AGY_DART_CONFIG_PATH: path.join(tmpDir, "cfg.json"),
      ANTIGRAVITY_CONVERSATION_ID: "",
      ANTIGRAVITY_PARENT_CONVERSATION_ID: "",
      ANTIGRAVITY_ROOT_CONVERSATION_ID: "",
      CONVERSATION_ID: "",
      ANTIGRAVITY_WORKSPACE_ROOT: "",
      VSCODE_CWD: "",
      PLUGIN_ROOT: installDir
    };

    // 2A. Fast MCP inside installed plugin dir WITHOUT roots/list:
    //     - omitting cwd fails fast
    //     - relative cwd fails fast
    //     - explicit absolute cwd succeeds with 0 roots/list calls!
    const fastNoRoots = createBidirectionalMcpClient(path.join(installDir, "fast", "mcp-server.mjs"), {
      cwd: installDir,
      env: cleanEnv,
      onServerRequest: (req) => ({ jsonrpc: "2.0", id: req.id, result: { roots: [] } })
    });
    try {
      await fastNoRoots.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "hub-test", version: "2.0" }
      });
      await fastNoRoots.request("tools/list", {});
      assert.equal(fastNoRoots.serverRequests.length, 0, "Handshake & tools/list must be 100% one-way");

      // Explicit absolute cwd skips roots/list completely
      const explicitCall = await fastNoRoots.request("tools/call", {
        name: "batch_search",
        arguments: { cwd: wsA, queries: [{ type: "text", pattern: "ALPHA_WORKSPACE_MARKER" }] }
      });
      assert.equal(explicitCall.result.isError, false);
      assert.ok(explicitCall.result.content[0].text.includes("alpha.txt"));
      assert.equal(fastNoRoots.serverRequests.length, 0, "Explicit absolute cwd must send 0 roots/list requests");

      // Omitted cwd fails fast with PLUGIN_ROOT guard
      const omittedCall = await fastNoRoots.request("tools/call", {
        name: "batch_search",
        arguments: { queries: [{ type: "glob", pattern: "*.json" }] }
      });
      assert.equal(omittedCall.result.isError, true);
      assert.match(omittedCall.result.content[0].text, /Workspace root could not be determined/);

      // Relative cwd also fails fast when base workspace is unconfirmed plugin dir
      const relEditCall = await fastNoRoots.request("tools/call", {
        name: "apply_edits",
        arguments: { cwd: "./rules", edits: [{ path: "hack.md", create: "bad" }] }
      });
      assert.equal(relEditCall.result.isError, true);
      assert.match(relEditCall.result.content[0].text, /Workspace root could not be determined/);
      assert.equal(fs.existsSync(path.join(installDir, "rules", "hack.md")), false);
    } finally {
      await fastNoRoots.close();
    }

    // 2A-bis. Host passing PLUGIN_ROOT in initialize.rootUri or roots/list MUST NOT bypass Fail-Fast guard
    const fastPluginInit = createBidirectionalMcpClient(path.join(installDir, "fast", "mcp-server.mjs"), {
      cwd: installDir,
      env: cleanEnv,
      onServerRequest: (req) => ({
        jsonrpc: "2.0",
        id: req.id,
        result: { roots: [{ uri: pathToFileURL(installDir).href }] }
      })
    });
    try {
      await fastPluginInit.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: { roots: { listChanged: true } },
        rootUri: pathToFileURL(installDir).href,
        clientInfo: { name: "buggy-hub", version: "2.0" }
      });
      const guarded = await fastPluginInit.request("tools/call", {
        name: "batch_search",
        arguments: { queries: [{ type: "glob", pattern: "*.json" }] }
      });
      assert.equal(guarded.result.isError, true, "PLUGIN_ROOT passed via rootUri/roots must never be confirmed as workspace");
      assert.match(guarded.result.content[0].text, /Workspace root could not be determined/);
    } finally {
      await fastPluginInit.close();
    }

    // 2B. Fast MCP WITH roots/list + notifications/roots/list_changed invalidation
    let activeRootDir = wsA;
    const fastWithRoots = createBidirectionalMcpClient(path.join(installDir, "fast", "mcp-server.mjs"), {
      cwd: installDir,
      env: cleanEnv,
      onServerRequest: (req) => {
        if (req.method === "roots/list") {
          return {
            jsonrpc: "2.0",
            id: req.id,
            result: { roots: [{ uri: pathToFileURL(activeRootDir).href, name: "ws" }] }
          };
        }
        return undefined;
      }
    });
    try {
      await fastWithRoots.request("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: { roots: { listChanged: true } },
        clientInfo: { name: "desktop-hub", version: "2.0" }
      });
      assert.equal(fastWithRoots.serverRequests.length, 0);

      const firstSearch = await fastWithRoots.request("tools/call", {
        name: "batch_search",
        arguments: { queries: [{ type: "text", pattern: "ALPHA_WORKSPACE_MARKER" }] }
      });
      assert.equal(firstSearch.result.isError, false);
      assert.ok(firstSearch.result.content[0].text.includes("alpha.txt"));
      assert.equal(fastWithRoots.serverRequests.length, 1);

      // Cached on 2nd call
      await fastWithRoots.request("tools/call", {
        name: "batch_search",
        arguments: { queries: [{ type: "text", pattern: "ALPHA_WORKSPACE_MARKER" }] }
      });
      assert.equal(fastWithRoots.serverRequests.length, 1, "Second call must reuse cached roots/list result");

      // Switch workspace via notifications/roots/list_changed
      activeRootDir = wsB;
      fastWithRoots.sendRaw({ jsonrpc: "2.0", method: "notifications/roots/list_changed" });
      const switchedSearch = await fastWithRoots.request("tools/call", {
        name: "batch_search",
        arguments: { queries: [{ type: "text", pattern: "BETA_WORKSPACE_MARKER" }] }
      });
      assert.equal(switchedSearch.result.isError, false);
      assert.ok(switchedSearch.result.content[0].text.includes("beta.txt"));
      assert.equal(fastWithRoots.serverRequests.length, 2);
    } finally {
      await fastWithRoots.close();
    }

    // 2C. Context MCP server: PLUGIN_ROOT fail-fast when unconfirmed + roots/list resolution
    let ctxProvideRoot = false;
    const ctxClient = createBidirectionalMcpClient(path.join(installDir, "context", "server.js"), {
      cwd: installDir,
      env: { ...cleanEnv, AGY_DART_DB_PATH: path.join(tmpDir, "fresh-ctx.db") },
      onServerRequest: (req) => {
        if (req.method === "roots/list") {
          return {
            jsonrpc: "2.0",
            id: req.id,
            result: { roots: ctxProvideRoot ? [{ uri: pathToFileURL(wsA).href }] : [] }
          };
        }
        return undefined;
      }
    });
    try {
      await ctxClient.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: { roots: { listChanged: true } },
        clientInfo: { name: "ctx-hub", version: "2.0" }
      });
      // Unconfirmed plugin cwd blocks ctx_execute & relative ctx_index
      const blockedExec = await ctxClient.request("tools/call", {
        name: "ctx_execute",
        arguments: { language: "javascript", code: "console.log(process.cwd())" }
      });
      assert.equal(blockedExec.result.isError, true);
      assert.match(blockedExec.result.content[0].text, /Workspace root could not be determined/);

      const blockedRelIdx = await ctxClient.request("tools/call", {
        name: "ctx_index",
        arguments: { path: "alpha.txt" }
      });
      assert.equal(blockedRelIdx.result.isError, true);
      assert.match(blockedRelIdx.result.content[0].text, /Workspace root could not be determined/);

      // Worktree-scoped ctx_search & ctx_purge also fail fast when unconfirmed
      const blockedWtSearch = await ctxClient.request("tools/call", {
        name: "ctx_search",
        arguments: { scope: "worktree", queries: ["ALPHA"] }
      });
      assert.equal(blockedWtSearch.result.isError, true);
      assert.match(blockedWtSearch.result.content[0].text, /Workspace root could not be determined/);

      const blockedWtPurge = await ctxClient.request("tools/call", {
        name: "ctx_purge",
        arguments: { scope: "worktree" }
      });
      assert.equal(blockedWtPurge.result.isError, true);
      assert.match(blockedWtPurge.result.content[0].text, /Workspace root could not be determined/);

      // Explicit file:// URI path in ctx_index works even before roots/list is confirmed
      const fileUriIdx = await ctxClient.request("tools/call", {
        name: "ctx_index",
        arguments: { path: pathToFileURL(path.join(wsB, "beta.txt")).href }
      });
      assert.equal(fileUriIdx.result.isError, false, fileUriIdx.result.content[0].text);
      assert.match(fileUriIdx.result.content[0].text, /Indexed/);

      // Anonymous raw text requires a workspace to own the stored content.
      const rawIdx = await ctxClient.request("tools/call", {
        name: "ctx_index",
        arguments: { content: "# Heading\nPure text content", label: "mem-doc" }
      });
      assert.equal(rawIdx.result.isError, true);
      assert.match(rawIdx.result.content[0].text, /Workspace root could not be determined/);

      // Now enable roots/list and trigger list_changed -> relative ctx_index resolves wsA/alpha.txt!
      ctxProvideRoot = true;
      ctxClient.sendRaw({ jsonrpc: "2.0", method: "notifications/roots/list_changed" });
      const okRelIdx = await ctxClient.request("tools/call", {
        name: "ctx_index",
        arguments: { path: "alpha.txt" }
      });
      assert.equal(okRelIdx.result.isError, false);
      assert.match(okRelIdx.result.content[0].text, /Indexed/);
    } finally {
      await ctxClient.close();
    }

    // Standard path pattern recognition even if `.git` exists inside ~/.gemini/config/plugins/agy-dart
    const fakeClonedGlobal = path.join(tmpDir, ".gemini", "config", "plugins", "agy-dart");
    fs.mkdirSync(path.join(fakeClonedGlobal, ".git"), { recursive: true });
    assert.equal(isInsideInstalledPluginDir(fakeClonedGlobal), true);
  } finally {
    cleanTmpDir(tmpDir);
  }
});

test("v1.6-3: Git read-only sandbox blocks external diff/textconv/gpg config execution, status -v, and injects -n on remote show", async () => {
  // 3A. Flag validation unit checks
  assert.ok(SAFE_GIT_CONFIG_ARGS.includes("diff.external="));
  assert.ok(SAFE_GIT_CONFIG_ARGS.includes("gpg.program=false"));
  assert.ok(SAFE_GIT_CONFIG_ARGS.includes("gpg.ssh.program=false"));

  for (const blocked of [
    "status -v",
    "status --verbose",
    "status -sv",
    "status -bvv",
    "diff --ext-diff",
    "diff --ext",
    "log --textconv",
    "log --textc",
    "show --output=hack.txt",
    "log -c core.pager=evil"
  ]) {
    assert.throws(
      () => validateReadonlyGitArgs(blocked),
      /not allowed/,
      `Expected '${blocked}' to be rejected by validateReadonlyGitArgs`
    );
  }

  assert.deepEqual(validateReadonlyGitArgs("remote show origin"), [
    "--no-pager",
    "remote",
    "show",
    "-n",
    "origin"
  ]);
  assert.deepEqual(validateReadonlyGitArgs("shortlog -sn HEAD"), [
    "--no-pager",
    "shortlog",
    "--no-ext-diff",
    "--no-textconv",
    "-sn",
    "HEAD"
  ]);
  assert.deepEqual(validateReadonlyGitArgs("blame -L 1,5 a.txt"), [
    "--no-pager",
    "blame",
    "--no-textconv",
    "-L",
    "1,5",
    "a.txt"
  ]);

  // 3B. Live untrusted repository with malicious diff.external & textconv in .git/config
  const tmpRepo = makeTmpDir("agy-v16-gitsandbox-");
  try {
    const runGit = (args) =>
      spawnSync("git", args, { cwd: tmpRepo, encoding: "utf8", windowsHide: true });
    assert.equal(runGit(["init"]).status, 0);
    assert.equal(runGit(["config", "user.email", "test@example.com"]).status, 0);
    assert.equal(runGit(["config", "user.name", "Test"]).status, 0);

    const markerPath = path.join(tmpRepo, "PWNED_MARKER.txt").replace(/\\/g, "/");
    const evilCmd = `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync(${JSON.stringify(markerPath)}, 'pwned')"`;
    assert.equal(runGit(["config", "diff.external", evilCmd]).status, 0);
    assert.equal(runGit(["config", "diff.evil.textconv", evilCmd]).status, 0);
    assert.equal(runGit(["config", "core.fsmonitor", evilCmd]).status, 0);
    fs.writeFileSync(path.join(tmpRepo, ".gitattributes"), "*.txt diff=evil\n", "utf8");
    fs.writeFileSync(path.join(tmpRepo, "hello.txt"), "line 1\n", "utf8");
    assert.equal(
      spawnSync("git", ["-c", "core.fsmonitor=false", "add", "."], { cwd: tmpRepo, encoding: "utf8", windowsHide: true }).status,
      0
    );
    assert.equal(
      spawnSync("git", ["-c", "core.fsmonitor=false", "commit", "-m", "initial"], {
        cwd: tmpRepo,
        encoding: "utf8",
        windowsHide: true
      }).status,
      0
    );
    fs.writeFileSync(path.join(tmpRepo, "hello.txt"), "line 1\nline 2\n", "utf8");

    // Full hooks/session-start.mjs (including repo-skeleton getGitHeadSha) & snapshot must NOT execute fsmonitor/diff.external/textconv
    const snap = await buildWorkspaceSnapshot(tmpRepo, { maxChars: 1500, gitTimeoutMs: 2000 });
    assert.ok(snap.includes("Modified"));
    assert.equal(fs.existsSync(markerPath), false, "SessionStart snapshot must never trigger .git/config hooks");

    const fullHookRes = spawnSync(
      process.execPath,
      [path.join(ROOT, "hooks", "session-start.mjs")],
      {
        cwd: tmpRepo,
        input: JSON.stringify({ cwd: tmpRepo, workspacePaths: [tmpRepo], hookEventName: "SessionStart" }),
        encoding: "utf8",
        timeout: 6000,
        windowsHide: true,
        env: { ...process.env, AGY_DART_DB_PATH: path.join(tmpRepo, ".test-ss.db") }
      }
    );
    assert.equal(fullHookRes.status, 0, fullHookRes.stderr);
    assert.equal(fs.existsSync(markerPath), false, "hooks/session-start.mjs + repo-skeleton must never trigger core.fsmonitor");

    const { runBatchSearch } = await import("../fast/mcp-server.mjs");
    const searchRes = await runBatchSearch({
      cwd: tmpRepo,
      queries: [
        { type: "git", pattern: "diff" },
        { type: "git", pattern: "log -p -n 1" },
        { type: "git", pattern: "blame hello.txt" }
      ]
    });
    assert.equal(searchRes.isError, false);
    assert.ok(searchRes.text.includes("+line 2"));
    assert.equal(fs.existsSync(markerPath), false, "batch_search(git) must block diff.external & textconv");
  } finally {
    cleanTmpDir(tmpRepo);
  }
});

test("v1.6-4: 170s shared monotonic call budget, stringified arguments/edits self-healing, flat lineRanges & Water-Filling quota", async () => {
  const tmpDir = makeTmpDir("agy-v16-p2-");
  try {
    // 4A. computeWaterFillBudgets invariants
    assert.deepEqual(computeWaterFillBudgets([], 1000), []);
    assert.deepEqual(computeWaterFillBudgets([100, 200], 0), [0, 0]);
    assert.deepEqual(computeWaterFillBudgets([-5, NaN, 120], 500), [0, 0, 120]);
    assert.deepEqual(computeWaterFillBudgets([80, 90, 100, 110, 120, 8000], 6000), [
      80, 90, 100, 110, 120, 5500
    ]);
    const equal3 = computeWaterFillBudgets([2000, 2000, 2000], 1000);
    assert.equal(equal3.reduce((a, b) => a + b, 0), 1000);
    assert.ok(equal3.every((v) => v >= 333 && v <= 334));

    // 4B. parseFlatLineRangeSpec (POSIX + Windows drive letters + invalid cases)
    assert.deepEqual(parseFlatLineRangeSpec("src/app.ts:10-50,80-120"), {
      path: "src/app.ts",
      ranges: [
        [10, 50],
        [80, 120]
      ]
    });
    assert.deepEqual(parseFlatLineRangeSpec("E:\\work\\agy-dart\\fast\\mcp-server.mjs:1-60, 90-100"), {
      path: "E:\\work\\agy-dart\\fast\\mcp-server.mjs",
      ranges: [
        [1, 60],
        [90, 100]
      ]
    });
    assert.deepEqual(parseFlatLineRangeSpec("notes.md:42"), {
      path: "notes.md",
      ranges: [[42, 42]]
    });
    assert.deepEqual(parseFlatLineRangeSpec("foo:bar.ts:10-20"), {
      path: "foo:bar.ts",
      ranges: [[10, 20]]
    });
    assert.deepEqual(parseFlatLineRangeSpec("src/app.ts:L10-L50, l80-90"), {
      path: "src/app.ts",
      ranges: [
        [10, 50],
        [80, 90]
      ]
    });
    assert.throws(() => parseFlatLineRangeSpec(""), /non-empty/);
    assert.throws(() => parseFlatLineRangeSpec("src/no-range.ts"), /Invalid lineRanges/);
    assert.throws(() => parseFlatLineRangeSpec("src/app.ts:0-10"), /must be >= 1/);
    assert.throws(() => parseFlatLineRangeSpec("src/app.ts:50-10"), /startLine \(50\) > endLine \(10\)/);
    if (process.platform === "win32") {
      assert.throws(() => parseFlatLineRangeSpec("C:10-20"), /drive letter/);
    }

    // 4C. apply_edits JSON-stringified edits + empty/corrupted circuit breaker
    const targetFile = path.join(tmpDir, "str-edit.js");
    const strEditRes = await runApplyEdits({
      cwd: tmpDir,
      edits: JSON.stringify([{ path: "str-edit.js", create: "const x = 1;\nconst y = 2;\n" }])
    });
    assert.equal(strEditRes.isError, false, strEditRes.text);
    assert.equal(fs.readFileSync(targetFile, "utf8"), "const x = 1;\nconst y = 2;\n");

    for (const corrupted of [[], "[]", [null], [true], [42], ["not-an-obj"]]) {
      const badRes = await runApplyEdits({ cwd: tmpDir, edits: corrupted });
      assert.equal(badRes.isError, true);
      assert.match(badRes.text, /HOST_SERIALIZATION_CORRUPTION/);
      assert.match(badRes.text, /edit_file/);
    }

    // PostToolUse extractInvalidationTargets parses JSON-stringified edits & runReadSlices rejects malformed lineRanges
    const { extractInvalidationTargets } = await import("../hooks/post-tool-use.mjs");
    const invTargets = extractInvalidationTargets(
      "mcp_agy-dart_fast_apply_edits",
      { edits: JSON.stringify([{ path: "str-edit.js", create: "x" }]) },
      tmpDir
    );
    assert.deepEqual(invTargets.paths, [path.resolve(tmpDir, "str-edit.js")]);

    const badLrRes = await runReadSlices({ cwd: tmpDir, outlines: ["str-edit.js"], lineRanges: 12345 });
    assert.equal(badLrRes.isError, true, "Malformed non-array lineRanges must never be silently dropped");

    // Stringified params.arguments over live JSON-RPC
    const client = createBidirectionalMcpClient(path.join(ROOT, "fast", "mcp-server.mjs"));
    try {
      await client.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "p2-client", version: "1.0" }
      });
      const listResp = await client.request("tools/list", {});
      const byName = new Map(listResp.result.tools.map((t) => [t.name, t]));
      assert.equal(byName.get("apply_edits").inputSchema.properties.verifyTimeoutSec.maximum, 170);
      assert.equal(byName.get("run_checks").inputSchema.properties.timeoutSec.maximum, 170);
      assert.equal(byName.get("run_checks").inputSchema.properties.commands.items.properties.timeoutSec.maximum, 170);

      const strArgsCall = await client.request("tools/call", {
        name: "read_slices",
        arguments: JSON.stringify({
          lineRanges: [`${targetFile}:1-2`]
        })
      });
      assert.equal(strArgsCall.result.isError, false);
      assert.ok(strArgsCall.result.content[0].text.includes("const y = 2;"));

      const badArgsCall = await client.request("tools/call", {
        name: "read_slices",
        arguments: "[1,2,3]"
      });
      assert.equal(badArgsCall.error?.code, -32602);
    } finally {
      await client.close();
    }

    // 4D. Shared monotonic budget exhaustion in runChecks
    const budgetRes = await runChecks(
      {
        cwd: tmpDir,
        concurrency: 1,
        commands: [
          { name: "slow-1", command: `${JSON.stringify(process.execPath)} -e "setTimeout(()=>{}, 450)"` },
          { name: "skipped-2", command: `${JSON.stringify(process.execPath)} -e "console.log('NEVER_' + 'EXECUTED_TOKEN')"` }
        ]
      },
      { budgetMs: 600 }
    );
    assert.equal(budgetRes.isError, false);
    assert.match(budgetRes.text, /MCP call budget exhausted/);
    assert.equal(budgetRes.text.includes("NEVER_EXECUTED_TOKEN"), false);

    // 4E. Water-Filling in run_checks (5 short passes + 1 long failing stack trace)
    const stackFile = path.join(tmpDir, "emit-long-fail.cjs");
    fs.writeFileSync(
      stackFile,
      `const frames = Array.from({length: 45}, (_, i) => '    at step_' + i + ' (src/module_' + i + '.js:' + (i+10) + ':5)').join('\\n');\n` +
        `console.error('Error: WATER_FILL_DEEP_TAIL_SENTINEL_START\\n' + frames + '\\nWATER_FILL_DEEP_TAIL_SENTINEL_END');\n` +
        `process.exit(1);\n`,
      "utf8"
    );
    const wfCheckRes = await runChecks({
      cwd: tmpDir,
      outputMode: "full",
      maxChars: 8000,
      commands: [
        { name: "p1", command: `${JSON.stringify(process.execPath)} -e "console.log('ok1')"` },
        { name: "p2", command: `${JSON.stringify(process.execPath)} -e "console.log('ok2')"` },
        { name: "p3", command: `${JSON.stringify(process.execPath)} -e "console.log('ok3')"` },
        { name: "p4", command: `${JSON.stringify(process.execPath)} -e "console.log('ok4')"` },
        { name: "p5", command: `${JSON.stringify(process.execPath)} -e "console.log('ok5')"` },
        { name: "big-fail", command: `${JSON.stringify(process.execPath)} ${JSON.stringify(stackFile)}` }
      ]
    });
    assert.equal(wfCheckRes.isError, false);
    assert.ok(Buffer.byteLength(wfCheckRes.text, "utf8") <= 8800);
    assert.ok(wfCheckRes.text.includes("WATER_FILL_DEEP_TAIL_SENTINEL_START"));
    assert.ok(
      wfCheckRes.text.includes("WATER_FILL_DEEP_TAIL_SENTINEL_END"),
      `Water-filling should preserve ~2.5KB error stack when 5 sibling checks are short:\n${wfCheckRes.text}`
    );

    // 4F. Water-Filling in multi-file read_slices({ outlines })
    const tinyFiles = [];
    for (let i = 0; i < 11; i++) {
      const fp = path.join(tmpDir, `tiny_${i}.js`);
      fs.writeFileSync(fp, `export function tinyFn_${i}() { return ${i}; }\n`, "utf8");
      tinyFiles.push(`tiny_${i}.js`);
    }
    const bigHubLines = [];
    for (let i = 0; i < 40; i++) {
      bigHubLines.push(`export function hubSymbol_${i}() {\n  return ${i};\n}`);
    }
    fs.writeFileSync(path.join(tmpDir, "big_hub.js"), bigHubLines.join("\n") + "\n", "utf8");
    const multiOutline = await runReadSlices({
      cwd: tmpDir,
      outlines: [...tinyFiles, "big_hub.js"]
    });
    assert.equal(multiOutline.isError, false);
    assert.ok(Buffer.byteLength(multiOutline.text, "utf8") <= 8800);
    assert.ok(
      multiOutline.text.includes("hubSymbol_39"),
      "Water-filling should allow big_hub.js to show all 40 top-level symbols alongside 11 tiny files"
    );
  } finally {
    cleanTmpDir(tmpDir);
  }
});

test("successful compact test checks retain diagnostics within their batch budget", async () => {
  const cwd = makeTmpDir();
  const nestedTestContext = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    const note = "The regional warehouse handles this shipment.";
    const small = "node --test --test-reporter=tap small.test.cjs";
    const large = "node --test --test-reporter=tap large.test.cjs";
    fs.writeFileSync(path.join(cwd, "small.test.cjs"), [
      'console.log("x".repeat(360));',
      `console.log(${JSON.stringify(note)});`
    ].join("\n"));
    fs.writeFileSync(path.join(cwd, "large.test.cjs"), [
      'for (let n = 1; n <= 600; n++) {',
      '  console.log("Processing parcel " + n + " of 600");',
      '  if (n === 317) console.log("承运仓库：青岛");',
      '}'
    ].join("\n"));
    fs.writeFileSync(path.join(cwd, "other.cjs"), 'console.log("other-hidden\\nother-middle\\nother-last")');

    const single = await runChecks({ cwd, commands: [small] });
    assert.match(single.text, /Checks: 1\/1 passed/);
    assert.ok(single.text.includes("x".repeat(360)));
    assert.ok(single.text.includes(note));

    const batch = await runChecks({ cwd, commands: [small, large, "node other.cjs"], maxChars: 2000 });
    assert.match(batch.text, /Checks: 3\/3 passed/);
    assert.ok(batch.text.includes(note));
    assert.ok(batch.text.includes("承运仓库：青岛"));
    assert.match(batch.text, /omitted|compacted/);
    assert.match(batch.text, /other-last/);
    assert.doesNotMatch(batch.text, /other-hidden/);
    assert.ok(batch.text.length <= 2000);
    assert.ok(Buffer.byteLength(batch.text) <= 8800);

    const edit = await runApplyEdits({ cwd, edits: [{ path: "edited.txt", create: "ok" }], verify: small });
    assert.match(edit.text, /Verify \[PASS/);
    assert.ok(edit.text.includes(note));

    const cities = ["青岛", "天津", "武汉", "沈阳", "广州", "厦门", "昆明", "成都", "太原", "长春"];
    const records = cities.map(city => `${city}仓库今日只接收已登记的包裹，请先核对收货人。`);
    fs.writeFileSync(path.join(cwd, "cities.test.cjs"), [
      'const test = require("node:test");',
      `for (const city of ${JSON.stringify(records)}) console.log(city);`,
      'for (let i = 0; i < 15; i++) test("reporter noise " + i, () => {});'
    ].join("\n"));
    const cityCheck = "node --test --test-reporter=tap cities.test.cjs";
    const cityBatch = await runChecks({ cwd, commands: [cityCheck, "node other.cjs"], maxChars: 640 });
    const cityEdit = await runApplyEdits({
      cwd, edits: [{ path: "cities.txt", create: "ok" }], verify: cityCheck, maxVerifyChars: 480
    });
    assert.match(cityBatch.text, /Checks: 2\/2 passed/);
    assert.ok(cityBatch.text.length <= 640);
    assert.match(cityEdit.text, /Verify \[PASS/);
    for (const record of records) {
      assert.ok(cityBatch.text.includes(record), `Missing from checks: ${record}`);
      assert.ok(cityEdit.text.includes(record), `Missing from verification: ${record}`);
    }
  } finally {
    if (nestedTestContext !== undefined) process.env.NODE_TEST_CONTEXT = nestedTestContext;
    cleanTmpDir(cwd);
  }
});

test("v1.6-5: Phase 3 installer --tool-loading persistence, rules/*.local.md preservation, GEMINI_HOME & T3 ACP multi-host sync, and OSS metadata", () => {
  const tmpDir = makeTmpDir("agy-v16-p3-");
  try {
    // 5A. buildMcpConfigObject modes (per-tool `tools.<name>.eager = true` matching Antigravity host schema)
    const fe = buildMcpConfigObject("fast-eager");
    assert.equal(fe.mcpServers.fast.eager, undefined);
    assert.deepEqual(Object.keys(fe.mcpServers.fast.tools).sort(), [
      "apply_edits",
      "batch_search",
      "read_slices",
      "run_checks"
    ]);
    assert.equal(fe.mcpServers.fast.tools.apply_edits.eager, true);
    assert.equal(fe.mcpServers.context.tools, undefined);

    const lz = buildMcpConfigObject("lazy");
    assert.equal(lz.mcpServers.fast.tools, undefined);
    assert.equal(lz.mcpServers.context.tools, undefined);

    const eg = buildMcpConfigObject("eager");
    assert.equal(eg.mcpServers.fast.tools.batch_search.eager, true);
    assert.equal(Object.keys(eg.mcpServers.context.tools).length, 8);
    assert.equal(eg.mcpServers.context.tools.ctx_execute.eager, true);

    // 5B. Install preserves rules/*.local.md & prunes stale files, switches --tool-loading cleanly
    const installDir = path.join(tmpDir, "custom-target");
    const cfgFile = path.join(tmpDir, "user-config.json");
    const dbFile = path.join(tmpDir, "inst.db");
    const instEnv = { ...process.env, AGY_DART_CONFIG_PATH: cfgFile, AGY_DART_DB_PATH: dbFile };

    const r1 = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts", "install.mjs"), "install", "--target", installDir],
      { encoding: "utf8", windowsHide: true, env: instEnv }
    );
    assert.equal(r1.status, 0, `${r1.stdout}\n${r1.stderr}`);
    const mcp1 = JSON.parse(fs.readFileSync(path.join(installDir, "mcp_config.json"), "utf8"));
    assert.equal(mcp1.mcpServers.fast.tools.apply_edits.eager, true);
    assert.equal(mcp1.mcpServers.context.tools, undefined);
    assert.equal(fs.existsSync(path.join(installDir, "SECURITY.md")), true);
    assert.equal(fs.existsSync(path.join(installDir, "assets", "logo.svg")), true);
    assert.equal(fs.existsSync(path.join(installDir, "assets", "architecture-dark.svg")), false);

    // Create user local rule + obsolete file, then re-install with --tool-loading eager
    const localRulePath = path.join(installDir, "rules", "my-team.local.md");
    const staleHookPath = path.join(installDir, "hooks", "obsolete-old.mjs");
    fs.writeFileSync(localRulePath, "# Custom Team Rule\n", "utf8");
    fs.writeFileSync(staleHookPath, "// stale\n", "utf8");

    const r2 = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts", "install.mjs"), "install", "--target", installDir, "--tool-loading", "eager"],
      { encoding: "utf8", windowsHide: true, env: instEnv }
    );
    assert.equal(r2.status, 0, `${r2.stdout}\n${r2.stderr}`);
    assert.equal(fs.existsSync(localRulePath), true, "rules/*.local.md MUST be preserved across upgrades");
    assert.equal(fs.readFileSync(localRulePath, "utf8"), "# Custom Team Rule\n");
    assert.equal(fs.existsSync(staleHookPath), false, "Stale non-local files MUST still be pruned");
    const mcp2 = JSON.parse(fs.readFileSync(path.join(installDir, "mcp_config.json"), "utf8"));
    assert.equal(mcp2.mcpServers.fast.tools.batch_search.eager, true);
    assert.equal(mcp2.mcpServers.context.tools.ctx_execute.eager, true);

    // Switch via `tool-loading lazy` subcommand
    const r3 = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts", "install.mjs"), "tool-loading", "lazy", "--target", installDir],
      { encoding: "utf8", windowsHide: true, env: instEnv }
    );
    assert.equal(r3.status, 0, `${r3.stdout}\n${r3.stderr}`);
    const mcp3 = JSON.parse(fs.readFileSync(path.join(installDir, "mcp_config.json"), "utf8"));
    assert.equal(mcp3.mcpServers.fast.tools, undefined);
    assert.equal(mcp3.mcpServers.context.tools, undefined);

    // 5C. Multi-host discovery (GEMINI_HOME + ~/.t3/userdata/providers/antigravity/*/)
    const fakeHome = path.join(tmpDir, "fake-home");
    const fakeGeminiHome = path.join(tmpDir, "custom-gemini-home");
    const t3ProfileA = path.join(fakeHome, ".t3", "userdata", "providers", "antigravity", "profile-alpha");
    const t3ProfileB = path.join(fakeHome, ".t3", "userdata", "providers", "antigravity", "profile-beta", "plugins");
    fs.mkdirSync(fakeGeminiHome, { recursive: true });
    fs.mkdirSync(t3ProfileA, { recursive: true });
    fs.mkdirSync(t3ProfileB, { recursive: true });

    const extraTargets = discoverExtraHostPluginTargets({
      homeDir: fakeHome,
      env: { GEMINI_HOME: fakeGeminiHome },
      primaryTargetDir: path.join(fakeHome, ".gemini", "config", "plugins", "agy-dart")
    });
    assert.equal(extraTargets.length, 3);
    assert.ok(extraTargets.some((p) => p.includes("custom-gemini-home")));
    assert.ok(extraTargets.some((p) => p.includes("profile-alpha")));
    assert.ok(extraTargets.some((p) => p.includes("profile-beta")));

    // 5D. Glama / Security / Dockerfile / Adaptive SVG assets
    const glama = JSON.parse(fs.readFileSync(path.join(ROOT, "glama.json"), "utf8"));
    assert.equal(glama.$schema, "https://glama.ai/mcp/schemas/server.json");
    assert.ok(Array.isArray(glama.maintainers) && glama.maintainers.includes("zou172866"));
    assert.ok(fs.existsSync(path.join(ROOT, "SECURITY.md")));
    const dockerfile = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
    assert.match(dockerfile, /^USER node$/m);
    assert.ok(fs.existsSync(path.join(ROOT, "assets", "architecture-dark.svg")));
    assert.ok(fs.existsSync(path.join(ROOT, "assets", "architecture-light.svg")));
    assert.ok(fs.existsSync(path.join(ROOT, "assets", "demo-comparison.svg")));
  } finally {
    resetConfigCache();
    cleanTmpDir(tmpDir);
  }
});

test("global uninstall removes owned secondary hosts after environment changes and keeps independent copies", t => {
  const home = makeTmpDir("agy-synced-hosts-");
  t.after(() => cleanTmpDir(home));
  const gemini = path.join(home, "custom-gemini");
  const t3 = path.join(home, ".t3", "userdata", "providers", "antigravity");
  const primary = path.join(home, ".gemini", "config", "plugins", "agy-dart");
  const secondary = path.join(gemini, ".gemini", "config", "plugins", "agy-dart");
  const managedT3 = path.join(t3, "managed", "plugins", "agy-dart");
  const standalone = path.join(t3, "independent", "plugins", "agy-dart");
  fs.mkdirSync(gemini);
  fs.mkdirSync(path.dirname(managedT3), { recursive: true });
  // An older synced copy and an independent install have identical, unmarked manifests.
  fs.mkdirSync(standalone, { recursive: true });
  fs.writeFileSync(path.join(standalone, "plugin.json"), '{"name":"agy-dart"}');
  fs.writeFileSync(path.join(standalone, "hooks.json"), "independently configured");
  const env = { ...process.env, HOME: home, USERPROFILE: home, GEMINI_HOME: gemini,
    AGY_DART_DB_PATH: path.join(home, "ctx.db"), AGY_DART_CONFIG_PATH: path.join(home, "config.json") };
  const run = (...args) => spawnSync(process.execPath, [path.join(ROOT, "scripts/install.mjs"), ...args],
    { env, encoding: "utf8", windowsHide: true });
  const cli = (...args) => {
    const r = run(...args);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return r.stdout;
  };
  assert.match(cli("install", "--with-devtools"), /Kept untracked secondary host/);
  for (const dst of [secondary, managedT3]) assert.ok(fs.existsSync(path.join(dst, "hooks.json")));
  // Two primary roots can use the same home when a configuration link is switched.
  const globalDir = path.join(home, ".gemini");
  const savedGlobal = path.join(home, "original-gemini-profile");
  const otherGlobal = path.join(home, "alternate-gemini-profile");
  const receipts = path.join(home, ".agy-dart", "synced-hosts");
  const originalReceipts = fs.readdirSync(receipts).sort();
  assert.equal(originalReceipts.length, 2);
  fs.mkdirSync(otherGlobal);
  fs.renameSync(globalDir, savedGlobal);
  fs.symlinkSync(otherGlobal, globalDir, process.platform === "win32" ? "junction" : "dir");
  cli("uninstall");
  assert.ok(fs.existsSync(path.join(secondary, "hooks.json")), "other primary leaves this owner's copies installed");
  assert.deepEqual(fs.readdirSync(receipts).sort(), originalReceipts, "other primary retains the original receipts");
  fs.unlinkSync(globalDir);
  fs.renameSync(savedGlobal, globalDir);
  const localRule = path.join(secondary, "rules", "user.local.md");
  fs.writeFileSync(localRule, "# user's rule");
  fs.writeFileSync(path.join(secondary, "local-notes.txt"), "user content");
  cli("install");
  assert.ok(!fs.existsSync(path.join(secondary, "fast", "benchmark.mjs")), "obsolete devtools removed on upgrade");
  assert.equal(fs.readFileSync(path.join(secondary, "local-notes.txt"), "utf8"), "user content");
  const project = path.join(home, "workspace");
  const projectTarget = path.join(project, ".agents", "plugins", "agy-dart");
  fs.mkdirSync(projectTarget, { recursive: true });
  fs.writeFileSync(path.join(projectTarget, "plugin.json"), '{"name":"agy-dart"}');
  cli("uninstall", "--project", project);
  assert.ok(!fs.existsSync(projectTarget));
  assert.ok(fs.existsSync(path.join(primary, "hooks.json")));
  assert.ok(fs.existsSync(path.join(secondary, "hooks.json")));
  cli("uninstall", "--no-sync-hosts");
  assert.ok(!fs.existsSync(primary));
  assert.ok(fs.existsSync(path.join(secondary, "hooks.json")));
  delete env.GEMINI_HOME;
  const busyFile = path.join(secondary, "fast", "session-start.mjs");
  fs.unlinkSync(busyFile);
  fs.mkdirSync(busyFile);
  assert.notEqual(run("uninstall").status, 0, "incomplete removal must report failure");
  fs.rmdirSync(busyFile);
  assert.match(cli("uninstall"), /Kept untracked secondary host/);
  assert.ok(!fs.existsSync(path.join(secondary, "hooks.json")));
  assert.ok(!fs.existsSync(path.join(secondary, "plugin.json")));
  assert.ok(!fs.existsSync(managedT3));
  assert.equal(fs.readFileSync(localRule, "utf8"), "# user's rule");
  assert.equal(fs.readFileSync(path.join(standalone, "hooks.json"), "utf8"), "independently configured");
  assert.ok(fs.existsSync(env.AGY_DART_DB_PATH), "uninstall preserves the user database");
  env.GEMINI_HOME = gemini;
  cli("install");
  assert.ok(fs.existsSync(path.join(secondary, "hooks.json")), "reinstall restores managed runtime alongside user files");
  cli("install", "--target", managedT3);
  cli("uninstall");
  assert.ok(fs.existsSync(path.join(managedT3, "hooks.json")), "explicit reinstall transfers ownership to standalone");
  cli("uninstall", "--target", managedT3);
  assert.ok(!fs.existsSync(managedT3));
});

test("batch_search keeps late Unicode matches visible on long lines across both backends", async t => {
  const cwd = makeTmpDir();
  t.after(() => cleanTmpDir(cwd));
  const context = "🙂".repeat(150);
  const before = "文🙂".repeat(129);
  const after = "🟢".repeat(150);
  fs.writeFileSync(path.join(cwd, "long.txt"), [
    context, before + "针🧵尾" + after, "early" + after,
    before + "FIRST", "SECOND" + after, before + "END"
  ].join("\r\n"));
  for (const forceNodeFallback of [false, true]) {
    const search = async query => {
      const { text } = await runBatchSearch({
        cwd, queries: [{ path: "long.txt", ...query }]
      }, { forceNodeFallback });
      assert.ok(text.isWellFormed(), "snippet boundaries must preserve surrogate pairs");
      return text.split("\n").filter(line => /^  \d/.test(line));
    };
    const near = await search({ type: "text", pattern: "针🧵尾", contextLines: 1 });
    assert.equal(near[0], "  1- " + context.slice(0, 240) + "...");
    assert.match(near[1], /^  2: \.\.\..*针🧵尾.*\.\.\.$/);
    assert.equal(near[2], "  3- " + ("early" + after).slice(0, 239) + "...");
    const early = await search({ type: "text", pattern: "early" });
    assert.equal(early[0], near[2].replace("3-", "3:"));
    const multi = await search({ type: "regex", multiline: true, pattern: "FIRST\\r?\\nSECOND" });
    assert.match(multi[0], /^  4: \.\.\..*FIRST$/);
    assert.match(multi[1], /^  5: SECOND.*\.\.\.$/);
    const end = await search({ type: "regex", pattern: "END$" });
    assert.match(end[0], /^  6: \.\.\..*END$/);
  }
});
