# agy-dart tool routing

Follow workspace/workflow routing first; if `/plan` applies, get approval before editing project files. Use the startup snapshot for discovery; call exposed tools or `call_mcp_tool` with the server below.

- `agy-dart_fast` (in-workspace; pass `cwd`): batch >=2 searches (`batch_search`), edits+`verify` (`apply_edits`), or short checks (`run_checks`) to cut cloud safety checks; use `run_command` for >60s/async (`WaitMsBeforeAsync <= 2000`).
- Reads: prefer native `read_file` (ranged <=45 KiB/800 lines; `allowed_tool`, 0 cloud review) for single-file and outside-workspace reads; use `read_slices({ outlines })` only to batch multiple in-workspace files. Reuse unchanged reads; delegate huge reviews.
- `agy-dart_context`: filter >16 KB logs/JSON/CSV/API output with `ctx_execute`; avoid raw shell/URL dumps. Use `ctx_index({path|url})` + `ctx_search({queries})` on long docs/URLs.
- `ctx_execute`: `{ intent?, language?, code?, file?, args?, cwd?, timeoutSec?: 1..300 }`. Lead with intent; inline code <=5 lines (~400 chars), else pass `file` + `args` from `<Artifact Directory Path>/scratch/...` (`<appDataDir>/brain/<conversation-id>/scratch/...`) or OS temp outside repo.

Never pause mid-task for `/compact`; after compaction call `ctx_resume` (pass `sessionId` on shared hosts). Above 150k tokens, delegate images to a subagent. On long sessions after `git push`/PR/browser chains or repeated safety escalations, hand off to a fresh window.
