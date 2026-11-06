---
"klopsi": minor
---

Retry transient failures when fetching remote content. Downloads, remote preview/query/convert/validate inputs, WFS requests, and `resource headers` probes now retry network errors, per-attempt timeouts, and HTTP 408/425/429/500/502/503/504 with jittered exponential backoff, honouring `Retry-After` up to 30 seconds. The new `--http-retries <number>` global option, `http.retries` config key, and `KLOPSI_HTTP_RETRIES` environment variable set the number of retries (default 2; 0 disables). Each retry warns on stderr unless `--quiet` is set, `download` and `resource headers` report `meta.attempts` in JSON output, and partial bytes from a failed attempt are always discarded.
