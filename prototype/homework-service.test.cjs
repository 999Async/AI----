const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {test} = require('node:test');
function setup(fetch) {
  const context=vm.createContext({setTimeout,clearTimeout,structuredClone,FormData,AbortController,TextDecoder,fetch,crypto:require('node:crypto').webcrypto});
  vm.runInContext(fs.readFileSync(__dirname+'/vendor/penecho/draw.js','utf8'),context);
  vm.runInContext(fs.readFileSync(__dirname+'/homework-service.js','utf8'),context);
  return context.HomeworkService;
}
test('malformed and duplicated question IDs fail closed; unknown verdict stays uncertain',()=>{
  const s=setup();
  assert.throws(()=>s.graded({id:'task',questions:[{id:'q',text:''}]}));
  assert.throws(()=>s.graded({id:'task',questions:[{id:'q',text:'a'},{id:'q',text:'b'}]}));
  assert.equal(s.graded({id:'task',questions:[{id:'q',text:'a',status:'mastered'}]}).questions[0].status,'uncertain');
});
test('memory must cite existing evidence; stale memory never enters tutoring context',()=>{
  const s=setup(),q=s.question({id:'q',text:'a'},0),event=s.record(q,'message','student work');
  assert.throws(()=>s.memoryResult({entries:[{kind:'inference',text:'claim',evidenceIds:['invented']}]},q));
  assert.throws(()=>s.memoryResult({entries:[{kind:'inference',text:'claim',evidenceIds:[]}]},q));
  q.memory={status:'ready',evidenceRevision:q.revision,entries:s.memoryResult({entries:[{kind:'fact',text:'work',evidenceIds:[event.id]}]},q)};
  assert.equal(s.payload(q).memory.length,1);
  s.record(q,'external','corrected help');
  assert.equal(s.payload(q).memory.length,0);
});
test('contextual questions are bounded, typed and unique',()=>{
  const s=setup();
  const result=s.suggestedQuestions({questions:[{type:'diagnose',text:' 我是从哪一步开始不对的？ '},{type:'extend',text:'如果数字变了，方法还一样吗？'}]});
  assert.equal(result.length,2);assert.equal(result[0].text,'我是从哪一步开始不对的？');
  assert.throws(()=>s.suggestedQuestions({questions:new Array(4).fill({type:'method',text:'问题'})}));
  assert.throws(()=>s.suggestedQuestions({questions:[{type:'answer',text:'直接告诉我答案'}]}));
  assert.throws(()=>s.suggestedQuestions({questions:[{type:'method',text:'重复'},{type:'diagnose',text:' 重复 '}]}));
  assert.throws(()=>s.suggestedQuestions({questions:[{type:'method',text:'问'.repeat(121)}]}));
});
test('suggestion and tutor endpoints return model-generated follow-up questions',async()=>{
  const calls=[];
  const s=setup(async(url,options)=>{calls.push({url,options});const tutor=url.endsWith('/tutor');return {ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=>tutor
    ?{title:'一起想',text:'先检查括号前的系数。',help:true,suggestedQuestions:[{type:'method',text:'系数要乘括号里的哪些项？'}]}
    :{questions:[{type:'diagnose',text:'我原来的写法从哪一步开始不对？'}]}};});
  const q=s.question({id:'q',text:'化简 2(x−3)',original:'2x−3',status:'wrong'},0),task={remoteId:'task'};
  const initial=await s.api.suggestions(task,q,'suggest-1');
  const reply=await s.api.chat(task,q,'我不确定去括号这一步','tutor-1');
  assert.equal(initial[0].type,'diagnose');assert.equal(reply.suggestedQuestions[0].type,'method');
  assert.equal(calls[0].url,'/api/homework/task/suggestions');
  assert.equal(JSON.parse(calls[0].options.body).question.original,'2x−3');
});
test('a missing real service fails clearly',async()=>{
  let calls=0;const s=setup(async()=>{calls++;return {status:404,ok:false};});
  await assert.rejects(s.api.chat({remoteId:'task'},s.question({id:'q',text:'a'},0),'message','id-1'),/尚未连接/);
  assert.equal(calls,1);
});
test('transport retains idempotency key and rejects an HTML fallback',async()=>{
  let received;const s=setup(async(url,options)=>{received={url,options};return {status:200,ok:true,headers:{get:()=> 'text/html'}};});
  await assert.rejects(s.api.check({remoteId:'a/b'},s.question({id:'q',text:'a'},0),'4','stable-key'),/有效结果/);
  assert.equal(received.url,'/api/homework/a%2Fb/check');
  assert.equal(received.options.headers['Idempotency-Key'],'stable-key');
  assert.equal(JSON.parse(received.options.body).answer,'4');
});
test('recognition correction keeps a traceable material history',()=>{
  const s=setup(),q=s.question({id:'q',text:'原题',formula:'x+1=3',original:'x=1',status:'wrong'},0);
  q.materialHistory.push({text:q.text,formula:q.formula,original:q.original});
  q.text=[q.text,q.formula].filter(Boolean).join('\n');q.formula='';q.original='x = 4';
  assert.equal(q.materialHistory[0].original,'x=1');
  assert.equal(s.payload(q).original,'x = 4');
});
test('superseded answers cannot become current progress or independent mastery',async()=>{
  const s=setup(),q=s.question({id:'q',text:'题目',status:'wrong'},0);
  const first=s.record(q,'attempt','old correct answer');
  q.attempts.push({status:'correct',eventId:first.id,superseded:true});
  s.record(q,'recognition','corrected material');q.status='uncertain';
  const current=q.attempts.filter(a=>!a.superseded);
  assert.equal(current.length,0);
  assert.equal(s.payload(q).status,'uncertain');
});

test('NDJSON forwards progress and handles UTF-8 split across chunks',async()=>{
  const streamEvents=[{type:'progress',requestId:'stream',seq:1,stage:'running',label:'正在处理',at:1},{type:'result',requestId:'stream',seq:2,data:{status:'correct',reason:'答案正确'}}];
  const bytes=new TextEncoder().encode(streamEvents.map(JSON.stringify).join('\n')+'\n');
  let index=0;
  const s=setup(async()=>({ok:true,status:200,headers:{get:()=> 'application/x-ndjson'},body:new ReadableStream({pull(controller){if(index<bytes.length){controller.enqueue(bytes.slice(index,index+3));index+=3;}else controller.close();}})}));
  const events=[];s.onProgress(e=>events.push(e));
  const result=await s.api.check({remoteId:'task'},s.question({id:'q',text:'题目'},0),'5','stream');
  assert.equal(result.reason,'答案正确');assert.equal(events[0].label,'正在处理');assert.equal(events.at(-1).type,'result');
});
test('stream errors and incomplete responses cannot become model answers',async()=>{
  for(const body of [JSON.stringify({type:'error',requestId:'bad',message:'Codex 额度不足'})+'\n',JSON.stringify({type:'progress',requestId:'bad',stage:'running'})+'\n']){
    const bytes=new TextEncoder().encode(body);
    const s=setup(async()=>({ok:true,status:200,headers:{get:()=> 'application/x-ndjson'},body:new ReadableStream({start(controller){controller.enqueue(bytes);controller.close();}})}));
    await assert.rejects(s.api.chat({remoteId:'task'},s.question({id:'q',text:'题目'},0),'请帮我','bad'),/额度不足|连接中断/);
  }
});

test('image regions preserve normalized coordinates and omit invalid or absent boxes',()=>{
  const s=setup();
  assert.deepEqual(Array.from(s.question({id:'q',text:'题',box:[.1,.2,.8,.3]},0).box),[.1,.2,.8,.3]);
  for(const box of [undefined,[],[0,0,0,1],[.8,0,.5,1],[-.1,0,1,1],[0,0,NaN,1],['0',0,1,1]])assert.equal(s.question({id:'q',text:'题',box},0).box,null);
});
test('legacy region lookup keeps original question IDs and rejects mismatched results',async()=>{
  let received;
  const s=setup(async(url,options)=>{received={url,options};return {ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=>({regions:[{id:'q-1',box:[0,.1,1,.2]}]})};});
  const result=await s.api.regions({remoteId:'task',questions:[{id:'q-1'}]},'regions-key');
  assert.equal(result[0].id,'q-1');assert.equal(received.url,'/api/homework/task/regions');
  assert.equal(received.options.headers['Idempotency-Key'],'regions-key');
  await assert.rejects(s.api.regions({remoteId:'task',questions:[{id:'another'}]},'bad'),/未对应/);
});
test('canvas accepts a verified teaching diagram and rejects raw model vectors',async()=>{
  const diagram={tool:'diagram',kind:'rectangle_about_side',x:120,y:400,width:880,height:280};
  const s=setup(async()=>({ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=>({intent:'continue',commands:[diagram],help:true})}));
  const q=s.question({id:'q',text:'将长方形绕其一边旋转一周',status:'wrong'},0);
  const result=await s.api.canvas({remoteId:'task'},q,{canvasImage:'data:image/png;base64,x',canvasWidth:1200,canvasHeight:760,replyMinY:380,latestInput:{x:1,y:400,w:10,h:10},strokeCount:1},'diagram');
  assert.equal(result.commands[0].tool,'diagram');
  assert.equal(result.commands[0].kind,'rectangle_about_side');
  const raw={tool:'draw',origin:[0,0],types:['rect'],items:[[120,420,220,120]],closed:[],fill:[],arrows:[],width:8,tension:50};
  const broken=setup(async()=>({ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=>({intent:'continue',commands:[raw],help:true})}));
  await assert.rejects(broken.api.canvas({remoteId:'task'},q,{},'raw-vector'),/无法显示的内容/);
});
