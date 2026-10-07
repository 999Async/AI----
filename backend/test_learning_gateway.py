import copy
import http.client
import json
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from codex_provider import ServiceError
from learning_model import DEFAULT_CURRICULUM as CID
from server import Store, Gateway, make_server, validate_question, canonical
from test_gateway import FakeProvider, question, wait
from test_learning_model import NODE, OTHER, points


class TreeProvider(FakeProvider):
    def generate(self, action, data, emit, image=None):
        if action in ('verification', 'verification_check', 'recognition'):
            self.calls.append((action, copy.deepcopy(data)))
            if self.block:
                self.started.set()
                self.release.wait(3)
            if action == 'verification':
                return {'question': f"化简 {len(self.calls) + 5}(x−2)"}
            if action == 'verification_check':
                return {'status': 'correct' if data['answer'] == 'correct' else 'wrong', 'reason': '测试批改依据'}
            return {'status': 'correct', 'reason': '已重新识别', 'knowledgePoints': points(OTHER)}
        return super().generate(action, data, emit, image)


class LearningGatewayTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(self.temp.name)
        self.provider = TreeProvider()
        self.gateway = Gateway(self.store, self.provider)
        result = self.run_job('grade', 'grade', None, {'note': ''}, (b'png', 'png'))
        self.task = result['id']
        self.counter = 0

    def tearDown(self):
        self.store.db.close()
        self.temp.cleanup()

    def run_job(self, key, action, task, data, image=None):
        event = wait(self.gateway.submit(key, action, task, data, image))
        self.assertEqual(event['type'], 'result', event)
        return event['data']

    def create_verification(self, **extra):
        self.counter += 1
        result = self.run_job(f'create-{self.counter}', 'verification', None, {'nodeId': NODE, **extra})
        vid = result['verification']['id']
        self.run_job(f'shown-{self.counter}', 'verification_shown', vid, {})
        return vid

    def test_grade_records_before_browser_memory_and_ignores_forged_outcomes(self):
        state = self.store.learning.question(self.task, 'q-1')
        self.assertEqual(state['evidence'][0]['result'], 'wrong')
        q = question(2)
        q['status'] = 'correct'
        q['attempts'] = [{'eventId': 'e-2', 'status': 'correct'}]
        q['knowledgePoints'] = points(OTHER)
        self.run_job('memory', 'memory', self.task, {'question': q})
        state = self.store.learning.question(self.task, 'q-1')
        self.assertEqual(len(state['evidence']), 1)
        self.assertEqual(state['evidence'][0]['result'], 'wrong')
        self.assertEqual(state['mappings'][0]['nodeId'], NODE)

    def test_tutor_receives_cross_question_context_and_check_is_assisted(self):
        self.run_job('help', 'tutor', self.task, {'question': question(), 'message': '我不懂',
            'teachingContext': {'strategy': 'forged'}})
        context = self.provider.calls[-1][1]['teachingContext']
        self.assertEqual(context['targetNodeIds'], [NODE])
        q = question(2)  # Deliberately hides browser help flag: server log still wins.
        self.run_job('check', 'check', self.task, {'question': q, 'answer': '5'})
        evidence = self.store.learning.question(self.task, 'q-1')['evidence']
        self.assertEqual(evidence[-1]['type'], 'assisted_completion')
        second = self.run_job('second-grade', 'grade', None, {}, (b'png', 'png'))['id']
        self.run_job('second-help', 'tutor', second, {'question': question(), 'message': '继续'})
        self.assertIn(f'{self.task}:q-1:help', self.provider.calls[-1][1]['teachingContext']['evidenceRefs'])

    def test_recognition_invalidates_immediately_then_remaps(self):
        q = question(2)
        q['text'] = '合并同类项 2x+3x'
        q['events'][-1]['type'] = 'recognition'
        self.provider.block = True
        job = self.gateway.submit('recognize', 'recognition', self.task, {'question': q})
        self.assertTrue(self.provider.started.wait(2))
        state = self.store.learning.question(self.task, 'q-1')
        self.assertTrue(all(e['superseded'] for e in state['evidence']))
        self.assertEqual(state['mappingStatus'], 'unmapped')
        self.provider.release.set()
        result = wait(job)
        self.assertEqual(result['type'], 'result')
        changed = {n['id']: n for n in result['data']['learningUpdate']['changedNodes']}
        self.assertEqual(changed[NODE]['visualState'], 'unlit')
        self.assertEqual(changed[OTHER]['visualState'], 'lit')
        state = self.store.learning.question(self.task, 'q-1')
        self.assertEqual([m['nodeId'] for m in state['mappings'] if not m['superseded']], [OTHER])
        self.assertEqual([e['result'] for e in state['evidence'] if not e['superseded']], ['correct'])

    def test_late_recognition_cannot_restore_old_material(self):
        q = question(2)
        q['text'] = '第一次修改'
        self.provider.block = True
        job = self.gateway.submit('recognize', 'recognition', self.task, {'question': q})
        self.assertTrue(self.provider.started.wait(2))
        newer = question(3)
        newer['text'] = '第二次修改'
        self.store.snapshot(self.task, validate_question(newer))
        self.provider.release.set()
        self.assertEqual(wait(job)['status'], 409)
        self.assertEqual(self.store.learning.question(self.task, 'q-1')['mappingStatus'], 'unmapped')

    def test_invalid_grade_mapping_rolls_back_homework_and_request(self):
        original = self.provider.generate
        def bad(action, data, emit, image=None):
            result = original(action, data, emit, image)
            result['questions'][0]['knowledgePoints'] = points('made-up')
            return result
        self.provider.generate = bad
        self.assertEqual(wait(self.gateway.submit('bad-grade', 'grade', None, {}, (b'png', 'png')))['type'], 'error')
        self.assertEqual(self.store.db.execute('SELECT COUNT(*) FROM homework').fetchone()[0], 1)
        self.assertIsNone(self.store.db.execute('SELECT * FROM requests WHERE key=?', ('bad-grade',)).fetchone())

    def test_create_freezes_first_wrong_and_restart_replays(self):
        vid = self.create_verification()
        result = self.run_job('first-wrong', 'verification_check', vid, {'answer': 'wrong', 'status': 'correct'})
        self.assertEqual(result['status'], 'wrong')
        self.assertEqual(self.store.learning.question('verification:' + vid, 'first')['evidence'][0]['type'], 'independent_verification')
        with self.assertRaises(ServiceError):
            self.gateway.submit('changed', 'verification_check', vid, {'answer': 'correct'})
        count = len(self.provider.calls)
        self.store.db.close()
        self.store = Store(self.temp.name)
        self.gateway = Gateway(self.store, self.provider)
        self.assertEqual(self.run_job('first-wrong', 'verification_check', vid, {'answer': 'wrong'}), result)
        self.assertEqual(self.run_job('new-key', 'verification_check', vid, {'answer': 'wrong'}), result)
        self.assertEqual(len(self.provider.calls), count)
        self.assertEqual(len(self.store.learning.question('verification:' + vid, 'first')['evidence']), 1)

    def test_help_exposure_and_external_help_are_never_independent(self):
        for external in (True, False):
            vid = self.create_verification()
            if not external:
                self.run_job('expose-help', 'verification_help', vid, {})
            self.run_job('answer-' + vid, 'verification_check', vid, {'answer': 'correct', 'externalHelp': external})
            evidence = self.store.learning.question('verification:' + vid, 'first')['evidence']
            self.assertEqual(evidence[0]['type'], 'assisted_completion')
            changed = wait(self.gateway.submit('late-help-' + vid, 'verification_help', vid, {}))
            self.assertEqual(changed['status'], 409)

    def test_failed_grading_keeps_frozen_input_and_can_retry(self):
        vid = self.create_verification()
        original = self.provider.generate
        self.provider.generate = lambda *args: (_ for _ in ()).throw(ServiceError('temporary'))
        self.assertEqual(wait(self.gateway.submit('fail-check', 'verification_check', vid, {'answer': 'wrong'}))['type'], 'error')
        with self.assertRaises(ServiceError):
            self.gateway.submit('rewrite', 'verification_check', vid, {'answer': 'correct'})
        self.provider.generate = original
        self.assertEqual(self.run_job('fail-check', 'verification_check', vid, {'answer': 'wrong'})['status'], 'wrong')

    def test_concurrent_checks_cannot_replace_first_submission(self):
        vid = self.create_verification()
        self.provider.block = True
        first = self.gateway.submit('check-one', 'verification_check', vid, {'answer': 'wrong'})
        self.assertTrue(self.provider.started.wait(2))
        with self.assertRaises(ServiceError):
            self.gateway.submit('check-two', 'verification_check', vid, {'answer': 'correct'})
        self.provider.release.set()
        self.assertEqual(wait(first)['data']['status'], 'wrong')

    def test_check_requires_shown_and_unknown_ids_rejected(self):
        result = self.run_job('create', 'verification', None, {'nodeId': NODE})
        vid = result['verification']['id']
        self.assertIsNone(result['verification']['shownAt'])
        with self.assertRaises(ServiceError):
            self.gateway.submit('unshown', 'verification_check', vid, {'answer': 'correct'})
        with self.assertRaises(ServiceError):
            self.gateway.submit('unknown', 'verification', None, {'nodeId': 'unknown'})
        with self.assertRaises(ServiceError):
            self.gateway.submit('bad-curriculum', 'grade', None, {'curriculumId': 'old'}, (b'png', 'png'))

    def test_delayed_retest_uses_server_elapsed_time(self):
        vid = self.create_verification()
        self.run_job('first', 'verification_check', vid, {'answer': 'correct'})
        with self.assertRaises(ServiceError):
            self.gateway.submit('fake-delay', 'verification', None, {'nodeId': NODE, 'reviewOf': vid, 'now': time.time() + 90000})
        server_future = self.store.verification(vid)['submittedAt'] + 90000
        with patch('server.time.time', return_value=server_future):
            retest = self.create_verification(reviewOf=vid)
            result = self.run_job('retest', 'verification_check', retest, {'answer': 'correct'})
        self.assertTrue(result['learningUpdate']['changedNodes'])
        self.assertEqual(self.store.learning.question('verification:' + retest, 'first')['evidence'][0]['type'], 'delayed_retest')

    def test_request_and_evidence_commit_roll_back_together(self):
        vid = self.create_verification()
        original = self.store.learning.record
        def fail_after_record(event):
            original(event)
            raise ServiceError('rollback test')
        with patch.object(self.store.learning, 'record', side_effect=fail_after_record):
            event = wait(self.gateway.submit('atomic', 'verification_check', vid, {'answer': 'correct'}))
        self.assertEqual(event['type'], 'error')
        self.assertIsNone(self.store.learning.question('verification:' + vid, 'first'))
        self.assertIsNone(self.store.verification(vid)['result'])
        self.assertIsNone(self.store.db.execute('SELECT * FROM requests WHERE key=?', ('atomic',)).fetchone())
        self.run_job('atomic', 'verification_check', vid, {'answer': 'correct'})

    def test_legacy_backfill_uses_alias_only_and_runs_once(self):
        legacy = {'id': 'legacy', 'title': 'old', 'questions': [
            {'id': 'known', 'text': '旧题', 'formula': '', 'original': '答案', 'status': 'wrong', 'reason': '原批改', 'skill': '去括号'},
            {'id': 'unknown', 'text': '去括号', 'formula': '', 'original': '答案', 'status': 'wrong', 'reason': '去括号', 'skill': ''}]}
        with self.store.db:
            self.store.db.execute('INSERT INTO homework VALUES(?,?,?,?)', ('legacy', canonical(legacy), b'png', 'png'))
        self.store._migrate_learning()
        self.store._migrate_learning()
        known = self.store.learning.question('legacy', 'known')
        unknown = self.store.learning.question('legacy', 'unknown')
        self.assertEqual(known['mappings'][0]['source'], 'explicit_alias')
        self.assertEqual(len(known['evidence']), 1)
        self.assertEqual(unknown['mappingStatus'], 'unmapped')
        self.assertEqual(unknown['mappings'], [])


class LearningHTTPTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.server = make_server(0, self.temp.name, TreeProvider())
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.thread.join()
        self.server.server_close()
        self.server.gateway.store.db.close()
        self.temp.cleanup()

    def request(self, method, path, payload=None, origin=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        headers = {'Content-Type': 'application/json', 'Idempotency-Key': method + path}
        if origin:
            headers['Origin'] = origin
        conn.request(method, path, body=json.dumps(payload) if payload is not None else None, headers=headers)
        response = conn.getresponse()
        status, body, content_type = response.status, response.read(), response.getheader('Content-Type')
        conn.close()
        if 'ndjson' in content_type:
            events = [json.loads(line) for line in body.splitlines()]
            return status, events[-1]
        return status, json.loads(body)

    def test_catalog_tree_and_private_boundary(self):
        status, health = self.request('GET', '/api/health')
        self.assertEqual(status, 200)
        self.assertEqual(health['status'], 'ok')
        self.assertEqual(health['service'], 'banxue-local')
        self.assertTrue(health['storage'])
        self.assertGreaterEqual(health['uptimeSeconds'], 0)
        status, catalog = self.request('GET', '/api/curricula')
        self.assertEqual(status, 200)
        self.assertEqual(catalog['defaultCurriculumId'], CID)
        status, tree = self.request('GET', '/api/learning-tree?curriculumId=' + CID)
        self.assertEqual(status, 200)
        self.assertTrue(all(n['visualState'] == 'unlit' for n in tree['nodes']))
        self.assertEqual(self.request('GET', '/api/learning-tree?curriculumId=old')[0], 400)
        self.assertEqual(self.request('GET', '/api/curricula', origin='https://example.com')[0], 403)
        self.assertNotIn('confidence', json.dumps(tree))

    def test_verification_http_lifecycle(self):
        status, result = self.request('POST', '/api/verification', {'nodeId': NODE})
        self.assertEqual(status, 200)
        self.assertEqual(result['type'], 'result', result)
        vid = result['data']['verification']['id']
        self.assertEqual(self.request('GET', '/api/verification/' + vid)[0], 200)
        self.assertEqual(self.request('POST', f'/api/verification/{vid}/shown', {})[1]['type'], 'result')
        _, result = self.request('POST', f'/api/verification/{vid}/check', {'answer': 'correct'})
        self.assertEqual(result['data']['status'], 'correct')
        status, saved = self.request('GET', '/api/verification/' + vid)
        self.assertEqual(saved['result']['status'], 'correct')
        self.assertNotIn('firstSubmission', saved)
        self.assertEqual(self.request('GET', '/api/verification/unknown')[0], 404)


if __name__ == '__main__':
    unittest.main()
