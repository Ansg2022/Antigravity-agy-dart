# agy-dart Error & Troubleshooting Playbook

Read this file on demand when hitting a guard block, edit rollback, rejected project filter rule, KV-cache hit drop, toolbox schema error, or platform/timeout error.

## Quick Triage Matrix

| Symptom / Error | Likely Cause | First Recovery Action |
| --- | --- | --- |
| `read_file` / `view_file` blocked by Read Guard | Un-ranged read exceeded tier cap (`45 KiB` / `800 lines` source, `128 KiB` patch, `16 KB` noisy/minified) or matched `readDedup` | Use the returned inline outline line numbers with `read_file(StartLine, EndLine)` or `agy-dart_fast` `read_slices`; for logs/data use `ctx_index` or `ctx_execute` |
| `ctx_doctor` / `doctor` shows rejected `.agy-dart/filters.json` rules | Invalid schema/ID, file `> 64 KB` / `> 20` rules, or regex rejected by `isSafeRegex` (ReDoS guard) | Inspect exact rejection reason via `ctx_doctor`; simplify regex to linear-time pattern using `examples/filters.json` |
| `apply_edits` aborted (`0 files modified`) or rolled back | Stale/mismatched `target`, ambiguous multi-line match, or write error | Re-read exact target slice (`read_slices`), pass `startLine`/`endLine` or wider anchor lines, preview with `dryRun: true` |
| KV-cache hit rate drops or Turn-0 prefix grows | Bloated rules/skill frontmatter, non-deterministic MCP `tools/list`, conflicting legacy plugin, or dynamic `systemMessage` hook | Run `npm run cache:audit -- --workspace . --no-live` and `node bin/agy-dart.mjs audit skills --workspace .` |
| Slow search, Windows encoding garble, or `run_checks` timeout | Missing `rg`, complex shell quoting, or `> 60s` job run inside `run_checks` | Install `rg` (`--install-rg`), use `ctx_execute` script file for heavy parsing, route `> 60s`/daemon jobs to native `run_command` (`WaitMsBeforeAsync <= 2000`) |
| `building toolbox: tool "mcp_ide-tools_mcp_agy-dart_fast_apply_edits" ... at '/required': items at 1 and 2 are equal` | Antigravity `ide-tools` bridge re-wraps eager `mcp_agy-dart_fast_*` tools and appends `toolSummary` to `/required` twice without deduplicating | Run `node ~/.gemini/config/plugins/agy-dart/scripts/install.mjs tool-loading lazy` (or remove `eager: true` under `mcpServers.fast`) and restart Antigravity |
| Quota drops unexpectedly, tool calls stall 3–6s, or Safety Monitor alerts `heavy_burst_or_sticky` / `429_avalanche` | Antigravity background safety pipeline (`sir_flash_lite` -> `gemini-4-hydrogen-sonar`, Issue #1886) sending up to 300K-char trajectories silently | Do NOT restart Antigravity first (restarts truncate `language_server.log`); run `npm run safety:audit` / `agy-dart audit safety`, open **Handoff Brief** to switch to a fresh window, and use native `read_file` for outside-workspace paths |
| `Workspace root could not be determined (server cwd is inside plugin directory ...)` | MCP server launched inside `${PLUGIN_ROOT}` without host `roots/list`, or multiple workspaces are simultaneously active (`N active workspaces detected`) | Pass the active workspace absolute path in `cwd`; for single-workspace setups you can also set `AGY_DART_WORKSPACE` or `"defaultCwd"` in `~/.agy-dart/config.json` |

---

## 1. Read Guard Blocks & Duplicate-Read Protection

### How tiered read limits work
- **Source code**: up to `45 KiB` / `800` lines direct read by default (`host-45k`).
- **Patches / diffs (`.patch`, `.diff`)**: up to `128 KiB` direct read (`reviewMaxReadBytes`); paginated continuation via `ByteOffset` passes through in soft mode.
- **Noisy / minified files** (logs, large JSON, lockfiles, minified bundles): capped at `16 KB` (`noiseMaxReadBytes`).

### Recovery steps
1. **Use the inline outline first**: On the first blocked un-ranged read (for files `<= 512 KiB`, `inlineOutlineMaxBytes`), `agy-dart` returns a compact outline with line numbers. Follow up immediately with ranged `read_file({ Path, StartLine, EndLine })` or `agy-dart_fast` `read_slices({ slices: [{ path, ranges: [[start, end]] }] })`.
2. **Batch outlines for unfamiliar files**: Call `read_slices({ outlines: ["path/a.js", "path/b.js"] })` before opening targeted ranges.
3. **Soft mode 2-strike retry**: Default `readGuardMode` is `"soft"`. Repeating the exact same read once passes through intentionally when a full read is genuinely required. In `"strict"` mode, hard denials stay enforced.
4. **Logs, CSVs, and large JSON**: Do not retry full reads on `> 16 KB` data/log files. Use `agy-dart_context` `ctx_execute` (filter locally to `<= 8.8 KB`) or `ctx_index` + `ctx_search`.
5. **Adjust preset mode or exemptions**:
   - Preset CLI modes: `node scripts/install.mjs mode <host-45k|fast-32k|balanced-16k|strict-8k|no-read-hook>`.
   - Fine-grained overrides in `~/.agy-dart/config.json`: `readGuardMode` (`"soft" | "strict" | "off"`), `maxReadBytes`, `exemptExtensions`, `exemptPaths`, `readDedup`. Note: `exemptPaths` and `readGuardMode: "off"` bypass size guards only; unchanged-file `readDedup` resets automatically after edits or `/compact`.

---

## 2. `.agy-dart/filters.json` Rejected Rules & `ctx_doctor` Warnings

Project-specific CLI output filters live in `<workspace>/.agy-dart/filters.json` and fail open on errors so commands never break. Check status with `ctx_doctor` or `node scripts/install.mjs doctor`.

### File-level errors
- `not_a_file` / `empty_file`: Path is not a regular non-empty file.
- `file_too_large`: File exceeds `64 KB` (`MAX_PROJECT_RULES_FILE_BYTES`). Keep only active build/test rules.
- `invalid_json` / `invalid_schema`: Fix JSON syntax and ensure a top-level `{ "rules": [ ... ] }` array.
- `too_many_rules`: Exceeds `20` rules (`MAX_PROJECT_RULES_COUNT`). Merge related command matchers.

### Rule-level rejection reasons
- `invalid_id` / `duplicate_id`: Every `id` must be unique and match `/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,47}$/`.
- `missing_match` / `invalid_keep` / `invalid_drop`: `match` is required and must be a string; optional `keep` / `drop` must be strings.
- `unsafe_or_invalid_regex` / `invalid_regex`: `hooks/filter-rules.mjs` validates every regex with `isSafeRegex()` to prevent catastrophic backtracking (ReDoS). It rejects nested quantifiers (e.g., `(a+)+`), overlapping quantified alternations (e.g., `(a|aa)+`), backreferences (`\1`), oversized `{min,max}` bounds (`min > 100` or `max > 200`), or invalid syntax.
  - **Fix**: Replace nested or wildcard quantifiers with anchored literal prefixes, character classes (e.g., `[a-z0-9._-]+`), or simple non-overlapping alternations.
  - **Reference**: Copy and adapt a validated starter template from `examples/filters.json`.
- **Failure safety**: On non-zero exit codes, stderr and error-anchor lines are preserved automatically (`preserveTailOnFail: true` by default) so custom `drop` rules do not hide crash diagnostics.
- **Evaluation order (`keep` before `drop`)**: `keep` is evaluated before `drop` and skips `drop` when matched. Keep `keep` patterns narrow (warnings, errors, summaries) so noisy task lines intended for `drop` (such as Gradle `> Task :... UP-TO-DATE`) do not fill `maxLines` and crowd out trailing results.
- **Precedence**: Built-in rules (`git`, `npm`/`vitest`/`pytest`/`go`/`cargo`/`dotnet`, `tsc`/`eslint`/`vite build`/`webpack`, `docker build`, `gh`, `kubectl`, `terraform`, `playwright`) run **before** `.agy-dart/filters.json`. Use `.agy-dart/filters.json` for project-specific CLIs not already covered by built-in rules.

---

## 3. `apply_edits` Rollback, Abort & Target Mismatch

`agy-dart_fast` `apply_edits` validates all hunks before writing and rolls back written files automatically if a write error occurs.

### Common errors & fixes
1. **`target text not found`**:
   - Re-read the target region with `read_slices({ lineRanges: ["path:start-end"] })` or ranged `read_file`.
   - Check indentation (tabs vs spaces), trailing whitespace, or prior edits that already changed the block.
   - Verify `cwd` points to the intended workspace (calls landing inside the installed plugin directory are blocked).
2. **`target matched N times (lines: ...)`**:
   - Add `startLine` and `endLine` to the hunk, expand surrounding unique context lines in `target`, or set `replaceAll: true` if every occurrence should be replaced.
3. **Safe multi-file workflow**:
   - Group multiple hunks for the same file under a single entry in `edits`.
   - Use `dryRun: true` to verify all hunks across files with zero writes.
   - Pass `verify` to run a post-write check in the same step.
   - Set `bestEffort: true` only when partial per-file commits are explicitly acceptable.

---

## 4. KV-Cache Hit Drops & Turn-0 Prefix Bloat

### Diagnostic commands
- Full offline environment audit: `npm run cache:audit -- --workspace . --no-live` (omit `--no-live` to also probe configured stdio MCP servers twice for deterministic `tools/list` ordering).
- Fast Skills-only audit: `node bin/agy-dart.mjs audit skills --workspace .` (flags `missing_skill_frontmatter`, `oversized_skill_frontmatter > 250 tok`, `oversized_skill_body > 3000 tok`, `excessive_skills_frontmatter > 2000 tok`, and `legacy_skill_path`).
- Plugin budget & MCP schema fingerprint gate: `npm run prefix:budget`.
- Session replay & keepalive cost check: `npm run cache:simulate`.

### Common root causes & fixes
- **Bloated Turn-0 prefix**: Move bulky docs out of always-loaded `rules/` into on-demand `SKILL.md` bodies, compress verbose skill YAML `description` fields, and split long `SKILL.md` files into `references/` and `examples/`.
- **Conflicting legacy plugins**: Disable standalone `agy-fast` or `antigravity-plugin-context-mode` when `agy-dart` is installed.
- **After `/compact`**: Call `ctx_resume({})` (passing `sessionId` on shared hosts) to restore recent FTS5 source IDs and session checkpoints without re-reading large files.
- **`stablePrefixOnly` vs keepalive**:
  - Enable `stablePrefixOnly: true` in `~/.agy-dart/config.json` to strip volatile Git status lines from `SessionStart` for higher cross-session prefix stability.
  - Automatic cache keepalive (`ttlKeepalive`) is **off by default** and opt-in per window in the **agy-dart Context** panel (each keepalive consumes model input; use only when intentionally preserving a warm large prompt across short idle gaps).
- **Unattributed busts (`prefix_drift`) — reading `zero-read` / `partial hit` / `unreported` and `priorContextMatch`**:
  - `agy-dart` stabilizes controllable client-side prefixes and reduces duplicate reads, while actual cache hits still depend on how the host assembles requests and on backend caching behavior.
  - `unreported` means no valid cache-read count was present in the transcript step (do not treat a fallback `0` as a confirmed zero hit). `zero-read` means an explicit `0` cached tokens without an identified model switch, compaction, TTL expiry, media, or recognized system injection. `partial hit` means a positive cached token count that fell below the 70% retention threshold.
  - On `gemini-4-512k`, an optional `priorContextMatch` observation marks a clean zero-read bust whose subsequent warm turn read back a cache count matching the preceding reference turn's context length (`P` or `P + 1`). Replica routing, eviction, or a transient prefix change that reverted on the next turn can all produce this reading; treat it as a diagnostic signal rather than proof of backend internals.
  - If you suspect a dynamic proxy group (`url-test`, `load-balance`, or fallback switching) is disrupting cache affinity, pin a single exit node as a controlled A/B troubleshooting experiment and compare hit rates across similar turns.
- **Full-file reviews of huge files without inflating main context**:
  - Keep targeted ranged `read_file` slices (`<= 45 KiB / 800 lines`) for localized edits, and use `ctx_index` + `ctx_search` to locate relevant passages in long documents or logs.
  - When you genuinely need full-file coverage of a multi-thousand-line file (e.g., auditing a large prototype or monolith), prefer delegating to a read-only subagent that reads contiguous line ranges end-to-end and returns structured evidence (line citations and findings) to the main conversation, instead of issuing dozens of parallel `read_file` slices directly into main context. Keeping main context leaner lowers the re-prefill token loss whenever a full-zero cache miss occurs (for example, a full-zero miss on a 300k reusable prefix loses 3x as many tokens as on a 100k prefix).

---

## 5. Windows / PowerShell Encoding, Missing `rg` & Long-Task Timeouts

- **Missing `rg` (ripgrep)**: `batch_search` works via a Node.js fallback, but installing `rg` significantly speeds up large repositories.
  - Windows x64: `node scripts/install.mjs install --install-rg` (or `.\install.ps1 -InstallRg`) installs official `rg.exe` into `~/.local/bin`.
  - macOS / Linux: `brew install ripgrep` or `apt install ripgrep`.
- **Windows / PowerShell quoting & UTF-8**:
  - Inline `ctx_execute` code should stay `<= 5` lines (`~400` chars). For multi-line log/JSONL processing or tricky shell escaping, write a script to `<Artifact Directory Path>/scratch/` (or an OS temp directory outside the repo on non-Antigravity hosts) and call `ctx_execute({ language: "python", file, args })`. See `examples/ctx_trace_summary.py`.
  - Commands with unsafe shell metacharacters (`%`, `!`, etc.) fail open past `cli-filter` automatically.
- **Long tasks & daemons (`run_checks` vs `run_command`)**:
  - Use `agy-dart_fast` `run_checks` for short foreground checks (`<= 60s`).
  - For builds, full integration suites (`> 60s`), watchers, or dev servers, use native `run_command` with `WaitMsBeforeAsync <= 2000` (plus `IsDaemon: true` for servers) and monitor with `manage_task`. Commands with `WaitMsBeforeAsync <= 2000` bypass foreground CLI filtering (`cliFilterAsyncBypassMs: 2000`).

---

## 6. Antigravity `ide-tools` Toolbox Schema Error (Duplicate `/required`)

### Symptom
Before a turn starts, Antigravity fails to initialize the agent toolbox with a JSON Schema Draft 2020-12 error on a double-prefixed tool name:
```text
agent executor error: building toolbox: tool "mcp_ide-tools_mcp_agy-dart_fast_apply_edits" advertises an invalid parameter schema: ...
• at '': 'allOf' failed
    • at '/required': items at 1 and 2 are equal
```

### Root cause
- `fast/mcp-server.mjs` only declares a single top-level required field for `apply_edits` (`"required": ["edits"]`) and no duplicate `required` entries across any tool.
- In the default `fast-eager` mode, Antigravity registers `apply_edits` eagerly as `mcp_agy-dart_fast_apply_edits` and injects its synthetic `toolSummary` parameter into `/required` (`["edits", "toolSummary"]`).
- When Antigravity's `ide-tools` bridge re-exposes `mcp_agy-dart_fast_apply_edits` as `mcp_ide-tools_mcp_agy-dart_fast_apply_edits`, the executor appends `"toolSummary"` a second time without deduplicating (`["edits", "toolSummary", "toolSummary"]`), violating Draft 2020-12 `uniqueItems: true` at 0-based indices `1` and `2`. `apply_edits` fails first because it sorts first alphabetically among the 4 eager `fast` tools.

### Recovery & verification
1. **Workaround (switch to lazy loading and restart Antigravity)**:
   ```bash
   node ~/.gemini/config/plugins/agy-dart/scripts/install.mjs tool-loading lazy
   ```
   (Or remove `"tools"` / `"eager": true` under `mcpServers.fast` in `~/.gemini/config/plugins/agy-dart/mcp_config.json` and restart.)
2. **Inspect / confirm**:
   - Raw server schemas cached on disk live under `~/.gemini/antigravity/mcp/agy-dart_fast/apply_edits.json` (App/IDE) or `~/.gemini/antigravity-cli/mcp/agy-dart_fast/apply_edits.json` (CLI) and show `"required": ["edits"]`; if `ide-tools` caches schemas on disk, check `~/.gemini/antigravity*/mcp/ide-tools/`.
   - Leaving only `read_slices` with `"eager": true` (which declares no top-level `required` array in `fast/mcp-server.mjs`) shifts the error to `mcp_ide-tools_mcp_agy-dart_fast_read_slices` with `at '/required': items at 0 and 1 are equal`, confirming both duplicates are injected by the host bridge.

---

## 7. Background Safety Monitor Quota Burn & False-Alarm Bursts (Issue #1886)

### How Antigravity's 3-stage background safety pipeline works
- **Stage 1 (`agy_tool_safety`, local ~20 µs)**: Native `read_file` hits `allowed_tool` (even on outside-workspace paths) and skips all cloud reviews. Write tools (`edit_file`, `write_file`), shell calls with `unquoted_shell_operators` (`;`, `|`, `&&`) or `unknown_command`, and **all MCP tools** (including `mcp_agy-dart_*`, even when Eager) return `unsupported_tool` and enter Stage 2.
- **Stage 2 (`sir_flash_lite`, ~48K char cap, ~1.1s)**: Runs on `MODEL_TIER_FLASH_LITE`. Hitting ~4,400 calls in a 5h window triggers `HTTP 429 RESOURCE_EXHAUSTED` + `parent sir_flash_lite failed, running it anyway`, escalating calls directly into Stage 3.
- **Stage 3 (`severe_internal_risks_agy` / `gemini-4-hydrogen-sonar`, up to 300K char cap, 3–6s)**: Invoked either after 429 fallback OR under zero-429 false-alarm / sticky-review escalations. These background `streamGenerateContent` requests are invisible in chat transcripts and standard usage panels.

### Diagnostics (before restarting Antigravity!)
- Desktop Antigravity **truncates `%APPDATA%\Antigravity\logs\language_server.log` on every restart**. Run diagnostics before restarting (or keep the **agy-dart Context** Sidecar open, which incrementally persists 5h rolling buckets to `~/.agy-dart/safety-audit-state.json`).
- Offline redacted CLI audit: `npm run safety:audit` or `node bin/agy-dart.mjs audit safety [--json] [--safety-log-path <path>] [--window-hours 5]`.
- Inside an agent session: call `ctx_doctor` and inspect `safetyMonitor`.
- Configuration overrides in `~/.agy-dart/config.json` (or `AGY_DART_SAFETY_*` env vars): `safetyAudit`, `safetyLogPaths`, `safetyStatePath`, `safetyWindowHours`, `safetyPrecheckWarnCount` (default `3500`), `safetyPrecheckLimit` (default `4400`), `safetyHeavyBurstCount` (default `3`), `safetyHeavyBurstWindowMin` (default `5`), `safetyStickyCharThreshold` (default `150000`).

### Proven source-side mitigations
1. **Outside-workspace files -> native `read_file`**: Reading global configs, `~/.gemini/...`, plugins, or brain artifacts with native ranged `read_file` stays on the `allowed_tool` fast-path (0 cloud checks), whereas calling `mcp_agy-dart_fast_*` outside the workspace frequently triggers Signal E 200K–300K char `gemini-4-hydrogen-sonar` false alarms.
2. **In-workspace multi-step work -> batch with `agy-dart_fast`**: Because `edit_file` and compound shell calls always trigger Stage 2, batching multiple in-workspace edits into one `apply_edits` or multiple queries into one `batch_search` lowers total `sir_flash_lite` call volume while keeping context lean.
3. **Break long-trajectory & sticky-review chains early**: Once a long session completes a major phase—especially after `git push`, PR updates, CDP browser automation, or repeated heavy safety escalations—generate a **Handoff Brief** and continue in a fresh window so subsequent steps do not carry a 250K–300K review tail.
4. **Concurrent `agy` CLI bursts**: Single-session daily workflows can keep normal batching, but when running many parallel `agy` CLI workers, avoid unnecessary unquoted shell operators (`&&`, `;`, `|`, `2>/dev/null`) that drive `unquoted_shell_operators` / `unknown_command` triggers toward the 4,400/5h limit.
