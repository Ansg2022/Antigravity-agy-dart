import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, posix, relative, resolve, win32 } from "node:path";
import { compareVersions, parseVersion, REPO } from "./version-check.mjs";
import { downloadArchive, readReleaseArchive, UpdateError } from "./update-archive.mjs";

export const UPDATE_ROUTE = "/api/update";
export const UPDATE_MARKER_NAME = ".update-in-progress";

const PLUGIN_NAME = "agy-dart";
const SIDECAR_REL_DIR = "sidecars/dashboard";
const SIDECAR_MANIFEST = `${SIDECAR_REL_DIR}/sidecar.json`;
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
const FALLBACK_RUNTIME_ROOT_FILES = new Set([
  "plugin.json",
  "mcp_config.json",
  "hooks.json",
  "package.json",
  "LICENSE",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
  "README.md",
  "README.zh-CN.md"
]);
const FALLBACK_RUNTIME_DIRS = new Set([
  "agents",
  "assets",
  "context",
  "fast",
  "hooks",
  "rules",
  "scripts",
  "sidecars",
  "skills"
]);
const PRESERVED_HIDDEN_FILES = new Set([UPDATE_MARKER_NAME, ".agy-dart-sync.json"]);
const FILE_ERROR_REASONS = { EACCES: "permission", EBUSY: "locked", ETXTBSY: "locked" };

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

  // Never overwrite a Git source checkout (checks root and all ancestors).
  for (let dir = canonical; ; dir = dirname(dir)) {
    if (await safeLstat(join(dir, ".git"))) {
      throw new UpdateError("gitCheckout");
    }
    const parent = dirname(dir);
    if (parent === dir) break;
  }

  if (!allowCustomRoot) {
    if (pluginsDirectory) {
      const expectedTarget = await realpath(join(pluginsDirectory, PLUGIN_NAME)).catch(() =>
        resolve(pluginsDirectory, PLUGIN_NAME)
      );
      if (!isSamePath(canonical, expectedTarget)) {
        throw new UpdateError("notInstalled");
      }
    } else {
      const dirName = basename(canonical);
      const parentName = basename(dirname(canonical));
      if (dirName !== PLUGIN_NAME || parentName !== "plugins") {
        throw new UpdateError("notInstalled");
      }
    }
  }

  const manifest = await readDiskJson(canonical, "plugin.json");
  if (manifest?.name !== PLUGIN_NAME) throw new UpdateError("notInstalled");
  await readDiskJson(canonical, SIDECAR_MANIFEST);
  return canonical;
}

function extractRuntimeFilesFromInstallScript(scriptSource, archiveFiles) {
  const match = /RUNTIME_FILES\s*=\s*Object\.freeze\(\s*\[([\s\S]*?)\]\s*\)/.exec(scriptSource);
  if (!match) return null;
  const list = [];
  const strRegex = /"([^"\r\n]+)"/g;
  for (const [, raw] of match[1].matchAll(strRegex)) {
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

function selectFallbackRuntimeFiles(archiveFiles) {
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
  const re = new RegExp(`${constName}\\s*=\\s*Object\\.freeze\\(\\s*\\[([\\s\\S]*?)\\]\\s*\\)`);
  const m = re.exec(scriptSource);
  if (!m) return fallback;
  const names = [...m[1].matchAll(/"([^"\r\n]+)"/g)].map((x) => x[1]).filter(Boolean);
  return names.length > 0 ? names : fallback;
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
  const { command } = installedSidecar || {};
  if (typeof command === "string" && win32.isAbsolute(command)) {
    const executable = win32.basename(command).toLowerCase();
    if (executable === "node.exe" && win32.parse(command).root.length > 1) {
      try {
        const sidecar = JSON.parse(selectedFiles.get(SIDECAR_MANIFEST).toString("utf8"));
        sidecar.command = command;
        selectedFiles.set(SIDECAR_MANIFEST, Buffer.from(JSON.stringify(sidecar, null, 2) + "\n", "utf8"));
      } catch {
        // Already validated above
      }
    }
  }
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
  // Ensure every required file is always included even if runtimeList omitted something
  for (const rel of REQUIRED_FILES) {
    if (!selectedFiles.has(rel)) {
      selectedFiles.set(rel, archiveFiles.get(rel));
    }
  }

  // Verify static relative imports across all selected JS modules without executing archive code.
  const importRe = /^[ \t]*(?:(?:import|export)[^\r\n]*?\bfrom[ \t]*|import[ \t]*)['"](\.{1,2}\/[^'"\r\n]+)['"]/gm;
  for (const [rel, bytes] of selectedFiles) {
    if (!/\.[cm]?js$/i.test(rel)) continue;
    const src = bytes.toString("utf8");
    for (const [, target] of src.matchAll(importRe)) {
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

async function replaceInstalledFiles(root, stageDir, backupDir, expectedCurrentVersion, selectedRelPaths, move) {
  await mkdir(backupDir, { recursive: true });
  const markerPath = join(root, UPDATE_MARKER_NAME);
  try {
    await writeFile(markerPath, "Updating agy-dart\n", { flag: "wx" });
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

    const selectedSet = new Set(selectedRelPaths);
    const liveFiles = await listLiveFiles(root);
    const obsoleteFiles = liveFiles.filter((rel) => !selectedSet.has(rel));

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
  userConfigPath = ""
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
      if (await safeLstat(join(root, UPDATE_MARKER_NAME))) {
        throw new UpdateError("busy");
      }
      const localManifest = await readDiskJson(root, "plugin.json");
      const currentVersion = parseVersion(localManifest?.version)?.version;
      if (!currentVersion || localManifest?.name !== PLUGIN_NAME) {
        throw new UpdateError("notInstalled");
      }
      const installedSidecar = await readDiskJson(root, SIDECAR_MANIFEST);
      const installedMcp = await readOptionalJson(join(root, "mcp_config.json"));
      const installedHooks = await readOptionalJson(join(root, "hooks.json"));
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
      const tarballUrl = `https://api.github.com/repos/${REPO}/tarball/${encodeURIComponent(release.releaseTag)}`;
      const archiveBuffer = await downloadArchive(tarballUrl, downloadOptions);

      step = "validate-archive";
      const archiveFiles = await readReleaseArchive(archiveBuffer);
      const selectedFiles = prepareReleaseFiles(archiveFiles, releaseParsed.version, {
        installedMcp,
        installedHooks,
        installedSidecar,
        installedUserConfig
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
        move
      );

      return {
        ok: true,
        status: "updated",
        previousVersion: currentVersion,
        version: releaseParsed.version,
        releaseTag: release.releaseTag,
        releaseUrl: release.releaseUrl
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
