const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {test}=require('node:test');

async function render(candidate,overrides={},harness=null){
  const question={id:'current-q',number:3,text:'当前题',formula:'',original:'15.7厘米',status:'wrong',reason:'需核对',skill:'图形与几何',
    messages:[],attempts:[],events:[],materialHistory:[],draft:'',answer:'',panel:'overview',help:false,external:false,revision:0,
    suggestions:{status:'idle',items:[],basedOnRevision:-1,requestId:null,error:''},
    memory:{status:'idle',entries:[],evidenceRevision:0},recognitionText:null,recognitionAnswer:null,error:null,...overrides};
  const task={id:'current',remoteId:'remote',mode:'api',purpose:'homework',title:'当前作业',image:null,note:'',phase:'work',questions:[question],
    selected:question.id,createdAt:'2026-09-14',updatedAt:'2026-09-14',filter:'all'};
  const listeners={};
  const document={addEventListener(type,handler){listeners[type]=handler;},getElementById(){return null;},querySelector(){return null;},querySelectorAll(){return [];}};
  const context=vm.createContext({document,sessionStorage:{getItem:()=>task.id,setItem(){},removeItem(){}},setTimeout,clearTimeout,structuredClone,console});
  context.window=context;context.scrollTo=()=>{};context.matchMedia=()=>({matches:false});
  context.URL={createObjectURL:()=>'',revokeObjectURL(){}};
  context.HomeworkService={id:()=> 'id',box:()=>null,suggestedQuestions:raw=>raw.questions,onProgress(){},api:{},record(){},store:{list:async()=>[task],get:async()=>task,put:async()=>{}}};
  context.HomeworkCanvas={ensure(q){q.canvas??={version:1,strokes:[],aiItems:[],drafts:[],focus:false};return q.canvas;},view(q,busy,focus){return `<section class="${focus?'focus-canvas':'inline-canvas'}"><button data-hw="canvas-focus-${focus?'exit':'enter'}"></button></section>`;},mount(){}};
  context.LearningSummary={similarPastWrong:()=>candidate};
  context.LearningRecords={open(){},leave(){},update(){}};
  context.LearningRecommendation={invalidate(){}};
  vm.runInContext(fs.readFileSync(__dirname+'/homework.js','utf8'),context);
  await context.HomeworkFlow.init(()=>{},()=>{});
  if(harness)Object.assign(harness,{context,listeners,question,task});
  return context.HomeworkFlow.view();
}

test('similar-question region is absent when no historical match exists',async()=>{
  const html=await render(null);
  assert.doesNotMatch(html,/hw-memory-cue|similar past|similar history/i);
  assert.doesNotMatch(html,/暂未找到考点相近/);
});

test('multiple-choice recognition work is not repeated as part of the question',async()=>{
  const html=await render(null,{
    text:'4．下列说法正确的是（ ）。A．单项式ab²的次数是2；B．单项式ab²的系数为0；C．多项式b²−abc的次数是2；D．多项式b²−abc的二次项系数是1',
    formula:'ab²的次数为3；b²−abc的二次项系数为1',
    original:'A'
  });
  assert.doesNotMatch(html,/ab²的次数为3/);
  assert.match(html,/图片中的原答[\s\S]*>A</);
});

test('a standalone formula remains visible for a non-choice question',async()=>{
  const html=await render(null,{text:'化简下列式子',formula:'2(x−3)+4'});
  assert.match(html,/class="hw-formula"[\s\S]*2\(x−3\)\+4/);
});

test('similar-question region appears only with a linked historical wrong question',async()=>{
  const html=await render({taskId:'past',questionId:'past-q',taskTitle:'上次作业',number:2,question:'过去的错题',reason:'同属“图形性质与计算”考点'});
  assert.match(html,/class="hw-memory-cue"/);
  assert.match(html,/上次作业 · 第 2 题：过去的错题/);
  assert.match(html,/data-task="past" data-question="past-q"/);
});

test('four-choice questions render the stem and each option on its own row',async()=>{
  const html=await render(null,{text:'1．−6的倒数是（ ）。A．6；B．−6；C．−1/6；D．1/6'});
  assert.match(html,/<p class="hw-question-stem">1．−6的倒数是（ ）。<\/p>/);
  assert.match(html,/<ol class="hw-question-options" aria-label="选项">/);
  for(const option of ['A．<\/span><span>6','B．<\/span><span>−6','C．<\/span><span>−1\/6','D．<\/span><span>1\/6'])assert.match(html,new RegExp(option));
});

test('non-choice questions keep their original text without an option list',async()=>{
  const html=await render(null,{text:'化简 2(x−3)'});
  assert.match(html,/<p class="hw-question-stem">化简 2\(x−3\)<\/p>/);
  assert.doesNotMatch(html,/hw-question-options/);
});

test('model questions appear above an empty free-form composer',async()=>{
  const html=await render(null,{panel:'chat',suggestions:{status:'ready',items:[
    {type:'diagnose',text:'我原来的写法从哪一步开始不对？'},
    {type:'extend',text:'如果数字变了，方法还一样吗？'}],basedOnRevision:0,requestId:null,error:''}});
  assert.match(html,/你可以这样问，也可以直接写自己的问题/);
  assert.match(html,/data-hw="suggestion" data-index="0"/);
  assert.match(html,/我原来的写法从哪一步开始不对？/);
  assert.match(html,/<textarea id="hw-message"[^>]*><\/textarea>/);
  assert.ok(html.indexOf('hw-chat-suggestions')<html.indexOf('hw-chat-compose'));
});

test('failed question generation preserves the free-form composer and offers retry',async()=>{
  const html=await render(null,{panel:'chat',suggestions:{status:'error',items:[],basedOnRevision:-1,requestId:'same-key',error:'服务失败'}});
  assert.match(html,/推荐问题暂时没准备好，你仍可以直接提问/);
  assert.match(html,/data-hw="retry-suggestions"/);
  assert.match(html,/id="hw-message"/);
});

test('focused canvas replaces the split homework workspace',async()=>{
  const html=await render(null,{panel:'chat',togetherMode:'canvas',canvas:{version:1,strokes:[],aiItems:[],drafts:[],focus:true}});
  assert.match(html,/class="hw-canvas-page"/);
  assert.match(html,/class="focus-canvas"/);
  assert.match(html,/data-hw="canvas-focus-exit"/);
  assert.doesNotMatch(html,/class="hw-grid"/);
});

test('choosing canvas mode stays inline until the student requests fullscreen',async()=>{
  const harness={};
  await render(null,{panel:'chat',togetherMode:'chat'},harness);
  harness.listeners.click({target:{closest:()=>({disabled:false,dataset:{hw:'together-canvas'}})}});

  assert.equal(harness.question.togetherMode,'canvas');
  assert.equal(harness.question.canvas.focus,false);
  const html=harness.context.HomeworkFlow.view();
  assert.match(html,/class="inline-canvas"/);
  assert.match(html,/data-hw="canvas-focus-enter"/);
  assert.doesNotMatch(html,/class="hw-canvas-page"/);
});

test('grading prefetches questions for the first actionable result before background memory',async()=>{
  const listeners={},calls=[],memoryTimers=[];let sequence=0,markSuggestion;
  const suggestionStarted=new Promise(resolve=>{markSuggestion=resolve;});
  const question=(id,status)=>({id,number:id==='q-correct'?1:2,text:'题目',formula:'',original:'原答',status,reason:status==='correct'?'原答正确':'需要订正',skill:'有理数',
    messages:[],attempts:[],events:[],materialHistory:[],draft:'',answer:'',panel:'overview',togetherMode:'chat',help:false,external:false,revision:0,
    suggestions:{status:'idle',items:[],basedOnRevision:-1,requestId:null,error:''},memory:{status:'idle',entries:[],evidenceRevision:0},recognitionText:null,recognitionAnswer:null,error:null});
  const document={addEventListener(type,handler){listeners[type]=handler;},getElementById(){return null;},querySelector(){return null;},querySelectorAll(){return [];}};
  const context=vm.createContext({document,sessionStorage:{getItem:()=>null,setItem(){},removeItem(){}},
    setTimeout(fn,delay){if(delay===500){memoryTimers.push(fn);return memoryTimers.length;}return setTimeout(fn,delay);},clearTimeout(){},structuredClone,console});
  context.window=context;context.scrollTo=()=>{};context.matchMedia=()=>({matches:false});context.URL={createObjectURL:()=>'',revokeObjectURL(){}};
  context.HomeworkService={id:()=>`request-${++sequence}`,box:()=>null,suggestedQuestions:raw=>raw.questions,onProgress(){},
    record(q){q.revision++;return{id:`event-${q.revision}`,at:'2026-09-16'};},
    api:{
      grade:async()=>{calls.push('grade');return{id:'remote',title:'新作业',questions:[question('q-correct','correct'),question('q-wrong','wrong')]};},
      suggestions:async(_task,q)=>{calls.push(`suggestions:${q.id}`);markSuggestion(q.id);return[{type:'diagnose',text:'我应该先检查哪一步？'}];},
      remember:async(_task,q)=>{calls.push(`memory:${q.id}`);return[];}
    },store:{list:async()=>[],get:async()=>null,put:async()=>{}}};
  context.LearningSummary={similarPastWrong:()=>null};context.LearningRecords={open(){},leave(){},update(){}};context.LearningRecommendation={invalidate(){}};
  vm.runInContext(fs.readFileSync(__dirname+'/homework.js','utf8'),context);
  await context.HomeworkFlow.init(()=>{},()=>{});
  context.HomeworkFlow.startUpload({name:'fixture.png'},'','homework');
  const selected=await Promise.race([suggestionStarted,new Promise((_,reject)=>setTimeout(()=>reject(Error('推荐问题没有在批改后预取')),120))]);
  assert.equal(selected,'q-wrong');
  assert.deepEqual(calls,['grade','suggestions:q-wrong']);
  assert.equal(memoryTimers.length,2);
});

test('choosing a recommended question only fills the composer and does not call the tutor',async()=>{
  const listeners={},input={value:'',focus(){},setSelectionRange(){}},calls=[];
  const question={id:'q',number:1,text:'化简 2(x−3)',formula:'',original:'2x−3',status:'wrong',reason:'需核对',skill:'去括号',
    messages:[],attempts:[],events:[],materialHistory:[],draft:'',answer:'',panel:'chat',help:false,external:false,revision:0,
    suggestions:{status:'ready',items:[{type:'diagnose',text:'我原来的写法从哪一步开始不对？'}],basedOnRevision:0,requestId:null,error:''},
    memory:{status:'idle',entries:[],evidenceRevision:0},recognitionText:null,recognitionAnswer:null,error:null};
  const task={id:'task',remoteId:'remote',mode:'api',purpose:'homework',title:'作业',image:null,note:'',phase:'work',questions:[question],selected:'q',createdAt:'2026-09-14',updatedAt:'2026-09-14',filter:'all'};
  const document={addEventListener(type,handler){listeners[type]=handler;},getElementById(id){return id==='hw-message'?input:null;},querySelector(){return null;},querySelectorAll(){return [];}};
  const context=vm.createContext({document,sessionStorage:{getItem:()=>task.id,setItem(){},removeItem(){}},setTimeout,clearTimeout,structuredClone,console});
  context.window=context;context.scrollTo=()=>{};context.matchMedia=()=>({matches:false});context.URL={createObjectURL:()=>'',revokeObjectURL(){}};
  context.HomeworkService={id:()=> 'request',box:()=>null,suggestedQuestions:raw=>raw.questions,onProgress(){},api:{chat:async()=>{calls.push('chat');}},record(){},store:{list:async()=>[task],get:async()=>task,put:async()=>{}}};
  context.LearningSummary={similarPastWrong:()=>null};context.LearningRecords={open(){},leave(){},update(){}};context.LearningRecommendation={invalidate(){}};
  vm.runInContext(fs.readFileSync(__dirname+'/homework.js','utf8'),context);
  await context.HomeworkFlow.init(()=>{},()=>{});
  listeners.click({target:{closest:()=>({disabled:false,dataset:{hw:'suggestion',index:'0'}})}});
  await context.HomeworkFlow.flush();
  assert.equal(question.draft,'我原来的写法从哪一步开始不对？');
  assert.deepEqual(calls,[]);
});
