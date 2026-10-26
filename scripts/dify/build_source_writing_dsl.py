#!/usr/bin/env python3
"""Build the separate source-grounded writing Workflow for Dify 1.17.1."""
from __future__ import annotations

import ast
import hashlib
import json
import re
from pathlib import Path

import yaml
import build_claim_extraction_dsl as base

ROOT = Path(__file__).resolve().parents[2]
DIRECTORY = ROOT / "packages/backend/src/evidence/workflows/source-writing"
RUNTIME = ROOT / "scripts/dify/source_writing_runtime.py"
OUTPUT_PATH = DIRECTORY / "source-writing-v1.yml"
RELEASE_PATH = DIRECTORY / "release.json"
RELEASE_ID = "source-writing-2026-10-20.1"
PROMPT_VERSION = "source-writing-prompt-v1"
TARGET = {"difyVersion": "1.17.1", "graphonVersion": "0.7.0", "dslVersion": "0.7.0"}
LIMITS = {"maxInputBytes": 150000, "maxContextBytes": 60000, "maxContextSnapshots": 100,
          "maxPassages": 1000,
          "maxClaims": 100, "maxSections": 30, "maxParagraphs": 300,
          "maxRepairs": 1, "maxReviews": 2, "maxModelCalls": 4,
          "maxOutputBytes": 450000, "maxStateBytes": 750000}


class SourceWritingDumper(base.DifyDumper):
    def ignore_aliases(self, data):
        return True


def canonical(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def object_schema(properties: dict, description: str | None = None) -> dict:
    result = {"type": "object", "additionalProperties": False,
              "properties": properties, "required": list(properties)}
    if description:
        result["description"] = description
    return result


def string(maximum: int = 4000, minimum: int = 0, description: str | None = None) -> dict:
    result = {"type": "string", "minLength": minimum, "maxLength": maximum}
    if description:
        result["description"] = description
    return result


def array(item: dict, maximum: int, minimum: int = 0, description: str | None = None) -> dict:
    # Gemini 3.8 Flash rejects some nested schemas containing native maxItems.
    # Code-node guards enforce the bound after each model call.
    result = {"type": "array", "items": item, "minItems": minimum,
              "description": description or f"Return at most {maximum} items."}
    return result


def schemas() -> dict[str, dict]:
    citation = object_schema({
        "kind": {"type": "string", "enum": ["source_passage", "approved_claim"]},
        "passageId": string(36), "claimRevisionId": string(36), "evidenceId": string(36),
        "quote": string(10000, 1), "assertionText": string(10000, 1),
    }, "Use passageId only for source_passage; use claimRevisionId and evidenceId only for approved_claim. Unused ID fields are empty strings.")
    paragraph = object_schema({"id": string(36, 36), "text": string(20000, 1),
                               "citations": array(citation, 100)})
    frame = object_schema({"id": string(36,36),"text": string(3000,1),"citations": array(citation,100),
        "purpose": string(200,1),"visualHint": string(1000),"transition": string(300)})
    section = object_schema({"id": string(36, 36), "title": string(300, 1), "purpose": string(2000, 1),
                            "targetWords": {"type": "integer", "minimum": 20, "maximum": 20000},
                            "passageIds": array(string(36, 36), 100),
                            "requiredClaimRevisionIds": array(string(36, 36), 100)})
    writer = object_schema({"task": {"type": "string", "enum": ["OUTLINE", "SECTION", "ADAPTATION"]},
        "title": string(500), "sectionId": string(36), "sections": array(section, 30),
        "paragraphs": array(paragraph, 300),"frames": array(frame,30),"coverInstruction": string(2000)},
        "For the selected task fill only its fields; return empty strings/arrays for unused fields.")
    issue = object_schema({"id": string(100, 1),
        "severity": {"type": "string", "enum": ["minor", "major", "critical"]},
        "paragraphId": string(36), "sectionId": string(36), "reason": string(2000, 1)},
        "Set exactly one target ID for a blocking issue; leave both blank for an untargeted minor issue.")
    review = object_schema({"reviewedHash": string(64, 64),
        "status": {"type": "string", "enum": ["ready", "needs_human", "insufficient_evidence"]},
        "issues": array(issue, 40), "reasons": array(string(2000, 1), 10)})
    paragraph_replacement = object_schema({"paragraphId": string(36, 36), "paragraph": paragraph})
    section_replacement = object_schema({"sectionId": string(36, 36), "section": section})
    patch = object_schema({"reviewedHash": string(64, 64),
        "paragraphReplacements": array(paragraph_replacement, 300),
        "sectionReplacements": array(section_replacement, 30)})
    return {"writer": writer, "review": review, "patch": patch}


def prompts() -> dict[str, str]:
    text = (DIRECTORY / "prompt.md").read_text(encoding="utf-8")
    parts = re.split(r"^# (.+)\n", text, flags=re.MULTILINE)
    roles = {parts[i]: parts[i + 1].strip() for i in range(1, len(parts), 2)}
    if set(roles) != {"Shared rules", "Writer", "Reviewer", "Repairer"}:
        raise ValueError("Source-writing prompt roles do not match the builder")
    return roles


def embedded_runtime() -> str:
    source = RUNTIME.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(RUNTIME))
    guards = [statement for statement in tree.body if isinstance(statement, ast.If)
        and isinstance(statement.test, ast.Compare) and isinstance(statement.test.left, ast.Name)
        and statement.test.left.id == "__name__" and len(statement.test.ops) == 1
        and isinstance(statement.test.ops[0], ast.Eq) and len(statement.test.comparators) == 1
        and isinstance(statement.test.comparators[0], ast.Constant)
        and statement.test.comparators[0].value == "__main__"]
    if len(guards) != 1 or guards[0] is not tree.body[-1]:
        raise ValueError("Source-writing runtime must end with exactly one standalone CLI guard")
    lines = source.splitlines(keepends=True)
    guard = guards[0]
    del lines[guard.lineno - 1:guard.end_lineno]
    return re.sub(r"^def main\(", "def runtime_main(", "".join(lines), count=1, flags=re.MULTILINE)


class Builder:
    OUTPUTS = ("state_json", "request_json", "status", "source_writing_json", "source_writing_report")

    def __init__(self):
        self.document = base.build_baseline_document()
        self.document["app"].update(name="contentflow-source-writing-v1",
            description="Frozen task evidence → source-grounded draft → independent citation review → one bounded targeted repair. Returns an unapproved candidate only.")
        self.nodes: list[dict] = []
        self.edges: list[dict] = []
        self.types: dict[str, str] = {}
        self.roles = prompts()
        self.schemas = schemas()
        self.runtime = embedded_runtime()

    def node(self, ident: str, kind: str, data: dict, x: int, y: int,
             width: int = 300, height: int = 150) -> str:
        self.nodes.append(base.node(ident, kind, data, x, y, width=width, height=height))
        self.types[ident] = kind
        return ident

    def edge(self, source: str, target: str, handle: str = "source") -> None:
        item = base.edge(source, target, self.types[source], self.types[target])
        item.update(id=f"{source}-{handle}-{target}-target", sourceHandle=handle)
        self.edges.append(item)

    def code(self, ident: str, operation: str, title: str, inputs: dict[str, list[str]], x: int, y: int):
        parameters = ", ".join(inputs)
        payload = "{" + ", ".join(repr(key) + ": " + key for key in inputs) + "}"
        wrapper = f"\ndef main({parameters}):\n" + (
            "    result = json.loads(runtime_main(" + repr(operation)
            + ", json.dumps(" + payload + ", ensure_ascii=False)))[\"result\"]\n"
            "    def encode(value):\n"
            "        rendered = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))\n"
            "        if len(rendered.encode('utf-8')) > 750000:\n"
            "            raise ValueError('SOURCE_WRITING_CODE_OUTPUT_LIMIT')\n"
            "        return rendered\n"
            "    return {\n"
            "        'state_json': encode(result['state']),\n"
            "        'request_json': encode(result.get('request', {})),\n"
            "        'status': result.get('status', result['state'].get('status', 'running')),\n"
            "        'source_writing_json': result.get('source_writing_json', ''),\n"
            "        'source_writing_report': result.get('source_writing_report', ''),\n"
            "    }\n")
        variables = [{"variable": name, "value_selector": selector} for name, selector in inputs.items()]
        outputs = {key: {"type": "string", "children": None} for key in self.OUTPUTS}
        # Keep the embedded runtime's module docstring and __future__ imports at
        # the legal start of the Code-node module. Its CLI guard is stripped.
        source = self.runtime + "\n" + wrapper
        return self.node(ident, "code", {"title": title, "code_language": "python3", "code": source,
            "variables": variables, "outputs": outputs}, x, y, width=320, height=160)

    def llm(self, ident: str, role: str, schema: str, request_node: str, x: int, y: int):
        system = self.roles["Shared rules"] + "\n\n" + self.roles[role]
        jinja = "<writing_request>\n{{ request_json }}\n</writing_request>"
        return self.node(ident, "llm", {"title": role, "desc": "One bounded structured call; no tools or automatic retries.",
            "model": {"provider": "langgenius/gemini/google", "name": "gemini-3.8-flash", "mode": "chat",
                      "completion_params": base.completion_params(8192)},
            "prompt_template": [
                {"id": ident + "-system", "role": "system", "edition_type": "basic", "text": system},
                {"id": ident + "-request", "role": "user", "edition_type": "jinja2", "text": jinja,
                 "jinja2_text": jinja}],
            "prompt_config": {"jinja2_variables": [{"variable": "request_json",
                "value_selector": [request_node, "request_json"]}]},
            "context": {"enabled": False, "variable_selector": []}, "vision": {"enabled": False},
            "structured_output_enabled": True, "structured_output": {"schema": self.schemas[schema]},
            "retry_config": {"max_retries": 0, "retry_enabled": False, "retry_interval": 3000}},
            x, y, width=370, height=200)

    def condition(self, ident: str, title: str, selector: list[str], value: str, x: int, y: int):
        return self.node(ident, "if-else", {"title": title, "cases": [{"case_id": "true",
            "logical_operator": "and", "conditions": [{"id": ident + "-condition", "varType": "string",
                "variable_selector": selector, "comparison_operator": "is", "value": value}]}]},
            x, y, width=280, height=120)

    def build(self) -> dict:
        self.node("start", "start", {"title": "Frozen task evidence and brief", "variables": [{
            "variable": "source_writing_request_json", "label": "Source writing input JSON", "type": "paragraph",
            "required": True, "max_length": 150000, "options": []}]}, 80, 380, width=280, height=110)
        self.code("prepare", "prepare", "Validate frozen writing input", {
            "source_writing_request_json": ["start", "source_writing_request_json"]}, 440, 380)
        self.condition("has_context", "Evidence is available?", ["prepare", "status"], "running", 820, 380)
        self.code("author_request", "author_request", "Prepare task and selected evidence", {"state_json": ["prepare", "state_json"]}, 1180, 380)
        self.llm("writer", "Writer", "writer", "author_request", 1550, 380)
        self.code("compile_draft", "draft", "Validate cited draft and word budget", {
            "state_json": ["author_request", "state_json"], "model_json": ["writer", "structured_output"]}, 1980, 380)
        self.condition("draft_valid", "Candidate passed deterministic guards?", ["compile_draft", "status"], "running", 2360, 380)
        self.code("review_request", "review_request", "Prepare the exact version for independent review", {
            "state_json": ["compile_draft", "state_json"]}, 2720, 380)
        self.llm("reviewer", "Reviewer", "review", "review_request", 3090, 380)
        self.code("review_decision", "review", "Check review hash and actionable targets", {
            "state_json": ["review_request", "state_json"], "model_json": ["reviewer", "structured_output"]}, 3520, 380)
        self.condition("patch_needed", "A blocking issue can be repaired?", ["review_decision", "status"], "running", 3900, 380)
        self.code("repair_request", "repair_request", "Prepare one targeted patch", {
            "state_json": ["review_decision", "state_json"]}, 4260, 200)
        self.llm("repairer", "Repairer", "patch", "repair_request", 4630, 200)
        self.code("apply_patch", "patch", "Apply only flagged replacements", {
            "state_json": ["repair_request", "state_json"], "model_json": ["repairer", "structured_output"]}, 5060, 200)
        self.condition("patch_valid", "Targeted patch passed guards?", ["apply_patch", "status"], "running", 5440, 200)
        self.code("review_request_2", "review_request", "Prepare patched version for final review", {
            "state_json": ["apply_patch", "state_json"]}, 5800, 200)
        self.llm("reviewer_2", "Reviewer", "review", "review_request_2", 6170, 200)
        self.code("review_decision_2", "review", "Check final review against patched version", {
            "state_json": ["review_request_2", "state_json"], "model_json": ["reviewer_2", "structured_output"]}, 6600, 200)

        finals = [
            ("final_input", "finalize", "Return missing-evidence result", "prepare", 1180, 720),
            ("final_draft", "finalize", "Return blocked draft result", "compile_draft", 2720, 720),
            ("final_review", "finalize", "Return reviewed candidate", "review_decision", 4260, 720),
            ("final_patch", "finalize", "Return blocked patch result", "apply_patch", 5800, 720),
            ("final_review_2", "finalize", "Return final reviewed candidate", "review_decision_2", 6970, 200),
        ]
        for ident, operation, title, source, x, y in finals:
            self.code(ident, operation, title, {"state_json": [source, "state_json"]}, x, y)

        self.node("merge_source_writing_json", "variable-aggregator", {"title": "One final writing result", "output_type": "string",
            "variables": [[item[0], "source_writing_json"] for item in finals],
            "advanced_settings": {"group_enabled": False, "groups": []}}, 7350, 500, width=310, height=140)
        self.node("merge_source_writing_report", "variable-aggregator", {"title": "One review report", "output_type": "string",
            "variables": [[item[0], "source_writing_report"] for item in finals],
            "advanced_settings": {"group_enabled": False, "groups": []}}, 7720, 500, width=310, height=140)
        self.node("end", "end", {"title": "Return unapproved source-grounded candidate", "outputs": [
            {"variable": "source_writing_json", "value_type": "string", "value_selector": ["merge_source_writing_json", "output"]},
            {"variable": "source_writing_report", "value_type": "string", "value_selector": ["merge_source_writing_report", "output"]}]},
            8090, 500, width=300, height=110)

        for source, target in [("start", "prepare"), ("prepare", "has_context"),
            ("author_request", "writer"), ("writer", "compile_draft"),
            ("compile_draft", "draft_valid"),
            ("review_request", "reviewer"), ("reviewer", "review_decision"),
            ("review_decision", "patch_needed"), ("repair_request", "repairer"),
            ("repairer", "apply_patch"), ("apply_patch", "patch_valid"),
            ("review_request_2", "reviewer_2"), ("reviewer_2", "review_decision_2")]:
            self.edge(source, target)
        self.edge("has_context", "final_input", "false")
        self.edge("has_context", "author_request", "true")
        self.edge("draft_valid", "final_draft", "false")
        self.edge("draft_valid", "review_request", "true")
        self.edge("patch_needed", "final_review", "false")
        self.edge("patch_needed", "repair_request", "true")
        self.edge("patch_valid", "final_patch", "false")
        self.edge("patch_valid", "review_request_2", "true")
        self.edge("review_decision_2", "final_review_2")
        for final, *_ in finals:
            self.edge(final, "merge_source_writing_json")
        self.edge("merge_source_writing_json", "merge_source_writing_report")
        self.edge("merge_source_writing_report", "end")
        self.document["workflow"]["graph"] = {"nodes": self.nodes, "edges": self.edges,
            "viewport": {"x": 0, "y": 100, "zoom": 0.37}}
        return self.document


def build_document() -> dict:
    return Builder().build()


def release_document(dsl_text: str) -> dict:
    release = {"schemaVersion": "contextflow-dify-release-v1", "operation": "SOURCE_WRITING",
        "releaseId": RELEASE_ID, "contractVersion": "source-writing-v1",
        "promptTemplateVersion": PROMPT_VERSION, "promptTemplateFile": "prompt.md",
        "promptSha256": hashlib.sha256((DIRECTORY / "prompt.md").read_bytes()).hexdigest(),
        "workflowDslFile": OUTPUT_PATH.name,
        "workflowDslSha256": hashlib.sha256(dsl_text.encode("utf-8")).hexdigest(),
        "runtimeFile": "scripts/dify/source_writing_runtime.py",
        "runtimeSha256": hashlib.sha256(RUNTIME.read_bytes()).hexdigest(), "target": TARGET,
        "writingLimits": LIMITS, "reportSchemaVersion": "source-writing-review-v1",
        "apiBaseEnv": "DIFY_API_BASE_URL", "apiKeyEnv": "DIFY_SOURCE_WRITING_API_KEY",
        "publishedWorkflowIdEnv": "DIFY_SOURCE_WRITING_PUBLISHED_WORKFLOW_ID",
        "configDigestEnv": "DIFY_SOURCE_WRITING_CONFIG_SHA256", "inputVariable": "source_writing_request_json",
        "outputVariable": "source_writing_json", "reportVariable": "source_writing_report",
        "responseMode": "streaming", "provider": "dify",
        "model": {"provider": "langgenius/gemini/google", "name": "gemini-3.8-flash", "mode": "chat",
                  "completionParams": base.completion_params(8192)}}
    release["configDigest"] = hashlib.sha256(canonical(release).encode("utf-8")).hexdigest()
    return release


def main() -> None:
    DIRECTORY.mkdir(parents=True, exist_ok=True)
    document = build_document()
    dsl_text = yaml.dump(document, Dumper=SourceWritingDumper, allow_unicode=True,
                         sort_keys=True, width=1000, default_flow_style=False)
    OUTPUT_PATH.write_text(dsl_text, encoding="utf-8", newline="\n")
    RELEASE_PATH.write_text(json.dumps(release_document(dsl_text), ensure_ascii=False, indent=2) + "\n",
                            encoding="utf-8", newline="\n")
    print(f"Built {len(document['workflow']['graph']['nodes'])} native nodes; release {RELEASE_ID}. Remote publication is separate.")


if __name__ == "__main__":
    main()
