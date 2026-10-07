const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const {test}=require('node:test');
const context=vm.createContext({});vm.runInContext(fs.readFileSync(__dirname+'/learning.js','utf8'),context);
const {aggregate,classify,plan,similarPastWrong}=context.LearningSummary;
const q=(id,skill,status,extra={})=>({id,number:1,text:'test',skill,status,revision:1,events:[{id:'e1'}],attempts:[],messages:[],memory:{status:'ready',evidenceRevision:1,entries:[]},...extra});
const task=(id,mode,questions)=>({id,mode,questions,phase:'work',title:id,updatedAt:'2026-09-13'});
function recordsUI(){
 const document={addEventListener(){},getElementById(){return null;},querySelectorAll(){return [];}};
 const sessionStorage={getItem(){return null;},setItem(){},removeItem(){}};
 const context=vm.createContext({document,sessionStorage,console,HomeworkFlow:{leave(){},flush:async()=>{}},HomeworkService:{store:{list:async()=>[]}}});
 context.window=context;context.scrollTo=()=>{};
 vm.runInContext(fs.readFileSync(__dirname+'/learning.js','utf8'),context);
 return context.LearningRecords;
}
test('records merge by canonical skill across all homework tasks and keep source links',()=>{
 const result=aggregate([task('a','api',[q('q1','整式化简','wrong')]),task('b','api',[q('q2','分配律与合并同类项','correct')])]);
 assert.equal(result.groups.length,1);assert.equal(result.groups[0].name,'去括号与分配律');
 assert.equal(result.groups[0].graded,2);assert.equal(result.groups[0].rate,50);
 assert.deepEqual(Array.from(result.groups[0].records,r=>r.taskId).sort(),['a','b']);
});
test('demo and real records never contribute to the same summary',()=>{
 const tasks=[task('a','api',[q('q1','一元一次方程','wrong')]),task('b','demo',[q('q1','一元一次方程','correct')])];
 assert.equal(aggregate(tasks).domains.find(d=>d.id==='equations').rate,0);
 assert.equal(aggregate(tasks,'demo').domains.find(d=>d.id==='equations').rate,100);
});
test('assisted correction changes progress without increasing original-answer rate',()=>{
 const result=aggregate([task('a','api',[q('q1','整式化简','wrong',{help:true,attempts:[{status:'correct',help:true,value:'x'}]})])]);
 assert.equal(result.corrected,1);assert.equal(result.assisted,1);assert.equal(result.pending,0);assert.equal(result.groups[0].rate,0);
});
test('uncertain and unanswered originals do not become zero scores; missing domains remain null',()=>{
 const result=aggregate([task('a','api',[q('q1','整式化简','uncertain'),q('q2','整式化简','unanswered')])]);
 assert.equal(result.domains.every(d=>d.rate===null),true);assert.equal(result.pending,1);assert.equal(result.uncertain,1);
});
test('superseded attempts and obsolete memory cannot become current learning evidence',()=>{
 const question=q('q1','整式化简','wrong',{revision:2,attempts:[{status:'correct',superseded:true}],memory:{status:'ready',evidenceRevision:1,entries:[{kind:'progress',text:'done',evidenceIds:['e1']}]}});
 const result=aggregate([task('a','api',[question])]);
 assert.equal(result.corrected,0);assert.equal(result.pending,1);assert.equal(result.records[0].memory.length,0);
});
test('unknown skills stay unclassified instead of inventing a radar assignment',()=>{
 assert.equal(classify(q('q','未明确的新知识点','wrong')).id,'unclassified');
 const result=aggregate([task('a','api',[q('q','未知','wrong')])]);
 assert.equal(result.groups[0].domain,null);assert.equal(result.domains.every(d=>d.rate===null),true);
});
test('empty and incomplete homework produce an empty overview',()=>{
 assert.equal(aggregate([]).questions,0);
 assert.equal(aggregate([{...task('a','api',[q('q','整式化简','wrong')]),phase:'grading'}]).questions,0);
});
test('empty learning records have a dedicated animal illustration',()=>{
 const html=recordsUI().view();
 assert.match(html,/class="lr-empty-art" src="assets\/learning-empty-v2\.png\?v=1" width="1254" height="1254" alt="" aria-hidden="true"/);
 assert.doesNotMatch(html,/<svg class="lr-empty-art"/);
  assert.doesNotMatch(html,/lr-empty-icon/);
});
test('learning action board starts directly with the useful content',()=>{
 const source=fs.readFileSync(__dirname+'/learning.js','utf8');
 assert.doesNotMatch(source,/接下来学什么|lr-overview-title/);
 assert.match(source,/class="lr-action-board" aria-label="学习行动"/);
});
test('learning plan turns evidence into a next action without claiming mastery',()=>{
 const question=q('q1','整式化简','wrong',{memory:{status:'ready',evidenceRevision:1,entries:[{kind:'inference',text:'括号前的负号仍需核对。',evidenceIds:['e1']}]}});
 const summary=aggregate([task('a','api',[question])]);
 const next=plan(summary);
 assert.equal(next.observed,'括号前的负号仍需核对。');
 assert.match(next.action,/回到最近错题/);
 assert.match(next.verification,/不看提示/);
});
test('similar past wrong question excludes the current task and links a real historical mistake',()=>{
 const current=q('current','圆与正方形的周长','wrong');
 const currentTask=task('now','api',[current]);
 const old=q('old','图形与几何','wrong',{text:'一个圆和长方形周长相等，求长方形的长。'});
 const correct=q('correct','圆与正方形的周长','correct',{text:'历史正确题'});
 const result=similarPastWrong([currentTask,task('past','api',[old,correct])],currentTask,current);
 assert.equal(result.taskId,'past');assert.equal(result.questionId,'old');
 assert.match(result.reason,/图形性质与计算/);
 assert.equal(similarPastWrong([currentTask],currentTask,current),null);
});
test('similar past wrong question prefers a shared evidenced reasoning cue',()=>{
 const memory=text=>({status:'ready',evidenceRevision:1,entries:[{kind:'inference',text,evidenceIds:['e1']}]});
 const current=q('current','整式化简','wrong',{memory:memory('去括号时符号需要核对。')});
 const generic=q('generic','整式化简','wrong',{text:'合并式子'});
 const matched=q('matched','分配律','wrong',{text:'去括号',memory:memory('括号前的符号漏了。')});
 const result=similarPastWrong([task('past-a','api',[generic]),task('past-b','api',[matched])],task('now','api',[current]),current);
 assert.equal(result.questionId,'matched');assert.match(result.reason,/解题时都容易卡在/);
});
