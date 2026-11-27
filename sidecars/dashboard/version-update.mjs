import { lstatSync, readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";
import { compareVersions, parseVersion, REPO } from "./version-check.mjs";
import { downloadArchive, readReleaseArchive, UpdateError } from "./update-archive.mjs";

export const UPDATE_ROUTE = "/api/update";
export const UPDATE_MARKER_NAME = ".update-in-progress";

const PLUGIN_NAME = "agy-dart";
const SYNC_MARKER_NAME = ".agy-dart-sync.json";
const SIDECAR_REL_DIR = "sidecars/dashboard";
const SIDECAR_MANIFEST = `${SIDECAR_REL_DIR}/sidecar.json`;
const STALE_MARKER_MS = 10 * 60_000;
const REQUIRED_FILES = [
  "plugin.json",
  "package.json",
  "mcp_config.json",
  "hooks.json",
  SIDECAR_MANIFEST,
  `${SIDECAR_REL_DIR}/server.mjs`,
  `${SIDECAR_REL_DIR}/index.html`,
  "scripts/install.mjs",
  "context/server.js",
  "fast/mcp-server.mjs"
];
const DEVTOOLS_SENTINELS = [
  "bin/agy-dart.mjs",
  "fast/benchmark.mjs",
  "scripts/cache-audit.mjs",
  "scripts/prefix-budget.mjs"
];
const FALLBACK_RUNTIME_ROOT_FILES = new Set([
  "plugin.json",
  "mcp_config.json",
  "hooks.json",
  "package.json",
  "LICENSE",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
  "assets/logo.svg"
]);
const FALLBACK_RUNTIME_DIRS = new Set([
  "agents",
  "context",
  "dsh",
  "fast",
  "hooks",
  "rules",
  "scripts",
  "sidecars",
  "skills"
]);
const PRESERVED_HIDDEN_FILES = new Set([UPDATE_MARKER_NAME, SYNC_MARKER_NAME]);
const FILE_ERROR_REASONS = { EACCES: "permission", EBUSY: "locked", EPERM: "locked", ETXTBSY: "locked" };

const DEFAULT_FAST_TOOLS = ["apply_edits", "batch_search", "read_slices", "run_checks"];
const DEFAULT_CONTEXT_TOOLS = [
  "ctx_batch",
  "ctx_doctor",
  "ctx_execute",
  "ctx_index",
  "ctx_purge",
  "ctx_resume",
  "ctx_search",
  "ctx_stats"
];

class InstallError extends UpdateError {
  constructor(error, relPath, { restored = false, recovery = false } = {}) {
    const code = typeof error?.code === "string" && /^E[A-Z0-9_]{1,31}$/.test(error.code) ? error.code : undefined;
    const reason = error instanceof UpdateError ? error.reason : FILE_ERROR_REASONS[code] || "install";
    super(recovery ? "recovery" : reason);
    // Only expose plugin-relative paths to avoid leaking host usernames or absolute paths.
    this.diagnostics = { ...(code && { code }), ...(relPath && { path: relPath }), ...(restored && { restored }) };
  }
}

async function safeLstat(targetPath) {
  try {
    return await lstat(targetPath);
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

function isSamePath(a, b) {
  const normA = resolve(a);
  const normB = resolve(b);
  return process.platform === "win32" ? normA.toLowerCase() === normB.toLowerCase() : normA === normB;
}

function stripWinExtendedPrefix(p) {
  const s = String(p || "");
  if (s.startsWith("\\\\?\\UNC\\")) return `\\\\${s.slice(8)}`;
  if (s.startsWith("\\\\?\\")) return s.slice(4);
  return s;
}

function normalizeComparePath(p) {
  const resolved = resolve(stripWinExtendedPrefix(p));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function canonicalComparePath(p) {
  const stripped = stripWinExtendedPrefix(p);
  const canon = await realpath(stripped).catch(() => resolve(stripped));
  return normalizeComparePath(canon);
}

function defaultIsPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function evaluateMarkerState(raw, mtimeMs, { now = Date.now, staleMs = STALE_MARKER_MS, isPidAlive = defaultIsPidAlive } = {}) {
  try {
    const parsed = JSON.parse(String(raw || "").replace(/^\uFEFF/, ""));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      if (parsed.phase === "recovery") return "recovery";
      if (Number.isInteger(parsed.pid)) {
        if (parsed.pid === process.pid) return "active";
        if (!isPidAlive(parsed.pid)) return "stale";
        if (Number.isFinite(parsed.startedAt) && now() - parsed.startedAt > staleMs) return "stale";
        return "active";
      }
    }
  } catch {
    // Legacy plain-text marker format
  }
  return Number.isFinite(mtimeMs) && now() - mtimeMs > staleMs ? "stale" : "active";
}

/**
 * Synchronous check used by the sidecar auto-reload poller so an active or recovery
 * update marker suppresses reloads while dead-process stale locks do not permanently disable reload.
 */
export function hasActiveUpdateMarker(
  markerPath,
  { now = Date.now, staleMs = STALE_MARKER_MS, isPidAlive = defaultIsPidAlive } = {}
) {
  let st;
  try {
    st = lstatSync(markerPath);
  } catch {
    return false;
  }
  if (!st.isFile() || st.isSymbolicLink()) return true;
  try {
    const raw = readFileSync(markerPath, "utf8");
    const state = evaluateMarkerState(raw, st.mtimeMs, { now, staleMs, isPidAlive });
    return state === "active" || state === "recovery";
  } catch {
    return true;
  }
}

async function reclaimStaleUpdateMarker(markerPath, markerOptions = {}) {
  const st = await safeLstat(markerPath);
  if (!st) return;
  if (!st.isFile() || st.isSymbolicLink()) {
    throw new UpdateError("pathConflict");
  }
  const raw = await readFile(markerPath, "utf8").catch(() => "");
  const state = evaluateMarkerState(raw, st.mtimeMs, markerOptions);
  if (state === "recovery") {
    throw new UpdateError("recovery");
  }
  if (state === "active") {
    throw new UpdateError("busy");
  }
  await unlink(markerPath).catch((err) => {
    if (err?.code !== "ENOENT") throw new InstallError(err, UPDATE_MARKER_NAME);
  });
}

async function readDiskJson(root, relPath) {
  const fullPath = join(root, relPath);
  const st = await safeLstat(fullPath);
  if (!st?.isFile() || st.isSymbolicLink()) throw new UpdateError("notInstalled");
  try {
    return JSON.parse((await readFile(fullPath, "utf8")).replace(/^\uFEFF/, ""));
  } catch (err) {
    if (err instanceof SyntaxError || err?.code === "ENOENT") throw new UpdateError("notInstalled");
    throw new InstallError(err, relPath);
  }
}

async function assertNoIntermediateSymlink(root, relPosix) {
  const parts = relPosix.split("/").slice(0, -1);
  let cur = root;
  for (const part of parts) {
    cur = join(cur, part);
    const st = await safeLstat(cur);
    if (!st) break;
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new UpdateError("pathConflict");
    }
  }
}

export async function resolveInstalledRoot(
  sidecarDirectory,
  { pluginsDirectory = "", allowCustomRoot = false } = {}
) {
  const root = resolve(sidecarDirectory, "../..");
  const expectedSidecarDir = join(root, "sidecars", "dashboard");
  if (!isSamePath(sidecarDirectory, expectedSidecarDir)) {
    throw new UpdateError("notInstalled");
  }

  for (const dirPath of [root, join(root, "sidecars"), expectedSidecarDir]) {
    const st = await safeLstat(dirPath);
    if (!st?.isDirectory() || st.isSymbolicLink()) throw new UpdateError("notInstalled");
  }

  const canonical = await realpath(root);
  const home = await realpath(homedir()).catch(() => resolve(homedir()));
  const fsRoot = resolve(canonical, "/");
  if (isSamePath(canonical, fsRoot) || isSamePath(canonical, home)) {
    throw new UpdateError("notInstalled");
  }

  // Never overwrite a Git source checkout directly at root.
  if (await safeLstat(join(canonical, ".git"))) {
    throw new UpdateError("gitCheckout");
  }

  let isStandardPluginSlot = false;
  if (pluginsDirectory) {
    const expectedTarget = await realpath(join(pluginsDirectory, PLUGIN_NAME)).catch(() =>
      resolve(pluginsDirectory, PLUGIN_NAME)
    );
    isStandardPluginSlot = isSamePath(canonical, expectedTarget);
  } else {
    const dirName = basename(canonical);
    const parentName = basename(dirname(canonical));
    isStandardPluginSlot = dirName === PLUGIN_NAME && parentName === "plugins";
  }

  if (!allowCustomRoot && !isStandardPluginSlot) {
    throw new UpdateError("notInstalled");
  }

  // For custom/non-standard roots, also walk ancestors below $HOME/fsRoot to protect monorepo subdirs,
  // while avoiding false positives when a developer keeps a $HOME/.git dotfiles repository.
  if (!isStandardPluginSlot) {
    for (let dir = dirname(canonical); ; dir = dirname(dir)) {
      if (isSamePath(dir, home) || isSamePath(dir, fsRoot)) break;
      if (await safeLstat(join(dir, ".git"))) {
        throw new UpdateError("gitCheckout");
      }
      const parent = dirname(dir);
      if (parent === dir) break;
    }
  }

  const manifest = await readDiskJson(canonical, "plugin.json");
  if (manifest?.name !== PLUGIN_NAME) throw new UpdateError("notInstalled");
  await readDiskJson(canonical, SIDECAR_MANIFEST);
  return canonical;
}

function stripArrayLiteralComments(body) {
  let out = "";
  let inQuote = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inQuote) {
      out += ch;
      if (ch === "\\" && i + 1 < body.length) {
        out += body[++i];
      } else if (ch === inQuote) {
        inQuote = "";
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && body[i + 1] === "/") {
      i += 2;
      while (i < body.length && body[i] !== "\n") i++;
      if (i < body.length) out += "\n";
      continue;
    }
    if (ch === "/" && body[i + 1] === "*") {
      i += 2;
      while (i < body.length && !(body[i] === "*" && body[i + 1] === "/")) {
        if (body[i] === "\n") out += "\n";
        i++;
      }
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

function extractFrozenStringList(scriptSource, constName) {
  const re = new RegExp(`\\b${constName}\\s*=\\s*Object\\.freeze\\(\\s*\\[([\\s\\S]*?)\\]\\s*\\)`);
  const match = re.exec(scriptSource);
  if (!match) return null;
  const cleaned = stripArrayLiteralComments(match[1]);
  const list = [];
  const strRegex = /["']([^"'\r\n]+)["']/g;
  for (const [, raw] of cleaned.matchAll(strRegex)) {
    if (raw) list.push(raw);
  }
  return list.length > 0 ? list : null;
}

function extractRuntimeFilesFromInstallScript(scriptSource, archiveFiles) {
  const rawList = extractFrozenStringList(scriptSource, "RUNTIME_FILES");
  if (!rawList) return null;
  const list = [];
  for (const raw of rawList) {
    const normalized = posix.normalize(raw.replace(/\\/g, "/"));
    if (!normalized || normalized.startsWith("..") || normalized.startsWith("/")) {
      throw new UpdateError("incomplete");
    }
    if (!archiveFiles.get(normalized)?.length) {
      throw new UpdateError("incomplete");
    }
    list.push(normalized);
  }
  return list.length > 0 ? list : null;
}

function extractDevtoolsFilesFromInstallScript(scriptSource, archiveFiles) {
  const rawList = extractFrozenStringList(scriptSource, "DEVTOOLS_FILES");
  if (!rawList) return [];
  const list = [];
  for (const raw of rawList) {
    const normalized = posix.normalize(raw.replace(/\\/g, "/"));
    if (!normalized || normalized.startsWith("..") || normalized.startsWith("/")) continue;
    if (archiveFiles.get(normalized)?.length) {
      list.push(normalized);
    }
  }
  return list;
}

export function selectFallbackRuntimeFiles(archiveFiles) {
  const selected = [];
  for (const [relPath, bytes] of archiveFiles) {
    if (!bytes?.length) continue;
    const top = relPath.split("/")[0];
    if (FALLBACK_RUNTIME_ROOT_FILES.has(relPath) || FALLBACK_RUNTIME_DIRS.has(top)) {
      selected.push(relPath);
    }
  }
  return selected;
}

async function detectInstalledDevtools(root) {
  for (const rel of DEVTOOLS_SENTINELS) {
    const st = await safeLstat(join(root, rel));
    if (st?.isFile() && !st.isSymbolicLink()) return true;
  }
  return false;
}

function detectInstalledToolLoading(installedMcp, installedUserConfig) {
  const fastTools = installedMcp?.mcpServers?.fast?.tools;
  const ctxTools = installedMcp?.mcpServers?.context?.tools;
  const hasEager = (toolsObj) =>
    Boolean(
      toolsObj &&
        typeof toolsObj === "object" &&
        Object.values(toolsObj).some((cfg) => Boolean(cfg && typeof cfg === "object" && cfg.eager === true))
    );
  if (installedMcp?.mcpServers) {
    if (hasEager(ctxTools)) return "eager";
    if (hasEager(fastTools)) return "fast-eager";
    return "lazy";
  }
  const cfgMode = typeof installedUserConfig?.toolLoading === "string" ? installedUserConfig.toolLoading.trim() : "";
  if (cfgMode === "eager" || cfgMode === "fast-eager" || cfgMode === "lazy") return cfgMode;
  return "fast-eager";
}

function buildEagerMap(toolNames) {
  const out = {};
  for (const name of toolNames) out[name] = { eager: true };
  return out;
}

function extractToolListFromInstallScript(scriptSource, constName, fallback) {
  const names = extractFrozenStringList(scriptSource, constName);
  return names && names.length > 0 ? names : fallback;
}

function preserveWindowsSidecarCommand(sidecarBuf, installedSidecar) {
  const { command } = installedSidecar || {};
  if (typeof command === "string" && win32.isAbsolute(command)) {
    const executable = win32.basename(command).toLowerCase();
    const parsedRoot = win32.parse(command).root;
    if (executable === "node.exe" && parsedRoot.length > 1 && !command.startsWith("\\\\")) {
      try {
        const sidecar = JSON.parse(sidecarBuf.toString("utf8"));
        sidecar.command = command;
        return Buffer.from(JSON.stringify(sidecar, null, 2) + "\n", "utf8");
      } catch {
        // Keep archive sidecar.json as-is
      }
    }
  }
  return sidecarBuf;
}

function applyPreservedConfigurations(
  selectedFiles,
  { installedMcp, installedHooks, installedSidecar, installedUserConfig, installScriptSource }
) {
  // 1. Preserve tool-loading mode on mcp_config.json
  try {
    const mcpObj = JSON.parse(selectedFiles.get("mcp_config.json").toString("utf8"));
    const mode = detectInstalledToolLoading(installedMcp, installedUserConfig);
    const fastNames = extractToolListFromInstallScript(installScriptSource, "FAST_MCP_TOOL_NAMES", DEFAULT_FAST_TOOLS);
    const ctxNames = extractToolListFromInstallScript(
      installScriptSource,
      "CONTEXT_MCP_TOOL_NAMES",
      DEFAULT_CONTEXT_TOOLS
    );
    if (mcpObj?.mcpServers?.fast) {
      if (mode === "lazy") delete mcpObj.mcpServers.fast.tools;
      else mcpObj.mcpServers.fast.tools = buildEagerMap(fastNames);
    }
    if (mcpObj?.mcpServers?.context) {
      if (mode === "eager") mcpObj.mcpServers.context.tools = buildEagerMap(ctxNames);
      else delete mcpObj.mcpServers.context.tools;
    }
    selectedFiles.set("mcp_config.json", Buffer.from(JSON.stringify(mcpObj, null, 2) + "\n", "utf8"));
  } catch {
    // Keep archive mcp_config.json as-is if non-standard
  }

  // 2. Preserve no-read-hook mode if installed hooks.json only matched run_command
  try {
    const oldPre = installedHooks?.["agy-dart-lifecycle"]?.PreToolUse;
    const oldMatcher = Array.isArray(oldPre) ? oldPre[0]?.matcher : "";
    if (oldMatcher === "run_command") {
      const nextHooks = JSON.parse(selectedFiles.get("hooks.json").toString("utf8"));
      if (Array.isArray(nextHooks?.["agy-dart-lifecycle"]?.PreToolUse) && nextHooks["agy-dart-lifecycle"].PreToolUse[0]) {
        nextHooks["agy-dart-lifecycle"].PreToolUse[0].matcher = "run_command";
        selectedFiles.set("hooks.json", Buffer.from(JSON.stringify(nextHooks, null, 2) + "\n", "utf8"));
      }
    }
  } catch {
    // Keep archive hooks.json as-is
  }

  // 3. Preserve explicit Windows Node executable launcher if configured
  selectedFiles.set(SIDECAR_MANIFEST, preserveWindowsSidecarCommand(selectedFiles.get(SIDECAR_MANIFEST), installedSidecar));
}

/**
 * Extract top-level static relative ESM import/export specifiers (both single-line and multiline
 * named `{ ... } from './...'` statements) without importing devtools-only modules.
 */
export function extractStaticRelativeImports(source) {
  const targets = new Set();
  const singleLineRe =
    /^(?:import[ \t]+['"](\.{1,2}\/[^'"\r\n]+)['"]|(?:import|export)[ \t]+[^\r\n'"`;]*?\bfrom[ \t]*['"](\.{1,2}\/[^'"\r\n]+)['"])/gm;
  for (const m of source.matchAll(singleLineRe)) {
    const spec = m[1] || m[2];
    if (spec) targets.add(spec);
  }
  const multiLineNamedRe =
    /^(?:import|export)[ \t]+(?:[A-Za-z_$][\w$]*[ \t]*,[ \t]*)?\{[^{};()`]*?\}[ \t]*from[ \t]*['"](\.{1,2}\/[^'"\r\n]+)['"]/gm;
  for (const m of source.matchAll(multiLineNamedRe)) {
    if (m[1]) targets.add(m[1]);
  }
  return Array.from(targets);
}

function prepareReleaseFiles(archiveFiles, expectedVersion, context) {
  if (REQUIRED_FILES.some((rel) => !archiveFiles.get(rel)?.length)) {
    throw new UpdateError("incomplete");
  }

  let manifest;
  let pkg;
  let sidecar;
  try {
    manifest = JSON.parse(archiveFiles.get("plugin.json").toString("utf8"));
    pkg = JSON.parse(archiveFiles.get("package.json").toString("utf8"));
    sidecar = JSON.parse(archiveFiles.get(SIDECAR_MANIFEST).toString("utf8"));
  } catch {
    throw new UpdateError("incomplete");
  }

  if (
    manifest?.name !== PLUGIN_NAME ||
    pkg?.name !== PLUGIN_NAME ||
    parseVersion(manifest?.version)?.version !== expectedVersion ||
    parseVersion(pkg?.version)?.version !== expectedVersion
  ) {
    throw new UpdateError("version");
  }

  if (
    sidecar?.command !== "node" ||
    !Array.isArray(sidecar?.args) ||
    sidecar.args[0] !== "server.mjs" ||
    !sidecar.args.every((arg) => typeof arg === "string") ||
    sidecar.restart_policy !== "always"
  ) {
    throw new UpdateError("incomplete");
  }

  const installScriptSource = archiveFiles.get("scripts/install.mjs").toString("utf8");
  const runtimeList =
    extractRuntimeFilesFromInstallScript(installScriptSource, archiveFiles) || selectFallbackRuntimeFiles(archiveFiles);

  const selectedFiles = new Map();
  for (const rel of runtimeList) {
    const bytes = archiveFiles.get(rel);
    if (!bytes?.length) throw new UpdateError("incomplete");
    selectedFiles.set(rel, bytes);
  }
  // Preserve devtools files when the installed plugin already has --with-devtools present.
  if (context?.preserveDevtools) {
    for (const rel of extractDevtoolsFilesFromInstallScript(installScriptSource, archiveFiles)) {
      if (!selectedFiles.has(rel)) {
        selectedFiles.set(rel, archiveFiles.get(rel));
      }
    }
  }
  // Ensure every required file is always included even if runtimeList omitted something.
  for (const rel of REQUIRED_FILES) {
    if (!selectedFiles.has(rel)) {
      selectedFiles.set(rel, archiveFiles.get(rel));
    }
  }

  // Verify static relative imports across all selected JS modules without executing archive code.
  for (const [rel, bytes] of selectedFiles) {
    if (!/\.[cm]?js$/i.test(rel)) continue;
    const src = bytes.toString("utf8");
    for (const target of extractStaticRelativeImports(src)) {
      const resolved = posix.normalize(posix.join(posix.dirname(rel), target));
      if (!selectedFiles.get(resolved)?.length) {
        throw new UpdateError("incomplete");
      }
    }
  }

  applyPreservedConfigurations(selectedFiles, { ...context, installScriptSource });
  return selectedFiles;
}

function isPreservedLocalFile(relPosix) {
  if (PRESERVED_HIDDEN_FILES.has(relPosix)) return true;
  if (/^rules\/[^/]+\.local\.md$/i.test(relPosix)) return true;
  return false;
}

async function listLiveFiles(rootDir, currentRel = "") {
  const absDir = currentRel ? join(rootDir, currentRel) : rootDir;
  const entries = await readdir(absDir, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const relPosix = currentRel ? `${currentRel}/${entry.name}` : entry.name;
    if (isPreservedLocalFile(relPosix)) continue;
    if (entry.isDirectory()) {
      results.push(...(await listLiveFiles(rootDir, relPosix)));
    } else {
      results.push(relPosix);
    }
  }
  return results;
}

async function removeEmptyDirsRecursive(dirPath, rootDir) {
  const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = join(dirPath, entry.name);
    await removeEmptyDirsRecursive(child, rootDir);
  }
  if (!isSamePath(dirPath, rootDir)) {
    const after = await readdir(dirPath).catch(() => ["non-empty"]);
    if (after.length === 0) {
      await unlink(dirPath).catch(async () => {
        await rm(dirPath, { recursive: false, force: true }).catch(() => {});
      });
    }
  }
}

async function replaceInstalledFiles(
  root,
  stageDir,
  backupDir,
  expectedCurrentVersion,
  selectedRelPaths,
  move,
  { caseInsensitiveFs = process.platform === "win32" || process.platform === "darwin", markerOptions = {} } = {}
) {
  await mkdir(backupDir, { recursive: true });
  const markerPath = join(root, UPDATE_MARKER_NAME);
  await reclaimStaleUpdateMarker(markerPath, markerOptions);

  const markerNow = markerOptions.now || Date.now;
  try {
    await writeFile(
      markerPath,
      JSON.stringify({ pid: process.pid, startedAt: markerNow(), phase: "replacing" }) + "\n",
      { flag: "wx" }
    );
  } catch (err) {
    if (err?.code === "EEXIST") throw new UpdateError("busy");
    throw new InstallError(err, UPDATE_MARKER_NAME);
  }

  const changes = [];
  let activePath = "plugin.json";

  async function moveTracked(from, to) {
    await mkdir(dirname(to), { recursive: true });
    await move(from, to);
    changes.push({ path: activePath, from, to });
  }

  try {
    const localManifest = await readDiskJson(root, "plugin.json");
    if (parseVersion(localManifest?.version)?.version !== expectedCurrentVersion) {
      throw new UpdateError("releaseChanged");
    }

    const normKey = (rel) => (caseInsensitiveFs ? rel.toLowerCase() : rel);
    const selectedKeySet = new Set(selectedRelPaths.map(normKey));
    const liveFiles = await listLiveFiles(root);
    const obsoleteFiles = liveFiles.filter((rel) => !selectedKeySet.has(normKey(rel)));

    // Guard against symlinked intermediate directories before modifying live files.
    for (const rel of selectedRelPaths) {
      activePath = rel;
      await assertNoIntermediateSymlink(root, rel);
    }

    // Order replacements so server.mjs and plugin.json land last.
    const tail = new Set([`${SIDECAR_REL_DIR}/server.mjs`, "plugin.json"]);
    const orderedInstall = [
      ...selectedRelPaths.filter((rel) => !tail.has(rel)),
      ...selectedRelPaths.filter((rel) => tail.has(rel))
    ];

    for (const rel of orderedInstall) {
      activePath = rel;
      const incoming = join(stageDir, rel);
      const live = join(root, rel);
      const existing = await safeLstat(live);
      if (existing) {
        if (existing.isDirectory()) throw new UpdateError("pathConflict");
        const saved = join(backupDir, "prev", rel);
        await moveTracked(live, saved);
      }
      await moveTracked(incoming, live);
    }

    for (const rel of obsoleteFiles) {
      activePath = rel;
      const live = join(root, rel);
      const existing = await safeLstat(live);
      if (existing && !existing.isDirectory()) {
        const saved = join(backupDir, "obsolete", rel);
        await moveTracked(live, saved);
      }
    }

    await removeEmptyDirsRecursive(root, root).catch(() => {});
    activePath = UPDATE_MARKER_NAME;
    await unlink(markerPath);
  } catch (err) {
    const failedPath = activePath;
    const restored = changes.length > 0;
    try {
      for (const { path: relPath, from, to } of [...changes].reverse()) {
        activePath = relPath;
        await mkdir(dirname(from), { recursive: true });
        await move(to, from);
      }
      activePath = UPDATE_MARKER_NAME;
      await unlink(markerPath);
    } catch (rollbackErr) {
      await writeFile(
        markerPath,
        JSON.stringify({ pid: process.pid, startedAt: markerNow(), phase: "recovery" }) + "\n"
      ).catch(() => {});
      throw new InstallError(rollbackErr, activePath, { recovery: true });
    }
    throw new InstallError(err, failedPath, { restored });
  }
}

async function readOptionalJson(filePath) {
  try {
    const st = await safeLstat(filePath);
    if (!st?.isFile() || st.isSymbolicLink()) return null;
    return JSON.parse((await readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

async function syncOwnedSecondaryHosts(
  primaryRoot,
  selectedFiles,
  { syncedHostsDir = "", caseInsensitiveFs = process.platform === "win32" || process.platform === "darwin" } = {}
) {
  const receiptDir = syncedHostsDir || join(await realpath(homedir()).catch(() => resolve(homedir())), ".agy-dart", "synced-hosts");
  let entries;
  try {
    entries = await readdir(receiptDir, { withFileTypes: true });
  } catch {
    return { syncedCount: 0, warnings: [] };
  }

  const normPrimary = await canonicalComparePath(primaryRoot);
  const normKey = (rel) => (caseInsensitiveFs ? rel.toLowerCase() : rel);
  const selectedKeySet = new Set(Array.from(selectedFiles.keys(), normKey));
  const seenTargets = new Set();
  let syncedCount = 0;
  const warnings = [];

  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith(".json")) continue;
    const receipt = await readOptionalJson(join(receiptDir, ent.name));
    if (!receipt || typeof receipt.primary !== "string" || typeof receipt.target !== "string") continue;
    if ((await canonicalComparePath(receipt.primary)) !== normPrimary) continue;

    const targetRaw = resolve(stripWinExtendedPrefix(receipt.target));
    if (isSamePath(targetRaw, primaryRoot)) continue;
    const targetKey = await canonicalComparePath(targetRaw);
    if (seenTargets.has(targetKey)) continue;
    seenTargets.add(targetKey);

    try {
      const targetSt = await safeLstat(targetRaw);
      if (!targetSt?.isDirectory() || targetSt.isSymbolicLink()) continue;
      const target = stripWinExtendedPrefix(await realpath(targetRaw));
      if (isSamePath(target, primaryRoot) || (await safeLstat(join(target, ".git")))) continue;

      const marker = await readOptionalJson(join(target, SYNC_MARKER_NAME));
      if (
        !marker ||
        typeof marker.primary !== "string" ||
        typeof marker.target !== "string" ||
        (await canonicalComparePath(marker.primary)) !== normPrimary ||
        (await canonicalComparePath(marker.target)) !== targetKey ||
        !Array.isArray(marker.files)
      ) {
        continue;
      }

      const manifest = await readOptionalJson(join(target, "plugin.json"));
      if (manifest?.name !== PLUGIN_NAME) continue;

      const targetSidecar = await readOptionalJson(join(target, SIDECAR_MANIFEST));

      for (const rel of selectedFiles.keys()) {
        await assertNoIntermediateSymlink(target, rel);
        const dst = join(target, rel);
        const dstSt = await safeLstat(dst);
        if (dstSt && (dstSt.isSymbolicLink() || dstSt.isDirectory())) {
          throw new UpdateError("pathConflict");
        }
      }

      for (const [rel, rawBytes] of selectedFiles) {
        const bytes = rel === SIDECAR_MANIFEST ? preserveWindowsSidecarCommand(rawBytes, targetSidecar) : rawBytes;
        const dst = join(target, rel);
        await mkdir(dirname(dst), { recursive: true });
        await writeFile(dst, bytes);
      }

      for (const prevRel of marker.files) {
        if (typeof prevRel !== "string" || !prevRel) continue;
        const normalizedPrev = posix.normalize(prevRel.replace(/\\/g, "/"));
        if (normalizedPrev.startsWith("..") || normalizedPrev.startsWith("/") || isPreservedLocalFile(normalizedPrev)) {
          continue;
        }
        if (selectedKeySet.has(normKey(normalizedPrev))) continue;
        const obsoletePath = join(target, normalizedPrev);
        const obsSt = await safeLstat(obsoletePath);
        if (obsSt && !obsSt.isDirectory()) {
          await unlink(obsoletePath).catch(() => {});
        }
      }

      await removeEmptyDirsRecursive(target, target).catch(() => {});
      await writeFile(
        join(target, SYNC_MARKER_NAME),
        JSON.stringify({ ...marker, files: Array.from(selectedFiles.keys()) }) + "\n",
        "utf8"
      );
      syncedCount += 1;
    } catch (err) {
      const code = typeof err?.code === "string" ? err.code : undefined;
      const reason = err instanceof UpdateError ? err.reason : FILE_ERROR_REASONS[code] || "install";
      warnings.push({ step: "sync-secondary-host", reason });
    }
  }

  return { syncedCount, warnings };
}

/**
 * Evaluate whether a discovered release qualifies for opt-in silent auto-install:
 * requires same major version, a verified SHA-256 release asset, and no open failure
 * circuit breaker for the same target version.
 */
export function evaluateAutoInstallEligibility({ release, currentVersion, failedVersion = "" } = {}) {
  const cur = parseVersion(currentVersion);
  if (!cur) return { eligible: false, skipReason: "invalidVersion" };
  if (!release || release.status !== "update") {
    return { eligible: false, skipReason: "notUpdate" };
  }
  const latest = parseVersion(release.latestVersion);
  const tagParsed = parseVersion(release.releaseTag);
  if (
    !latest ||
    !tagParsed ||
    latest.pre.length > 0 ||
    tagParsed.pre.length > 0 ||
    latest.version !== tagParsed.version
  ) {
    return { eligible: false, skipReason: "invalidVersion" };
  }
  if (compareVersions(latest.version, cur.version) !== 1) {
    return { eligible: false, skipReason: "notUpdate" };
  }
  if (cur.core[0] !== latest.core[0]) {
    return { eligible: false, skipReason: "majorUpgrade", targetVersion: latest.version };
  }
  const hasVerifiedAsset = Boolean(
    typeof release.assetUrl === "string" &&
      release.assetUrl.trim() &&
      typeof release.assetSha256 === "string" &&
      /^[0-9a-f]{64}$/i.test(release.assetSha256.trim())
  );
  if (!hasVerifiedAsset) {
    return { eligible: false, skipReason: "noVerifiedAsset", targetVersion: latest.version };
  }
  const failedParsed = parseVersion(failedVersion);
  if (failedParsed && failedParsed.version === latest.version) {
    return { eligible: false, skipReason: "failedCircuitOpen", targetVersion: latest.version };
  }
  return { eligible: true, skipReason: null, targetVersion: latest.version };
}

/**
 * Create an atomic, rollback-safe self-updater for an installed agy-dart plugin directory.
 */
export function createPluginUpdater({
  sidecarDirectory,
  checkVersion,
  pluginsDirectory = process.env.AGY_DART_PLUGINS_DIR || "",
  allowCustomRoot = false,
  downloadOptions,
  move = rename,
  userConfigPath = "",
  syncedHostsDir = "",
  caseInsensitiveFs = process.platform === "win32" || process.platform === "darwin",
  markerOptions = {}
} = {}) {
  let busy = false;
  const failure = (reason, step, details = {}) => ({
    ok: false,
    status: "error",
    reason,
    diagnostics: { step, ...details }
  });

  return async function update(expectedVersion) {
    if (busy) return failure("busy", "start");
    busy = true;
    let workDir;
    let stagedFile;
    let keepBackup = false;
    let step = "start";

    try {
      const parsedExpected = parseVersion(expectedVersion);
      if (!parsedExpected) throw new UpdateError("releaseChanged");
      const targetVersion = parsedExpected.version;

      step = "inspect";
      const root = await resolveInstalledRoot(sidecarDirectory, { pluginsDirectory, allowCustomRoot });
      await reclaimStaleUpdateMarker(join(root, UPDATE_MARKER_NAME), markerOptions);
      const localManifest = await readDiskJson(root, "plugin.json");
      const currentVersion = parseVersion(localManifest?.version)?.version;
      if (!currentVersion || localManifest?.name !== PLUGIN_NAME) {
        throw new UpdateError("notInstalled");
      }
      const installedSidecar = await readDiskJson(root, SIDECAR_MANIFEST);
      const installedMcp = await readOptionalJson(join(root, "mcp_config.json"));
      const installedHooks = await readOptionalJson(join(root, "hooks.json"));
      const preserveDevtools = await detectInstalledDevtools(root);
      const resolvedCfgPath =
        userConfigPath || process.env.AGY_DART_CONFIG_PATH || join(homedir(), ".agy-dart", "config.json");
      const installedUserConfig = await readOptionalJson(resolvedCfgPath);

      step = "verify-release";
      const release = await checkVersion("manual", { fresh: true });
      if (release?.reason === "rateLimit") {
        return { ...failure("rateLimit", step), retryAt: release.retryAt };
      }
      if (release?.status === "error") {
        throw new UpdateError(release.reason === "timeout" ? "timeout" : "releaseCheck");
      }
      const releaseParsed = parseVersion(release?.releaseTag);
      if (
        !releaseParsed ||
        releaseParsed.pre.length > 0 ||
        releaseParsed.version !== release?.latestVersion ||
        releaseParsed.version !== targetVersion ||
        compareVersions(releaseParsed.version, currentVersion) !== 1 ||
        release?.status !== "update"
      ) {
        throw new UpdateError("releaseChanged");
      }

      step = "download";
      const useVerifiedAsset = Boolean(
        typeof release.assetUrl === "string" &&
          release.assetUrl &&
          typeof release.assetSha256 === "string" &&
          release.assetSha256
      );
      const downloadUrl = useVerifiedAsset
        ? release.assetUrl
        : `https://api.github.com/repos/${REPO}/tarball/${encodeURIComponent(release.releaseTag)}`;
      const archiveBuffer = await downloadArchive(downloadUrl, {
        ...downloadOptions,
        ...(useVerifiedAsset ? { expectedSha256: release.assetSha256 } : {})
      });

      step = "validate-archive";
      const archiveFiles = await readReleaseArchive(archiveBuffer);
      const selectedFiles = prepareReleaseFiles(archiveFiles, releaseParsed.version, {
        installedMcp,
        installedHooks,
        installedSidecar,
        installedUserConfig,
        preserveDevtools
      });

      step = "stage";
      workDir = await mkdtemp(join(dirname(root), ".agy-dart-update-"));
      const stageDir = join(workDir, "next");
      for (const [relPath, bytes] of selectedFiles) {
        stagedFile = relPath;
        const destination = join(stageDir, relPath);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, bytes, { flag: "wx" });
      }

      step = "replace";
      await replaceInstalledFiles(
        root,
        stageDir,
        join(workDir, "backup"),
        currentVersion,
        Array.from(selectedFiles.keys()),
        move,
        { caseInsensitiveFs, markerOptions }
      );

      step = "sync-secondary";
      const syncSummary = await syncOwnedSecondaryHosts(root, selectedFiles, {
        syncedHostsDir,
        caseInsensitiveFs
      });

      return {
        ok: true,
        status: "updated",
        previousVersion: currentVersion,
        version: releaseParsed.version,
        releaseTag: release.releaseTag,
        releaseUrl: release.releaseUrl,
        ...(useVerifiedAsset ? { verifiedSha256: release.assetSha256 } : {}),
        ...(syncSummary.syncedCount > 0 ? { syncedSecondaryHosts: syncSummary.syncedCount } : {}),
        ...(syncSummary.warnings.length > 0 ? { warnings: syncSummary.warnings } : {})
      };
    } catch (error) {
      const failureError =
        error instanceof UpdateError ? error : new InstallError(error, step === "stage" ? stagedFile : undefined);
      keepBackup = failureError.reason === "recovery";
      return failure(failureError.reason, keepBackup ? "rollback" : step, failureError.diagnostics);
    } finally {
      if (workDir && !keepBackup) {
        await rm(workDir, { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
      }
      busy = false;
    }
  };
}
