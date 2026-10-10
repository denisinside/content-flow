"""Execute the actual exported outline graph with synthetic model responses."""
import copy
import json
import logging
from prompt_rendering import editorial_request
import time
import unittest

import yaml
import build_outline_generation_dsl as builder
import test_outline_generation_runtime as fixtures
from test_article_generation_graph import Factory
from graphon.runtime.variable_pool import VariablePool
from graphon.runtime.graph_runtime_state import GraphRuntimeState
from graphon.graph.graph import Graph
from graphon.graph_engine.graph_engine import GraphEngine
from graphon.graph_engine.config import GraphEngineConfig
from graphon.graph_engine.command_channels.in_memory_channel import InMemoryChannel
from graphon.graph_events.graph import GraphRunFailedEvent, GraphRunSucceededEvent


class Scenario:
    def __init__(self, mode='ready', creative=False, sections=2):
        self.editorial = fixtures.editorial(creative)
        self.mode, self.creative, self.sections, self.counts = mode, creative, sections, {}

    @staticmethod
    def issue(target, field, quote, category='clarity', severity='major'):
        return {'issueId': target + '-' + field, 'severity': severity, 'category': category,
            'targetId': target, 'field': field, 'quote': quote,
            'instruction': 'Уточнити завдання без додаткових фактів.',
            'acceptance': 'Завдання пояснено конкретно.'}

    def respond(self, node):
        self.counts[node.id] = self.counts.get(node.id, 0) + 1
        req = editorial_request(node)
        if node.id == 'strategist':
            return fixtures.strategy()
        if node.id == 'strategy-editor':
            updated = copy.deepcopy(req['strategy'])
            updated['angle'] += ' Уточнений кут.'
            return {'reviewedHash': req['reviewedHash'], 'strategy': updated}
        if node.id == 'architect':
            plan = fixtures.plan(self.creative)
            if self.sections == 30:
                seed = plan['sections'][1]
                plan['sections'] = [{**copy.deepcopy(seed), 'sectionId': 's' + str(i + 1),
                    'title': 'Розділ ' + str(i + 1), 'targetWords': 10} for i in range(30)]
            if self.mode == 'missing-required':
                plan['sections'][1]['claimRevisionIds'] = []
            return plan
        if node.id == 'outline-editor':
            plan = copy.deepcopy(req['plan'])
            for issue in req['issues']:
                if issue['targetId'] == 'article' and issue['field'] == 'sections':
                    plan['sections'].reverse()
                elif issue['targetId'] != 'article':
                    section = next(s for s in plan['sections'] if s['sectionId'] == issue['targetId'])
                    section[issue['field']] += ' Уточнення ' + str(self.counts[node.id]) + '.'
            return {'reviewedHash': req['reviewedHash'], 'plan': plan}
        issues = []
        if node.id == 'strategy-reviewer':
            blocked = self.mode == 'strategy-blocked'
            repair = self.mode in ('strategy-repair', 'worst-case') and self.counts[node.id] == 1
            if blocked or repair:
                issues = [self.issue('strategy', 'angle', req['strategy']['angle'])]
        elif node.id in ('editorial-reviewer', 'grounding-reviewer'):
            count = self.counts[node.id]
            if self.mode == 'empty-transition' and node.id == 'editorial-reviewer' and count == 1:
                issues = [self.issue(req['plan']['sections'][-1]['sectionId'], 'transition', '')]
            elif self.mode == 'reorder' and node.id == 'editorial-reviewer' and count == 1:
                issues = [self.issue('article', 'sections', '', 'sequence')]
            else:
                mode = 'editorial' if node.id == 'editorial-reviewer' else 'grounding'
                blocked = self.mode == mode + '-blocked'
                repair = self.mode == mode + '-repair' and count == 1
                worst = self.mode == 'worst-case' and count <= 2
                if blocked or repair or worst or self.mode == 'minor':
                    field = 'purpose' if mode == 'editorial' else 'keyMessage'
                    section = req['plan']['sections'][-1]
                    issues = [self.issue(section['sectionId'], field, section[field],
                        severity='minor' if self.mode == 'minor' else 'major')]
        return {'reviewedHash': '0' * 64 if self.mode == 'stale' else req['reviewedHash'], 'issues': issues}


class GraphTests(unittest.TestCase):
    def execute(self, scenario, mutate=None):
        if scenario.sections == 30:
            scenario.editorial['brief']['targetLength'] = 300
        path = builder.DIRECTORY / 'outline-generation-v1.yml'
        document = yaml.safe_load(path.read_text(encoding='utf-8'))
        self.assertEqual(document, builder.build_document(), 'Regenerate outline export before testing')
        config = document['workflow']['graph']
        if mutate:
            mutate(config)
        pool = VariablePool()
        pool.add(['start', 'editorial_json'], json.dumps(scenario.editorial, ensure_ascii=False))
        runtime = GraphRuntimeState(variable_pool=pool, start_at=time.perf_counter())
        graph = Graph.init(graph_config=config, node_factory=Factory(config, runtime, scenario.respond), root_node_id='start')
        engine = GraphEngine(workflow_id='synthetic-outline', graph=graph, graph_runtime_state=runtime,
            command_channel=InMemoryChannel(), config=GraphEngineConfig(min_workers=1, max_workers=1))
        events = []
        try:
            events.extend(engine.run())
        except RuntimeError:
            if not any(isinstance(e, GraphRunFailedEvent) for e in events):
                raise
        errors = [e.error for e in events if isinstance(e, GraphRunFailedEvent)]
        successes = [e for e in events if isinstance(e, GraphRunSucceededEvent)]
        return successes[-1].outputs if successes else None, errors

    def test_ready_factual_and_creative_preserve_contract(self):
        for creative in (False, True):
            scenario = Scenario(creative=creative)
            output, errors = self.execute(scenario)
            self.assertEqual(errors, [])
            expected = fixtures.plan(creative)
            expected = {'schemaVersion': 'outline-v1', 'content': {'title': expected['title'], 'sections': [
                {k: s[k] for k in ('title', 'purpose', 'claimRevisionIds')} for s in expected['sections']]}}
            self.assertEqual(json.loads(output['outline_json']), expected)
            report = json.loads(output['outline_report'])
            self.assertEqual(report['status'], 'ready')
            self.assertEqual(report['modelCalls'], 5)
            self.assertTrue(report['humanApprovalRequired'])

    def test_strategy_and_both_outline_reviewers_can_trigger_repairs(self):
        for mode, editor in [('strategy-repair', 'strategy-editor'), ('editorial-repair', 'outline-editor'), ('grounding-repair', 'outline-editor')]:
            scenario = Scenario(mode)
            outputs, errors = self.execute(scenario)
            self.assertEqual(errors, [], mode)
            self.assertEqual(json.loads(outputs['outline_report'])['status'], 'ready')
            self.assertEqual(scenario.counts[editor], 1)

    def test_unresolved_findings_never_return_candidates(self):
        for mode in ('strategy-blocked', 'editorial-blocked', 'grounding-blocked'):
            scenario = Scenario(mode)
            outputs, errors = self.execute(scenario)
            self.assertEqual(errors, [], mode)
            self.assertEqual(outputs['outline_json'], '')
            report = json.loads(outputs['outline_report'])
            self.assertEqual(report['status'], 'needs_human')
            self.assertTrue(report['unresolvedIssues'])
            if mode == 'strategy-blocked':
                self.assertNotIn('architect', scenario.counts)
            else:
                self.assertEqual(scenario.counts['outline-editor'], 2)

    def test_minor_findings_do_not_start_unnecessary_edits(self):
        scenario = Scenario('minor')
        outputs, errors = self.execute(scenario)
        self.assertEqual(errors, [])
        self.assertEqual(json.loads(outputs['outline_report'])['modelCalls'], 5)
        self.assertNotIn('outline-editor', scenario.counts)

    def test_structural_reorder_preserves_surviving_section_fields(self):
        outputs, errors = self.execute(Scenario('reorder'))
        self.assertEqual(errors, [])
        content = json.loads(outputs['outline_json'])['content']
        self.assertEqual(content['sections'][0]['title'], fixtures.plan()['sections'][1]['title'])
        self.assertEqual(content['sections'][1]['purpose'], fixtures.plan()['sections'][0]['purpose'])

    def test_all_thirty_sections_and_all_repairs_fit_13_calls(self):
        scenario = Scenario('worst-case', sections=30)
        outputs, errors = self.execute(scenario)
        self.assertEqual(errors, [])
        report = json.loads(outputs['outline_report'])
        self.assertEqual(report['status'], 'ready')
        self.assertEqual(report['modelCalls'], 13)
        self.assertEqual(report['strategyRevisions'], 1)
        self.assertEqual(report['outlineRevisions'], 2)
        self.assertEqual(len(json.loads(outputs['outline_json'])['content']['sections']), 30)

    def test_missing_transition_can_be_reviewed_and_added(self):
        outputs, errors = self.execute(Scenario('empty-transition'))
        self.assertEqual(errors, [])
        report = json.loads(outputs['outline_report'])
        self.assertEqual(report['status'], 'ready')
        self.assertTrue(report['sectionPlan']['sections'][-1]['transition'])
        self.assertEqual(report['sectionPlan']['sections'][-1]['purpose'], fixtures.plan()['sections'][-1]['purpose'])

    def test_stale_reviews_and_missing_required_claims_fail(self):
        for mode, error in [('stale', 'STALE_REVIEW'), ('missing-required', 'REQUIRED_COVERAGE')]:
            outputs, errors = self.execute(Scenario(mode))
            self.assertIsNone(outputs)
            self.assertTrue(any(error in e for e in errors), errors)

    def test_premature_loop_exhaustion_fails_closed(self):
        for loop, mode in [('strategy', 'strategy-repair'), ('outline', 'editorial-repair')]:
            def truncate(config):
                next(n for n in config['nodes'] if n['id'] == loop)['data']['loop_count'] = 1
            outputs, errors = self.execute(Scenario(mode), truncate)
            self.assertIsNone(outputs)
            self.assertTrue(any('OUTLINE_LOOP_EXHAUSTED' in e for e in errors), errors)


if __name__ == '__main__':
    logging.disable(logging.CRITICAL)
    unittest.main()
