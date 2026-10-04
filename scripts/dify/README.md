# Dify workflow checks

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

The output is an importable YAML app export, not the API release descriptor or synthetic fixture. It is a User Input workflow for the existing Workflow API provider: input `sources_json`, output `claims_json`. The admin-panel editor profile is only a local reference; Dify Cloud import, model access, publish, and a live run still need to be checked in the target workspace. Import it in Dify Cloud, configure the OpenAI model if the workspace does not already have it, run a test, then publish. Set `DIFY_API_BASE_URL=https://api.dify.ai/v1`, copy the published workflow ID and app API key from Dify's Access API page, and use the checked-in `DIFY_CLAIM_EXTRACTION_CONFIG_SHA256` pin. This API mode has no app-specific webhook URL: ContentFlow calls `POST /v1/workflows/run` with streaming response mode. Dify Cloud may restrict the version-specific `/workflows/{workflow_id}/run` endpoint by plan, so the worker executes the currently published workflow and verifies its returned `workflow_id` against the frozen release before accepting any claims. Keep the per-app API key server-side; do not commit it.

The synthetic JSON-form fixture in `fixtures/minimal_valid_dsl.yaml` exercises only the validator's static structure; it is not a claim that this reduced fixture can be imported into a Dify server.
