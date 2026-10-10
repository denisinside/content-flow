#!/usr/bin/env python3
"""Static checks for an exported Dify app/workflow DSL.

This validator never installs packages and never runs workflow code. It checks
the graph and Python/Jinja syntax, and can optionally validate node data against
an explicitly selected, already-installed Graphon release.
"""

from __future__ import annotations

import argparse
import ast
import copy
import importlib
import importlib.metadata
import json
import pkgutil
import re
import sys
from collections.abc import Mapping
from collections import defaultdict
from pathlib import Path
from typing import Any


MAX_INPUT_BYTES = 10 * 1024 * 1024
DSL_VERSION_RE = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
GRAPHON_VERSION_ALLOWLIST = {"0.7.0"}
# This optional editor profile is transcribed from the sibling admin-panel
# reference. It is scoped to the Dify 2.x / Graphon 0.7.0 profile documented
# there; the target ContentFlow Dify installation has not been inspected here.
EDITOR_PROFILES = {"admin-panel-reference": "0.7.0"}
POOLS = {"env", "sys", "conversation"}
VARIABLE_REF_RE = re.compile(r"\{\{#([^#{}\s]+)#\}\}")
# Version-matched to graphon.variables.template_resolution in Graphon 0.7.0.
# Node IDs containing hyphens are legal selectors, but basic prompt templates
# leave their native placeholder syntax literal instead of resolving it.
GRAPHON_070_NATIVE_REF_RE = re.compile(
    r"\{\{#([a-zA-Z0-9_]{1,50}(?:\.[a-zA-Z_][a-zA-Z0-9_]{0,29}){1,10})#\}\}"
)


class InputError(Exception):
    """The input cannot be checked (usage, parser, or dependency issue)."""


class DuplicateKeyError(ValueError):
    """A JSON/YAML mapping repeats a key and would otherwise be ambiguous."""


def _unique_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise DuplicateKeyError(f"duplicate mapping key {key!r}")
        value[key] = item
    return value


def _load_yaml(raw: str) -> Any:
    import yaml

    class NoAliasSafeLoader(yaml.SafeLoader):
        def compose_node(self, parent: Any, index: Any) -> Any:
            if self.check_event(yaml.AliasEvent):
                raise yaml.constructor.ConstructorError(
                    None, None, "YAML aliases are not accepted by this bounded validator", self.peek_event().start_mark
                )
            return super().compose_node(parent, index)

    def construct_unique_mapping(loader: Any, node: Any, deep: bool = False) -> dict[Any, Any]:
        loader.flatten_mapping(node)
        value: dict[Any, Any] = {}
        for key_node, value_node in node.value:
            key = loader.construct_object(key_node, deep=deep)
            try:
                duplicate = key in value
            except TypeError as exc:
                raise yaml.constructor.ConstructorError(
                    "while constructing a mapping", node.start_mark,
                    "unhashable mapping key", key_node.start_mark,
                ) from exc
            if duplicate:
                raise yaml.constructor.ConstructorError(
                    "while constructing a mapping", node.start_mark,
                    f"duplicate mapping key {key!r}", key_node.start_mark,
                )
            value[key] = loader.construct_object(value_node, deep=deep)
        return value

    NoAliasSafeLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, construct_unique_mapping)
    return yaml.load(raw, Loader=NoAliasSafeLoader)


def is_contentflow_release_descriptor(value: Any) -> bool:
    return isinstance(value, dict) and value.get("schemaVersion") == "contextflow-dify-release-v1"


def load_document(path: Path) -> Any:
    try:
        size = path.stat().st_size
    except OSError as exc:
        raise InputError(f"Cannot read {path}: {exc}") from exc
    if size > MAX_INPUT_BYTES:
        raise InputError(f"Input is larger than {MAX_INPUT_BYTES} bytes; refusing to parse it.")
    try:
        raw = path.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeError) as exc:
        raise InputError(f"Cannot read UTF-8 input {path}: {exc}") from exc

    # JSON is a YAML subset, and this fallback keeps the synthetic fixture and
    # JSON-form DSL usable with the standard library alone.
    try:
        return json.loads(raw, object_pairs_hook=_unique_json_object)
    except DuplicateKeyError as exc:
        raise InputError(f"Invalid document: {exc}.") from exc
    except json.JSONDecodeError:
        pass

    try:
        import yaml
    except ImportError as exc:
        raise InputError(
            "This file is YAML, but PyYAML is not installed. The validator does not install it. "
            "Install an audited, pinned PyYAML dependency yourself, or provide a JSON-form DSL."
        ) from exc

    try:
        return _load_yaml(raw)
    except Exception as exc:  # PyYAML exposes several parser exception types.
        raise InputError(f"Invalid or unsupported YAML: {exc}") from exc


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _title(node: dict[str, Any]) -> str:
    data = node.get("data")
    if isinstance(data, dict) and data.get("title"):
        return str(data["title"])
    return str(node.get("id", "<unnamed>"))


def _node_type(node: dict[str, Any]) -> str | None:
    data = node.get("data")
    value = data.get("type") if isinstance(data, dict) else None
    return value if isinstance(value, str) and value else None


def _llm_prompts(data: dict[str, Any]) -> list[Any]:
    prompts = data.get("prompt_template")
    return [prompts] if isinstance(prompts, dict) else _as_list(prompts)


def _validate_llm_prompts(node: dict[str, Any], errors: list[str], warnings: list[str]) -> None:
    data = node["data"]
    prompts = _llm_prompts(data)
    if not prompts:
        errors.append(f"[{_title(node)}] LLM needs a non-empty prompt_template.")
        return
    config = data.get("prompt_config")
    if config is not None and not isinstance(config, dict):
        errors.append(f"[{_title(node)}] LLM prompt_config must be an object.")
        config = {}
    bindings = (config or {}).get("jinja2_variables", [])
    if bindings is None:
        bindings = []  # Graphon 0.7.0 normalizes null to an empty binding list.
    if not isinstance(bindings, list):
        errors.append(f"[{_title(node)}] LLM jinja2_variables must be an array.")
        bindings = []
    names: set[str] = set()
    for binding in bindings:
        if not isinstance(binding, dict):
            errors.append(f"[{_title(node)}] LLM Jinja binding must be an object.")
            continue
        name = binding.get("variable")
        if not isinstance(name, str) or not name.isidentifier():
            errors.append(f"[{_title(node)}] LLM Jinja binding has an invalid variable name {name!r}.")
        elif name in names:
            errors.append(f"[{_title(node)}] Duplicate LLM Jinja binding {name!r}.")
        else:
            names.add(name)
        if not isinstance(binding.get("value_selector"), list) or not binding["value_selector"]:
            errors.append(f"[{_title(node)}] LLM Jinja binding {name!r} needs a non-empty value_selector.")
        # Non-empty selectors use the shared shape, source and ancestry checks.
    for index, prompt in enumerate(prompts):
        if not isinstance(prompt, dict):
            errors.append(f"[{_title(node)}] LLM prompt at index {index} must be an object.")
            continue
        edition = prompt.get("edition_type")
        if edition not in (None, "basic", "jinja2"):
            errors.append(f"[{_title(node)}] Unsupported LLM prompt edition_type {edition!r}.")
            continue
        if edition == "jinja2":
            source = prompt.get("jinja2_text")
            if not isinstance(source, str) or not source.strip():
                errors.append(f"[{_title(node)}] LLM Jinja prompt needs non-empty jinja2_text; Graphon does not render text as a fallback.")
                continue
            try:
                from jinja2 import Environment, meta  # type: ignore[import-not-found]
            except ImportError:
                warnings.append("Jinja2 is not installed; LLM Jinja syntax and bindings were not checked. No package was installed.")
            else:
                try:
                    parsed = Environment().parse(source)
                    missing = meta.find_undeclared_variables(parsed) - names
                    if missing:
                        errors.append(f"[{_title(node)}] LLM prompt uses undeclared Jinja variables: {sorted(missing)!r}.")
                except Exception as exc:
                    errors.append(f"[{_title(node)}] LLM Jinja syntax error: {exc}.")
            continue
        source = prompt.get("text", "")
        if not isinstance(source, str):
            errors.append(f"[{_title(node)}] Basic LLM prompt text must be a string.")
            continue
        for start in re.finditer(r"\{\{#", source):
            end = source.find("}}", start.end())
            token = source[start.start():end + 2] if end >= 0 else source[start.start():]
            if token != "{{#context#}}" and not GRAPHON_070_NATIVE_REF_RE.fullmatch(token):
                errors.append(
                    f"[{_title(node)}] Basic LLM placeholder {token[:160]!r} is not resolvable by Graphon 0.7.0; "
                    "use alphanumeric/underscore node IDs or an explicit Jinja binding."
                )


def _collect_selectors(nodes: list[dict[str, Any]]) -> list[tuple[dict[str, Any], list[Any]]]:
    found: list[tuple[dict[str, Any], list[Any]]] = []

    def add(node: dict[str, Any], value: Any) -> None:
        if isinstance(value, list):
            found.append((node, value))

    for node in nodes:
        data = node.get("data")
        if not isinstance(data, dict):
            continue
        if data.get("type") == "llm":
            config = data.get("prompt_config")
            if isinstance(config, dict):
                for binding in _as_list(config.get("jinja2_variables")):
                    if isinstance(binding, dict):
                        add(node, binding.get("value_selector"))
            for prompt in _llm_prompts(data):
                if isinstance(prompt, dict) and prompt.get("edition_type") != "jinja2":
                    source = prompt.get("text")
                    if isinstance(source, str):
                        for token in GRAPHON_070_NATIVE_REF_RE.findall(source):
                            add(node, token.split("."))
        for item in _as_list(data.get("variables")):
            if isinstance(item, dict):
                add(node, item.get("value_selector"))
            elif isinstance(item, list):
                add(node, item)
        if data.get("type") == "end":
            for output in _as_list(data.get("outputs")):
                if isinstance(output, dict):
                    add(node, output.get("value_selector"))
        for case in _as_list(data.get("cases")):
            if not isinstance(case, dict):
                continue
            for condition in _as_list(case.get("conditions")):
                if isinstance(condition, dict):
                    add(node, condition.get("variable_selector"))
        if data.get("type") == "loop":
            for item in _as_list(data.get("loop_variables")):
                if isinstance(item, dict) and item.get("value_type") == "variable":
                    add(node, item.get("value"))
            for condition in _as_list(data.get("break_conditions")):
                if isinstance(condition, dict):
                    add(node, condition.get("variable_selector"))
        if data.get("type") == "assigner":
            for item in _as_list(data.get("items")):
                if not isinstance(item, dict):
                    continue
                add(node, item.get("variable_selector"))
                if item.get("input_type") == "variable":
                    add(node, item.get("value"))
        for key in ("iterator_selector", "output_selector"):
            add(node, data.get(key))
        if data.get("type") == "list-operator":
            add(node, data.get("variable"))
        for item in _as_list(data.get("inputs")):
            if not isinstance(item, dict):
                continue
            default = item.get("default")
            if isinstance(default, dict) and default.get("type") == "variable":
                add(node, default.get("selector"))
            source = item.get("option_source")
            if isinstance(source, dict) and source.get("type") == "variable":
                add(node, source.get("selector"))
    return found


def _strings(value: Any, visited: set[int] | None = None):
    """Yield strings in a JSON/YAML tree without recursing forever on aliases."""
    seen = visited if visited is not None else set()
    if isinstance(value, str):
        yield value
        return
    if isinstance(value, (dict, list)):
        identity = id(value)
        if identity in seen:
            return
        seen.add(identity)
        if isinstance(value, dict):
            for key, item in value.items():
                yield from _strings(key, seen)
                yield from _strings(item, seen)
        else:
            for item in value:
                yield from _strings(item, seen)


def _main_function(tree: ast.Module) -> ast.FunctionDef | ast.AsyncFunctionDef | None:
    for statement in tree.body:
        if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)) and statement.name == "main":
            return statement
    return None


def _return_keys(function: ast.FunctionDef | ast.AsyncFunctionDef) -> tuple[set[str], bool]:
    keys: set[str] = set()
    dynamic = False

    class Returns(ast.NodeVisitor):
        def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
            if node is function:
                for child in node.body:
                    self.visit(child)

        def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
            if node is function:
                for child in node.body:
                    self.visit(child)

        def visit_Lambda(self, node: ast.Lambda) -> None:
            return

        def visit_Return(self, node: ast.Return) -> None:
            nonlocal dynamic
            value = node.value
            if isinstance(value, ast.Dict):
                for key in value.keys:
                    if isinstance(key, ast.Constant) and isinstance(key.value, str):
                        keys.add(key.value)
                    else:
                        dynamic = True
            elif isinstance(value, ast.Call) and isinstance(value.func, ast.Name) and value.func.id == "dict":
                dynamic = dynamic or bool(value.args)
                for item in value.keywords:
                    if item.arg:
                        keys.add(item.arg)
                    else:
                        dynamic = True
            elif value is not None:
                dynamic = True

    Returns().visit(function)
    return keys, dynamic


def _graphon_mapping(version: str) -> tuple[dict[str, Any], list[str]]:
    if version not in GRAPHON_VERSION_ALLOWLIST:
        allowed = ", ".join(sorted(GRAPHON_VERSION_ALLOWLIST))
        raise InputError(f"Graphon {version!r} is not allowlisted. Reviewed versions: {allowed}.")
    try:
        installed = importlib.metadata.version("graphon")
    except importlib.metadata.PackageNotFoundError as exc:
        raise InputError(
            f"Graphon {version} was requested but is not installed. No package was installed. "
            "Installing Graphon uses the network and adds third-party executable code; review and pin it separately."
        ) from exc
    if installed != version:
        raise InputError(f"Requested Graphon {version}, but installed Graphon is {installed}.")

    # This opt-in import executes code from the already-installed package. It is
    # never reached during structural checks unless --graphon-version is passed.
    package = importlib.import_module("graphon.nodes")
    missing: list[str] = []
    for module in pkgutil.walk_packages(package.__path__, prefix="graphon.nodes."):
        try:
            importlib.import_module(module.name)
        except Exception as exc:
            missing.append(f"{module.name} ({type(exc).__name__}: {exc})")
    base = importlib.import_module("graphon.nodes.base.node")
    return base.Node.get_node_type_classes_mapping(), missing


def validate_document(
    document: Any,
    *,
    graphon_mapping: dict[str, Any] | None = None,
    graphon_import_warnings: list[str] | None = None,
    profile: str | None = None,
    strict_node_types: bool = False,
) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []

    if is_contentflow_release_descriptor(document):
        errors.append(
            "This is ContentFlow API release metadata, not a Dify workflow DSL. "
            "Use an exported Dify workflow YAML; verify release.json with scripts/dify/verify_release.mjs."
        )
        return errors, warnings
    if not isinstance(document, dict):
        return ["DSL root must be a mapping/object."], warnings

    version = document.get("version")
    if not isinstance(version, str) or not DSL_VERSION_RE.fullmatch(version):
        errors.append("DSL `version` must be a quoted numeric x.y.z version (for example `0.7.0`).")
    if "kind" in document:
        kind = document.get("kind")
        if not isinstance(kind, str) or kind not in {"app", "workflow"}:
            errors.append("Unsupported DSL `kind`; this validator accepts Dify app/workflow exports.")

    workflow = document.get("workflow")
    if not isinstance(workflow, dict):
        return errors + ["Missing `workflow` object."], warnings
    graph = workflow.get("graph")
    if not isinstance(graph, dict):
        return errors + ["Missing `workflow.graph` object."], warnings
    raw_nodes, raw_edges = graph.get("nodes"), graph.get("edges")
    if not isinstance(raw_nodes, list) or not isinstance(raw_edges, list):
        return errors + ["`workflow.graph.nodes` and `workflow.graph.edges` must be arrays."], warnings

    nodes: list[dict[str, Any]] = []
    for index, node in enumerate(raw_nodes):
        if not isinstance(node, dict):
            errors.append(f"Node at index {index} must be an object.")
            continue
        nodes.append(node)
        if not isinstance(node.get("id"), str) or not node["id"].strip():
            errors.append(f"Node at index {index} needs a non-empty string `id`.")
        if not isinstance(node.get("data"), dict):
            errors.append(f"Node at index {index} needs an object `data`.")
        elif not isinstance(node["data"].get("type"), str) or not node["data"]["type"].strip():
            errors.append(f"Node {_title(node)!r} needs a non-empty `data.type`.")

    ids: dict[str, dict[str, Any]] = {}
    for node in nodes:
        node_id = node.get("id")
        if not isinstance(node_id, str) or not node_id.strip():
            continue
        if node_id in ids:
            errors.append(f"Duplicate node id {node_id!r} ({_title(ids[node_id])!r} and {_title(node)!r}).")
        else:
            ids[node_id] = node

    edge_ids: set[str] = set()
    parents: dict[str, set[str]] = defaultdict(set)
    valid_edges: list[dict[str, Any]] = []
    for index, edge in enumerate(raw_edges):
        if not isinstance(edge, dict):
            errors.append(f"Edge at index {index} must be an object.")
            continue
        edge_id = edge.get("id")
        if not isinstance(edge_id, str) or not edge_id.strip():
            errors.append(f"Edge at index {index} needs a non-empty string `id`.")
        elif edge_id in edge_ids:
            errors.append(f"Duplicate edge id {edge_id!r}.")
        else:
            edge_ids.add(edge_id)
        source, target = edge.get("source"), edge.get("target")
        if not isinstance(source, str) or source not in ids:
            errors.append(f"Edge {edge_id or index!r} points to missing source node {source!r}.")
        if not isinstance(target, str) or target not in ids:
            errors.append(f"Edge {edge_id or index!r} points to missing target node {target!r}.")
        if isinstance(edge.get("sourceHandle"), str) and not edge["sourceHandle"]:
            errors.append(f"Edge {edge_id or index!r} has an empty `sourceHandle`.")
        if isinstance(source, str) and source in ids and isinstance(target, str) and target in ids:
            valid_edges.append(edge)
            parents[target].add(source)
            data = edge.get("data")
            if isinstance(data, dict):
                source_type = _node_type(ids[source])
                target_type = _node_type(ids[target])
                if data.get("sourceType") not in (None, source_type):
                    warnings.append(f"Edge {edge_id or index!r}: `data.sourceType` differs from its source node.")
                if data.get("targetType") not in (None, target_type):
                    warnings.append(f"Edge {edge_id or index!r}: `data.targetType` differs from its target node.")

    # Check nested canvas references and cycles in parentId independently of edges.
    enclosing: dict[str, str] = {}
    for node in nodes:
        node_id = node.get("id")
        if not isinstance(node_id, str) or node_id not in ids:
            continue
        parent_id = node.get("parentId")
        if parent_id is None:
            continue
        if not isinstance(parent_id, str) or parent_id not in ids:
            errors.append(f"Node {_title(node)!r} has missing or invalid `parentId` {parent_id!r}.")
        elif parent_id == node_id:
            errors.append(f"Node {_title(node)!r} cannot parent itself.")
        else:
            enclosing[node_id] = parent_id
    for node_id in enclosing:
        seen: set[str] = set()
        current: str | None = node_id
        while current in enclosing:
            if current in seen:
                errors.append(f"Cycle in `parentId` hierarchy includes node {current!r}.")
                break
            seen.add(current)
            current = enclosing[current]

    ancestry_cache: dict[str, set[str]] = {}

    def ancestors(node_id: str) -> set[str]:
        if node_id in ancestry_cache:
            return ancestry_cache[node_id]
        found: set[str] = set()
        stack = list(parents.get(node_id, ()))
        box = enclosing.get(node_id)
        if box:
            stack.append(box)
        while stack:
            candidate = stack.pop()
            if candidate in found:
                continue
            found.add(candidate)
            stack.extend(parents.get(candidate, ()))
            parent = enclosing.get(candidate)
            if parent:
                stack.append(parent)
        ancestry_cache[node_id] = found
        return found

    env_names: set[str] = set()
    environment = workflow.get("environment_variables", [])
    if environment is not None and not isinstance(environment, list):
        errors.append("`workflow.environment_variables` must be an array when present.")
        environment = []
    for item in environment or []:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str) or not item["name"].strip():
            errors.append("Every environment variable needs a non-empty string `name`.")
        elif item["name"] in env_names:
            errors.append(f"Duplicate environment variable name {item['name']!r}.")
        else:
            env_names.add(item["name"])

    for node, selector in _collect_selectors(nodes):
        if not selector:
            warnings.append(f"Node {_title(node)!r} has an empty variable selector; check whether it is intentional.")
            continue
        if len(selector) < 2 or any(not isinstance(part, str) or not part for part in selector):
            errors.append(f"Node {_title(node)!r} has a malformed selector; expected non-empty string path parts: {selector!r}.")
            continue
        head = selector[0]
        if head in POOLS:
            if head == "env" and selector[1] not in env_names:
                errors.append(f"Node {_title(node)!r} selects undeclared `env.{selector[1]}`.")
            continue
        if head not in ids:
            errors.append(f"Node {_title(node)!r} selects missing node {head!r}.")
        elif head != node.get("id") and head not in ancestors(str(node.get("id", ""))):
            errors.append(f"Node {_title(node)!r} selects {_title(ids[head])!r}, which is not an upstream ancestor.")

    for node in nodes:
        data = node.get("data")
        if not isinstance(data, dict):
            continue
        if data.get("type") == "llm":
            _validate_llm_prompts(node, errors, warnings)
            # Jinja prompts do not interpret basic/native placeholders. Basic
            # prompt selectors were collected above using the actual regex.
            reference_data = {key: value for key, value in data.items() if key != "prompt_template"}
        else:
            reference_data = data
        for value in _strings(reference_data):
            for token in set(VARIABLE_REF_RE.findall(value)):
                parts = token.split(".")
                if len(parts) < 2:
                    continue
                head, field = parts[0], parts[1]
                if head == "$output":
                    continue
                if head in POOLS:
                    if head == "env" and field not in env_names:
                        errors.append(f"[{_title(node)}] template reference `{{{{#{token}#}}}}` uses undeclared `env.{field}`.")
                    continue
                if head not in ids:
                    errors.append(f"[{_title(node)}] template reference `{{{{#{token}#}}}}` points to a missing node.")
                elif head != node.get("id") and head not in ancestors(str(node.get("id", ""))):
                    errors.append(f"[{_title(node)}] template reference `{{{{#{token}#}}}}` uses a node that is not an upstream ancestor.")
                if len(parts) > 2:
                    warnings.append(
                        f"Template reference `{{{{#{token}#}}}}` uses a nested field path; "
                        "static validation cannot confirm runtime output shape."
                    )

    if profile is not None:
        expected_graphon = EDITOR_PROFILES[profile]
        if graphon_mapping is not None and expected_graphon not in GRAPHON_VERSION_ALLOWLIST:
            errors.append(f"Editor profile {profile!r} has no reviewed Graphon pin.")
        for node in nodes:
            node_type = _node_type(node)
            if not node_type:
                continue
            expected_envelope = {
                "iteration-start": "custom-iteration-start",
                "loop-start": "custom-loop-start",
            }.get(node_type, "custom")
            if node.get("type") != expected_envelope:
                errors.append(
                    f"[{_title(node)}] editor profile expects envelope type {expected_envelope!r}, "
                    f"found {node.get('type')!r}."
                )

        handles_by_node: dict[str, set[str]] = {}
        for node in nodes:
            node_id = node.get("id")
            node_type = _node_type(node)
            data = node.get("data") if isinstance(node.get("data"), dict) else {}
            handles = {"source"}
            if node_type == "if-else":
                handles = {str(case.get("case_id")) for case in _as_list(data.get("cases")) if isinstance(case, dict)} | {"false"}
            elif node_type == "question-classifier":
                handles = {str(item.get("id")) for item in _as_list(data.get("classes")) if isinstance(item, dict)}
            elif node_type == "human-input":
                handles = {str(item.get("id")) for item in _as_list(data.get("user_actions")) if isinstance(item, dict)} | {"__timeout"}
            if data.get("error_strategy") == "fail-branch":
                handles.add("fail-branch")
            if isinstance(node_id, str):
                handles_by_node[node_id] = handles
        for edge in valid_edges:
            source = edge.get("source")
            source_handle = edge.get("sourceHandle") or "source"
            if source in handles_by_node and source_handle not in handles_by_node[source]:
                errors.append(
                    f"Edge {edge.get('id')!r} uses unknown source handle {source_handle!r} "
                    f"on node {_title(ids[source])!r}."
                )
        for node in nodes:
            data = node.get("data") if isinstance(node.get("data"), dict) else {}
            if data.get("error_strategy") == "fail-branch":
                node_id = node.get("id")
                if isinstance(node_id, str) and not any(
                    edge.get("source") == node_id and (edge.get("sourceHandle") or "source") == "fail-branch"
                    for edge in valid_edges
                ):
                    errors.append(f"[{_title(node)}] `fail-branch` has no outgoing edge in this editor profile.")

        end_outputs: dict[str, list[str]] = defaultdict(list)
        for node in nodes:
            if _node_type(node) != "end":
                continue
            data = node.get("data") if isinstance(node.get("data"), dict) else {}
            for output in _as_list(data.get("outputs")):
                if not isinstance(output, dict):
                    continue
                name = output.get("variable")
                if isinstance(name, str) and name.strip():
                    end_outputs[name].append(_title(node))
                else:
                    errors.append(f"[{_title(node)}] Output entry has no variable name.")
                if not output.get("value_selector"):
                    errors.append(f"[{_title(node)}] Output entry {name!r} has no value selector.")
        for name, owners in end_outputs.items():
            if len(owners) > 1:
                errors.append(f"Output variable {name!r} is declared by multiple End nodes: {', '.join(owners)}.")

    if graphon_mapping is None:
        warnings.append("Graphon node-data schemas were not checked; pass --graphon-version with an installed, allowlisted version.")
    else:
        warnings.extend(f"Graphon module could not be imported: {item}" for item in (graphon_import_warnings or []))
        for node in nodes:
            node_type = _node_type(node)
            data = node.get("data") if isinstance(node.get("data"), dict) else None
            if not node_type or data is None:
                continue
            versions = graphon_mapping.get(node_type)
            if not versions:
                message = f"Node type {node_type!r} is not in the selected Graphon registry; it may be Dify-side or plugin-provided."
                (errors if strict_node_types else warnings).append(message)
                continue
            if isinstance(versions, Mapping):
                model = versions.get("latest") or versions.get("1") or next(iter(versions.values()), None)
            else:
                model = versions
            if model is None:
                warnings.append(f"No Graphon schema model is available for node type {node_type!r}.")
                continue
            try:
                model.validate_node_data(data)
            except Exception as exc:
                errors.append(f"[{_title(node)}] Graphon schema rejected node type {node_type!r}: {exc}")

    for node in nodes:
        data = node.get("data") if isinstance(node.get("data"), dict) else {}
        node_type = data.get("type")
        if node_type == "code":
            language = data.get("code_language", "python3")
            if language != "python3":
                warnings.append(f"[{_title(node)}] code language {language!r} is not parsed by this Python-only check.")
                continue
            source = data.get("code")
            if not isinstance(source, str):
                errors.append(f"[{_title(node)}] Python code node must contain string `code`.")
                continue
            try:
                tree = ast.parse(source)
            except SyntaxError as exc:
                errors.append(f"[{_title(node)}] Python syntax error at line {exc.lineno}: {exc.msg}.")
                continue
            main = _main_function(tree)
            if main is None:
                errors.append(f"[{_title(node)}] Python code node has no top-level `main()` function.")
                continue
            variables = {
                item.get("variable") for item in _as_list(data.get("variables"))
                if isinstance(item, dict) and isinstance(item.get("variable"), str)
            }
            if main.args.posonlyargs:
                errors.append(f"[{_title(node)}] `main()` uses positional-only arguments, which cannot be passed by variable name.")
            if main.args.vararg or main.args.kwarg:
                errors.append(f"[{_title(node)}] `main()` uses *args or **kwargs; declare explicit input variables instead.")
            args = {arg.arg for arg in [*main.args.args, *main.args.kwonlyargs]}
            if args != variables:
                errors.append(
                    f"[{_title(node)}] main() arguments {sorted(args)!r} do not match declared variables {sorted(variables)!r}."
                )
            outputs = data.get("outputs")
            if outputs is not None and not isinstance(outputs, dict):
                warnings.append(f"[{_title(node)}] outputs are not an object; static return-key comparison was skipped.")
            elif isinstance(outputs, dict):
                returned, dynamic = _return_keys(main)
                if dynamic:
                    warnings.append(f"[{_title(node)}] main() has dynamic return values; output keys cannot be checked statically.")
                else:
                    missing = set(outputs) - returned
                    extra = returned - set(outputs)
                    if missing:
                        errors.append(f"[{_title(node)}] declared outputs never appear in a literal return: {sorted(missing)!r}.")
                    if extra:
                        errors.append(f"[{_title(node)}] literal return keys are undeclared outputs: {sorted(extra)!r}.")
        elif node_type == "template-transform":
            template = data.get("template")
            if not isinstance(template, str):
                errors.append(f"[{_title(node)}] template-transform needs string `template`.")
                continue
            try:
                from jinja2 import Environment  # type: ignore[import-not-found]
            except ImportError:
                warnings.append("Jinja2 is not installed; template syntax was not checked. No package was installed.")
            else:
                try:
                    Environment().parse(template)
                except Exception as exc:
                    errors.append(f"[{_title(node)}] Jinja syntax error: {exc}.")

    if profile:
        warnings.append(
            "Editor profile checks use rules documented by the admin-panel reference for Dify 2.x / Graphon 0.7.0; "
            "confirm that profile against the target Dify server before relying on it."
        )
    return errors, warnings


def run_self_test() -> int:
    fixture = Path(__file__).resolve().parent / "fixtures" / "minimal_valid_dsl.yaml"
    try:
        base = load_document(fixture)
    except InputError as exc:
        print(f"SELF-TEST FAILED: {exc}")
        return 1

    checks = [
        ("synthetic graph accepted", lambda d: len(validate_document(d)[0]) == 0),
    ]
    for name, predicate in checks:
        if not predicate(copy.deepcopy(base)):
            print(f"SELF-TEST FAILED: {name}")
            return 1

    try:
        json.loads('{"workflow": {}, "workflow": {}}', object_pairs_hook=_unique_json_object)
    except DuplicateKeyError:
        pass
    else:
        print("SELF-TEST FAILED: duplicate JSON mapping key was accepted")
        return 1

    yaml_duplicate_check = "skipped (PyYAML not installed)"
    try:
        import yaml  # noqa: F401
    except ImportError:
        pass
    else:
        try:
            _load_yaml("workflow: {}\nworkflow: {}\n")
        except Exception as exc:
            if "duplicate mapping key" not in str(exc):
                print(f"SELF-TEST FAILED: YAML duplicate-key rejection returned an unexpected error: {exc}")
                return 1
            yaml_duplicate_check = "passed"
        else:
            print("SELF-TEST FAILED: duplicate YAML mapping key was accepted")
            return 1

    jinja_check = "skipped (Jinja2 not installed)"
    try:
        import jinja2  # noqa: F401
    except ImportError:
        pass
    else:
        invalid_template = copy.deepcopy(base)
        invalid_template["workflow"]["graph"]["nodes"][2]["data"]["template"] = "{% if %}"
        if not any("Jinja syntax error" in item for item in validate_document(invalid_template)[0]):
            print("SELF-TEST FAILED: invalid Jinja syntax was not caught")
            return 1
        jinja_check = "passed"

    duplicate = copy.deepcopy(base)
    duplicate["workflow"]["graph"]["nodes"][1]["id"] = "start"
    if not any("Duplicate node id" in item for item in validate_document(duplicate)[0]):
        print("SELF-TEST FAILED: duplicate node id was not caught")
        return 1

    dangling = copy.deepcopy(base)
    dangling["workflow"]["graph"]["edges"][0]["target"] = "missing-node"
    if not any("missing target node" in item for item in validate_document(dangling)[0]):
        print("SELF-TEST FAILED: dangling edge was not caught")
        return 1

    bad_code = copy.deepcopy(base)
    bad_code["workflow"]["graph"]["nodes"][1]["data"]["code"] = "def main(:\n    return {}\n"
    if not any("Python syntax error" in item for item in validate_document(bad_code)[0]):
        print("SELF-TEST FAILED: invalid Python syntax was not caught")
        return 1

    non_ancestor = copy.deepcopy(base)
    graph_nodes = non_ancestor["workflow"]["graph"]["nodes"]
    graph_nodes.append({"id": "orphan", "type": "custom", "data": {"type": "answer"}})
    graph_nodes[-2]["data"]["variables"] = [{"variable": "x", "value_selector": ["orphan", "text"]}]
    if not any("not an upstream ancestor" in item for item in validate_document(non_ancestor)[0]):
        print("SELF-TEST FAILED: non-ancestor selector was not caught")
        return 1

    native_loop = copy.deepcopy(base)
    native_loop["workflow"]["graph"] = {
        "nodes": [
            {"id": "start", "type": "custom", "data": {"type": "start"}},
            {"id": "loop", "type": "custom", "data": {
                "type": "loop", "start_node_id": "loop-start", "loop_count": 2,
                "logical_operator": "and",
                "loop_variables": [
                    {"label": "state", "var_type": "string", "value_type": "variable", "value": ["start", "input"]},
                    {"label": "done", "var_type": "number", "value_type": "constant", "value": 0},
                    # Constant arrays are values, not node selectors.
                    {"label": "literal", "var_type": "array[string]", "value_type": "constant", "value": ["missing", "literal"]},
                ],
                "break_conditions": [{"variable_selector": ["loop", "done"], "comparison_operator": "=", "value": "1"}],
            }},
            {"id": "loop-start", "type": "custom-loop-start", "parentId": "loop", "data": {"type": "loop-start", "loop_id": "loop"}},
            {"id": "body", "type": "custom", "parentId": "loop", "data": {
                "type": "template-transform", "loop_id": "loop",
                "variables": [{"variable": "state", "value_selector": ["loop", "state"]}], "template": "{{ state }}",
            }},
            {"id": "assign", "type": "custom", "parentId": "loop", "data": {
                "type": "assigner", "version": "2", "loop_id": "loop", "items": [
                    {"variable_selector": ["loop", "state"], "input_type": "variable", "operation": "over-write", "value": ["body", "output"]},
                    {"variable_selector": ["loop", "done"], "input_type": "constant", "operation": "set", "value": 1},
                ],
            }},
            {"id": "end", "type": "custom", "data": {"type": "end", "outputs": [{"variable": "answer", "value_selector": ["loop", "state"]}]}},
            {"id": "orphan", "type": "custom", "data": {"type": "answer"}},
            {"id": "other-loop", "type": "custom", "data": {"type": "loop", "loop_variables": [], "break_conditions": []}},
        ],
        "edges": [
            {"id": "outer-in", "source": "start", "target": "loop"},
            {"id": "outer-out", "source": "loop", "target": "end"},
            {"id": "body-in", "source": "loop-start", "target": "body"},
            {"id": "body-out", "source": "body", "target": "assign"},
        ],
    }
    native_errors, _ = validate_document(native_loop)
    if native_errors:
        print(f"SELF-TEST FAILED: native loop selectors were rejected: {native_errors}")
        return 1

    native_selector_cases = [
        ("loop initializer missing source", "loop", ("loop_variables", 0, "value"), ["missing", "input"], "selects missing node"),
        ("loop initializer non-ancestor source", "loop", ("loop_variables", 0, "value"), ["orphan", "input"], "not an upstream ancestor"),
        ("loop break missing source", "loop", ("break_conditions", 0, "variable_selector"), ["missing", "done"], "selects missing node"),
        ("loop break non-ancestor source", "loop", ("break_conditions", 0, "variable_selector"), ["orphan", "done"], "not an upstream ancestor"),
        ("assigner missing target", "assign", ("items", 0, "variable_selector"), ["missing", "state"], "selects missing node"),
        ("assigner wrong loop target", "assign", ("items", 0, "variable_selector"), ["other-loop", "state"], "not an upstream ancestor"),
        ("assigner malformed target", "assign", ("items", 0, "variable_selector"), ["loop"], "malformed selector"),
        ("assigner missing source", "assign", ("items", 0, "value"), ["missing", "output"], "selects missing node"),
        ("assigner non-ancestor source", "assign", ("items", 0, "value"), ["orphan", "output"], "not an upstream ancestor"),
        ("assigner malformed source", "assign", ("items", 0, "value"), ["body", ""], "malformed selector"),
    ]
    for name, node_id, path, replacement, expected in native_selector_cases:
        invalid_native = copy.deepcopy(native_loop)
        data = next(node["data"] for node in invalid_native["workflow"]["graph"]["nodes"] if node["id"] == node_id)
        target = data
        for key in path[:-1]:
            target = target[key]
        target[path[-1]] = replacement
        native_errors, _ = validate_document(invalid_native)
        if len(native_errors) != 1 or expected not in native_errors[0]:
            print(f"SELF-TEST FAILED: {name} expected one {expected!r} diagnostic, got {native_errors}")
            return 1

    def prompt_fixture(jinja: bool) -> dict[str, Any]:
        source_id = "request-source" if jinja else "request_source"
        data: dict[str, Any] = {
            "type": "llm", "title": "Prompt",
            "model": {"provider": "synthetic", "name": "synthetic", "mode": "chat", "completion_params": {}},
            "context": {"enabled": False, "variable_selector": []},
            "prompt_template": [{"role": "user", "edition_type": "jinja2" if jinja else "basic",
                                 "text": "{{ request_json }}" if jinja else "{{#request_source.request_json#}}"}],
        }
        if jinja:
            data["prompt_template"][0]["jinja2_text"] = "{{ request_json }}"
            data["prompt_config"] = {"jinja2_variables": [
                {"variable": "request_json", "value_selector": [source_id, "request_json"]}
            ]}
        document = copy.deepcopy(base)
        document["workflow"]["graph"] = {
            "nodes": [
                {"id": source_id, "type": "custom", "data": {"type": "start"}},
                {"id": "llm", "type": "custom", "data": data},
                {"id": "end", "type": "custom", "data": {"type": "end", "outputs": [
                    {"variable": "answer", "value_selector": ["llm", "text"]}
                ]}},
                {"id": "orphan", "type": "custom", "data": {"type": "answer"}},
            ],
            "edges": [{"id": "prompt-in", "source": source_id, "target": "llm"},
                      {"id": "prompt-out", "source": "llm", "target": "end"}],
        }
        return document

    basic_prompt = prompt_fixture(False)
    jinja_prompt = prompt_fixture(True)
    for name, document in (("underscore basic prompt", basic_prompt), ("hyphen Jinja selector", jinja_prompt)):
        prompt_errors, _ = validate_document(document)
        if prompt_errors:
            print(f"SELF-TEST FAILED: {name} was rejected: {prompt_errors}")
            return 1

    prompt_cases = [
        ("hyphen basic placeholder", basic_prompt, ("prompt_template", 0, "text"), "{{#request-source.request_json#}}", "not resolvable by Graphon 0.7.0"),
        ("invalid basic field name", basic_prompt, ("prompt_template", 0, "text"), "{{#request_source.1field#}}", "not resolvable by Graphon 0.7.0"),
        ("unterminated basic placeholder", basic_prompt, ("prompt_template", 0, "text"), "{{#request_source.request_json#}", "not resolvable by Graphon 0.7.0"),
        ("basic missing source", basic_prompt, ("prompt_template", 0, "text"), "{{#missing.request_json#}}", "selects missing node"),
        ("basic non-ancestor source", basic_prompt, ("prompt_template", 0, "text"), "{{#orphan.request_json#}}", "not an upstream ancestor"),
        ("Jinja missing source", jinja_prompt, ("prompt_config", "jinja2_variables", 0, "value_selector"), ["missing", "request_json"], "selects missing node"),
        ("Jinja non-ancestor source", jinja_prompt, ("prompt_config", "jinja2_variables", 0, "value_selector"), ["orphan", "request_json"], "not an upstream ancestor"),
        ("Jinja malformed selector", jinja_prompt, ("prompt_config", "jinja2_variables", 0, "value_selector"), ["request-source"], "malformed selector"),
        ("Jinja empty selector", jinja_prompt, ("prompt_config", "jinja2_variables", 0, "value_selector"), [], "non-empty value_selector"),
        ("Jinja missing rendered text", jinja_prompt, ("prompt_template", 0, "jinja2_text"), None, "non-empty jinja2_text"),
        ("Jinja duplicate binding", jinja_prompt, ("prompt_config", "jinja2_variables"), [
            {"variable": "request_json", "value_selector": ["request-source", "request_json"]},
            {"variable": "request_json", "value_selector": ["request-source", "request_json"]},
        ], "Duplicate LLM Jinja binding"),
    ]
    if jinja_check == "passed":
        prompt_cases += [
            ("Jinja invalid syntax", jinja_prompt, ("prompt_template", 0, "jinja2_text"), "{% if %}", "LLM Jinja syntax error"),
            ("Jinja undeclared variable", jinja_prompt, ("prompt_template", 0, "jinja2_text"), "{{ missing }}", "undeclared Jinja variables"),
        ]
        nearby_jinja = copy.deepcopy(jinja_prompt)
        nearby_jinja["workflow"]["graph"]["nodes"][1]["data"]["prompt_template"][0]["jinja2_text"] = (
            '{% set local = request_json %}{{ local }} {{ "{{#literal-source.request_json#}}" }}'
        )
        if validate_document(nearby_jinja)[0]:
            print("SELF-TEST FAILED: valid local Jinja variable or literal basic placeholder was rejected")
            return 1
        unicode_jinja = copy.deepcopy(jinja_prompt)
        unicode_data = unicode_jinja["workflow"]["graph"]["nodes"][1]["data"]
        unicode_data["prompt_config"]["jinja2_variables"][0]["variable"] = "запит"
        unicode_data["prompt_template"][0]["jinja2_text"] = "{{ запит }}"
        if validate_document(unicode_jinja)[0]:
            print("SELF-TEST FAILED: valid Unicode Jinja binding was rejected")
            return 1
    nearby_basic = copy.deepcopy(basic_prompt)
    nearby_basic["workflow"]["graph"]["nodes"][1]["data"]["prompt_template"][0]["text"] += " {{#context#}}"
    if validate_document(nearby_basic)[0]:
        print("SELF-TEST FAILED: Graphon's special basic context placeholder was rejected")
        return 1
    for name, document, path, replacement, expected in prompt_cases:
        invalid_prompt = copy.deepcopy(document)
        target = invalid_prompt["workflow"]["graph"]["nodes"][1]["data"]
        for key in path[:-1]:
            target = target[key]
        target[path[-1]] = replacement
        prompt_errors, _ = validate_document(invalid_prompt)
        if len(prompt_errors) != 1 or expected not in prompt_errors[0]:
            print(f"SELF-TEST FAILED: {name} expected one {expected!r} diagnostic, got {prompt_errors}")
            return 1

    release = {"schemaVersion": "contextflow-dify-release-v1"}
    release_errors, _ = validate_document(release)
    if not release_errors or "not a Dify workflow DSL" not in release_errors[0]:
        print("SELF-TEST FAILED: ContentFlow API release descriptor was not rejected")
        return 1

    print("SELF-TEST PASS: valid fixture, duplicate JSON/YAML keys, duplicate IDs, dangling edges, Python/Jinja syntax, selector ancestry, native loop/assigner selectors, basic LLM placeholders, explicit Jinja prompt bindings, release metadata detection")
    print(f"  YAML duplicate-key check: {yaml_duplicate_check}")
    print(f"  Jinja syntax check: {jinja_check}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dsl", nargs="?", type=Path, help="Path to a Dify exported YAML/JSON DSL")
    parser.add_argument("--self-test", action="store_true", help="Run offline checks against the synthetic fixture")
    parser.add_argument("--graphon-version", help="Validate node data with this exact installed, allowlisted Graphon version (currently 0.7.0)")
    parser.add_argument("--strict-node-types", action="store_true", help="Treat node types absent from Graphon as errors; may reject Dify/plugin nodes")
    parser.add_argument("--profile", choices=sorted(EDITOR_PROFILES), help="Apply a version-scoped editor profile documented in README.md")
    args = parser.parse_args(argv)

    if args.self_test:
        if args.dsl:
            parser.error("--self-test does not take a DSL path")
        return run_self_test()
    if not args.dsl:
        parser.error("provide a Dify DSL path or use --self-test")

    graphon_mapping = None
    graphon_warnings: list[str] = []
    try:
        if args.graphon_version:
            graphon_mapping, graphon_warnings = _graphon_mapping(args.graphon_version)
        if args.profile and args.graphon_version and EDITOR_PROFILES[args.profile] != args.graphon_version:
            raise InputError(
                f"Editor profile {args.profile!r} is scoped to Graphon {EDITOR_PROFILES[args.profile]}, "
                f"not requested {args.graphon_version}."
            )
        document = load_document(args.dsl)
        if is_contentflow_release_descriptor(document):
            print(
                "ERROR: release.json is ContentFlow API registry metadata, not Dify DSL. "
                "Use an exported Dify workflow YAML. To verify this artifact, run `node scripts/dify/verify_release.mjs`."
            )
            return 2
        errors, warnings = validate_document(
            document,
            graphon_mapping=graphon_mapping,
            graphon_import_warnings=graphon_warnings,
            profile=args.profile,
            strict_node_types=args.strict_node_types,
        )
    except InputError as exc:
        print(f"ERROR: {exc}")
        return 2

    if errors:
        print(f"ERRORS ({len(errors)}):")
        for item in errors:
            print(f"  x {item}")
    else:
        print("ERRORS: none")
    if warnings:
        print(f"WARNINGS ({len(warnings)}):")
        for item in warnings:
            print(f"  ! {item}")
    else:
        print("WARNINGS: none")
    if args.graphon_version:
        print(f"Graphon schema profile: {args.graphon_version}")
    print("Static checks do not prove Dify import, publication, plugin availability, model access, or live execution.")
    return 1 if errors else 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    raise SystemExit(main())
