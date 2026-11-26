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
9. **Works smoothly alongside your Skills, plus a Skills bloat check**: Use it with any Skills in Antigravity, Claude Code, or Codex — your Skills guide the workflow while `agy-dart` quietly blocks giant file reads, trims noisy logs, and looks after your cache; run `node bin/agy-dart.mjs audit skills` to see how much startup context each installed Skill uses and spot oversized main files.

> Antigravity updates frequently — click **Star** at the top right to follow compatibility updates.

---

## How to Install

Use **Node.js 22.16.0 or later in the 22.x line, or Node.js 24 or later**. The installer checks that the built-in SQLite supports FTS5 with the trigram tokenizer. The plugin uses only built-in modules.

### Option 1: One-line terminal install (no clone needed)

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/zou172866/Antigravity-agy-dart/v1.7.5/install.ps1 | iex
```

**macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/zou172866/Antigravity-agy-dart/v1.7.5/install.sh | sh
```

### Option 2: Let Antigravity install it

Send this to Antigravity:

```text
Clone tag v1.7.5 of https://github.com/zou172866/Antigravity-agy-dart.git to a temp folder, run `node scripts/install.mjs install` (add `--install-rg` on Windows if `rg` is missing), and confirm `doctor` passes.
```

### Option 3: Clone & install with custom flags

```powershell
git clone --branch v1.7.5 --depth 1 https://github.com/zou172866/Antigravity-agy-dart.git
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

Automatic cache warming is off by default. To turn it on for a chat, enable **Auto-Keepalive** in the **agy-dart Context** panel — or click **Warm 1×** next to the countdown anytime for a single manual ping. **Global Warm** sets the default count and timing (**Auto**, **Fixed 4 / 9 / 15 min**, or **Custom 1–60 min**) for chats that haven't picked their own. Turning warming off for a chat silences its expiry and limit desktop alerts. Desktop alerts for stalled chats are also off by default and can be enabled separately. Each warm-up asks the model for a short `OK` reply and uses input tokens (or the full conversation if the cache already expired). The panel also controls desktop alerts, pausing protection, local cleanup, and file-size limits.

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

### v1.7.5
- **One-click manual `Warm 1×` button in the panel**: Added a manual warm-up button right next to the cache countdown. It works even when Auto-Keepalive is off and doesn't use up your automatic warm-up limit (with double-click protection and rollback if sending fails).
- **Skip hopeless last-second warm-ups & unified countdown**: When only a few seconds are left and a warm-up ping won't arrive in time, the plugin skips it to avoid wasting tokens and falls back to a desktop alert instead. The panel, background monitor, and alerts now all share the same expiry countdown, and warming stops right away if the cache has already expired.

### v1.7.4
- **Warmer wording for "Copy Handoff Prompt"**: Updated the handoff prompt templates with a friendlier opening (`宝宝，` in Chinese / `Sweetie,` in English) and asked the AI to start its generated handoff summary the same way — still body-only, with no filler.

### v1.7.3
- **Custom Auto-Keepalive intervals**: Pick **Auto**, **Fixed 4 / 9 / 15 min**, or **Custom (1–60 min)** globally or per chat, with one-click reset back to **Global**. All existing safety guards (max count, skipping short chats, stopping after a cache miss, and skipping background subagents) stay on.
- **Fixed false warnings on timeouts and partial test runs**: Timed-out commands no longer trigger "repeated edit-fail" alerts; passing an unrelated test or a single test case won't erase an earlier full-suite failure; background test errors stay visible even after editing other files; and if a failing check log gets cut off, the panel keeps flagging it until you re-run it.
- **Cleaner handoff summaries & clearer cache-miss reasons**: Copy cleaner progress summaries before switching chats or compacting (with secrets auto-masked), and see more accurate reasons when the cache misses.

### v1.7.2
- **Lighter built-in skill docs & a Skills bloat check**: Moved sample scripts and troubleshooting notes into on-demand files so they don't eat startup context when unused; added `node bin/agy-dart.mjs audit skills` to check how much startup context each installed Skill uses and spot oversized main files.
- **Leaner output from built-in helper agents**: The built-in coding (`dart-coder`) and review (`dart-reviewer`) subagents stay lightweight without carrying extra external tools or global rules, and now route quick checks through output trimming instead of dumping long terminal logs into the chat.

### v1.7.1
- **Fixed the panel's "Blocked Noise" counter staying at 0**: Bytes saved by sliced file reads, batched searches, and trimmed check outputs are now counted accurately in the panel, without mixing up windows or double-counting.
- **Roll up subagent savings into the main chat**: Savings from saved long docs, batch lookups, and background subagents now roll up under the main conversation so panel totals stay accurate.
- **Fixed missed log filtering on Windows / PowerShell**: Commands using flags like `npm --prefix`, `pnpm -C`, `yarn --cwd`, or `--` separators now trim noisy output properly on Windows and PowerShell too.

### v1.7.0
- **Hand the AI a file map when blocking a full large-file read**: When the AI tries to read a huge code file all at once for the first time, the block message now includes a line-numbered list of functions and classes so it can jump straight to the lines it needs without an extra turn.
- **Unified CLI with Claude Code & Codex support**: Added `node bin/agy-dart.mjs` to install for Antigravity, Claude Code, or Codex, print file outlines, and compare token usage across chats; also shipped lightweight built-in coding/review subagents and stronger workspace & Node.js checks.

### v1.6.0
- **4 core tools preloaded directly, fixing occasional dropped multi-file edits**: Batch search, file outlines, multi-file edits, and quick checks now load directly instead of going through an extra layer that sometimes emptied multi-file edits; the other 8 large-log tools stay on-demand to save startup context.
- **Fixed Auto-Keepalive stalls & skipped all background subagents**: The background panel now restarts cleanly after plugin updates so stale processes don't interfere; subagents spawned by `/boost`, browser tasks, or workflows — plus closed chats — never send keepalive pings or crowd the top status bar.
- **Let subagents read freely & protect the plugin folder**: Background subagents can read large or repeated files without hitting red block messages, and any call missing a project path that lands inside the plugin's own install folder is blocked so the AI won't search or edit the plugin by mistake.
- **One-line install without cloning**: Added single-line PowerShell and Shell commands so you don't have to clone the repo first.
- **Other polish**: Unused output budget from short checks automatically shifts to long error traces; read-only Git queries block untrusted external commands; fixed Windows hang on exit; upgrades preserve your custom `rules/*.local.md` files; added a security policy and light/dark architecture diagrams.

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
npm run brief:check                         # Check that AI_REVIEW_BRIEF.md line/test counts are up to date
node scripts/cache-audit.mjs --workspace . --no-live
node bin/agy-dart.mjs audit skills --workspace .   # Check startup context usage and structure of installed Skills
npm run cache:simulate
```

After adding, removing, or editing modules or tests, keep these three places in sync so local checks stay green:
- **Installer file list** (`scripts/install.mjs`): update `RUNTIME_FILES` (installed by default) or `DEVTOOLS_FILES` (`--with-devtools`) whenever files are added or removed, or `npm run verify:pkg` will fail.
- **Test count check** (`tests/v1.2-hardening.test.mjs`): when the test count changes, update the hardcoded `computeBriefMetrics(ROOT).testCases` number to match `npm test`.
- **Review brief** (`AI_REVIEW_BRIEF.md`): after changing tracked source files or test counts, run `node scripts/gen-review-brief.mjs --write` to refresh the numbers, then verify with `npm run brief:check`.

---

## Credits & License

[MIT License](LICENSE). Incorporates and adapts MIT-licensed code from [INK-Q/agy-fast](https://github.com/INK-Q/agy-fast) and [Domush/antigravity-plugin-context-mode](https://github.com/Domush/antigravity-plugin-context-mode); full third-party notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## CLI (Antigravity / Claude Code / Codex)

`node bin/agy-dart.mjs` installs for Antigravity by default; pass `--target claude` or `--target codex` for Claude Code or Codex. You can also run `outline <file>` to print a file's function map with line numbers, `session <id>` to inspect one chat's token bill, or `compare <before> <after>` to compare two chats.

When installing for Claude Code or Codex, the installer saves an undo record in `~/.agy-dart/<host>-install.json` so uninstalling cleanly restores your original config.

```sh
git clone --branch v1.7.5 --depth 1 https://github.com/zou172866/Antigravity-agy-dart.git
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
