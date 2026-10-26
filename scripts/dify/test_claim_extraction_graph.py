"""Execute exported extraction on real Graphon with synthetic model responses."""
import copy
import json
import logging
from prompt_rendering import editorial_request
import time
import unittest

import yaml
import build_claim_review_dsl as builder
import test_claim_extraction_runtime as fixtures
from test_article_generation_graph import Factory
from graphon.runtime.variable_pool import VariablePool
from graphon.runtime.graph_runtime_state import GraphRuntimeState
from graphon.graph.graph import Graph
from graphon.graph_engine.graph_engine import GraphEngine
from graphon.graph_engine.config import GraphEngineConfig
from graphon.graph_engine.command_channels.in_memory_channel import InMemoryChannel
from graphon.graph_events.graph import GraphRunFailedEvent, GraphRunSucceededEvent


class Scenario:
    def __init__(self, count=2, mode='ready'):
        self.sources = fixtures.sources(count)
        self.mode, self.counts = mode, {}
        self.batch_review_requests, self.global_review_requests = [], []
        self.global_request_sizes = []

    def respond(self, node):
        self.counts[node.id] = self.counts.get(node.id, 0) + 1
        request = editorial_request(node)
        if node.id == 'extractor':
            if self.mode == 'empty':
                return {'claims': []}
            batch = int(request['batchId'][1:])
            if self.mode == 'multi-packet':
                return {'claims': [fixtures.claim(i + 1, f['id'], batch=batch)
                                   for i, f in enumerate(request['fragments'][:20])]}
            if self.mode in ('five-hundred-short', 'over-500-short'):
                return {'claims': [fixtures.claim(i + 1, f['id'], batch=batch)
                                   for i, f in enumerate(request['fragments'][:20])]}
            if self.mode in ('worst-case', 'worst-case-with-review-retries'):
                claim = fixtures.claim(1, request['fragments'][0]['id'], batch=batch)
                claim['evidence'] = [{'fragmentId': f['id'], 'relation': 'SUPPORTS'} for f in request['fragments'][:10]]
                return {'claims': [claim]}
            return {'claims': [fixtures.claim(i + 1, f['id'], batch=batch) for i, f in enumerate(request['fragments'])]}
        if node.id in ('batch-editor', 'global-editor'):
            claims = copy.deepcopy(request['claims'])
            for issue in request['feedback']:
                claim = next(c for c in claims if c['key'] == issue['claimKey'])
                if node.id == 'batch-editor':
                    round_number = 2 if claim['wording'].endswith('правка 1.') else 1
                    claim['wording'] = f'Дослідження охопило 12 учасників: правка {round_number}.'
                else:
                    count = self.counts[node.id]
                    claim['wording'] = f'Дослідження охопило 12 учасників: фінальна правка {count}.'
            if node.id == 'global-editor':
                feedback_keys = {issue['claimKey'] for issue in request['feedback'] if issue['claimKey']}
                updates = [claim for claim, original in zip(claims, request['claims'])
                           if claim['key'] in feedback_keys and claim != original]
                result = {'versionHash': request['versionHash'], 'updates': updates, 'additions': [], 'removals': []}
            else:
                result = {'versionHash': request['versionHash'], 'claims': claims}
            if node.id == 'global-editor':
                result['conflicts'] = request['conflicts']
            return result
        if node.id == 'deduplicator':
            keys = [c['key'] for c in request['claims']]
            groups = [{'claimKeys': keys}] if self.mode == 'dedup' else []
            return {'versionHash': request['versionHash'], 'groups': groups}
        if node.id == 'conflict-reviewer':
            conflicts = [{'claimKeys': [c['key'] for c in request['claims']], 'rationale': 'Джерела описують несумісні результати.'}] if self.mode == 'conflict' else []
            return {'versionHash': request['versionHash'], 'conflicts': conflicts}
        if node.id == 'evidence-reviewer':
            self.batch_review_requests.append(copy.deepcopy(request))
        if node.id == 'final-auditor':
            self.global_review_requests.append(copy.deepcopy(request))
            self.global_request_sizes.append((len(json.dumps(request, ensure_ascii=False)),
                                              len(json.dumps(request, ensure_ascii=False).encode('utf-8'))))
        coverage = []
        for fragment in request['fragments']:
            keys = [c['key'] for c in request['claims'] if any(e['fragmentId'] == fragment['id'] for e in c['evidence'])]
            coverage.append({'fragmentId': fragment['id'], 'disposition': 'covered' if keys else 'no_factual_claims', 'claimKeys': keys})
        issues = []
        for claim in request['claims']:
            local = node.id == 'evidence-reviewer' and (
                self.mode in ('local-repair', 'local-blocked', 'worst-case', 'worst-case-with-review-retries'))
            global_ = node.id == 'final-auditor' and self.mode in ('global-repair', 'global-blocked', 'worst-case', 'worst-case-with-review-retries')
            if local:
                local = self.mode == 'local-blocked' or not claim['wording'].endswith('правка 2.' if self.mode in ('worst-case', 'worst-case-with-review-retries') else 'правка 1.')
            if global_:
                global_ = self.mode == 'global-blocked' or not claim['wording'].endswith('фінальна правка 2.' if self.mode in ('worst-case', 'worst-case-with-review-retries') else 'фінальна правка 1.')
            if local or global_:
                issues.append({'id': 'issue-' + claim['key'], 'severity': 'major', 'category': 'entailment',
                    'claimKey': claim['key'], 'fragmentId': '', 'quote': claim['wording'],
                    'instruction': 'Уточнити формулювання без зміни факту.', 'acceptance': 'Умови збережено.'})
        if node.id == 'final-auditor':
            batch_coverage = copy.deepcopy(request['batchManifest'])
            invalid = self.mode == 'global-review-invalid-always' or (
                self.mode == 'global-review-invalid-once' and self.counts[node.id] == 1)
            invalid = invalid or (self.mode == 'worst-case-with-review-retries' and self.counts[node.id] == 1)
            if invalid:
                batch_coverage.pop()
            return {'versionHash': request['versionHash'], 'issues': issues, 'batchCoverage': batch_coverage}
        invalid = self.mode == 'batch-review-invalid-always' or (
            self.mode == 'batch-review-invalid-once' and self.counts[node.id] == 1)
        invalid = invalid or (self.mode == 'worst-case-with-review-retries' and self.counts[node.id] == 1)
        if invalid and coverage and coverage[0]['claimKeys']:
            coverage[0] = {'fragmentId': coverage[0]['fragmentId'], 'disposition': 'no_factual_claims', 'claimKeys': []}
        return {'versionHash': request['versionHash'], 'issues': issues, 'coverage': coverage}


class GraphTests(unittest.TestCase):
    def execute(self, scenario, mutate=None):
        path = builder.DIRECTORY / 'claim-extraction-v1.yml'
        document = yaml.safe_load(path.read_text(encoding='utf-8'))
        self.assertEqual(document, builder.build_document(), 'Regenerate exported extraction first')
        config = document['workflow']['graph']
        if mutate:
            mutate(config)
        pool = VariablePool()
        pool.add(['start', 'sources_json'], json.dumps(scenario.sources, ensure_ascii=False))
        runtime = GraphRuntimeState(variable_pool=pool, start_at=time.perf_counter())
        graph = Graph.init(graph_config=config, node_factory=Factory(config, runtime, scenario.respond), root_node_id='start')
        engine = GraphEngine(workflow_id='synthetic-claims', graph=graph, graph_runtime_state=runtime,
            command_channel=InMemoryChannel(), config=GraphEngineConfig(min_workers=1, max_workers=1))
        events = []
        try:
            events.extend(engine.run())
        except RuntimeError:
            if not any(isinstance(e, GraphRunFailedEvent) for e in events):
                raise
        errors = [e.error for e in events if isinstance(e, GraphRunFailedEvent)]
        if errors:
            def summary(event):
                result = getattr(event, 'node_run_result', None)
                outputs = getattr(result, 'outputs', {}) or {}
                return (type(event).__name__, getattr(event, 'node_id', None),
                        getattr(getattr(result, 'status', None), 'value', None),
                        {key: len(value) if isinstance(value, str) else type(value).__name__ for key, value in outputs.items()},
                        getattr(result, 'error', None), getattr(event, 'error', None))
            print([summary(event) for event in events[-12:]])
        successes = [e for e in events if isinstance(e, GraphRunSucceededEvent)]
        return successes[-1].outputs if successes else None, errors

    def test_ready_exact_quotes_and_multi_packet_keys(self):
        scenario = Scenario(33, 'multi-packet')
        outputs, errors = self.execute(scenario)
        self.assertEqual(errors, [])
        result = json.loads(outputs['claims_json'])
        self.assertEqual(len(result['claims']), 21)
        self.assertEqual(result['claims'][-1]['key'], 'b2-c1')
        original = {f['id']: f for f in scenario.sources[0]['fragments']}
        for claim in result['claims']:
            for evidence in claim['evidence']:
                f = original[evidence['fragmentId']]
                self.assertEqual(evidence['quote'], f['text'])
                self.assertEqual(evidence['sha256'], f['sha256'])
                self.assertEqual(evidence['startOffset'], f['startOffset'])
        report = json.loads(outputs['extraction_report'])
        self.assertEqual(report['status'], 'ready')
        self.assertEqual(report['modelCalls'], 7)

    def test_dedup_retains_all_evidence_and_conflicts_remain_proposed(self):
        for mode in ('dedup', 'conflict'):
            outputs, errors = self.execute(Scenario(mode=mode))
            self.assertEqual(errors, [])
            result = json.loads(outputs['claims_json'])
            if mode == 'dedup':
                self.assertEqual(len(result['claims']), 1)
                self.assertEqual(len(result['claims'][0]['evidence']), 2)
            else:
                self.assertEqual(len(result['claims']), 2)
                self.assertEqual(len(result['conflicts']), 1)
            self.assertTrue(json.loads(outputs['extraction_report'])['humanApprovalRequired'])

    def test_local_and_global_repair_branches(self):
        for mode, editor in [('local-repair', 'batch-editor'), ('global-repair', 'global-editor')]:
            scenario = Scenario(mode=mode)
            outputs, errors = self.execute(scenario)
            self.assertEqual(errors, [], mode)
            self.assertEqual(json.loads(outputs['extraction_report'])['status'], 'ready')
            self.assertEqual(scenario.counts[editor], 1)

    def test_batch_structural_retry_reuses_exact_candidates_and_version(self):
        scenario = Scenario(mode='batch-review-invalid-once')
        outputs, errors = self.execute(scenario)
        self.assertEqual(errors, [])
        report = json.loads(outputs['extraction_report'])
        self.assertEqual(report['status'], 'ready')
        self.assertEqual(report['modelCalls'], 6)
        self.assertEqual(scenario.counts['extractor'], 1)
        self.assertEqual(scenario.counts.get('batch-editor', 0), 0)
        self.assertEqual(scenario.counts['evidence-reviewer'], 2)
        first, retry = scenario.batch_review_requests
        self.assertEqual(retry['validationCode'], 'COVERAGE_EMPTY')
        self.assertEqual(retry['versionHash'], first['versionHash'])
        self.assertEqual(retry['claims'], first['claims'])
        self.assertEqual(retry['fragments'], first['fragments'])
        self.assertEqual(retry['expectedCoverage'][0]['claimKeys'], ['b1-c1'])

    def test_global_structural_retry_reuses_exact_candidates_and_version(self):
        scenario = Scenario(mode='global-review-invalid-once')
        outputs, errors = self.execute(scenario)
        self.assertEqual(errors, [])
        report = json.loads(outputs['extraction_report'])
        self.assertEqual(report['status'], 'ready')
        self.assertEqual(report['modelCalls'], 6)
        self.assertEqual(scenario.counts.get('global-editor', 0), 0)
        self.assertEqual(scenario.counts['final-auditor'], 2)
        first, retry = scenario.global_review_requests
        self.assertEqual(retry['validationCode'], 'GLOBAL_COVERAGE_INCOMPLETE')
        self.assertEqual(retry['versionHash'], first['versionHash'])
        self.assertEqual(retry['claims'], first['claims'])
        self.assertEqual(retry['conflicts'], first['conflicts'])

    def test_review_validation_retry_exhaustion_returns_no_candidates(self):
        for mode, reviewer, expected_calls in [
            ('batch-review-invalid-always', 'evidence-reviewer', 4),
            ('global-review-invalid-always', 'final-auditor', 7),
        ]:
            with self.subTest(mode=mode):
                scenario = Scenario(mode=mode)
                outputs, errors = self.execute(scenario)
                self.assertEqual(errors, [])
                self.assertEqual(outputs['claims_json'], '')
                report = json.loads(outputs['extraction_report'])
                self.assertEqual(report['status'], 'needs_human')
                self.assertEqual(report['reason'], 'REVIEW_VALIDATION_LIMIT')
                self.assertEqual(report['modelCalls'], expected_calls)
                self.assertEqual(scenario.counts[reviewer], 3)

    def test_unresolved_local_and_global_findings_emit_no_candidates(self):
        for mode, editor in [('local-blocked', 'batch-editor'), ('global-blocked', 'global-editor')]:
            scenario = Scenario(mode=mode)
            outputs, errors = self.execute(scenario)
            self.assertEqual(errors, [], mode)
            self.assertEqual(outputs['claims_json'], '')
            report = json.loads(outputs['extraction_report'])
            self.assertEqual(report['status'], 'needs_human')
            self.assertTrue(report['unresolvedIssues'])
            self.assertEqual(scenario.counts[editor], 2)

    def test_empty_sources_get_reviewed_empty_result(self):
        scenario = Scenario(mode='empty')
        for source in scenario.sources:
            for fragment in source['fragments']:
                fragment['text'] = 'Вступ.'
                fragment['sha256'] = fixtures.hashlib.sha256(fragment['text'].encode()).hexdigest()
                fragment['endOffset'] = fragment['startOffset'] + len(fragment['text'])
        outputs, errors = self.execute(scenario)
        self.assertEqual(errors, [])
        self.assertEqual(json.loads(outputs['claims_json']), {'schemaVersion': 'claims-v1', 'claims': [], 'conflicts': []})
        self.assertEqual(json.loads(outputs['extraction_report'])['modelCalls'], 5)

    def test_all_thirty_packets_and_all_repairs_fit_budget(self):
        scenario = Scenario(960, 'worst-case')
        outputs, errors = self.execute(scenario)
        self.assertEqual(errors, [])
        report = json.loads(outputs['extraction_report'])
        self.assertEqual(report['status'], 'ready')
        self.assertEqual(report['modelCalls'], 187)
        self.assertEqual(len(report['batchHistory']), 30)
        self.assertEqual(scenario.counts['batch-editor'], 60)
        self.assertEqual(scenario.counts['global-editor'], 2)

    def test_five_hundred_short_candidates_complete_end_to_end_with_bounded_envelopes(self):
        scenario = Scenario(800, 'five-hundred-short')
        outputs, errors = self.execute(scenario)
        self.assertEqual(errors, [])
        result = json.loads(outputs['claims_json'])
        report = json.loads(outputs['extraction_report'])
        self.assertEqual(report['status'], 'ready')
        self.assertEqual(len(result['claims']), 500)
        self.assertEqual([row['claimCount'] for row in report['batchHistory']], [20] * 25)
        self.assertEqual(len(scenario.global_request_sizes), 1)
        request_chars, request_bytes = scenario.global_request_sizes[0]
        self.assertLessEqual(request_chars, fixtures.runtime.MAX_CODE_OUTPUT_CHARS)
        self.assertLessEqual(request_bytes, fixtures.runtime.MAX_BYTES)
        self.assertLessEqual(len(outputs['claims_json']), fixtures.runtime.MAX_CODE_OUTPUT_CHARS)
        self.assertLessEqual(len(outputs['claims_json'].encode('utf-8')), fixtures.runtime.MAX_BYTES)

    def test_candidate_overflow_fails_instead_of_skipping_later_packets(self):
        scenario = Scenario(960, 'over-500-short')
        outputs, errors = self.execute(scenario)
        self.assertIsNone(outputs)
        self.assertTrue(any('CLAIMS_WORKFLOW_CLAIM_LIMIT' in error for error in errors), errors)
        self.assertEqual(scenario.counts['extractor'], 26)

    def test_all_repairs_and_shared_review_retries_fit_189_call_budget(self):
        scenario = Scenario(960, 'worst-case-with-review-retries')
        outputs, errors = self.execute(scenario)
        self.assertEqual(errors, [])
        report = json.loads(outputs['extraction_report'])
        self.assertEqual(report['status'], 'ready')
        self.assertEqual(report['modelCalls'], 189)
        self.assertEqual(report['modelCalls'], 187 + 2)
        self.assertEqual(scenario.counts['batch-editor'], 60)
        self.assertEqual(scenario.counts['global-editor'], 2)
        self.assertEqual(scenario.counts['evidence-reviewer'], 91)
        self.assertEqual(scenario.counts['final-auditor'], 4)
        self.assertEqual(report['modelCalls'], sum(scenario.counts.values()))

    def test_truncated_loop_fails_closed(self):
        def truncate(config):
            next(n for n in config['nodes'] if n['id'] == 'batches')['data']['loop_count'] = 1
        outputs, errors = self.execute(Scenario(33, 'multi-packet'), truncate)
        self.assertIsNone(outputs)
        self.assertTrue(any('CLAIMS_LOOP_EXHAUSTED' in error for error in errors))


if __name__ == '__main__':
    logging.disable(logging.CRITICAL)
    unittest.main()
