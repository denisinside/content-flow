# Dify workflow checks

The same `DIFY_*` configuration is used in every runtime mode; no `TEST_DIFY_*` variables or extra test Dify apps are needed. Ordinary automated tests inject synthetic settings and transport. To print the current three config pins for `.env`, run `node scripts/dify/print_config_env.mjs`. Each value is `configDigest` from its operation's `release.json`, not `workflowDslSha256` or a manually hashed YAML. The command reads public local descriptors only. Configure a value after publishing the matching release; it does not automatically attest to the remote app's settings.

Outline generation now has a [reviewed 38-node pipeline](../../packages/backend/src/editorial/workflows/outline-generation/README.md): strategy review, complete editorial/grounding reviews, two bounded native loops and mandatory ready report. `build_outline_generation_dsl.py` is its deterministic generator; `test_outline_generation_runtime.py` checks invariants and `test_outline_generation_graph.py` exercises the exported graph on real Graphon with synthetic LLM/Code executor. `verify_outline_release.mjs` checks prompt/runtime/DSL hashes and complete provider/test release pins. Publication and real model quality remain separate acceptance work.

Claim extraction now has a [reviewed 40-node pipeline](../../packages/backend/src/claims/workflows/claim-extraction/README.md). Run `test_claim_extraction_runtime.py` for controller invariants and `test_claim_extraction_graph.py` for the actual exported graph on Graphon with synthetic LLM/Code executor. `build_claim_extraction_dsl.py` remains the entry point and uses `build_claim_review_dsl.py`; shared baseline graph envelopes for outline/article remain separate and unchanged.

The article-generation workflow now has a native 51-node editorial pipeline. See its [design, limits, contract and import instructions](../../packages/backend/src/editorial/workflows/article-generation/README.md). `test_article_generation_runtime.py` checks the bounded editorial controller; `test_article_generation_graph.py` executes the generated YAML on real Graphon 0.7.0 with synthetic LLM and local Code-executor substitutes. The selector validator covers native Loop initializers, break conditions and Assigner v2 target/source references with passing and deliberately broken fixtures. These checks do not prove remote editor/plugin/model compatibility or actual writing quality.

`validate_dify_dsl.py` checks an exported Dify app/workflow YAML or JSON document. It does not install Python packages, execute Code-node contents, contact Dify, or prove that a workflow imports, publishes, or runs successfully.

For a full local pass, create the project-isolated validator environment once:

```powershell
py -3 -m venv .venv-dify-validator
.\.venv-dify-validator\Scripts\python.exe -m pip install -r scripts/dify/requirements.txt
.\.venv-dify-validator\Scripts\python.exe scripts/dify/validate_dify_dsl.py --self-test
```

`requirements.txt` pins PyYAML, Jinja2 and Graphon 0.7.0. The Graphon pin matches the admin-panel reference profile; it is not asserted as the engine version of every Dify Cloud tenant. This environment is ignored by Git and separate from the app's runtime dependencies.

```powershell
python scripts/dify/validate_dify_dsl.py path\to\dify-export.yml
python scripts/dify/validate_dify_dsl.py --self-test
```

On Windows, use `py -3` if `python` is not on `PATH`. If neither command exists in the Codex desktop session, call `load_workspace_dependencies` and run the returned bundled Python executable. The target project keeps its validator dependencies isolated in `.venv-dify-validator`.

The built-in parser accepts JSON-form DSL because JSON is a YAML subset. Other YAML requires PyYAML. The self-test explicitly exercises duplicate-key rejection for both JSON and YAML and valid/invalid Jinja syntax when the pinned packages are installed. The validator never invokes `pip`.

The structural pass checks duplicate mapping keys, DSL version syntax, node/edge IDs and references, selectors and upstream ancestry, declared environment variables, Python Code-node syntax/arguments/literal return keys, and Jinja syntax when available. Duplicate keys are rejected because YAML/JSON parsers can otherwise silently replace earlier values. It does not infer arbitrary plug-in schemas or execute workflow code.

Graphon `version:` is not inferred from the DSL `version:` field. The latter identifies the DSL document version; the target Dify installation determines its engine package separately. Node-data schema checks are opt-in and use an exact, allowlisted package that is already installed:

```powershell
python scripts/dify/validate_dify_dsl.py path\to\dify-export.yml --graphon-version 0.7.0
```

Graphon `0.7.0` is the only pin currently allowlisted, taken from the sibling `admin-panel` reference. Passing it imports that installed package's code in the current Python process. A missing or mismatched package exits with an error; the validator does not install it. Unknown node types are warnings by default because Dify-side and plug-in nodes may not be registered in Graphon. `--strict-node-types` treats them as errors and can reject valid extension nodes.

`--profile admin-panel-reference` enables envelope, branch-handle, and End-output checks documented by the reference for its Dify 2.x / Graphon 0.7.0 context. That profile has not been verified against ContentFlow's target Dify server. Confirm the server/editor version before relying on these profile-specific checks.

The current `release.json` at `packages/backend/src/claims/workflows/claim-extraction/release.json` is ContentFlow API registry metadata, not an importable Dify workflow DSL. The DSL validator rejects it with an actionable message. Verify its prompt and canonical config digests with:

```powershell
node scripts/dify/verify_release.mjs
```

`verify_release.mjs` is read-only. It checks the SHA-256 of `prompt.md` and the generated DSL, the canonical SHA-256 of `release.json` with `configDigest` omitted, and the matching release ID/config digest pinned in the provider and claim-extraction tests. It does not verify a published workflow, remote configuration, or live execution.

Build the real claim-extraction Workflow API DSL from the pinned prompt and schema with:

```powershell
.\.venv-dify-validator\Scripts\python.exe scripts\dify\build_claim_extraction_dsl.py
.\.venv-dify-validator\Scripts\python.exe scripts\dify\validate_dify_dsl.py packages\backend\src\claims\workflows\claim-extraction\claim-extraction-v1.yml --graphon-version 0.7.0 --profile admin-panel-reference
```

The output is a YAML app export for import into Dify, not the API release descriptor or synthetic fixture. It is a User Input workflow for the existing Workflow API provider: input `sources_json`, outputs `claims_json` and mandatory `extraction_report`. The target is Dify 1.17.1 / Graphon 0.7.0; the admin-panel editor profile is only a local reference. Dify Cloud import, Gemini plugin/model access, Code sandbox, publish checks, and a live run still need verification in the target workspace. Follow the claim workflow README's acceptance steps before publication. After accepting the published release, set `DIFY_API_BASE_URL=https://api.dify.ai/v1`, copy the published workflow ID and app API key from Dify's Access API page, and use the checked-in `DIFY_CLAIM_EXTRACTION_CONFIG_SHA256` pin. This API mode has no app-specific webhook URL: ContentFlow calls `POST /v1/workflows/run` with streaming response mode. Dify Cloud may restrict the version-specific `/workflows/{workflow_id}/run` endpoint by plan, so the worker executes the currently published workflow and verifies its returned `workflow_id` against the frozen release before accepting any claims. Keep the per-app API key server-side; do not commit it. Existing live environment pins are preserved; the old published workflow does not meet the new report contract.

The synthetic JSON-form fixture in `fixtures/minimal_valid_dsl.yaml` exercises only the validator's static structure; it is not a claim that this reduced fixture can be imported into a Dify server.

## Explicit live diagnostics

`live_workflow_checks.mjs --preflight` reads the three existing apps' parameters. `--live --suite smoke|adversarial|all` calls the real providers with synthetic fixtures and writes sanitized receipts; `--case name,name` selects cases. It reads ordinary DIFY_* configuration in every mode and never imports or publishes. Build the backend first. Live calls require owner authorization.

New live runs default to a timestamped `docs/live-dify/` directory to preserve earlier release evidence; `--output-dir` explicitly chooses another destination. Direct Gemini probes accept `--schema-file` and `--output-dir` for a new release without overwriting historical fixtures/receipts.

`gemini_compat_checks.mjs --live --env-file '<authorized-env-path>'` reads only GEMINI_API_KEY from that explicitly supplied file and probes direct model/schema compatibility. The saved public schema fixture is required; `--isolate-bounds` and `--isolate-max-items` separate constraint changes. Keys are never printed or persisted. [2026-10-09 results and fixture/release limitations](../../docs/LIVE_DIFY_CHECK_2026-10-09.md).

## Actual prompt delivery and local real-model checks

All three controlled exports bind request_json through explicit Jinja selectors. Graphon 0.7.0 basic prompt placeholders cannot interpolate hyphenated node IDs. test_prompt_rendering.py uses the actual Graphon prompt composer and preserves opaque Ukrainian/source template text. Graph scenario mocks now render prompts before reading JSON.

`live_graphon_gemini.py --self-test` is offline. Paid local execution requires `--live --env-file <explicit external absolute path> --operation claims|outline|article --input-file <synthetic receipt or JSON> --output-dir <receipt parent>`. It substitutes direct Gemini REST and local Code execution, preserves sanitized per-call prompts/responses and final engine outputs, and does not verify remote Dify plugins/publication. The Dify harness supports `--export-fixtures` for synthetic inputs without model requests.
