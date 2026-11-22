# Source-grounded writing workflow

This directory contains the importable Dify Workflow DSL and the local API release descriptor for writing from frozen, selected evidence. `release.json` is ContentFlow metadata; import `source-writing-v1.yml` as a separate Workflow app.

The workflow targets Dify `1.17.1`, Graphon `0.7.0` and DSL `0.7.0`. It uses Gemini `gemini-3.8-flash` for one author call and one independent semantic/citation reviewer. If the reviewer finds a targeted major issue, one repair call and one final review may follow. Normal runs use 2 calls; the hard maximum is 4. No call publishes or approves the draft.

The Workflow API input is `source_writing_request_json`, a JSON `source-writing-input-v1` request. It contains one bounded task (`OUTLINE`, one `SECTION`, or a channel `ADAPTATION`), a brief, style guidance, optional nonfactual writing context, selected evidence passages and any required approved claims with their supporting quotations. The complete UTF-8 input is limited to 150,000 bytes; passages and required-claim evidence together are limited to 60,000 bytes. Bounds and conditional fields are validated in the Code nodes. Notes, brandbook text, settings and style samples are instructions about presentation only; factual content can come only from the supplied source passages and approved claims.

Ordinary `SECTION` writing, when the request has no required approved claims, uses an indexed evidence output. The model writes a paragraph and selects one source passage by its zero-based input index. Runtime validates that index, generates the paragraph ID, attaches the exact full supplied passage as the quotation, and uses the full paragraph as its assertion locator. This avoids asking the model to copy UUIDs or long source quotations. Each factual paragraph can cite one selected passage, and the independent reviewer still checks whether the passage actually supports the paragraph. A brief transition with no factual content can use the index after the final passage and gets no citation. Legacy requests carrying required claims retain their existing citation format.

The workflow returns `source_writing_json` with schema `source-writing-v1` and a separate `source_writing_report`. Only a candidate that passes exact source-locator guards and a matching independent review returns `status: ready` with content. Other outcomes return `content: null`. In the legacy path, a citation must quote an exact, unique substring of an allowed source and point to one exact, unique, nonoverlapping substring of the paragraph. In indexed sections the runtime builds these locators from the selected supplied passage and complete paragraph. This locates text; it does not prove that the source is true. The server validates the complete output again before a human can review or approve it.

`OUTLINE` selects relevant passages and required claims across up to 30 sections and allocates the brief's target word count exactly. For `SECTION`, the target and calculated 80–120% range guide the draft but do not trigger a deterministic rejection by length alone. The independent reviewer checks whether a short draft omits useful supported detail or a long draft adds repetition, padding or irrelevant content; a sound concise section can pass, and sparse evidence must not be padded. `ADAPTATION` supports all seven channels: caption text, cover title/instruction where applicable, and reviewed frame scripts for carousels/stories. Frames retain stable IDs, exact citations, purpose, visual hints and story transitions; a frame repair changes only its addressed text/citations. Caption/script candidates share one exact job but require independent human approval. Optional approvedArticle carries the complete current approved Article ID/hash/title/text as editorial context for derived channels; only supplied passages/required claims can establish factual support. Each section/adaptation is one bounded request, not an entire long Article in one provider call. No exhaustive fact inventory is promised.

The output is constrained to 450,000 bytes and the serialized controller state to 750,000 bytes. The model schema omits nested `maxItems`; deterministic Code-node checks enforce item bounds. One review may trigger at most one repair, and the final review must approve that exact repaired content hash. If a structural, locator or review guard fails, the workflow returns a human-needed result without content.

## Dify setup

1. Generate and validate the local artifact before importing it. Do not import `release.json`.
2. Keep the Dify app key in the server environment as `DIFY_SOURCE_WRITING_API_KEY`; configure the published Workflow ID in `DIFY_SOURCE_WRITING_PUBLISHED_WORKFLOW_ID`. The local descriptor names the expected environment variables but contains no credentials or published ID.
3. Importing, publishing, and executing a live workflow are separate actions. These local checks do not establish that the app exists remotely, that the Google model/plugin is configured, or that a real run produces good writing.

Dify may retain workflow input, prompts and model outputs in run history. Inputs include source quotations and style/context text. Restrict run-history access and retention under the project's data policy. No provider key is sent in the request JSON or embedded in this DSL.

Run offline checks from the repository root:

```powershell
.\.venv-dify-validator\Scripts\python.exe scripts\dify\build_source_writing_dsl.py
.\.venv-dify-validator\Scripts\python.exe scripts\dify\validate_dify_dsl.py --self-test
.\.venv-dify-validator\Scripts\python.exe scripts\dify\validate_dify_dsl.py packages\backend\src\evidence\workflows\source-writing\source-writing-v1.yml --graphon-version 0.7.0
Push-Location scripts\dify
..\..\.venv-dify-validator\Scripts\python.exe -B -m unittest test_source_writing_graph -v
Pop-Location
```

The Graphon suite executes the generated native graph with synthetic model replies and a local Code-node executor. It covers all three task shapes, the 4-call repair/re-review path, stale review hashes, unsupported/overlapping locators, no-evidence results, context snapshot hashes, and cross-language request-hash parity. It makes no Dify, Gemini or other provider calls.
