<div align="center">

[简体中文](README.zh-CN.md) · **English**

<img src="assets/logo.svg" alt="agy-dart logo" width="80" />

# agy-dart

**Google Antigravity plugin — Save tokens · Improve KV-cache hits · Keep cache warm automatically · Protect context quota · Rescue crashed sessions**

No extra dependencies · Works automatically in the background · Built-in Sidecar dashboard

[![License: MIT](https://img.shields.io/badge/License-MIT-10b981.svg)](LICENSE)
[![Node.js 22.16+ (22.x) or 24+](https://img.shields.io/badge/Node.js-22.16%2B_(22.x)_or_24%2B-38bdf8.svg)](package.json)
[![Security Policy](https://img.shields.io/badge/Security-Policy-818cf8.svg)](SECURITY.md)
[![Glama MCP](https://glama.ai/mcp/servers/zou172866/agy-dart/badges/score.svg)](https://glama.ai/mcp/servers/zou172866/agy-dart)
[![Clones](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/zou172866/repo-traffic-archive/main/badges/Antigravity-agy-dart.json)](https://github.com/zou172866/repo-traffic-archive)

[How to Install](#how-to-install) · [Changelog](#changelog) · [Security](SECURITY.md) · [Third-Party Notices](THIRD_PARTY_NOTICES.md)

</div>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/architecture-dark.svg" />
    <source media="(prefers-color-scheme: light)" srcset="assets/architecture-light.svg" />
    <img alt="agy-dart architecture" src="assets/architecture-dark.svg" width="860" />
  </picture>
</p>

<p align="center">
  <img alt="Before vs With agy-dart comparison" src="assets/demo-comparison.svg" width="860" />
</p>

---

## What does this Google Antigravity plugin do?

`agy-dart` is a performance, KV-cache, and context-window plugin for **Google Antigravity** (also supports Claude Code and Codex via `--target`). It reduces repeated reads and large tool results, shows prompt-cache usage, and helps you resume work in a new chat when a session fills up or stalls.

Once installed, it runs automatically in the background — no new commands to learn, just chat and code as usual:

### 1. Combine actions
When the AI needs to search several terms, it runs them in one batch; when it edits multiple files, it edits them together and runs tests in the same step instead of resending your full chat context across half a dozen turns.

### 2. Block noise
If a test run prints 3,000 lines of logs, the plugin passes only the lines that matter to the AI (e.g., line 42 failed, the other 199 passed) and stores the full log locally for lookup. On multi-thousand-line code files, it pulls the outline first and reads only the target lines.

### 3. Cache monitoring and optional keepalive
The plugin stabilizes controllable client-side prefixes and reduces repeated reads of unchanged files; actual cache hit rates still depend on how the host constructs requests and on backend caching behavior (if you use a dynamic proxy pool, pinning a single exit node can serve as a controlled troubleshooting experiment). Automatic keepalive and desktop expiry alerts start off. If you enable keepalive, the initial limit is one ping per chat until your next message. You can change the limit in the panel.

### 4. Side panel & crash/hang rescue
The right-sidebar panel shows: remaining context space, minutes until cache expiry, and total noise blocked.
With multiple project windows open, if a background window is nearly out of context or stuck spinning with zero output, a desktop popup names that exact project and chat — click the popup to jump straight there. If a session crashes from blown-out context or hangs completely, click once in the panel to copy a progress summary and paste it into a new chat to continue.

### Other built-in features
1. **Restore context clues after `/compact`**: Records modified files, latest test/build pass status, and saved reference IDs in the background so the AI can pick back up right after `/compact`.
2. **Local search for long docs & web pages**: Stores multi-thousand-word docs or web pages by section in a local database and fetches only matching sections by keyword.
3. **Local script filtering for giant logs & tables**: On multi-MB logs, CSVs, or huge JSON dumps, the AI runs a short local script to compute counts or extract rows (e.g., top 5 failing endpoints) and returns only the result; large JSON outputs also surface error rows automatically.
4. **Workspace layout on new chats**: Supplies a compact directory, script, and core-file summary at the start of a new conversation.
5. **Loop warnings**: Shows a UI-only note (not injected into model context) when the AI repeats `edit → fail → revert → fail` cycles or calls the same tool with no progress.
6. **Secret masking & sensitive-file blocking**: Masks API keys and tokens in logs or fetched pages, blocks accidental reads of `.env` files when configured, and sandboxes read-only `git` queries against untrusted `.git/config` hooks.
7. **Hard 8.8 KB response cap with dynamic quota**: Antigravity spills tool outputs above ~10 KB into a temp file that costs an extra read turn; all plugin responses stay within 8.8 KB, dynamically giving short passing checks' unused space to failing stack traces.
8. **Detailed panel breakdown & offline simulation**: Inspect context usage across file reads, terminal output, and subagents, check 15-turn cache hit trends and miss causes, optionally read only changed lines after edits (off by default), or replay past chat history via CLI to measure cache hit rates and keepalive cost.
9. **Complements Agent Skills & audits Skills prefix tax**: Works orthogonally alongside domain Agent Skills in Antigravity, Claude Code, and Codex — Skills guide task workflows while `agy-dart` handles low-level read guards, log filtering, and KV-cache hygiene underneath; run `node bin/agy-dart.mjs audit skills` to inspect Turn-0 frontmatter overhead and progressive-disclosure structure across installed skills.

> Antigravity updates frequently — click **Star** at the top right to follow compatibility updates.

---

## How to Install

Use **Node.js 22.16.0 or later in the 22.x line, or Node.js 24 or later**. The installer checks that the built-in SQLite supports FTS5 with the trigram tokenizer. The plugin uses only built-in modules.

### Option 1: One-line terminal install (no clone needed)

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/zou172866/Antigravity-agy-dart/v1.7.2/install.ps1 | iex
```

**macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/zou172866/Antigravity-agy-dart/v1.7.2/install.sh | sh
```

### Option 2: Let Antigravity install it

Send this to Antigravity:

```text
Clone tag v1.7.2 of https://github.com/zou172866/Antigravity-agy-dart.git to a temp folder, run `node scripts/install.mjs install` (add `--install-rg` on Windows if `rg` is missing), and confirm `doctor` passes.
```

### Option 3: Clone & install with custom flags

```powershell
git clone --branch v1.7.2 --depth 1 https://github.com/zou172866/Antigravity-agy-dart.git
cd Antigravity-agy-dart

# Windows PowerShell (optional -InstallRg auto-installs ripgrep)
.\install.ps1 -InstallRg

# macOS / Linux
./install.sh
```

**Other commands:**

```bash
node scripts/install.mjs install                        # Global install (auto-syncs GEMINI_HOME & T3 ACP if present)
node scripts/install.mjs install --project /repo/path   # Single-project install
node scripts/install.mjs doctor                         # Check install health
node scripts/install.mjs uninstall                      # Uninstall
```

Restart or reload Antigravity after installing and open a new chat. User-created `rules/*.local.md` files inside the plugin directory are preserved across upgrades. If you previously installed standalone `agy-fast` or `antigravity-plugin-context-mode`, disable the old ones in your plugin list.

Indexed content and usage history are stored locally in `~/.agy-dart/context.db` by default and survive uninstall. Before uninstalling, `ctx_purge` can clear the current chat's index. When the host omits a session ID, this covers anonymous data for the confirmed workspace. To clear indexed data and history across all projects, call `ctx_purge` with `scope: "all"`.

Global uninstall also removes the Gemini/T3 copies recorded by the installer. If an older copy has no ownership record, the installer prints its location and a command for removing that copy explicitly.

---

## Settings

Automatic cache keepalive is off by default. To opt in for one chat, turn on **Auto-Keepalive** in the **agy-dart Context** panel. **Global Warm** sets the default for chats without an override. Turning off warming for a chat silences its cache-expiry and keepalive-limit desktop alerts. Desktop alerts for stalled tasks default to off and can be enabled separately. Each keepalive requests an `OK` reply and consumes model input, including the full prompt on a cache miss. The panel also controls desktop alerts, protection, local cleanup, and file-size limits.

Preset modes & tool-loading modes via CLI:

```bash
node scripts/install.mjs mode host-45k              # Default: direct read up to 45 KB code / 128 KB patches, block >16 KB noisy logs
node scripts/install.mjs mode balanced-16k          # Outline first above 16 KB
node scripts/install.mjs mode fast-32k              # Raise normal file limit to 32 KB
node scripts/install.mjs mode strict-8k             # Block above 8 KB
node scripts/install.mjs mode no-read-hook          # Never block file reads, only trim noisy terminal output

node scripts/install.mjs tool-loading fast-eager    # Default: 4 fast tools eager, 8 context tools lazy
node scripts/install.mjs tool-loading lazy          # All 12 tools lazy-loaded
node scripts/install.mjs tool-loading eager         # All 12 tools eager-loaded
```

> **Troubleshooting (`ide-tools` duplicate `/required` error):** If Antigravity fails during toolbox initialization with `building toolbox: tool "mcp_ide-tools_mcp_agy-dart_fast_apply_edits" advertises an invalid parameter schema ... at '/required': items at 1 and 2 are equal`, the host's `ide-tools` bridge is re-wrapping already-eager `mcp_agy-dart_fast_*` tools and appending `toolSummary` to `/required` a second time without deduplicating (`agy-dart` itself only declares `"required": ["edits"]`). Switch to lazy loading and restart Antigravity:
>
> ```bash
> node ~/.gemini/config/plugins/agy-dart/scripts/install.mjs tool-loading lazy
> ```
>
> (Or remove `"tools"` / `"eager": true` under `mcpServers.fast` in `~/.gemini/config/plugins/agy-dart/mcp_config.json` and restart. See [skills/agy-dart/references/error-playbook.md](skills/agy-dart/references/error-playbook.md) for diagnostics.)

---

## Changelog

### v1.7.2
- **Agent Skills progressive disclosure & prefix-tax audit**: Restructured `skills/agy-dart/` with on-demand `examples/` (`ctx_trace_summary.py`, `filters.json`) and `references/error-playbook.md` synced cleanly across Antigravity, Claude Code, and Codex; added `node bin/agy-dart.mjs audit skills` to inspect Turn-0 frontmatter tax and progressive-disclosure hygiene, and separated on-demand skill assets in `prefix:budget`.
- **Scoped `dart-coder` / `dart-reviewer` check routing**: Guided built-in minimal agents to prefer `run_checks` for short checks (keeping `run_command` for `>60s` or async tasks) so command outputs stay within 8.8 KB without losing `inheritMcp: false` / `inheritCustomizations: false` isolation.
- **Test & packaging hardening**: Isolated `AGY_DART_CONFIG_PATH` in `v1.2-persist-prefix.test.mjs` so local `~/.agy-dart/config.json` overrides (such as `stablePrefixOnly: true`) never interfere with unit tests, and excluded Python bytecode artifacts (`__pycache__`, `*.py[cod]`) from Git and package manifests.

### v1.7.1
- **Accurate "Guard Saved" accounting for `agy-dart_fast` tools**: `read_slices`, `run_checks`, and `batch_search` now record strictly non-inflated byte savings (only when raw input/output genuinely exceeds returned bytes) and attribute anonymous shared MCP calls cleanly to the active conversation without cross-session stealing.
- **Expanded Windows / PowerShell CLI filtering**: `cli-filter` now recognizes leading package-manager flags (`npm --prefix`, `pnpm -C`, `yarn --cwd`, etc.) and safe `--` argument/path separators while preserving cross-shell safety guards.
- **Complete MCP receipt claiming & subagent rollup**: Extended receipt claiming to `ctx_index` and `ctx_batch` alongside `ctx_execute`, synced `sources`/`chunks` ownership (`schema v155` + `idx_sources_origin_session`), and unified `rootSessionId` rollup so subagent savings roll up into parent conversation stats without double-counting.

### v1.7.0
- **Compact signature outlines & inline read-guard outlines**: Added compact function-signature outlines and inline line-number outlines when a large un-ranged file read is intercepted on first blind read.
- **Multi-host CLI (`bin/agy-dart.mjs`) & scoped subagents**: Added `agy-dart` CLI with `--target claude|codex`, `outline`, `session`, and `compare` commands, shipped `dart-coder` / `dart-reviewer` role definitions, and hardened workspace isolation & Node.js 22.16+ / 24+ SQLite FTS5 checks.

### v1.6.0
- **4 core fast tools preloaded directly, fixing occasional multi-file edit drops**: Batch search, outlines, multi-file edits, and concurrent checks now preload directly instead of going through the wrapper tool that occasionally emptied multi-file edit arrays; the other 8 large-log tools stay on-demand to save initial context (switchable via `tool-loading`).
- **Fixed automatic cache keepalive & skipped all subagents**: Cleared legacy global-off state conflicts from old panel processes, added duplicate-send locks, and auto-restarts the background panel after plugin updates; subagents spawned by `/boost`, browser tasks, or workflows — plus closed chats — no longer trigger keepalives or take over the top keepalive bar.
- **Direct file reads for subagents, plugin-folder write protection**: Background subagents can read large or repeated files directly without red-text blocks; calls missing a project path that land inside the installed plugin folder are blocked so the plugin never searches or edits its own files.
- **One-line install without cloning**: Added single-line PowerShell and Shell install commands.
- Cross-platform hook launcher; unused quota from short checks shifts to long error traces; read-only Git sandboxing against external `.git/config` hooks; clean Windows exit, preserved `rules/*.local.md` on upgrade, plus `SECURITY.md` and light/dark architecture diagrams.

### v1.5.4
- **Click alerts to jump to that chat**: Clicking a desktop popup or cross-window panel alert brings the matching project window to the front and opens that conversation; added a multi-window session switcher bar in the panel.
- **Optional cache keepalive** sends a ping for primary chats shortly before expiry. The panel controls the per-chat limit. Your next message resets the count.
- Moved current context usage, cache countdown, and blocked noise volume into a larger top card in the panel.

### v1.5.3
- **Project & chat titles on multi-window alerts**: Desktop popups and panel alerts show folder names (e.g., `work/agy-dart`) and short chat titles without exposing message text.
- **"Context Almost Full" desktop alert**: Pops up once near the limit and resets after `/compact`.

### v1.5.2
- Faster file reads and chat startup; added code outlines for multi-thousand-line `.html` / `.astro` and `.dart` files; fixed Windows Python / PowerShell encoding garbling and paused panel refreshes while hidden.

### v1.5.1
- Filled in untranslated strings in Chinese UI mode; tuned post-edit file-limit suggestions.

### v1.5.0
- **Read actual model cache expiry time**: Reads the active model's real cache lifetime (such as 5m or 15m) from recent usage and carries it into new chats.
- Added optional 1-minute cache-expiry desktop reminder and CLI keepalive cost simulation.

### v1.4.0
- **Hang detection & rescue summary**: Flags chats stuck spinning with zero output (ignoring long builds and laptop sleep), points to the stalled step in the panel, and prepares a one-click progress summary (modified files, last command, current step) to continue in a new chat.

### v1.3.1
- Allow immediate file re-reads right after `/compact`; skip dedup prompts on slices under 4 KB; preserve mid-log error lines in long failure outputs.

### v1.3.0
- **Tiered file-read limits**: Raised direct reads to 45 KB (800 lines) for normal code and 128 KB for `.patch` files while keeping noisy logs at 16 KB; second-try reads pass through so patch reviews and subagents don't stall.
- Added `.patch` file outlines and kept context lines when trimming `git diff`.

### v1.2.2
- **Uninterrupted long tasks**: Removed mid-task `/compact` prompts and routed >60s builds, tests, and background servers straight to Antigravity's native background runner.
- Blocked `.env` reads and fixed 42 Windows shell, isolation, and orphan-process issues.

### v1.2.1
- Automatic rollback on failed multi-file edits and 76 path/argument stability fixes.

### v1.2.0
- Unified settings in `~/.agy-dart/config.json`; added local panel request checks; **automatic structure, sample, and error extraction for huge JSON files**; added `gh`, `kubectl`, `terraform`, and `playwright` output trimming plus handoff summaries.

### v1.1.0
- **Automatic terminal output trimming**: Strips progress bars and repetitive noise from `git`, test, build, and install commands while saving full logs locally.
- Unchanged-file duplicate-read protection, edit-fail loop notes, internal-URL SSRF blocking, log secret masking, and one-click panel cleanup.

---

## Local Checks

```bash
npm test                                    # Run full test suite
npm run verify:pkg                          # Verify installer file list
npm run prefix:budget                       # Estimate configured Antigravity startup and full-catalog token usage
node scripts/cache-audit.mjs --workspace . --no-live
node bin/agy-dart.mjs audit skills --workspace .   # Audit Skills Turn-0 frontmatter tax & progressive disclosure
npm run cache:simulate
```

---

## Credits & License

[MIT License](LICENSE). Incorporates and adapts MIT-licensed code from [INK-Q/agy-fast](https://github.com/INK-Q/agy-fast) and [Domush/antigravity-plugin-context-mode](https://github.com/Domush/antigravity-plugin-context-mode); full third-party notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## v1.7 CLI

Install for Antigravity by default. Select Claude Code or Codex explicitly with `--target claude|codex`. Use `outline <file>` for a compact signature map and `session <id>` or `compare <before> <after>` for transcript usage.

For Claude Code and Codex, the installer keeps hashes and undo metadata in `~/.agy-dart/<host>-install.json` to restore the plugin's configuration changes. Reinstalling replaces an older full-config record. Uninstalling removes that host's record.

```sh
git clone --branch v1.7.2 --depth 1 https://github.com/zou172866/Antigravity-agy-dart.git
cd Antigravity-agy-dart
node bin/agy-dart.mjs install
node bin/agy-dart.mjs doctor
```

---

## Star History

<a href="https://www.star-history.com/?repos=zou172866%2FAntigravity-agy-dart&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/image?repos=zou172866/antigravity-agy-dart&type=date&theme=dark&legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/image?repos=zou172866/antigravity-agy-dart&type=date&legend=top-left" />
    <img alt="Star History Chart" src="https://api.star-history.com/image?repos=zou172866/antigravity-agy-dart&type=date&legend=top-left" />
  </picture>
</a>
