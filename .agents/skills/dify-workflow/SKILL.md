---
name: dify-workflow
description: Build, inspect, validate or debug an importable Dify workflow DSL, or change the controlled Dify workflow contract. Use for Dify YAML generation, node graphs, import/publish/runtime errors, or claim-extraction prompt/release changes; skip for unrelated code and read-only API client changes.
---

# Dify workflow work in ContentFlow

Read this skill when a task changes an importable Dify DSL, its node logic, or the controlled workflow release. Keep the current ContentFlow API integration separate from native Dify exports:

- The current claim-extraction [release descriptor](../../../packages/backend/src/claims/workflows/claim-extraction/release.json) and [prompt](../../../packages/backend/src/claims/workflows/claim-extraction/prompt.md) pin an API contract. They are **not** an importable Dify YAML export.
- The importable claims workflow is [claim-extraction-v1.yml](../../../packages/backend/src/claims/workflows/claim-extraction/claim-extraction-v1.yml). Regenerate it with [build_claim_extraction_dsl.py](../../../scripts/dify/build_claim_extraction_dsl.py); its prompt and DSL hashes are pinned in `release.json` and checked by `verify_release.mjs`.
- The server [provider](../../../packages/backend/src/claims/provider.ts) calls a published Dify workflow; the [worker handler](../../../packages/backend/src/claims/jobs-handler.ts) validates the complete result before committing proposed claims, using the [claims-v1 contract](../../../packages/backend/src/claims/contracts.ts). Runtime variable names are listed in the safe, placeholder-only [.env.example](../../../.env.example).
- This app uses a User Input workflow and the Workflow API by published workflow ID. For Dify Cloud, `DIFY_API_BASE_URL` includes `/v1`; this mode has no per-app webhook URL.
- Native workflow authoring produces YAML DSL. Use the project [validator](../../../scripts/dify/validate_dify_dsl.py) and its supported-version notes before importing a DSL artifact.
- After changing the current API release/prompt, run `node scripts/dify/verify_release.mjs`. It verifies local hashes only; it does not verify the remote app.

## Build and verify

1. **Establish the target.** Identify whether the request changes the API release/prompt or a native exported workflow. For a DSL task, record the target Dify/Graphon versions and workflow mode. Read version-matched Dify and Graphon source/docs for node fields or editor errors; do not promote a single observed version's rules to universal facts.
2. **Generate the graph as code.** Keep one deterministic builder as the source for nodes, edges, IDs, selectors and layout. Avoid hand-editing large generated YAML. Re-running the builder should produce a reviewable artifact without ID collisions or hidden changes.
3. **Validate the generated file.** Install the pinned, project-isolated dependencies as documented in the [validator README](../../../scripts/dify/README.md). For claim extraction, run `python scripts/dify/build_claim_extraction_dsl.py`, `python scripts/dify/validate_dify_dsl.py --self-test`, `python scripts/dify/validate_dify_dsl.py packages/backend/src/claims/workflows/claim-extraction/claim-extraction-v1.yml --graphon-version 0.7.0`, and `node scripts/dify/verify_release.mjs`. The validator never installs packages; it checks only its listed Graphon versions and static rules. Its result cannot prove that a Dify editor will publish the graph, that plugins/models/credentials exist, or that a live run behaves correctly.
4. **Exercise embedded logic separately.** Tests should load the generated DSL, extract Code-node source, and run its entry point against synthetic fixtures. Check declared outputs against returned keys, both success and failure branches, malformed/missing data, retries/idempotency and external size limits relevant to this workflow. Keep credentials and production data out of fixtures.
5. **Test validator rules in both directions.** A valid fixture must pass. For each new machine-checkable rule, make a copy with exactly that fault and prove the validator rejects it with a useful message. Avoid false positives by testing nearby valid cases.
6. **Import and live-run only with authorization.** Import success, publish-check success and runtime success are separate outcomes. Report each separately with the exact Dify/Graphon version, artifact digest, synthetic inputs and sanitized result. Do not publish, modify an app, call a paid provider or use private source material without explicit authorization.

## ContentFlow invariants

- Workflow output is untrusted candidate data. For claim extraction, each claim needs exact supplied snapshot/fragment evidence and at least one SUPPORTS relation; the server independently validates IDs, ancestry, quote, offsets, hash and bounds. Dify never approves a claim or decides that a source is true.
- Keep API keys in server runtime configuration. Exported DSL may refer to environment variables and mark secret fields, but never embed resolved credentials. Do not copy `config/secrets.local.env` or other secret files from another project.
- Persist and review the workflow release, prompt/contract versions and digest. A workflow ID or digest by itself does not attest to the remote app's actual model, prompt or plugin configuration.
- Do not copy another repository's prompts, project schemas, helper code or Dify-specific assumptions unless the task explicitly needs them. Reuse generic validation mechanisms only after checking their version and scope.

## Record discoveries

When a run exposes a new Dify constraint, find its cause in the matching editor/backend/Graphon version. Add a concise symptom→cause→fix rule here. If the rule is machine-checkable, update the validator and add passing and deliberately broken fixtures. Remove or version a rule when the upstream behavior changes. Keep task-specific graph design in that task's builder/docs rather than expanding this general skill.
