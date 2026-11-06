---
"klopsi": patch
---

Replace ExcelJS with a bounded in-house XLSX reader and writer, removing the deprecated `inflight`, `rimraf@2`, `glob@7`, `fstream`, `lodash.isequal`, and `uuid@8` packages from installs (fixes #42). Date-formatted XLSX cells are now read as wall-clock text (`YYYY-MM-DD` or `YYYY-MM-DDTHH:MM:SS`, no time zone) while time-only and elapsed formats stay numeric, exported dates carry a date-time number format, and malformed or oversized workbooks fail with `INVALID_XLSX_DATA` or `XLSX_LIMIT_EXCEEDED`.
