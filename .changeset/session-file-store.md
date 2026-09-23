---
'@truefoundry/trueforge-core': minor
'@truefoundry/trueforge': minor
---

Sessions can now keep files, such as screenshots returned by tools, outside their history. `@truefoundry/trueforge-core` adds the `IFileStore` port (`put`, `get`, `deleteSession`) and `SessionFileStore`, which keeps each file's bytes in an object store and one row in a new `session_file` table. The server stores the bytes in the `FILES` R2 bucket on Workers, and on Node in a local directory (`FILE_STORE_DIR`, the default) or any S3-compatible bucket (`FILE_STORE_BACKEND=s3` with the `FILE_STORE_S3_*` settings). The filesystem backend suits a single replica only, so a peered server (`STANDALONE=false`) logs a warning at startup when it is selected. Only PNG, JPEG, WebP and GIF images can be stored. `GET /api/v1/sessions/{session_id}/files/{file_id}` serves a file with its stored media type and `Cache-Control: private` to anyone who may read the session's turns, and answers 404 to anyone else. Deleting a session deletes its files. Workers deploys need an R2 bucket bound as `FILES`.
