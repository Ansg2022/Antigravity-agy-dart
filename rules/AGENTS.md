# agy-dart tool routing

Follow workspace rules first; get `/plan` approval before edits. Use startup snapshot; call exposed tools or `call_mcp_tool`:

- `agy-dart_fast` (in-workspace; pass `cwd`): batch >=2 searches (`batch_search`), edits+`verify` (`apply_edits`), or short checks (`run_checks`); use `run_command` for >60s/async (`WaitMsBeforeAsync <= 2000`).
- Reads: native `read_file` (ranged <=45 KiB/800 lines; `allowed_tool`, 0 cloud review) for single-file/outside-workspace reads; `read_slices({ outlines })` only to batch in-workspace files. Reuse unchanged reads; delegate huge reviews.
- `agy-dart_context`: filter >16 KB logs/JSON/CSV/API via `ctx_execute`; index long docs/URLs via `ctx_index` + `ctx_search`.
- `ctx_execute`: `{ intent?, language?, code?, file?, args?, cwd?, timeoutSec?: 1..300 }`. Lead with intent; inline <=5 lines (~400 chars), else `file` + `args` under `<Artifact Directory Path>/scratch/...` (`<appDataDir>/brain/<conversation-id>/scratch/...`) or OS temp outside repo.

Never pause mid-task for `/compact`; after compaction call `ctx_resume` (`sessionId` on shared hosts). Above 150k tokens, delegate images. After `git push`/PR/browser chains or repeated safety escalations, hand off to a fresh window.
