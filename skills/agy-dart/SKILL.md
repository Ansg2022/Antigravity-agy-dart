---
name: agy-dart
description: Batch code work, filter logs, search indexed docs and diagnose context or cache usage.
---

# agy-dart

## Search, read, edit and verify

In Antigravity `call_mcp_tool`, set `ServerName: "agy-dart_fast"` and pass `cwd`.

| Tool | Common arguments |
| --- | --- |
| `batch_search` | `queries: [{type, pattern, ...}]` (`text`/`regex`/`glob`/`fuzzy`/read-only `git`). Options: `outputMode` (`content`/`files_with_matches`/`count`), `multiline`, `fileType`, `sortBy: "mtime"`, `path`, `glob`, `contextLines`, `maxResults`. |
| `read_slices` | `outlines` (10–20 files/batch for symbols or patch hunks); 1-based ranges via `slices: [{path, ranges: [[s, e]]}]` or `lineRanges: ["file:s-e"]`. |
| `apply_edits` | `edits: [{path, hunks: [{target, replacement}]}]` or `create`. Use `dryRun` to preview, `verify` to check post-write, `bestEffort` only when partial commits are OK. |
| `run_checks` | `commands: [{name, command, cwd?, timeoutSec?}]`. Route `>60s`/async jobs (`WaitMsBeforeAsync <= 2000`, `IsDaemon: true`) to native `run_command` + `manage_task`. |

Read guard defaults: 45 KiB source, 128 KiB patches, 16 KB noisy/minified (soft mode allows one retry; prefer ranged reads).

## Filter large output

On `agy-dart_context`, call `ctx_execute` with `intent` first. Inline `code` (`<=5` lines / ~400 chars) supports `javascript`/`nodejs` (CJS + ESM), `python`, `shell`, `powershell`, `cmd` (`cwd`, `timeoutSec` 1–300, default 120).

For longer scripts, write to `<Artifact Directory Path>/scratch/agy_ctx_trace.py` (`<appDataDir>/brain/<conversation-id>/scratch/agy_ctx_trace.py`; non-Antigravity hosts: OS temp outside repo such as `"file": "/tmp/agy_ctx_trace.py"`), then pass `file` + `args`:

```json
{
  "intent": "Analyze slow queries in trace.json",
  "language": "python",
  "file": "/home/<user>/.gemini/antigravity/brain/<conversation-id>/scratch/agy_ctx_trace.py",
  "args": ["trace.json"]
}
```

Return only needed counts/errors. Foreground commands filter to `<=8.8 KB` inline with exit codes and searchable redacted logs. Project filters live in `.agy-dart/filters.json`; read `examples/filters.json` or `examples/ctx_trace_summary.py` on demand.

## Indexed retrieval and recovery

Index docs/URLs once via `ctx_index({path|url, label})`, query via `ctx_search({queries, sourceId, limit, offset})`, or batch commands via `ctx_batch({commands, queries})`. Prefer `/compact <focus>` (and `/btw <question>` for isolated side queries); after compaction call `ctx_resume({})` (`sessionId` on shared hosts).

## Diagnostics

Use the **agy-dart Context** panel for KV-cache hits, context usage, **Safety Monitor** (Issue #1886), and handoff (or `/context` in Antigravity CLI). On `v2.35.1+`, emit `[agy-dart Context](sidecar://agy-dart/dashboard/)` sparingly when surfacing diagnostics or requested—never in routine turns. `ctx_stats` and `ctx_doctor` render inline MCP App cards on `v2.34.0+` UI hosts and compact JSON on CLI/IDE. Override guards, `cliFilter` (`false` under strict enterprise hooks), safety audit (`safetyAudit`, `safetyLogPaths`, `safetyWindowHours`), or diff reads in `~/.agy-dart/config.json` (env overrides file). Prune old DB rows via `ctx_purge({scope: "stale", olderThanDays: 14, vacuum: true})`.

Devtools CLI (`--with-devtools` or repo): `npm run prefix:budget`, `npm run cache:audit -- --workspace . --no-live`, `npm run safety:audit`, `node bin/agy-dart.mjs audit safety|skills --workspace .`, `npm run cache:simulate`. Keep `agy-dart_fast` in-workspace (use native `read_file` outside workspace for 0 cloud checks); after `git push`, PRs, browser chains, or repeated safety escalations, hand off to a fresh window. For blocks, rollbacks, filter errors, cache drops, or quota burn, read `references/error-playbook.md` on demand.
