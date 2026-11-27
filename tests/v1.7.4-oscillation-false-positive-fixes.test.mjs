import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { analyzeTranscriptCache } from "../context/lib/cache-analyzer.js";
import { extractVerificationSignal } from "../hooks/post-tool-use.mjs";

const __testDir = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__testDir, "..");

const T0_MS = Date.parse("2026-11-25T10:00:00Z");
const iso = (offsetSec) => new Date(T0_MS + offsetSec * 1000).toISOString();

function plannerTurn(stepIndex, offsetSec, toolCalls) {
  return {
    type: "PLANNER_RESPONSE",
    step_index: stepIndex,
    created_at: iso(offsetSec),
    model: "claude-sonnet-4-6",
    input_tokens: 3000,
    cache_read_tokens: 30000 + stepIndex * 500,
    tool_calls: toolCalls
  };
}

function toolResult(stepIndex, callId, content, extra = {}) {
  return {
    type: "TOOL_RESULT",
    step_index: stepIndex,
    tool_call_id: callId,
    content,
    ...extra
  };
}

test("v1.7.4-osc-1: Ephemeral brain scratch, artifacts, ArtifactMetadata, and OS temp edits never pollute oscillations while preserving read-dedup invalidation and workspace-in-tmp detection", () => {
  const convUuid = "550e8400-e29b-41d4-a716-446655440000";
  const scratchAuth = `C:/Users/Administrator/.gemini/antigravity/brain/${convUuid}/scratch/capture-auth-shot.mjs`;
  const scratchShowcase = `C:/Users/Administrator/.gemini/antigravity/brain/${convUuid}/scratch/capture-v2-showcase.mjs`;
  const walkthrough = `C:/Users/Administrator/.gemini/antigravity/brain/${convUuid}/walkthrough.md`;
  const winTempScript = "C:/Users/Administrator/AppData/Local/Temp/probe-shot.mjs";
  const posixTempScript = "/tmp/probe-shot.mjs";

  const steps = [];
  let si = 1;
  let sec = 0;

  // Read -> edit -> re-read scratch script: must invalidate duplicate-read cache even though scratch is excluded from oscillation
  steps.push(
    plannerTurn(si++, (sec += 5), [{ id: "r1", name: "read_file", args: { Path: scratchAuth, StartLine: 1, EndLine: 50 } }]),
    toolResult(si++, "r1", "console.log(1);")
  );
  // 4 failing edit+run iterations on scratch scripts + temp files + ArtifactMetadata
  for (let k = 0; k < 2; k++) {
    steps.push(
      plannerTurn(si++, (sec += 5), [
        { id: `sa${k}`, name: "edit_file", args: { Path: scratchAuth, Target: `a${k}`, Replacement: `a${k + 1}` } },
        { id: `ra${k}`, name: "run_command", args: { CommandLine: `node "${scratchAuth}"` } }
      ]),
      toolResult(si++, `sa${k}`, "Edited file"),
      toolResult(si++, `ra${k}`, "Command exited with code 1.\n\nCommand output:\nHTTP 404 on /assets/main.js", { status: "ERROR", exit_code: 1 })
    );
  }
  steps.push(
    plannerTurn(si++, (sec += 5), [{ id: "r2", name: "read_file", args: { Path: scratchAuth, StartLine: 1, EndLine: 50 } }]),
    toolResult(si++, "r2", "console.log(2);")
  );
  for (let k = 0; k < 2; k++) {
    steps.push(
      plannerTurn(si++, (sec += 5), [
        { id: `sv${k}`, name: "write_file", args: { Path: scratchShowcase, Content: `// v${k}` } },
        { id: `rv${k}`, name: "run_command", args: { CommandLine: `node "${scratchShowcase}"` } }
      ]),
      toolResult(si++, `sv${k}`, "Created file"),
      toolResult(si++, `rv${k}`, "Command exited with code 1.\n\nCommand output:\nWaiting for selector #root timed out", { status: "ERROR", exit_code: 1 })
    );
  }
  // Artifact walkthrough, ArtifactMetadata write, and OS temp scripts edited right before an unrelated project check failure
  steps.push(
    plannerTurn(si++, (sec += 5), [
      { id: "w1", name: "write_file", args: { Path: walkthrough, Content: "# Walkthrough" } },
      { id: "w2", name: "write_file", args: { Path: "docs/plan.md", Content: "# Plan", ArtifactMetadata: { UserFacing: true, RequestFeedback: false, Summary: "plan" } } },
      { id: "w3", name: "write_file", args: { Path: winTempScript, Content: "process.exit(1);" } },
      { id: "w4", name: "write_file", args: { Path: posixTempScript, Content: "process.exit(1);" } },
      { id: "w5", name: "run_command", args: { CommandLine: `node "${winTempScript}"` } }
    ]),
    toolResult(si++, "w1", "Created"),
    toolResult(si++, "w2", "Created"),
    toolResult(si++, "w3", "Created"),
    toolResult(si++, "w4", "Created"),
    toolResult(si++, "w5", "Command exited with code 1.", { status: "ERROR", exit_code: 1 })
  );

  const diag = analyzeTranscriptCache(steps, { nowMs: T0_MS + (sec + 10) * 1000 });
  assert.equal(diag.loopWatch.editFailOscillations, 0, `Scratch/artifact/temp must never oscillate: ${JSON.stringify(diag.loopWatch)}`);
  assert.equal(diag.loopWatch.status, "ok");
  assert.deepEqual(diag.loopWatch.oscillatingFiles, []);
  assert.equal(diag.duplicateReadCount, 0, "Editing a scratch file must still invalidate seenReadSignatures");

  // Workspace living inside OS tmpdir (e.g. unit test repos): files INSIDE workspaceCwd MUST still be tracked!
  const tmpRepo = path.join(os.tmpdir(), "agy-osc-repo-workspace");
  const repoFile = path.join(tmpRepo, "src", "app.ts");
  const repoSteps = [];
  for (let k = 0; k < 2; k++) {
    repoSteps.push(
      plannerTurn(k * 4 + 1, k * 20, [{ id: `e${k}`, name: "edit_file", args: { Path: repoFile, Target: "x", Replacement: "y" } }]),
      toolResult(k * 4 + 2, `e${k}`, "ok"),
      plannerTurn(k * 4 + 3, k * 20 + 5, [{ id: `t${k}`, name: "run_command", args: { CommandLine: "npx vitest run" } }]),
      toolResult(k * 4 + 4, `t${k}`, "AssertionError: boom", { status: "ERROR", exit_code: 1 })
    );
  }
  const diagInTmpWs = analyzeTranscriptCache(repoSteps, { nowMs: T0_MS + 60000, workspaceCwd: tmpRepo });
  assert.equal(diagInTmpWs.loopWatch.status, "warn");
  assert.equal(diagInTmpWs.loopWatch.editFailOscillations, 2);
  assert.deepEqual(diagInTmpWs.loopWatch.oscillatingFiles, ["src/app.ts"]);

  // Stringified falsy ArtifactMetadata ("null"/"false") on a real project file must NOT exclude it
  const falsyMetaSteps = [];
  for (let k = 0; k < 2; k++) {
    falsyMetaSteps.push(
      plannerTurn(k * 4 + 1, k * 20, [
        { id: `fm${k}`, name: "edit_file", args: { Path: "src/real.ts", Target: `a${k}`, Replacement: `b${k}`, ArtifactMetadata: k === 0 ? "null" : '"false"' } }
      ]),
      toolResult(k * 4 + 2, `fm${k}`, "ok"),
      plannerTurn(k * 4 + 3, k * 20 + 5, [{ id: `ft${k}`, name: "run_command", args: { CommandLine: `npx vitest run real-${k}` } }]),
      toolResult(k * 4 + 4, `ft${k}`, "AssertionError: boom", { status: "ERROR", exit_code: 1 })
    );
  }
  const diagFalsyMeta = analyzeTranscriptCache(falsyMetaSteps, { nowMs: T0_MS + 60000 });
  assert.equal(diagFalsyMeta.loopWatch.status, "warn");
  assert.equal(diagFalsyMeta.loopWatch.editFailOscillations, 2);
});

test("v1.7.4-osc-2: Zero-match filter exits (Select-String/sls/grep/rg/findstr, including quoted pipes) are benign without causing false resets, while real filter errors still fail", () => {
  // 1. Repeated edit + empty-output Select-String (with quoted alternation '|') exit 1 -> 0 oscillations
  const zeroMatchSteps = [];
  let si = 1;
  for (let k = 0; k < 3; k++) {
    zeroMatchSteps.push(
      plannerTurn(si++, k * 20, [
        { id: `e${k}`, name: "edit_file", args: { Path: "src/hooks/useFpcSettings.ts", Target: `a${k}`, Replacement: `b${k}` } },
        { id: `g${k}`, name: "run_command", args: { CommandLine: 'npx tsc --noEmit 2>&1 | Select-String -Pattern "useFpcSettings|FpcPanel"' } }
      ]),
      toolResult(si++, `e${k}`, "Edited"),
      toolResult(si++, `g${k}`, "Created At: 2026-11-25T10:00:00Z\nCompleted At: 2026-11-25T10:00:01Z\nCommand exited with code 1.\n\nCommand output:\n", { exit_code: 1 })
    );
  }
  const dZeroMatch = analyzeTranscriptCache(zeroMatchSteps, { nowMs: T0_MS + 90000 });
  assert.equal(dZeroMatch.loopWatch.editFailOscillations, 0);
  assert.equal(dZeroMatch.loopWatch.status, "ok");

  // 2. Standalone 0-match filter command or filter-only run_checks must NOT clear an already-active oscillation
  const activeOscSteps = [];
  si = 1;
  for (let k = 0; k < 2; k++) {
    activeOscSteps.push(
      plannerTurn(si++, k * 20, [{ id: `pe${k}`, name: "edit_file", args: { Path: "src/hooks/useFpcSettings.ts" } }]),
      toolResult(si++, `pe${k}`, "ok"),
      plannerTurn(si++, k * 20 + 5, [{ id: `pt${k}`, name: "run_command", args: { CommandLine: "npx vitest run" } }]),
      toolResult(si++, `pt${k}`, "AssertionError: mismatch", { status: "ERROR", exit_code: 1 })
    );
  }
  activeOscSteps.push(
    plannerTurn(si++, 50, [{ id: "f1", name: "run_command", args: { CommandLine: 'npx tsc --noEmit 2>&1 | Select-String "useFpcSettings|FpcPanel"' } }]),
    toolResult(si++, "f1", "Command exited with code 1.\n\nCommand output:\n", { exit_code: 1 }),
    plannerTurn(si++, 55, [{ id: "f2", name: "mcp_agy-dart_fast_run_checks", args: { commands: [{ name: "todo-grep", command: 'rg "TODO|FIXME" src/' }] } }]),
    toolResult(si++, "f2", 'Checks: 0/1 passed, 1 failed (wall: 22ms)\n\n## [FAIL (exit 1) 20ms] todo-grep\n$ rg "TODO|FIXME" src/\nExited with code 1')
  );
  const dStillWarn = analyzeTranscriptCache(activeOscSteps, { nowMs: T0_MS + 70000 });
  assert.equal(dStillWarn.loopWatch.status, "warn", "Filter-only 0-match checks must NOT clear prior oscillation");
  assert.equal(dStillWarn.loopWatch.editFailOscillations, 2);

  // 3. Mixed run_checks with PASS vitest + empty-output Select-String exit 1 DOES converge & clear
  const convergedViaRunChecks = [
    ...activeOscSteps,
    plannerTurn(si++, 65, [
      {
        id: "rc_ok",
        name: "mcp_agy-dart_fast_run_checks",
        args: {
          commands: [
            { name: "vitest", command: "npx vitest run" },
            { name: "tsc-filter", command: 'npx tsc --noEmit 2>&1 | Select-String "useFpcSettings|FpcPanel"' }
          ]
        }
      }
    ]),
    toolResult(
      si++,
      "rc_ok",
      'Checks: 1/2 passed, 1 failed (wall: 910ms)\n\n- [PASS 820ms] vitest (`npx vitest run`): 59 passed\n\n## [FAIL (exit 1) 80ms] tsc-filter\n$ npx tsc --noEmit 2>&1 | Select-String "useFpcSettings|FpcPanel"\nExited with code 1'
    )
  ];
  const dConv = analyzeTranscriptCache(convergedViaRunChecks, { nowMs: T0_MS + 80000 });
  assert.equal(dConv.loopWatch.editFailOscillations, 0);
  assert.equal(dConv.loopWatch.status, "ok");

  // 4. Anti-false-negative: Select-String with real stderr error OR exit code 2 MUST still fail
  const realFilterErrSteps = [];
  si = 1;
  for (let k = 0; k < 2; k++) {
    realFilterErrSteps.push(
      plannerTurn(si++, k * 20, [
        { id: `fe${k}`, name: "edit_file", args: { Path: "src/broken.ts" } },
        { id: `fc${k}`, name: "run_command", args: { CommandLine: 'Select-String "[" src/broken.ts' } }
      ]),
      toolResult(si++, `fe${k}`, "ok"),
      toolResult(si++, `fc${k}`, "Command exited with code 1.\n\nCommand output:\nSelect-String : The string [ is not a valid regular expression.", { exit_code: 1 })
    );
  }
  const dRealFilterErr = analyzeTranscriptCache(realFilterErrSteps, { nowMs: T0_MS + 60000 });
  assert.equal(dRealFilterErr.loopWatch.status, "warn");
  assert.equal(dRealFilterErr.loopWatch.editFailOscillations, 2);

  // 5. PostToolUse extractVerificationSignal alignment for run_checks
  const sigBenign = extractVerificationSignal(
    "mcp_agy-dart_fast_run_checks",
    { commands: [{ name: "vitest", command: "npx vitest run" }, { name: "tsc-filter", command: 'npx tsc --noEmit | Select-String "useFpcSettings|FpcPanel"' }] },
    'Checks: 1/2 passed, 1 failed (wall: 910ms)\n\n- [PASS 820ms] vitest (`npx vitest run`): 59 passed\n\n## [FAIL (exit 1) 80ms] tsc-filter\n$ npx tsc --noEmit | Select-String "useFpcSettings|FpcPanel"\nExited with code 1'
  );
  assert.equal(sigBenign.passed, true);
  assert.equal(sigBenign.exitCode, 0);
  assert.equal(sigBenign.failureSection, "");

  const sigRealErr = extractVerificationSignal(
    "mcp_agy-dart_fast_run_checks",
    { commands: [{ name: "vitest", command: "npx vitest run" }, { name: "tsc-filter", command: 'Select-String "[" src/a.ts' }] },
    'Checks: 1/2 passed, 1 failed (wall: 910ms)\n\n- [PASS 820ms] vitest (`npx vitest run`): 59 passed\n\n## [FAIL (exit 1) 80ms] tsc-filter\n$ Select-String "[" src/a.ts\nSelect-String : Invalid regex'
  );
  assert.equal(sigRealErr.passed, false);
  assert.equal(sigRealErr.exitCode, 1);
  assert.match(sigRealErr.failureSection, /Invalid regex/);

  const sigTimeout = extractVerificationSignal(
    "mcp_agy-dart_fast_run_checks",
    { commands: [{ name: "unit", command: "npm test" }, { name: "slow", command: "npm run e2e" }] },
    "Checks: 1/2 passed, 1 failed (wall: 60010ms)\n\n- [PASS 120ms] unit (`npm test`): 18 passed\n\n## [TIMEOUT 60000ms] slow\n$ npm run e2e\nTIMED OUT"
  );
  assert.equal(sigTimeout.passed, false);
  assert.equal(sigTimeout.exitCode, 1);
});

test("v1.7.4-osc-3: Mixed run_checks denoises pre-existing static-check errors on untouched files only when sibling test/build passes, while preserving all real regressions", () => {
  const preExistingRunChecksOut = [
    "Checks: 2/3 passed, 1 failed (wall: 3100ms)",
    "",
    "- [PASS 900ms] vitest (`npx vitest run`): 59 passed",
    "- [PASS 1800ms] build (`npx electron-vite build`): built in 1.7s",
    "",
    "## [FAIL (exit 2) 400ms] tsc",
    "$ npx tsc -p tsconfig.test.json --noEmit",
    "src/legacy/oldModule.ts(14,5): error TS2835: Relative import paths need explicit file extensions in ECMAScript imports.",
    "src/legacy/anotherOld.ts:22:3 - error TS2322: Type 'string' is not assignable to type 'number'."
  ].join("\n");

  // 1. Repeated edits to useFpcSettings.ts with vitest+build PASS and tsc ONLY reporting untouched legacy files -> 0 oscillations
  const noisySteps = [];
  let si = 1;
  for (let k = 0; k < 3; k++) {
    noisySteps.push(
      plannerTurn(si++, k * 25, [{ id: `e${k}`, name: "edit_file", args: { Path: "src/hooks/useFpcSettings.ts", Target: `v${k}`, Replacement: `v${k + 1}` } }]),
      toolResult(si++, `e${k}`, "Edited"),
      plannerTurn(si++, k * 25 + 8, [
        { id: `rc${k}`, name: "mcp_agy-dart_fast_run_checks", args: { commands: [{ name: "vitest", command: "npx vitest run" }, { name: "build", command: "npx electron-vite build" }, { name: "tsc", command: "npx tsc -p tsconfig.test.json --noEmit" }] } }
      ]),
      toolResult(si++, `rc${k}`, preExistingRunChecksOut)
    );
  }
  const dNoisy = analyzeTranscriptCache(noisySteps, { nowMs: T0_MS + 90000 });
  assert.equal(dNoisy.loopWatch.editFailOscillations, 0, `Pre-existing untouched TS2835 must not trigger oscillation: ${JSON.stringify(dNoisy.loopWatch)}`);
  assert.equal(dNoisy.loopWatch.status, "ok");

  // 2. Anti-false-negative A: tsc reports an error IN the edited file -> MUST oscillate!
  const ownFileTscOut = [
    "Checks: 2/3 passed, 1 failed (wall: 3100ms)",
    "",
    "- [PASS 900ms] vitest (`npx vitest run`): 59 passed",
    "- [PASS 1800ms] build (`npx electron-vite build`): built in 1.7s",
    "",
    "## [FAIL (exit 2) 400ms] tsc",
    "$ npx tsc --noEmit",
    "src/legacy/oldModule.ts(14,5): error TS2835: Relative import paths...",
    "src/hooks/useFpcSettings.ts(42,5): error TS2322: Type 'number' is not assignable to type 'string'."
  ].join("\n");
  const ownErrSteps = [];
  si = 1;
  for (let k = 0; k < 2; k++) {
    ownErrSteps.push(
      plannerTurn(si++, k * 25, [{ id: `oe${k}`, name: "edit_file", args: { Path: "src/hooks/useFpcSettings.ts" } }]),
      toolResult(si++, `oe${k}`, "Edited"),
      plannerTurn(si++, k * 25 + 8, [{ id: `orc${k}`, name: "mcp_agy-dart_fast_run_checks", args: { commands: [{ name: "vitest", command: "npx vitest run" }, { name: "tsc", command: "npx tsc --noEmit" }] } }]),
      toolResult(si++, `orc${k}`, ownFileTscOut)
    );
  }
  const dOwnErr = analyzeTranscriptCache(ownErrSteps, { nowMs: T0_MS + 70000 });
  assert.equal(dOwnErr.loopWatch.status, "warn");
  assert.equal(dOwnErr.loopWatch.editFailOscillations, 2);
  assert.deepEqual(dOwnErr.loopWatch.oscillatingFiles, ["src/hooks/usefpcsettings.ts"]);

  // 3. Anti-false-negative B: test runner fails in tests/fpc.test.ts (different path!) while build passes -> MUST oscillate!
  const testFailOut = [
    "Checks: 1/2 passed, 1 failed (wall: 2100ms)",
    "",
    "- [PASS 1500ms] build (`npx electron-vite build`): built in 1.5s",
    "",
    "## [FAIL (exit 1) 600ms] vitest",
    "$ npx vitest run",
    "tests/fpc.test.ts(18,5): AssertionError: expected false to be true"
  ].join("\n");
  const testFailSteps = [];
  si = 1;
  for (let k = 0; k < 2; k++) {
    testFailSteps.push(
      plannerTurn(si++, k * 25, [{ id: `te${k}`, name: "edit_file", args: { Path: "src/hooks/useFpcSettings.ts" } }]),
      toolResult(si++, `te${k}`, "Edited"),
      plannerTurn(si++, k * 25 + 8, [{ id: `trc${k}`, name: "mcp_agy-dart_fast_run_checks", args: { commands: [{ name: "build", command: "npx electron-vite build" }, { name: "vitest", command: "npx vitest run" }] } }]),
      toolResult(si++, `trc${k}`, testFailOut)
    );
  }
  const dTestFail = analyzeTranscriptCache(testFailSteps, { nowMs: T0_MS + 70000 });
  assert.equal(dTestFail.loopWatch.status, "warn");
  assert.equal(dTestFail.loopWatch.editFailOscillations, 2);

  // 4. Anti-false-negative C: standalone tsc failing (no sibling passing test/build) -> MUST oscillate!
  const standaloneTscOut = [
    "Checks: 0/1 passed, 1 failed (wall: 450ms)",
    "",
    "## [FAIL (exit 2) 450ms] tsc",
    "$ npx tsc --noEmit",
    "src/consumer.ts(10,3): error TS2339: Property 'x' does not exist on type 'Props'."
  ].join("\n");
  const standaloneSteps = [];
  si = 1;
  for (let k = 0; k < 2; k++) {
    standaloneSteps.push(
      plannerTurn(si++, k * 25, [{ id: `se${k}`, name: "edit_file", args: { Path: "src/types.ts" } }]),
      toolResult(si++, `se${k}`, "Edited"),
      plannerTurn(si++, k * 25 + 8, [{ id: `src${k}`, name: "mcp_agy-dart_fast_run_checks", args: { commands: [{ name: "tsc", command: "npx tsc --noEmit" }] } }]),
      toolResult(si++, `src${k}`, standaloneTscOut)
    );
  }
  const dStandalone = analyzeTranscriptCache(standaloneSteps, { nowMs: T0_MS + 70000 });
  assert.equal(dStandalone.loopWatch.status, "warn");
  assert.equal(dStandalone.loopWatch.editFailOscillations, 2);

  // 5. Anti-false-negative D: global tsc error with no extractable file path -> MUST oscillate!
  const globalTscOut = [
    "Checks: 1/2 passed, 1 failed (wall: 900ms)",
    "",
    "- [PASS 700ms] vitest (`npx vitest run`): 59 passed",
    "",
    "## [FAIL (exit 2) 200ms] tsc",
    "$ npx tsc --noEmit",
    "error TS6053: File 'tsconfig.base.json' not found."
  ].join("\n");
  const globalErrSteps = [];
  si = 1;
  for (let k = 0; k < 2; k++) {
    globalErrSteps.push(
      plannerTurn(si++, k * 25, [{ id: `ge${k}`, name: "edit_file", args: { Path: "src/types.ts" } }]),
      toolResult(si++, `ge${k}`, "Edited"),
      plannerTurn(si++, k * 25 + 8, [{ id: `grc${k}`, name: "mcp_agy-dart_fast_run_checks", args: { commands: [{ name: "vitest", command: "npx vitest run" }, { name: "tsc", command: "npx tsc --noEmit" }] } }]),
      toolResult(si++, `grc${k}`, globalTscOut)
    );
  }
  const dGlobal = analyzeTranscriptCache(globalErrSteps, { nowMs: T0_MS + 70000 });
  assert.equal(dGlobal.loopWatch.status, "warn");
  assert.equal(dGlobal.loopWatch.editFailOscillations, 2);

  // 6. Anti-false-negative E: truncated run_checks header saying "1 failed" with missing fail block MUST still count as fail (never false pass!)
  const truncatedRunChecksSteps = [];
  si = 1;
  for (let k = 0; k < 2; k++) {
    truncatedRunChecksSteps.push(
      plannerTurn(si++, k * 25, [{ id: `trce${k}`, name: "edit_file", args: { Path: "src/truncated.ts", Target: `x${k}`, Replacement: `y${k}` } }]),
      toolResult(si++, `trce${k}`, "Edited"),
      plannerTurn(si++, k * 25 + 8, [{ id: `trcc${k}`, name: "mcp_agy-dart_fast_run_checks", args: { commands: [{ name: "vitest", command: "npx vitest run" }, { name: "build", command: "npm run build" }] } }]),
      toolResult(si++, `trcc${k}`, "Checks: 1/2 passed, 1 failed (wall: 500ms)\n\n- [PASS 200ms] vitest (`npx vitest run`): 10 passed")
    );
  }
  const dTruncated = analyzeTranscriptCache(truncatedRunChecksSteps, { nowMs: T0_MS + 70000 });
  assert.equal(dTruncated.loopWatch.status, "warn", "Truncated run_checks with unaccounted failed count must never be treated as pass");
  assert.equal(dTruncated.loopWatch.editFailOscillations, 2);
});

test("v1.7.4-osc-4: Expanded verify commands & full async background task lifecycle prevent premature reset and converge cleanly on exit 0", () => {
  const convId = "0283d5b9-6722-4b90-a7a5-3b2a499afbcc";
  const taskId = `${convId}/task-42`;
  const walkthrough = `C:/Users/Administrator/.gemini/antigravity/brain/${convId}/walkthrough.md`;

  // Build 2x oscillation on src/components/Panel.tsx
  const oscBase = [];
  let si = 1;
  for (let k = 0; k < 2; k++) {
    oscBase.push(
      plannerTurn(si++, k * 20, [{ id: `e${k}`, name: "edit_file", args: { Path: "src/components/Panel.tsx", Target: `v${k}`, Replacement: `v${k + 1}` } }]),
      toolResult(si++, `e${k}`, "Edited"),
      plannerTurn(si++, k * 20 + 5, [{ id: `t${k}`, name: "run_command", args: { CommandLine: `npx vitest run panel-${k}` } }]),
      toolResult(si++, `t${k}`, "AssertionError: layout mismatch", { status: "ERROR", exit_code: 1 })
    );
  }

  // 1. Synchronous expanded verify commands (`electron-vite build`, `npm run doc-health-check`) clear oscillation; `git diff` does NOT
  const afterGitDiff = [
    ...oscBase,
    plannerTurn(si, 45, [{ id: "gd", name: "run_command", args: { CommandLine: "git diff src/components/Panel.tsx" } }]),
    toolResult(si + 1, "gd", "Command exited with code 0.\n\nCommand output:\ndiff --git a/src/components/Panel.tsx ...", { exit_code: 0 })
  ];
  const dAfterGitDiff = analyzeTranscriptCache(afterGitDiff, { nowMs: T0_MS + 60000 });
  assert.equal(dAfterGitDiff.loopWatch.status, "warn");
  assert.equal(dAfterGitDiff.loopWatch.editFailOscillations, 2);
  assert.equal(dAfterGitDiff.loopWatch.reason, "edit_fail_oscillation");

  const afterElectronVite = [
    ...oscBase,
    plannerTurn(si, 45, [{ id: "ev", name: "run_command", args: { CommandLine: "npx electron-vite build" } }]),
    toolResult(si + 1, "ev", "Command exited with code 0.\n\nCommand output:\nbuilt in 2.1s", { exit_code: 0 })
  ];
  const dAfterElectronVite = analyzeTranscriptCache(afterElectronVite, { nowMs: T0_MS + 60000 });
  assert.equal(dAfterElectronVite.loopWatch.status, "ok");
  assert.equal(dAfterElectronVite.loopWatch.editFailOscillations, 0);
  assert.equal(dAfterElectronVite.loopWatch.reason, null);

  const afterDocHealth = [
    ...oscBase,
    plannerTurn(si, 45, [{ id: "dh", name: "run_command", args: { CommandLine: "npm run doc-health-check" } }]),
    toolResult(si + 1, "dh", "Command exited with code 0.\n\nCommand output:\nAll docs healthy", { exit_code: 0 })
  ];
  const dAfterDocHealth = analyzeTranscriptCache(afterDocHealth, { nowMs: T0_MS + 60000 });
  assert.equal(dAfterDocHealth.loopWatch.status, "ok");
  assert.equal(dAfterDocHealth.loopWatch.editFailOscillations, 0);
  assert.equal(dAfterDocHealth.loopWatch.reason, null);

  // 2. Async background build launch MUST NOT prematurely clear while running; SYSTEM_MESSAGE exit 0 DOES clear (even after reading images & writing walkthrough.md)
  const bgLaunchSteps = [
    ...oscBase,
    plannerTurn(si++, 50, [{ id: "fix1", name: "edit_file", args: { Path: "src/components/Panel.tsx", Target: "v2", Replacement: "v3" } }]),
    toolResult(si++, "fix1", "Edited"),
    plannerTurn(si++, 55, [
      { id: "bg1", name: "run_command", args: { CommandLine: '"npx electron-vite build && node scratch/capture-v2-showcase.mjs"', WaitMsBeforeAsync: 10000 } }
    ]),
    {
      type: "GENERIC",
      step_index: si++,
      tool_call_id: "bg1",
      status: "RUNNING",
      content: `Created At: 2026-11-25T10:00:55Z\nTool is running as a background task with task id: ${taskId}\nTask Description: npx electron-vite build && node scratch/capture-v2-showcase.mjs\nLog output:\nbuilding...`
    }
  ];
  const dWhileRunning = analyzeTranscriptCache(bgLaunchSteps, { nowMs: T0_MS + 60000 });
  assert.equal(dWhileRunning.loopWatch.status, "warn", "Launching a background build must NOT prematurely clear oscillation before it exits 0");
  assert.equal(dWhileRunning.loopWatch.editFailOscillations, 2);

  const bgFinishSteps = [
    ...bgLaunchSteps,
    // Subsequent turns only read images & write brain artifact walkthrough.md
    plannerTurn(si++, 65, [{ id: "wt1", name: "write_file", args: { Path: walkthrough, Content: "# Walkthrough\nDone." } }]),
    toolResult(si++, "wt1", "Created"),
    {
      type: "SYSTEM_MESSAGE",
      step_index: si++,
      source: "SYSTEM",
      status: "DONE",
      content:
        `The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n` +
        `[Message] timestamp=2026-11-25T10:01:10Z sender=${taskId} priority=MESSAGE_PRIORITY_HIGH content=Task id "${taskId}" finished with result:\n` +
        `The tool's output was truncated due to being too long.\n\nHere is a preview with the middle of the output truncated:\n` +
        `Command exited with code 0.\n\nCommand output:\n✓ built in 11.2s\nSaved showcase screenshot\n</SYSTEM_MESSAGE>`
    }
  ];
  const dAfterBgPass = analyzeTranscriptCache(bgFinishSteps, { nowMs: T0_MS + 80000 });
  assert.equal(dAfterBgPass.loopWatch.editFailOscillations, 0, "Background verify completion with exit 0 must converge & reset oscillation");
  assert.equal(dAfterBgPass.loopWatch.status, "ok");

  // 3. Background task failure: manage_task(status) "Status: DONE" must NOT falsely reset; SYSTEM_MESSAGE exit 1 increments oscillation!
  const failTaskId = `${convId}/task-99`;
  const bgFailSteps = [
    ...oscBase,
    plannerTurn(si++, 50, [{ id: "fix2", name: "edit_file", args: { Path: "src/components/Panel.tsx", Target: "v2", Replacement: "v3-fail" } }]),
    toolResult(si++, "fix2", "Edited"),
    plannerTurn(si++, 55, [{ id: "bg2", name: "run_command", args: { CommandLine: "npm test", WaitMsBeforeAsync: 2000 } }]),
    {
      type: "GENERIC",
      step_index: si++,
      tool_call_id: "bg2",
      status: "RUNNING",
      content: `Tool is running as a background task with task id: ${failTaskId}\nTask Description: npm test`
    },
    plannerTurn(si++, 70, [{ id: "ms1", name: "manage_task", args: { Action: '"status"', TaskId: `"${failTaskId}"` } }]),
    {
      type: "GENERIC",
      step_index: si++,
      tool_call_id: "ms1",
      status: "DONE",
      content: `Task: ${failTaskId}\nStatus: DONE\nLog output:\nℹ tests 239\nℹ pass 238\nℹ fail 1`
    }
  ];
  const dAfterStatusDone = analyzeTranscriptCache(bgFailSteps, { nowMs: T0_MS + 75000 });
  assert.equal(dAfterStatusDone.loopWatch.status, "warn", "manage_task(status) bare 'Status: DONE' must NEVER clear oscillation");
  assert.equal(dAfterStatusDone.loopWatch.editFailOscillations, 2);

  const bgFailCompleted = [
    ...bgFailSteps,
    {
      type: "SYSTEM_MESSAGE",
      step_index: si++,
      source: "SYSTEM",
      status: "DONE",
      content:
        `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-25T10:01:20Z sender=${failTaskId} priority=MESSAGE_PRIORITY_HIGH content=Task id "${failTaskId}" finished with result:\n` +
        `Command exited with code 1.\n\nCommand output:\nAssertionError: layout mismatch\n</SYSTEM_MESSAGE>`
    }
  ];
  const dAfterBgFail = analyzeTranscriptCache(bgFailCompleted, { nowMs: T0_MS + 90000 });
  assert.equal(dAfterBgFail.loopWatch.status, "critical", "Failed background check must increment oscillation to critical");
  assert.equal(dAfterBgFail.loopWatch.editFailOscillations, 3);

  // 4. Epoch boundary: new project edit AFTER bg launch stays pending when old bg check passes; IsDaemon never clears
  const epochTaskId = `${convId}/task-108`;
  const epochSteps = [
    ...oscBase,
    plannerTurn(si++, 50, [{ id: "bg3", name: "run_command", args: { CommandLine: "npx vitest run", WaitMsBeforeAsync: 500 } }]),
    {
      type: "GENERIC",
      step_index: si++,
      tool_call_id: "bg3",
      status: "RUNNING",
      content: `Tool is running as a background task with task id: ${epochTaskId}\nTask Description: npx vitest run`
    },
    // New file edited AFTER bg3 launched
    plannerTurn(si++, 55, [{ id: "ne1", name: "edit_file", args: { Path: "src/newFeature.ts" } }]),
    toolResult(si++, "ne1", "Edited"),
    // bg3 finishes with exit 0 -> clears old Panel.tsx, keeps newFeature.ts pending!
    {
      type: "SYSTEM_MESSAGE",
      step_index: si++,
      source: "SYSTEM",
      status: "DONE",
      content: `<SYSTEM_MESSAGE>\n[Message] sender=${epochTaskId} content=Task id "${epochTaskId}" finished with result:\nCommand exited with code 0.\n\nCommand output:\n59 passed\n</SYSTEM_MESSAGE>`
    },
    // Subsequent test failure blames ONLY src/newFeature.ts
    plannerTurn(si++, 65, [{ id: "nt1", name: "run_command", args: { CommandLine: "npx vitest run" } }]),
    toolResult(si++, "nt1", "TypeError: undefined is not a function", { status: "ERROR", exit_code: 1 })
  ];
  const dEpoch = analyzeTranscriptCache(epochSteps, { nowMs: T0_MS + 80000 });
  assert.equal(dEpoch.loopWatch.editFailOscillations, 1);
  assert.equal(dEpoch.loopWatch.status, "ok");

  // IsDaemon command exiting 0 must NOT clear oscillation
  const daemonTaskId = `${convId}/task-120`;
  const daemonSteps = [
    ...oscBase,
    plannerTurn(si++, 50, [{ id: "dm1", name: "run_command", args: { CommandLine: "npm run build:watch", IsDaemon: true, WaitMsBeforeAsync: 500 } }]),
    {
      type: "GENERIC",
      step_index: si++,
      tool_call_id: "dm1",
      status: "RUNNING",
      content: `Tool is running as a background task with task id: ${daemonTaskId}\nTask Description: npm run build:watch`
    },
    {
      type: "SYSTEM_MESSAGE",
      step_index: si++,
      source: "SYSTEM",
      status: "DONE",
      content: `<SYSTEM_MESSAGE>\n[Message] sender=${daemonTaskId} content=Task id "${daemonTaskId}" finished with result:\nCommand exited with code 0.\n</SYSTEM_MESSAGE>`
    }
  ];
  const dDaemon = analyzeTranscriptCache(daemonSteps, { nowMs: T0_MS + 80000 });
  assert.equal(dDaemon.loopWatch.status, "warn");
  assert.equal(dDaemon.loopWatch.editFailOscillations, 2);
  assert.equal(dDaemon.loopWatch.reason, "edit_fail_oscillation");

  // 5. Synchronous test failure whose body mentions "running as a background task" MUST still count as a real failure!
  const bgMentionFailSteps = [];
  si = 1;
  for (let k = 0; k < 2; k++) {
    bgMentionFailSteps.push(
      plannerTurn(si++, k * 20, [{ id: `bm${k}`, name: "edit_file", args: { Path: "src/watchdog.ts", Target: `w${k}`, Replacement: `w${k + 1}` } }]),
      toolResult(si++, `bm${k}`, "Edited"),
      plannerTurn(si++, k * 20 + 5, [{ id: `bt${k}`, name: "run_command", args: { CommandLine: `npx vitest run wd-${k}` } }]),
      toolResult(
        si++,
        `bt${k}`,
        'Command exited with code 1.\n\nCommand output:\nAssertionError: expected "Tool is running as a background task with task id: t-1" to fail',
        { exit_code: 1 }
      )
    );
  }
  const dBgMentionFail = analyzeTranscriptCache(bgMentionFailSteps, { nowMs: T0_MS + 60000 });
  assert.equal(dBgMentionFail.loopWatch.status, "warn", "Sync test failure mentioning background task text must NOT be swallowed as bg launch");
  assert.equal(dBgMentionFail.loopWatch.editFailOscillations, 2);

  // 6. Stringified IsDaemon: '"false"' still tracks bg check + same-line </SYSTEM_MESSAGE> exit 0 converges; "was canceled with result" evicts cleanly
  const strFalseTaskId = `${convId}/task-121`;
  const strFalseSteps = [
    ...oscBase,
    plannerTurn(si++, 50, [{ id: "sf1", name: "run_command", args: { CommandLine: "npx electron-vite build", IsDaemon: '"false"', WaitMsBeforeAsync: 500 } }]),
    {
      type: "GENERIC",
      step_index: si++,
      tool_call_id: "sf1",
      status: "RUNNING",
      content: `Tool is running as a background task with task id: ${strFalseTaskId}\nTask Description: npx electron-vite build`
    },
    {
      type: "SYSTEM_MESSAGE",
      step_index: si++,
      source: "SYSTEM",
      status: "DONE",
      content: `<SYSTEM_MESSAGE>[Message] sender=${strFalseTaskId} content=Task id "${strFalseTaskId}" finished with result:\nCommand exited with code 0.</SYSTEM_MESSAGE>`
    }
  ];
  const dStrFalse = analyzeTranscriptCache(strFalseSteps, { nowMs: T0_MS + 80000 });
  assert.equal(dStrFalse.loopWatch.status, "ok");
  assert.equal(dStrFalse.loopWatch.editFailOscillations, 0);
  assert.equal(dStrFalse.loopWatch.reason, null);

  const canceledBgTaskId = `${convId}/task-122`;
  const canceledBgSteps = [
    ...oscBase,
    plannerTurn(si++, 50, [{ id: "cb1", name: "run_command", args: { CommandLine: "npm test", WaitMsBeforeAsync: 500 } }]),
    {
      type: "GENERIC",
      step_index: si++,
      tool_call_id: "cb1",
      status: "RUNNING",
      content: `Tool is running as a background task with task id: ${canceledBgTaskId}\nTask Description: npm test`
    },
    {
      type: "SYSTEM_MESSAGE",
      step_index: si++,
      source: "SYSTEM",
      status: "DONE",
      content: `<SYSTEM_MESSAGE>[Message] sender=${canceledBgTaskId} content=Task id "${canceledBgTaskId}" was canceled with result:\nStopped</SYSTEM_MESSAGE>`
    }
  ];
  const dCanceledBg = analyzeTranscriptCache(canceledBgSteps, { nowMs: T0_MS + 80000 });
  assert.equal(dCanceledBg.loopWatch.status, "warn", "Canceled bg task must neither fail nor falsely clear");
  assert.equal(dCanceledBg.loopWatch.editFailOscillations, 2);
});

test("v1.7.4-osc-5: P0-1 filter-terminal commands matching real errors (exit 0) never falsely converge or clear oscillation (sync, bg, run_checks)", () => {
  const convId = "11111111-2222-4333-8444-555555555555";
  const makeOscBase = (filePath = "src/app.ts") => {
    const steps = [];
    let si = 1;
    for (let k = 0; k < 2; k++) {
      steps.push(
        plannerTurn(si++, k * 20, [{ id: `e${k}`, name: "edit_file", args: { Path: filePath, Target: `a${k}`, Replacement: `b${k}` } }]),
        toolResult(si++, `e${k}`, "Edited"),
        plannerTurn(si++, k * 20 + 5, [{ id: `t${k}`, name: "run_command", args: { CommandLine: `npx vitest run suite-${k}` } }]),
        toolResult(si++, `t${k}`, "AssertionError: broken", { status: "ERROR", exit_code: 1 })
      );
    }
    return { steps, nextSi: si };
  };

  // 1. Sync piped filter matching real errors (exit 0 without pipefail) must NOT clear oscillation
  for (const cmd of [
    'npx tsc --noEmit 2>&1 | Select-String "TS2322"',
    'npx vitest run 2>&1 | grep "FAIL"',
    'npx tsc --noEmit 2>&1 | rg "error"',
    'npx tsc --noEmit 2>&1 | findstr "TS2322"'
  ]) {
    const { steps, nextSi } = makeOscBase();
    const syncSteps = [
      ...steps,
      plannerTurn(nextSi, 50, [{ id: "flt", name: "run_command", args: { CommandLine: cmd } }]),
      toolResult(nextSi + 1, "flt", "Command exited with code 0.\n\nCommand output:\nsrc/app.ts(10,3): error TS2322: Type mismatch", { exit_code: 0 })
    ];
    const diag = analyzeTranscriptCache(syncSteps, { nowMs: T0_MS + 70000 });
    assert.equal(diag.loopWatch.status, "warn", `Filter-terminal exit 0 must NOT clear oscillation: ${cmd}`);
    assert.equal(diag.loopWatch.editFailOscillations, 2);
    assert.equal(diag.loopWatch.reason, "edit_fail_oscillation");
  }

  // 2. Background piped filter finishing with exit 0 (matched errors) must NOT clear oscillation
  {
    const { steps, nextSi } = makeOscBase();
    const bgTaskId = `${convId}/task-10`;
    const bgSteps = [
      ...steps,
      plannerTurn(nextSi, 50, [{ id: "bgf", name: "run_command", args: { CommandLine: 'npx tsc --noEmit 2>&1 | Select-String "TS2322"', WaitMsBeforeAsync: 500 } }]),
      {
        type: "GENERIC",
        step_index: nextSi + 1,
        tool_call_id: "bgf",
        status: "RUNNING",
        content: `Tool is running as a background task with task id: ${bgTaskId}\nTask Description: tsc filter`
      },
      {
        type: "SYSTEM_MESSAGE",
        step_index: nextSi + 2,
        source: "SYSTEM",
        status: "DONE",
        content: `<SYSTEM_MESSAGE>[Message] sender=${bgTaskId} content=Task id "${bgTaskId}" finished with result:\nCommand exited with code 0.\n\nCommand output:\nsrc/app.ts(10,3): error TS2322\n</SYSTEM_MESSAGE>`
      }
    ];
    const diag = analyzeTranscriptCache(bgSteps, { nowMs: T0_MS + 70000 });
    assert.equal(diag.loopWatch.status, "warn", "Background filter exit 0 must NOT clear oscillation");
    assert.equal(diag.loopWatch.editFailOscillations, 2);
    assert.equal(diag.loopWatch.reason, "edit_fail_oscillation");
  }

  // 3. run_checks with ONLY a filter-terminal PASS block (compact or full) must be neutral, NOT clear oscillation
  for (const rcOut of [
    'Checks: 1/1 passed (wall: 95ms)\n\n- [PASS 90ms] tsc-filter (`npx tsc --noEmit 2>&1 | Select-String "TS2322"`): src/app.ts(10,3): error TS2322',
    'Checks: 1/1 passed (wall: 95ms)\n\n## [PASS 90ms] tsc-filter\n$ npx tsc --noEmit 2>&1 | grep "error"\nsrc/app.ts(10,3): error TS2322'
  ]) {
    const { steps, nextSi } = makeOscBase();
    const rcSteps = [
      ...steps,
      plannerTurn(nextSi, 50, [{ id: "rcf", name: "mcp_agy-dart_fast_run_checks", args: { commands: [{ name: "tsc-filter", command: 'npx tsc --noEmit 2>&1 | Select-String "TS2322"' }] } }]),
      toolResult(nextSi + 1, "rcf", rcOut)
    ];
    const diag = analyzeTranscriptCache(rcSteps, { nowMs: T0_MS + 70000 });
    assert.equal(diag.loopWatch.status, "warn", "Filter-only PASS run_checks must NOT clear oscillation");
    assert.equal(diag.loopWatch.editFailOscillations, 2);
    assert.equal(diag.loopWatch.reason, "edit_fail_oscillation");
  }
});

test("v1.7.4-osc-6: P1-1 concurrent same-epoch bg pass/fail preserves real failures in both completion orders; P1-2 enforces epoch guard and prevents single-edit double-counting", () => {
  const convId = "22222222-3333-4444-8555-666666666666";

  // Helper: 1 prior failure on src/worker.ts, then edit v2 and launch concurrent bgTest + bgBuild in same turn
  const buildConcurrentPair = () => {
    const taskTest = `${convId}/task-1`;
    const taskBuild = `${convId}/task-2`;
    let si = 1;
    const base = [
      plannerTurn(si++, 0, [{ id: "e1", name: "edit_file", args: { Path: "src/worker.ts", Target: "a", Replacement: "b" } }]),
      toolResult(si++, "e1", "Edited"),
      plannerTurn(si++, 5, [{ id: "t1", name: "run_command", args: { CommandLine: "npx vitest run worker-1" } }]),
      toolResult(si++, "t1", "AssertionError: fail 1", { status: "ERROR", exit_code: 1 }),
      plannerTurn(si++, 15, [{ id: "e2", name: "edit_file", args: { Path: "src/worker.ts", Target: "b", Replacement: "c" } }]),
      toolResult(si++, "e2", "Edited"),
      plannerTurn(si++, 20, [
        { id: "bgt", name: "run_command", args: { CommandLine: "npx vitest run worker-2", WaitMsBeforeAsync: 500 } },
        { id: "bgb", name: "run_command", args: { CommandLine: "npx electron-vite build", WaitMsBeforeAsync: 500 } }
      ]),
      { type: "GENERIC", step_index: si++, tool_call_id: "bgt", status: "RUNNING", content: `Tool is running as a background task with task id: ${taskTest}` },
      { type: "GENERIC", step_index: si++, tool_call_id: "bgb", status: "RUNNING", content: `Tool is running as a background task with task id: ${taskBuild}` }
    ];
    return { base, taskTest, taskBuild, nextSi: si };
  };

  // P1-1 Order A: bgTest fails FIRST, bgBuild passes SECOND -> failure must NOT be wiped out
  {
    const { base, taskTest, taskBuild, nextSi } = buildConcurrentPair();
    const stepsA = [
      ...base,
      {
        type: "SYSTEM_MESSAGE",
        step_index: nextSi,
        source: "SYSTEM",
        status: "DONE",
        content: `<SYSTEM_MESSAGE>[Message] sender=${taskTest} content=Task id "${taskTest}" finished with result:\nCommand exited with code 1.\n\nCommand output:\nAssertionError: fail 2\n</SYSTEM_MESSAGE>`
      },
      {
        type: "SYSTEM_MESSAGE",
        step_index: nextSi + 1,
        source: "SYSTEM",
        status: "DONE",
        content: `<SYSTEM_MESSAGE>[Message] sender=${taskBuild} content=Task id "${taskBuild}" finished with result:\nCommand exited with code 0.\n\nCommand output:\nbuilt\n</SYSTEM_MESSAGE>`
      }
    ];
    const diagA = analyzeTranscriptCache(stepsA, { nowMs: T0_MS + 60000 });
    assert.equal(diagA.loopWatch.status, "warn", "Order A: concurrent build pass must NOT erase test fail");
    assert.equal(diagA.loopWatch.editFailOscillations, 2);
    assert.equal(diagA.loopWatch.reason, "edit_fail_oscillation");

    // Retrying bgTest AFTER the failure without editing code -> passing retry DOES clear oscillation
    const retryTask = `${convId}/task-3`;
    const stepsRetry = [
      ...stepsA,
      plannerTurn(nextSi + 2, 40, [{ id: "bgr", name: "run_command", args: { CommandLine: "npx vitest run worker-2", WaitMsBeforeAsync: 500 } }]),
      { type: "GENERIC", step_index: nextSi + 3, tool_call_id: "bgr", status: "RUNNING", content: `Tool is running as a background task with task id: ${retryTask}` },
      {
        type: "SYSTEM_MESSAGE",
        step_index: nextSi + 4,
        source: "SYSTEM",
        status: "DONE",
        content: `<SYSTEM_MESSAGE>[Message] sender=${retryTask} content=Task id "${retryTask}" finished with result:\nCommand exited with code 0.\n\nCommand output:\n59 passed\n</SYSTEM_MESSAGE>`
      }
    ];
    const diagRetry = analyzeTranscriptCache(stepsRetry, { nowMs: T0_MS + 70000 });
    assert.equal(diagRetry.loopWatch.status, "ok", "Fresh bg retry launched after failure must clear on exit 0");
    assert.equal(diagRetry.loopWatch.editFailOscillations, 0);
    assert.equal(diagRetry.loopWatch.reason, null);
  }

  // P1-1 Order B: bgBuild passes FIRST, bgTest fails SECOND -> failure must NOT be silently dropped
  {
    const { base, taskTest, taskBuild, nextSi } = buildConcurrentPair();
    const stepsB = [
      ...base,
      {
        type: "SYSTEM_MESSAGE",
        step_index: nextSi,
        source: "SYSTEM",
        status: "DONE",
        content: `<SYSTEM_MESSAGE>[Message] sender=${taskBuild} content=Task id "${taskBuild}" finished with result:\nCommand exited with code 0.\n\nCommand output:\nbuilt\n</SYSTEM_MESSAGE>`
      },
      {
        type: "SYSTEM_MESSAGE",
        step_index: nextSi + 1,
        source: "SYSTEM",
        status: "DONE",
        content: `<SYSTEM_MESSAGE>[Message] sender=${taskTest} content=Task id "${taskTest}" finished with result:\nCommand exited with code 1.\n\nCommand output:\nAssertionError: fail 2\n</SYSTEM_MESSAGE>`
      }
    ];
    const diagB = analyzeTranscriptCache(stepsB, { nowMs: T0_MS + 60000 });
    assert.equal(diagB.loopWatch.status, "warn", "Order B: early build pass must NOT swallow subsequent concurrent test fail");
    assert.equal(diagB.loopWatch.editFailOscillations, 2);
    assert.equal(diagB.loopWatch.reason, "edit_fail_oscillation");
  }

  // P1-1 Both pass -> clears cleanly; build pass + sibling killed -> deferred pass clears cleanly
  {
    const { base, taskTest, taskBuild, nextSi } = buildConcurrentPair();
    const bothPass = [
      ...base,
      {
        type: "SYSTEM_MESSAGE",
        step_index: nextSi,
        source: "SYSTEM",
        status: "DONE",
        content: `<SYSTEM_MESSAGE>[Message] sender=${taskBuild} content=Task id "${taskBuild}" finished with result:\nCommand exited with code 0.\n</SYSTEM_MESSAGE>`
      },
      {
        type: "SYSTEM_MESSAGE",
        step_index: nextSi + 1,
        source: "SYSTEM",
        status: "DONE",
        content: `<SYSTEM_MESSAGE>[Message] sender=${taskTest} content=Task id "${taskTest}" finished with result:\nCommand exited with code 0.\n</SYSTEM_MESSAGE>`
      }
    ];
    const dBoth = analyzeTranscriptCache(bothPass, { nowMs: T0_MS + 60000 });
    assert.equal(dBoth.loopWatch.status, "ok");
    assert.equal(dBoth.loopWatch.editFailOscillations, 0);

    const passThenKill = [
      ...base,
      {
        type: "SYSTEM_MESSAGE",
        step_index: nextSi,
        source: "SYSTEM",
        status: "DONE",
        content: `<SYSTEM_MESSAGE>[Message] sender=${taskBuild} content=Task id "${taskBuild}" finished with result:\nCommand exited with code 0.\n</SYSTEM_MESSAGE>`
      },
      plannerTurn(nextSi + 1, 35, [{ id: "k1", name: "manage_task", args: { Action: "kill", TaskId: taskTest } }]),
      toolResult(nextSi + 2, "k1", "Killed task")
    ];
    const dKill = analyzeTranscriptCache(passThenKill, { nowMs: T0_MS + 60000 });
    assert.equal(dKill.loopWatch.status, "ok", "Killing remaining sibling after sibling pass should flush deferred pass");
    assert.equal(dKill.loopWatch.editFailOscillations, 0);
  }

  // P1-2 (a): Single edit + concurrent sync fail + bg fail must NOT double-count to osc=2 (warn);
  // and if concurrent bg instead passes, it must NOT wipe out the same-turn sync failure
  {
    const bgId = `${convId}/task-20`;
    let si = 1;
    const singleEditBase = [
      plannerTurn(si++, 0, [{ id: "se1", name: "edit_file", args: { Path: "src/single.ts" } }]),
      toolResult(si++, "se1", "Edited"),
      plannerTurn(si++, 5, [
        { id: "sync1", name: "run_command", args: { CommandLine: "npx vitest run single" } },
        { id: "bg1", name: "run_command", args: { CommandLine: "npx electron-vite build", WaitMsBeforeAsync: 500 } }
      ]),
      toolResult(si++, "sync1", "AssertionError: boom", { status: "ERROR", exit_code: 1 }),
      { type: "GENERIC", step_index: si++, tool_call_id: "bg1", status: "RUNNING", content: `Tool is running as a background task with task id: ${bgId}` }
    ];
    const singleEditDoubleFail = [
      ...singleEditBase,
      {
        type: "SYSTEM_MESSAGE",
        step_index: si,
        source: "SYSTEM",
        status: "DONE",
        content: `<SYSTEM_MESSAGE>[Message] sender=${bgId} content=Task id "${bgId}" finished with result:\nCommand exited with code 1.\n\nCommand output:\nBuild error\n</SYSTEM_MESSAGE>`
      }
    ];
    const dSingle = analyzeTranscriptCache(singleEditDoubleFail, { nowMs: T0_MS + 50000 });
    assert.equal(dSingle.loopWatch.editFailOscillations, 1, "Single edit must NOT be double-counted by concurrent sync + bg failures");
    assert.equal(dSingle.loopWatch.status, "ok");

    const singleEditSyncFailBgPass = [
      ...singleEditBase,
      {
        type: "SYSTEM_MESSAGE",
        step_index: si,
        source: "SYSTEM",
        status: "DONE",
        content: `<SYSTEM_MESSAGE>[Message] sender=${bgId} content=Task id "${bgId}" finished with result:\nCommand exited with code 0.\n\nCommand output:\nbuilt\n</SYSTEM_MESSAGE>`
      }
    ];
    const dSyncFailBgPass = analyzeTranscriptCache(singleEditSyncFailBgPass, { nowMs: T0_MS + 50000 });
    assert.equal(dSyncFailBgPass.loopWatch.editFailOscillations, 1, "Same-turn bg pass must NOT erase same-turn sync failure");
  }

  // P1-2 (b): Stale bg1 fail arriving AFTER v2 edit must NOT pollute v2 and cause immediate warn on v2's first failure
  {
    const staleBgId = `${convId}/task-21`;
    let si = 1;
    const staleBgSteps = [
      plannerTurn(si++, 0, [{ id: "v1", name: "edit_file", args: { Path: "src/ver.ts", Target: "a", Replacement: "b" } }]),
      toolResult(si++, "v1", "Edited"),
      plannerTurn(si++, 5, [{ id: "bg1", name: "run_command", args: { CommandLine: "npm test", WaitMsBeforeAsync: 500 } }]),
      { type: "GENERIC", step_index: si++, tool_call_id: "bg1", status: "RUNNING", content: `Tool is running as a background task with task id: ${staleBgId}` },
      // Edit v2 before bg1 settles
      plannerTurn(si++, 10, [{ id: "v2", name: "edit_file", args: { Path: "src/ver.ts", Target: "b", Replacement: "c" } }]),
      toolResult(si++, "v2", "Edited"),
      // Stale bg1 from v1 fails -> MUST be ignored (fileLastEditEpoch=2 > launchEditEpoch=1)
      {
        type: "SYSTEM_MESSAGE",
        step_index: si++,
        source: "SYSTEM",
        status: "DONE",
        content: `<SYSTEM_MESSAGE>[Message] sender=${staleBgId} content=Task id "${staleBgId}" finished with result:\nCommand exited with code 1.\n\nCommand output:\nAssertionError: stale v1 fail\n</SYSTEM_MESSAGE>`
      },
      // Now v2's first check fails -> osc must be 1 (ok), NOT 2 (warn)
      plannerTurn(si++, 20, [{ id: "t2", name: "run_command", args: { CommandLine: "npm test" } }]),
      toolResult(si++, "t2", "AssertionError: v2 first fail", { status: "ERROR", exit_code: 1 })
    ];
    const dStale = analyzeTranscriptCache(staleBgSteps, { nowMs: T0_MS + 60000 });
    assert.equal(dStale.loopWatch.editFailOscillations, 1, "Stale v1 bg failure must NOT pollute v2");
    assert.equal(dStale.loopWatch.status, "ok");
  }
});

test("v1.7.4-osc-7: P1-3 Log output cannot forge manage_task(status) exit code; P1-4 handles bg 0-match </SYSTEM_MESSAGE>, failed-with-error exit code, and multi-completion SYSTEM_MESSAGE", () => {
  const convId = "33333333-4444-4555-8666-777777777777";

  // Build 2x oscillation on src/service.ts
  const oscBase = [];
  let si = 1;
  for (let k = 0; k < 2; k++) {
    oscBase.push(
      plannerTurn(si++, k * 20, [{ id: `e${k}`, name: "edit_file", args: { Path: "src/service.ts", Target: `v${k}`, Replacement: `v${k + 1}` } }]),
      toolResult(si++, `e${k}`, "Edited"),
      plannerTurn(si++, k * 20 + 5, [{ id: `t${k}`, name: "run_command", args: { CommandLine: `npx vitest run svc-${k}` } }]),
      toolResult(si++, `t${k}`, "AssertionError: bad response", { status: "ERROR", exit_code: 1 })
    );
  }

  // P1-3: manage_task(status) Log output containing "Command exited with code 0." must NOT prematurely clear
  {
    const taskId = `${convId}/task-30`;
    const spoofedStatusSteps = [
      ...oscBase,
      plannerTurn(si, 50, [{ id: "bg0", name: "run_command", args: { CommandLine: "npm test", WaitMsBeforeAsync: 500 } }]),
      { type: "GENERIC", step_index: si + 1, tool_call_id: "bg0", status: "RUNNING", content: `Tool is running as a background task with task id: ${taskId}` },
      plannerTurn(si + 2, 55, [{ id: "ms0", name: "manage_task", args: { Action: "status", TaskId: taskId } }]),
      {
        type: "GENERIC",
        step_index: si + 3,
        tool_call_id: "ms0",
        status: "RUNNING",
        content: `Task: ${taskId}\nStatus: RUNNING\nLog output:\nfixture child output:\nCommand exited with code 0.\nstill running suite...`
      }
    ];
    const dSpoof = analyzeTranscriptCache(spoofedStatusSteps, { nowMs: T0_MS + 70000 });
    assert.equal(dSpoof.loopWatch.status, "warn", "Log output text must NOT forge exit 0 in manage_task(status)");
    assert.equal(dSpoof.loopWatch.editFailOscillations, 2);
    assert.equal(dSpoof.loopWatch.reason, "edit_fail_oscillation");

    // Genuine exit 0 BEFORE Log output DOES settle & clear
    const realStatusSteps = [
      ...spoofedStatusSteps,
      plannerTurn(si + 4, 65, [{ id: "ms1", name: "manage_task", args: { Action: "status", TaskId: taskId } }]),
      {
        type: "GENERIC",
        step_index: si + 5,
        tool_call_id: "ms1",
        status: "DONE",
        content: `Task: ${taskId}\nStatus: DONE\nCommand exited with code 0.\nLog output:\nall passed`
      }
    ];
    const dReal = analyzeTranscriptCache(realStatusSteps, { nowMs: T0_MS + 80000 });
    assert.equal(dReal.loopWatch.status, "ok");
    assert.equal(dReal.loopWatch.editFailOscillations, 0);
  }

  // P1-4 (a): Background 0-match Select-String exit 1 with trailing </SYSTEM_MESSAGE> is benign; failed with error exit 2 still fails
  {
    const zmTaskId = `${convId}/task-31`;
    let s2 = 1;
    const bgZeroMatchSteps = [
      plannerTurn(s2++, 0, [{ id: "ze1", name: "edit_file", args: { Path: "src/clean.ts" } }]),
      toolResult(s2++, "ze1", "Edited"),
      plannerTurn(s2++, 5, [{ id: "zbg1", name: "run_command", args: { CommandLine: 'npx tsc --noEmit 2>&1 | Select-String "clean"', WaitMsBeforeAsync: 500 } }]),
      { type: "GENERIC", step_index: s2++, tool_call_id: "zbg1", status: "RUNNING", content: `Tool is running as a background task with task id: ${zmTaskId}` },
      {
        type: "SYSTEM_MESSAGE",
        step_index: s2++,
        source: "SYSTEM",
        status: "DONE",
        content: `<SYSTEM_MESSAGE>\n[Message] sender=${zmTaskId} content=Task id "${zmTaskId}" finished with result:\nCommand exited with code 1.\n\nCommand output:\n</SYSTEM_MESSAGE>`
      }
    ];
    const dZm = analyzeTranscriptCache(bgZeroMatchSteps, { nowMs: T0_MS + 40000 });
    assert.equal(dZm.loopWatch.editFailOscillations, 0, "Bg 0-match filter with </SYSTEM_MESSAGE> must NOT count as failure");
    assert.equal(dZm.loopWatch.status, "ok");

    // Anti-false-negative: "failed with error:" with exit code 2 on filter command MUST count as real failure
    const err2TaskId = `${convId}/task-32`;
    let s3 = 1;
    const bgExit2Steps = [];
    for (let k = 0; k < 2; k++) {
      const tid = `${err2TaskId}-${k}`;
      bgExit2Steps.push(
        plannerTurn(s3++, k * 20, [{ id: `e2_${k}`, name: "edit_file", args: { Path: "src/badfilter.ts", Target: `a${k}`, Replacement: `b${k}` } }]),
        toolResult(s3++, `e2_${k}`, "Edited"),
        plannerTurn(s3++, k * 20 + 5, [{ id: `bg2_${k}`, name: "run_command", args: { CommandLine: 'npx tsc --noEmit 2>&1 | grep "["', WaitMsBeforeAsync: 500 } }]),
        { type: "GENERIC", step_index: s3++, tool_call_id: `bg2_${k}`, status: "RUNNING", content: `Tool is running as a background task with task id: ${tid}` },
        {
          type: "SYSTEM_MESSAGE",
          step_index: s3++,
          source: "SYSTEM",
          status: "DONE",
          content: `<SYSTEM_MESSAGE>\n[Message] sender=${tid} content=Task id "${tid}" failed with error:\nCommand exited with code 2.\n\nCommand output:\n</SYSTEM_MESSAGE>`
        }
      );
    }
    const dExit2 = analyzeTranscriptCache(bgExit2Steps, { nowMs: T0_MS + 60000 });
    assert.equal(dExit2.loopWatch.status, "warn", "Bg filter 'failed with error' exit 2 must still record failure");
    assert.equal(dExit2.loopWatch.editFailOscillations, 2);
  }

  // P1-4 (b): Merged SYSTEM_MESSAGE with TWO [Message] completions settles BOTH tasks
  {
    const task1 = `${convId}/task-40`;
    const task2 = `${convId}/task-41`;
    const mergedSteps = [
      ...oscBase,
      plannerTurn(si, 50, [
        { id: "m1", name: "run_command", args: { CommandLine: "npx electron-vite build", WaitMsBeforeAsync: 500 } },
        { id: "m2", name: "run_command", args: { CommandLine: "npx vitest run", WaitMsBeforeAsync: 500 } }
      ]),
      { type: "GENERIC", step_index: si + 1, tool_call_id: "m1", status: "RUNNING", content: `Tool is running as a background task with task id: ${task1}` },
      { type: "GENERIC", step_index: si + 2, tool_call_id: "m2", status: "RUNNING", content: `Tool is running as a background task with task id: ${task2}` },
      {
        type: "SYSTEM_MESSAGE",
        step_index: si + 3,
        source: "SYSTEM",
        status: "DONE",
        content:
          `The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n` +
          `[Message] timestamp=2026-11-25T10:01:10Z sender=${task1} priority=MESSAGE_PRIORITY_HIGH content=Task id "${task1}" finished with result:\n` +
          `Command exited with code 0.\n\nCommand output:\nbuilt in 1.2s\n` +
          `[Message] timestamp=2026-11-25T10:01:11Z sender=${task2} priority=MESSAGE_PRIORITY_HIGH content=Task id "${task2}" finished with result:\n` +
          `Command exited with code 0.\n\nCommand output:\n59 passed\n</SYSTEM_MESSAGE>`
      }
    ];
    const dMerged = analyzeTranscriptCache(mergedSteps, { nowMs: T0_MS + 80000 });
    assert.equal(dMerged.loopWatch.status, "ok", "Both tasks in merged SYSTEM_MESSAGE must settle and clear oscillation");
    assert.equal(dMerged.loopWatch.editFailOscillations, 0);
    assert.equal(dMerged.loopWatch.reason, null);

    // Merged SYSTEM_MESSAGE where 1st passes and 2nd fails -> 2nd failure MUST NOT be dropped
    const mergedFailSteps = [
      ...oscBase,
      plannerTurn(si, 50, [{ id: "me", name: "edit_file", args: { Path: "src/service.ts", Target: "v2", Replacement: "v3" } }]),
      toolResult(si + 1, "me", "Edited"),
      plannerTurn(si + 2, 55, [
        { id: "mf1", name: "run_command", args: { CommandLine: "npx electron-vite build", WaitMsBeforeAsync: 500 } },
        { id: "mf2", name: "run_command", args: { CommandLine: "npx vitest run", WaitMsBeforeAsync: 500 } }
      ]),
      { type: "GENERIC", step_index: si + 3, tool_call_id: "mf1", status: "RUNNING", content: `Tool is running as a background task with task id: ${task1}` },
      { type: "GENERIC", step_index: si + 4, tool_call_id: "mf2", status: "RUNNING", content: `Tool is running as a background task with task id: ${task2}` },
      {
        type: "SYSTEM_MESSAGE",
        step_index: si + 5,
        source: "SYSTEM",
        status: "DONE",
        content:
          `<SYSTEM_MESSAGE>\n` +
          `[Message] sender=${task1} content=Task id "${task1}" finished with result:\nCommand exited with code 0.\n\nCommand output:\nbuilt\n` +
          `[Message] sender=${task2} content=Task id "${task2}" finished with result:\nCommand exited with code 1.\n\nCommand output:\nAssertionError: still broken\n</SYSTEM_MESSAGE>`
      }
    ];
    const dMergedFail = analyzeTranscriptCache(mergedFailSteps, { nowMs: T0_MS + 80000 });
    assert.equal(dMergedFail.loopWatch.status, "critical", "2nd failing task in merged SYSTEM_MESSAGE must increment oscillation to critical");
    assert.equal(dMergedFail.loopWatch.editFailOscillations, 3);
  }
});

test("v1.7.4-osc-8: P1-5 rejects read-only inspect commands from verify/strong-pass; P1-6 blocks crash-stack, ../ monorepo, and custom/compound script false denoising", () => {
  // P1-5: Read-only commands with test/script/build filenames exiting 0 must NOT clear active oscillation
  const oscBase = [];
  let si = 1;
  for (let k = 0; k < 2; k++) {
    oscBase.push(
      plannerTurn(si++, k * 20, [{ id: `e${k}`, name: "edit_file", args: { Path: "src/core.ts", Target: `a${k}`, Replacement: `b${k}` } }]),
      toolResult(si++, `e${k}`, "Edited"),
      plannerTurn(si++, k * 20 + 5, [{ id: `t${k}`, name: "run_command", args: { CommandLine: `npx vitest run core-${k}` } }]),
      toolResult(si++, `t${k}`, "AssertionError: boom", { status: "ERROR", exit_code: 1 })
    );
  }

  for (const roCmd of [
    "git diff tests/app.test.ts",
    "git diff scripts/verify-package-graph.mjs",
    "cat webpack.config.js",
    "ls scripts/check-env.mjs",
    'echo "run test"',
    'rg "vitest" tests/',
    "Get-Content webpack.config.js",
    "gci scripts/verify-package-graph.mjs"
  ]) {
    const steps = [
      ...oscBase,
      plannerTurn(si, 50, [{ id: "ro", name: "run_command", args: { CommandLine: roCmd } }]),
      toolResult(si + 1, "ro", "Command exited with code 0.\n\nCommand output:\nok", { exit_code: 0 })
    ];
    const diag = analyzeTranscriptCache(steps, { nowMs: T0_MS + 70000 });
    assert.equal(diag.loopWatch.status, "warn", `Read-only command must NOT clear oscillation: ${roCmd}`);
    assert.equal(diag.loopWatch.editFailOscillations, 2);
    assert.equal(diag.loopWatch.reason, "edit_fail_oscillation");
  }

  // Real script execution (after executor) DOES clear oscillation
  {
    const steps = [
      ...oscBase,
      plannerTurn(si, 50, [{ id: "vs", name: "run_command", args: { CommandLine: "node scripts/verify-package-graph.mjs" } }]),
      toolResult(si + 1, "vs", "Command exited with code 0.\n\nCommand output:\nAll ok", { exit_code: 0 })
    ];
    const diag = analyzeTranscriptCache(steps, { nowMs: T0_MS + 70000 });
    assert.equal(diag.loopWatch.status, "ok");
    assert.equal(diag.loopWatch.editFailOscillations, 0);
    assert.equal(diag.loopWatch.reason, null);
  }

  // P1-5 strong verify: git diff tests/app.test.ts PASS in run_checks must NOT enable static denoising
  {
    const rcOut = [
      "Checks: 1/2 passed, 1 failed (wall: 300ms)",
      "",
      "- [PASS 20ms] diff (`git diff tests/app.test.ts`): diff --git a/tests/app.test.ts",
      "",
      "## [FAIL (exit 2) 280ms] tsc",
      "$ npx tsc --noEmit",
      "src/legacy/old.ts(10,3): error TS2322: bad type"
    ].join("\n");
    const steps = [];
    let s2 = 1;
    for (let k = 0; k < 2; k++) {
      steps.push(
        plannerTurn(s2++, k * 20, [{ id: `ge${k}`, name: "edit_file", args: { Path: "src/app.ts", Target: `a${k}`, Replacement: `b${k}` } }]),
        toolResult(s2++, `ge${k}`, "Edited"),
        plannerTurn(s2++, k * 20 + 5, [{ id: `gr${k}`, name: "mcp_agy-dart_fast_run_checks", args: { commands: [{ name: "diff", command: "git diff tests/app.test.ts" }, { name: "tsc", command: "npx tsc --noEmit" }] } }]),
        toolResult(s2++, `gr${k}`, rcOut)
      );
    }
    const diag = analyzeTranscriptCache(steps, { nowMs: T0_MS + 60000 });
    assert.equal(diag.loopWatch.status, "warn", "git diff tests/app.test.ts must NOT act as strong verify pass for denoising");
    assert.equal(diag.loopWatch.editFailOscillations, 2);
  }

  // P1-6 (a): Crashed tsc/eslint (node_modules stack trace, FATAL ERROR, Oops! Something went wrong) must NOT be denoised
  for (const crashBody of [
    "TypeError: Cannot read properties of undefined\n    at checkSourceFile (node_modules/typescript/lib/tsc.js:58240:12)\n    at node_modules/typescript/lib/tsc.js:58240:12",
    "    at node_modules/typescript/lib/tsc.js:58240:12",
    "FATAL ERROR: Reached heap limit Allocation failed\nsrc/legacy/old.ts(1,1): error TS2835: ignored",
    "Oops! Something went wrong! :(\nESLint: 9.0.0\nsrc/legacy/old.ts:1:1"
  ]) {
    const rcOut = [
      "Checks: 1/2 passed, 1 failed (wall: 900ms)",
      "",
      "- [PASS 700ms] vitest (`npx vitest run`): 59 passed",
      "",
      "## [FAIL (exit 2) 200ms] tsc",
      "$ npx tsc --noEmit",
      crashBody
    ].join("\n");
    const steps = [];
    let s2 = 1;
    for (let k = 0; k < 2; k++) {
      steps.push(
        plannerTurn(s2++, k * 20, [{ id: `ce${k}`, name: "edit_file", args: { Path: "src/app.ts", Target: `a${k}`, Replacement: `b${k}` } }]),
        toolResult(s2++, `ce${k}`, "Edited"),
        plannerTurn(s2++, k * 20 + 5, [{ id: `cr${k}`, name: "mcp_agy-dart_fast_run_checks", args: { commands: [{ name: "vitest", command: "npx vitest run" }, { name: "tsc", command: "npx tsc --noEmit" }] } }]),
        toolResult(s2++, `cr${k}`, rcOut)
      );
    }
    const diag = analyzeTranscriptCache(steps, { nowMs: T0_MS + 60000 });
    assert.equal(diag.loopWatch.status, "warn", `Static tool crash must NEVER be denoised: ${crashBody.slice(0, 40)}`);
    assert.equal(diag.loopWatch.editFailOscillations, 2);
  }

  // P1-6 (b): Monorepo ../shared/fpc.ts MUST match edited packages/shared/fpc.ts and NOT be denoised
  {
    const rcOut = [
      "Checks: 1/2 passed, 1 failed (wall: 900ms)",
      "",
      "- [PASS 700ms] vitest (`npx vitest run`): 59 passed",
      "",
      "## [FAIL (exit 2) 200ms] tsc",
      "$ npx tsc --noEmit",
      "../shared/fpc.ts(10,3): error TS2322: Type 'string' is not assignable to type 'number'."
    ].join("\n");
    const steps = [];
    let s2 = 1;
    for (let k = 0; k < 2; k++) {
      steps.push(
        plannerTurn(s2++, k * 20, [{ id: `me${k}`, name: "edit_file", args: { Path: "packages/shared/fpc.ts", Target: `a${k}`, Replacement: `b${k}` } }]),
        toolResult(s2++, `me${k}`, "Edited"),
        plannerTurn(s2++, k * 20 + 5, [{ id: `mr${k}`, name: "mcp_agy-dart_fast_run_checks", args: { commands: [{ name: "vitest", command: "npx vitest run" }, { name: "tsc", command: "npx tsc --noEmit" }] } }]),
        toolResult(s2++, `mr${k}`, rcOut)
      );
    }
    const diag = analyzeTranscriptCache(steps, { nowMs: T0_MS + 60000 });
    assert.equal(diag.loopWatch.status, "warn", "Monorepo ../shared/fpc.ts must overlap edited packages/shared/fpc.ts");
    assert.equal(diag.loopWatch.editFailOscillations, 2);
  }

  // P1-6 (c): Custom script `node tests/eslint-rule.mjs` & compound `npm run lint && npm run build` must NOT be denoised
  for (const [blkName, blkCmd] of [
    ["eslint-rule", "node tests/eslint-rule.mjs"],
    ["lint-build", "npm run lint && npm run build"]
  ]) {
    const rcOut = [
      "Checks: 1/2 passed, 1 failed (wall: 900ms)",
      "",
      "- [PASS 700ms] vitest (`npx vitest run`): 59 passed",
      "",
      `## [FAIL (exit 1) 200ms] ${blkName}`,
      `$ ${blkCmd}`,
      "src/legacy/old.ts(10,3): error rule failed"
    ].join("\n");
    const steps = [];
    let s2 = 1;
    for (let k = 0; k < 2; k++) {
      steps.push(
        plannerTurn(s2++, k * 20, [{ id: `xe${k}`, name: "edit_file", args: { Path: "src/app.ts", Target: `a${k}`, Replacement: `b${k}` } }]),
        toolResult(s2++, `xe${k}`, "Edited"),
        plannerTurn(s2++, k * 20 + 5, [{ id: `xr${k}`, name: "mcp_agy-dart_fast_run_checks", args: { commands: [{ name: "vitest", command: "npx vitest run" }, { name: blkName, command: blkCmd }] } }]),
        toolResult(s2++, `xr${k}`, rcOut)
      );
    }
    const diag = analyzeTranscriptCache(steps, { nowMs: T0_MS + 60000 });
    assert.equal(diag.loopWatch.status, "warn", `Non-pure static check must NOT be denoised: ${blkCmd}`);
    assert.equal(diag.loopWatch.editFailOscillations, 2);
  }

  // Positive ESLint check: stylish output ending with "✖ 1 problem (1 error, 0 warnings)" on untouched file still denoises cleanly
  {
    const eslintOut = [
      "Checks: 1/2 passed, 1 failed (wall: 900ms)",
      "",
      "- [PASS 700ms] vitest (`npx vitest run`): 59 passed",
      "",
      "## [FAIL (exit 1) 200ms] eslint",
      "$ npx eslint src/",
      "src/legacy/old.ts",
      "  12:5  error  Unexpected any  @typescript-eslint/no-explicit-any",
      "",
      "✖ 1 problem (1 error, 0 warnings)"
    ].join("\n");
    const steps = [];
    let s2 = 1;
    for (let k = 0; k < 2; k++) {
      steps.push(
        plannerTurn(s2++, k * 20, [{ id: `ee${k}`, name: "edit_file", args: { Path: "src/app.ts", Target: `a${k}`, Replacement: `b${k}` } }]),
        toolResult(s2++, `ee${k}`, "Edited"),
        plannerTurn(s2++, k * 20 + 5, [{ id: `er${k}`, name: "mcp_agy-dart_fast_run_checks", args: { commands: [{ name: "vitest", command: "npx vitest run" }, { name: "eslint", command: "npx eslint src/" }] } }]),
        toolResult(s2++, `er${k}`, eslintOut)
      );
    }
    const diag = analyzeTranscriptCache(steps, { nowMs: T0_MS + 60000 });
    assert.equal(diag.loopWatch.status, "ok", "Normal ESLint stylish output on untouched file should still denoise");
    assert.equal(diag.loopWatch.editFailOscillations, 0);
  }
});

test("v1.7.4-osc-9: P1-7 shell quoting/&&/Windows backslash/PS backtick parity; P2-1/P2-2 post-tool-use null-checkpoint, parallel order, bg-tool guard, macOS tmpdir, and sessionEditedFiles", () => {
  // P1-7 (a): Silent preceding && failure must NOT be treated as benign 0-match in cache-analyzer or post-tool-use
  {
    const badCmd = 'node -e "process.exit(1)" && Select-String "foo" src/a.ts';
    const steps = [];
    let si = 1;
    for (let k = 0; k < 2; k++) {
      steps.push(
        plannerTurn(si++, k * 20, [
          { id: `e${k}`, name: "edit_file", args: { Path: "src/andfail.ts", Target: `a${k}`, Replacement: `b${k}` } },
          { id: `c${k}`, name: "run_command", args: { CommandLine: badCmd } }
        ]),
        toolResult(si++, `e${k}`, "Edited"),
        toolResult(si++, `c${k}`, "Command exited with code 1.\n\nCommand output:\n", { exit_code: 1 })
      );
    }
    const diag = analyzeTranscriptCache(steps, { nowMs: T0_MS + 60000 });
    assert.equal(diag.loopWatch.status, "warn", "Silent && preceding failure must NOT be exempted as benign 0-match");
    assert.equal(diag.loopWatch.editFailOscillations, 2);

    const sig = extractVerificationSignal(
      "mcp_agy-dart_fast_run_checks",
      { commands: [{ name: "vitest", command: "npx vitest run" }, { name: "bad", command: badCmd }] },
      `Checks: 1/2 passed, 1 failed (wall: 500ms)\n\n- [PASS 400ms] vitest (\`npx vitest run\`): 10 passed\n\n## [FAIL (exit 1) 10ms] bad\n$ ${badCmd}\nExited with code 1`
    );
    assert.equal(sig.passed, false);
    assert.equal(sig.exitCode, 1);
  }

  // P1-7 (b): Windows trailing backslash in double quotes must NOT swallow closing quote
  {
    const winTrailFailCmd = 'Select-String "foo" "C:\\src\\" ; node -e "process.exit(1)"';
    const steps = [];
    let si = 1;
    for (let k = 0; k < 2; k++) {
      steps.push(
        plannerTurn(si++, k * 20, [
          { id: `we${k}`, name: "edit_file", args: { Path: "src/winbs.ts", Target: `a${k}`, Replacement: `b${k}` } },
          { id: `wc${k}`, name: "run_command", args: { CommandLine: winTrailFailCmd } }
        ]),
        toolResult(si++, `we${k}`, "Edited"),
        toolResult(si++, `wc${k}`, "Command exited with code 1.\n\nCommand output:\n", { exit_code: 1 })
      );
    }
    const diag = analyzeTranscriptCache(steps, { nowMs: T0_MS + 60000 });
    assert.equal(diag.loopWatch.status, "warn", "Windows trailing backslash must NOT hide '; node -e process.exit(1)'");
    assert.equal(diag.loopWatch.editFailOscillations, 2);

    const sigFail = extractVerificationSignal(
      "mcp_agy-dart_fast_run_checks",
      { commands: [{ name: "vitest", command: "npx vitest run" }, { name: "win", command: winTrailFailCmd }] },
      `Checks: 1/2 passed, 1 failed (wall: 500ms)\n\n- [PASS 400ms] vitest (\`npx vitest run\`): 10 passed\n\n## [FAIL (exit 1) 10ms] win\n$ ${winTrailFailCmd}\nExited with code 1`
    );
    assert.equal(sigFail.passed, false);

    // Pure cd with Windows trailing backslash + env setup + PowerShell backtick-escaped quote inside pattern IS benign 0-match
    const psBenignCmd = 'cd "e:\\work\\app\\" && $env:CI="1" && npx tsc --noEmit 2>&1 | Select-String -Pattern "foo`"|bar"';
    const okSteps = [];
    si = 1;
    for (let k = 0; k < 2; k++) {
      okSteps.push(
        plannerTurn(si++, k * 20, [
          { id: `pe${k}`, name: "edit_file", args: { Path: "src/psok.ts", Target: `a${k}`, Replacement: `b${k}` } },
          { id: `pc${k}`, name: "run_command", args: { CommandLine: psBenignCmd } }
        ]),
        toolResult(si++, `pe${k}`, "Edited"),
        toolResult(si++, `pc${k}`, "Command exited with code 1.\n\nCommand output:\n", { exit_code: 1 })
      );
    }
    const diagOk = analyzeTranscriptCache(okSteps, { nowMs: T0_MS + 60000 });
    assert.equal(diagOk.loopWatch.status, "ok", "cd with Windows trailing backslash + PS backtick quote must be recognized as benign 0-match");
    assert.equal(diagOk.loopWatch.editFailOscillations, 0);

    const sigOk = extractVerificationSignal(
      "mcp_agy-dart_fast_run_checks",
      { commands: [{ name: "vitest", command: "npx vitest run" }, { name: "ps-flt", command: psBenignCmd }] },
      `Checks: 1/2 passed, 1 failed (wall: 500ms)\n\n- [PASS 400ms] vitest (\`npx vitest run\`): 10 passed\n\n## [FAIL (exit 1) 10ms] ps-flt\n$ ${psBenignCmd}\nExited with code 1`
    );
    assert.equal(sigOk.passed, true);
    assert.equal(sigOk.exitCode, 0);
    assert.match(sigOk.summary, /1 benign 0-match filter/, "onlyBenignZeroMatch summary must annotate benign 0-match filter");
  }

  // P2-1: Pure 0-match filter run_checks (0 passed, 1 benign 0-match failed) returns null so checkpoint is not overwritten
  {
    const sigPureZero = extractVerificationSignal(
      "mcp_agy-dart_fast_run_checks",
      { commands: [{ name: "todo-grep", command: 'rg "TODO|FIXME" src/' }] },
      'Checks: 0/1 passed, 1 failed (wall: 22ms)\n\n## [FAIL (exit 1) 20ms] todo-grep\n$ rg "TODO|FIXME" src/\nExited with code 1'
    );
    assert.equal(sigPureZero, null, "Pure 0-match filter run_checks must return null instead of overwriting checkpoint");
  }

  // P2-2 (a): Parallel out-of-order turn [run_checks BEFORE edit_file] must share one consistent candidate set (no prelimCandidates drift)
  {
    const rcOut = [
      "Checks: 1/2 passed, 1 failed (wall: 900ms)",
      "",
      "- [PASS 700ms] vitest (`npx vitest run`): 59 passed",
      "",
      "## [FAIL (exit 2) 200ms] tsc",
      "$ npx tsc --noEmit",
      "src/parallel.ts(10,3): error TS2322: bad type"
    ].join("\n");
    let si = 1;
    // Seed pendingEditFiles with an unrelated file so old prelimCandidates would have been non-empty yet missing src/parallel.ts
    const steps = [
      plannerTurn(si++, 0, [{ id: "seed0", name: "edit_file", args: { Path: "src/unrelatedSeed.ts", Target: "x", Replacement: "y" } }]),
      toolResult(si++, "seed0", "Edited")
    ];
    for (let k = 0; k < 3; k++) {
      steps.push(
        plannerTurn(si++, (k + 1) * 20, [
          { id: `prc${k}`, name: "mcp_agy-dart_fast_run_checks", args: { commands: [{ name: "vitest", command: "npx vitest run" }, { name: "tsc", command: "npx tsc --noEmit" }] } },
          { id: `pe${k}`, name: "edit_file", args: { Path: "src/parallel.ts", Target: `a${k}`, Replacement: `b${k}` } }
        ]),
        toolResult(si++, `prc${k}`, rcOut),
        toolResult(si++, `pe${k}`, "Edited")
      );
    }
    const diag = analyzeTranscriptCache(steps, { nowMs: T0_MS + 90000 });
    assert.equal(diag.loopWatch.status, "critical", "Parallel run_checks before edit_file must fail consistently without #pass_e drift");
    assert.equal(diag.loopWatch.editFailOscillations, 3);
    assert.equal(diag.loopWatch.maxRepeatCount, 3, "Failed parallel run_checks must NOT receive false #pass_e fingerprint dedup");
    assert.equal(diag.loopWatch.reason, "repeat_and_oscillation");
  }

  // P2-2 (a2): Non-run_command / unknown tool returning "Tool is running as a background task" + AssertionError must NOT be swallowed as bg launch
  {
    let si = 1;
    const steps = [];
    for (let k = 0; k < 2; k++) {
      steps.push(
        plannerTurn(si++, k * 20, [
          { id: `be${k}`, name: "edit_file", args: { Path: "src/noncmd.ts", Target: `a${k}`, Replacement: `b${k}` } },
          { id: `bx${k}`, name: "custom_runner", args: { script: `run-${k}` } }
        ]),
        toolResult(si++, `be${k}`, "Edited"),
        toolResult(si++, `bx${k}`, "Tool is running as a background task with task id: fake/task-1\nAssertionError: crash")
      );
    }
    const diag = analyzeTranscriptCache(steps, { nowMs: T0_MS + 60000 });
    assert.equal(diag.loopWatch.status, "warn", "Non-run_command tool must never be treated as a run_command background launch");
    assert.equal(diag.loopWatch.editFailOscillations, 2);
  }

  // P2-2 (b): Trailing punctuation on bg task id launch banner + macOS /var/folders temp path + sessionEditedFiles
  {
    const convId = "44444444-5555-4666-8777-888888888888";
    const taskId = `${convId}/task-77`;
    let si = 1;
    const steps = [
      // macOS temp files must be ignored as ephemeral
      plannerTurn(si++, 0, [
        { id: "m1", name: "write_file", args: { Path: "/var/folders/ab/cdef1234/T/probe.mjs", Content: "x" } },
        { id: "m2", name: "write_file", args: { Path: "/private/var/folders/ab/cdef1234/T/probe2.mjs", Content: "y" } },
        { id: "mr1", name: "run_command", args: { CommandLine: "node /var/folders/ab/cdef1234/T/probe.mjs" } }
      ]),
      toolResult(si++, "m1", "Created"),
      toolResult(si++, "m2", "Created"),
      toolResult(si++, "mr1", "Command exited with code 1.", { status: "ERROR", exit_code: 1 }),
      // Trailing punctuation in task id launch banner (`task-77.`) must still match SYSTEM_MESSAGE for `task-77`
      plannerTurn(si++, 10, [{ id: "e1", name: "edit_file", args: { Path: "src/punct.ts" } }]),
      toolResult(si++, "e1", "Edited"),
      plannerTurn(si++, 15, [{ id: "t1", name: "run_command", args: { CommandLine: "npx vitest run punct-1" } }]),
      toolResult(si++, "t1", "AssertionError: 1", { status: "ERROR", exit_code: 1 }),
      plannerTurn(si++, 20, [{ id: "e2", name: "edit_file", args: { Path: "src/punct.ts" } }]),
      toolResult(si++, "e2", "Edited"),
      plannerTurn(si++, 25, [{ id: "t2", name: "run_command", args: { CommandLine: "npx vitest run punct-2" } }]),
      toolResult(si++, "t2", "AssertionError: 2", { status: "ERROR", exit_code: 1 }),
      plannerTurn(si++, 30, [{ id: "bg77", name: "run_command", args: { CommandLine: "npx vitest run", WaitMsBeforeAsync: 500 } }]),
      { type: "GENERIC", step_index: si++, tool_call_id: "bg77", status: "RUNNING", content: `Tool is running as a background task with task id: ${taskId}.` },
      {
        type: "SYSTEM_MESSAGE",
        step_index: si++,
        source: "SYSTEM",
        status: "DONE",
        content: `<SYSTEM_MESSAGE>[Message] sender=${taskId} content=Task id "${taskId}" finished with result:\nCommand exited with code 0.\n</SYSTEM_MESSAGE>`
      }
    ];
    const diag = analyzeTranscriptCache(steps, { nowMs: T0_MS + 60000 });
    assert.equal(diag.loopWatch.status, "ok", "Trailing '.' on launched task id must be stripped so completion clears oscillation");
    assert.equal(diag.loopWatch.editFailOscillations, 0);
  }

  // P2-2 (c): sessionEditedFiles prevents denoising tsc errors in files edited earlier in the same session
  {
    const rcOut = [
      "Checks: 1/2 passed, 1 failed (wall: 900ms)",
      "",
      "- [PASS 700ms] vitest (`npx vitest run`): 59 passed",
      "",
      "## [FAIL (exit 2) 200ms] tsc",
      "$ npx tsc --noEmit",
      "src/types.ts(10,3): error TS2322: Type mismatch from earlier edit"
    ].join("\n");
    let si = 1;
    const steps = [
      // Turn 1: edit src/types.ts and pass vitest (clears pendingEditFiles & fileOscState, but stays in sessionEditedFiles)
      plannerTurn(si++, 0, [{ id: "te0", name: "edit_file", args: { Path: "src/types.ts" } }]),
      toolResult(si++, "te0", "Edited"),
      plannerTurn(si++, 5, [{ id: "tv0", name: "run_command", args: { CommandLine: "npx vitest run" } }]),
      toolResult(si++, "tv0", "Command exited with code 0.\n59 passed", { exit_code: 0 }),
      // Turn 2-3: edit src/consumer.ts twice while tsc reports error in src/types.ts -> must NOT denoise!
      plannerTurn(si++, 15, [{ id: "ce1", name: "edit_file", args: { Path: "src/consumer.ts", Target: "a", Replacement: "b" } }]),
      toolResult(si++, "ce1", "Edited"),
      plannerTurn(si++, 20, [{ id: "cr1", name: "mcp_agy-dart_fast_run_checks", args: { commands: [{ name: "vitest", command: "npx vitest run" }, { name: "tsc", command: "npx tsc --noEmit" }] } }]),
      toolResult(si++, "cr1", rcOut),
      plannerTurn(si++, 30, [{ id: "ce2", name: "edit_file", args: { Path: "src/consumer.ts", Target: "b", Replacement: "c" } }]),
      toolResult(si++, "ce2", "Edited"),
      plannerTurn(si++, 35, [{ id: "cr2", name: "mcp_agy-dart_fast_run_checks", args: { commands: [{ name: "vitest", command: "npx vitest run" }, { name: "tsc", command: "npx tsc --noEmit" }] } }]),
      toolResult(si++, "cr2", rcOut)
    ];
    const diag = analyzeTranscriptCache(steps, { nowMs: T0_MS + 60000 });
    assert.equal(diag.loopWatch.status, "warn", "tsc error in a file edited earlier in the same session must NOT be denoised");
    assert.equal(diag.loopWatch.editFailOscillations, 2);
  }
});

test("v1.7.4-osc-10: Hardening for sync+bg races, filter-chain/;/||/apply_edits bypasses, shell wrappers, single-segment Win trailing backslash, mixed SYSTEM_MESSAGE, and eslint test-config args", () => {
  const convId = "55555555-6666-4777-8888-999999999999";
  const makeOsc2 = (filePath = "src/harden.ts") => {
    let si = 1;
    const steps = [];
    for (let k = 0; k < 2; k++) {
      steps.push(
        plannerTurn(si++, k * 20, [{ id: `he${k}`, name: "edit_file", args: { Path: filePath, Target: `a${k}`, Replacement: `b${k}` } }]),
        toolResult(si++, `he${k}`, "Edited"),
        plannerTurn(si++, k * 20 + 5, [{ id: `ht${k}`, name: "run_command", args: { CommandLine: `npx vitest run h-${k}` } }]),
        toolResult(si++, `ht${k}`, "AssertionError: boom", { status: "ERROR", exit_code: 1 })
      );
    }
    return { steps, nextSi: si };
  };

  // 1. Concurrent fast sync build PASS + slow bg test FAIL (both same-turn and cross-turn) must NOT swallow bg failure
  for (const sameTurn of [true, false]) {
    const tid = `${convId}/task-syncbg-${sameTurn ? "same" : "cross"}`;
    let si = 1;
    const base = [
      plannerTurn(si++, 0, [{ id: "e1", name: "edit_file", args: { Path: "src/race.ts" } }]),
      toolResult(si++, "e1", "Edited"),
      plannerTurn(si++, 5, [{ id: "t1", name: "run_command", args: { CommandLine: "npx vitest run race-1" } }]),
      toolResult(si++, "t1", "AssertionError: fail 1", { status: "ERROR", exit_code: 1 }),
      plannerTurn(si++, 10, [{ id: "e2", name: "edit_file", args: { Path: "src/race.ts" } }]),
      toolResult(si++, "e2", "Edited")
    ];
    if (sameTurn) {
      base.push(
        plannerTurn(si++, 15, [
          { id: "sb", name: "run_command", args: { CommandLine: "npx electron-vite build" } },
          { id: "bgt", name: "run_command", args: { CommandLine: "npx vitest run race-2", WaitMsBeforeAsync: 500 } }
        ]),
        toolResult(si++, "sb", "Command exited with code 0.\nbuilt", { exit_code: 0 }),
        { type: "GENERIC", step_index: si++, tool_call_id: "bgt", status: "RUNNING", content: `Tool is running as a background task with task id: ${tid}` }
      );
    } else {
      base.push(
        plannerTurn(si++, 15, [{ id: "bgt", name: "run_command", args: { CommandLine: "npx vitest run race-2", WaitMsBeforeAsync: 500 } }]),
        { type: "GENERIC", step_index: si++, tool_call_id: "bgt", status: "RUNNING", content: `Tool is running as a background task with task id: ${tid}` },
        plannerTurn(si++, 18, [{ id: "sb", name: "run_command", args: { CommandLine: "npx electron-vite build" } }]),
        toolResult(si++, "sb", "Command exited with code 0.\nbuilt", { exit_code: 0 })
      );
    }
    const failSteps = [
      ...base,
      {
        type: "SYSTEM_MESSAGE",
        step_index: si,
        source: "SYSTEM",
        status: "DONE",
        content: `<SYSTEM_MESSAGE>[Message] sender=${tid} content=Task id "${tid}" finished with result:\nCommand exited with code 1.\n\nCommand output:\nAssertionError: fail 2\n</SYSTEM_MESSAGE>`
      }
    ];
    const dFail = analyzeTranscriptCache(failSteps, { nowMs: T0_MS + 60000 });
    assert.equal(dFail.loopWatch.status, "warn", `sameTurn=${sameTurn}: fast sync pass must NOT swallow concurrent bg failure`);
    assert.equal(dFail.loopWatch.editFailOscillations, 2);

    const passSteps = [
      ...base,
      {
        type: "SYSTEM_MESSAGE",
        step_index: si,
        source: "SYSTEM",
        status: "DONE",
        content: `<SYSTEM_MESSAGE>[Message] sender=${tid} content=Task id "${tid}" finished with result:\nCommand exited with code 0.\n</SYSTEM_MESSAGE>`
      }
    ];
    const dPass = analyzeTranscriptCache(passSteps, { nowMs: T0_MS + 60000 });
    assert.equal(dPass.loopWatch.status, "ok", `sameTurn=${sameTurn}: when concurrent bg also passes, oscillation clears`);
    assert.equal(dPass.loopWatch.editFailOscillations, 0);
  }

  // 2. Sync failure when pendingEditFiles is empty still poisons an in-flight earlier bg pass;
  //    conversely, an already-poisoned stale bg sibling does NOT block a fresh retry launched after the failure
  {
    const { steps: baseOsc, nextSi } = makeOsc2("src/retry.ts");
    const bgBuildId = `${convId}/task-build-stale`;
    const poisonSteps = [
      ...baseOsc,
      plannerTurn(nextSi, 50, [{ id: "bgb", name: "run_command", args: { CommandLine: "npx electron-vite build", WaitMsBeforeAsync: 500 } }]),
      { type: "GENERIC", step_index: nextSi + 1, tool_call_id: "bgb", status: "RUNNING", content: `Tool is running as a background task with task id: ${bgBuildId}` },
      // Sync vitest fails while pendingEditFiles is empty -> must poison bgb
      plannerTurn(nextSi + 2, 55, [{ id: "st", name: "run_command", args: { CommandLine: "npx vitest run h-2" } }]),
      toolResult(nextSi + 3, "st", "AssertionError: still failing", { status: "ERROR", exit_code: 1 }),
      {
        type: "SYSTEM_MESSAGE",
        step_index: nextSi + 4,
        source: "SYSTEM",
        status: "DONE",
        content: `<SYSTEM_MESSAGE>[Message] sender=${bgBuildId} content=Task id "${bgBuildId}" finished with result:\nCommand exited with code 0.\n</SYSTEM_MESSAGE>`
      }
    ];
    const dPoison = analyzeTranscriptCache(poisonSteps, { nowMs: T0_MS + 80000 });
    assert.equal(dPoison.loopWatch.status, "warn", "Sync failure with empty pendingEditFiles must still poison earlier in-flight bg pass");
    assert.equal(dPoison.loopWatch.editFailOscillations, 2);

    // Fresh retry launched AFTER sync failure while stale bgBuildId is still running -> passes and clears immediately
    const freshRetryId = `${convId}/task-retry-fresh`;
    const retryBeforeStale = [
      ...poisonSteps.slice(0, -1),
      plannerTurn(nextSi + 4, 60, [{ id: "bgr", name: "run_command", args: { CommandLine: "npx vitest run h-3", WaitMsBeforeAsync: 500 } }]),
      { type: "GENERIC", step_index: nextSi + 5, tool_call_id: "bgr", status: "RUNNING", content: `Tool is running as a background task with task id: ${freshRetryId}` },
      {
        type: "SYSTEM_MESSAGE",
        step_index: nextSi + 6,
        source: "SYSTEM",
        status: "DONE",
        content: `<SYSTEM_MESSAGE>[Message] sender=${freshRetryId} content=Task id "${freshRetryId}" finished with result:\nCommand exited with code 0.\n</SYSTEM_MESSAGE>`
      }
    ];
    const dFresh = analyzeTranscriptCache(retryBeforeStale, { nowMs: T0_MS + 90000 });
    assert.equal(dFresh.loopWatch.status, "ok", "Already-poisoned stale bg sibling must NOT block fresh retry from clearing");
    assert.equal(dFresh.loopWatch.editFailOscillations, 0);
  }

  // 3. P0-1/P1-5 bypass prevention: filter-piped chains, trailing ; read-only, || fallback, wrapped filters, and apply_edits filter verify
  for (const cmd of [
    'npx tsc --noEmit 2>&1 | Select-String "TS2322" && echo done',
    'npx tsc --noEmit 2>&1 | Select-String "TS2322" | Select-Object -First 20',
    'powershell -Command "npx tsc --noEmit 2>&1 | Select-String TS2322"',
    'bash -c "git diff tests/app.test.ts"',
    "npm test; echo done",
    "npm test; git status",
    "npm test || echo failed",
    "npm test || true"
  ]) {
    const { steps, nextSi } = makeOsc2();
    const diag = analyzeTranscriptCache(
      [
        ...steps,
        plannerTurn(nextSi, 50, [{ id: "c0", name: "run_command", args: { CommandLine: cmd } }]),
        toolResult(nextSi + 1, "c0", "Command exited with code 0.", { exit_code: 0 })
      ],
      { nowMs: T0_MS + 70000 }
    );
    assert.equal(diag.loopWatch.status, "warn", `Non-converging/masked exit-0 command must NOT clear oscillation: ${cmd}`);
    assert.equal(diag.loopWatch.editFailOscillations, 2);
  }

  // apply_edits with filter-terminal verify exiting 0 (matched errors) must NOT clear oscillation or record a PASS checkpoint
  {
    const { steps, nextSi } = makeOsc2();
    const dAe = analyzeTranscriptCache(
      [
        ...steps,
        plannerTurn(nextSi, 50, [
          { id: "ae1", name: "apply_edits", args: { edits: [{ path: "src/harden.ts", hunks: [] }], verify: 'npx tsc --noEmit 2>&1 | Select-String "TS2322"' } }
        ]),
        toolResult(nextSi + 1, "ae1", "Applied edits to 1 file(s).\nVerify [PASS in 50ms]:\nsrc/harden.ts(10,3): error TS2322")
      ],
      { nowMs: T0_MS + 70000 }
    );
    assert.equal(dAe.loopWatch.status, "warn");
    assert.equal(dAe.loopWatch.editFailOscillations, 2);

    assert.equal(
      extractVerificationSignal(
        "apply_edits",
        { edits: [], verify: 'npx tsc --noEmit 2>&1 | Select-String "TS2322"' },
        "Applied edits to 1 file(s).\nVerify [PASS in 50ms]:\nsrc/harden.ts(10,3): error TS2322"
      ),
      null
    );
    assert.equal(
      extractVerificationSignal(
        "mcp_agy-dart_fast_run_checks",
        { commands: [{ name: "tsc-filter", command: 'npx tsc --noEmit 2>&1 | Select-String "TS2322" && echo done' }] },
        'Checks: 1/1 passed (wall: 95ms)\n\n- [PASS 90ms] tsc-filter (`npx tsc --noEmit 2>&1 | Select-String "TS2322" && echo done`): src/app.ts(10,3): error TS2322'
      ),
      null
    );
  }

  // 4. Legitimate shell wrappers, npm -w <pkg>, /usr/bin/env, and non-filter display pipe `npm test | tail -n 30` DO converge
  for (const cmd of [
    'powershell -Command "npx vitest run"',
    'bash -c "npm test"',
    'cmd /c "npm run build"',
    "npm -w packages/app test",
    "/usr/bin/env npm test",
    "npm test | tail -n 30"
  ]) {
    const { steps, nextSi } = makeOsc2();
    const diag = analyzeTranscriptCache(
      [
        ...steps,
        plannerTurn(nextSi, 50, [{ id: "ok0", name: "run_command", args: { CommandLine: cmd } }]),
        toolResult(nextSi + 1, "ok0", "Command exited with code 0.", { exit_code: 0 })
      ],
      { nowMs: T0_MS + 70000 }
    );
    assert.equal(diag.loopWatch.status, "ok", `Legitimate verify command must clear oscillation: ${cmd}`);
    assert.equal(diag.loopWatch.editFailOscillations, 0);
  }

  // 5. Single-segment Windows trailing backslash parity (`"src\"` fail & `cd "app\"` benign) + POSIX escaped quote preserved
  {
    const failCmd = 'Select-String "foo" "src\\" ; node -e "process.exit(1)"';
    const failSteps = [];
    let si = 1;
    for (let k = 0; k < 2; k++) {
      failSteps.push(
        plannerTurn(si++, k * 20, [
          { id: `sf_e${k}`, name: "edit_file", args: { Path: "src/singlewin.ts" } },
          { id: `sf_c${k}`, name: "run_command", args: { CommandLine: failCmd } }
        ]),
        toolResult(si++, `sf_e${k}`, "Edited"),
        toolResult(si++, `sf_c${k}`, "Command exited with code 1.\n\nCommand output:\n", { exit_code: 1 })
      );
    }
    const dFail = analyzeTranscriptCache(failSteps, { nowMs: T0_MS + 60000 });
    assert.equal(dFail.loopWatch.status, "warn");
    assert.equal(dFail.loopWatch.editFailOscillations, 2);

    const sigFail = extractVerificationSignal(
      "mcp_agy-dart_fast_run_checks",
      { commands: [{ name: "t", command: "npm test" }, { name: "f", command: failCmd }] },
      `Checks: 1/2 passed, 1 failed\n\n- [PASS 10ms] t (\`npm test\`): 5 passed\n\n## [FAIL (exit 1) 10ms] f\n$ ${failCmd}\nExited with code 1`
    );
    assert.equal(sigFail.passed, false);

    for (const okCmd of [
      'cd "app\\" && npx tsc --noEmit 2>&1 | Select-String "foo"',
      'npx tsc --noEmit 2>&1 | grep "foo\\" | bar"'
    ]) {
      const okSteps = [];
      let s2 = 1;
      for (let k = 0; k < 2; k++) {
        okSteps.push(
          plannerTurn(s2++, k * 20, [
            { id: `ok_e${k}`, name: "edit_file", args: { Path: "src/okwin.ts" } },
            { id: `ok_c${k}`, name: "run_command", args: { CommandLine: okCmd } }
          ]),
          toolResult(s2++, `ok_e${k}`, "Edited"),
          toolResult(s2++, `ok_c${k}`, "Command exited with code 1.\n\nCommand output:\n", { exit_code: 1 })
        );
      }
      const dOk = analyzeTranscriptCache(okSteps, { nowMs: T0_MS + 60000 });
      assert.equal(dOk.loopWatch.status, "ok", `Must recognize benign 0-match: ${okCmd}`);
      assert.equal(dOk.loopWatch.editFailOscillations, 0);
    }
  }

  // 6. Mixed SYSTEM_MESSAGE ([Message] + bare Task id), bare [Message] inside Command output, and manage_task(status) 0-match w/o Log output header
  {
    const { steps, nextSi } = makeOsc2();
    const t1 = `${convId}/task-mix-1`;
    const t2 = `${convId}/task-mix-2`;
    const dMix = analyzeTranscriptCache(
      [
        ...steps,
        plannerTurn(nextSi, 50, [
          { id: "mx1", name: "run_command", args: { CommandLine: "npx electron-vite build", WaitMsBeforeAsync: 500 } },
          { id: "mx2", name: "run_command", args: { CommandLine: "npx vitest run", WaitMsBeforeAsync: 500 } }
        ]),
        { type: "GENERIC", step_index: nextSi + 1, tool_call_id: "mx1", status: "RUNNING", content: `Tool is running as a background task with task id: ${t1}` },
        { type: "GENERIC", step_index: nextSi + 2, tool_call_id: "mx2", status: "RUNNING", content: `Tool is running as a background task with task id: ${t2}` },
        {
          type: "SYSTEM_MESSAGE",
          step_index: nextSi + 3,
          source: "SYSTEM",
          status: "DONE",
          content: `<SYSTEM_MESSAGE>\n[Message] sender=${t1} content=Task id "${t1}" finished with result:\nCommand exited with code 0.\n</SYSTEM_MESSAGE>\n<SYSTEM_MESSAGE>\nTask id "${t2}" finished with result:\nCommand exited with code 0.\n</SYSTEM_MESSAGE>`
        }
      ],
      { nowMs: T0_MS + 80000 }
    );
    assert.equal(dMix.loopWatch.status, "ok");
    assert.equal(dMix.loopWatch.editFailOscillations, 0);

    // Log line starting with "[Message]" inside Command output must NOT truncate error body into false 0-match
    const tErr = `${convId}/task-msg-err`;
    const dMsgErr = analyzeTranscriptCache(
      [
        plannerTurn(1, 0, [{ id: "me1", name: "edit_file", args: { Path: "src/msgerr.ts" } }]),
        toolResult(2, "me1", "Edited"),
        plannerTurn(3, 5, [{ id: "mbg", name: "run_command", args: { CommandLine: 'npx tsc --noEmit 2>&1 | Select-String "msg"', WaitMsBeforeAsync: 500 } }]),
        { type: "GENERIC", step_index: 4, tool_call_id: "mbg", status: "RUNNING", content: `Tool is running as a background task with task id: ${tErr}` },
        {
          type: "SYSTEM_MESSAGE",
          step_index: 5,
          source: "SYSTEM",
          status: "DONE",
          content: `<SYSTEM_MESSAGE>\n[Message] sender=${tErr} content=Task id "${tErr}" finished with result:\nCommand exited with code 1.\n\nCommand output:\n[Message] Select-String : Invalid regex\n</SYSTEM_MESSAGE>`
        }
      ],
      { nowMs: T0_MS + 40000 }
    );
    assert.equal(dMsgErr.loopWatch.editFailOscillations, 1);

    // manage_task(status) 0-match filter exit without Log output header is benign
    const tNoLog = `${convId}/task-nolog`;
    const dNoLog = analyzeTranscriptCache(
      [
        plannerTurn(1, 0, [{ id: "nl1", name: "edit_file", args: { Path: "src/nolog.ts" } }]),
        toolResult(2, "nl1", "Edited"),
        plannerTurn(3, 5, [{ id: "nlbg", name: "run_command", args: { CommandLine: 'npx tsc --noEmit 2>&1 | Select-String "nolog"', WaitMsBeforeAsync: 500 } }]),
        { type: "GENERIC", step_index: 4, tool_call_id: "nlbg", status: "RUNNING", content: `Tool is running as a background task with task id: ${tNoLog}` },
        plannerTurn(5, 10, [{ id: "nlms", name: "manage_task", args: { Action: "status", TaskId: tNoLog } }]),
        { type: "GENERIC", step_index: 6, tool_call_id: "nlms", status: "DONE", content: `Task: ${tNoLog}\nStatus: DONE\nCommand exited with code 1.` }
      ],
      { nowMs: T0_MS + 40000 }
    );
    assert.equal(dNoLog.loopWatch.editFailOscillations, 0);
    assert.equal(dNoLog.loopWatch.status, "ok");
  }

  // 7. Static lint check whose file argument contains "vitest" (`npx eslint tests/vitest.config.ts`) still denoises untouched files
  {
    const rcOut = [
      "Checks: 1/2 passed, 1 failed (wall: 500ms)",
      "",
      "- [PASS 400ms] vitest (`npx vitest run`): 50 passed",
      "",
      "## [FAIL (exit 1) 100ms] eslint",
      "$ npx eslint tests/vitest.config.ts",
      "src/legacy/old.ts",
      "  12:5  error  Unexpected any  @typescript-eslint/no-explicit-any",
      "",
      "✖ 1 problem (1 error, 0 warnings)"
    ].join("\n");
    const steps = [];
    let si = 1;
    for (let k = 0; k < 2; k++) {
      steps.push(
        plannerTurn(si++, k * 20, [{ id: `ve${k}`, name: "edit_file", args: { Path: "src/app.ts" } }]),
        toolResult(si++, `ve${k}`, "Edited"),
        plannerTurn(si++, k * 20 + 5, [{ id: `vr${k}`, name: "mcp_agy-dart_fast_run_checks", args: { commands: [{ name: "vitest", command: "npx vitest run" }, { name: "eslint", command: "npx eslint tests/vitest.config.ts" }] } }]),
        toolResult(si++, `vr${k}`, rcOut)
      );
    }
    const dEslint = analyzeTranscriptCache(steps, { nowMs: T0_MS + 60000 });
    assert.equal(dEslint.loopWatch.status, "ok");
    assert.equal(dEslint.loopWatch.editFailOscillations, 0);
  }
});

test("v1.7.4-osc-11: Audit follow-ups — host empty-output & Log: meta, spaced/unattributed diagnostics, PostToolUse read-only parity, production workspaceCwd wiring, and bg failed-with-error timeout", () => {
  const convId = "66666666-7777-4888-8999-aaaaaaaaaaaa";

  // 1. P1-1: Real Antigravity host "No output from the command.", pre-tool hook notice, and background "Log: file:///..." metadata
  {
    const syncNoOutputSteps = [];
    let si = 1;
    for (let k = 0; k < 2; k++) {
      syncNoOutputSteps.push(
        plannerTurn(si++, k * 20, [
          { id: `no_e${k}`, name: "edit_file", args: { Path: "src/hooks/useFpcSettings.ts", Target: `a${k}`, Replacement: `b${k}` } },
          { id: `no_c${k}`, name: "run_command", args: { CommandLine: 'npx tsc --noEmit 2>&1 | Select-String -Pattern "useFpcSettings|FpcPanel"' } }
        ]),
        toolResult(si++, `no_e${k}`, "Edited"),
        toolResult(
          si++,
          `no_c${k}`,
          [
            "Created At: 2026-11-25T16:26:11-05:00",
            "Completed At: 2026-11-25T16:26:18-05:00",
            ...(k === 1 ? ["A pre-tool hook changed the arguments of this tool call before it ran. Changed: CommandLine.", ""] : []),
            "Command exited with code 1.",
            "",
            "No output from the command."
          ].join("\n"),
          { exit_code: 1 }
        )
      );
    }
    const dSyncNoOut = analyzeTranscriptCache(syncNoOutputSteps, { nowMs: T0_MS + 60000 });
    assert.equal(dSyncNoOut.loopWatch.status, "ok", "Host 'No output from the command.' on 0-match filter must not oscillate");
    assert.equal(dSyncNoOut.loopWatch.editFailOscillations, 0);

    // Background 0-match with host Log: link (both with "No output from the command." and empty "Command output:")
    const bgLogSteps = [];
    si = 1;
    for (let k = 0; k < 2; k++) {
      const tid = `${convId}/task-log-${k}`;
      const completionBody =
        k === 0
          ? `Command exited with code 1.\n\nNo output from the command.\n\nLog: file:///C:/Users/Administrator/.gemini/antigravity/brain/${convId}/.system_generated/tasks/task-log-${k}.log`
          : `Command exited with code 1.\n\nCommand output:\n\nLog: file:///C:/Users/Administrator/.gemini/antigravity/brain/${convId}/.system_generated/tasks/task-log-${k}.log`;
      bgLogSteps.push(
        plannerTurn(si++, k * 20, [
          { id: `bl_e${k}`, name: "edit_file", args: { Path: "src/hooks/useFpcSettings.ts", Target: `x${k}`, Replacement: `y${k}` } },
          { id: `bl_c${k}`, name: "run_command", args: { CommandLine: 'npx tsc --noEmit 2>&1 | Select-String "useFpcSettings"', WaitMsBeforeAsync: 500 } }
        ]),
        toolResult(si++, `bl_e${k}`, "Edited"),
        { type: "GENERIC", step_index: si++, tool_call_id: `bl_c${k}`, status: "RUNNING", content: `Tool is running as a background task with task id: ${tid}` },
        {
          type: "SYSTEM_MESSAGE",
          step_index: si++,
          source: "SYSTEM",
          status: "DONE",
          content: `<SYSTEM_MESSAGE>\n[Message] sender=${tid} content=Task id "${tid}" finished with result:\n${completionBody}\n</SYSTEM_MESSAGE>`
        }
      );
    }
    const dBgLog = analyzeTranscriptCache(bgLogSteps, { nowMs: T0_MS + 60000 });
    assert.equal(dBgLog.loopWatch.status, "ok", "Background 0-match filter with host Log: link must not oscillate");
    assert.equal(dBgLog.loopWatch.editFailOscillations, 0);

    // Anti-false-negative: real filter error WITH Log: link MUST still trigger oscillation
    const bgErrWithLogSteps = [];
    si = 1;
    for (let k = 0; k < 2; k++) {
      const tid = `${convId}/task-errlog-${k}`;
      bgErrWithLogSteps.push(
        plannerTurn(si++, k * 20, [
          { id: `bel_e${k}`, name: "edit_file", args: { Path: "src/hooks/useFpcSettings.ts", Target: `m${k}`, Replacement: `n${k}` } },
          { id: `bel_c${k}`, name: "run_command", args: { CommandLine: 'npx tsc --noEmit 2>&1 | Select-String "["', WaitMsBeforeAsync: 500 } }
        ]),
        toolResult(si++, `bel_e${k}`, "Edited"),
        { type: "GENERIC", step_index: si++, tool_call_id: `bel_c${k}`, status: "RUNNING", content: `Tool is running as a background task with task id: ${tid}` },
        {
          type: "SYSTEM_MESSAGE",
          step_index: si++,
          source: "SYSTEM",
          status: "DONE",
          content: `<SYSTEM_MESSAGE>\n[Message] sender=${tid} content=Task id "${tid}" finished with result:\nCommand exited with code 1.\n\nCommand output:\nSelect-String : Invalid regex\n\nLog: file:///C:/Users/Administrator/.gemini/antigravity/brain/${convId}/.system_generated/tasks/task-errlog-${k}.log\n</SYSTEM_MESSAGE>`
        }
      );
    }
    const dBgErrLog = analyzeTranscriptCache(bgErrWithLogSteps, { nowMs: T0_MS + 60000 });
    assert.equal(dBgErrLog.loopWatch.status, "warn", "Real filter error accompanied by Log: link must still oscillate");
    assert.equal(dBgErrLog.loopWatch.editFailOscillations, 2);

    // PostToolUse run_checks alignment for "No output from the command."
    const sigHostNoOut = extractVerificationSignal(
      "mcp_agy-dart_fast_run_checks",
      { commands: [{ name: "vitest", command: "npx vitest run" }, { name: "tsc-flt", command: 'npx tsc --noEmit 2>&1 | Select-String "foo"' }] },
      'Checks: 1/2 passed, 1 failed (wall: 500ms)\n\n- [PASS 400ms] vitest (`npx vitest run`): 12 passed\n\n## [FAIL (exit 1) 100ms] tsc-flt\n$ npx tsc --noEmit 2>&1 | Select-String "foo"\nCommand exited with code 1.\nNo output from the command.'
    );
    assert.equal(sigHostNoOut.passed, true);
    assert.equal(sigHostNoOut.exitCode, 0);
  }

  // 2. P1-2: Spaced/parenthesized file paths & unattributed global errors must NEVER be falsely denoised
  {
    const runMixedCheck = (editedPath, tscLines) => {
      const rcOut = [
        "Checks: 1/2 passed, 1 failed (wall: 900ms)",
        "",
        "- [PASS 700ms] vitest (`npx vitest run`): 59 passed",
        "",
        "## [FAIL (exit 2) 200ms] tsc",
        "$ npx tsc --noEmit",
        ...tscLines
      ].join("\n");
      const steps = [];
      let si = 1;
      for (let k = 0; k < 2; k++) {
        steps.push(
          plannerTurn(si++, k * 25, [{ id: `sp_e${k}`, name: "edit_file", args: { Path: editedPath, Target: `a${k}`, Replacement: `b${k}` } }]),
          toolResult(si++, `sp_e${k}`, "Edited"),
          plannerTurn(si++, k * 25 + 8, [
            { id: `sp_rc${k}`, name: "mcp_agy-dart_fast_run_checks", args: { commands: [{ name: "vitest", command: "npx vitest run" }, { name: "tsc", command: "npx tsc --noEmit" }] } }
          ]),
          toolResult(si++, `sp_rc${k}`, rcOut)
        );
      }
      return analyzeTranscriptCache(steps, { nowMs: T0_MS + 80000 });
    };

    // Edited spaced file "src/My View.tsx" + untouched "src/legacy.ts" -> MUST oscillate!
    const dSpaced = runMixedCheck("src/My View.tsx", [
      "src/legacy.ts(10,1): error TS2835: Relative import paths need explicit file extensions.",
      "src/My View.tsx(12,5): error TS2322: Type 'string' is not assignable to type 'number'."
    ]);
    assert.equal(dSpaced.loopWatch.status, "warn", "Real tsc error in spaced path 'src/My View.tsx' must NOT be denoised");
    assert.equal(dSpaced.loopWatch.editFailOscillations, 2);
    assert.deepEqual(dSpaced.loopWatch.oscillatingFiles, ["src/my view.tsx"]);

    // Parenthesized route group + space: "src/app/(auth)/My View.tsx" with colon format
    const dParenSpace = runMixedCheck("src/app/(auth)/My View.tsx", [
      "src/legacy.ts:10:1 - error TS2835: Legacy issue.",
      "src/app/(auth)/My View.tsx:12:5 - error TS2322: Bad prop."
    ]);
    assert.equal(dParenSpace.loopWatch.status, "warn", "Parenthesized spaced path must NOT be denoised");
    assert.equal(dParenSpace.loopWatch.editFailOscillations, 2);

    // ESLint stylish Windows spaced path header -> MUST oscillate!
    const dWinEslint = runMixedCheck("E:\\My Work\\app\\src\\My View.tsx", [
      "E:\\My Work\\app\\src\\legacy.ts",
      "  4:1  error  Old issue  no-unused-vars",
      "E:\\My Work\\app\\src\\My View.tsx",
      "  12:5  error  New issue  @typescript-eslint/no-explicit-any",
      "",
      "✖ 2 problems (2 errors, 0 warnings)"
    ]);
    assert.equal(dWinEslint.loopWatch.status, "warn", "Windows spaced ESLint header on edited file must NOT be denoised");
    assert.equal(dWinEslint.loopWatch.editFailOscillations, 2);

    // Fail-closed: untouched legacy file + unattributed global error TS6053 -> MUST oscillate!
    const dUnattr = runMixedCheck("src/app.ts", [
      "src/legacy.ts(10,1): error TS2835: Legacy issue.",
      "error TS6053: File 'tsconfig.base.json' not found."
    ]);
    assert.equal(dUnattr.loopWatch.status, "warn", "Mixed legacy + global unattributed TS error must fail-closed (not denoise)");
    assert.equal(dUnattr.loopWatch.editFailOscillations, 2);

    // Positive: untouched spaced legacy file ONLY while edited file is clean -> still denoises cleanly
    const dUntouchedSpaced = runMixedCheck("src/My View.tsx", [
      "src/Legacy Old.ts(10,1): error TS2835: Pre-existing legacy issue."
    ]);
    assert.equal(dUntouchedSpaced.loopWatch.status, "ok", "Untouched spaced legacy file should still denoise when sibling vitest passes");
    assert.equal(dUntouchedSpaced.loopWatch.editFailOscillations, 0);
  }

  // 3. P2-3: Dashboard & PostToolUse parity for filter + read-only git status --short
  {
    const filterPlusGitOut = [
      "Checks: 2/2 passed (wall: 310ms)",
      "",
      '- [PASS 280ms] tsc-filter (`npx tsc --noEmit 2>&1 | Select-String "TS2322"`): src/app.ts(10,3): error TS2322',
      "- [PASS 30ms] git-status (`git status --short`): M src/app.ts"
    ].join("\n");
    const steps = [];
    let si = 1;
    for (let k = 0; k < 2; k++) {
      steps.push(
        plannerTurn(si++, k * 20, [{ id: `pg_e${k}`, name: "edit_file", args: { Path: "src/app.ts", Target: `a${k}`, Replacement: `b${k}` } }]),
        toolResult(si++, `pg_e${k}`, "Edited"),
        plannerTurn(si++, k * 20 + 5, [{ id: `pg_t${k}`, name: "run_command", args: { CommandLine: `npx vitest run pg-${k}` } }]),
        toolResult(si++, `pg_t${k}`, "AssertionError: fail", { status: "ERROR", exit_code: 1 })
      );
    }
    steps.push(
      plannerTurn(si++, 50, [
        {
          id: "pg_rc",
          name: "mcp_agy-dart_fast_run_checks",
          args: {
            commands: [
              { name: "tsc-filter", command: 'npx tsc --noEmit 2>&1 | Select-String "TS2322"' },
              { name: "git-status", command: "git status --short" }
            ]
          }
        }
      ]),
      toolResult(si++, "pg_rc", filterPlusGitOut)
    );
    const dFilterGit = analyzeTranscriptCache(steps, { nowMs: T0_MS + 70000 });
    assert.equal(dFilterGit.loopWatch.status, "warn");
    assert.equal(dFilterGit.loopWatch.editFailOscillations, 2);

    const sigFilterGit = extractVerificationSignal(
      "mcp_agy-dart_fast_run_checks",
      {
        commands: [
          { name: "tsc-filter", command: 'npx tsc --noEmit 2>&1 | Select-String "TS2322"' },
          { name: "git-status", command: "git status --short" }
        ]
      },
      filterPlusGitOut
    );
    assert.equal(sigFilterGit, null, "PostToolUse must NOT record PASS checkpoint for filter + read-only git status");

    for (const nonConvVerify of [
      'npx tsc --noEmit 2>&1 | Select-String "TS2322" && git status --short',
      'npx tsc --noEmit 2>&1 | Select-String "TS2322"; git status --short',
      "git status --short"
    ]) {
      assert.equal(
        extractVerificationSignal(
          "apply_edits",
          { edits: [], verify: nonConvVerify },
          "Applied edits to 1 file(s).\nVerify [PASS in 20ms]:\nM src/app.ts"
        ),
        null,
        `apply_edits non-converging verify must return null: ${nonConvVerify}`
      );
    }

    // Converging sibling vitest + git status DOES record PASS
    const sigVitestGit = extractVerificationSignal(
      "mcp_agy-dart_fast_run_checks",
      {
        commands: [
          { name: "vitest", command: "npx vitest run" },
          { name: "git-status", command: "git status --short" }
        ]
      },
      "Checks: 2/2 passed (wall: 500ms)\n\n- [PASS 470ms] vitest (`npx vitest run`): 20 passed\n- [PASS 30ms] git-status (`git status --short`): M src/app.ts"
    );
    assert.equal(sigVitestGit.passed, true);
    assert.equal(sigVitestGit.exitCode, 0);
  }

  // 4. P2-4: Production entrypoints (hooks/pre-invocation.mjs & sidecars/dashboard/server.mjs) wire workspaceCwd for temp-dir repos
  {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "agy-osc-prod-entry-"));
    try {
      const tmpRepo = path.join(tmpBase, "real-repo");
      fs.mkdirSync(path.join(tmpRepo, "src"), { recursive: true });
      const repoFile = path.join(tmpRepo, "src", "app.ts");
      fs.writeFileSync(repoFile, "export const x = 1;\n", "utf8");

      const prodConvId = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
      const scratchFile = `C:/Users/Administrator/.gemini/antigravity/brain/${prodConvId}/scratch/probe.mjs`;
      const txPath = path.join(tmpBase, "transcript.jsonl");
      const dbPath = path.join(tmpBase, "context.db");

      const prodSteps = [];
      let si = 1;
      for (let k = 0; k < 2; k++) {
        prodSteps.push(
          plannerTurn(si++, k * 20, [
            { id: `pe${k}`, name: "edit_file", args: { Path: repoFile, Target: `a${k}`, Replacement: `b${k}` } },
            { id: `ps${k}`, name: "write_file", args: { Path: scratchFile, Content: `// s${k}` } }
          ]),
          toolResult(si++, `pe${k}`, "Edited"),
          toolResult(si++, `ps${k}`, "Created"),
          plannerTurn(si++, k * 20 + 5, [{ id: `pt${k}`, name: "run_command", args: { CommandLine: `npx vitest run p-${k}` } }]),
          toolResult(si++, `pt${k}`, "AssertionError: boom", { status: "ERROR", exit_code: 1 })
        );
      }
      fs.writeFileSync(txPath, `${prodSteps.map((s) => JSON.stringify(s)).join("\n")}\n`, "utf8");

      const hookEnv = {
        ...process.env,
        AGY_DART_DB_PATH: dbPath,
        AGY_DART_CACHE_WATCH: "1",
        AGY_DART_CACHE_WATCH_INLINE_ALERTS: "1",
        AGY_DART_STALL_WATCHDOG: "1",
        AGY_DART_LANG: "en",
        AGY_DART_SUMMARY_DB_PATH: path.join(tmpBase, "missing-summaries.db")
      };
      const hookPayload = JSON.stringify({
        conversationId: prodConvId,
        transcriptPath: txPath,
        cwd: tmpRepo,
        invocationNum: 1
      });
      const hookRawOut = execFileSync(process.execPath, [path.join(REPO_ROOT, "hooks", "pre-invocation.mjs")], {
        input: hookPayload,
        env: hookEnv,
        encoding: "utf8",
        timeout: 15000,
        windowsHide: true
      });
      const hookJson = JSON.parse(hookRawOut.trim());
      const hookText = JSON.stringify(hookJson);
      assert.match(hookText, /2x edit↔fail oscillation/i, `pre-invocation hook must detect temp-repo oscillation: ${hookText}`);
      assert.match(hookText, /src\/app\.ts/i, `pre-invocation alert must blame src/app.ts: ${hookText}`);
      assert.doesNotMatch(hookText, /probe\.mjs/i, "Scratch file must remain excluded from temp-repo oscillation");

      // Dashboard production entrypoint (/api/cache-diag WITHOUT passing cwd in request body; resolves cwd from lease/store)
      const dashProbeScript = [
        `import { registerSidecarRoutes, closeRuntimeStore } from ${JSON.stringify(new URL("../sidecars/dashboard/server.mjs", import.meta.url).href)};`,
        "const routes = new Map();",
        "registerSidecarRoutes({ config: {}, api: (route, fn) => routes.set(route, fn) });",
        `const res = routes.get("/api/cache-diag")({ scope: "conversation", conversationId: ${JSON.stringify(prodConvId)} });`,
        "closeRuntimeStore();",
        "process.stdout.write(JSON.stringify(res));"
      ].join("\n");
      const dashRawOut = execFileSync(process.execPath, ["--input-type=module", "-e", dashProbeScript], {
        env: hookEnv,
        encoding: "utf8",
        timeout: 15000,
        windowsHide: true
      });
      const dashJson = JSON.parse(dashRawOut.trim());
      assert.equal(dashJson.transcriptFound, true, "Dashboard must locate transcript from watchdog lease");
      assert.equal(dashJson.loopWatch.status, "warn", `Dashboard must detect temp-repo oscillation: ${JSON.stringify(dashJson.loopWatch)}`);
      assert.equal(dashJson.loopWatch.editFailOscillations, 2);
      assert.deepEqual(dashJson.loopWatch.oscillatingFiles, ["src/app.ts"]);
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  }

  // 5. P2-5: Background "failed with error" pure timeout matches "finished with result" (does not count as code failure), while real errors still count
  {
    const runBgNotifications = (verb, body) => {
      const steps = [];
      let si = 1;
      for (let k = 0; k < 2; k++) {
        const tid = `${convId}/task-to-${verb.replace(/\s+/g, "-")}-${k}`;
        steps.push(
          plannerTurn(si++, k * 30, [
            { id: `te${k}`, name: "edit_file", args: { Path: "src/slow.ts", Target: `a${k}`, Replacement: `b${k}` } },
            { id: `tc${k}`, name: "run_command", args: { CommandLine: "npx vitest run slow", WaitMsBeforeAsync: 500 } }
          ]),
          toolResult(si++, `te${k}`, "Edited"),
          { type: "GENERIC", step_index: si++, tool_call_id: `tc${k}`, status: "RUNNING", content: `Tool is running as a background task with task id: ${tid}` },
          {
            type: "SYSTEM_MESSAGE",
            step_index: si++,
            source: "SYSTEM",
            status: "DONE",
            content: `<SYSTEM_MESSAGE>\n[Message] sender=${tid} content=Task id "${tid}" ${verb}:\n${body}\n</SYSTEM_MESSAGE>`
          }
        );
      }
      return analyzeTranscriptCache(steps, { nowMs: T0_MS + 90000 });
    };

    const timeoutNotice = `Command timed out after 60s.\n\nLog: file:///C:/Users/Administrator/.gemini/antigravity/brain/${convId}/.system_generated/tasks/task-to.log`;
    const dFinishTimeout = runBgNotifications("finished with result", timeoutNotice);
    const dFailTimeout = runBgNotifications("failed with error", timeoutNotice);
    assert.equal(dFinishTimeout.loopWatch.status, "ok");
    assert.equal(dFinishTimeout.loopWatch.editFailOscillations, 0);
    assert.equal(dFailTimeout.loopWatch.status, "ok", "failed with error pure 60s timeout must NOT count as code failure");
    assert.equal(dFailTimeout.loopWatch.editFailOscillations, 0);

    // Anti-false-negative: failed with error containing AssertionError OR explicit exit code 1 MUST still oscillate
    const dFailTimeoutWithErr = runBgNotifications(
      "failed with error",
      "Command timed out after 60s.\n\nCommand output:\nAssertionError: expected 1 to equal 2"
    );
    assert.equal(dFailTimeoutWithErr.loopWatch.status, "warn");
    assert.equal(dFailTimeoutWithErr.loopWatch.editFailOscillations, 2);

    const dFailRealExit = runBgNotifications(
      "failed with error",
      "Command exited with code 1.\n\nCommand output:\nTypeError: cannot read properties of undefined"
    );
    assert.equal(dFailRealExit.loopWatch.status, "warn");
    assert.equal(dFailRealExit.loopWatch.editFailOscillations, 2);
  }
});
