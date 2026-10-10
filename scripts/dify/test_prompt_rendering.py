"""Regression for actual prompt delivery, including hyphenated node IDs."""
import copy
import json
import unittest
from types import SimpleNamespace

import build_article_generation_dsl as article
import build_claim_review_dsl as claims
import build_outline_generation_dsl as outline
from graphon.nodes.llm.entities import LLMNodeData
from graphon.runtime.variable_pool import VariablePool
from prompt_rendering import editorial_request, message_text, render_messages


class PromptDeliveryTests(unittest.TestCase):
    def test_every_exported_model_receives_exact_opaque_json(self):
        payload = {'versionHash': 'a' * 64, 'fragmentId': 'source-1',
            'text': 'Українська «цитата»\n<&> {{7*7}} {{#missing.value#}} {% if x %}'}
        raw = json.dumps(payload, ensure_ascii=False)
        count = 0
        for builder in (article, claims, outline):
            for node in builder.build_document()['workflow']['graph']['nodes']:
                if node['data']['type'] != 'llm':
                    continue
                with self.subTest(workflow=builder.__name__, node=node['id']):
                    data = LLMNodeData.model_validate(node['data'])
                    binding = data.prompt_config.jinja2_variables[0]
                    pool = VariablePool()
                    pool.add(binding.value_selector, raw)
                    actual = render_messages(data, pool)
                    self.assertEqual(message_text(actual[-1]), '<editorial_request>\n' + raw + '\n</editorial_request>')
                    self.assertEqual(editorial_request(SimpleNamespace(node_data=data,
                        graph_runtime_state=SimpleNamespace(variable_pool=pool))), payload)
                count += 1
        self.assertEqual(count, 23)

    def test_old_basic_hyphen_placeholder_is_not_interpolated(self):
        node = next(n for n in article.build_document()['workflow']['graph']['nodes'] if n['id'] == 'planner')
        data = copy.deepcopy(node['data'])
        data['prompt_template'][-1].update(edition_type='basic',
            text='<editorial_request>\n{{#plan-request.request_json#}}\n</editorial_request>')
        pool = VariablePool()
        pool.add(['plan-request', 'request_json'], '{"versionHash":"real"}')
        fake = SimpleNamespace(node_data=LLMNodeData.model_validate(data),
            graph_runtime_state=SimpleNamespace(variable_pool=pool))
        with self.assertRaises(json.JSONDecodeError):
            editorial_request(fake)

    def test_missing_binding_cannot_produce_valid_request(self):
        node = next(n for n in article.build_document()['workflow']['graph']['nodes'] if n['id'] == 'planner')
        fake = SimpleNamespace(node_data=LLMNodeData.model_validate(node['data']),
            graph_runtime_state=SimpleNamespace(variable_pool=VariablePool()))
        with self.assertRaises(json.JSONDecodeError):
            editorial_request(fake)


if __name__ == '__main__':
    unittest.main()
