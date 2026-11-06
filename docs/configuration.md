# Configuration

Precedence is CLI flags, environment, `./klopsi.config.json`, user config, then defaults. `klopsi config path` prints both files. Defaults: provider `opsi`, output `human`, locale `sl-SI`, online mode, platform cache/data directories, HTTP timeout 30000 ms per attempt, two HTTP retries (three attempts), download maximum 2 GiB, preview 20 rows, query 1000 rows/30000 ms, DuckDB `1GB` and 4 threads, a transparent 10 GB/30-day DuckDB stage cache, and color unless `NO_COLOR` exists.

Environment names include `KLOPSI_PROVIDER`, `KLOPSI_OUTPUT`, `KLOPSI_OFFLINE`, `KLOPSI_CACHE_DIR`, `KLOPSI_DOWNLOAD_DIR`, `KLOPSI_HTTP_TIMEOUT_MS`, `KLOPSI_HTTP_RETRIES`, `KLOPSI_MAX_DOWNLOAD_BYTES`, `KLOPSI_QUERY_ROW_LIMIT`, `KLOPSI_QUERY_TIMEOUT_MS`, `KLOPSI_DUCKDB_MEMORY_LIMIT`, `KLOPSI_DUCKDB_CACHE_ENABLED`, `KLOPSI_DUCKDB_CACHE_MAX_BYTES`, `KLOPSI_DUCKDB_CACHE_TTL_DAYS`, and `OPSI_API_KEY`. Only the environment may provide secrets. `config set` validates the complete strict schema and refuses api-key/token/secret/authorization/cookie-like keys.

## Complete schema

`provider` is a non-empty provider ID; `output` is `human|json|ndjson|csv|tsv`; `locale` is non-empty; and `offline` is boolean. Paths are non-empty and HTTP/preview/query limits are positive integers, except `http.retries`, which is a nonnegative integer. DuckDB memory accepts a positive byte-size string no larger than decimal `1GB` (for example, `512MB` or `1GB`), threads are limited to 1–4, and its cache uses validated byte sizes. Archive limits are `archive.maxEntries`, `maxPathBytes`, `maxSelectedBytes`, `maxExpandedBytes`, and `maxCompressionRatio`. XML limits are `xml.maxDocumentBytes`, `maxDepth`, `maxAttributesPerElement`, `maxValueBytes`, `maxColumns`, `maxRecords`, and `maxStateBytes`. All are positive. Unknown keys fail strict validation.

The defaults are provider `opsi`, human output, locale `sl-SI`, online mode, platform-conventional cache/data roots, 30,000 ms HTTP timeout, `http.retries = 2`, 2 GiB maximum download, 20 preview rows, 1,000 query rows, 30,000 ms query timeout, `1GB` DuckDB memory, four threads, `duckdb.cache = {"enabled":true,"maxBytes":"10GB","ttlDays":30}`, and color when `NO_COLOR` is absent. The DuckDB budget applies only to rebuildable derived stages; raw downloads, provider metadata, catalogue snapshots, and provenance are outside its LRU eviction budget.

Archive defaults are 10,000 entries, 1,024 path bytes, 512 MiB selected bytes, 1 GiB expanded bytes, and a 200:1 compression ratio. XML defaults are 64 MiB document/state, depth 128, 256 attributes per element, 1 MiB values, 1,024 columns, and 100,000 records.

### PC-Axis engine limits

Dense PC-Axis parsing always uses hard bounds. The CLI currently uses the defaults below; SDK callers may replace the complete set through `KlopsiClientOptions.pcAxisLimits`. These are engine options, not accepted `klopsi.config.json` keys.

The principal byte/cube defaults are `maxMetadataBytes`: 16 MiB, `maxCells`: 100,000,000, and `maxStagingBytes`: 1 GiB.

| `PcAxisLimits` field | Default |
| --- | ---: |
| `maxSourceBytes` | 512 MiB |
| `maxMetadataBytes` | 16 MiB |
| `maxMetadataStatements` | 100,000 |
| `maxStatementBytes` | 4 MiB |
| `maxDimensions` | 64 |
| `maxValuesPerDimension` | 1,000,000 |
| `maxCells` | 100,000,000 |
| `maxDecodedStringBytes` | 1 MiB |
| `maxNotes` | 10,000 |
| `maxLanguageVariants` | 10,000 |
| `maxCellTokenBytes` | 64 KiB |
| `maxEmittedRecords` | 1,000,000 |
| `maxStagingBytes` | 1 GiB |

Limits are checked before allocation or overflow-sensitive multiplication. Preview is additionally bounded by its requested row limit, while query and conversion staging must satisfy both the PC-Axis limits and the normal DuckDB/output policies.

## Transient download retries

Remote content fetches (`download`, remote `resource preview`, `query`, `convert`, and `validate`, WFS service requests, and `resource headers` probes) retry transient failures: connection resets/refusals, temporary DNS failures (`EAI_AGAIN`), socket errors, per-attempt timeouts, and HTTP 408, 425, 429, 500, 502, 503, and 504. `http.retries` (`--http-retries`, `KLOPSI_HTTP_RETRIES`) is the number of additional attempts, an integer from `0` to `10`; the default `2` allows three attempts in total, `0` disables retries, and larger values are rejected as invalid input (exit 2). `http.timeoutMs` applies to each attempt, so the worst-case wall time grows with the retry count.

Backoff is exponential with full jitter (a random delay below 500 ms, 1 s, 2 s, … capped at 30 s). A `Retry-After` header is honoured when it is delta-seconds or an RFC 9110 HTTP date (IMF-fixdate, or the obsolete RFC 850 and asctime forms): the wait is the longer of that value and the jittered backoff, so `0` or a past date never causes an immediate retry storm. If it asks for more than 30 s the command fails at once rather than waiting. Any other `Retry-After` value is ignored in favour of the jittered backoff. Each retry prints `warning [DOWNLOAD_RETRY]: …` to stderr unless `--quiet` is set, and `download`/`resource headers` JSON output reports the attempts used in `meta.attempts` (provenance sidecars are unchanged). Other 4xx statuses, HTTPS/private-network/redirect/origin policy rejections, size-limit violations, integrity failures, and cancellation are never retried. Partially received bytes from a failed attempt are discarded before the next attempt, so a published artifact always comes from one complete response. After the final attempt the last error is reported (`DOWNLOAD_HTTP_ERROR` or `DOWNLOAD_FAILED`, exit 4) with `context.attempts`. Cancelling a fetch (for example with Ctrl-C), whether during a request, a backoff wait, or while waiting for the destination lock, stops at once with `DOWNLOAD_CANCELLED`. It uses exit 4, the network/provider category, because downloads have no dedicated cancellation exit code. Before this release a caller abort during a fetch surfaced as `DOWNLOAD_FAILED`. Conditional revalidation of a cached download sends one `HEAD` probe without retries, because the following `GET` has its own retry budget; explicit `resource headers` probes do retry. Catalogue snapshot reads keep their fixed deadline and do not retry. The OPSI catalogue API has its own request scheduler and retry policy, which this setting does not change.

## Examples and precedence

User file: `{"query":{"rowLimit":500},"terminal":{"color":false}}`. Project file: `{"provider":"opsi","offline":true}`. `KLOPSI_OFFLINE=0 klopsi search promet --offline` is offline because the CLI layer wins. `KLOPSI_OUTPUT=csv klopsi search promet --json` produces JSON for the same reason. Nested objects merge by field; later layers do not erase sibling fields.

Use `klopsi config path` before editing by hand, `klopsi config set query.rowLimit 500` for validated atomic writes, `klopsi config get query.rowLimit`, and `klopsi config list`. Values that parse as JSON retain boolean/number/object meaning; other values remain strings. The project file is never mutated by `config set`.

## Secrets and recovery

`OPSI_API_KEY` is read only from the process environment. Config commands neither display nor persist it. Secret-like dotted keys are rejected even if the schema would otherwise reject them later. Debug rendering redacts API keys, tokens, authorization, cookies, and secret assignments. If configuration is invalid, correct or remove the reported file/value; `config path` paths are documented by platform in installation guidance.
