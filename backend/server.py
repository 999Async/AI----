#!/usr/bin/env python3
"""Local-only homework gateway. Run: python3 backend/server.py"""
import argparse
import base64
import binascii
import copy
from email import policy
from email.parser import BytesParser
import hashlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import threading
import time
from urllib.parse import urlsplit, unquote, parse_qs
import uuid

from codex_provider import CodexProvider, ServiceError
from learning_model import LearningModel, LearningEvent, SQLiteAdapter, DEFAULT_CURRICULUM

PROJECT = Path(__file__).resolve().parent.parent
MAX_BODY = 11 * 1024 * 1024
EVENT_TYPES = {'grade', 'message', 'help', 'attempt', 'recognition', 'regrade', 'external'}


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def require_text(value, limit, label, empty=False):
    if not isinstance(value, str) or len(value) > limit or (not empty and not value.strip()):
        raise ServiceError(f'{label}格式不正确。', 400)
    return value


def validate_question(q):
    if not isinstance(q, dict):
        raise ServiceError('缺少当前题目。', 400)
    q = copy.deepcopy(q)
    q.setdefault('skill', '')
    for name, limit in [('id', 200), ('text', 16000), ('formula', 16000), ('original', 16000), ('reason', 16000), ('skill', 200)]:
        require_text(q.get(name), limit, name, empty=name not in ('id', 'text'))
    if q.get('status') not in ('correct', 'wrong', 'unanswered', 'uncertain'):
        raise ServiceError('题目状态不正确。', 400)
    if type(q.get('revision')) is not int or q['revision'] < 0:
        raise ServiceError('记录版本不正确。', 400)
    if type(q.get('help')) is not bool or type(q.get('external')) is not bool:
        raise ServiceError('帮助事实不正确。', 400)
    for name, limit in [('events', 1000), ('messages', 300), ('attempts', 300)]:
        if not isinstance(q.get(name), list) or len(q[name]) > limit:
            raise ServiceError('学习记录过长或不完整。', 400)
    seen = set()
    previous = 0
    for event in q['events']:
        if not isinstance(event, dict):
            raise ServiceError('学习事件格式不正确。', 400)
        eid = require_text(event.get('id'), 200, '事件编号')
        rev = event.get('revision')
        if eid in seen or type(rev) is not int or rev <= previous or rev > q['revision'] or event.get('type') not in EVENT_TYPES:
            raise ServiceError('学习事件编号或版本不正确。', 400)
        require_text(event.get('detail'), 16000, '学习事件内容', empty=True)
        seen.add(eid)
        previous = rev
    if previous != q['revision']:
        raise ServiceError('学习事件与当前版本不一致。', 400)
    for message in q['messages']:
        if not isinstance(message, dict) or message.get('role') not in ('student', 'assistant'):
            raise ServiceError('讨论记录格式不正确。', 400)
        require_text(message.get('text'), 16000, '讨论内容')
    for attempt in q['attempts']:
        if not isinstance(attempt, dict) or attempt.get('eventId') not in seen or attempt.get('status') not in ('correct', 'wrong', 'uncertain'):
            raise ServiceError('订正记录缺少有效依据。', 400)
    # Memory is authoritative on the server; never accept browser-authored model conclusions.
    q.pop('memory', None)
    q.pop('knowledgePoints', None)
    q.pop('curriculumId', None)
    for message in q['messages']:
        message.pop('execution', None)
    return q


def validate_suggested_questions(items):
    if not isinstance(items, list) or len(items) > 3:
        raise ServiceError('推荐问题格式不正确，请重试。')
    seen = set()
    for item in items:
        if not isinstance(item, dict) or set(item) != {'type', 'text'} or item.get('type') not in ('diagnose', 'method', 'extend'):
            raise ServiceError('推荐问题格式不正确，请重试。')
        value = require_text(item.get('text'), 120, '推荐问题')
        normalized = re.sub(r'\s+', '', value)
        if normalized in seen:
            raise ServiceError('推荐问题存在重复，请重试。')
        seen.add(normalized)
    return items


def material(q):
    return [q['text'], q['formula'], q['original'], q['external']]


def valid_box(value):
    if (not isinstance(value, list) or len(value) != 4 or
            any(type(n) not in (int, float) or not math.isfinite(n) or not 0 <= n <= 1 for n in value)):
        return []
    x, y, w, h = value
    return value if w > 0 and h > 0 and x + w <= 1.000001 and y + h <= 1.000001 else []


def validate_canvas_board(data):
    if data.get('canvasWidth') != 1200 or data.get('canvasHeight') != 760:
        raise ServiceError('画板尺寸不正确。', 400)
    if type(data.get('replyMinY')) is not int or not 300 <= data['replyMinY'] <= 700:
        raise ServiceError('画板可回复区域不正确。', 400)
    count = data.get('strokeCount')
    if type(count) is not int or not 1 <= count <= 10000:
        raise ServiceError('画板笔迹数量不正确。', 400)
    bounds = data.get('latestInput')
    if not isinstance(bounds, dict) or set(bounds) != {'x', 'y', 'w', 'h'}:
        raise ServiceError('缺少最新笔迹位置。', 400)
    if any(type(bounds[name]) not in (int, float) or not math.isfinite(bounds[name]) for name in bounds):
        raise ServiceError('最新笔迹位置不正确。', 400)
    if bounds['x'] < 0 or bounds['y'] < 0 or bounds['w'] <= 0 or bounds['h'] <= 0 or bounds['x'] + bounds['w'] > 1200 or bounds['y'] + bounds['h'] > 760:
        raise ServiceError('最新笔迹超出画板。', 400)


def rectangle_rotation_question(question):
    material = ''.join(str(question.get(name, '')) for name in ('text', 'formula'))
    return (re.search(r'长方形|矩形', material) is not None and
            re.search(r'绕|旋转', material) is not None and
            re.search(r'(?:其|某|任意|长方形|矩形)(?:的)?(?:一条|一)?边|边所在(?:的)?直线', material) is not None and
            re.search(r'一周|360', material) is not None)


def place_canvas_diagram(command, data, text_commands=()):
    if command != {'tool': 'diagram', 'kind': 'rectangle_about_side'}:
        return None
    if not rectangle_rotation_question(data['question']):
        return None
    left, top, right, bottom = 24, data['replyMinY'] + 12, 1176, 744
    obstacles = []
    latest = data['latestInput']
    obstacles.append((latest['x'] - 18, latest['y'] - 18,
                      latest['x'] + latest['w'] + 18, latest['y'] + latest['h'] + 18))
    for text in text_commands:
        usable = max(80, text['maxWidth'] - 44)
        line_count = max(1, min(7, math.ceil(len(text['text']) * text['fontSize'] * .72 / usable)))
        height = line_count * text['fontSize'] * text['lineHeight'] + 48
        obstacles.append((text['x'] - 12, text['y'] - 12,
                          text['x'] + text['maxWidth'] + 12, text['y'] + height + 12))
    candidates = [(left, top, right, bottom)]
    for ox1, oy1, ox2, oy2 in obstacles:
        next_candidates = []
        for x1, y1, x2, y2 in candidates:
            if ox2 <= x1 or ox1 >= x2 or oy2 <= y1 or oy1 >= y2:
                next_candidates.append((x1, y1, x2, y2))
                continue
            next_candidates.extend(((x1, y1, min(x2, ox1), y2),
                                    (max(x1, ox2), y1, x2, y2),
                                    (x1, y1, x2, min(y2, oy1)),
                                    (x1, max(y1, oy2), x2, y2)))
        candidates = next_candidates
    candidates = [box for box in candidates if box[2] - box[0] >= 500 and box[3] - box[1] >= 150]
    if not candidates:
        return None
    x1, y1, x2, y2 = max(candidates, key=lambda box: (box[2] - box[0]) * (box[3] - box[1]))
    width, height = min(880, x2 - x1), min(280, y2 - y1)
    x = round(x1 + (x2 - x1 - width) / 2)
    y = round(y1 + (y2 - y1 - height) / 2)
    return {'tool': 'diagram', 'kind': command['kind'], 'x': x, 'y': y,
            'width': round(width), 'height': round(height)}


def validate_canvas_diagram(command, minimum_y=300):
    required = {'tool', 'kind', 'x', 'y', 'width', 'height'}
    if (not isinstance(command, dict) or set(command) != required or command.get('tool') != 'diagram' or
            command.get('kind') != 'rectangle_about_side' or
            any(type(command.get(name)) is not int for name in ('x', 'y', 'width', 'height')) or
            command['width'] < 500 or command['height'] < 150 or command['x'] < 0 or
            command['y'] < minimum_y or command['x'] + command['width'] > 1200 or
            command['y'] + command['height'] > 760):
        raise ServiceError('画板教学图格式不正确，请重试。')


def validate_canvas_commands(commands, minimum_y=300):
    if not isinstance(commands, list) or not 1 <= len(commands) <= 3:
        raise ServiceError('画板回复数量不正确，请重试。')
    for command in commands:
        if not isinstance(command, dict):
            raise ServiceError('画板回复格式不正确，请重试。')
        if command.get('tool') == 'write_text':
            require_text(command.get('text'), 1200, '画板回复')
            if (type(command.get('x')) is not int or type(command.get('y')) is not int or
                    type(command.get('fontSize')) is not int or type(command.get('maxWidth')) is not int or
                    type(command.get('lineHeight')) not in (int, float) or not math.isfinite(command['lineHeight']) or
                    command['x'] < 0 or not minimum_y <= command['y'] <= 700 or
                    not 20 <= command['fontSize'] <= 54 or command['maxWidth'] < 180 or
                    not 1.2 <= command['lineHeight'] <= 1.8 or command['x'] + command['maxWidth'] > 1200):
                raise ServiceError('画板文字回复超出画板范围，请重试。')
        elif command.get('tool') == 'diagram':
            validate_canvas_diagram(command, minimum_y)
        else:
            raise ServiceError('画板回复类型不支持，请重试。')


def parse_canvas_image(value):
    prefix = 'data:image/png;base64,'
    if not isinstance(value, str) or not value.startswith(prefix):
        raise ServiceError('画板图片格式不正确。', 400)
    try:
        payload = base64.b64decode(value[len(prefix):], validate=True)
    except (ValueError, binascii.Error) as error:
        raise ServiceError('画板图片格式不正确。', 400) from error
    if not payload or len(payload) > 2 * 1024 * 1024:
        raise ServiceError('画板图片过大。', 413)
    if not payload.startswith(b'\x89PNG\r\n\x1a\n'):
        raise ServiceError('画板图片不是有效 PNG。', 415)
    return payload, 'png'


def canonical_skill(value, fallback=''):
    text = (value or '').strip()
    rules = [
        ('去括号与分配律', r'分配律|去括号|整式化简'),
        ('合并同类项', r'合并同类项'),
        ('代数式求值', r'代数式求值|整体代入|求值'),
        ('一元一次方程', r'一元一次|方程'),
        ('有理数运算', r'有理数|正负数|相反数|绝对值|分数|四则'),
        ('图形与几何', r'几何|三角|四边|圆|面积|周长|角度|勾股'),
        ('统计与概率', r'统计|概率|平均数|中位数|众数|数据'),
    ]
    return next((name for name, pattern in rules if re.search(pattern, text)), (fallback or '').strip())


def build_learning_profile(history):
    """Create a server-owned cross-task profile; never infer from demo/browser summaries."""
    tasks = {item['task'] for item in history}
    groups = {}
    for item in history:
        q = item['question']
        # Older real records may predate the explicit skill field. Reconstruct only
        # from the saved question and server-owned memory, never from a demo label.
        memory_text = ' '.join(entry.get('text', '') for entry in item['memory'])
        skill = canonical_skill(' '.join((q.get('skill', ''), q['text'], q['formula'], memory_text)), q.get('skill'))
        if not skill:
            continue
        attempts = [a for a in q['attempts'] if not a.get('superseded')]
        latest = attempts[-1] if attempts else None
        assisted = bool(q['help'] or q['external'] or any(a.get('help') or a.get('external') for a in attempts))
        concerning = q['status'] in ('wrong', 'unanswered', 'uncertain') or any(a.get('status') == 'wrong' for a in attempts) or assisted
        event_by_id = {event['id']: event for event in q['events']}
        evidence = []
        patterns = []
        for entry in item['memory']:
            if entry.get('kind') == 'inference' and entry.get('text'):
                patterns.append(entry['text'][:500])
            for event_id in entry.get('evidenceIds', []):
                event = event_by_id.get(event_id)
                if event:
                    evidence.append({'id': f"{item['task']}:{q['id']}:{event_id}",
                                     'type': event['type'], 'detail': event['detail'][:1000]})
        if not evidence and concerning and q['events']:
            event = q['events'][-1]
            evidence.append({'id': f"{item['task']}:{q['id']}:{event['id']}",
                             'type': event['type'], 'detail': event['detail'][:1000]})
        group = groups.setdefault(skill, {'knowledgePoint': skill, 'observations': [], 'concerns': 0,
                                          'reasoningPatterns': [], 'knowledgeState': {
                                              'questionCount': 0, 'wrongAttempts': 0,
                                              'assistedCompletions': 0, 'independentCompletions': 0}})
        group['concerns'] += int(concerning)
        group['reasoningPatterns'].extend(patterns[:3])
        group['knowledgeState']['questionCount'] += 1
        group['knowledgeState']['wrongAttempts'] += sum(a.get('status') == 'wrong' for a in attempts)
        group['knowledgeState']['assistedCompletions'] += int(bool(latest and latest.get('status') == 'correct' and assisted))
        group['knowledgeState']['independentCompletions'] += int(bool(latest and latest.get('status') == 'correct' and not assisted))
        group['observations'].append({
            'task': item['task'], 'question': q['id'], 'status': latest.get('status') if latest else q['status'],
            'assisted': assisted, 'patterns': patterns[:3], 'evidence': evidence[:8],
        })
    for group in groups.values():
        group['reasoningPatterns'] = list(dict.fromkeys(group['reasoningPatterns']))[:6]
        group['knowledgeState']['taskCount'] = len({o['task'] for o in group['observations']})
    candidates = [group for group in groups.values()
                  if len(group['observations']) >= 2 and group['concerns'] >= 2
                  and len({o['task'] for o in group['observations']}) >= 2]
    if len(tasks) < 2 or len(history) < 3 or not candidates:
        return {'state': 'insufficient', 'requiredTasks': 2, 'observedTasks': len(tasks)}
    candidates.sort(key=lambda group: (-(group['concerns'] * 3 + group['knowledgeState']['wrongAttempts'] * 2
                                        + group['knowledgeState']['assistedCompletions']),
                                       -len(group['reasoningPatterns']), group['knowledgePoint']))
    return {'state': 'ready', 'candidates': candidates[:3]}


class Store:
    def __init__(self, directory):
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.db = sqlite3.connect(directory / 'homework.sqlite3', check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        self.db.executescript('''
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS homework(id TEXT PRIMARY KEY, result TEXT NOT NULL, image BLOB NOT NULL, extension TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS snapshots(task TEXT, question TEXT, revision INTEGER, body TEXT NOT NULL, PRIMARY KEY(task,question));
            CREATE TABLE IF NOT EXISTS memories(task TEXT, question TEXT, revision INTEGER, entries TEXT NOT NULL, basis TEXT NOT NULL, PRIMARY KEY(task,question));
            CREATE TABLE IF NOT EXISTS requests(key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS verifications(id TEXT PRIMARY KEY, body TEXT NOT NULL);
        ''')
        self.learning = LearningModel(SQLiteAdapter(self.db, self.lock),
            confidence_threshold=float(os.environ.get('BANXUE_MAPPING_THRESHOLD', '.75')))
        self._migrate_learning()

    def healthy(self):
        with self.lock:
            return self.db.execute('SELECT 1').fetchone()[0] == 1

    def _migrate_learning(self):
        # Only saved model grades are trusted. Old browser attempts are not imported.
        with self.lock, self.db:
            self.db.execute('BEGIN')
            rows = self.db.execute('SELECT id,result FROM homework').fetchall()
            for row in rows:
                result = json.loads(row['result'])
                cid = result.get('curriculumId', DEFAULT_CURRICULUM)
                for q in result['questions']:
                    if self.learning.question(row['id'], q['id']):
                        continue
                    self.learning.record(LearningEvent(row['id'], q['id'], 'legacy-grade', cid,
                        'original_attempt', material=[q['text'], q['formula'], q['original']],
                        knowledge_points=q.get('knowledgePoints'), skill=q.get('skill', ''),
                        result=q['status'], detail=q['reason'], occurred_at=0))
                    snapshot = self.db.execute('SELECT body FROM snapshots WHERE task=? AND question=?', (row['id'], q['id'])).fetchone()
                    if snapshot:
                        current = json.loads(snapshot[0])
                        if material(current)[:3] != [q['text'], q['formula'], q['original']]:
                            self.learning.record(LearningEvent(row['id'], q['id'], 'legacy-invalidated', cid,
                                'invalidate', revision=current['revision'], material=material(current)[:3], occurred_at=0))
                        if current.get('external'):
                            self.learning.record(LearningEvent(row['id'], q['id'], 'legacy-external', cid,
                                'fact_correction', revision=current['revision'], external=True, occurred_at=0))

    def sync_facts(self, task, q):
        state = self.learning.question(task, q['id'])
        cid = state['curriculumId']
        if state['material'] != material(q)[:3]:
            self.learning.record(LearningEvent(task, q['id'], f"material:{q['revision']}", cid,
                'invalidate', revision=q['revision'], material=material(q)[:3]))
        if state['external'] != q['external']:
            self.learning.record(LearningEvent(task, q['id'], f"external:{q['revision']}", cid,
                'fact_correction', revision=q['revision'], external=q['external'], detail='学生更正外部帮助事实'))

    def verification(self, vid):
        with self.lock:
            row = self.db.execute('SELECT body FROM verifications WHERE id=?', (vid,)).fetchone()
        if not row:
            raise ServiceError('验证题不存在。', 404)
        return json.loads(row[0])

    def save_verification(self, value):
        self.db.execute('INSERT OR REPLACE INTO verifications VALUES(?,?)', (value['id'], canonical(value)))

    @staticmethod
    def public_verification(value):
        return {k: value[k] for k in ('id', 'curriculumId', 'nodeId', 'question', 'createdAt', 'shownAt', 'helpExposed', 'kind', 'result')}

    def verification_input(self, vid, answer, external):
        with self.lock, self.db:
            value = self.verification(vid)
            if value['shownAt'] is None:
                raise ServiceError('请先展示验证题，再提交作答。', 409)
            submitted = {'answer': answer, 'externalHelp': external}
            if value.get('firstSubmission') is not None:
                if value['firstSubmission'] != submitted:
                    raise ServiceError('首次作答已冻结，请保留原答案重试或创建新验证题。', 409)
                return value
            value['firstSubmission'] = submitted
            value['submittedAt'] = time.time()
            value['firstAssistance'] = 'external' if external else 'explanation' if value['helpExposed'] else 'none'
            self.save_verification(value)
            return value

    def new_verification(self, question, cid, node, model, refs, kind='independent_verification', review_of=None):
        require_text(question, 16000, '验证题')
        self.learning.mappings(cid, [{'nodeId': node, 'role': 'primary', 'confidence': 1}])
        normalized = re.sub(r'\s+', '', question)
        previous = [json.loads(r[0]) for r in self.db.execute('SELECT body FROM verifications')]
        if any(v['curriculumId'] == cid and re.sub(r'\s+', '', v['question']) == normalized for v in previous):
            raise ServiceError('验证题与已有题目重复，请重新生成。')
        value = {'id': str(uuid.uuid4()), 'curriculumId': cid, 'nodeId': node, 'question': question,
                 'model': model, 'evidenceRefs': refs, 'createdAt': time.time(), 'shownAt': None,
                 'helpExposed': False, 'kind': kind, 'reviewOf': review_of, 'result': None, 'firstSubmission': None}
        self.save_verification(value)
        return self.public_verification(value)

    def source(self, task):
        with self.lock:
            row = self.db.execute('SELECT * FROM homework WHERE id=?', (task,)).fetchone()
        if not row:
            raise ServiceError('这份作业在当前服务中不存在，请重新上传。', 410)
        return json.loads(row['result']), (row['image'], row['extension'])

    def cached(self, key, fingerprint):
        with self.lock:
            row = self.db.execute('SELECT * FROM requests WHERE key=?', (key,)).fetchone()
        if row and row['fingerprint'] != fingerprint:
            raise ServiceError('请求编号已用于其他内容，请重新发起操作。', 409)
        return json.loads(row['result']) if row else None

    def snapshot(self, task, q):
        with self.lock, self.db:
            row = self.db.execute('SELECT result FROM homework WHERE id=?', (task,)).fetchone()
            if not row:
                raise ServiceError('这份作业在当前服务中不存在，请重新上传。', 410)
            if q['id'] not in {item['id'] for item in json.loads(row['result'])['questions']}:
                raise ServiceError('当前题目不属于这份作业。', 400)
            prior = self.db.execute('SELECT revision,body FROM snapshots WHERE task=? AND question=?', (task,q['id'])).fetchone()
            if prior and prior['revision'] > q['revision']:
                raise ServiceError('已有更新的学习记录，请刷新后继续。', 409)
            if prior and prior['revision'] == q['revision'] and canonical(validate_question(json.loads(prior['body']))) != canonical(q):
                raise ServiceError('同一版本的学习内容不一致，请重新进入作业。', 409)
            self.db.execute('INSERT OR REPLACE INTO snapshots VALUES(?,?,?,?)', (task,q['id'],q['revision'],canonical(q)))
            self.sync_facts(task, q)

    def recalled(self, task, q):
        with self.lock:
            row = self.db.execute('SELECT * FROM memories WHERE task=? AND question=?', (task,q['id'])).fetchone()
        if not row:
            return []
        basis = json.loads(row['basis'])
        if material(basis) != material(q):
            return []
        current = {event['id']: event for event in q['events']}
        if any(current.get(event['id']) != event for event in basis['events']):
            return []
        return json.loads(row['entries'])

    def learning_history(self):
        with self.lock:
            rows = self.db.execute('SELECT task,question,body FROM snapshots ORDER BY task,question').fetchall()
        history = []
        for row in rows:
            q = validate_question(json.loads(row['body']))
            history.append({'task': row['task'], 'question': q, 'memory': self.recalled(row['task'], q)})
        return history

    def commit(self, key, fingerprint, action, task, q, result, image, data=None):
        with self.lock, self.db:
            self.db.execute('BEGIN')
            if q:
                latest = self.db.execute('SELECT revision FROM snapshots WHERE task=? AND question=?', (task,q['id'])).fetchone()
                if latest and latest['revision'] > q['revision']:
                    raise ServiceError('学习记录已有更新，本次旧结果未保存。', 409)
            if action == 'grade':
                self.db.execute('INSERT INTO homework VALUES(?,?,?,?)', (result['id'],canonical(result),image[0],image[1]))
            elif action == 'regions':
                original, _ = self.source(task)
                boxes = {item['id']: item['box'] for item in result['regions']}
                for question in original['questions']:
                    question['box'] = boxes[question['id']]
                self.db.execute('UPDATE homework SET result=? WHERE id=?', (canonical(original), task))
            elif action == 'memory':
                latest = self.db.execute('SELECT revision FROM snapshots WHERE task=? AND question=?', (task,q['id'])).fetchone()
                if latest and latest['revision'] > q['revision']:
                    raise ServiceError('学习记录已有更新，本次旧判断未保存。', 409)
                self.db.execute('INSERT OR REPLACE INTO memories VALUES(?,?,?,?,?)', (task,q['id'],q['revision'],canonical(result['entries']),canonical(q)))
            if action == 'grade':
                updates = []
                for item in result['questions']:
                    updates.append(self.learning.record(LearningEvent(result['id'], item['id'], key,
                        result['curriculumId'], 'original_attempt', material=[item['text'], item['formula'], item['original']],
                        knowledge_points=item.get('knowledgePoints'), skill=item.get('skill', ''),
                        result=item['status'], detail=item['reason'])))
                result['learningUpdate'] = {'curriculumId': result['curriculumId'],
                    'changedNodes': list({n['id']: n for u in updates for n in u['changedNodes']}.values())}
            elif q and action in ('recognition', 'check', 'tutor', 'canvas'):
                state = self.learning.question(task, q['id'])
                kind = {'recognition': 'recognition', 'check': 'correction_attempt', 'tutor': 'help', 'canvas': 'help'}[action]
                if kind != 'help' or result.get('help'):
                    result['learningUpdate'] = self.learning.record(LearningEvent(task, q['id'], key, state['curriculumId'],
                        kind, revision=q['revision'], material=material(q)[:3],
                        knowledge_points=result.get('knowledgePoints'), result=result.get('status', 'uncertain'),
                        assistance='explanation' if kind == 'help' else 'none',
                        detail=result.get('text', result.get('reason', '画板辅导'))))
            elif action in ('verification', 'recommendation') and result.get('state') != 'insufficient':
                node = result.get('nodeId')
                if node:
                    cid = data.get('curriculumId', DEFAULT_CURRICULUM)
                    result['verification'] = self.new_verification(
                        result['question'] if action == 'verification' else result['transferQuestion'], cid, node,
                        data.get('model'), result.get('evidenceIds', data.get('evidenceRefs', [])),
                        data.get('kind', 'independent_verification'), data.get('reviewOf'))
            elif action in ('verification_shown', 'verification_help'):
                value = self.verification(task)
                if action == 'verification_shown':
                    value['shownAt'] = value['shownAt'] or time.time()
                elif value.get('firstSubmission') is not None:
                    raise ServiceError('首次作答已冻结，不能再改写其帮助状态。', 409)
                else:
                    value['helpExposed'] = True
                self.save_verification(value)
                result.update(self.public_verification(value))
            elif action == 'verification_check':
                value = self.verification(task)
                if value['result'] is not None:
                    result.clear()
                    result.update(value['result'])
                else:
                    result['learningUpdate'] = self.learning.record(LearningEvent('verification:' + task, 'first',
                        'first-submission', value['curriculumId'], value['kind'],
                        material=[value['question']], knowledge_points=[{'nodeId': value['nodeId'], 'role': 'primary', 'confidence': 1}],
                        result=result['status'], assistance=value['firstAssistance'], detail=result['reason'],
                        occurred_at=value['submittedAt']))
                    result['verificationId'] = task
                    value['result'] = copy.deepcopy(result)
                    self.save_verification(value)
            if q:
                # Snapshot acceptance may already have invalidated old mappings or
                # corrected help facts. Include those nodes in the success delta,
                # so a client never retains a stale lit branch after recognition.
                state = self.learning.question(task, q['id'])
                projection = self.learning.tree(state['curriculumId'])
                nodes = {n['id']: n for n in projection['nodes']}
                affected = set()
                for mapping in state['mappings']:
                    nid = mapping['nodeId']
                    while nid:
                        affected.add(nid)
                        nid = nodes[nid]['parentId']
                result['learningUpdate'] = {'curriculumId': state['curriculumId'],
                    'changedNodes': [n for n in projection['nodes'] if n['id'] in affected]}
            self.db.execute('INSERT INTO requests VALUES(?,?,?)', (key,fingerprint,canonical(result)))


class Job:
    def __init__(self, key, fingerprint, action):
        self.key, self.fingerprint, self.action = key, fingerprint, action
        self.events = []
        self.done = False
        self.failed = False
        self.condition = threading.Condition()

    def append(self, event):
        with self.condition:
            self.events.append({'seq': len(self.events)+1, 'requestId': self.key, 'action': self.action,
                                'at': time.time(), **event})
            if event['type'] in ('result', 'error'):
                self.done = True
                self.failed = event['type'] == 'error'
            self.condition.notify_all()

    def stage(self, stage, label):
        self.append({'type':'progress', 'stage':stage, 'label':label})


class Gateway:
    def __init__(self, store, provider):
        self.store, self.provider = store, provider
        self.jobs = {}
        self.lock = threading.Lock()

    def submit(self, key, action, task, data, image=None):
        learning = self.store.learning
        if action == 'recommendation':
            cid = data.get('curriculumId', DEFAULT_CURRICULUM)
            profile = learning.recommendation_profile(cid)
            data = {'profile': profile, 'curriculumId': cid}
            key = 'recommendation-' + digest(data)
        elif action in ('grade', 'verification'):
            cid = data.get('curriculumId', DEFAULT_CURRICULUM)
            learning.definition(cid)
            if action == 'grade':
                data = {'note': require_text(data.get('note', ''), 4000, '作业说明', empty=True), 'curriculumId': cid}
            else:
                node = data.get('nodeId')
                learning.mappings(cid, [{'nodeId': node, 'role': 'primary', 'confidence': 1}])
                review_of = data.get('reviewOf')
                if review_of is not None:
                    require_text(review_of, 200, '复测来源')
                    prior = self.store.verification(review_of)
                    if (prior['curriculumId'] != cid or prior['nodeId'] != node or not prior['result']
                            or prior['firstAssistance'] != 'none' or prior['result']['status'] != 'correct'
                            or time.time() - prior['submittedAt'] < 86400):
                        raise ServiceError('延迟复测需要同一知识点至少 24 小时前的无帮助正确验证。', 409)
                data = {'curriculumId': cid, 'nodeId': node, 'reviewOf': review_of,
                        'kind': 'delayed_retest' if review_of else 'independent_verification'}
        require_text(key, 200, '请求编号')
        no_question = ('grade', 'regions', 'recommendation', 'verification', 'verification_check', 'verification_shown', 'verification_help')
        q = validate_question(data.get('question')) if action not in no_question else None
        if action == 'regions':
            original, image = self.store.source(task)
            data = {'questions': [{k: item[k] for k in ('id', 'text', 'formula', 'original')} for item in original['questions']]}
        if q:
            data = {**data, 'question': q}
            # These contexts are constructed only after request identity is fixed.
            for field in ('savedMemory', 'teachingContext', 'knowledgeCandidates', 'curriculumId'):
                data.pop(field, None)
        if action == 'tutor':
            require_text(data.get('message'), 4000, '学生消息')
        if action in ('check', 'verification_check'):
            require_text(data.get('answer'), 6000, '订正答案')
        if action == 'verification_check':
            external = data.get('externalHelp', False)
            if type(external) is not bool:
                raise ServiceError('帮助事实不正确。', 400)
            data = {'answer': data['answer'], 'externalHelp': external}
        if action in ('verification_shown', 'verification_help'):
            self.store.verification(task)
            data = {}
        if action == 'canvas':
            validate_canvas_board(data)
        fingerprint = digest([action, task, data, hashlib.sha256(image[0]).hexdigest() if image else None])
        with self.lock:
            job = self.jobs.get(key)
            if job and job.fingerprint != fingerprint:
                raise ServiceError('请求编号与原始内容不一致。', 409)
            if job and not job.failed:
                return job
            cached = self.store.cached(key, fingerprint)
            if cached is None and q:
                self.store.snapshot(task, q)
            if cached is None and action == 'verification_check':
                value = self.store.verification_input(task, data['answer'], data['externalHelp'])
                if value['result'] is not None:
                    # A new key may replay the same frozen first result, never regrade it.
                    cached = copy.deepcopy(value['result'])
                    self.store.commit(key, fingerprint, action, task, None, cached, None, data)
            job = Job(key, fingerprint, action)
            self.jobs[key] = job
            for old_key, old_job in list(self.jobs.items()):
                if len(self.jobs) <= 128:
                    break
                if old_key != key and old_job.done:
                    del self.jobs[old_key]
            job.stage('accepted', '请求已接收')
            if cached is not None:
                job.stage('restored', '已恢复这次请求的结果')
                job.append({'type': 'result', 'data': cached})
            elif action == 'recommendation' and data['profile']['state'] == 'insufficient':
                result = data['profile']
                self.store.commit(key, fingerprint, action, task, q, result, image, data)
                job.append({'type': 'result', 'data': result})
            else:
                threading.Thread(target=self.run, args=(job, task, data, q, image), daemon=True).start()
            return job

    def run(self, job, task, data, q, image):
        try:
            context = copy.deepcopy(data)
            context['model'] = self.provider.model
            if job.action in ('grade', 'verification'):
                context['knowledgeCandidates'] = self.store.learning.candidates(data['curriculumId'])
            if job.action == 'verification':
                with self.store.lock:
                    previous = [json.loads(r[0]) for r in self.store.db.execute('SELECT body FROM verifications')]
                context['excludedQuestions'] = [v['question'] for v in previous
                    if v['curriculumId'] == data['curriculumId'] and v['nodeId'] == data['nodeId']][-30:]
                profile = self.store.learning.recommendation_profile(data['curriculumId'])
                context['evidenceRefs'] = list(dict.fromkeys(e['id'] for group in profile.get('candidates', [])
                    if group['nodeId'] == data['nodeId'] for obs in group['observations'] for e in obs['evidence']))
                if data.get('reviewOf'):
                    context['previousQuestion'] = self.store.verification(data['reviewOf'])['question']
            if job.action == 'verification_check':
                value = self.store.verification(task)
                context = {'question': value['question'], 'answer': value['firstSubmission']['answer']}
            if q:
                state = self.store.learning.question(task, q['id'])
                context['teachingContext'] = self.store.learning.context({'task': task, 'question': q['id'], 'curriculumId': state['curriculumId']})
                if job.action == 'recognition':
                    context['knowledgeCandidates'] = self.store.learning.candidates(state['curriculumId'])
                context['savedMemory'] = self.store.recalled(task, q)
                if context['savedMemory']:
                    job.stage('context', '已读取本题的学习记录')
            if job.action in ('verification_shown', 'verification_help'):
                result = {}
            else:
                result = self.provider.generate(job.action, context, job.stage, image)
            if job.action == 'grade':
                if len(result['questions']) > 30:
                    raise ServiceError('这张图片题目过多，请分成更小的图片。')
                result['id'] = str(uuid.uuid4())
                result['curriculumId'] = data['curriculumId']
                result['title'] = require_text(result['title'],200,'作业标题')
                for index, question in enumerate(result['questions']):
                    require_text(question['text'],16000,'识别题目')
                    question['id'] = f'q-{index+1}'
                    question['box'] = valid_box(question.get('box'))
                    mappings = self.store.learning.mappings(data['curriculumId'], question.get('knowledgePoints'), question.get('skill', ''))
                    question['knowledgePoints'] = [{k: m[k] for k in ('nodeId', 'role', 'confidence')} for m in mappings]
            elif job.action == 'verification':
                require_text(result.get('question'), 16000, '验证题')
                result['nodeId'] = data['nodeId']
                if re.sub(r'\s+', '', result['question']) in {re.sub(r'\s+', '', old) for old in context['excludedQuestions']}:
                    raise ServiceError('验证题与已有题目重复，请重新生成。')
            elif job.action == 'verification_check':
                if result.get('status') not in ('correct', 'wrong', 'uncertain'):
                    raise ServiceError('验证结果无效。')
                require_text(result.get('reason'), 16000, '验证依据')
            elif job.action in ('verification_shown', 'verification_help'):
                pass
            elif job.action == 'regions':
                expected = {item['id'] for item in data['questions']}
                regions = result.get('regions', [])
                if len(regions) != len(expected) or {item.get('id') for item in regions} != expected:
                    raise ServiceError('题目定位未对应到原题，请重试。')
                for item in regions:
                    item['box'] = valid_box(item.get('box'))
            elif job.action == 'suggestions':
                validate_suggested_questions(result.get('questions'))
            elif job.action == 'memory':
                known = {event['id'] for event in q['events']}
                if len(result['entries']) > 6:
                    raise ServiceError('学习记录过长，暂未保存。')
                for entry in result['entries']:
                    if not entry['text'].strip() or not entry['evidenceIds'] or any(eid not in known for eid in entry['evidenceIds']):
                        raise ServiceError('学习判断缺少有效证据，暂未保存。')
            elif job.action == 'tutor':
                require_text(result.get('text'), 16000, '辅导内容')
                if type(result.get('help')) is not bool:
                    raise ServiceError('辅导帮助状态不正确，请重试。')
                validate_suggested_questions(result.get('suggestedQuestions'))
            elif job.action == 'canvas':
                texts, diagrams = result.get('texts'), result.get('diagrams')
                if not isinstance(texts, list) or not isinstance(diagrams, list) or (diagrams and not texts):
                    raise ServiceError('画板回复格式不正确，请重试。')
                validate_canvas_commands(texts, data['replyMinY'])
                placed = [place_canvas_diagram(diagram, data, texts) for diagram in diagrams]
                commands = [*texts, *(diagram for diagram in placed if diagram)]
                result = {'intent': result.get('intent'), 'commands': commands, 'help': result.get('help')}
                validate_canvas_commands(commands, data['replyMinY'])
            elif job.action == 'recommendation':
                profile = data['profile']
                known = {event['id'] for group in profile['candidates'] for observation in group['observations']
                         for event in observation['evidence']}
                if not 2 <= len(result['example']['steps']) <= 4:
                    raise ServiceError('推荐讲解步骤不完整，暂未采用。')
                if not result['evidenceIds'] or any(eid not in known for eid in result['evidenceIds']):
                    raise ServiceError('推荐缺少真实学习依据，暂未采用。')
                candidates = {group['nodeId']: group for group in profile['candidates']}
                node = result.get('nodeId')
                if node not in candidates:
                    raise ServiceError('推荐知识点不在有效候选中。')
                node_refs = {e['id'] for obs in candidates[node]['observations'] for e in obs['evidence']}
                if any(ref not in node_refs for ref in result['evidenceIds']):
                    raise ServiceError('推荐证据不属于目标知识点。')
                result = {'state': 'ready', **result}
                result['knowledgePoint'] = candidates[node]['knowledgePoint']
            elif not result.get('text',result.get('reason','')).strip():
                raise ServiceError('模型未返回可用内容，请重试。')
            job.stage('saving', '正在保存学习记录' if job.action == 'memory' else '正在保存执行结果')
            self.store.commit(job.key,job.fingerprint,job.action,task,q,result,image,context)
            job.stage('completed', '学习记录已保存' if job.action == 'memory' else '处理完成')
            job.append({'type':'result', 'data':result})
        except ServiceError as error:
            job.append({'type':'error','message':str(error),'status':error.status})
        except Exception as error:
            print(f'Request failed: {type(error).__name__}', flush=True)
            job.append({'type':'error','message':'本地服务未完成处理，内容已保留，请重试。','status':500})


def parse_upload(body, content_type):
    message = BytesParser(policy=policy.default).parsebytes(('Content-Type: '+content_type+'\r\nMIME-Version: 1.0\r\n\r\n').encode()+body)
    if not message.is_multipart():
        raise ServiceError('图片上传格式不正确。',400)
    image, note, curriculum_id = None, '', DEFAULT_CURRICULUM
    for part in message.iter_parts():
        name = part.get_param('name',header='content-disposition')
        payload = part.get_payload(decode=True) or b''
        if name == 'image':
            if image is not None or not payload or len(payload) > 10*1024*1024:
                raise ServiceError('请上传一张不超过 10 MB 的图片。',413)
            ext = 'png' if payload.startswith(b'\x89PNG\r\n\x1a\n') else 'jpg' if payload.startswith(b'\xff\xd8\xff') else 'webp' if payload[:4]==b'RIFF' and payload[8:12]==b'WEBP' else None
            if not ext:
                raise ServiceError('仅支持 JPG、PNG、WebP 图片。',415)
            image = (payload,ext)
        elif name == 'curriculumId':
            curriculum_id = payload.decode('utf-8', errors='replace')
        elif name == 'note':
            note = payload.decode('utf-8',errors='replace')
    if not image:
        raise ServiceError('请先选择作业图片。',400)
    require_text(note,4000,'作业说明',empty=True)
    require_text(curriculum_id, 200, '教材编号')
    return image, {'note':note, 'curriculumId': curriculum_id}


class Handler(SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PROJECT/'prototype'), **kwargs)

    def log_message(self, format, *args):
        # No request bodies, images, model text, or credentials in server logs.
        pass

    def allowed(self):
        host = self.headers.get('Host','')
        valid = {f'127.0.0.1:{self.server.server_port}',f'localhost:{self.server.server_port}'}
        origin = self.headers.get('Origin')
        if host not in valid or (origin and origin != 'http://'+host):
            return False
        if self.headers.get('Sec-Fetch-Site') != 'cross-site':
            return True
        # Desktop shells can classify an app -> localhost top-level navigation as
        # cross-site. Allow only known static entry pages; API and write requests
        # remain protected by the same-origin boundary above.
        return (getattr(self, 'command', '') == 'GET' and
                self.headers.get('Sec-Fetch-Mode') == 'navigate' and
                self.headers.get('Sec-Fetch-Dest') == 'document' and
                urlsplit(getattr(self, 'path', '')).path in
                {'/', '/index.html'})

    def json_response(self, status, value):
        body = canonical(value).encode()
        self.send_response(status)
        self.send_header('Content-Type','application/json; charset=utf-8')
        self.send_header('Content-Length',str(len(body)))
        self.send_header('Cache-Control','no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self.allowed():
            self.json_response(403,{'error':'仅允许从本机伴学页面访问。'})
            return
        if urlsplit(self.path).path == '/api/health':
            try:
                storage = self.server.gateway.store.healthy()
            except sqlite3.Error:
                storage = False
            self.json_response(200 if storage else 503,{
                'status':'ok' if storage else 'error','service':'banxue-local','storage':storage,
                'backend':'codex-cli','model':self.server.gateway.provider.model,
                'available':bool(self.server.gateway.provider.executable),'stream':'ndjson',
                'uptimeSeconds':max(0,int(time.time()-self.server.started_at))})
            return
        path = urlsplit(self.path).path
        try:
            if path == '/api/curricula':
                self.json_response(200, self.server.gateway.store.learning.curricula())
                return
            if path == '/api/learning-tree':
                cid = parse_qs(urlsplit(self.path).query).get('curriculumId', [DEFAULT_CURRICULUM])[0]
                self.json_response(200, self.server.gateway.store.learning.tree(cid))
                return
            match = re.fullmatch(r'/api/verification/([^/]+)', path)
            if match:
                store = self.server.gateway.store
                self.json_response(200, store.public_verification(store.verification(unquote(match[1]))))
                return
        except ServiceError as error:
            self.json_response(error.status, {'error': str(error)})
            return
        if self.path.startswith('/api/'):
            self.json_response(404,{'error':'接口不存在。'})
            return
        # Static handler is confined to prototype, including symlinks.
        target = Path(self.translate_path(self.path)).resolve()
        if not target.is_relative_to((PROJECT/'prototype').resolve()):
            self.json_response(403,{'error':'不可访问此路径。'})
            return
        super().do_GET()

    def do_POST(self):
        try:
            if not self.allowed():
                self.close_connection = True
                raise ServiceError('仅允许从本机伴学页面提交请求。',403)
            path = urlsplit(self.path).path
            match = re.fullmatch(r'/api/homework/([^/]+)/(suggestions|tutor|canvas|check|recognition|memory|regions)',path)
            verification_match = re.fullmatch(r'/api/verification/([^/]+)/(check|shown|help)', path)
            if path == '/api/homework':
                action, task = 'grade', None
            elif path == '/api/verification':
                action, task = 'verification', None
            elif verification_match:
                task, action = unquote(verification_match[1]), 'verification_' + verification_match[2]
            elif path == '/api/recommendation':
                action, task = 'recommendation', None
            elif match:
                task, action = unquote(match[1]), match[2]
            else:
                self.close_connection = True
                raise ServiceError('接口不存在。',404)
            length = self.headers.get('Content-Length','')
            if not length.isdigit() or not 0 < int(length) <= MAX_BODY or self.headers.get('Transfer-Encoding'):
                self.close_connection = True
                raise ServiceError('请求大小不正确或超过限制。',413)
            self.connection.settimeout(30)
            body = self.rfile.read(int(length))
            content_type = self.headers.get('Content-Type','')
            if action == 'grade':
                if not content_type.startswith('multipart/form-data'):
                    raise ServiceError('请用图片上传表单提交。',415)
                image, data = parse_upload(body, content_type)
            else:
                json_limit = 3 * 1024 * 1024 if action == 'canvas' else 512 * 1024
                if not content_type.startswith('application/json') or len(body)>json_limit:
                    raise ServiceError('消息格式不正确或内容过长。',400)
                data, image = json.loads(body), None
                if not isinstance(data,dict):
                    raise ServiceError('消息格式不正确。',400)
                if action == 'canvas':
                    image = parse_canvas_image(data.pop('canvasImage', None))
            job = self.server.gateway.submit(self.headers.get('Idempotency-Key'),action,task,data,image)
        except ServiceError as error:
            self.json_response(error.status,{'error':str(error)})
            return
        except (ValueError, TimeoutError):
            self.close_connection = True
            self.json_response(400,{'error':'请求内容不完整。'})
            return
        self.send_response(200)
        self.send_header('Content-Type','application/x-ndjson; charset=utf-8')
        self.send_header('Cache-Control','no-store')
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Connection','close')
        self.end_headers()
        self.close_connection = True
        index = 0
        try:
            while True:
                with job.condition:
                    if index == len(job.events) and not job.done:
                        job.condition.wait(10)
                    events = job.events[index:]
                    index = len(job.events)
                    done = job.done
                if not events and not done:
                    self.wfile.write(b'{"type":"heartbeat"}\n')
                for event in events:
                    self.wfile.write((canonical(event)+'\n').encode())
                self.wfile.flush()
                if done:
                    return
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            return  # Job continues and is persisted; same-key retries reattach.


def make_server(port=4178, data_dir=None, provider=None):
    store = Store(data_dir or os.environ.get('BANXUE_DATA_DIR',str(PROJECT/'.banxue')))
    server = ThreadingHTTPServer(('127.0.0.1',port),Handler)
    server.daemon_threads = True
    server.started_at = time.time()
    server.gateway = Gateway(store,provider or CodexProvider())
    return server


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port',type=int,default=4178)
    parser.add_argument('--data-dir')
    args = parser.parse_args()
    os.umask(0o077)
    server = make_server(args.port,args.data_dir)
    print(f'伴学 Codex 后端：http://127.0.0.1:{server.server_port}（仅本机）',flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
