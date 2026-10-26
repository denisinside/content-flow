# Source relevance filter — compact model protocol

Release `source-relevance-2026-10-24.1` keeps the external `source-relevance-request-v1` input and `source-relevance-v1` output unchanged. It changes only the internal prompt/result protocol sent to Gemini.

The prepare Code node validates the exact frozen request, then assigns each candidate a zero-based index. Gemini receives the query plus `{i,label,quote}` for each candidate; opaque candidate IDs, snapshot/fragment IDs and SHA-256 hashes are not sent to the model. The model returns `{decisions:[{i,c}],rankedIndexes:[...]}` with one compact class per candidate: `D` direct, `P` partial/condition, `N` no query support, `B` structural/bibliographic noise, `X` duplicate. The final Code node validates full unique coverage and the exact useful-index ranking, reconstructs the existing API relevance/reason/ID/hash fields from the original validated request, and enforces the 40 KB output bound. No class threshold, top-k quota or unfiltered fallback is introduced.

The graph remains one Gemini chat call, using the configured Google provider and `gemini-3.8-flash`, low thinking, structured JSON and a 4,096-token output ceiling. It has no tools, grounding, URL context, retries or provider fallback. The compact output for 60 candidates is under 2 KB in the synthetic maximum-coverage check. That byte/token reduction targets the earlier 23,000-token response; it does not guarantee a proportional latency reduction because provider time may depend on input length, model scheduling and structured-output behavior.

## Contract and bounds

- Dify `1.17.1`, Graphon `0.7.0`, DSL `0.7.0`.
- External variables remain `source_relevance_request_json` → `source_relevance_json`.
- Up to 60 candidates, 60,000 total quote bytes, 100,000 serialized request bytes, 1,536 bytes per quote, 1,000 UTF-16 code units / 1,536 bytes per query, 20 passages downstream and 40,000 output bytes.
- The Dify Code node validates exact quote ranges and hashes before prompt construction, and maps only numeric indexes back to their original exact IDs and quote hashes after exhaustive validation.
- Useful conflicting evidence remains separate. A human reviews evidence; this filter does not verify truth or approve content.
- Provider credentials remain in backend runtime configuration. The exported workflow contains no resolved secrets.

## Preserve the previous published release

The previous release is retained byte-for-byte under `archive/source-relevance-2026-10-22.1/`: `prompt.md`, `release.json`, `source-relevance-v1.yml`, the embedded-runtime source, and the prior README. Its recorded hashes remain in its copied release descriptor. The current verifier targets only the new current release.

## Build and offline checks

```powershell
.\.venv-dify-validator\Scripts\python.exe scripts\dify\build_source_relevance_dsl.py
.\.venv-dify-validator\Scripts\python.exe scripts\dify\validate_dify_dsl.py --self-test
.\.venv-dify-validator\Scripts\python.exe scripts\dify\validate_dify_dsl.py packages\backend\src\evidence\workflows\source-relevance\source-relevance-v1.yml --graphon-version 0.7.0
.\.venv-dify-validator\Scripts\python.exe scripts\dify\test_source_relevance_graph.py -v
node scripts/dify/verify_source_relevance_release.mjs
```

The graph test executes the exported Code-node source with real Graphon and synthetic model replies. It covers the direct/partial/noise/duplicate classes, conflicts, zero useful candidates, all 60 useful candidates, output-size reduction, compact prompt privacy, prompt-injection text treated as data, malformed output, duplicate or missing indexes, unknown ranking indexes, and proof that final IDs/hashes come from the original validated candidates. These offline checks do not prove model classification quality, Dify import/publishing or live response time.

## Import and publish

Import `source-relevance-v1.yml` as a separate Dify Workflow app named `contentflow-source-relevance-v2`. Configure the existing `langgenius/gemini/google` provider and `gemini-3.8-flash`, then review and publish it. Configure the backend with the app API key, published workflow ID, and the `configDigest` printed by `node scripts/dify/verify_source_relevance_release.mjs`. Keep the workflow API key in runtime environment only. The release digest identifies expected local configuration; it does not attest to the actual remote app settings.
