# agy-dart tool routing

Follow workspace/workflow routing first; if `/plan` applies, get approval before editing project files. Use the startup snapshot for discovery; call exposed tools or `call_mcp_tool` with the server below.

- `agy-dart_fast` (in-workspace; pass workspace `cwd`): batch `batch_search`, group `apply_edits` + `verify` by path, use `run_checks` for short checks and native `run_command` for >60s/async (`WaitMsBeforeAsync <= 2000`). For files outside the workspace (global configs/logs), use native `read_file` (`allowed_tool`, 0 cloud review).
- Large source/patches: outline via `read_slices({ outlines })` (in-workspace), then read ranged `read_file` (45 KiB/800 lines); for huge full-file reviews, use a read-only subagent returning evidence. Reuse unchanged reads; give subagents the same routing.
- `agy-dart_context`: filter >16 KB logs/JSON/CSV/API output with `ctx_execute`; avoid raw shell/URL dumps. Use `ctx_index({path|url})` + `ctx_search({queries})` on long docs/URLs.
- `ctx_execute`: `{ intent?, language?, code?, file?, args?, cwd?, timeoutSec?: 1..300 }`. Lead with intent; inline code <=5 lines (~400 chars), else pass `file` + `args` from `<Artifact Directory Path>/scratch/...` (`<appDataDir>/brain/<conversation-id>/scratch/...`) or OS temp outside repo.

Never pause mid-task for `/compact`; after compaction call `ctx_resume` (pass `sessionId` on shared hosts). Above 150k tokens, delegate images to a subagent. On long sessions after `git push`/PR/browser chains or repeated safety escalations, hand off to a fresh window.
