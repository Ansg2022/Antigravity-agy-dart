import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { apply as applyDshPlugin, DSH_ROUTING_PROMPT, inject as dshInject, name as dshPluginName } from "../dsh/plugin.mjs";
import { extractInvalidationTargets } from "../hooks/post-tool-use.mjs";
import { extractFastSavingsToolName, isContextExecution } from "../context/lib/execution-receipts.js";
import { runTargets } from "../scripts/targets/index.mjs";
import { resolveProfileName } from "../scripts/targets/dsh.mjs";

const src = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PRE_HOOK = path.join(src, "hooks", "pre-tool-use.mjs");
const SESSION_HOOK = path.join(src, "hooks", "session-start.mjs");

function createMockCordisContext(cwd) {
  const listeners = new Map();
  const promptSections = [];
  const ctx = {
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
    },
    inject(services, fn) {
      if (services.includes("systemPrompt")) {
        fn({
          systemPrompt: {
            section(spec) {
              promptSections.push(spec);
            }
          }
        });
      }
    },
    get(service) {
      if (service === "workingDirectory") {
        return { get: () => cwd };
      }
      return undefined;
    }
  };
  async function runWaterfall(event, exec, terminal) {
    const fns = listeners.get(event) || [];
    let i = 0;
    const next = () => (i < fns.length ? fns[i++](exec, next) : terminal());
    return next();
  }
  async function emitResult(exec, result) {
    for (const fn of listeners.get("tools/result") || []) {
      fn(exec, result);
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  return { ctx, promptSections, runWaterfall, emitResult };
}

test("v1.7.7 DSH native Cordis plugin guards read/pwsh/bash, rewrites CLI args, invalidates cache, and injects prompt section", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dsh-plugin-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const prevCfg = process.env.AGY_DART_CONFIG_PATH;
  const prevDb = process.env.AGY_DART_DB_PATH;
  process.env.AGY_DART_CONFIG_PATH = path.join(dir, "cfg.json");
  process.env.AGY_DART_DB_PATH = path.join(dir, "ctx.db");
  t.after(() => {
    if (prevCfg === undefined) delete process.env.AGY_DART_CONFIG_PATH;
    else process.env.AGY_DART_CONFIG_PATH = prevCfg;
    if (prevDb === undefined) delete process.env.AGY_DART_DB_PATH;
    else process.env.AGY_DART_DB_PATH = prevDb;
  });

  const bigTs = path.join(dir, "big.ts");
  fs.writeFileSync(
    bigTs,
    Array.from({ length: 1400 }, (_, i) => `export function fn${i}(x: number) { return x + ${i}; }`).join("\n")
  );
  const mediumJs = path.join(dir, "medium.js");
  fs.writeFileSync(mediumJs, "// header\n" + "export const line = '0123456789abcdef';\n".repeat(120));

  assert.equal(dshPluginName, "agy-dart");
  assert.deepEqual(dshInject, ["tools"]);

  const { ctx, promptSections, runWaterfall, emitResult } = createMockCordisContext(dir);
  applyDshPlugin(ctx);

  // 1. Prompt section registered cleanly with interpolate: false
  assert.equal(promptSections.length, 1);
  assert.equal(promptSections[0].name, "agy-dart:routing");
  assert.equal(promptSections[0].interpolate, false);
  assert.equal(promptSections[0].text, DSH_ROUTING_PROMPT);

  const agent = { session: { id: "dsh-sess-1", header: { cwd: dir } } };

  // 2. Oversized `read` is denied on Strike 1 with inline code outline & lowercase `read(...)` hint
  const bigReadExec = { name: "read", arguments: Object.freeze({ file_path: bigTs }), agent };
  const bigGate = await runWaterfall("tools/pre-execute", bigReadExec, async () => ({ kind: "allow" }));
  assert.equal(bigGate.kind, "deny");
  assert.match(bigGate.reason, /read\(file_path, offset, limit\)/);
  assert.match(bigGate.reason, /\[L\d+/);

  // 3. Medium file first `read` allowed -> second unchanged `read` dedup-denied -> `edit` result invalidates -> third `read` allowed
  const medRead1 = { name: "read", arguments: Object.freeze({ file_path: mediumJs }), agent };
  assert.equal((await runWaterfall("tools/pre-execute", medRead1, async () => ({ kind: "allow" }))).kind, "allow");
  const medRead2 = { name: "read", arguments: Object.freeze({ file_path: mediumJs }), agent };
  const dedupGate = await runWaterfall("tools/pre-execute", medRead2, async () => ({ kind: "allow" }));
  assert.equal(dedupGate.kind, "deny");
  assert.match(dedupGate.reason, /read-dedup/);

  await emitResult(
    { name: "edit", arguments: Object.freeze({ file_path: mediumJs, old_string: "header", new_string: "updated" }), agent },
    { content: [{ type: "text", text: "ok" }], isError: false }
  );
  const medRead3 = { name: "read", arguments: Object.freeze({ file_path: mediumJs }), agent };
  assert.equal((await runWaterfall("tools/pre-execute", medRead3, async () => ({ kind: "allow" }))).kind, "allow");

  // 4. Windows `pwsh` and POSIX `bash` CLI filter rewrites in `tools/execute` and restores original args
  for (const shellTool of ["pwsh", "bash"]) {
    const origArgs = Object.freeze({ description: "Show git history", command: "git log" });
    const exec = { name: shellTool, arguments: origArgs, agent };
    const gate = await runWaterfall("tools/pre-execute", exec, async () => ({ kind: "allow" }));
    assert.equal(gate.kind, "allow");
    let seenCommand = "";
    await runWaterfall("tools/execute", exec, async () => {
      seenCommand = exec.arguments.command;
      return { content: [{ type: "text", text: "ok" }], isError: false };
    });
    assert.notEqual(seenCommand, "git log", `${shellTool} should receive CLI-filtered command`);
    assert.equal(exec.arguments, origArgs, "original frozen arguments reference should be restored");
  }

  // 5. Background `pwsh` with run_in_background: true bypasses synchronous CLI filter rewrite
  const bgArgs = Object.freeze({ description: "Run test watcher", command: "npm test", run_in_background: true });
  const bgExec = { name: "pwsh", arguments: bgArgs, agent };
  assert.equal((await runWaterfall("tools/pre-execute", bgExec, async () => ({ kind: "allow" }))).kind, "allow");
  let bgSeenCommand = "";
  await runWaterfall("tools/execute", bgExec, async () => {
    bgSeenCommand = bgExec.arguments.command;
    return { content: [{ type: "text", text: "job-1" }], isError: false };
  });
  assert.equal(bgSeenCommand, "npm test");
});

test("v1.7.7 hook CLI bridge supports lowercase DSH tools (read/pwsh/bash), DSH MCP names, and SessionStart additionalContext", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dsh-hooks-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const env = {
    ...process.env,
    HOME: dir,
    USERPROFILE: dir,
    AGY_DART_CONFIG_PATH: path.join(dir, "cfg.json"),
    AGY_DART_DB_PATH: path.join(dir, "ctx.db")
  };

  // PreToolUse CLI bridge with lowercase pwsh
  const preRes = spawnSync(process.execPath, [PRE_HOOK], {
    env,
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: "dsh-cli-1",
      cwd: dir,
      tool_name: "pwsh",
      tool_input: { command: "git log", description: "history" }
    }),
    encoding: "utf8"
  });
  assert.equal(preRes.status, 0, preRes.stderr);
  const preOut = JSON.parse(preRes.stdout);
  assert.equal(preOut.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.notEqual(preOut.hookSpecificOutput.updatedInput.command, "git log");

  // SessionStart CLI bridge emits hookSpecificOutput.additionalContext while Antigravity keeps injectSteps
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"dsh-sample"}\n');
  const ssBridge = spawnSync(process.execPath, [SESSION_HOOK], {
    env,
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "dsh-cli-1", cwd: dir }),
    encoding: "utf8"
  });
  assert.equal(ssBridge.status, 0, ssBridge.stderr);
  const ssBridgeJson = JSON.parse(ssBridge.stdout);
  assert.equal(ssBridgeJson.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(ssBridgeJson.hookSpecificOutput.additionalContext, /agy-dart active/);

  const ssAgy = spawnSync(process.execPath, [SESSION_HOOK], {
    env,
    input: JSON.stringify({ cwd: dir }),
    encoding: "utf8"
  });
  assert.equal(ssAgy.status, 0, ssAgy.stderr);
  const ssAgyJson = JSON.parse(ssAgy.stdout);
  assert.ok(Array.isArray(ssAgyJson.injectSteps));

  // PostToolUse invalidation + execution-receipts recognize DSH tools & underscored server names
  const invEdit = extractInvalidationTargets("edit", { file_path: "src/a.js" }, dir);
  assert.deepEqual(invEdit.paths, [path.resolve(dir, "src/a.js")]);
  const invPatch = extractInvalidationTargets(
    "apply_patch",
    { input: "*** Begin Patch\n*** Update File: src/b.js\n*** Move to: src/c.js\n*** End Patch\n" },
    dir
  );
  assert.deepEqual(invPatch.paths, [path.resolve(dir, "src/b.js"), path.resolve(dir, "src/c.js")]);
  const invMcp = extractInvalidationTargets("mcp__agy_dart_fast__apply_edits", { edits: [{ path: "src/d.js" }] }, dir);
  assert.deepEqual(invMcp.paths, [path.resolve(dir, "src/d.js")]);
  const invResume = extractInvalidationTargets("mcp__agy_dart_context__ctx_resume", {}, dir);
  assert.equal(invResume.clearAllSession, true);

  assert.equal(isContextExecution({ name: "mcp__agy_dart_context__ctx_execute" }), true);
  assert.equal(extractFastSavingsToolName({ name: "mcp__agy_dart_fast__batch_search" }), "batch_search");
});

test("v1.7.7 --target dsh installs, preserves user cordis.patch.yml, handles empty [], validates live MCP doctor, and uninstalls cleanly", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dsh-target-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const desktopDir = path.join(home, ".dsh", "profiles", "desktop");
  const webDir = path.join(home, ".dsh", "profiles", "web");
  fs.mkdirSync(desktopDir, { recursive: true });
  fs.mkdirSync(webDir, { recursive: true });

  // 1. Auto-prefers `desktop` profile when present and preserves existing user entries byte-for-byte
  assert.equal(resolveProfileName(home), "desktop");
  const patchFile = path.join(desktopDir, "cordis.patch.yml");
  const originalPatch = [
    "# existing desktop patch",
    "- id: computer-use-cua-driver-native",
    "  disabled: false",
    "",
    "- insert:",
    "    - id: mcp-aiStudioYoko",
    "      name: '@deepseek-ai/dsh-mcp-client'",
    "      config:",
    "        serverName: aiStudioYoko",
    "        transport: stdio",
    "        command: 'D:\\stable\\bin\\bun.exe'",
    ""
  ].join("\r\n");
  fs.writeFileSync(patchFile, originalPatch, "utf8");

  await runTargets(src, ["install", "--target", "dsh"], home);
  const installedPatch = fs.readFileSync(patchFile, "utf8");
  assert.ok(installedPatch.startsWith(originalPatch), "existing DSH entries must stay byte-identical");
  assert.match(installedPatch, /id: mcp-agy-dart-fast/);
  assert.match(installedPatch, /toolCallTimeoutMs: 180000/);
  assert.match(installedPatch, /id: mcp-agy-dart-context/);
  assert.match(installedPatch, /toolCallTimeoutMs: 310000/);
  assert.match(installedPatch, /id: agy-dart-native/);
  assert.equal(fs.existsSync(path.join(home, ".dsh", "skills", "agy-dart", "SKILL.md")), true);

  // User adds another entry later -> doctor & reinstall & uninstall must preserve user edit
  const userExtra = "\r\n- id: custom-telemetry\r\n  disabled: true\r\n";
  fs.writeFileSync(patchFile, installedPatch + userExtra, "utf8");
  await runTargets(src, ["doctor", "--target", "dsh"], home);
  await runTargets(src, ["install", "--target", "dsh"], home);
  await runTargets(src, ["uninstall", "--target", "dsh"], home);
  assert.equal(fs.readFileSync(patchFile, "utf8"), originalPatch + userExtra);
  assert.equal(fs.existsSync(path.join(home, ".dsh", "skills", "agy-dart")), false);
  assert.equal(fs.existsSync(path.join(home, ".agy-dart", "runtime")), false);

  // 2. Handles empty `[]` cordis.patch.yml cleanly (--profile web --mcp-only) and restores `[]` on uninstall
  const webPatch = path.join(webDir, "cordis.patch.yml");
  const emptyDoc = "# default empty layer\n[]\n";
  fs.writeFileSync(webPatch, emptyDoc, "utf8");
  await runTargets(src, ["install", "--target", "dsh", "--profile", "web", "--mcp-only"], home);
  const webInstalled = fs.readFileSync(webPatch, "utf8");
  assert.doesNotMatch(webInstalled, /^\[\]\s*$/m, "empty [] must be replaced so YAML stays valid");
  assert.match(webInstalled, /id: mcp-agy-dart-fast/);
  assert.doesNotMatch(webInstalled, /id: agy-dart-native/);
  // Subsequent doctor/uninstall auto-finds recorded profile without repeating --profile
  await runTargets(src, ["doctor", "--target", "dsh"], home);
  await runTargets(src, ["uninstall", "--target", "dsh"], home);
  assert.equal(fs.readFileSync(webPatch, "utf8"), emptyDoc);

  // 3. Coexistence with codex keeps shared runtime alive until all hosts uninstall
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  await runTargets(src, ["install", "--target", "dsh,codex"], home);
  await runTargets(src, ["uninstall", "--target", "codex"], home);
  assert.equal(fs.existsSync(path.join(home, ".agy-dart", "runtime")), true);
  await runTargets(src, ["doctor", "--target", "dsh"], home);
  await runTargets(src, ["uninstall", "--target", "dsh"], home);
  assert.equal(fs.existsSync(path.join(home, ".agy-dart", "runtime")), false);
});
