const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {test}=require('node:test');
const uploadCSS=fs.readFileSync(__dirname+'/upload.css','utf8');

function uploadContext(history='<section class="history-fixture">history</section>'){
  const document={addEventListener(){},getElementById(){return null;},querySelector(){return null;}};
  const context=vm.createContext({document,console});
  context.window=context;
  context.URL={createObjectURL:()=>'',revokeObjectURL(){}};
  context.HomeworkFlow={historyHTML:()=>history,startUpload(){}};
  vm.runInContext(fs.readFileSync(__dirname+'/upload.js','utf8'),context);
  context.BanxueUpload.init(()=>{});
  return context;
}

test('homework starts with the same centered picker and defers confirmation',()=>{
  const html=uploadContext().BanxueUpload.view('homework');
  assert.doesNotMatch(html,/上传已完成的作业，保留原答/);
  assert.doesNotMatch(html,/<h2>上传你的作业<\/h2>/);
  assert.doesNotMatch(html,/<section class="upload-form"/);
  assert.match(html,/class="upload-empty"/);
  assert.doesNotMatch(html,/upload-homework-empty|upload-homework-primary/);
  assert.match(html,/请拍全题目、答案和计算步骤/);
  assert.doesNotMatch(html,/class="upload-inline-form"/);
  assert.doesNotMatch(html,/data-upload-note="homework"/);
  assert.doesNotMatch(html,/upload-confirm-homework/);
  assert.match(html,/class="history-fixture"/);
  const order=['upload-choose-homework','或拖动图片到这里','JPG、PNG、WebP','请拍全题目'].map(value=>html.indexOf(value));
  assert.deepEqual(order,[...order].sort((a,b)=>a-b));
  assert.match(html,/class="upload-formats"[^>]*>[^<]+<\/p><p class="upload-framing-tip">请拍全题目、答案和计算步骤。<\/p><\/div>/);
  assert.match(uploadCSS,/\.upload-empty>p\.upload-framing-tip\{align-self:stretch;width:100%;max-width:none;[^}]*text-align:center/);
});

test('homework shows note and confirmation after an image is ready',()=>{
  const context=uploadContext();
  context.BanxueUpload.restore('homework',{name:'作业.jpg',size:1024,type:'image/jpeg'},'');
  const html=context.BanxueUpload.view('homework');
  assert.match(html,/class="upload-preview"/);
  assert.match(html,/class="upload-inline-form" aria-label="作业说明与确认"/);
  assert.match(html,/>补充说明<span>选填<\/span><\/label>/);
  assert.match(html,/data-upload-note="homework"/);
  assert.match(html,/upload-confirm-homework/);
  assert.doesNotMatch(html,/upload-confirm-homework[^>]+disabled/);
});

test('question upload removes duplicate prompts and does not show homework history',()=>{
  const html=uploadContext().BanxueUpload.view('single');
  assert.doesNotMatch(html,/把题目图片放到这里/);
  assert.doesNotMatch(html,/让题目信息完整，方便接着讨论/);
  assert.match(html,/拍清楚这三处/);
  assert.doesNotMatch(html,/history-fixture/);
});

test('homework confirmation button shares the note field width',()=>{
  assert.match(uploadCSS,/\.upload-inline-form \.upload-confirm\{display:flex;margin-inline:0\}/);
  assert.match(uploadCSS,/\.upload-homework \.upload-dropzone::before\{border-color:#b2a0cd\}/);
  assert.match(uploadCSS,/\.upload-homework \.upload-picker-content\{min-height:330px;display:flex;flex-direction:column;justify-content:center\}/);
});

function historyContext(records){
  const document={addEventListener(){},getElementById(){return null;},querySelector(){return null;},querySelectorAll(){return [];}};
  const context=vm.createContext({document,sessionStorage:{getItem:()=>null,setItem(){},removeItem(){}},setTimeout,clearTimeout,structuredClone,console});
  context.window=context;
  context.scrollTo=()=>{};
  context.matchMedia=()=>({matches:false});
  context.URL={createObjectURL:()=>'',revokeObjectURL(){}};
  context.HomeworkService={onProgress(){},store:{list:async()=>records,put:async()=>{}},api:{}};
  context.LearningRecords={update(){},leave(){},open(){}};
  context.LearningRecommendation={invalidate(){}};
  vm.runInContext(fs.readFileSync(__dirname+'/homework.js','utf8'),context);
  return context.HomeworkFlow.init(()=>{},()=>{}).then(()=>context);
}

function task(id,purpose,title){
  return {id,mode:'api',purpose,title,phase:'work',updatedAt:'2026-09-15T08:00:00Z',questions:[{id:id+'-q',number:1,status:'wrong',attempts:[],memory:{status:'idle'},reason:'需要订正'}]};
}

test('history shows real homework records and excludes single-question sessions',async()=>{
  const context=await historyContext([task('homework','homework','九月作业'),task('single','single','题目答疑')]);
  const html=context.HomeworkFlow.historyHTML();
  assert.match(html,/历史批改记录/);
  assert.match(html,/九月作业/);
  assert.doesNotMatch(html,/题目答疑/);
  assert.match(html,/data-hw="resume" data-id="homework"/);
});

test('history has an honest empty state instead of sample records',async()=>{
  const context=await historyContext([]);
  const html=context.HomeworkFlow.historyHTML();
  assert.match(html,/class="upload-history-empty-art" src="assets\/history-empty-v3\.png\?v=1" width="512" height="512" alt="" aria-hidden="true"/);
  assert.doesNotMatch(html,/history-bunny|history-folder-inside|class="clock"/);
  assert.match(html,/<p>还没有历史批改记录哦<\/p>/);
  assert.doesNotMatch(html,/保存在此浏览器/);
  assert.doesNotMatch(html,/data-hw="resume"/);
});
