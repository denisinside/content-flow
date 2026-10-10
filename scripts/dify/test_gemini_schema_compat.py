"""Regression checks on model-facing schemas for the three actual exports."""
import unittest

import build_article_generation_dsl as article
import build_claim_review_dsl as claims
import build_outline_generation_dsl as outline


def walk(schema):
    if isinstance(schema, dict):
        yield schema
        for value in schema.values():
            yield from walk(value)
    elif isinstance(schema, list):
        for value in schema:
            yield from walk(value)


class GeminiSchemaCompatibility(unittest.TestCase):
    def test_all_exported_model_schemas_preserve_limits_without_native_max_items(self):
        # Inspect every exported LLM, including editors/reviewers inside loops,
        # so a new role cannot quietly reintroduce the live rejection trigger.
        for builder in (claims.ClaimsBuilder, outline.OutlineBuilder, article.Builder):
            document = builder().build()
            count = 0
            for node in document['workflow']['graph']['nodes']:
                if node['data']['type'] != 'llm':
                    continue
                count += 1
                schema = node['data']['structured_output']['schema']
                with self.subTest(builder=builder.__name__, node=node['id']):
                    for value in walk(schema):
                        self.assertNotIn('maxItems', value)
                        if value.get('type') == 'array':
                            self.assertIn('minItems', value)
                            self.assertRegex(value['description'], r'^Return at most [1-9][0-9]* items\.$')
                        if value.get('type') == 'string' and 'enum' not in value:
                            self.assertIn('maxLength', value)
                            self.assertIn('minLength', value)
            self.assertGreater(count, 0)


if __name__ == '__main__':
    unittest.main()
