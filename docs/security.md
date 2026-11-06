# Security boundaries

Network fetches require HTTPS and public DNS/IP results, revalidate redirects, limit redirect count/time/bytes, and sanitize filenames. OPSI catalogue redirects are restricted to the exact configured HTTPS origin and their intermediate bodies are cancelled. Explicit `--allow-insecure-http` and `--allow-private-network` overrides apply only to download/content commands. Existing files are not replaced without `--force`; atomic publication and checksum provenance detect partial or changed content.

Queries admit one SELECT, WITH…SELECT, or VALUES statement, run in a worker with row/time/memory/thread/cell/output bounds, open the staged database read-only, disable external access and extensions, and terminate on cancellation. Output escapes terminal controls and optionally prefixes formula-like spreadsheet strings. Debug stacks require `--debug` and redact secret headers/values. No telemetry, analytics, AI provider, or hidden AI service exists.

## Threat boundaries

Provider metadata, filenames, URLs, redirects, headers, tabular cells, spreadsheet formulas, SQL, configuration files, cache objects, and provenance sidecars are untrusted. Remote text is sanitized before terminal rendering. Filenames are reduced to safe basenames and destinations remain inside the selected directory. Redirect/DNS checks are repeated to resist rebinding; private, loopback, link-local, multicast, and special-purpose addresses are denied unless the explicit per-command override is present. Plain HTTP is likewise opt-in and recorded in provenance.

Downloads use bounded time/bytes/redirects, exclusive temporary files, hashes, atomic rename/link publication, and cleanup. Bounded retries (`http.retries`, default 2) apply only to idempotent GET/HEAD content fetches after transient network errors, per-attempt timeouts, or HTTP 408/425/429/500/502/503/504; each attempt re-runs the full HTTPS, DNS, redirect, origin, and size policy, and every attempt streams into a fresh exclusive temporary file that is removed if the attempt fails, so bytes from different responses are never spliced. Policy rejections, size-limit violations, other 4xx statuses, and cancellation are not retried, and `Retry-After` is honoured only up to 30 seconds. Existing different files survive unless `--force`. Cache objects are content-addressed, locked, and verified. Provenance redacts URL credentials/query secrets and stores source/final redirect information, retrieval time, digest, size, provider/dataset/resource IDs, transformations, and override flags. Verification recomputes the artifact digest.

## Catalogue snapshot trust boundary

The default dataset list trusts no static bytes merely because GitHub Pages served them. It uses
one compile-time HTTPS origin, accepts only safe relative paths below the versioned snapshot
prefix, and restricts redirects to that origin. The snapshot client applies one monotonic
8.5-second remote-operation deadline across the manifest and snapshot reads, leaving 1.5 seconds
of headroom for typed failure propagation and cleanup within the under-ten-second observable
bound. Each individual read is also capped by the strict reader's configured per-request
ceiling, which defaults to 9.5 seconds; a shorter explicit ceiling remains effective. Separate
manifest and snapshot size limits also apply. The manifest and snapshot pass strict schemas
with unknown-key rejection; the client verifies schema version, generation timestamp, count,
ordering, unique IDs, exact byte length, and SHA-256 before emitting a record or publishing the
cache atomically. The npm package includes neither a fallback snapshot nor mutable service
metadata.

Snapshot freshness is based on `generatedAt`, never download or cache time, and may not exceed
24 hours. Offline mode accepts only a completely validated fresh cache. Missing, stale,
malformed, oversized, or digest-invalid data fails closed, and normal mode never falls back to
direct OPSI access. The explicit `--live` mode remains subject to the provider's normal network
controls and is unavailable offline.

GitHub Actions is the only npm publication path: `0.0.1` uses one short-lived token in the
protected `npm` environment to create the package, and later releases use trusted publishing.
GitHub Pages is the static transport, so these services' availability affects cold and refresh
requests; this project makes no hard uptime-SLA claim for either service. Publication uses
least-privilege workflow permissions: generation has
`contents: read` plus the `pages: read` required by the pinned Pages configuration action,
Pages/OIDC writes remain isolated to deployment, and verification has `contents: read`. Pinned
third-party actions, a prior-count reduction guard, immutable snapshot retention, and
post-deployment digest/schema verification provide additional controls. Operational response is documented in the
[catalogue service operations guide](catalogue-service.md).

## Query and format isolation

SQL policy uses DuckDB statement extraction/preparation, rejects multiple/diagnostic/mutating statements, stages input in a KLOPSI-owned database, reopens read-only, disables external access and extension auto-install/load, and runs in a killable worker. Cached stages are immutable content-addressed objects; workers never open the canonical cache path, only an invocation-local hard link or exclusive copy. Structural verification also opens read-only with external access and extensions disabled. Derived metadata contains only digests, format/sheet, compatibility versions, sizes, and retention timestamps—never source paths, URLs, credentials, SQL, or result rows. TTL/LRU eviction affects only rebuildable derived stages. Limits cover SQL bytes, rows, deadline, 1GB memory, four threads, columns, cells, and output. XLSX shared strings/columns and all preview/export sizes are bounded. Formula-like strings are warned or prefixed by explicit spreadsheet-safe export.

## DuckDB UI boundary

`klopsi duckdb open` reuses the same validated staging pipeline and gives the external CLI a writable invocation-local workbench path, never the canonical cache object. The staged database is attached to that workbench with DuckDB's `READ_ONLY` option as `dataset`, and `main.data` is a view over `dataset.main.data`. The lease remains live only while the UI process is attached; closing DuckDB UI releases and removes both invocation-local databases. The canonical derived-cache object remains immutable.

DuckDB UI is an explicitly launched local exploration tool, not the bounded `klopsi query` sandbox. KLOPSI does not apply its single-statement, row, time, memory, extension, or external-access policy inside the UI. Treat SQL, extension choices, imports, exports, and paths entered there as direct local DuckDB actions. Use the bounded query command for reproducible automation or untrusted SQL.

The external CLI is never installed implicitly by package installation, startup, diagnostics, or ordinary commands. Installation requires `klopsi duckdb install --yes` or the explicit `--install` flag on `duckdb open`. Automatic installation accepts only DuckDB's exact official HTTPS installer URLs, rejects redirects and oversized or empty responses, stores the script in an owner-only temporary directory, launches the platform interpreter without shell interpolation, pins the requested CLI version, verifies the installed executable, and cleans up the temporary script.

## Overrides, secrets, and reporting

`--allow-insecure-http`, `--allow-private-network`, `--force`, and `--debug` never persist as relaxed defaults. Destructive cache operations require `--yes` in non-TTY or structured-output contexts; interactive human TTY commands may use the explicit `[y/N]` confirmation prompt. Non-TTY processes never prompt or hang for input. `OPSI_API_KEY` is environment-only, and config refuses secret-like keys. Errors omit causes/stacks by default; debug stacks pass terminal sanitation and redaction.

Report vulnerabilities privately through GitHub Security Advisories with affected version/platform, reproduction, and impact. Do not include live credentials or private datasets. Maintainers will coordinate validation, a supported-release fix, regression tests, advisory/CVE where appropriate, and release notes before public disclosure.
