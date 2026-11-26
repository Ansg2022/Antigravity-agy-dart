import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import zlib from "node:zlib";

import { RUNTIME_FILES } from "../scripts/install.mjs";
import { verifyPackageManifest } from "../scripts/verify-package-graph.mjs";
import {
  closeRuntimeStore,
  createStandaloneServer,
  handlePluginUpdate,
  handleVersionCheck,
  registerSidecarRoutes
} from "../sidecars/dashboard/server.mjs";
import { downloadArchive, readReleaseArchive, UpdateError } from "../sidecars/dashboard/update-archive.mjs";
import {
  compareVersions,
  createVersionChecker,
  parseVersion,
  readLocalVersion,
  RELEASES_URL,
  VERSION_ROUTE
} from "../sidecars/dashboard/version-check.mjs";
import {
  createPluginUpdater,
  resolveInstalledRoot,
  UPDATE_MARKER_NAME,
  UPDATE_ROUTE
} from "../sidecars/dashboard/version-update.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function makeTarHeader(name, size, typeByte, { prefix = "", mode = typeByte === 53 ? 0o755 : 0o644 } = {}) {
  const header = Buffer.alloc(512, 0);
  Buffer.from(name, "utf8").copy(header, 0, 0, 100);
  Buffer.from(mode.toString(8).padStart(7, "0") + "\0", "latin1").copy(header, 100);
  Buffer.from("0000000\0", "latin1").copy(header, 108);
  Buffer.from("0000000\0", "latin1").copy(header, 116);
  Buffer.from(size.toString(8).padStart(11, "0") + "\0", "latin1").copy(header, 124);
  Buffer.from("00000000000\0", "latin1").copy(header, 136);
  Buffer.from("        ", "latin1").copy(header, 148);
  header[156] = typeByte;
  Buffer.from("ustar\0", "latin1").copy(header, 257);
  Buffer.from("00", "latin1").copy(header, 263);
  if (prefix) Buffer.from(prefix, "utf8").copy(header, 345, 0, 155);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i];
  Buffer.from(sum.toString(8).padStart(6, "0") + "\0 ", "latin1").copy(header, 148);
  return header;
}

function makePaxRecord(key, value) {
  const body = `${key}=${value}\n`;
  let len = Buffer.byteLength(body, "utf8") + 3;
  while (true) {
    const candidate = `${len} ${body}`;
    const actual = Buffer.byteLength(candidate, "utf8");
    if (actual === len) return Buffer.from(candidate, "utf8");
    len = actual;
  }
}

function buildTarGz(entries, { includeGlobalComment = false, corruptChecksum = false } = {}) {
  const blocks = [];
  if (includeGlobalComment) {
    const comment = Buffer.from(`52 comment=${"a".repeat(40)}\n`, "latin1");
    blocks.push(makeTarHeader("pax_global_header", comment.length, 103));
    blocks.push(comment);
    const pad = (512 - (comment.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad, 0));
  }
  for (const entry of entries) {
    const contentBuf = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(entry.content || "", "utf8");
    const typeByte = entry.type ?? 48;
    if (entry.paxRecords) {
      const paxBuf = Buffer.concat(entry.paxRecords.map(([k, v]) => makePaxRecord(k, v)));
      blocks.push(makeTarHeader("PaxHeader", paxBuf.length, 120));
      blocks.push(paxBuf);
      const pad = (512 - (paxBuf.length % 512)) % 512;
      if (pad) blocks.push(Buffer.alloc(pad, 0));
    }
    const hdr = makeTarHeader(entry.name, typeByte === 53 ? 0 : contentBuf.length, typeByte, {
      prefix: entry.prefix || ""
    });
    if (corruptChecksum) hdr[148] = 0x41;
    blocks.push(hdr);
    if (typeByte !== 53 && contentBuf.length > 0) {
      blocks.push(contentBuf);
      const pad = (512 - (contentBuf.length % 512)) % 512;
      if (pad) blocks.push(Buffer.alloc(pad, 0));
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(blocks));
}

function makeMockJsonRes(status, body, headers = {}) {
  const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (k) => headerMap.get(k.toLowerCase()) ?? null
    },
    json: async () => (typeof body === "string" ? JSON.parse(body) : body)
  };
}

function makeMockStreamRes(status, buffer, headers = {}, url = "") {
  const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  let consumed = false;
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: {
      get: (k) => headerMap.get(k.toLowerCase()) ?? null
    },
    body: {
      cancel: async () => {},
      getReader: () => ({
        read: async () => {
          if (consumed) return { done: true, value: undefined };
          consumed = true;
          return { done: false, value: new Uint8Array(buffer) };
        },
        releaseLock: () => {}
      })
    }
  };
}

function createReleaseArchiveEntries(version, { extraRuntimeFiles = {}, brokenImport = false } = {}) {
  const rootPrefix = `Antigravity-agy-dart-${version}`;
  const runtimeList = [...RUNTIME_FILES, ...Object.keys(extraRuntimeFiles)];
  const installScript = `export const FAST_MCP_TOOL_NAMES = Object.freeze(["apply_edits", "batch_search", "read_slices", "run_checks"]);
export const CONTEXT_MCP_TOOL_NAMES = Object.freeze(["ctx_batch", "ctx_doctor", "ctx_execute", "ctx_index", "ctx_purge", "ctx_resume", "ctx_search", "ctx_stats"]);
export const RUNTIME_FILES = Object.freeze(${JSON.stringify(runtimeList, null, 2)});
`;
  const sidecarJson = fs.readFileSync(path.join(ROOT, "sidecars/dashboard/sidecar.json"), "utf8");
  const mcpJson = fs.readFileSync(path.join(ROOT, "mcp_config.json"), "utf8");
  const hooksJson = fs.readFileSync(path.join(ROOT, "hooks.json"), "utf8");

  const filesMap = new Map();
  for (const rel of RUNTIME_FILES) {
    filesMap.set(rel, `// stub for ${rel}`);
  }
  filesMap.set("plugin.json", JSON.stringify({ name: "agy-dart", version }, null, 2));
  filesMap.set("package.json", JSON.stringify({ name: "agy-dart", version, type: "module" }, null, 2));
  filesMap.set("mcp_config.json", mcpJson);
  filesMap.set("hooks.json", hooksJson);
  filesMap.set("sidecars/dashboard/sidecar.json", sidecarJson);
  filesMap.set(
    "sidecars/dashboard/server.mjs",
    brokenImport ? 'import "./does-not-exist.mjs";\n' : 'import "./version-check.mjs";\nexport const v = 1;\n'
  );
  filesMap.set("sidecars/dashboard/index.html", `<html><span id="dashboard-version">--</span></html>`);
  filesMap.set("sidecars/dashboard/version-check.mjs", `export const v = "${version}";\n`);
  filesMap.set("sidecars/dashboard/update-archive.mjs", `export const a = 1;\n`);
  filesMap.set("sidecars/dashboard/version-update.mjs", `export const u = 1;\n`);
  filesMap.set("scripts/install.mjs", installScript);
  filesMap.set("context/server.js", "// ctx\n");
  filesMap.set("fast/mcp-server.mjs", "// fast\n");
  for (const [rel, content] of Object.entries(extraRuntimeFiles)) {
    filesMap.set(rel, content);
  }

  return Array.from(filesMap.entries()).map(([rel, content]) => ({
    name: `${rootPrefix}/${rel}`,
    content
  }));
}

async function httpRequest(port, reqPath, { method = "POST", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: reqPath,
        method,
        headers: {
          Host: `127.0.0.1:${port}`,
          Origin: `http://127.0.0.1:${port}`,
          Referer: `http://127.0.0.1:${port}/`,
          ...headers
        }
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      }
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test("v1.7.5-1: version-check SemVer parsing, comparison, rate-limit, caching & auto/manual modes", async () => {
  assert.deepEqual(parseVersion("v1.7.2")?.version, "1.7.2");
  assert.equal(parseVersion("1.7.2-beta.1")?.pre.length, 2);
  assert.equal(parseVersion("1.7.2-01"), null);
  assert.equal(parseVersion("invalid"), null);

  assert.equal(compareVersions("1.8.0", "1.7.2"), 1);
  assert.equal(compareVersions("1.7.2", "1.7.2"), 0);
  assert.equal(compareVersions("1.7.1", "1.7.2"), -1);
  assert.equal(compareVersions("1.8.0", "1.8.0-rc.1"), 1);
  assert.equal(compareVersions(readLocalVersion(ROOT), "1.0.0"), 1);

  let fakeNow = 1_000_000;
  let fetchCalls = 0;
  const checker = createVersionChecker({
    getCurrentVersion: () => "1.7.2",
    now: () => fakeNow,
    fetchImpl: async () => {
      fetchCalls += 1;
      return makeMockJsonRes(200, {
        tag_name: "v1.8.0",
        draft: false,
        prerelease: false,
        published_at: "2026-11-26T00:00:00Z"
      });
    }
  });

  // Concurrent auto + manual share single-flight request
  const [rAuto, rManual] = await Promise.all([checker("auto"), checker("manual")]);
  assert.equal(fetchCalls, 1);
  assert.equal(rAuto.status, "update");
  assert.equal(rManual.status, "update");
  assert.equal(rManual.latestVersion, "1.8.0");
  assert.equal(rManual.releaseUrl, `${RELEASES_URL}/tag/v1.8.0`);

  // Manual 5s dedupe reuses recent result unless fresh=true
  await checker("manual");
  assert.equal(fetchCalls, 1);
  await checker("manual", { fresh: true });
  assert.equal(fetchCalls, 2);

  // Invalid mode returns error
  const invalidMode = await checker("bogus");
  assert.equal(invalidMode.status, "error");
  assert.equal(invalidMode.reason, "invalidMode");

  // Rate-limit & prerelease/404/network handling
  let scenario = "429";
  let limitCalls = 0;
  const errChecker = createVersionChecker({
    getCurrentVersion: () => "1.7.2",
    now: () => fakeNow,
    fetchImpl: async () => {
      limitCalls += 1;
      if (scenario === "429") {
        return makeMockJsonRes(429, { message: "rate limit" }, { "retry-after": "120" });
      }
      if (scenario === "prerelease") {
        return makeMockJsonRes(200, { tag_name: "v1.9.0-rc.1", prerelease: true, draft: false });
      }
      if (scenario === "404") return makeMockJsonRes(404, {});
      throw new Error("ECONNREFUSED");
    }
  });

  const rlAuto = await errChecker("auto");
  assert.equal(rlAuto.status, "idle", "auto mode suppresses errors into idle");
  const rlManual = await errChecker("manual");
  assert.equal(rlManual.status, "error");
  assert.equal(rlManual.reason, "rateLimit");
  assert.equal(limitCalls, 1, "active rateLimit cooldown prevents extra fetches");

  fakeNow += 130_000;
  scenario = "prerelease";
  const preRes = await errChecker("manual", { fresh: true });
  assert.equal(preRes.reason, "invalidRelease");

  scenario = "404";
  const notFoundRes = await errChecker("manual", { fresh: true });
  assert.equal(notFoundRes.reason, "noRelease");

  scenario = "net";
  const netRes = await errChecker("manual", { fresh: true });
  assert.equal(netRes.reason, "network");
});

test("v1.7.5-2: update-archive validates HTTPS redirects, size limits, pax/ustar paths & rejects symlinks/traversal", async () => {
  // Valid redirect within allowed GitHub hosts
  const samplePayload = Buffer.from("hello-tarball");
  let step = 0;
  const downloaded = await downloadArchive("https://api.github.com/repos/zou172866/Antigravity-agy-dart/tarball/v1.8.0", {
    fetchImpl: async (url) => {
      step += 1;
      if (step === 1) {
        return makeMockStreamRes(302, Buffer.alloc(0), { location: "https://codeload.github.com/archive.tar.gz" }, url);
      }
      return makeMockStreamRes(200, samplePayload, { "content-length": String(samplePayload.length) }, url);
    }
  });
  assert.deepEqual(downloaded, samplePayload);

  // Disallowed redirect host blocked
  await assert.rejects(
    downloadArchive("https://api.github.com/repos/zou172866/Antigravity-agy-dart/tarball/v1.8.0", {
      fetchImpl: async () => makeMockStreamRes(302, Buffer.alloc(0), { location: "https://evil.example.com/a.tgz" })
    }),
    (err) => err instanceof UpdateError && err.reason === "redirect"
  );

  // Oversize archive rejected
  await assert.rejects(
    downloadArchive("https://api.github.com/repos/zou172866/Antigravity-agy-dart/tarball/v1.8.0", {
      maxBytes: 8,
      fetchImpl: async () => makeMockStreamRes(200, Buffer.alloc(16, 1), {})
    }),
    (err) => err instanceof UpdateError && err.reason === "size"
  );

  // Valid GitHub pax + ustar archive strips top-level folder
  const validTgz = buildTarGz(
    [
      { name: "repo-v1.8.0/plugin.json", content: '{"name":"agy-dart","version":"1.8.0"}' },
      {
        name: "repo-v1.8.0/ignored",
        content: "long-path-content",
        paxRecords: [["path", "repo-v1.8.0/skills/agy-dart/references/long-doc.md"]]
      }
    ],
    { includeGlobalComment: true }
  );
  const parsedMap = await readReleaseArchive(validTgz);
  assert.equal(parsedMap.get("plugin.json")?.toString("utf8"), '{"name":"agy-dart","version":"1.8.0"}');
  assert.equal(parsedMap.get("skills/agy-dart/references/long-doc.md")?.toString("utf8"), "long-path-content");

  // Reject symlinks, traversal, Windows reserved names, case-collisions, pax linkpath & bad checksum
  for (const badEntries of [
    [{ name: "repo-v1.8.0/evil-link", content: "", type: 50 }],
    [{ name: "repo-v1.8.0/../escape.txt", content: "x" }],
    [{ name: "repo-v1.8.0/CON.txt", content: "x" }],
    [
      { name: "repo-v1.8.0/File.txt", content: "a" },
      { name: "repo-v1.8.0/file.txt", content: "b" }
    ],
    [{ name: "repo-v1.8.0/a.txt", content: "x", paxRecords: [["linkpath", "/etc/passwd"]] }]
  ]) {
    await assert.rejects(readReleaseArchive(buildTarGz(badEntries)), (err) => err instanceof UpdateError && err.reason === "archive");
  }
  await assert.rejects(
    readReleaseArchive(buildTarGz([{ name: "repo-v1.8.0/a.txt", content: "x" }], { corruptChecksum: true })),
    (err) => err instanceof UpdateError && err.reason === "archive"
  );
});

test("v1.7.5-3: version-update atomically replaces files, preserves local settings/rules, blocks git checkout & rolls back on error", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v175-upd-"));
  try {
    const pluginsDir = path.join(tmpDir, "plugins");
    const installedRoot = path.join(pluginsDir, "agy-dart");
    const sidecarDir = path.join(installedRoot, "sidecars", "dashboard");
    fs.mkdirSync(sidecarDir, { recursive: true });
    fs.mkdirSync(path.join(installedRoot, "rules"), { recursive: true });
    fs.mkdirSync(path.join(installedRoot, "legacy"), { recursive: true });

    fs.writeFileSync(path.join(installedRoot, "plugin.json"), JSON.stringify({ name: "agy-dart", version: "1.7.2" }));
    fs.writeFileSync(path.join(installedRoot, "package.json"), JSON.stringify({ name: "agy-dart", version: "1.7.2" }));
    fs.writeFileSync(path.join(sidecarDir, "sidecar.json"), fs.readFileSync(path.join(ROOT, "sidecars/dashboard/sidecar.json"), "utf8"));
    fs.writeFileSync(path.join(sidecarDir, "server.mjs"), "// old server\n");
    fs.writeFileSync(path.join(installedRoot, "rules", "custom.local.md"), "# User local override\n");
    fs.writeFileSync(path.join(installedRoot, "legacy", "obsolete.js"), "// obsolete\n");

    // Existing installation configured eager MCP tools + no-read-hook mode
    const eagerMcp = {
      mcpServers: {
        fast: { command: "node", args: ["${PLUGIN_ROOT}/fast/mcp-server.mjs"], tools: { apply_edits: { eager: true } } },
        context: { command: "node", args: ["${PLUGIN_ROOT}/context/server.js"], tools: { ctx_search: { eager: true } } }
      }
    };
    fs.writeFileSync(path.join(installedRoot, "mcp_config.json"), JSON.stringify(eagerMcp));
    fs.writeFileSync(
      path.join(installedRoot, "hooks.json"),
      JSON.stringify({ "agy-dart-lifecycle": { PreToolUse: [{ matcher: "run_command", hooks: [] }] } })
    );

    const tgz180 = buildTarGz(
      createReleaseArchiveEntries("1.8.0", {
        extraRuntimeFiles: {
          "context/lib/new-module.js": "// new module\n"
        }
      })
    );

    const checkVersion = async () => ({
      ok: true,
      status: "update",
      currentVersion: "1.7.2",
      latestVersion: "1.8.0",
      releaseTag: "v1.8.0",
      releaseUrl: `${RELEASES_URL}/tag/v1.8.0`
    });

    // 1. Atomic rollback test when move fails mid-replace
    let moveCount = 0;
    const failingUpdater = createPluginUpdater({
      sidecarDirectory: sidecarDir,
      pluginsDirectory: pluginsDir,
      checkVersion,
      downloadOptions: { fetchImpl: async () => makeMockStreamRes(200, tgz180) },
      move: async (from, to) => {
        moveCount += 1;
        if (moveCount === 5) {
          const err = new Error("busy");
          err.code = "EBUSY";
          throw err;
        }
        return fs.promises.rename(from, to);
      }
    });
    const failedRes = await failingUpdater("1.8.0");
    assert.equal(failedRes.status, "error");
    assert.equal(failedRes.reason, "locked");
    assert.equal(failedRes.diagnostics?.restored, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(installedRoot, "plugin.json"), "utf8")).version, "1.7.2");
    assert.equal(fs.existsSync(path.join(installedRoot, "legacy", "obsolete.js")), true);
    assert.equal(fs.existsSync(path.join(installedRoot, UPDATE_MARKER_NAME)), false);

    // 2. Full successful upgrade
    const updater = createPluginUpdater({
      sidecarDirectory: sidecarDir,
      pluginsDirectory: pluginsDir,
      checkVersion,
      downloadOptions: { fetchImpl: async () => makeMockStreamRes(200, tgz180) }
    });
    const okRes = await updater("1.8.0");
    assert.equal(okRes.status, "updated");
    assert.equal(okRes.version, "1.8.0");
    assert.equal(JSON.parse(fs.readFileSync(path.join(installedRoot, "plugin.json"), "utf8")).version, "1.8.0");
    assert.equal(fs.existsSync(path.join(installedRoot, "context/lib/new-module.js")), true);
    assert.equal(fs.existsSync(path.join(installedRoot, "rules/custom.local.md")), true, "rules/*.local.md preserved");
    assert.equal(fs.existsSync(path.join(installedRoot, "legacy/obsolete.js")), false, "obsolete file pruned");
    assert.equal(fs.existsSync(path.join(installedRoot, UPDATE_MARKER_NAME)), false);

    // Preserved eager MCP & no-read-hook matcher
    const updatedMcp = JSON.parse(fs.readFileSync(path.join(installedRoot, "mcp_config.json"), "utf8"));
    assert.equal(updatedMcp.mcpServers.context.tools?.ctx_search?.eager, true);
    const updatedHooks = JSON.parse(fs.readFileSync(path.join(installedRoot, "hooks.json"), "utf8"));
    assert.equal(updatedHooks["agy-dart-lifecycle"].PreToolUse[0].matcher, "run_command");

    // 3. Broken static import inside release archive is rejected before modifying live files
    const badTgz = buildTarGz(createReleaseArchiveEntries("1.9.0", { brokenImport: true }).map((e) => e));
    const brokenArchiveUpdater = createPluginUpdater({
      sidecarDirectory: sidecarDir,
      pluginsDirectory: pluginsDir,
      checkVersion: async () => ({
        ok: true,
        status: "update",
        currentVersion: "1.8.0",
        latestVersion: "1.9.0",
        releaseTag: "v1.9.0",
        releaseUrl: `${RELEASES_URL}/tag/v1.9.0`
      }),
      downloadOptions: { fetchImpl: async () => makeMockStreamRes(200, badTgz) }
    });
    const brokenRes = await brokenArchiveUpdater("1.9.0");
    assert.equal(brokenRes.status, "error");
    assert.equal(brokenRes.reason, "incomplete");

    // 4. Git checkout repo root is strictly protected (even without .git in ZIP checkout, verify synthetic .git dir)
    const gitRepoSidecar = path.join(tmpDir, "git-repo", "sidecars", "dashboard");
    fs.mkdirSync(gitRepoSidecar, { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "git-repo", ".git"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "git-repo", "plugin.json"), JSON.stringify({ name: "agy-dart", version: "1.7.2" }));
    fs.writeFileSync(path.join(gitRepoSidecar, "sidecar.json"), fs.readFileSync(path.join(ROOT, "sidecars/dashboard/sidecar.json"), "utf8"));
    await assert.rejects(
      resolveInstalledRoot(gitRepoSidecar, { allowCustomRoot: true }),
      (err) => err instanceof UpdateError && err.reason === "gitCheckout"
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.7.5-4: /api/version & /api/update enforce POST-only, CSRF, Origin, Content-Type & strict input schemas", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v175-srv-"));
  const prevDb = process.env.AGY_DART_DB_PATH;
  const prevCfg = process.env.AGY_DART_CONFIG_PATH;
  process.env.AGY_DART_DB_PATH = path.join(tmpDir, "ctx.db");
  process.env.AGY_DART_CONFIG_PATH = path.join(tmpDir, "cfg.json");

  let srv = null;
  try {
    // 1. Direct handler validation
    assert.equal((await handleVersionCheck({ mode: "bogus" })).status, 400);
    assert.equal((await handleVersionCheck({ extra: 1 })).status, 400);
    assert.equal((await handlePluginUpdate({ version: "not-semver" })).status, 400);
    assert.equal((await handlePluginUpdate({ version: "1.8.0", extra: 1 })).status, 400);

    // 2. SidecarApp routes are strictly POST-only and trigger onUpdated callback
    const registered = [];
    let restarted = false;
    registerSidecarRoutes(
      {
        config: { conversationId: "conv-1" },
        api(route, handler, method) {
          registered.push({ route, handler, method });
        }
      },
      {
        versionChecker: async (mode) => ({ ok: true, status: "current", mode, currentVersion: "1.7.2" }),
        pluginUpdater: async (version) => ({ ok: true, status: "updated", version }),
        onUpdated: () => {
          restarted = true;
        }
      }
    );
    assert.equal(registered.some((r) => r.method !== "POST"), false);
    const verRoute = registered.find((r) => r.route === VERSION_ROUTE);
    const updRoute = registered.find((r) => r.route === UPDATE_ROUTE);
    assert.ok(verRoute && updRoute);
    assert.equal((await verRoute.handler({ mode: "auto" })).status, "current");
    assert.equal((await updRoute.handler({ version: "1.8.0" })).status, "updated");
    assert.equal(restarted, true);

    // 3. Standalone HTTP server security checks
    const token = "test-csrf-token-v175";
    srv = createStandaloneServer({
      csrfToken: token,
      watchdogOptions: { pollMs: 60_000 },
      versionChecker: async (mode) => ({
        ok: true,
        status: "update",
        mode,
        currentVersion: "1.7.2",
        latestVersion: "1.8.0",
        releaseTag: "v1.8.0",
        releaseUrl: `${RELEASES_URL}/tag/v1.8.0`
      }),
      pluginUpdater: async (version) => ({ ok: true, status: "updated", version })
    });
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const { port } = srv.address();

    for (const route of [VERSION_ROUTE, UPDATE_ROUTE]) {
      const get405 = await httpRequest(port, route, {
        method: "GET",
        headers: { "X-Agy-Dart-Token": token }
      });
      assert.equal(get405.status, 405);
      assert.equal(get405.headers.allow, "POST");

      const noCsrf = await httpRequest(port, route, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      });
      assert.equal(noCsrf.status, 403);

      const crossSite = await httpRequest(port, route, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Agy-Dart-Token": token,
          "Sec-Fetch-Site": "cross-site"
        },
        body: "{}"
      });
      assert.equal(crossSite.status, 403);

      const badCt = await httpRequest(port, route, {
        method: "POST",
        headers: { "Content-Type": "text/plain", "X-Agy-Dart-Token": token },
        body: "{}"
      });
      assert.equal(badCt.status, 415);
    }

    const okVer = await httpRequest(port, VERSION_ROUTE, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agy-Dart-Token": token },
      body: JSON.stringify({ mode: "auto" })
    });
    assert.equal(okVer.status, 200);
    assert.equal(okVer.json.latestVersion, "1.8.0");

    const okUpd = await httpRequest(port, UPDATE_ROUTE, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agy-Dart-Token": token },
      body: JSON.stringify({ version: "1.8.0" })
    });
    assert.equal(okUpd.status, 200);
    assert.equal(okUpd.json.status, "updated");
  } finally {
    if (srv) await new Promise((r) => srv.close(r));
    closeRuntimeStore();
    if (prevDb === undefined) delete process.env.AGY_DART_DB_PATH;
    else process.env.AGY_DART_DB_PATH = prevDb;
    if (prevCfg === undefined) delete process.env.AGY_DART_CONFIG_PATH;
    else process.env.AGY_DART_CONFIG_PATH = prevCfg;
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.7.5-5: Dashboard UI auto-checks on open, shows #version-update button, updates via POST & renders EN/ZH", async () => {
  const htmlSource = fs.readFileSync(path.join(ROOT, "sidecars/dashboard/index.html"), "utf8");
  assert.ok(htmlSource.includes('id="version-check-btn"'));
  assert.ok(htmlSource.includes('id="version-update-banner"'));
  assert.ok(htmlSource.includes('id="version-update"'));
  assert.ok(htmlSource.indexOf('id="kv-cache-card"') < htmlSource.indexOf('id="star-milestone-banner"'));

  const scriptBlocks = [...htmlSource.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
  const mainUiScript = scriptBlocks[scriptBlocks.length - 1][1];
  new vm.Script(mainUiScript, { filename: "sidecars/dashboard/index.html" });
  assert.equal(/apiFetch\([^)]*method:\s*['"]GET['"]/.test(mainUiScript), false);

  const elements = new Map();
  const makeEl = (id) => ({
    id,
    value: id === "cutoff-select" ? "46080" : "",
    innerText: "",
    textContent: "",
    innerHTML: "",
    className: "",
    title: "",
    href: "",
    hidden: id === "version-update-banner" || id === "version-update",
    disabled: false,
    style: {},
    dataset: {},
    options: id === "cutoff-select" ? [{ value: "0" }, { value: "46080" }] : [],
    classList: {
      _s: new Set(id === "version-update-banner" || id === "version-update" || id === "star-milestone-banner" ? ["hidden"] : []),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); }
    },
    getAttribute(attr) {
      return attr === "content" ? "vm-csrf" : "";
    },
    scrollIntoView() {}
  });
  const getEl = (id) => {
    if (!elements.has(id)) elements.set(id, makeEl(id));
    return elements.get(id);
  };

  const apiCalls = [];
  let updateMode = "ok";
  const scheduledCallbacks = [];

  const sandbox = {
    window: { location: { search: "", reload() {} }, addEventListener() {}, sidecar: null },
    document: {
      title: "",
      hidden: false,
      documentElement: { lang: "en" },
      getElementById: getEl,
      querySelector: () => getEl("meta-csrf"),
      querySelectorAll: () => [],
      addEventListener: () => {}
    },
    navigator: { language: "en-US" },
    localStorage: { getItem: () => "en", setItem: () => {} },
    URLSearchParams,
    Headers,
    Intl,
    fetch: async (urlPath, opts = {}) => {
      const body = opts.body ? JSON.parse(opts.body) : {};
      apiCalls.push({ urlPath, method: opts.method || "GET", body });
      const mk = (obj) => ({ ok: true, status: 200, json: async () => obj });
      if (urlPath === "/api/version") {
        return mk({
          ok: true,
          status: "update",
          currentVersion: "1.7.2",
          latestVersion: "1.8.0",
          releaseTag: "v1.8.0",
          releaseUrl: `${RELEASES_URL}/tag/v1.8.0`
        });
      }
      if (urlPath === "/api/update") {
        if (updateMode === "locked") {
          return mk({ ok: false, status: "error", reason: "locked", diagnostics: { restored: true } });
        }
        return mk({ ok: true, status: "updated", version: "1.8.0" });
      }
      if (urlPath === "/api/stats") {
        return mk({
          version: "1.7.2",
          isPaused: false,
          cutoffBytes: 46080,
          exemptCategories: [],
          starPrompt: { state: "dismissed", shouldShow: false }
        });
      }
      return mk({ status: "HEALTHY", ok: true, recentEvents: [], recentSources: [] });
    },
    alert: () => {},
    confirm: () => true,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: (fn, ms) => {
      scheduledCallbacks.push({ fn, ms });
      return scheduledCallbacks.length;
    },
    clearTimeout: () => {},
    console: { log() {}, warn() {}, error() {} }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    `${mainUiScript}\nglobalThis.__uiTest = { checkForUpdates, handleVersionButtonClick, handleVersionUpdateClick, dismissVersionBanner, setLanguage };`,
    sandbox
  );

  // Opening dashboard schedules one automatic version check (600ms delay)
  const autoTimer = scheduledCallbacks.find((c) => c.ms === 600);
  assert.ok(autoTimer, "Dashboard open must schedule automatic version check");
  await autoTimer.fn();

  assert.ok(apiCalls.some((c) => c.urlPath === "/api/version" && c.method === "POST" && c.body.mode === "auto"));
  assert.equal(getEl("version-update-banner").classList.contains("hidden"), false);
  assert.equal(getEl("version-update").classList.contains("hidden"), false);
  assert.equal(getEl("version-check-btn").classList.contains("has-update"), true);
  assert.ok(getEl("version-status-text").textContent.includes("1.8.0"));

  // Language switch translates update banner immediately
  sandbox.__uiTest.setLanguage("zh", false);
  assert.ok(getEl("version-update").textContent.includes("立即更新"));

  // Update failure renders localized error + restored hint + retry button
  updateMode = "locked";
  await sandbox.__uiTest.handleVersionUpdateClick();
  assert.equal(getEl("version-update-banner").dataset.state, "error");
  assert.ok(getEl("version-detail-text").textContent.includes("已自动回滚"));
  assert.equal(getEl("version-update").textContent, "重试");

  // Retry succeeds
  updateMode = "ok";
  await sandbox.__uiTest.handleVersionUpdateClick();
  assert.equal(getEl("version-update-banner").dataset.state, "updated");
  assert.ok(getEl("version-status-text").textContent.includes("1.8.0"));

  // Package graph remains 100% clean
  const pkgReport = verifyPackageManifest(ROOT);
  assert.equal(pkgReport.ok, true, JSON.stringify(pkgReport));
});
