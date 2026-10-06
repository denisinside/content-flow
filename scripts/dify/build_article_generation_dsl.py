#!/usr/bin/env python3
"""Generate the bounded article-v1 native Graphon 0.7.0 workflow."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import yaml
import build_claim_extraction_dsl as base

ROOT = Path(__file__).resolve().parents[2]
DIRECTORY = ROOT / 'packages/backend/src/editorial/workflows/article-generation'


def canonical(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def article_schema() -> dict:
    # Native JSON Schema recursion keeps the graph small. Application validation
    # additionally checks legal parent/child combinations, depth and byte bounds.
    mark = {'anyOf': [
        {'type': 'object', 'additionalProperties': False, 'required': ['type'],
         'properties': {'type': {'type': 'string', 'enum': ['bold', 'italic', 'strike']}}},
        {'type': 'object', 'additionalProperties': False, 'required': ['type', 'attrs'],
         'properties': {'type': {'type': 'string', 'enum': ['evidence']}, 'attrs': {
             'type': 'object', 'additionalProperties': False,
             'required': ['claimRevisionId', 'evidenceId', 'quote'], 'properties': {
                 'claimRevisionId': {'type': 'string'}, 'evidenceId': {'type': 'string'},
                 'quote': {'type': 'string', 'minLength': 1, 'maxLength': 10000}}}}}]}
    node = {'type': 'object', 'additionalProperties': False, 'required': ['type'], 'properties': {
        'type': {'type': 'string', 'enum': ['doc', 'paragraph', 'heading', 'bulletList', 'orderedList', 'listItem', 'blockquote', 'text', 'hardBreak']},
        'attrs': {'type': 'object', 'additionalProperties': False, 'required': ['level'], 'properties': {'level': {'type': 'integer', 'enum': [2, 3]}}},
        'text': {'type': 'string', 'minLength': 1, 'maxLength': 100000},
        'marks': {'type': 'array', 'maxItems': 4, 'items': mark},
        'content': {'type': 'array', 'maxItems': 1000, 'items': {'$ref': '#/$defs/node'}}}}
    return {'type': 'object', 'additionalProperties': False, '$defs': {'node': node},
        'required': ['schemaVersion', 'content'], 'properties': {
            'schemaVersion': {'type': 'string', 'enum': ['article-v1']},
            'content': {'type': 'object', 'additionalProperties': False, 'required': ['title', 'document'],
                'properties': {'title': {'type': 'string', 'minLength': 1, 'maxLength': 500},
                               'document': {'$ref': '#/$defs/node'}}}}}


def build_document() -> dict:
    document = base.build_document()
    document['app']['name'] = 'contentflow-article-generation-v1'
    document['app']['description'] = 'Frozen approved outline, brief and exact factual/creative context to an unapproved article candidate.'
    start, llm, end = [item['data'] for item in document['workflow']['graph']['nodes']]
    start['title'] = 'Frozen article context'
    start['variables'][0].update(variable='editorial_json', label='Frozen article context (JSON)')
    llm['title'] = 'Draft article candidate'
    llm['prompt_template'] = [
        {'id': 'sys-article-v1', 'role': 'system', 'text': (DIRECTORY / 'prompt.md').read_text(encoding='utf-8').rstrip()},
        {'id': 'user-article-v1', 'role': 'user', 'text': '<editorial_json>\n{{#start.editorial_json#}}\n</editorial_json>'}]
    llm['model']['completion_params'] = base.completion_params(8192)
    llm['retry_config'] = {'max_retries': 0, 'retry_enabled': False, 'retry_interval': 3000}
    llm['structured_output']['schema'] = article_schema()
    end['title'] = 'Return article-v1'
    end['outputs'][0]['variable'] = 'article_json'
    return document


def main() -> None:
    document = build_document()
    output = DIRECTORY / 'article-generation-v1.yml'
    output.write_text(yaml.dump(document, Dumper=base.DifyDumper, allow_unicode=True,
        sort_keys=True, width=1000, default_flow_style=False), encoding='utf-8', newline='\n')
    release = {'schemaVersion': 'contextflow-dify-release-v1', 'operation': 'ARTICLE_GENERATION',
        'releaseId': 'article-generation-2026-10-06.1', 'contractVersion': 'article-v1',
        'promptTemplateVersion': 'article-generation-prompt-v1', 'promptTemplateFile': 'prompt.md',
        'promptSha256': hashlib.sha256((DIRECTORY / 'prompt.md').read_bytes()).hexdigest(),
        'workflowDslFile': output.name, 'workflowDslSha256': hashlib.sha256(output.read_bytes()).hexdigest(),
        'apiBaseEnv': 'DIFY_API_BASE_URL', 'apiKeyEnv': 'DIFY_ARTICLE_GENERATION_API_KEY',
        'publishedWorkflowIdEnv': 'DIFY_ARTICLE_GENERATION_PUBLISHED_WORKFLOW_ID',
        'configDigestEnv': 'DIFY_ARTICLE_GENERATION_CONFIG_SHA256', 'inputVariable': 'editorial_json',
        'outputVariable': 'article_json', 'responseMode': 'streaming', 'provider': 'dify',
        'model': {'provider': 'langgenius/gemini/google', 'name': 'gemini-3.8-flash', 'mode': 'chat', 'completionParams': base.completion_params(8192)}}
    release['configDigest'] = hashlib.sha256(canonical(release).encode()).hexdigest()
    (DIRECTORY / 'release.json').write_text(json.dumps(release, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print('Built article-v1 DSL and release descriptor; remote import/publication is separate.')


if __name__ == '__main__':
    main()
