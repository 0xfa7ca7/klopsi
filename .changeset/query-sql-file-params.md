---
"klopsi": minor
---

Make `klopsi query` scriptable and injection-safe. `--sql-file <path|->` reads the statement from a bounded (1 MiB), BOM-tolerant UTF-8 file or piped stdin, and exactly one of `--sql` or `--sql-file` is now required. Repeatable `--param name=value` (or typed `name:int|double|bool|date=value`) binds DuckDB `$name` placeholders through prepared statements instead of string interpolation. Invalid, duplicate, missing, or unused parameters exit 2 with typed `QUERY_PARAM_*` errors. Bound parameters appear in `meta.parameters` and in query-export provenance alongside the SQL. The SDK `query.execute` accepts `parameters`.
