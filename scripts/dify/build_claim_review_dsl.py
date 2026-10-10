"""Reviewed extraction DSL for Dify 1.17.1 / Graphon 0.7.0.

Uses the already exercised native graph primitives from the article builder.
No nested loops, credentials, external tools, or paid calls in this generator.
"""
import hashlib
import json
import re
from pathlib import Path

import yaml
import build_claim_extraction_dsl as base
from build_article_generation_dsl import Builder, EditorialDumper, object_schema, string, array

ROOT = Path(__file__).resolve().parents[2]
DIRECTORY = base.WORKFLOW_DIR
RUNTIME = ROOT / 'scripts/dify/claim_extraction_runtime.py'
RELEASE_ID = 'claim-extraction-2026-10-09.2'
PROMPT_VERSION = 'claims-extraction-review-prompt-v2'
ROLES = ['Shared rules', 'Extractor', 'Evidence reviewer', 'Batch editor',
         'Deduplicator', 'Conflict reviewer', 'Final auditor', 'Global editor']


def schemas():
    claim = object_schema({'key': string(64, 1), 'wording': string(2000, 1),
        'evidence': array(object_schema({'fragmentId': string(36, 36),
            'relation': {'type': 'string', 'enum': ['SUPPORTS', 'CONTRADICTS']}}), 10, 1)})
    issue = object_schema({'id': string(80, 1),
        'severity': {'type': 'string', 'enum': ['critical', 'major', 'minor']},
        'category': string(80, 1), 'claimKey': string(64), 'fragmentId': string(36),
        'quote': string(1000, 1), 'instruction': string(1000, 1), 'acceptance': string(1000, 1)})
    coverage = array(object_schema({'fragmentId': string(36, 36),
        'disposition': {'type': 'string', 'enum': ['covered', 'no_factual_claims']},
        'claimKeys': array(string(64, 1), 100)}), 240)
    conflict = object_schema({'claimKeys': array(string(64, 1), 10, 2), 'rationale': string(2000, 1)})
    version = string(64, 64)
    return {'draft': object_schema({'claims': array(claim, 30)}),
        'batch_patch': object_schema({'versionHash': version, 'claims': array(claim, 30)}),
        'review': object_schema({'versionHash': version, 'issues': array(issue, 40), 'coverage': coverage}),
        'merge': object_schema({'versionHash': version,
            'groups': array(object_schema({'claimKeys': array(string(64, 1), 100, 1)}), 100)}),
        'conflict': object_schema({'versionHash': version, 'conflicts': array(conflict, 100)}),
        'global_patch': object_schema({'versionHash': version, 'claims': array(claim, 100),
            'conflicts': array(conflict, 100)})}


class ClaimsBuilder(Builder):
    def __init__(self):
        self.document = base.build_baseline_document()
        self.document['app'].update(name='contentflow-claim-extraction-reviewed-v2',
            description='Frozen fragments → bounded extraction/review → deduplication → conflict analysis → complete audit. Proposed claims only.')
        self.nodes, self.edges, self.types = [], [], {}
        parts = re.split(r'^# (.+)\n', (DIRECTORY / 'prompt.md').read_text(encoding='utf-8'), flags=re.MULTILINE)
        self.roles = {parts[i]: parts[i + 1].strip() for i in range(1, len(parts), 2)}
        if set(self.roles) != set(ROLES):
            raise ValueError('Claim-extraction prompt roles do not match the graph')
        self.schemas = schemas()
        self.runtime = re.sub(r'^def main\(', 'def runtime_main(', RUNTIME.read_text(encoding='utf-8'), count=1, flags=re.MULTILINE)

    @staticmethod
    def inputs(state, raw=None):
        result = {'sources_json': ['start', 'sources_json'], 'state_json': [state, 'state_json']}
        if raw:
            result['raw'] = [raw, 'text']
        return result

    def code(self, ident, operation, title, inputs, x, y, parent=None, gate=False):
        payload = '{' + ', '.join(repr(key) + ': ' + key for key in inputs if key != 'container_done') + '}'
        prefix = "    if container_done != 1:\n        raise ValueError('CLAIMS_LOOP_EXHAUSTED')\n" if gate else ''
        if operation == 'gate':
            call = "    result = {'state': json.loads(state_json), 'request': {}, 'done': 1, 'status': json.loads(state_json)['status']}\n"
        else:
            call = '    result = json.loads(runtime_main(' + repr(operation) + ', json.dumps(' + payload + ", ensure_ascii=False))['result_json'])\n"
        wrapper = '\ndef main(' + ', '.join(inputs) + '):\n' + prefix + call + '''    def encode(value):
        text = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
        if len(text.encode('utf-8')) > 350000:
            raise ValueError('CLAIMS_CODE_OUTPUT_LIMIT')
        return text
    return {
        'state_json': encode(result['state']),
        'request_json': encode(result.get('request', {})),
        'done': int(result.get('done', 0)),
        'status': result.get('status', 'running'),
        'mode': result.get('mode', result.get('request', {}).get('mode', 'draft')),
        'claims_json': encode(result['claims_json']) if result.get('claims_json') is not None else '',
        'extraction_report': encode(result['extraction_report']) if result.get('extraction_report') is not None else '',
    }
'''
        keys = ['state_json', 'request_json', 'done', 'status', 'mode', 'claims_json', 'extraction_report']
        return self.node(ident, 'code', {'title': title, 'code_language': 'python3',
            'code': 'import json\n' + wrapper + '\n' + self.runtime,
            'variables': [{'variable': k, 'value_selector': v} for k, v in inputs.items()],
            'outputs': {k: {'type': 'number' if k == 'done' else 'string', 'children': None} for k in keys}}, x, y, parent)

    def build(self):
        self.node('start', 'start', {'title': 'Заморожені фрагменти джерел', 'variables': [{
            'variable': 'sources_json', 'label': 'Frozen source fragments JSON', 'type': 'paragraph',
            'required': True, 'max_length': 350000, 'options': []}]}, 80, 220)
        self.code('prepare', 'prepare', 'Перевірити джерела і розподілити пакети', {'sources_json': ['start', 'sources_json']}, 430, 220)
        self.edge('start', 'prepare')
        self.loop('batches', 'Пакети: витяг → докази та пропуски → правки', 'prepare', 90, 800, 100, 3700, 900)
        self.edge('prepare', 'batches')
        self.code('batch-request', 'batch_request', 'Поточний пакет джерел', self.inputs('batches'), 130, 180, 'batches')
        self.edge('batches-start', 'batch-request', parent='batches')
        self.conditional('batch-mode', 'Витяг чи виправлення?', ['batch-request', 'mode'], 'patch', 490, 180, 'batches')
        self.edge('batch-request', 'batch-mode', parent='batches')
        for raw, role, schema, code, operation, y, handle in [
            ('batch-editor', 'Batch editor', 'batch_patch', 'batch-patched', 'batch_patch', 20, 'true'),
            ('extractor', 'Extractor', 'draft', 'batch-drafted', 'batch_draft', 420, 'false')]:
            self.llm(raw, role, schema, 'batch-request', 850, y, 'batches')
            self.code(code, operation, 'Перевірити IDs та кандидатів', self.inputs('batch-request', raw), 1210, y, 'batches')
            self.edge('batch-mode', raw, handle, 'batches')
            self.edge(raw, code, parent='batches')
        self.node('batch-merge', 'variable-aggregator', {'title': 'Стан поточної гілки', 'output_type': 'string',
            'variables': [['batch-patched', 'state_json'], ['batch-drafted', 'state_json']],
            'advanced_settings': {'group_enabled': False, 'groups': []}}, 1570, 200, 'batches')
        for source in ['batch-patched', 'batch-drafted']:
            self.edge(source, 'batch-merge', parent='batches')
        self.code('batch-review-request', 'batch_review_request', 'Кандидати і всі фрагменти пакета',
            {'sources_json': ['start', 'sources_json'], 'state_json': ['batch-merge', 'output']}, 1930, 200, 'batches')
        self.llm('evidence-reviewer', 'Evidence reviewer', 'review', 'batch-review-request', 2290, 200, 'batches')
        self.code('batch-verdict', 'batch_review', 'Перевірити аудит доказів і повноти', self.inputs('batch-review-request', 'evidence-reviewer'), 2650, 200, 'batches')
        self.code('batch-advance', 'advance', 'Зберегти пакет або повторити правку', self.inputs('batch-verdict'), 3010, 200, 'batches')
        self.assign('batch-save', 'batch-advance', 'batches', 3370, 200)
        for source, target in [('batch-merge', 'batch-review-request'), ('batch-review-request', 'evidence-reviewer'),
            ('evidence-reviewer', 'batch-verdict'), ('batch-verdict', 'batch-advance'), ('batch-advance', 'batch-save')]:
            self.edge(source, target, parent='batches')
        self.code('batch-gate', 'gate', 'Пакети завершені', {'state_json': ['batches', 'state_json'],
            'container_done': ['batches', 'done']}, 4660, 200, gate=True)
        self.edge('batches', 'batch-gate')
        self.conditional('batches-ready', 'Докази придатні?', ['batch-gate', 'status'], 'running', 5020, 200)
        self.edge('batch-gate', 'batches-ready')
        self.code('merge-request', 'merge_request', 'Всі кандидати для об’єднання дублів', self.inputs('batch-gate'), 5380, 200)
        self.edge('batches-ready', 'merge-request', 'true')
        self.llm('deduplicator', 'Deduplicator', 'merge', 'merge-request', 5740, 200, None)
        self.code('merged', 'merge', 'Зберегти формулювання і об’єднати докази', self.inputs('merge-request', 'deduplicator'), 6100, 200)
        self.code('conflict-request', 'conflict_request', 'Факти між усіма джерелами', self.inputs('merged'), 6460, 200)
        self.llm('conflict-reviewer', 'Conflict reviewer', 'conflict', 'conflict-request', 6820, 200, None)
        self.code('conflicts', 'conflict', 'Перевірити учасників суперечностей', self.inputs('conflict-request', 'conflict-reviewer'), 7180, 200)
        for source, target in [('merge-request', 'deduplicator'), ('deduplicator', 'merged'), ('merged', 'conflict-request'),
            ('conflict-request', 'conflict-reviewer'), ('conflict-reviewer', 'conflicts')]:
            self.edge(source, target)
        self.loop('audit', 'Фінальний аудит усіх фактів та джерел', 'conflicts', 3, 7540, 100, 3010, 850)
        self.edge('conflicts', 'audit')
        self.code('global-request', 'global_request', 'Поточні факти, суперечності та повні джерела', self.inputs('audit'), 130, 180, 'audit')
        self.llm('final-auditor', 'Final auditor', 'review', 'global-request', 490, 180, 'audit')
        self.code('global-verdict', 'global_review', 'Зафіксувати аудит актуальної версії', self.inputs('global-request', 'final-auditor'), 850, 180, 'audit')
        self.code('audit-decision', 'decision', 'Готовність або ліміт виправлень', self.inputs('global-verdict'), 1210, 180, 'audit')
        self.conditional('audit-done', 'Перевірку завершено?', ['audit-decision', 'done'], '1', 1570, 180, 'audit', True)
        for source, target in [('audit-start', 'global-request'), ('global-request', 'final-auditor'),
            ('final-auditor', 'global-verdict'), ('global-verdict', 'audit-decision'), ('audit-decision', 'audit-done')]:
            self.edge(source, target, parent='audit')
        self.assign('audit-pass-save', 'audit-decision', 'audit', 1930, 20)
        self.llm('global-editor', 'Global editor', 'global_patch', 'audit-decision', 1930, 350, 'audit')
        self.code('global-patched', 'global_patch', 'Перевірити адресні виправлення', self.inputs('audit-decision', 'global-editor'), 2290, 350, 'audit')
        self.assign('audit-patch-save', 'global-patched', 'audit', 2650, 350)
        self.edge('audit-done', 'audit-pass-save', 'true', 'audit')
        self.edge('audit-done', 'global-editor', 'false', 'audit')
        self.edge('global-editor', 'global-patched', parent='audit')
        self.edge('global-patched', 'audit-patch-save', parent='audit')
        self.code('finalize', 'finalize', 'Зібрати точні докази та звіт без погодження',
            {**self.inputs('audit'), 'container_done': ['audit', 'done']}, 10600, 200, gate=True)
        self.edge('audit', 'finalize')
        self.code('batch-failure', 'finalize', 'Звіт про заблокований витяг', self.inputs('batch-gate'), 5380, 1350)
        self.edge('batches-ready', 'batch-failure', 'false')
        for key, x in [('claims_json', 10960), ('extraction_report', 11320)]:
            self.node('merge-' + key, 'variable-aggregator', {'title': key, 'output_type': 'string',
                'variables': [[source, key] for source in ['finalize', 'batch-failure']],
                'advanced_settings': {'group_enabled': False, 'groups': []}}, x, 650)
        for source in ['finalize', 'batch-failure']:
            self.edge(source, 'merge-claims_json')
        self.edge('merge-claims_json', 'merge-extraction_report')
        self.node('end', 'end', {'title': 'Кандидати фактів та аудит', 'outputs': [
            {'variable': key, 'value_type': 'string', 'value_selector': ['merge-' + key, 'output']}
            for key in ['claims_json', 'extraction_report']]}, 11680, 650)
        self.edge('merge-extraction_report', 'end')
        for node in self.nodes:
            if node['data']['type'] == 'loop':
                node['_children'] = [{'id': child['id'], 'type': child['data']['type']}
                    for child in self.nodes if child.get('parentId') == node['id']]
        self.document['workflow']['graph'] = {'nodes': self.nodes, 'edges': self.edges,
            'viewport': {'x': 20, 'y': 80, 'zoom': 0.2}}
        return self.document


def build_document():
    return ClaimsBuilder().build()


def write_document(output):
    document = build_document()
    output.write_text(yaml.dump(document, Dumper=EditorialDumper, allow_unicode=True,
        sort_keys=True, width=1000, default_flow_style=False), encoding='utf-8', newline='\n')
    if output == base.OUTPUT_PATH.resolve():
        release = {'schemaVersion': 'contextflow-dify-release-v1', 'operation': 'CLAIM_EXTRACTION',
            'releaseId': RELEASE_ID, 'contractVersion': 'claims-v1', 'promptTemplateVersion': PROMPT_VERSION,
            'promptTemplateFile': 'prompt.md', 'promptSha256': hashlib.sha256(base.PROMPT_PATH.read_bytes()).hexdigest(),
            'workflowDslFile': output.name, 'workflowDslSha256': hashlib.sha256(output.read_bytes()).hexdigest(),
            'runtimeFile': 'scripts/dify/claim_extraction_runtime.py', 'runtimeSha256': hashlib.sha256(RUNTIME.read_bytes()).hexdigest(),
            'target': {'difyVersion': '1.17.1', 'graphonVersion': '0.7.0', 'dslVersion': '0.7.0'},
            'extractionLimits': {'maxBatches': 30, 'batchFragments': 8, 'batchBytes': 40000,
                'batchRepairs': 2, 'globalRepairs': 2, 'maxClaims': 100, 'maxModelCalls': 200,
                'maxStateBytes': 350000, 'deadlineMs': 3600000},
            'reportVariable': 'extraction_report', 'reportSchemaVersion': 'claims-extraction-report-v1',
            'apiBaseEnv': 'DIFY_API_BASE_URL', 'apiKeyEnv': 'DIFY_CLAIM_EXTRACTION_API_KEY',
            'publishedWorkflowIdEnv': 'DIFY_CLAIM_EXTRACTION_PUBLISHED_WORKFLOW_ID',
            'configDigestEnv': 'DIFY_CLAIM_EXTRACTION_CONFIG_SHA256', 'inputVariable': 'sources_json',
            'outputVariable': 'claims_json', 'responseMode': 'streaming', 'provider': 'dify',
            'model': {'provider': 'langgenius/gemini/google', 'name': 'gemini-3.8-flash',
                'mode': 'chat', 'completionParams': base.completion_params(8192)}}
        release['configDigest'] = hashlib.sha256(json.dumps(release, ensure_ascii=False, sort_keys=True,
            separators=(',', ':')).encode('utf-8')).hexdigest()
        (DIRECTORY / 'release.json').write_text(json.dumps(release, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'Built {len(document["workflow"]["graph"]["nodes"])} native nodes; release {RELEASE_ID}. Remote publication is separate.')
    return 0
