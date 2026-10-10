#!/usr/bin/env python3
"""Reviewed outline DSL for Dify 1.17.1 / Graphon 0.7.0."""
from __future__ import annotations
import hashlib
import json
import re
from pathlib import Path

import yaml
import build_claim_extraction_dsl as base
from build_article_generation_dsl import Builder, EditorialDumper, object_schema, string, array

ROOT = Path(__file__).resolve().parents[2]
DIRECTORY = ROOT / 'packages/backend/src/editorial/workflows/outline-generation'
RUNTIME = ROOT / 'scripts/dify/outline_generation_runtime.py'
RELEASE_ID = 'outline-generation-2026-10-09.2'
PROMPT_VERSION = 'outline-generation-reviewed-prompt-v2'
ROLES = ['Shared rules', 'Strategist', 'Strategy reviewer', 'Strategy editor',
         'Outline architect', 'Editorial reviewer', 'Grounding reviewer', 'Outline editor']


def schemas():
    strategy = object_schema({key: string(2000, 1) for key in
        ['readerNeed', 'angle', 'promise', 'narrativeLogic']}
        | {'exclusions': array(string(500, 1), 50)})
    section = object_schema({'sectionId': string(20, 1), 'title': string(300, 1),
        'purpose': string(2000, 1), 'keyMessage': string(1500, 1),
        'readerQuestion': string(1000, 1), 'claimRevisionIds': array(string(36, 36), 100),
        'targetWords': {'type': 'integer', 'minimum': 1, 'maximum': 20000},
        'transition': string(1000)})
    plan = object_schema({'title': string(500, 1), 'sections': array(section, 30, 1)})
    issue = object_schema({'issueId': string(80, 1),
        'severity': {'type': 'string', 'enum': ['critical', 'major', 'minor']},
        'category': string(100, 1), 'targetId': string(20, 1), 'field': string(80, 1),
        'quote': string(1000), 'instruction': string(1000, 1), 'acceptance': string(1000, 1)})
    reviewed_hash = string(64, 64)
    return {'strategy': strategy, 'plan': plan,
        'review': object_schema({'reviewedHash': reviewed_hash, 'issues': array(issue, 40)}),
        'strategy_patch': object_schema({'reviewedHash': reviewed_hash, 'strategy': strategy}),
        'plan_patch': object_schema({'reviewedHash': reviewed_hash, 'plan': plan})}


class OutlineBuilder(Builder):
    def __init__(self):
        self.document = base.build_baseline_document()
        self.document['app'].update(name='contentflow-outline-generation-reviewed-v2',
            description='Frozen brief → reviewed strategy → outline → composition and grounding reviews → bounded edits. Unapproved candidates only.')
        self.nodes, self.edges, self.types = [], [], {}
        parts = re.split(r'^# (.+)\n', (DIRECTORY / 'prompt.md').read_text(encoding='utf-8'), flags=re.MULTILINE)
        self.roles = {parts[i]: parts[i + 1].strip() for i in range(1, len(parts), 2)}
        if set(self.roles) != set(ROLES):
            raise ValueError('Outline prompt roles do not match graph')
        self.schemas = schemas()
        self.runtime = re.sub(r'^def main\(', 'def runtime_main(', RUNTIME.read_text(encoding='utf-8'), count=1, flags=re.MULTILINE)

    @staticmethod
    def inputs(state, raw=None):
        result = {'editorial_json': ['start', 'editorial_json'], 'state_json': [state, 'state_json']}
        if raw:
            result['model_json'] = [raw, 'text']
        return result

    def code(self, ident, operation, title, inputs, x, y, parent=None, scope=None, gate=False):
        payload = '{' + ', '.join(repr(key) + ': ' + key for key in inputs if key != 'container_done') + '}'
        if scope:
            payload = payload[:-1] + ", 'scope': " + repr(scope) + '}'
        prefix = "    if container_done != 1:\n        raise ValueError('OUTLINE_LOOP_EXHAUSTED')\n" if gate else ''
        call = ("    result = {'state': json.loads(state_json), 'request': {}, 'done': 1, 'status': json.loads(state_json)['status']}\n"
            if operation == 'gate' else
            '    result = json.loads(runtime_main(' + repr(operation) + ', json.dumps(' + payload + ", ensure_ascii=False))['result_json'])\n")
        wrapper = '\ndef main(' + ', '.join(inputs) + '):\n' + prefix + call + '''    def encode(value):
        text = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
        if len(text.encode('utf-8')) > 350000:
            raise ValueError('OUTLINE_CODE_OUTPUT_LIMIT')
        return text
    return {
        'state_json': encode(result['state']),
        'request_json': encode(result.get('request', {})),
        'done': int(result.get('done', 0)),
        'status': result.get('status', result['state'].get('status', 'running')),
        'mode': result.get('mode', result['state'].get('mode', 'draft')),
        'outline_json': encode(result['outline_json']) if result.get('outline_json') is not None else '',
        'outline_report': encode(result['outline_report']) if result.get('outline_report') is not None else '',
    }
'''
        keys = ['state_json', 'request_json', 'done', 'status', 'mode', 'outline_json', 'outline_report']
        return self.node(ident, 'code', {'title': title, 'code_language': 'python3',
            'code': 'import json\n' + wrapper + '\n' + self.runtime,
            'variables': [{'variable': key, 'value_selector': value} for key, value in inputs.items()],
            'outputs': {key: {'type': 'number' if key == 'done' else 'string', 'children': None} for key in keys}}, x, y, parent)

    def build(self):
        self.node('start', 'start', {'title': 'Заморожений бриф, стиль і фактична основа', 'variables': [{
            'variable': 'editorial_json', 'label': 'Frozen editorial context JSON', 'type': 'paragraph',
            'required': True, 'max_length': 350000, 'options': []}]}, 80, 200)
        self.code('prepare', 'prepare', 'Перевірити вхід, режим і обов’язкові факти', {'editorial_json': ['start', 'editorial_json']}, 440, 200)
        self.llm('strategist', 'Strategist', 'strategy', 'prepare', 800, 200, None)
        self.code('strategy-drafted', 'strategy_draft', 'Зберегти редакційну стратегію', self.inputs('prepare', 'strategist'), 1160, 200)
        for source, target in [('start', 'prepare'), ('prepare', 'strategist'), ('strategist', 'strategy-drafted')]:
            self.edge(source, target)
        self.loop('strategy', 'Стратегія: рев’ю та одна правка', 'strategy-drafted', 2, 1520, 100, 3050, 900)
        self.edge('strategy-drafted', 'strategy')
        self.code('strategy-request', 'strategy_review_request', 'Бриф і поточна стратегія', self.inputs('strategy'), 130, 180, 'strategy')
        self.llm('strategy-reviewer', 'Strategy reviewer', 'review', 'strategy-request', 490, 180, 'strategy')
        self.code('strategy-reviewed', 'strategy_review', 'Перевірити зауваження до стратегії', self.inputs('strategy-request', 'strategy-reviewer'), 850, 180, 'strategy')
        self.code('strategy-decision', 'strategy_decision', 'Прийняти, виправити або заблокувати', self.inputs('strategy-reviewed'), 1210, 180, 'strategy')
        self.conditional('strategy-done', 'Перевірку стратегії завершено?', ['strategy-decision', 'done'], '1', 1570, 180, 'strategy', True)
        self.assign('strategy-pass-save', 'strategy-decision', 'strategy', 1930, 20)
        self.llm('strategy-editor', 'Strategy editor', 'strategy_patch', 'strategy-decision', 1930, 350, 'strategy')
        self.code('strategy-patched', 'strategy_patch', 'Перевірити адресну правку стратегії', self.inputs('strategy-decision', 'strategy-editor'), 2290, 350, 'strategy')
        self.assign('strategy-patch-save', 'strategy-patched', 'strategy', 2650, 350)
        for source, target in [('strategy-start', 'strategy-request'), ('strategy-request', 'strategy-reviewer'),
            ('strategy-reviewer', 'strategy-reviewed'), ('strategy-reviewed', 'strategy-decision'), ('strategy-decision', 'strategy-done')]:
            self.edge(source, target, parent='strategy')
        self.edge('strategy-done', 'strategy-pass-save', 'true', 'strategy')
        self.edge('strategy-done', 'strategy-editor', 'false', 'strategy')
        self.edge('strategy-editor', 'strategy-patched', parent='strategy')
        self.edge('strategy-patched', 'strategy-patch-save', parent='strategy')
        self.code('strategy-gate', 'gate', 'Контролювати завершення циклу', {'state_json': ['strategy', 'state_json'], 'container_done': ['strategy', 'done']}, 4930, 200, gate=True)
        self.edge('strategy', 'strategy-gate')
        self.conditional('strategy-ready', 'Стратегію перевірено?', ['strategy-gate', 'status'], 'running', 5290, 200)
        self.edge('strategy-gate', 'strategy-ready')
        self.code('plan-request', 'plan_request', 'Стратегія, факти і бюджет статті', self.inputs('strategy-gate'), 5650, 200)
        self.edge('strategy-ready', 'plan-request', 'true')
        self.llm('architect', 'Outline architect', 'plan', 'plan-request', 6010, 200, None)
        self.code('plan-drafted', 'plan_draft', 'Перевірити структуру, факти і розподіл обсягу', self.inputs('plan-request', 'architect'), 6370, 200)
        self.edge('plan-request', 'architect')
        self.edge('architect', 'plan-drafted')
        self.loop('outline', 'Структура: композиція, доказовість і до двох правок', 'plan-drafted', 3, 6730, 100, 3770, 900)
        self.edge('plan-drafted', 'outline')
        self.code('outline-request', 'review_request', 'Повна актуальна структура', self.inputs('outline'), 130, 180, 'outline', scope='editorial')
        self.llm('editorial-reviewer', 'Editorial reviewer', 'review', 'outline-request', 490, 180, 'outline')
        self.code('editorial-reviewed', 'review', 'Перевірити редакційні зауваження', self.inputs('outline-request', 'editorial-reviewer'), 850, 180, 'outline', scope='editorial')
        self.llm('grounding-reviewer', 'Grounding reviewer', 'review', 'editorial-reviewed', 1210, 180, 'outline')
        self.code('grounding-reviewed', 'review', 'Перевірити фактологічні зауваження', self.inputs('editorial-reviewed', 'grounding-reviewer'), 1570, 180, 'outline', scope='grounding')
        self.code('outline-decision', 'decision', 'Спільне рішення двох рев’юверів', self.inputs('grounding-reviewed'), 1930, 180, 'outline')
        self.conditional('outline-done', 'Аудит структури завершено?', ['outline-decision', 'done'], '1', 2290, 180, 'outline', True)
        self.assign('outline-pass-save', 'outline-decision', 'outline', 2650, 20)
        self.llm('outline-editor', 'Outline editor', 'plan_patch', 'outline-decision', 2650, 350, 'outline')
        self.code('outline-patched', 'plan_patch', 'Перевірити правку без сторонніх змін', self.inputs('outline-decision', 'outline-editor'), 3010, 350, 'outline')
        self.assign('outline-patch-save', 'outline-patched', 'outline', 3370, 350)
        for source, target in [('outline-start', 'outline-request'), ('outline-request', 'editorial-reviewer'),
            ('editorial-reviewer', 'editorial-reviewed'), ('editorial-reviewed', 'grounding-reviewer'),
            ('grounding-reviewer', 'grounding-reviewed'), ('grounding-reviewed', 'outline-decision'), ('outline-decision', 'outline-done')]:
            self.edge(source, target, parent='outline')
        self.edge('outline-done', 'outline-pass-save', 'true', 'outline')
        self.edge('outline-done', 'outline-editor', 'false', 'outline')
        self.edge('outline-editor', 'outline-patched', parent='outline')
        self.edge('outline-patched', 'outline-patch-save', parent='outline')
        self.code('finalize', 'finalize', 'Зібрати outline-v1 та звіт без погодження', {**self.inputs('outline'), 'container_done': ['outline', 'done']}, 10860, 200, gate=True)
        self.edge('outline', 'finalize')
        self.code('strategy-failure', 'finalize', 'Звіт про заблоковану стратегію', self.inputs('strategy-gate'), 5650, 1350)
        self.edge('strategy-ready', 'strategy-failure', 'false')
        for key, x in [('outline_json', 11220), ('outline_report', 11580)]:
            self.node('merge-' + key, 'variable-aggregator', {'title': key, 'output_type': 'string',
                'variables': [[source, key] for source in ['finalize', 'strategy-failure']],
                'advanced_settings': {'group_enabled': False, 'groups': []}}, x, 650)
        for source in ['finalize', 'strategy-failure']:
            self.edge(source, 'merge-outline_json')
        self.edge('merge-outline_json', 'merge-outline_report')
        self.node('end', 'end', {'title': 'Кандидат структури та звіт', 'outputs': [
            {'variable': key, 'value_type': 'string', 'value_selector': ['merge-' + key, 'output']}
            for key in ['outline_json', 'outline_report']]}, 11940, 650)
        self.edge('merge-outline_report', 'end')
        for node in self.nodes:
            if node['data']['type'] == 'loop':
                node['_children'] = [{'id': child['id'], 'type': child['data']['type']}
                    for child in self.nodes if child.get('parentId') == node['id']]
        self.document['workflow']['graph'] = {'nodes': self.nodes, 'edges': self.edges,
            'viewport': {'x': 20, 'y': 80, 'zoom': 0.2}}
        return self.document


def build_document():
    return OutlineBuilder().build()


def main():
    document = build_document()
    output = DIRECTORY / 'outline-generation-v1.yml'
    output.write_text(yaml.dump(document, Dumper=EditorialDumper, allow_unicode=True,
        sort_keys=True, width=1000, default_flow_style=False), encoding='utf-8', newline='\n')
    release = {'schemaVersion': 'contextflow-dify-release-v1', 'operation': 'OUTLINE_GENERATION',
        'releaseId': RELEASE_ID, 'contractVersion': 'outline-v1', 'promptTemplateVersion': PROMPT_VERSION,
        'promptTemplateFile': 'prompt.md', 'promptSha256': hashlib.sha256((DIRECTORY / 'prompt.md').read_bytes()).hexdigest(),
        'workflowDslFile': output.name, 'workflowDslSha256': hashlib.sha256(output.read_bytes()).hexdigest(),
        'runtimeFile': 'scripts/dify/outline_generation_runtime.py', 'runtimeSha256': hashlib.sha256(RUNTIME.read_bytes()).hexdigest(),
        'target': {'difyVersion': '1.17.1', 'graphonVersion': '0.7.0', 'dslVersion': '0.7.0'},
        'outlineLimits': {'strategyRepairs': 1, 'outlineRepairs': 2, 'maxSections': 30,
            'maxModelCalls': 16, 'maxStateBytes': 350000, 'deadlineMs': 600000},
        'reportVariable': 'outline_report', 'reportSchemaVersion': 'outline-review-report-v1',
        'apiBaseEnv': 'DIFY_API_BASE_URL', 'apiKeyEnv': 'DIFY_OUTLINE_GENERATION_API_KEY',
        'publishedWorkflowIdEnv': 'DIFY_OUTLINE_GENERATION_PUBLISHED_WORKFLOW_ID',
        'configDigestEnv': 'DIFY_OUTLINE_GENERATION_CONFIG_SHA256', 'inputVariable': 'editorial_json',
        'outputVariable': 'outline_json', 'responseMode': 'streaming', 'provider': 'dify',
        'model': {'provider': 'langgenius/gemini/google', 'name': 'gemini-3.8-flash',
            'mode': 'chat', 'completionParams': base.completion_params(8192)}}
    release['configDigest'] = hashlib.sha256(json.dumps(release, ensure_ascii=False, sort_keys=True,
        separators=(',', ':')).encode('utf-8')).hexdigest()
    (DIRECTORY / 'release.json').write_text(json.dumps(release, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'Built {len(document["workflow"]["graph"]["nodes"])} outline nodes; remote publication is separate.')


if __name__ == '__main__':
    main()
