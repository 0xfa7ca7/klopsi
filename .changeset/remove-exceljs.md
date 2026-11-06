---
"klopsi": patch
---

Replace ExcelJS with a bounded in-house XLSX reader and writer, removing the deprecated `inflight`, `rimraf@2`, `glob@7`, `fstream`, `lodash.isequal`, and `uuid@8` packages from installs (fixes #42). Date-formatted XLSX cells are now read as ISO timestamps, exported dates carry a date number format, and malformed or oversized workbooks fail with `INVALID_XLSX_DATA` or `XLSX_LIMIT_EXCEEDED`.
