import copy
from dataclasses import replace
import sqlite3
import unittest

from codex_provider import ServiceError
from learning_model import (DEFAULT_CURRICULUM as CID, LearningEvent, LearningModel,
                            MemoryAdapter, SQLiteAdapter, load_curricula, validate_curriculum)

NODE = 'kp-remove-parentheses'
OTHER = 'kp-combine-like-terms'


def points(*nodes, confidence=1):
    return [{'nodeId': n, 'role': 'primary' if i == 0 else 'secondary', 'confidence': confidence} for i, n in enumerate(nodes)]


def original(task='a', question='q', nodes=(NODE,), **kw):
    return LearningEvent(task, question, 'grade', CID, 'original_attempt',
                         knowledge_points=points(*nodes), material=['化简 2(x−1)', '', '2x−1'],
                         occurred_at=100, **kw)


class CurriculumTest(unittest.TestCase):
    def setUp(self):
        self.definition = load_curricula()[CID]

    def test_seed_has_six_chapters_fifteen_sections_and_provenance(self):
        self.assertEqual(sum(n['kind'] == 'chapter' for n in self.definition['nodes']), 6)
        self.assertEqual(sum(n['kind'] == 'section' for n in self.definition['nodes']), 15)
        validate_curriculum(self.definition)
        self.assertEqual(self.definition['curriculum']['edition'], '2024修订版')

    def test_invalid_structure_and_sources_are_rejected(self):
        mutations = [
            lambda d: d['nodes'].append(copy.deepcopy(d['nodes'][0])),
            lambda d: d['nodes'][0].update(parentId=d['nodes'][1]['id']),
            lambda d: d['nodes'][2].update(parentId='missing'),
            lambda d: d['edges'].append({'from': NODE, 'to': NODE, 'relation': 'prerequisite'}),
            lambda d: d['edges'].append({'from': NODE, 'to': 'missing', 'relation': 'prerequisite'}),
            lambda d: d['demoFocusNodeIds'].append(d['nodes'][0]['id']),
            lambda d: d['nodes'][0].update(sourceType='invented'),
            lambda d: d['curriculum'].pop('edition'),
        ]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                body = copy.deepcopy(self.definition)
                mutate(body)
                with self.assertRaises((ValueError, KeyError)):
                    validate_curriculum(body)

    def test_curriculum_version_is_not_silently_overwritten(self):
        for adapter in (MemoryAdapter(), SQLiteAdapter(self.sqlite())):
            with self.subTest(adapter=type(adapter).__name__):
                LearningModel(adapter)
                modified = copy.deepcopy(load_curricula())
                modified[CID]['curriculum']['edition'] = '旧版'
                with self.assertRaises(ValueError):
                    LearningModel(adapter, modified)
                with self.assertRaises(ServiceError):
                    LearningModel(adapter).tree('rj-math-g7-1-old')

    def sqlite(self):
        db = sqlite3.connect(':memory:')
        db.row_factory = sqlite3.Row
        self.addCleanup(db.close)
        return db


class AdapterBehavior:
    def test_mapping_validation_and_alias_only_migration(self):
        for mapping in (points('missing'), points('ch1-rational-numbers'), points(NODE, NODE),
                        points(NODE, confidence=float('nan')), points(NODE, confidence=True), points(NODE, OTHER, 'kp-like-terms', 'kp-monomial')):
            with self.assertRaises(ServiceError):
                self.model.mappings(CID, mapping)
        self.assertEqual(self.model.mappings(CID, None, '去括号')[0]['nodeId'], NODE)
        self.assertEqual(self.model.mappings(CID, None, '不确定的方程推断'), [])

    def test_multitag_counts_one_question_in_parent_and_no_negative_single_result(self):
        self.model.record(original(nodes=(NODE, OTHER), result='wrong'))
        state = self.model.question('a', 'q')
        self.assertEqual(len(state['evidence']), 2)
        facts = self.model._facts(CID)
        self.assertEqual(self.model._aggregate(facts)['questionCount'], 1)
        self.assertEqual(self.model._aggregate(facts)['state'], 'insufficient_evidence')
        parent = next(n for n in self.model.tree()['nodes'] if n['id'] == 'sec4-2-polynomial-operations')
        self.assertEqual(parent['visualState'], 'growing')
        self.assertEqual(parent['nextAction']['type'], 'continue')

    def test_repeated_difficulty_is_deduplicated_and_rolls_up_to_parents(self):
        for i in range(3):
            self.model.record(replace(original(task=f'work-{i}', nodes=(NODE, OTHER), result='wrong'), occurred_at=100+i))
        nodes = {n['id']: n for n in self.model.tree()['nodes']}
        self.assertEqual(nodes[NODE]['attention']['unresolvedCount'], 3)
        parent = nodes['sec4-2-polynomial-operations']
        self.assertEqual(parent['progress']['practiceConcepts'], 2)
        self.assertEqual(parent['progress']['coveredConcepts'], 2)
        self.assertEqual(parent['visualState'], 'growing')
        self.assertEqual(nodes['ch4-polynomial-add-sub']['progress']['practiceConcepts'], 2)

    def test_same_question_retries_do_not_create_repeated_difficulty(self):
        self.model.record(original(result='wrong'))
        for i in range(1, 5):
            self.model.record(LearningEvent('a', 'q', f'check-{i}', CID, 'correction_attempt',
                revision=i, result='wrong', occurred_at=100+i))
        node = next(n for n in self.model.tree()['nodes'] if n['id'] == NODE)
        self.assertIsNone(node['attention'])

    def test_two_recent_independent_successes_clear_practice_signal(self):
        for i in range(3):
            self.model.record(replace(original(task=f'work-{i}', result='wrong'), occurred_at=100+i))
        for i in range(2):
            self.model.record(LearningEvent(f'verification-{i}', 'q', 'answer', CID, 'independent_verification',
                knowledge_points=points(NODE), material=['new'], result='correct', occurred_at=200+i))
        node = next(n for n in self.model.tree()['nodes'] if n['id'] == NODE)
        self.assertIsNone(node['attention'])

    def test_parent_requires_coverage_across_all_concepts_to_light(self):
        section = 'sec4-2-polynomial-operations'
        leaves = [n for n in self.model.definition(CID)['nodes'] if n['parentId'] == section]
        for i, node in enumerate(leaves):
            self.model.record(replace(original(task=f'covered-{i}', nodes=(node['id'],), result='correct'), occurred_at=100+i))
            parent = next(n for n in self.model.tree()['nodes'] if n['id'] == section)
            self.assertEqual(parent['progress']['litConcepts'], i+1)
            self.assertEqual(parent['visualState'], 'lit' if i+1 == len(leaves) else 'growing')

    def test_pending_mapping_does_not_grow_parent(self):
        self.model.record(replace(original(), knowledge_points=points(NODE, confidence=.3)))
        self.assertEqual(self.model.question('a', 'q')['mappings'][0]['mappingStatus'], 'pending_review')
        self.assertTrue(all(n['visualState'] == 'unlit' for n in self.model.tree()['nodes']))

    def test_replay_is_idempotent_and_changed_payload_conflicts(self):
        event = original(result='wrong')
        self.assertTrue(self.model.record(event)['changedNodes'])
        self.assertTrue(self.model.record(replace(event, occurred_at=120))['replayed'])
        self.assertEqual(len(self.model.question('a', 'q')['evidence']), 1)
        with self.assertRaises(ServiceError):
            self.model.record(replace(event, result='correct'))

    def test_help_then_correct_never_becomes_independent(self):
        self.model.record(original(result='wrong'))
        self.model.record(LearningEvent('a', 'q', 'hint', CID, 'help', revision=1, detail='把系数乘到每一项', occurred_at=110))
        self.model.record(LearningEvent('a', 'q', 'check', CID, 'correction_attempt', revision=2, result='correct', occurred_at=120))
        state = self.model.question('a', 'q')
        self.assertEqual(state['evidence'][-1]['type'], 'assisted_completion')
        context = self.model.context({'task': 'a', 'question': 'q'})
        self.assertEqual(context['strategy'], 'minimal_hint_then_verify')
        self.assertEqual(context['avoid'], ['repeat_full_solution'])
        self.assertIn('把系数乘到每一项', context['previousHelp'][0]['detail'])

    def test_external_fact_correction_keeps_original_and_server_help(self):
        self.model.record(original(result='correct'))
        self.model.record(LearningEvent('a', 'q', 'external-on', CID, 'fact_correction', revision=1, external=True, occurred_at=110))
        self.assertEqual(self.model.context({'task': 'a', 'question': 'q'})['strategy'], 'minimal_hint_then_verify')
        self.model.record(LearningEvent('a', 'q', 'help', CID, 'help', revision=2, occurred_at=120))
        self.model.record(LearningEvent('a', 'q', 'external-off', CID, 'fact_correction', revision=3, external=False, occurred_at=130))
        state = self.model.question('a', 'q')
        self.assertFalse(state['external'])
        self.assertTrue(state['help'])
        self.assertEqual(state['evidence'][0]['result'], 'correct')
        self.assertEqual(self.model.context({'task': 'a', 'question': 'q'})['strategy'], 'minimal_hint_then_verify')

    def test_recognition_supersedes_old_mapping_and_evidence(self):
        self.model.record(original(result='wrong'))
        self.model.record(LearningEvent('a', 'q', 'correct-material', CID, 'recognition', revision=1,
            material=['new'], knowledge_points=points(OTHER), result='correct', occurred_at=120))
        nodes = {n['id']: n for n in self.model.tree()['nodes']}
        self.assertEqual(nodes[NODE]['visualState'], 'unlit')
        self.assertEqual(nodes[OTHER]['visualState'], 'lit')
        self.assertTrue(self.model.question('a', 'q')['evidence'][0]['superseded'])
        self.assertEqual(self.model.context({'task': 'a', 'question': 'q'})['targetNodeIds'], [OTHER])
        with self.assertRaises(ServiceError):
            self.model.record(LearningEvent('a', 'q', 'late', CID, 'help', revision=0))

    def test_context_only_related_and_direct_prerequisite_evidence(self):
        self.model.record(original(nodes=(OTHER,)))
        self.model.record(original('b', nodes=('kp-like-terms',)))
        self.model.record(original('c', nodes=('kp-angle-concept',)))
        context = self.model.context({'task': 'a', 'question': 'q'})
        self.assertIn('kp-like-terms', context['prerequisiteNodeIds'])
        self.assertIn('b:q:grade', context['evidenceRefs'])
        self.assertNotIn('c:q:grade', context['evidenceRefs'])

    def test_stable_requires_multiple_independent_questions_and_conflict_changes_strategy(self):
        self.model.record(original(result='correct'))
        self.assertEqual(self.model.context({'task': 'a', 'question': 'q'})['strategy'], 'observe_first')
        for i in range(2):
            self.model.record(LearningEvent(f'verification:{i}', 'first', 'first', CID, 'independent_verification',
                knowledge_points=points(NODE), result='correct', occurred_at=120+i))
        self.assertEqual(self.model.context({'task': 'a', 'question': 'q'})['strategy'], 'fade_help_and_transfer')
        self.model.record(original('new', result='wrong'))
        self.model.record(replace(original('later', result='wrong'), occurred_at=140))
        self.assertNotEqual(self.model.context({'task': 'a', 'question': 'q'})['strategy'], 'fade_help_and_transfer')

    def test_independent_first_result_cannot_be_replaced_with_new_event_id(self):
        event = LearningEvent('verification:one', 'first', 'first', CID, 'independent_verification',
                              knowledge_points=points(NODE), result='wrong', occurred_at=110)
        self.model.record(event)
        with self.assertRaises(ServiceError):
            self.model.record(replace(event, event_id='retry', result='correct'))
        self.assertEqual(self.model.question('verification:one', 'first')['evidence'][0]['result'], 'wrong')

    def test_projection_is_small_and_recent_highlight_expires(self):
        self.model.record(original())
        projected = self.model.tree()
        for n in projected['nodes']:
            self.assertIn(n['visualState'], ('unlit', 'growing', 'lit'))
            self.assertEqual(set(n), {'id', 'parentId', 'kind', 'name', 'order', 'code', 'visualState', 'recentlyChanged', 'nextAction', 'attention', 'progress'})
        self.model.clock = lambda: 100000
        self.assertFalse(any(n['recentlyChanged'] for n in self.model.tree()['nodes']))

    def test_failed_event_rolls_back_mapping_and_evidence(self):
        self.model.record(original())
        before = self.model.tree()
        with self.assertRaises(ServiceError):
            self.model.record(LearningEvent('a', 'q', 'invalid', CID, 'recognition', revision=1, knowledge_points=points('unknown')))
        self.assertEqual(self.model.tree(), before)
        self.assertEqual(len(self.model.question('a', 'q')['evidence']), 1)


class MemoryBehaviorTest(AdapterBehavior, unittest.TestCase):
    def setUp(self):
        self.model = LearningModel(MemoryAdapter(), clock=lambda: 200)


class SQLiteBehaviorTest(AdapterBehavior, unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.row_factory = sqlite3.Row
        self.model = LearningModel(SQLiteAdapter(self.db), clock=lambda: 200)

    def tearDown(self):
        self.db.close()

    def test_reopen_rebuilds_same_projection(self):
        self.model.record(original(result='wrong'))
        fresh = LearningModel(SQLiteAdapter(self.db), clock=lambda: 200)
        self.assertEqual(fresh.tree(), self.model.tree())
        self.assertEqual(fresh.context({'task': 'a', 'question': 'q'}), self.model.context({'task': 'a', 'question': 'q'}))
