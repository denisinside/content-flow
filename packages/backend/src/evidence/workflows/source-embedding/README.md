# Source embeddings for evidence search

This directory contains an importable Dify Workflow export and its local API-release descriptor. `release.json` is ContentFlow metadata, not Dify DSL. Generate both files with `python scripts/dify/build_source_embedding_dsl.py`; verify their hashes by regenerating and comparing the diff.

Target profile: Dify `1.17.1`, Graphon `0.7.0`, DSL `0.7.0`. The graph makes one bounded Google Gemini `batchEmbedContents` request per workflow run. Its model, endpoint, task settings, dimensions and API documentation references are pinned in `release.json`. This corrected export is `source-embedding-2026-10-20.1`.

The workflow accepts `embedding_request_json`, an exact `source-embedding-request-v1` object:

```json
{
  "schemaVersion": "source-embedding-request-v1",
  "requestId": "10000000-0000-4000-8000-000000000000",
  "task": "DOCUMENT",
  "texts": [{
    "id": "10000000-0000-4000-8000-000000000001",
    "text": "A bounded source passage",
    "sha256": "<lowercase SHA-256 of UTF-8 text>"
  }]
}
```

`DOCUMENT` accepts 1–16 texts. `QUERY` accepts exactly one. Each text is limited to 4,000 Unicode code points and 1,536 UTF-8 bytes; total UTF-8 text is limited to 64,000 bytes, and the complete request JSON is limited to 64,000 bytes. IDs must be canonical UUIDs and unique. Every text hash is checked before contacting Google. Text must not contain non-whitespace C0 or DEL control characters. The service binds output IDs and hashes to the exact input order.

The 1,536-byte per-text limit is a conservative application bound against Google's 2,048-token model limit. This workflow does not tokenize locally. It sets `autoTruncate: false`, so an unexpected tokenizer-limit rejection is visible and does not silently embed shortened content. The backend chunker should respect the byte bound while keeping headings and table context with their passages.

## Reduced-dimension request compatibility

A live synthetic request through the previously published export returned HTTP 200 but produced 3,072-value vectors when `taskType` and `outputDimensionality: 768` appeared only inside `embedContentConfig`. ContentFlow correctly rejected those vectors before persistence. Google's batch [`EmbedContentRequest` schema](https://ai.google.dev/api/batch-api#EmbedContentRequest) still lists top-level `taskType` and `outputDimensionality` fields, although it marks them deprecated and recommends `EmbedContentConfig`; this export sends matching values in both locations and keeps `autoTruncate: false` in the config. The offline Graphon regression stub follows that observed wire behavior: it reads dimensions from the top-level field and returns the 3,072 default when that field is absent. The response validator rejects that default.

That stub is a local contract check, not proof that this corrected export works against Google's live endpoint. After importing and publishing this exact release, run one synthetic document request and one synthetic query request, confirm both return 768 values, then update ContentFlow's workflow release pin before enabling source indexing. Do not retry the failed live run; it is retained as diagnostic history.

For documents the workflow requests `RETRIEVAL_DOCUMENT`; for a query it requests `RETRIEVAL_QUERY`. It asks for 768 dimensions. The response node rejects non-2xx status, malformed JSON, response bodies over Graphon's 400,000-character Code-node bound, wrong cardinality or dimensions, boolean/non-finite/zero vectors, and invalid request metadata. It unit-normalizes every returned vector because reduced dimensions may not be normalized by the provider. Output is canonical JSON in `embedding_json` with schema `source-embedding-v1`, request ID/hash, pinned model/dimensions/task, and ordered `{id, sha256, values}` rows. The backend must validate the complete output against its frozen request before persistence.

## Dify setup

1. Import `source-embedding-v1.yml` as a new Workflow app. Do not import `release.json`.
2. Set the workflow secret environment variable `GOOGLE_EMBEDDING_API_KEY` in Dify. The exported value is blank; never put a real key in the YAML, application repository, request JSON, or ContentFlow logs.
3. Keep the HTTP node's authorization as API key → Custom header → `x-goog-api-key`; Dify/Graphon masks this configured authorization header in HTTP request traces. The synthetic Graphon test verifies that behavior. Do not move the secret into an ordinary header string.
4. Publish only after local checks and a Dify editor review. Import, publication and a live Google request are separate checks. A live request may incur provider usage; use synthetic text and the existing owner authorization.

Dify may retain workflow inputs, HTTP request bodies and output vectors in run history; those traces can contain source text. Restrict Dify run-history access and retention according to the project's data policy. The workflow masks the API key in its HTTP request trace but cannot promise that Dify stores no source content.

To run offline checks:

```powershell
.\.venv-dify-validator\Scripts\python.exe scripts\dify\build_source_embedding_dsl.py
.\.venv-dify-validator\Scripts\python.exe scripts\dify\validate_dify_dsl.py --self-test
.\.venv-dify-validator\Scripts\python.exe scripts\dify\validate_dify_dsl.py packages\backend\src\evidence\workflows\source-embedding\source-embedding-v1.yml --graphon-version 0.7.0
Push-Location scripts\dify
..\..\.venv-dify-validator\Scripts\python.exe -B -m unittest test_source_embedding_graph -v
Pop-Location
```

The Graphon test stubs the Google HTTP transport and uses synthetic vectors. It verifies the exported Code nodes, native HTTP request graph, top-level and nested task/dimension fields for document and query requests, rejection of the 3,072-dimension default, secret masking and cross-language request-hash fixture without a Google call.
