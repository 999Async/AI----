import copy
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from codex_provider import ServiceError, validate_schema, SCHEMAS
from server import Store, Gateway, Handler, build_learning_profile, validate_question, parse_upload, validate_canvas_commands
from types import SimpleNamespace


def question(revision=1):
    return {'id':'q-1','text':'计算 2+3','formula':'','original':'4','reason':'加法计算需核对',
            'status':'wrong','skill':'整式化简','help':False,'external':False,'revision':revision,
            'messages':[],'attempts':[],'memory':[],
            'events':[{'id':f'e-{i}','type':'grade' if i==1 else 'message','detail':'测试事件','at':'2026-09-13','revision':i} for i in range(1,revision+1)]}


class FakeProvider:
    model = 'test-only'
    executable = 'fake'
    def __init__(self):
        self.calls = []
        self.started = threading.Event()
        self.release = threading.Event()
        self.block = False
    def generate(self,action,data,emit,image=None):
        self.calls.append((action,copy.deepcopy(data)))
        emit('running','测试替身执行中')
        if self.block:
            self.started.set()
            self.release.wait(3)
        if action=='grade':
            return {'title':'测试作业','questions':[{'text':'计算 2+3','formula':'','original':'4','status':'wrong','reason':'需核对','skill':'去括号','knowledgePoints':[{'nodeId':'kp-remove-parentheses','role':'primary','confidence':.95}]}]}
        if action=='memory':
            return {'entries':[{'kind':'fact','text':'原答需订正','evidenceIds':['e-1']}]}
        if action=='recommendation':
            evidence=data['profile']['candidates'][0]['observations'][0]['evidence'][0]['id']
            return {'nodeId':'kp-remove-parentheses','knowledgePoint':'去括号与分配律','gap':'括号前的负号没有分配到每一项',
                    'title':'一题学会负号去括号','reason':'这个步骤在不同作业中重复出错。',
                    'example':{'question':'化简 3−2(x−4)','steps':['先把 −2 乘到每一项','再合并同类项'],
                               'method':'括号前的数要乘括号内每一项。'},
                    'transferQuestion':'化简 5−3(2x−1)','success':'不看例题，能说出方法并独立完成。',
                    'evidenceIds':[evidence]}
        if action=='tutor':
            return {'title':'一起算','text':'从 2 往后数 3 个数。','help':True,
                    'suggestedQuestions':[{'type':'method','text':'我可以怎样检查这一步？'}]}
        if action=='suggestions':
            return {'questions':[{'type':'diagnose','text':'我原来的算法从哪一步开始不对？'},
                                 {'type':'method','text':'我可以怎样检查这一步？'}]}
        return {'status':'correct','reason':'5 正确'}


def wait(job):
    deadline=time.monotonic()+4
    with job.condition:
        while not job.done and time.monotonic()<deadline:
            job.condition.wait(.1)
    if not job.done:
        raise AssertionError('job hung')
    return job.events[-1]


class GatewayTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.store=Store(self.temp.name)
        self.provider=FakeProvider()
        self.gateway=Gateway(self.store,self.provider)
        event=wait(self.gateway.submit('grade','grade',None,{'note':''},(b'png','png')))
        self.task=event['data']['id']
    def tearDown(self):
        self.store.db.close()
        self.temp.cleanup()
    def test_regions_use_saved_image_and_preserve_learning(self):
        q=question()
        self.store.snapshot(self.task,validate_question(q))
        before=self.store.db.execute('SELECT body FROM snapshots').fetchone()[0]
        inputs=[]
        def locate(action,data,emit,image):
            inputs.append((action,data,image))
            return {'regions':[{'id':'q-1','box':[.1,.2,.8,.3]}]}
        self.provider.generate=locate
        job=wait(self.gateway.submit('regions','regions',self.task,{}))
        self.assertEqual(job['type'],'result')
        saved,image=self.store.source(self.task)
        self.assertEqual(saved['questions'][0]['box'],[.1,.2,.8,.3])
        self.assertEqual(inputs[0][2],(b'png','png'))
        self.assertEqual(self.store.db.execute('SELECT body FROM snapshots').fetchone()[0],before)
        self.assertEqual(wait(Gateway(self.store,self.provider).submit('regions','regions',self.task,{}))['data'],job['data'])
        self.assertEqual(len(inputs),1)
    def test_regions_reject_foreign_ids_and_omit_invalid_geometry(self):
        self.provider.generate=lambda *a: {'regions':[{'id':'foreign','box':[0,0,1,1]}]}
        self.assertEqual(wait(self.gateway.submit('bad-region','regions',self.task,{}))['type'],'error')
        self.provider.generate=lambda *a: {'regions':[{'id':'q-1','box':[.8,.2,.5,.2]}]}
        self.assertEqual(wait(self.gateway.submit('invalid-box','regions',self.task,{}))['data']['regions'][0]['box'],[])
        with self.assertRaises(ServiceError):
            self.gateway.submit('missing-task','regions','missing',{})

    def test_retry_coalesces_active_and_replays_after_restart(self):
        self.provider.block=True
        data={'question':question(),'message':'我不懂'}
        first=self.gateway.submit('chat','tutor',self.task,data)
        self.assertTrue(self.provider.started.wait(2))
        self.assertIs(first,self.gateway.submit('chat','tutor',self.task,data))
        self.provider.release.set()
        result=wait(first)
        restarted=Gateway(self.store,self.provider)
        self.assertEqual(wait(restarted.submit('chat','tutor',self.task,data))['data'],result['data'])
        self.assertEqual(len(self.provider.calls),2)
        with self.assertRaises(ServiceError):
            restarted.submit('chat','tutor',self.task,{**data,'message':'换了内容'})
    def test_memory_is_persisted_and_included_in_next_turn(self):
        q=question()
        self.assertEqual(wait(self.gateway.submit('memory','memory',self.task,{'question':q}))['type'],'result')
        q=question(2)
        wait(Gateway(self.store,self.provider).submit('turn2','tutor',self.task,{'question':q,'message':'继续'}))
        self.assertEqual(self.provider.calls[-1][1]['savedMemory'][0]['evidenceIds'],['e-1'])
        q['external']=True
        self.assertEqual(self.store.recalled(self.task,q),[])
    def test_contextual_questions_use_server_context_and_refresh_after_tutoring(self):
        q=question()
        initial=wait(self.gateway.submit('suggestions','suggestions',self.task,{'question':q}))
        self.assertEqual(initial['data']['questions'][0]['type'],'diagnose')
        self.assertEqual(self.provider.calls[-1][0],'suggestions')
        self.assertIn('teachingContext',self.provider.calls[-1][1])
        turn=wait(self.gateway.submit('turn-with-suggestions','tutor',self.task,{'question':q,'message':'我先这样算'}))
        self.assertEqual(turn['data']['suggestedQuestions'][0]['type'],'method')
    def test_contextual_questions_reject_duplicates_and_long_copy(self):
        self.provider.generate=lambda *args,**kwargs:{'questions':[{'type':'diagnose','text':'同一个问题'},{'type':'method','text':' 同一个问题 '} ]}
        self.assertEqual(wait(self.gateway.submit('duplicate-suggestions','suggestions',self.task,{'question':question()}))['type'],'error')
        self.provider.generate=lambda *args,**kwargs:{'questions':[{'type':'diagnose','text':'问'*121}]}
        self.assertEqual(wait(self.gateway.submit('long-suggestions','suggestions',self.task,{'question':question()}))['type'],'error')
    def test_late_memory_does_not_overwrite_new_revision(self):
        self.provider.block=True
        old=self.gateway.submit('old','memory',self.task,{'question':question()})
        self.assertTrue(self.provider.started.wait(2))
        self.store.snapshot(self.task,validate_question(question(2)))
        self.provider.release.set()
        self.assertEqual(wait(old)['status'],409)
        self.assertEqual(self.store.recalled(self.task,question(2)),[])
    def test_forged_memory_rejected_and_input_memory_not_trusted(self):
        q=question()
        q['memory']=[{'text':'已经掌握'}]
        self.assertNotIn('memory',validate_question(q))
        self.provider.generate=lambda *args,**kwargs:{'entries':[{'kind':'fact','text':'虚构','evidenceIds':['missing']}]}
        self.assertEqual(wait(self.gateway.submit('bad-memory','memory',self.task,{'question':q}))['type'],'error')
    def test_question_ownership_and_versions(self):
        q=question();q['id']='other'
        with self.assertRaises(ServiceError):
            self.gateway.submit('other','check',self.task,{'question':q,'answer':'5'})
        q=question();q['events'].append(q['events'][0])
        with self.assertRaises(ServiceError): validate_question(q)
        self.store.snapshot(self.task,validate_question(question(2)))
        with self.assertRaises(ServiceError): self.store.snapshot(self.task,validate_question(question()))
    def test_progress_is_ordered_and_contains_no_private_model_data(self):
        result=self.gateway.submit('progress','check',self.task,{'question':question(),'answer':'5'})
        wait(result)
        self.assertEqual([e['seq'] for e in result.events],list(range(1,len(result.events)+1)))
        self.assertEqual(result.events[-1]['type'],'result')
        self.assertIn('saving',[e.get('stage') for e in result.events])
    def test_ui_execution_metadata_does_not_change_learning_version(self):
        q=question()
        q['messages']=[{'role':'assistant','text':'请继续','execution':{'state':'done'}}]
        self.store.snapshot(self.task,validate_question(q))
        del q['messages'][0]['execution']
        self.store.snapshot(self.task,validate_question(q))
        self.assertNotIn('execution',validate_question(q)['messages'][0])
    def test_local_origin_boundary(self):
        handler=object.__new__(Handler)
        handler.server=SimpleNamespace(server_port=4178)
        handler.headers={'Host':'127.0.0.1:4178','Origin':'http://127.0.0.1:4178'}
        self.assertTrue(handler.allowed())
        handler.headers['Origin']='https://unrelated.example'
        self.assertFalse(handler.allowed())
        handler.headers={'Host':'unrelated.example:4178'}
        self.assertFalse(handler.allowed())

    def test_desktop_shell_navigation_does_not_weaken_api_boundary(self):
        handler=object.__new__(Handler)
        handler.server=SimpleNamespace(server_port=4178)
        handler.command='GET'
        handler.path='/index.html'
        handler.headers={'Host':'127.0.0.1:4178','Sec-Fetch-Site':'cross-site',
                         'Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'document'}
        self.assertTrue(handler.allowed())
        handler.path='/api/health'
        self.assertFalse(handler.allowed())
        handler.path='/index.html'
        handler.command='POST'
        self.assertFalse(handler.allowed())
    def test_strict_model_shape_and_image_magic(self):
        with self.assertRaises(ServiceError): validate_schema({'status':'correct'},SCHEMAS['check'])
        diagram={'tool':'diagram','kind':'rectangle_about_side'}
        text={'tool':'write_text','x':80,'y':400,'text':'把这条边看作旋转轴。','fontSize':24,'maxWidth':300,'lineHeight':1.4}
        validate_schema({'intent':'continue','texts':[text],'diagrams':[diagram],'help':True},SCHEMAS['canvas'])
        with self.assertRaises(ServiceError):
            validate_schema({'intent':'continue','texts':[text],'diagrams':[{**diagram,'kind':'freeform_svg'}],'help':True},SCHEMAS['canvas'])
        with self.assertRaises(ServiceError):
            validate_canvas_commands([{'tool':'draw'}])
        body=b'--b\r\nContent-Disposition: form-data; name="image"; filename="test.png"\r\nContent-Type: image/png\r\n\r\nnot-an-image\r\n--b--\r\n'
        with self.assertRaises(ServiceError): parse_upload(body,'multipart/form-data; boundary=b')

    def test_canvas_model_uses_semantic_template_instead_of_raw_coordinates(self):
        vector={'tool':'draw','origin':[0,0],'types':['rect','line','ellipse'],
                'items':[[120,420,220,120],[150,600,350,600],[700,520,80,45]],
                'closed':[],'fill':[0,2],'arrows':[1],'width':8,'tension':50}
        rotation=question();rotation['text']='将长方形绕其一边所在直线旋转一周，得到什么几何体？'
        text={'tool':'write_text','x':60,'y':400,'text':'把长方形的一条边看作旋转轴。','fontSize':24,'maxWidth':320,'lineHeight':1.4}
        self.provider.generate=lambda *args,**kwargs:{'intent':'continue','texts':[text],'diagrams':[{'tool':'diagram','kind':'rectangle_about_side'}],'help':True}
        board={'question':rotation,'canvasWidth':1200,'canvasHeight':760,'replyMinY':380,
               'latestInput':{'x':20,'y':400,'w':40,'h':30},'strokeCount':1}
        result=wait(self.gateway.submit('canvas-template','canvas',self.task,board,(b'png','png')))
        self.assertEqual(result['type'],'result')
        diagram=next(command for command in result['data']['commands'] if command['tool']=='diagram')
        self.assertEqual(diagram['kind'],'rectangle_about_side')
        self.assertGreaterEqual(diagram['y'],board['replyMinY'])
        self.provider.generate=lambda *args,**kwargs:{'intent':'continue','texts':[],'drawings':[vector],'help':True}
        rejected=wait(self.gateway.submit('canvas-raw-vector','canvas',self.task,board,(b'png','png')))
        self.assertEqual(rejected['type'],'error')

    def test_canvas_drops_a_diagram_when_the_question_does_not_match_its_semantics(self):
        q=question();q['text']='计算 2+3'
        text={'tool':'write_text','x':80,'y':400,'text':'先把两个数相加。','fontSize':24,'maxWidth':300,'lineHeight':1.4}
        self.provider.generate=lambda *args,**kwargs:{'intent':'continue','texts':[text],'diagrams':[{'tool':'diagram','kind':'rectangle_about_side'}],'help':True}
        board={'question':q,'canvasWidth':1200,'canvasHeight':760,'replyMinY':380,
               'latestInput':{'x':20,'y':400,'w':40,'h':30},'strokeCount':1}
        result=wait(self.gateway.submit('canvas-template-mismatch','canvas',self.task,board,(b'png','png')))
        self.assertEqual(result['type'],'result')
        self.assertEqual([command['tool'] for command in result['data']['commands']],['write_text'])

    def test_recommendation_requires_cross_task_real_evidence(self):
        profile=build_learning_profile(self.store.learning_history())
        self.assertEqual(profile['state'],'insufficient')
        tasks=[self.task]
        for index in range(2):
            tasks.append(wait(self.gateway.submit(f'grade-{index}','grade',None,{'note':''},(b'png','png')))['data']['id'])
        for index,task in enumerate(tasks):
            q=question()
            wait(self.gateway.submit(f'memory-{index}','memory',task,{'question':q}))
        profile=build_learning_profile(self.store.learning_history())
        self.assertEqual(profile['state'],'ready')
        result=wait(self.gateway.submit('ignored','recommendation',None,{}))
        self.assertEqual(result['data']['state'],'ready')
        self.assertEqual(result['data']['knowledgePoint'],'去括号')
        self.assertEqual(result['data']['nodeId'],'kp-remove-parentheses')
        self.assertIn('verification',result['data'])
        self.assertEqual(self.provider.calls[-1][0],'recommendation')

    def test_recommendation_rebuilds_legacy_skill_from_saved_evidence(self):
        history=[]
        for task,qid in (('older-a','q-1'),('older-b','q-1'),('older-b','q-2')):
            q=question()
            q['id']=qid
            q['skill']=''
            q['text']='一个圆与正方形周长相等，求正方形边长。'
            history.append({'task':task,'question':q,'memory':[{
                'kind':'inference','text':'求出圆周长后，分给正方形四条边的步骤仍需确认。','evidenceIds':['e-1']}]})
        profile=build_learning_profile(history)
        self.assertEqual(profile['state'],'ready')
        self.assertEqual(profile['candidates'][0]['knowledgePoint'],'图形与几何')
        self.assertEqual(profile['candidates'][0]['knowledgeState']['taskCount'],2)
        self.assertTrue(profile['candidates'][0]['reasoningPatterns'])

    def test_recommendation_rejects_untraceable_evidence(self):
        tasks=[self.task]
        for index in range(2):
            tasks.append(wait(self.gateway.submit(f'more-grade-{index}','grade',None,{'note':''},(b'png','png')))['data']['id'])
        for index,task in enumerate(tasks):
            wait(self.gateway.submit(f'more-memory-{index}','memory',task,{'question':question()}))
        original=self.provider.generate
        def forged(action,data,emit,image=None):
            result=original(action,data,emit,image)
            if action=='recommendation': result['evidenceIds']=['missing']
            return result
        self.provider.generate=forged
        self.assertEqual(wait(self.gateway.submit('ignored','recommendation',None,{}))['type'],'error')


if __name__=='__main__': unittest.main()
