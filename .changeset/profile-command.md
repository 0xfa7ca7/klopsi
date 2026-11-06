---
"klopsi": minor
---

Add `klopsi profile <input>` and `client.query.profile()` for per-column statistics (type, non-null and null counts, null percentage, approximate distinct count, text-rendered min/max capped at 256 characters, and numeric mean and standard deviation that skip non-finite float values) over any tabular input accepted by `klopsi query`, using the same staged-database cache, read-only worker sandbox, and time, memory, and thread bounds. Interrupting `query` or `profile` while the input is still being staged now exits 7 with `QUERY_CANCELLED` instead of an internal error. Query results too large for a single IPC write (for example, 5,000 rows of 100-character text) are now delivered instead of failing with `QUERY_WORKER_EXIT`.
