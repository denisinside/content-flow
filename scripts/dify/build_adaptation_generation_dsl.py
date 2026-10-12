#!/usr/bin/env python3
"""Build the shared M4.2 channel workflow for Dify 1.17.1 / Graphon 0.7.0."""
from __future__ import annotations

import ast
import hashlib
import json
import re
from pathlib import Path

import yaml
import build_claim_extraction_dsl as base

ROOT = Path(__file__).resolve().parents[2]
DIRECTORY = ROOT / "packages/backend/src/editorial/workflows/adaptation-generation"
RUNTIME = ROOT / "scripts/dify/adaptation_generation_runtime.py"
RELEASE_ID = "adaptation-generation-2026-10-12.1"
PROMPT_VERSION = "adaptation-generation-v2"
TARGET = {"difyVersion": "1.17.1", "graphonVersion": "0.7.0", "dslVersion": "0.7.0"}
LIMITS = {"maxInputBytes": 350000, "maxTelegramTextUtf16": 4096, "maxOtherTextUtf16": 10000,
          "maxCoverTextUtf16": 200, "maxCoverInstructionChars": 2000, "maxParagraphs": 20,
          "maxSegments": 100, "maxRepairs": 1, "maxReviews": 2, "maxModelCalls": 4,
          "maxScriptFrames": 30, "maxScriptFrameTextUtf16": 3000, "maxScriptTextUtf16": 30000,
          "maxScriptMappings": 100, "maxScriptBytes": 200000,
          "maxScriptPurposeChars": 200, "maxScriptVisualHintChars": 1000,
          "maxScriptTransitionChars": 300, "maxOutputBytes": 360000,
          "maxStateBytes": 750000, "deadlineMs": 600000}


class AdaptationDumper(base.DifyDumper):
    def ignore_aliases(self, data):
        return True


def canonical(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def obj_schema(properties: dict, required: list[str] | None = None) -> dict:
    return {"type": "object", "additionalProperties": False, "properties": properties,
            "required": required if required is not None else list(properties)}


def string(maximum: int = 4096, minimum: int = 0) -> dict:
    return {"type": "string", "minLength": minimum, "maxLength": maximum}


def array(item: dict, maximum: int, minimum: int = 0) -> dict:
    # Describe the maximum for Gemini; the Code runtime enforces it without
    # native maxItems, matching the checked provider schema compatibility.
    return {"type": "array", "items": item, "minItems": minimum,
            "description": f"Return at most {maximum} items."}


def schemas() -> dict[str, dict]:
    segment = obj_schema({"text": string(10000, 1), "claimRevisionId": string(36), "evidenceId": string(36)})
    script_segment = obj_schema({"text": string(3000, 1), "claimRevisionId": string(36), "evidenceId": string(36)})
    paragraph = obj_schema({"field": {"type": "string", "enum": ["text", "cover"]},
                            "segments": array(segment, 100, 1)})
    script_frame = obj_schema({"id": string(36, 36), "purpose": string(200, 1),
        "segments": array(script_segment, 100, 1), "visualHint": string(1000, 1), "transition": string(300)})
    script = obj_schema({"frames": array(script_frame, 30, 1)})
    issue = obj_schema({"severity": {"type": "string", "enum": ["critical", "major", "minor"]},
        "category": string(60, 1), "paragraphId": string(50, 1), "quote": string(1000, 1),
        "instruction": string(1000, 1)})
    frame_replacement = obj_schema({"frameId": string(36, 36), "purpose": string(200, 1),
        "segments": array(script_segment, 100, 1), "visualHint": string(1000, 1), "transition": string(300)})
    return {
        "draft": obj_schema({"paragraphs": array(paragraph, 20, 1),
                             "coverInstruction": string(2000), "script": script}, ["paragraphs", "coverInstruction"]),
        "review": obj_schema({"status": {"type": "string", "enum": ["ready", "needs_human", "insufficient_evidence"]},
            "reasons": array(string(500, 1), 10), "issues": array(issue, 30)}),
        "patch": obj_schema({"replacements": array(obj_schema({"paragraphId": string(20, 1),
            "segments": array(segment, 100, 1)}), 20), "frameReplacements": array(frame_replacement, 30),
            "coverInstruction": string(2000)}),
    }


def prompts() -> dict[str, str]:
    raw = (DIRECTORY / "prompt.md").read_text(encoding="utf-8")
    parts = re.split(r"^# (.+)\n", raw, flags=re.MULTILINE)
    result = {parts[i]: parts[i + 1].strip() for i in range(1, len(parts), 2)}
    if set(result) != {"Shared rules", "Writer", "Reviewer", "Repairer"}:
        raise ValueError("Adaptation prompt roles do not match the workflow builder")
    return result


def embedded_runtime() -> str:
    source = RUNTIME.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(RUNTIME))
    guards = [statement for statement in tree.body
              if isinstance(statement, ast.If)
              and isinstance(statement.test, ast.Compare)
              and isinstance(statement.test.left, ast.Name)
              and statement.test.left.id == "__name__"
              and len(statement.test.ops) == 1
              and isinstance(statement.test.ops[0], ast.Eq)
              and len(statement.test.comparators) == 1
              and isinstance(statement.test.comparators[0], ast.Constant)
              and statement.test.comparators[0].value == "__main__"]
    if len(guards) != 1 or guards[0] is not tree.body[-1]:
        raise ValueError("Adaptation runtime must end with exactly one standalone CLI guard")
    lines = source.splitlines(keepends=True)
    guard = guards[0]
    del lines[guard.lineno - 1:guard.end_lineno]
    return "".join(lines)


class Builder:
    def __init__(self):
        self.document = base.build_baseline_document()
        self.document["app"].update(name="contentflow-adaptation-generation-v1",
            description="Shared Telegram, LinkedIn and Instagram caption/script candidate workflow with one bounded repair and deterministic evidence validation.")
        self.nodes: list[dict] = []
        self.edges: list[dict] = []
        self.types: dict[str, str] = {}
        self.roles = prompts()
        self.schemas = schemas()
        self.runtime = re.sub(r"^def main\(", "def runtime_main(", embedded_runtime(),
                              count=1, flags=re.MULTILINE)

    def node(self, ident: str, kind: str, data: dict, x: int, y: int,
             width: int = 300, height: int = 160) -> str:
        item = base.node(ident, kind, data, x, y, width=width, height=height)
        self.nodes.append(item)
        self.types[ident] = kind
        return ident

    def edge(self, source: str, target: str, handle: str = "source") -> None:
        item = base.edge(source, target, self.types[source], self.types[target])
        item.update(id=f"{source}-{handle}-{target}-target", sourceHandle=handle)
        self.edges.append(item)

    def code(self, ident: str, operation: str, title: str, inputs: dict[str, list[str]], x: int, y: int) -> str:
        parameters = ", ".join(inputs)
        payload = "{" + ", ".join(repr(key) + ": " + key for key in inputs) + "}"
        wrapper = f"\ndef main({parameters}):\n" + (
            "    payload = " + payload + "\n"
            "    result = json.loads(runtime_main(" + repr(operation) + ", json.dumps(payload, ensure_ascii=False)))[\"result\"]\n"
            "    def encode(value):\n"
            "        rendered = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))\n"
            "        if len(rendered.encode('utf-8')) > 750000:\n"
            "            raise ValueError('ADAPTATION_CODE_OUTPUT_LIMIT')\n"
            "        return rendered\n"
            "    return {\n"
            "        'state_json': encode(result['state']),\n"
            "        'request_json': encode(result.get('request', {})),\n"
            "        'repair_required': int(result.get('repair_required', 0)),\n"
            "        'status': result.get('status', result['state'].get('status', 'running')),\n"
            "        'adaptation_json': result.get('adaptation_json', ''),\n"
            "        'adaptation_report': result.get('adaptation_report', ''),\n"
            "    }\n")
        source = "import json\n" + wrapper + "\n" + self.runtime
        outputs = {key: {"type": "number" if key == "repair_required" else "string", "children": None}
                   for key in ("state_json", "request_json", "repair_required", "status",
                               "adaptation_json", "adaptation_report")}
        self.node(ident, "code", {"title": title, "code_language": "python3", "code": source,
            "variables": [{"variable": key, "value_selector": selector} for key, selector in inputs.items()],
            "outputs": outputs}, x, y)
        return ident

    def llm(self, ident: str, role: str, schema: str, request_node: str, x: int, y: int) -> str:
        system = self.roles["Shared rules"] + "\n\n" + self.roles[role]
        jinja = "<adaptation_request>\n{{ request_json }}\n</adaptation_request>"
        self.node(ident, "llm", {"title": role, "desc": "One structured editorial call; no tools or retries.",
            "model": {"provider": "langgenius/gemini/google", "name": "gemini-3.8-flash", "mode": "chat",
                      "completion_params": base.completion_params(8192)},
            "prompt_template": [
                {"id": ident + "-system", "role": "system", "edition_type": "basic", "text": system},
                {"id": ident + "-request", "role": "user", "edition_type": "jinja2", "text": jinja, "jinja2_text": jinja}],
            "prompt_config": {"jinja2_variables": [{"variable": "request_json",
                "value_selector": [request_node, "request_json"]}]},
            "context": {"enabled": False, "variable_selector": []}, "vision": {"enabled": False},
            "structured_output_enabled": True, "structured_output": {"schema": self.schemas[schema]},
            "retry_config": {"max_retries": 0, "retry_enabled": False, "retry_interval": 3000}}, x, y, width=360, height=200)
        return ident

    def condition(self, ident: str, title: str, selector: list[str], value: str, x: int, y: int,
                  *, number: bool = False) -> str:
        condition = {"id": ident + "-condition", "varType": "number" if number else "string",
            "variable_selector": selector, "comparison_operator": "=" if number else "is", "value": value}
        if number:
            condition["numberVarType"] = "constant"
        self.node(ident, "if-else", {"title": title, "cases": [{"case_id": "true", "logical_operator": "and",
            "conditions": [condition]}]}, x, y, width=280, height=120)
        return ident

    def build(self) -> dict:
        self.node("start", "start", {"title": "Заморожений контекст і формат каналу", "variables": [{
            "variable": "editorial_json", "label": "Frozen adaptation context (JSON)", "type": "paragraph",
            "required": True, "max_length": 500000, "options": []}]}, 80, 300, width=260, height=100)
        self.code("prepare", "prepare", "Перевірити формат і заморожений контекст", {
            "editorial_json": ["start", "editorial_json"]}, 430, 300)
        self.llm("writer", "Writer", "draft", "prepare", 820, 300)
        self.code("compile-draft", "draft", "Скомпілювати текст і evidence offsets", {
            "editorial_json": ["start", "editorial_json"], "state": ["prepare", "state_json"],
            "raw": ["writer", "text"]}, 1270, 300)
        self.condition("draft-ready", "Чернетка пройшла кодову перевірку?", ["compile-draft", "status"], "running", 1640, 300)
        self.code("blocked-draft-state", "review_request", "Повернути звіт без некоректної чернетки", {
            "editorial_json": ["start", "editorial_json"], "state": ["compile-draft", "state_json"]}, 2020, 520)
        self.code("review-request", "review_request", "Підготувати текст і cover до рев’ю", {
            "editorial_json": ["start", "editorial_json"], "state": ["compile-draft", "state_json"]}, 2020, 300)
        self.llm("reviewer", "Reviewer", "review", "review-request", 2410, 300)
        self.code("review-result", "review", "Перевірити адресні зауваження", {
            "editorial_json": ["start", "editorial_json"], "state": ["review-request", "state_json"],
            "raw": ["reviewer", "text"]}, 2860, 300)
        self.condition("repair-needed", "Потрібна єдина правка?", ["review-result", "repair_required"], "1", 3230, 300, number=True)
        self.code("select-reviewed-state", "review_request", "Зберегти результат без додаткової правки", {
            "editorial_json": ["start", "editorial_json"], "state": ["review-result", "state_json"]}, 3600, 480)
        self.llm("repairer", "Repairer", "patch", "review-result", 3600, 170)
        self.code("apply-repair", "patch", "Застосувати лише цільові заміни", {
            "editorial_json": ["start", "editorial_json"], "state": ["review-result", "state_json"],
            "raw": ["repairer", "text"]}, 4050, 170)
        self.code("review-request-2", "review_request", "Підготувати змінений результат до рев’ю", {
            "editorial_json": ["start", "editorial_json"], "state": ["apply-repair", "state_json"]}, 4440, 170)
        self.llm("reviewer-2", "Reviewer", "review", "review-request-2", 4830, 170)
        self.code("review-result-2", "review", "Перевірити актуальний результат", {
            "editorial_json": ["start", "editorial_json"], "state": ["review-request-2", "state_json"],
            "raw": ["reviewer-2", "text"]}, 5280, 170)
        self.node("merge-state", "variable-aggregator", {"title": "Єдиний перевірений стан", "output_type": "string",
            "variables": [["blocked-draft-state", "state_json"], ["select-reviewed-state", "state_json"], ["review-result-2", "state_json"]],
            "advanced_settings": {"group_enabled": False, "groups": []}}, 5700, 300, width=300, height=140)
        self.code("finalize", "finalize", "Детермінований фінальний guard і звіт", {
            "editorial_json": ["start", "editorial_json"], "state": ["merge-state", "output"]}, 6090, 300)
        self.node("end", "end", {"title": "Повернути unapproved adaptation/report", "outputs": [
            {"variable": "adaptation_json", "value_type": "string", "value_selector": ["finalize", "adaptation_json"]},
            {"variable": "adaptation_report", "value_type": "string", "value_selector": ["finalize", "adaptation_report"]}]},
            6480, 300, width=280, height=110)

        for source, target in [("start", "prepare"), ("prepare", "writer"), ("writer", "compile-draft"),
            ("review-request", "reviewer"), ("reviewer", "review-result"),
            ("review-result", "repair-needed"), ("repairer", "apply-repair"), ("apply-repair", "review-request-2"),
            ("review-request-2", "reviewer-2"), ("reviewer-2", "review-result-2"),
            ("review-result-2", "merge-state"), ("merge-state", "finalize"), ("finalize", "end")]:
            self.edge(source, target)
        self.edge("compile-draft", "draft-ready")
        self.edge("draft-ready", "blocked-draft-state", "false")
        self.edge("blocked-draft-state", "merge-state")
        self.edge("draft-ready", "review-request", "true")
        self.edge("repair-needed", "repairer", "true")
        self.edge("repair-needed", "select-reviewed-state", "false")
        self.edge("select-reviewed-state", "merge-state")

        self.document["workflow"]["graph"] = {"nodes": self.nodes, "edges": self.edges,
            "viewport": {"x": 0, "y": 100, "zoom": 0.42}}
        return self.document


def build_document() -> dict:
    return Builder().build()


def main() -> None:
    document = build_document()
    output = DIRECTORY / "adaptation-generation-v1.yml"
    output.write_text(yaml.dump(document, Dumper=AdaptationDumper, allow_unicode=True,
        sort_keys=True, width=1000, default_flow_style=False), encoding="utf-8", newline="\n")
    release = {"schemaVersion": "contextflow-dify-release-v1", "operation": "ADAPTATION_GENERATION",
        "releaseId": RELEASE_ID, "contractVersion": "adaptation-v1", "promptTemplateVersion": PROMPT_VERSION,
        "promptTemplateFile": "prompt.md", "promptSha256": hashlib.sha256((DIRECTORY / "prompt.md").read_bytes()).hexdigest(),
        "workflowDslFile": output.name, "workflowDslSha256": hashlib.sha256(output.read_bytes()).hexdigest(),
        "runtimeFile": "scripts/dify/adaptation_generation_runtime.py",
        "runtimeSha256": hashlib.sha256(RUNTIME.read_bytes()).hexdigest(), "target": TARGET,
        "adaptationLimits": LIMITS, "reportSchemaVersion": "adaptation-editorial-report-v1",
        "apiBaseEnv": "DIFY_API_BASE_URL", "apiKeyEnv": "DIFY_ADAPTATION_API_KEY",
        "publishedWorkflowIdEnv": "DIFY_ADAPTATION_WORKFLOW_ID",
        "configDigestEnv": "DIFY_ADAPTATION_CONFIG_SHA256", "inputVariable": "editorial_json",
        "outputVariable": "adaptation_json", "reportVariable": "adaptation_report",
        "responseMode": "streaming", "provider": "dify",
        "model": {"provider": "langgenius/gemini/google", "name": "gemini-3.8-flash", "mode": "chat",
                  "completionParams": base.completion_params(8192)}}
    release["configDigest"] = hashlib.sha256(canonical(release).encode("utf-8")).hexdigest()
    (DIRECTORY / "release.json").write_text(json.dumps(release, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Built {len(document['workflow']['graph']['nodes'])} native nodes; release {RELEASE_ID}. Remote publication is separate.")


if __name__ == "__main__":
    main()
