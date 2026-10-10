#!/usr/bin/env python3
"""Build the native editorial pipeline, matched to Dify 1.17.1 / Graphon 0.7.0.

No nested containers: the section loop advances only when a section's local
review/revision cycle finishes. Runtime, prompts and graph are release hashed.
This script generates local artifacts only; it never imports or publishes them.
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

import yaml
import build_claim_extraction_dsl as base

ROOT = Path(__file__).resolve().parents[2]
DIRECTORY = ROOT / 'packages/backend/src/editorial/workflows/article-generation'
RUNTIME = ROOT / 'scripts/dify/article_generation_runtime.py'
RELEASE_ID = 'article-generation-2026-10-09.2'
PROMPT_VERSION = 'article-generation-editorial-prompt-v2'
TARGET = {'difyVersion': '1.17.1', 'graphonVersion': '0.7.0', 'dslVersion': '0.7.0'}
LIMITS = {'planRepairs': 1, 'sectionRepairs': 2, 'globalRepairs': 2,
          'maxSections': 30, 'maxModelCalls': 200, 'maxStateBytes': 350000,
          'deadlineMs': 3600000}


class EditorialDumper(base.DifyDumper):
    def ignore_aliases(self, data):
        return True


def canonical(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def object_schema(properties: dict, required: list[str] | None = None) -> dict:
    return {'type': 'object', 'additionalProperties': False,
            'properties': properties, 'required': required if required is not None else list(properties)}


def string(maximum: int = 4000, minimum: int = 0) -> dict:
    return {'type': 'string', 'minLength': minimum, 'maxLength': maximum}


def array(items: dict, maximum: int = 30, minimum: int = 0) -> dict:
    # Gemini 3.8 Flash rejects our nested schemas with native maxItems (live
    # A/B probes, 2026-10-09). Describe the bound to guide generation; Code
    # runtime and backend validation enforce it independently of the model.
    return {'type': 'array', 'items': items, 'minItems': minimum,
            'description': f'Return at most {maximum} items.'}


def schemas() -> dict[str, dict]:
    span = object_schema({'text': string(10000, 1), 'claimRevisionId': string(100), 'evidenceId': string(100)})
    block = object_schema({'id': string(80, 1), 'type': {'type': 'string', 'enum': [
        'paragraph', 'heading', 'bullet', 'ordered', 'blockquote']},
        'level': {'type': 'integer', 'enum': [3]}, 'spans': array(span, 40, 1)}, ['id', 'type', 'spans'])
    plan_section = object_schema({'sectionId': string(20, 1),
        'role': {'type': 'string', 'enum': ['body', 'introduction', 'conclusion']},
        'readerQuestion': string(1000, 1), 'thesis': string(1500, 1),
        'paragraphPlan': array(string(1000, 1), 12, 1), 'claimRevisionIds': array(string(100, 1), 100),
        'targetWords': {'type': 'integer', 'minimum': 1, 'maximum': 20000},
        'avoidRepeating': array(string(1000, 1), 12), 'transition': string(1500)})
    issue = object_schema({'id': string(80, 1),
        'severity': {'type': 'string', 'enum': ['critical', 'major', 'minor']},
        'category': string(80, 1), 'sectionId': string(20, 1), 'blockId': string(80, 1),
        'quote': string(1000, 1), 'instruction': string(1000, 1), 'acceptance': string(1000, 1)})
    return {
        'plan': object_schema({'status': {'type': 'string', 'enum': ['ready', 'insufficient_evidence', 'needs_human']},
            'reasons': array(string(1000, 1), 10),
            'terminology': array(object_schema({'term': string(200, 1), 'definition': string(1000, 1)}), 50),
            'sections': array(plan_section, 30)}),
        'section': object_schema({'sectionId': string(20, 1), 'blocks': array(block, 60, 1)}),
        'review': object_schema({'versionHash': string(64, 64),
            'resolvedIssueIds': array(string(80, 1), 100), 'issues': array(issue, 40)}),
        'patch': object_schema({'versionHash': string(64, 64), 'replacements': array(object_schema({
            'sectionId': string(20, 1), 'blockId': string(100, 1), 'block': block}), 60, 1)}),
    }


def prompts() -> dict[str, str]:
    text = (DIRECTORY / 'prompt.md').read_text(encoding='utf-8')
    parts = re.split(r'^# (.+)\n', text, flags=re.MULTILINE)
    result = {parts[i]: parts[i + 1].strip() for i in range(1, len(parts), 2)}
    required = ['Shared rules', 'Planner', 'Plan reviewer', 'Section writer', 'Section reviewer',
                'Section editor', 'Global reviewer', 'Language reviewer', 'Factual reviewer', 'Global editor']
    if set(result) != set(required):
        raise ValueError('Editorial prompt role sections do not match the builder')
    return result


class Builder:
    def __init__(self):
        self.document = base.build_baseline_document()
        self.document['app'].update(name='contentflow-article-generation-editorial-v2',
            description='Approved outline → detailed plan → sequential reviewed sections → full editorial, language and factual audit. Unapproved candidates only.')
        self.nodes: list[dict] = []
        self.edges: list[dict] = []
        self.roles = prompts()
        self.schemas = schemas()
        # Code nodes are standalone in the Dify sandbox. Rename the public
        # runtime entry point so the validator sees the node's own main first.
        self.runtime = re.sub(r'^def main\(', 'def runtime_main(', RUNTIME.read_text(encoding='utf-8'),
                              count=1, flags=re.MULTILINE)
        self.types: dict[str, str] = {}

    def node(self, ident: str, kind: str, data: dict, x: int, y: int, parent: str | None = None,
             width: int = 300, height: int = 160) -> str:
        item = base.node(ident, kind, data, x, y, width=width, height=height)
        if parent:
            item.update(parentId=parent, extent='parent', zIndex=1002)
            item['data'].update(isInLoop=True, loop_id=parent)
            if kind == 'loop-start':
                item['type'] = 'custom-loop-start'
                item.update(width=44, height=48)
        self.nodes.append(item)
        self.types[ident] = kind
        return ident

    def edge(self, source: str, target: str, handle: str = 'source', parent: str | None = None):
        item = base.edge(source, target, self.types[source], self.types[target])
        item.update(id=f'{source}-{handle}-{target}-target', sourceHandle=handle)
        if parent:
            item['data'].update(isInLoop=True, loop_id=parent)
            item['zIndex'] = 1002
        self.edges.append(item)

    def llm(self, ident: str, role: str, schema: str, request: str, x: int, y: int, parent: str):
        return self.node(ident, 'llm', {
            'title': role, 'desc': 'Structured Ukrainian editorial artifact; no tools or model retries.',
            'model': {'provider': 'langgenius/gemini/google', 'name': 'gemini-3.8-flash', 'mode': 'chat',
                      'completion_params': base.completion_params(8192)},
            'prompt_template': [
                {'id': f'{ident}-system', 'role': 'system', 'edition_type': 'basic',
                 'text': self.roles['Shared rules'] + '\n\n' + self.roles[role]},
                {'id': f'{ident}-request', 'role': 'user', 'edition_type': 'jinja2',
                 'text': '<editorial_request>\n{{ request_json }}\n</editorial_request>',
                 'jinja2_text': '<editorial_request>\n{{ request_json }}\n</editorial_request>'}],
            # Basic templates reject hyphenated node IDs in Graphon 0.7.0.
            # An explicit Jinja selector keeps stable IDs and carries data.
            'prompt_config': {'jinja2_variables': [
                {'variable': 'request_json', 'value_selector': [request, 'request_json']}]},
            'context': {'enabled': False, 'variable_selector': []}, 'vision': {'enabled': False},
            'structured_output_enabled': True, 'structured_output': {'schema': self.schemas[schema]},
            'retry_config': {'max_retries': 0, 'retry_enabled': False, 'retry_interval': 3000}}, x, y, parent)

    def code(self, ident: str, operation: str, title: str, inputs: dict[str, list[str]], x: int, y: int,
             parent: str | None = None, scope: str | None = None, gate: bool = False):
        parameters = ', '.join(inputs)
        payload = '{' + ', '.join(repr(key) + ': ' + key for key in inputs if key != 'container_done') + '}'
        if scope:
            payload = payload[:-1] + (', ' if len(payload) > 2 else '') + "'scope': " + repr(scope) + '}'
        prefix = ''
        if gate:
            prefix = "    if container_done != 1:\n        raise ValueError('EDITORIAL_LOOP_EXHAUSTED')\n"
        if operation == 'gate':
            call = "    result = {'state': json.loads(state_json), 'request': {}, 'done': 1, 'status': json.loads(state_json)['status']}\n"
        else:
            call = '    result = json.loads(runtime_main(' + repr(operation) + ', json.dumps(' + payload + ", ensure_ascii=False))['result_json'])\n"
        wrapper = f'\ndef main({parameters}):\n' + prefix + call + '''    def encode(value):
        text = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
        if len(text.encode('utf-8')) > 350000:
            raise ValueError('EDITORIAL_CODE_OUTPUT_LIMIT')
        return text
    return {
        'state_json': encode(result['state']),
        'request_json': encode(result.get('request', {})),
        'done': int(result.get('done', 0)),
        'status': result.get('status', result['state'].get('status', 'running')),
        'mode': result.get('mode', result.get('request', {}).get('mode', 'draft')),
        'article_json': encode(result['article_json']) if result.get('article_json') is not None else '',
        'editorial_report': encode(result['editorial_report']) if result.get('editorial_report') is not None else '',
    }
'''
        # Put wrapper first: static main discovery is deterministic. Definitions
        # below it exist by the time the sandbox invokes main.
        source = 'import json\n' + wrapper + '\n' + self.runtime
        outputs = {key: {'type': 'number' if key == 'done' else 'string', 'children': None}
                   for key in ['state_json', 'request_json', 'done', 'status', 'mode', 'article_json', 'editorial_report']}
        return self.node(ident, 'code', {'title': title, 'code_language': 'python3', 'code': source,
            'variables': [{'variable': key, 'value_selector': value} for key, value in inputs.items()],
            'outputs': outputs}, x, y, parent)

    def conditional(self, ident: str, title: str, selector: list[str], value: str, x: int, y: int,
                    parent: str | None = None, number: bool = False):
        condition = {'id': ident + '-condition', 'varType': 'number' if number else 'string',
            'variable_selector': selector, 'comparison_operator': '=' if number else 'is', 'value': value}
        if number:
            condition['numberVarType'] = 'constant'
        return self.node(ident, 'if-else', {'title': title, 'cases': [{
            'case_id': 'true', 'logical_operator': 'and', 'conditions': [condition]}]}, x, y, parent)

    def loop(self, ident: str, title: str, seed: str, count: int, x: int, y: int, width: int, height: int):
        self.node(ident, 'loop', {'title': title, 'desc': 'Bounded state machine; no nested loops.',
            'start_node_id': ident + '-start', 'loop_count': count, 'logical_operator': 'and',
            'error_handle_mode': 'terminated', 'break_conditions': [{
                'id': ident + '-done', 'varType': 'number', 'variable_selector': [ident, 'done'],
                'comparison_operator': '=', 'value': '1', 'numberVarType': 'constant'}],
            'loop_variables': [
                {'id': ident + '-state', 'label': 'state_json', 'var_type': 'string',
                 'value_type': 'variable', 'value': [seed, 'state_json']},
                {'id': ident + '-done-state', 'label': 'done', 'var_type': 'number',
                 'value_type': 'constant', 'value': 0}]}, x, y, width=width, height=height)
        self.node(ident + '-start', 'loop-start', {'title': '', 'desc': ''}, 30, 70, ident)

    def assign(self, ident: str, source: str, loop: str, x: int, y: int):
        return self.node(ident, 'assigner', {'title': 'Зберегти стан і рішення', 'version': '2', 'items': [
            {'variable_selector': [loop, key], 'input_type': 'variable', 'operation': 'over-write',
             'value': [source, key]} for key in ['state_json', 'done']]}, x, y, loop)

    @staticmethod
    def inputs(state: str, raw: str | None = None) -> dict[str, list[str]]:
        result = {'editorial_json': ['start', 'editorial_json'], 'state_json': [state, 'state_json']}
        if raw:
            result['raw'] = [raw, 'text']
        return result

    def build(self) -> dict:
        self.node('start', 'start', {'title': 'Заморожений редакційний контекст', 'variables': [{
            'variable': 'editorial_json', 'label': 'Frozen article context (JSON)', 'type': 'paragraph',
            'required': True, 'max_length': 1048576, 'options': []}]}, 80, 240)
        self.code('prepare', 'prepare', 'Перевірити контекст і бюджети', {'editorial_json': ['start', 'editorial_json']}, 430, 240)
        self.edge('start', 'prepare')

        self.loop('planning', 'Детальний план та його рев’ю', 'prepare', 2, 800, 100, 2700, 750)
        self.edge('prepare', 'planning')
        self.code('plan-request', 'plan_request', 'Завдання планувальнику', self.inputs('planning'), 130, 100, 'planning')
        self.llm('planner', 'Planner', 'plan', 'plan-request', 490, 100, 'planning')
        self.code('validate-plan', 'plan', 'Перевірити незмінну структуру і факти', self.inputs('plan-request', 'planner'), 850, 100, 'planning')
        self.conditional('plan-stopped', 'Брак матеріалу чи непридатний план?', ['validate-plan', 'done'], '1', 1210, 100, 'planning', True)
        self.llm('plan-reviewer', 'Plan reviewer', 'review', 'validate-plan', 1570, 250, 'planning')
        self.code('plan-verdict', 'plan_review', 'Прийняти план або конкретні зауваження', self.inputs('validate-plan', 'plan-reviewer'), 1930, 250, 'planning')
        self.assign('plan-save', 'plan-verdict', 'planning', 2290, 250)
        self.assign('plan-blocked-save', 'validate-plan', 'planning', 1570, 50)
        for a, b in [('planning-start', 'plan-request'), ('plan-request', 'planner'), ('planner', 'validate-plan'),
                     ('validate-plan', 'plan-stopped'), ('plan-reviewer', 'plan-verdict'), ('plan-verdict', 'plan-save')]:
            self.edge(a, b, parent='planning')
        self.edge('plan-stopped', 'plan-blocked-save', 'true', 'planning')
        self.edge('plan-stopped', 'plan-reviewer', 'false', 'planning')
        self.code('plan-gate', 'gate', 'Плановий цикл завершився явно', {
            'state_json': ['planning', 'state_json'], 'container_done': ['planning', 'done']}, 3600, 200, gate=True)
        self.edge('planning', 'plan-gate')
        self.conditional('plan-ready', 'Можна писати статтю?', ['plan-gate', 'status'], 'running', 3960, 200)
        self.edge('plan-gate', 'plan-ready')

        self.loop('sections', 'Розділи: написання → рев’ю → точкові правки', 'plan-gate', 90, 4350, 100, 3650, 950)
        self.edge('plan-ready', 'sections', 'true')
        self.code('section-request', 'section_request', 'Контекст поточного розділу і пам’ять', self.inputs('sections'), 130, 150, 'sections')
        self.conditional('section-mode', 'Чернетка чи редактура?', ['section-request', 'mode'], 'patch', 490, 150, 'sections')
        self.llm('section-editor', 'Section editor', 'patch', 'section-request', 850, 50, 'sections')
        self.llm('section-writer', 'Section writer', 'section', 'section-request', 850, 390, 'sections')
        self.code('section-patched', 'section_patch', 'Застосувати лише адресні правки', self.inputs('section-request', 'section-editor'), 1210, 50, 'sections')
        self.code('section-drafted', 'section_draft', 'Перевірити блоки і evidence', self.inputs('section-request', 'section-writer'), 1210, 390, 'sections')
        self.node('section-merge', 'variable-aggregator', {'title': 'Поточна валідна версія', 'output_type': 'string',
            'variables': [['section-drafted', 'state_json'], ['section-patched', 'state_json']],
            'advanced_settings': {'group_enabled': False, 'groups': []}}, 1570, 200, 'sections')
        self.code('section-review-request', 'section_request', 'Текст і версія для рев’ю', {
            'editorial_json': ['start', 'editorial_json'], 'state_json': ['section-merge', 'output']}, 1930, 200, 'sections')
        self.llm('section-reviewer', 'Section reviewer', 'review', 'section-review-request', 2290, 200, 'sections')
        self.code('section-verdict', 'section_review', 'Перевірити цитати і зауваження', self.inputs('section-review-request', 'section-reviewer'), 2650, 200, 'sections')
        self.code('section-advance', 'advance', 'Наступний розділ або ще одна правка', self.inputs('section-verdict'), 3010, 200, 'sections')
        self.assign('section-save', 'section-advance', 'sections', 3370, 200)
        for a, b in [('sections-start', 'section-request'), ('section-request', 'section-mode'),
                     ('section-editor', 'section-patched'), ('section-writer', 'section-drafted'),
                     ('section-patched', 'section-merge'), ('section-drafted', 'section-merge'),
                     ('section-merge', 'section-review-request'), ('section-review-request', 'section-reviewer'),
                     ('section-reviewer', 'section-verdict'), ('section-verdict', 'section-advance'), ('section-advance', 'section-save')]:
            self.edge(a, b, parent='sections')
        self.edge('section-mode', 'section-editor', 'true', 'sections')
        self.edge('section-mode', 'section-writer', 'false', 'sections')
        self.code('section-gate', 'gate', 'Усі розділи завершені', {
            'state_json': ['sections', 'state_json'], 'container_done': ['sections', 'done']}, 8100, 200, gate=True)
        self.edge('sections', 'section-gate')
        self.conditional('sections-ready', 'Повний текст готовий до рев’ю?', ['section-gate', 'status'], 'running', 8460, 200)
        self.edge('section-gate', 'sections-ready')

        self.loop('editing', 'Ціла стаття: зміст → мова → факти → правки', 'section-gate', 3, 8850, 100, 4750, 850)
        self.edge('sections-ready', 'editing', 'true')
        self.code('article-request', 'article_request', 'Зібрати цілісний текст і відкриті дефекти', self.inputs('editing'), 130, 180, 'editing')
        previous = 'article-request'
        self.edge('editing-start', previous, parent='editing')
        for i, (scope, role) in enumerate([('global', 'Global reviewer'), ('language', 'Language reviewer'), ('factual', 'Factual reviewer')]):
            llm_id, code_id = scope + '-reviewer', scope + '-verdict'
            x = 490 + i * 720
            # All reviewers see the same unchanged snapshot. Review collections
            # accumulate sequentially in state; they never edit the text.
            self.llm(llm_id, role, 'review', previous, x, 180, 'editing')
            self.code(code_id, 'review', 'Зафіксувати перевірку: ' + scope, self.inputs(previous, llm_id), x + 360, 180, 'editing', scope)
            self.edge(previous, llm_id, parent='editing')
            self.edge(llm_id, code_id, parent='editing')
            previous = code_id
        self.code('editorial-decision', 'decision', 'Об’єднати дефекти та перевірити ліміти', self.inputs(previous), 2650, 180, 'editing')
        self.edge(previous, 'editorial-decision', parent='editing')
        self.conditional('editing-done', 'Перевірки завершені?', ['editorial-decision', 'done'], '1', 3010, 180, 'editing', True)
        self.edge('editorial-decision', 'editing-done', parent='editing')
        self.assign('editing-pass-save', 'editorial-decision', 'editing', 3370, 30)
        self.llm('global-editor', 'Global editor', 'patch', 'editorial-decision', 3370, 350, 'editing')
        self.code('article-patched', 'patch', 'Застосувати правки з контролем покриття', self.inputs('editorial-decision', 'global-editor'), 3730, 350, 'editing')
        self.assign('editing-patch-save', 'article-patched', 'editing', 4090, 350)
        self.edge('editing-done', 'editing-pass-save', 'true', 'editing')
        self.edge('editing-done', 'global-editor', 'false', 'editing')
        self.edge('global-editor', 'article-patched', parent='editing')
        self.edge('article-patched', 'editing-patch-save', parent='editing')

        self.code('finalize', 'finalize', 'Фінальний кандидат та редакційний звіт', {
            'editorial_json': ['start', 'editorial_json'], 'state_json': ['editing', 'state_json'],
            'container_done': ['editing', 'done']}, 13700, 200, gate=True)
        self.edge('editing', 'finalize')
        for name, source, x, y in [('plan-failure', 'plan-gate', 3960, 1250), ('section-failure', 'section-gate', 8460, 1250)]:
            self.code(name, 'finalize', 'Звіт про незавершену редактуру', self.inputs(source), x, y)
            self.edge('plan-ready' if name == 'plan-failure' else 'sections-ready', name, 'false')
        # Dify has a workflow-wide output namespace. Exclusive terminal branches
        # must converge before one End instead of redeclaring output names.
        for key, x in [('article_json', 14060), ('editorial_report', 14420)]:
            self.node('merge-' + key, 'variable-aggregator', {'title': 'Результат: ' + key, 'output_type': 'string',
                'variables': [[source, key] for source in ['finalize', 'plan-failure', 'section-failure']],
                'advanced_settings': {'group_enabled': False, 'groups': []}}, x, 700)
        for source in ['finalize', 'plan-failure', 'section-failure']:
            self.edge(source, 'merge-article_json')
        self.edge('merge-article_json', 'merge-editorial_report')
        self.node('end', 'end', {'title': 'Повернути candidate/report без погодження', 'outputs': [
            {'variable': key, 'value_type': 'string', 'value_selector': ['merge-' + key, 'output']}
            for key in ['article_json', 'editorial_report']]}, 14780, 700)
        self.edge('merge-editorial_report', 'end')
        for node in self.nodes:
            if node['data']['type'] == 'loop':
                children = [item for item in self.nodes if item.get('parentId') == node['id']]
                node['_children'] = [{'id': child['id'], 'type': child['data']['type']} for child in children]
        self.document['workflow']['graph'] = {'nodes': self.nodes, 'edges': self.edges,
            'viewport': {'x': 20, 'y': 80, 'zoom': 0.18}}
        return self.document


def build_document() -> dict:
    return Builder().build()


def main() -> None:
    document = build_document()
    output = DIRECTORY / 'article-generation-v1.yml'
    output.write_text(yaml.dump(document, Dumper=EditorialDumper, allow_unicode=True,
        sort_keys=True, width=1000, default_flow_style=False), encoding='utf-8', newline='\n')
    release = {'schemaVersion': 'contextflow-dify-release-v1', 'operation': 'ARTICLE_GENERATION',
        'releaseId': RELEASE_ID, 'contractVersion': 'article-v1', 'promptTemplateVersion': PROMPT_VERSION,
        'promptTemplateFile': 'prompt.md', 'promptSha256': hashlib.sha256((DIRECTORY / 'prompt.md').read_bytes()).hexdigest(),
        'workflowDslFile': output.name, 'workflowDslSha256': hashlib.sha256(output.read_bytes()).hexdigest(),
        'runtimeFile': 'scripts/dify/article_generation_runtime.py', 'runtimeSha256': hashlib.sha256(RUNTIME.read_bytes()).hexdigest(),
        'target': TARGET, 'editorialLimits': LIMITS, 'reportSchemaVersion': 'article-editorial-report-v1',
        'apiBaseEnv': 'DIFY_API_BASE_URL', 'apiKeyEnv': 'DIFY_ARTICLE_GENERATION_API_KEY',
        'publishedWorkflowIdEnv': 'DIFY_ARTICLE_GENERATION_PUBLISHED_WORKFLOW_ID',
        'configDigestEnv': 'DIFY_ARTICLE_GENERATION_CONFIG_SHA256', 'inputVariable': 'editorial_json',
        'outputVariable': 'article_json', 'reportVariable': 'editorial_report', 'responseMode': 'streaming', 'provider': 'dify',
        'model': {'provider': 'langgenius/gemini/google', 'name': 'gemini-3.8-flash', 'mode': 'chat',
                  'completionParams': base.completion_params(8192)}}
    release['configDigest'] = hashlib.sha256(canonical(release).encode()).hexdigest()
    (DIRECTORY / 'release.json').write_text(json.dumps(release, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f"Built {len(document['workflow']['graph']['nodes'])} native nodes; release {RELEASE_ID}. Remote publication is separate.")


if __name__ == '__main__':
    main()
