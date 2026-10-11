"""Run the exported workflow on real Graphon 0.7.0, without any provider.

Only the LLM and sandbox executor are substituted. The actual engine performs
loop scoping, branch skipping, aggregators, assignment, Code output bounds,
graph validation and End selection. Synthetic LLM outputs obey exported schemas.
"""
import copy
import json
import logging
from prompt_rendering import editorial_request
import time
import unittest

import jsonschema
import yaml

import build_article_generation_dsl as builder
import test_article_generation_runtime as fixtures
import validate_dify_dsl as validator

from graphon.entities.graph_init_params import GraphInitParams
from graphon.enums import BuiltinNodeTypes, WorkflowNodeExecutionStatus
from graphon.graph.graph import Graph
from graphon.graph_engine.command_channels.in_memory_channel import InMemoryChannel
from graphon.graph_engine.config import GraphEngineConfig
from graphon.graph_engine.graph_engine import GraphEngine
from graphon.graph_events.graph import GraphRunFailedEvent, GraphRunSucceededEvent
from graphon.node_events.base import NodeRunResult
from graphon.nodes.base.node import Node
from graphon.nodes.code.limits import CodeNodeLimits
from graphon.nodes.llm.entities import LLMNodeData
from graphon.runtime.graph_runtime_state import GraphRuntimeState
from graphon.runtime.variable_pool import VariablePool


class LocalExecutor:
    def execute(self, *, language, code, inputs):
        namespace = {}
        exec(compile(code, '<exported-code-node>', 'exec'), namespace)
        result = namespace['main'](**inputs)
        return result

    def is_execution_error(self, error):
        return isinstance(error, (ValueError, TypeError))


class SyntheticModel(Node[LLMNodeData]):
    node_type = BuiltinNodeTypes.LLM

    @classmethod
    def version(cls):
        return '99'

    def _run(self):
        raw = self.graph_init_params.run_context['respond'](self)
        jsonschema.Draft7Validator(self.node_data.structured_output['schema']).validate(raw)
        return NodeRunResult(status=WorkflowNodeExecutionStatus.SUCCEEDED,
                             outputs={'text': json.dumps(raw, ensure_ascii=False)})


class Scenario:
    def __init__(self, editorial, mode='ready', revisions=1):
        self.editorial = editorial
        self.mode = mode
        self.revisions = revisions
        self.counts = {}
        self.section_order = []

    def respond(self, node):
        self.counts[node.id] = self.counts.get(node.id, 0) + 1
        request = editorial_request(node)
        count = self.counts[node.id]
        if node.id == 'planner':
            if self.mode == 'insufficient':
                return {'status': 'insufficient_evidence', 'reasons': ['Бракує даних для порівняння.'], 'sections': [], 'terminology': []}
            roles = ['introduction'] + ['body'] * (len(self.editorial['outline']['sections']) - 2) + ['conclusion']
            if self.mode == 'short-bookend':
                roles = ['introduction'] if len(self.editorial['outline']['sections']) == 1 else ['introduction', 'conclusion']
                return fixtures.plan(self.editorial, roles)
            return fixtures.plan(self.editorial, roles if len(roles) > 2 else None)
        if node.id == 'plan-reviewer':
            issues = [fixtures.issue(bid='plan', quote='Від умов.')] if self.mode == 'plan-repair' and count == 1 else []
            return {'versionHash': request['versionHash'], 'issues': issues, 'resolvedIssueIds': []}
        if node.id == 'section-writer':
            sid = request['section']['sectionId']
            self.section_order.append(sid)
            value = fixtures.block(sid, self.editorial['contentMode'] == 'FACTUAL')
            if self.mode in ('under-length', 'over-length', 'persistent-short'):
                value['spans'][0]['text'] = fixtures.synthetic_prose(words=121 if self.mode == 'over-length' else 79)
            if self.editorial['contentMode'] == 'CREATIVE':
                value['spans'][0].update(claimRevisionId='', evidenceId='')
            return {'sectionId': sid, 'blocks': [value]}
        if node.id == 'section-reviewer':
            sid = request['section']['sectionId']
            local = self.mode in ('local-repair', 'worst-case') and 'Виправлено' not in request['currentBlocks'][0]['spans'][0]['text']
            if self.mode == 'worst-case':
                local = not request['currentBlocks'][0]['spans'][0]['text'].endswith('2.')
            issues = [fixtures.issue(sid)] if local else []
            return {'versionHash': request['versionHash'], 'issues': issues, 'resolvedIssueIds': []}
        if node.id in ('section-editor', 'global-editor'):
            feedback = request['feedback']
            issues = feedback['issues'] if isinstance(feedback, dict) else feedback
            replacements = []
            seen = set()
            for issue in issues:
                key = issue['sectionId'], issue['blockId']
                if key in seen or issue['blockId'] in ('title', 'heading'):
                    continue
                seen.add(key)
                rows = request['currentBlocks'] if node.id == 'section-editor' else request['sections'][key[0]]
                current = copy.deepcopy(next(b for b in rows if b['id'] == key[1]))
                if self.mode == 'no-progress':
                    pass
                elif self.mode == 'corrected-short-noop' and count > 1:
                    pass
                elif self.mode in ('corrected-short', 'corrected-short-noop', 'persistent-short', 'corrected-overlong'):
                    words = 121 + count if self.mode == 'corrected-overlong' else 80 - count
                    current['spans'][0]['text'] = fixtures.synthetic_prose('Виправлено: результат залежить від умов.', words=words)
                elif self.mode == 'worst-case':
                    text = current['spans'][0]['text']
                    current['spans'][0]['text'] = fixtures.synthetic_prose('Результат виправлено', suffix='2.' if text.endswith('1.') else '1.')
                elif self.mode == 'unresolved':
                    current['spans'][0]['text'] = fixtures.synthetic_prose(f'Виправлено {count}: результат залежить від умов.')
                else:
                    current['spans'][0]['text'] = fixtures.synthetic_prose('Виправлено: результат залежить від умов.')
                for span in current['spans']:
                    span.setdefault('claimRevisionId', '')
                    span.setdefault('evidenceId', '')
                replacements.append({'sectionId': key[0], 'blockId': key[1], 'block': current})
            return {'versionHash': request['versionHash'], 'replacements': replacements}
        issues = []
        if node.id == 'global-reviewer':
            if self.mode in ('global-repair', 'no-progress') and count == 1:
                issues = [fixtures.issue()]
            if self.mode in ('corrected-short', 'corrected-short-noop', 'corrected-overlong') and count == 1:
                issues = [fixtures.issue(severity='minor')]
            if self.mode == 'unresolved':
                quote = request['sections']['s1'][0]['spans'][0]['text'][:10]
                issues = [fixtures.issue(quote=quote, severity='critical')]
            if self.mode == 'immutable':
                issues = [fixtures.issue(bid='title', quote='Тестова', severity='critical')]
        return {'versionHash': request['versionHash'], 'issues': issues, 'resolvedIssueIds': []}


class Factory:
    def __init__(self, graph, runtime, respond):
        self.runtime = runtime
        self.params = GraphInitParams(workflow_id='synthetic-editorial', graph_config=graph,
            run_context={'respond': respond}, call_depth=0)
        self.mapping = validator._graphon_mapping('0.7.0')[0]

    def with_runtime_state(self, runtime):
        clone = copy.copy(self)
        clone.runtime = runtime
        return clone

    def create_node(self, config):
        data = config['data']
        cls = SyntheticModel if data['type'] == 'llm' else self.mapping[data['type']][data.get('version', '1')]
        kwargs = {'graph_init_params': self.params, 'graph_runtime_state': self.runtime}
        if data['type'] == 'code':
            kwargs.update(code_executor=LocalExecutor(), code_limits=CodeNodeLimits(
                max_string_length=400000, max_number=1e100, min_number=-1e100, max_precision=20,
                max_depth=5, max_number_array_length=1000, max_string_array_length=30, max_object_array_length=30))
        return cls(node_id=config['id'], data=cls.validate_node_data(data), **kwargs)


class GraphTests(unittest.TestCase):
    def execute(self, scenario, mutate=None):
        path = builder.DIRECTORY / 'article-generation-v1.yml'
        document = yaml.safe_load(path.read_text(encoding='utf-8'))
        self.assertEqual(document, builder.build_document(), 'Regenerate the YAML before graph tests')
        graph_config = document['workflow']['graph']
        if mutate:
            mutate(graph_config)
        pool = VariablePool()
        pool.add(['start', 'editorial_json'], json.dumps(scenario.editorial, ensure_ascii=False))
        runtime = GraphRuntimeState(variable_pool=pool, start_at=time.perf_counter())
        graph = Graph.init(graph_config=graph_config, node_factory=Factory(graph_config, runtime, scenario.respond), root_node_id='start')
        engine = GraphEngine(workflow_id='synthetic-editorial', graph=graph, graph_runtime_state=runtime,
            command_channel=InMemoryChannel(), config=GraphEngineConfig(min_workers=1, max_workers=1))
        events = []
        try:
            events.extend(engine.run())
        except RuntimeError:
            if not any(isinstance(e, GraphRunFailedEvent) for e in events):
                raise
        failures = [e.error for e in events if isinstance(e, GraphRunFailedEvent)]
        succeeded = [e for e in events if isinstance(e, GraphRunSucceededEvent)]
        return succeeded[-1].outputs if succeeded else None, failures

    def test_full_export_factual_and_creative(self):
        for factual in (True, False):
            scenario = Scenario(fixtures.fixture(factual, 3))
            output, errors = self.execute(scenario)
            self.assertEqual(errors, [])
            self.assertEqual(json.loads(output['editorial_report'])['status'], 'ready')
            article = json.loads(output['article_json'])
            headings = [n['content'][0]['text'] for n in article['content']['document']['content'] if n['type'] == 'heading']
            self.assertEqual(headings, ['Розділ 1', 'Розділ 2', 'Розділ 3'])
            self.assertEqual(scenario.section_order, ['s2', 's1', 's3'])

    def test_no_progress_editor_stops_with_report_and_no_candidate(self):
        output, errors = self.execute(Scenario(fixtures.fixture(False), 'no-progress'))
        self.assertEqual(errors, [])
        self.assertEqual(output['article_json'], '')
        report = json.loads(output['editorial_report'])
        self.assertEqual(report['status'], 'needs_human')
        self.assertEqual(report['reasons'], ['EDITOR_NO_PROGRESS'])

    def test_short_bookends_generate_and_false_length_pass_is_blocked(self):
        for count in (1, 2):
            scenario = Scenario(fixtures.fixture(False, count), 'short-bookend')
            output, errors = self.execute(scenario)
            self.assertEqual(errors, [])
            self.assertEqual(json.loads(output['editorial_report'])['status'], 'ready')
            self.assertEqual(scenario.section_order, ['s' + str(i + 1) for i in range(count)])
        for mode in ('under-length', 'over-length'):
            output, errors = self.execute(Scenario(fixtures.fixture(False), mode))
            self.assertEqual(errors, [])
            report = json.loads(output['editorial_report'])
            self.assertEqual(report['status'], 'ready')
            self.assertEqual(report['globalRevisions'], 1)
            self.assertEqual(report['metrics']['wordCount'], 100)

    def test_corrected_short_text_survives_budget_or_length_only_noop(self):
        for mode, words in [('corrected-short', 78), ('corrected-short-noop', 79)]:
            output, errors = self.execute(Scenario(fixtures.fixture(False), mode))
            self.assertEqual(errors, [], mode)
            report = json.loads(output['editorial_report'])
            self.assertEqual(report['status'], 'ready')
            self.assertFalse(report['restoredEarlierVersion'])
            self.assertEqual(report['metrics']['wordCount'], words)
            self.assertEqual(report['warnings'], ['ARTICLE_SHORTER_AFTER_EDIT'])
            self.assertIn('Виправлено', output['article_json'])

    def test_initial_short_and_edited_overlong_stay_blocked(self):
        for mode in ('persistent-short', 'corrected-overlong'):
            output, errors = self.execute(Scenario(fixtures.fixture(False), mode))
            self.assertEqual(errors, [], mode)
            report = json.loads(output['editorial_report'])
            self.assertEqual(output['article_json'], '')
            self.assertEqual(report['status'], 'needs_human')
            self.assertEqual(report['reasons'], ['ARTICLE_LENGTH_OUT_OF_RANGE'])
            self.assertFalse(report['restoredEarlierVersion'])

    def test_plan_section_and_global_revision_branches(self):
        for mode, counter in [('plan-repair', 'planner'), ('local-repair', 'section-editor'), ('global-repair', 'global-editor')]:
            scenario = Scenario(fixtures.fixture(), mode)
            output, errors = self.execute(scenario)
            self.assertEqual(errors, [], mode)
            self.assertEqual(json.loads(output['editorial_report'])['status'], 'ready', mode)
            self.assertGreaterEqual(scenario.counts[counter], 1)
            if mode == 'plan-repair':
                self.assertEqual(scenario.counts[counter], 2)

    def test_insufficient_material_and_immutable_title_have_report_without_candidate(self):
        for mode in ('insufficient', 'immutable'):
            scenario = Scenario(fixtures.fixture(), mode)
            output, errors = self.execute(scenario)
            self.assertEqual(errors, [])
            self.assertEqual(output['article_json'], '')
            report = json.loads(output['editorial_report'])
            self.assertEqual(report['status'], 'insufficient_evidence' if mode == 'insufficient' else 'needs_human')

    def test_two_global_repairs_are_bounded_and_never_pass_critical_issues(self):
        scenario = Scenario(fixtures.fixture(), 'unresolved')
        output, errors = self.execute(scenario)
        self.assertEqual(errors, [])
        self.assertEqual(scenario.counts['global-editor'], 2)
        self.assertEqual(scenario.counts['factual-reviewer'], 3)
        self.assertEqual(output['article_json'], '')
        self.assertEqual(json.loads(output['editorial_report'])['status'], 'needs_human')

    def test_native_section_loop_handles_all_thirty_sections_and_two_repairs(self):
        scenario = Scenario(fixtures.fixture(False, 30), 'worst-case')
        output, errors = self.execute(scenario)
        self.assertEqual(errors, [])
        self.assertEqual(scenario.counts['section-editor'], 60)
        report = json.loads(output['editorial_report'])
        self.assertEqual(report['status'], 'ready')
        self.assertEqual(report['modelCalls'], 185)

    def test_exhausted_native_loop_cannot_succeed_with_incomplete_article(self):
        def shorten(graph):
            next(n for n in graph['nodes'] if n['id'] == 'sections')['data']['loop_count'] = 1
        output, errors = self.execute(Scenario(fixtures.fixture(True, 3)), shorten)
        self.assertIsNone(output)
        self.assertTrue(any('EDITORIAL_LOOP_EXHAUSTED' in e for e in errors))


if __name__ == '__main__':
    logging.disable(logging.CRITICAL)
    unittest.main()
