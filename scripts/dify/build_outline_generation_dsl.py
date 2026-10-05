#!/usr/bin/env python3
"""Build the bounded M3.1 outline workflow using the repo's Graphon 0.7.0 reference nodes."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import yaml
import build_claim_extraction_dsl as base

ROOT = Path(__file__).resolve().parents[2]
DIRECTORY = ROOT / 'packages/backend/src/editorial/workflows/outline-generation'


def canonical(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def build_document() -> dict:
    document = base.build_document()
    document['app']['name'] = 'contentflow-outline-generation-v1'
    document['app']['description'] = 'Frozen brief and factual/creative context to an unapproved article outline candidate.'
    nodes = document['workflow']['graph']['nodes']
    start, llm, end = [item['data'] for item in nodes]
    start['title'] = 'Frozen editorial context'
    start['variables'][0].update(variable='editorial_json', label='Frozen editorial context (JSON)')
    llm['title'] = 'Suggest article outline'
    llm['prompt_template'] = [
        {'id': 'sys-outline-v1', 'role': 'system', 'text': (DIRECTORY / 'prompt.md').read_text(encoding='utf-8').rstrip()},
        {'id': 'user-outline-v1', 'role': 'user', 'text': '<editorial_json>\n{{#start.editorial_json#}}\n</editorial_json>'},
    ]
    llm['model']['completion_params'] = base.completion_params(4096)
    llm['retry_config'] = {'max_retries': 0, 'retry_enabled': False, 'retry_interval': 3000}
    section = {'type': 'object', 'additionalProperties': False, 'required': ['title', 'purpose', 'claimRevisionIds'],
               'properties': {'title': {'type': 'string', 'minLength': 1, 'maxLength': 300},
                              'purpose': {'type': 'string', 'minLength': 1, 'maxLength': 2000},
                              'claimRevisionIds': {'type': 'array', 'maxItems': 100, 'items': {'type': 'string'}}}}
    llm['structured_output']['schema'] = {'type': 'object', 'additionalProperties': False,
        'required': ['schemaVersion', 'content'], 'properties': {
            'schemaVersion': {'type': 'string', 'enum': ['outline-v1']},
            'content': {'type': 'object', 'additionalProperties': False, 'required': ['title', 'sections'],
                'properties': {'title': {'type': 'string', 'minLength': 1, 'maxLength': 500},
                               'sections': {'type': 'array', 'minItems': 1, 'maxItems': 30, 'items': section}}}}}
    end['title'] = 'Return outline-v1'
    end['outputs'][0]['variable'] = 'outline_json'
    return document


def main() -> None:
    document = build_document()
    output = DIRECTORY / 'outline-generation-v1.yml'
    body = yaml.dump(document, Dumper=base.DifyDumper, allow_unicode=True, sort_keys=True, width=1000, default_flow_style=False)
    output.write_text(body, encoding='utf-8', newline='\n')
    release = {'schemaVersion': 'contextflow-dify-release-v1', 'operation': 'OUTLINE_GENERATION',
        'releaseId': 'outline-generation-2026-10-05.2', 'contractVersion': 'outline-v1',
        'promptTemplateVersion': 'outline-generation-prompt-v1', 'promptTemplateFile': 'prompt.md',
        'promptSha256': hashlib.sha256((DIRECTORY / 'prompt.md').read_bytes()).hexdigest(),
        'workflowDslFile': output.name, 'workflowDslSha256': hashlib.sha256(output.read_bytes()).hexdigest(),
        'apiBaseEnv': 'DIFY_API_BASE_URL', 'apiKeyEnv': 'DIFY_OUTLINE_GENERATION_API_KEY',
        'publishedWorkflowIdEnv': 'DIFY_OUTLINE_GENERATION_PUBLISHED_WORKFLOW_ID',
        'configDigestEnv': 'DIFY_OUTLINE_GENERATION_CONFIG_SHA256', 'inputVariable': 'editorial_json',
        'outputVariable': 'outline_json', 'responseMode': 'streaming', 'provider': 'dify',
        'model': {'provider': 'langgenius/gemini/google', 'name': 'gemini-3.8-flash', 'mode': 'chat', 'completionParams': base.completion_params(4096)}}
    release['configDigest'] = hashlib.sha256(canonical(release).encode()).hexdigest()
    (DIRECTORY / 'release.json').write_text(json.dumps(release, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print('Built outline-v1 DSL and release descriptor; remote import/publication is separate.')


if __name__ == '__main__':
    main()
