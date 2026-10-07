"""Curriculum and evidence domain. Only the gateway may author LearningEvents.

Adapters persist facts; all projections are rebuilt deterministically. No learner
scores or model-authored mastery labels are accepted by this module.
"""
from contextlib import contextmanager
import copy
from dataclasses import asdict, dataclass, field
import hashlib
import json
import math
from pathlib import Path
import threading
import time

from codex_provider import ServiceError

DEFAULT_CURRICULUM = 'rj-math-g7-1-2024'
STRATEGY_VERSION = 1


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def load_curricula(directory=None):
    definitions = {}
    global_ids = set()
    for path in sorted(Path(directory or Path(__file__).parent / 'fixtures/curricula').glob('*.json')):
        body = json.loads(path.read_text())
        validate_curriculum(body)
        cid = body['curriculum']['id']
        ids = {n['id'] for n in body['nodes']}
        if cid in definitions or ids & global_ids:
            raise ValueError('Duplicate curriculum or global node ID')
        global_ids.update(ids)
        definitions[cid] = body
    if not definitions:
        raise ValueError('No curricula found')
    return definitions


def validate_curriculum(body):
    curriculum = body['curriculum']
    if type(body['schemaVersion']) is not int or body['schemaVersion'] < 1:
        raise ValueError('Invalid curriculum definition version')
    if any(not curriculum.get(k) for k in ('id', 'publisher', 'edition', 'grade', 'term', 'subject', 'displayName')):
        raise ValueError('Incomplete curriculum version')
    nodes = {n['id']: n for n in body['nodes']}
    if len(nodes) != len(body['nodes']) or not nodes:
        raise ValueError('Duplicate or missing nodes')
    policy = body['modelingPolicy']['verificationBySourceType']
    sources = {s['id'] for s in body['provenance']['sources']}
    for node in nodes.values():
        if not node['id'] or not node['name'] or node['kind'] not in ('chapter', 'section', 'concept'):
            raise ValueError('Invalid node')
        source = policy.get(node['sourceType'])
        if not source or not source.get('sourceTier') or not source.get('verificationStatus'):
            raise ValueError('Unresolved node provenance')
        if source.get('sourceRef') is not None and source['sourceRef'] not in sources:
            raise ValueError('Unknown provenance reference')
        expected = {'chapter': None, 'section': 'chapter', 'concept': 'section'}[node['kind']]
        parent = nodes.get(node['parentId'])
        if (expected is None and node['parentId'] is not None) or (expected and (not parent or parent['kind'] != expected)):
            raise ValueError('Invalid parent')
        seen = {node['id']}
        while parent:
            if parent['id'] in seen:
                raise ValueError('Parent cycle')
            seen.add(parent['id'])
            parent = nodes.get(parent['parentId'])
    seen_edges = set()
    for edge in body['edges']:
        key = (edge['from'], edge['to'], edge['relation'])
        if (edge['from'] not in nodes or edge['to'] not in nodes or edge['from'] == edge['to']
                or edge['relation'] not in ('prerequisite', 'transfer', 'similar') or key in seen_edges):
            raise ValueError('Invalid edge')
        seen_edges.add(key)
    if any(nodes.get(n, {}).get('kind') != 'concept' for n in body['demoFocusNodeIds']):
        raise ValueError('Demo focus must reference concepts')


@dataclass(frozen=True)
class LearningEvent:
    task: str
    question: str
    event_id: str
    curriculum_id: str
    kind: str
    revision: int = 0
    material: list | None = None
    knowledge_points: list | None = None
    skill: str = ''
    result: str = 'uncertain'
    assistance: str = 'none'
    external: bool = False
    detail: str = ''
    occurred_at: float = field(default_factory=time.time)


class MemoryAdapter:
    def __init__(self):
        self.questions = {}
        self.definitions = {}
        self.lock = threading.RLock()

    @contextmanager
    def transaction(self):
        with self.lock:
            saved = copy.deepcopy((self.questions, self.definitions))
            try:
                yield
            except Exception:
                self.questions, self.definitions = saved
                raise

    def install(self, definitions):
        for cid, body in definitions.items():
            if cid in self.definitions and self.definitions[cid] != body:
                raise ValueError('Existing curriculum is immutable; use a new curriculum ID')
            self.definitions[cid] = copy.deepcopy(body)

    def get(self, task, question):
        return copy.deepcopy(self.questions.get((task, question)))

    def put(self, state):
        self.questions[state['task'], state['question']] = copy.deepcopy(state)

    def all(self, cid):
        return [copy.deepcopy(s) for s in self.questions.values() if s['curriculumId'] == cid]


class SQLiteAdapter:
    def __init__(self, db, lock=None):
        self.db = db
        self.lock = lock or threading.RLock()
        db.executescript('''
            CREATE TABLE IF NOT EXISTS curricula(id TEXT PRIMARY KEY, definition_version INTEGER NOT NULL, body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS learning_questions(task TEXT NOT NULL, question TEXT NOT NULL,
                curriculum_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(task,question));
            CREATE TABLE IF NOT EXISTS question_knowledge(task TEXT NOT NULL, question TEXT NOT NULL,
                curriculum_id TEXT NOT NULL, node_id TEXT NOT NULL, role TEXT NOT NULL,
                confidence REAL NOT NULL, source TEXT NOT NULL, mapping_status TEXT NOT NULL,
                revision INTEGER NOT NULL, superseded INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY(task,question,node_id,revision));
            CREATE TABLE IF NOT EXISTS learning_evidence(id TEXT PRIMARY KEY, curriculum_id TEXT NOT NULL,
                node_id TEXT NOT NULL, task TEXT NOT NULL, question TEXT NOT NULL, event_id TEXT NOT NULL,
                evidence_type TEXT NOT NULL, result TEXT NOT NULL, assistance_level TEXT NOT NULL,
                occurred_at REAL NOT NULL, revision INTEGER NOT NULL, superseded INTEGER NOT NULL DEFAULT 0,
                body TEXT NOT NULL, UNIQUE(task,question,event_id,node_id));
            CREATE INDEX IF NOT EXISTS learning_evidence_node ON learning_evidence(curriculum_id,node_id,superseded);
        ''')

    @contextmanager
    def transaction(self):
        with self.lock:
            self.db.execute('SAVEPOINT learning_model')
            try:
                yield
                self.db.execute('RELEASE SAVEPOINT learning_model')
            except Exception:
                self.db.execute('ROLLBACK TO SAVEPOINT learning_model')
                self.db.execute('RELEASE SAVEPOINT learning_model')
                raise

    def install(self, definitions):
        for cid, body in definitions.items():
            row = self.db.execute('SELECT body FROM curricula WHERE id=?', (cid,)).fetchone()
            if row and json.loads(row[0]) != body:
                raise ValueError('Existing curriculum is immutable; use a new curriculum ID')
            self.db.execute('INSERT OR IGNORE INTO curricula VALUES(?,?,?)', (cid, body['schemaVersion'], encoded(body)))

    def get(self, task, question):
        row = self.db.execute('SELECT body FROM learning_questions WHERE task=? AND question=?', (task, question)).fetchone()
        if not row:
            return None
        state = json.loads(row[0])
        state['mappings'] = [dict(r) for r in self.db.execute('SELECT node_id AS nodeId, role, confidence, source, mapping_status AS mappingStatus, revision, superseded FROM question_knowledge WHERE task=? AND question=? ORDER BY revision,node_id', (task, question))]
        state['evidence'] = [json.loads(r[0]) for r in self.db.execute('SELECT body FROM learning_evidence WHERE task=? AND question=? ORDER BY occurred_at,event_id,node_id', (task, question))]
        return state

    def put(self, state):
        metadata = {k: v for k, v in state.items() if k not in ('mappings', 'evidence')}
        self.db.execute('INSERT OR REPLACE INTO learning_questions VALUES(?,?,?,?)', (state['task'], state['question'], state['curriculumId'], encoded(metadata)))
        for m in state['mappings']:
            self.db.execute('INSERT OR REPLACE INTO question_knowledge VALUES(?,?,?,?,?,?,?,?,?,?)', (
                state['task'], state['question'], state['curriculumId'], m['nodeId'], m['role'], m['confidence'], m['source'], m['mappingStatus'], m['revision'], m['superseded']))
        for e in state['evidence']:
            self.db.execute('INSERT OR REPLACE INTO learning_evidence VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', (
                e['id'], state['curriculumId'], e['nodeId'], state['task'], state['question'], e['eventId'], e['type'], e['result'], e['assistance'], e['occurredAt'], e['revision'], e['superseded'], encoded(e)))

    def all(self, cid):
        rows = self.db.execute('SELECT task,question FROM learning_questions WHERE curriculum_id=? ORDER BY task,question', (cid,)).fetchall()
        return [self.get(r[0], r[1]) for r in rows]


class LearningModel:
    def __init__(self, adapter=None, definitions=None, confidence_threshold=.75, clock=time.time):
        if not 0 <= confidence_threshold <= 1:
            raise ValueError('Invalid confidence threshold')
        self.adapter = adapter or MemoryAdapter()
        self.definitions = copy.deepcopy(definitions if definitions is not None else load_curricula())
        global_ids = set()
        for cid, body in self.definitions.items():
            validate_curriculum(body)
            ids = {n['id'] for n in body['nodes']}
            if body['curriculum']['id'] != cid or ids & global_ids:
                raise ValueError('Duplicate or inconsistent curriculum ID')
            global_ids.update(ids)
        self.threshold, self.clock = confidence_threshold, clock
        with self.adapter.transaction():
            self.adapter.install(self.definitions)

    def definition(self, cid):
        if not isinstance(cid, str) or cid not in self.definitions:
            raise ServiceError('教材版本不存在。', 400)
        return self.definitions[cid]

    def curricula(self):
        return {'defaultCurriculumId': DEFAULT_CURRICULUM, 'curricula': [
            {**d['curriculum'], 'definitionVersion': d['schemaVersion'], 'boundary': d['provenance']['boundary']}
            for d in self.definitions.values()]}

    def candidates(self, cid):
        return [{k: n.get(k, []) for k in ('id', 'name', 'aliases')} for n in self.definition(cid)['nodes'] if n['kind'] == 'concept']

    def mappings(self, cid, points, skill=''):
        nodes = {n['id']: n for n in self.definition(cid)['nodes']}
        source = 'model'
        if points is None:
            # Legacy migration is exact and unambiguous: never parse a memory or stem.
            matches = [n for n in nodes.values() if n['kind'] == 'concept' and skill.strip() in [n['name'], *n.get('aliases', [])]]
            points = [{'nodeId': matches[0]['id'], 'role': 'primary', 'confidence': 1.0}] if len(matches) == 1 else []
            source = 'explicit_alias'
        if not isinstance(points, list) or len(points) > 3:
            raise ServiceError('每题最多关联三个已有知识点。', 400)
        seen, result = set(), []
        for p in points:
            if not isinstance(p, dict) or not isinstance(p.get('nodeId'), str):
                raise ServiceError('知识点映射格式不正确。', 400)
            nid, confidence = p['nodeId'], p.get('confidence')
            if (nid in seen or nodes.get(nid, {}).get('kind') != 'concept' or p.get('role') not in ('primary', 'secondary')
                    or type(confidence) not in (int, float) or not math.isfinite(confidence) or not 0 <= confidence <= 1):
                raise ServiceError('知识点映射包含未知、重复或无效节点。', 400)
            seen.add(nid)
            result.append({'nodeId': nid, 'role': p['role'], 'confidence': confidence, 'source': source,
                           'mappingStatus': 'confirmed' if confidence >= self.threshold else 'pending_review'})
        return result

    def question(self, task, question):
        with self.adapter.transaction():
            return self.adapter.get(task, question)

    def record(self, event):
        self.definition(event.curriculum_id)
        if (event.kind not in ('original_attempt', 'recognition', 'invalidate', 'help', 'correction_attempt',
                              'independent_verification', 'delayed_retest', 'fact_correction')
                or type(event.revision) is not int or event.revision < 0
                or event.result not in ('correct', 'wrong', 'unanswered', 'uncertain')
                or event.assistance not in ('none', 'hint', 'explanation', 'external', 'unknown')
                or type(event.external) is not bool or not math.isfinite(event.occurred_at)
                or any(not isinstance(v, str) or not v for v in (event.task, event.question, event.event_id))):
            raise ServiceError('学习事件无效。', 400)
        fingerprint = hashlib.sha256(encoded({k: v for k, v in asdict(event).items() if k != 'occurred_at'}).encode()).hexdigest()
        with self.adapter.transaction():
            before = self.tree(event.curriculum_id)
            state = self.adapter.get(event.task, event.question)
            if state and state['curriculumId'] != event.curriculum_id:
                raise ServiceError('题目不能更换教材版本。', 409)
            if state and event.event_id in state['eventFingerprints']:
                if state['eventFingerprints'][event.event_id] != fingerprint:
                    raise ServiceError('学习事件编号已被其他内容使用。', 409)
                return {'curriculumId': event.curriculum_id, 'changedNodes': [], 'replayed': True}
            if state and event.kind in ('independent_verification', 'delayed_retest'):
                raise ServiceError('首次验证证据已冻结，不能用后续作答覆盖。', 409)
            if state and event.kind == 'original_attempt':
                raise ServiceError('原始证据已存在。', 409)
            if state and event.revision < state['revision']:
                raise ServiceError('学习事件版本已过期。', 409)
            if not state:
                if event.kind not in ('original_attempt', 'independent_verification', 'delayed_retest'):
                    raise ServiceError('缺少题目原始证据。', 409)
                state = {'task': event.task, 'question': event.question, 'curriculumId': event.curriculum_id,
                         'material': event.material, 'revision': event.revision, 'generation': 0, 'help': False,
                         'external': event.external, 'mappings': [], 'evidence': [], 'eventFingerprints': {}}
            if event.kind in ('recognition', 'invalidate'):
                for m in state['mappings']:
                    m['superseded'] = True
                for e in state['evidence']:
                    e['superseded'] = True
                state['generation'] += 1
                state['material'] = event.material
            if event.kind in ('original_attempt', 'recognition', 'independent_verification', 'delayed_retest'):
                if state['mappings'] and event.kind == 'original_attempt':
                    raise ServiceError('原始证据已存在。', 409)
                new = self.mappings(event.curriculum_id, event.knowledge_points, event.skill)
                state['mappings'].extend({**m, 'revision': state['generation'], 'superseded': False} for m in new)
            if event.kind == 'help':
                state['help'] = True
            if event.kind == 'fact_correction':
                state['external'] = event.external
                # Preserve source facts. External-help corrections alter their effective
                # interpretation on projection, not the original result or help log.
            effective_help = state['help'] or state['external'] or event.assistance != 'none'
            kind = event.kind
            if kind in ('correction_attempt', 'independent_verification', 'delayed_retest') and effective_help:
                kind = 'assisted_completion'
            if event.kind == 'delayed_retest' and event.task.startswith('verification:') is False:
                raise ServiceError('延迟复测只能由验证服务写入。', 400)
            if kind != 'invalidate':
                for m in state['mappings']:
                    if m['superseded']:
                        continue
                    identity = [event.task, event.question, event.event_id, m['nodeId']]
                    state['evidence'].append({'id': hashlib.sha256(encoded(identity).encode()).hexdigest(),
                        'nodeId': m['nodeId'], 'eventId': event.event_id, 'type': kind, 'result': event.result,
                        'assistance': event.assistance if event.assistance != 'none' else 'explanation' if state['help'] else 'none',
                        'occurredAt': event.occurred_at, 'revision': state['generation'], 'superseded': False,
                        'detail': event.detail[:1000], 'ref': ':'.join(identity[:3])})
            active_mappings = [m for m in state['mappings'] if not m['superseded']]
            state['mappingStatus'] = ('confirmed' if any(m['mappingStatus'] == 'confirmed' for m in active_mappings)
                                      else 'pending_review' if active_mappings else 'unmapped')
            state['revision'] = max(state['revision'], event.revision)
            state['eventFingerprints'][event.event_id] = fingerprint
            self.adapter.put(state)
            after = self.tree(event.curriculum_id)
            old = {n['id']: n for n in before['nodes']}
            return {'curriculumId': event.curriculum_id,
                    'changedNodes': [n for n in after['nodes'] if n != old[n['id']]], 'replayed': False}

    def _facts(self, cid):
        facts = []
        for state in self.adapter.all(cid):
            active = {m['nodeId'] for m in state['mappings'] if not m['superseded'] and m['mappingStatus'] == 'confirmed'}
            for e in state['evidence']:
                if e['superseded'] or e['nodeId'] not in active:
                    continue
                fact = {**e, 'task': state['task'], 'question': state['question'], 'external': state['external']}
                # A later self-reported correction may conservatively downgrade an
                # independent fact, but cannot erase server-observed help.
                if state['external'] and fact['type'] in ('independent_verification', 'delayed_retest'):
                    fact['type'] = 'assisted_completion'
                facts.append(fact)
        return sorted(facts, key=lambda e: (e['occurredAt'], e['ref'], e['nodeId']))

    @staticmethod
    def _aggregate(facts):
        observations = [e for e in facts if e['type'] not in ('help', 'fact_correction')]
        by_question = {}
        for e in observations:
            by_question[e['task'], e['question']] = e
        latest = list(by_question.values())
        independent = [e for e in latest if e['type'] in ('independent_verification', 'delayed_retest') and e['result'] == 'correct']
        supported = [e for e in latest if e['type'] == 'assisted_completion' or e['external']]
        corrected = [e for e in latest if e['type'] == 'correction_attempt' and e['result'] == 'correct']
        failures = [e for e in latest if e['result'] in ('wrong', 'unanswered')]
        status = 'insufficient_evidence'
        if len(independent) >= 2 and (not failures or max(e['occurredAt'] for e in independent) > max(e['occurredAt'] for e in failures)):
            status = 'stable_evidence'
        elif supported or corrected or any(e['type'] == 'help' for e in facts):
            status = 'verify_independently'
        elif len(failures) >= 2:
            status = 'needs_support'
        return {'state': status, 'questionCount': len(by_question), 'taskCount': len({e['task'] for e in observations}),
                'independentCount': len(independent), 'assistedCount': len(supported),
                'latestAt': max((e['occurredAt'] for e in facts), default=None)}

    @staticmethod
    def _practice_focus(facts):
        # One current observation per distinct question; repeated submissions and
        # multi-tag mappings do not amplify the signal. This is guidance, not mastery.
        latest = {}
        for e in facts:
            if e['type'] not in ('help', 'fact_correction'):
                latest[e['task'], e['question']] = e
        recent = sorted(latest.values(), key=lambda e: (e['occurredAt'], e['ref']))[-5:]
        unresolved = sum(e['result'] in ('wrong', 'unanswered') for e in recent)
        recovered = len(recent) >= 2 and all(
            e['type'] in ('independent_verification', 'delayed_retest') and e['result'] == 'correct'
            for e in recent[-2:])
        if unresolved >= 3 and not recovered:
            return {'type': 'practice', 'label': '再巩固一下',
                    'reason': f"最近 {len(recent)} 道题中，{unresolved} 道还需要订正。",
                    'questionCount': len(recent), 'unresolvedCount': unresolved}
        return None

    def tree(self, curriculum_id=DEFAULT_CURRICULUM):
        definition = self.definition(curriculum_id)
        with self.adapter.transaction():
            facts = self._facts(curriculum_id)
        nodes = definition['nodes']
        indexed = {n['id']: n for n in nodes}
        grouped = {n['id']: [] for n in nodes}
        for e in facts:
            nid = e['nodeId']
            while nid:
                grouped[nid].append(e)
                nid = indexed[nid]['parentId']
        projected = []
        for n in nodes:
            evidence = grouped[n['id']]
            aggregate = self._aggregate(evidence)
            # Lit is a footprint, never a mastery judgement. Parent coverage is
            # deduplicated by task/question even for multi-concept questions.
            successful = any(e['result'] == 'correct' and e['type'] not in ('help', 'fact_correction') for e in evidence)
            visual = 'lit' if successful else 'growing' if evidence else 'unlit'
            action = 'review' if aggregate['state'] == 'stable_evidence' else 'verify' if aggregate['state'] == 'verify_independently' else 'continue'
            labels = {'continue': '继续练习', 'verify': '独立试一题：', 'review': '复习'}
            projected.append({k: n[k] for k in ('id', 'parentId', 'kind', 'name', 'order', 'code')} | {
                'visualState': visual,
                'recentlyChanged': aggregate['latestAt'] is not None and 0 <= self.clock() - aggregate['latestAt'] < 86400,
                'nextAction': {'type': action, 'label': labels[action] + n['name'], 'nodeId': n['id']},
                'attention': self._practice_focus(evidence) if n['kind'] == 'concept' else None,
                'progress': None})
        # Parents express concept coverage rather than inheriting one successful
        # answer. Compute from leaves so textbook ordering is irrelevant.
        leaves_by_parent = {n['id']: [] for n in nodes if n['kind'] != 'concept'}
        for leaf in projected:
            if leaf['kind'] != 'concept':
                continue
            parent = leaf['parentId']
            while parent:
                leaves_by_parent[parent].append(leaf)
                parent = indexed[parent]['parentId']
        for n in projected:
            if n['kind'] == 'concept':
                continue
            leaves = leaves_by_parent[n['id']]
            covered = sum(leaf['visualState'] != 'unlit' for leaf in leaves)
            lit = sum(leaf['visualState'] == 'lit' for leaf in leaves)
            practice = sum(leaf['attention'] is not None for leaf in leaves)
            n['progress'] = {'totalConcepts': len(leaves), 'coveredConcepts': covered,
                             'litConcepts': lit, 'practiceConcepts': practice}
            n['visualState'] = ('unlit' if not covered else
                                'lit' if lit == len(leaves) and not practice else 'growing')
            if practice:
                n['attention'] = {'type': 'practice', 'label': f'{practice} 个知识点再巩固',
                                  'reason': f'下方有 {practice} 个知识点近期反复遇到困难，可以点开看看。'}
        return {'curriculumId': curriculum_id, 'definitionVersion': definition['schemaVersion'],
                'displayName': definition['curriculum']['displayName'], 'nodes': projected}

    def context(self, question):
        cid = question.get('curriculumId', DEFAULT_CURRICULUM)
        definition = self.definition(cid)
        with self.adapter.transaction():
            state = self.adapter.get(question['task'], question['question'])
            targets = [m['nodeId'] for m in (state or {}).get('mappings', []) if not m['superseded'] and m['mappingStatus'] == 'confirmed']
            prerequisites = sorted({e['from'] for e in definition['edges'] if e['to'] in targets and e['relation'] == 'prerequisite'} - set(targets))
            facts = [e for e in self._facts(cid) if e['nodeId'] in targets + prerequisites]
        target_facts = [e for e in facts if e['nodeId'] in targets]
        aggregate = self._aggregate(target_facts)
        strategy = {'insufficient_evidence': 'observe_first', 'needs_support': 'focus_step_then_verify',
                    'verify_independently': 'minimal_hint_then_verify', 'stable_evidence': 'fade_help_and_transfer'}[aggregate['state']]
        help_facts = [e for e in facts if e['type'] == 'help']
        return {'targetNodeIds': targets, 'prerequisiteNodeIds': prerequisites, 'strategy': strategy,
                'strategyVersion': STRATEGY_VERSION, 'verificationRequired': aggregate['state'] != 'stable_evidence',
                'avoid': ['repeat_full_solution'] if help_facts else [],
                'previousHelp': [{'ref': e['ref'], 'detail': e['detail']} for e in help_facts[-4:]],
                'signals': [{**self._aggregate([e for e in facts if e['nodeId'] == nid]), 'nodeId': nid} for nid in targets + prerequisites],
                'evidenceRefs': list(dict.fromkeys(e['ref'] for e in facts))[-20:],
                'recentIndependentVerification': next(({'ref': e['ref'], 'result': e['result'], 'at': e['occurredAt']}
                    for e in reversed(target_facts) if e['type'] in ('independent_verification', 'delayed_retest')), None)}

    def recommendation_profile(self, cid=DEFAULT_CURRICULUM):
        definition = self.definition(cid)
        with self.adapter.transaction():
            facts = self._facts(cid)
        candidates = []
        original_tasks = {e['task'] for e in facts if not e['task'].startswith('verification:')}
        question_count = len({(e['task'], e['question']) for e in facts if not e['task'].startswith('verification:')})
        for node in definition['nodes']:
            relevant = [e for e in facts if e['nodeId'] == node['id']]
            agg = self._aggregate(relevant)
            latest = {}
            for e in relevant:
                if e['type'] != 'fact_correction':
                    latest[e['task'], e['question']] = e
            concerns = [e for e in latest.values() if e['result'] in ('wrong', 'unanswered', 'uncertain') or e['type'] in ('help', 'assisted_completion') or e['external']]
            if len({e['task'] for e in concerns}) < 2 or agg['state'] == 'stable_evidence':
                continue
            candidates.append({'nodeId': node['id'], 'knowledgePoint': node['name'], 'knowledgeState': agg,
                'reasoningPatterns': [], 'concerns': len(concerns), 'observations': [
                    {'task': e['task'], 'question': e['question'], 'status': e['result'],
                     'evidence': [{'id': e['ref'], 'type': e['type'], 'detail': e['detail']}]} for e in concerns[-12:]]})
        if len(original_tasks) < 2 or question_count < 3 or not candidates:
            return {'state': 'insufficient', 'requiredTasks': 2, 'observedTasks': len(original_tasks)}
        candidates.sort(key=lambda c: (-c['concerns'], c['nodeId']))
        return {'state': 'ready', 'curriculumId': cid, 'candidates': candidates[:3]}
