---
"klopsi": minor
---

Add `klopsi profile <input>` and `client.query.profile()` for per-column statistics (type, non-null and null counts, null percentage, approximate distinct count, text-rendered min/max, and numeric mean and standard deviation) over any tabular input accepted by `klopsi query`, using the same staged-database cache, read-only worker sandbox, and time, memory, and thread bounds. Interrupting `query` or `profile` while the input is still being staged now exits 7 with `QUERY_CANCELLED` instead of an internal error.
