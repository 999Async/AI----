const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {test}=require('node:test');
const seed=JSON.parse(fs.readFileSync(__dirname+'/../backend/fixtures/curricula/rj-math-g7-1-2024.json','utf8'));
const projection=()=>({curriculumId:seed.curriculum.id,displayName:seed.curriculum.displayName,nodes:seed.nodes.map(n=>({...n,visualState:'unlit',recentlyChanged:false}))});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function setup(fetch,api={}){
 const handlers={},store=new Map();let key=0;
 const context=vm.createContext({module:{exports:{}},setTimeout,clearTimeout,AbortController,fetch,CSS:{escape:x=>x},matchMedia:()=>({matches:false}),sessionStorage:{getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)},document:{addEventListener:(n,fn)=>(handlers[n]??=[]).push(fn),getElementById:()=>null,querySelector:s=>s==='.kt-practice-question'?{}:null},HomeworkService:{id:()=>String(++key),api}});
 context.window=context;context.scrollTo=()=>{};
 vm.runInContext(fs.readFileSync(__dirname+'/knowledge-tree.js','utf8'),context);
 const click=dataset=>{for(const fn of handlers.click)fn({target:{closest:()=>({dataset})}});};
 const input=(id,value)=>{for(const fn of handlers.input)fn({target:{id,value}});};
 return {tree:context.KnowledgeTree,buildTree:context.module.exports.buildTree,layoutTree:context.module.exports.layoutTree,click,input,store};
}
function respond(url){return Promise.resolve({ok:true,json:async()=>url==='/api/curricula'?{curricula:[seed.curriculum],defaultCurriculumId:seed.curriculum.id}:projection()});}
test('official finite hierarchy retains all six chapters without manufacturing footprints',()=>{
 const {buildTree}=setup(),tree=buildTree(projection());
 assert.equal(tree.children.get(null).length,6);assert.equal(tree.nodes.filter(n=>n.kind==='concept').length,54);
 assert.ok(tree.nodes.every(n=>n.visualState==='unlit'));
});
test('home knowledge-tree entry keeps an icon-only accessible action',async()=>{
 const s=setup(respond);s.tree.init(()=>{});await tick();const html=s.tree.homeHTML();
 assert.match(html,/class="text-button kt-home-open"[^>]*aria-label="查看知识树"/);
 assert.doesNotMatch(html,/>\s*查看知识树\s*</);
});
test('unavailable knowledge-tree state explains the failure and offers a retry',async()=>{
 const s=setup(()=>Promise.reject(Error('offline')));s.tree.init(()=>{});await tick();const html=s.tree.view();
 assert.match(html,/知识树暂时打不开/);
 assert.match(html,/data-kt="refresh"/);
 assert.doesNotMatch(html,/knowledge-tree-v1\.png/);
});
test('invalid states, duplicate IDs and broken hierarchy fail closed',()=>{
 const {buildTree}=setup();
 for(const mutate of [p=>p.nodes[0].visualState='mastered',p=>p.nodes.push(p.nodes[0]),p=>p.nodes.find(n=>n.kind==='concept').parentId=p.nodes[0].id]){const p=projection();mutate(p);assert.throws(()=>buildTree(p));}
});
test('search includes ancestor branches, and missing recent evidence stays empty',async()=>{
 const s=setup(respond);s.tree.init(()=>{});await tick();s.input('kt-search','去括号');
 assert.match(s.tree.view(),/去括号/);assert.doesNotMatch(s.tree.view(),/data-kt="chapter" data-id="ch1/);
 s.click({kt:'filter',value:'recent'});assert.match(s.tree.view(),/最近还没有变化/);
});
test('failed reads clear the current display and expose retry instead of stale success',async()=>{
 let fail=false;const s=setup(url=>fail?Promise.reject(Error('offline')):respond(url));s.tree.init(()=>{});await tick();
 fail=true;await s.tree.refresh();assert.match(s.tree.view(),/offline/);assert.match(s.tree.view(),/重新加载/);assert.doesNotMatch(s.tree.view(),/kt-unavailable-art|knowledge-tree-v1\.png/);assert.doesNotMatch(s.tree.view(),/kt-art-/);assert.doesNotMatch(s.tree.view(),/kt-node/);
});
test('late older refresh cannot overwrite the latest tree',async()=>{
 let pending=[];const s=setup(url=>url==='/api/curricula'?respond(url):new Promise(resolve=>pending.push(resolve)));
 s.tree.init(()=>{});await tick();const second=s.tree.refresh();await tick();
 pending[1]({ok:true,json:async()=>({...projection(),nodes:projection().nodes.map(n=>({...n,name:n.kind==='chapter'?'新的章节':n.name}))})});await second;
 pending[0]({ok:true,json:async()=>projection()});await tick();assert.match(s.tree.view(),/新的章节/);
});
test('verification displays before shown; failed grading retries identical frozen answer and key',async()=>{
 const calls=[];let checks=0;const node=seed.nodes.find(n=>n.kind==='concept');
 const s=setup(respond,{createVerification:async data=>{calls.push('create');return {verification:{id:'v1',nodeId:data.nodeId,curriculumId:data.curriculumId,question:'本测试题面'}};},showVerification:async()=>{calls.push('shown');},checkVerification:async(id,data,key)=>{calls.push({id,data:{...data},key});if(!checks++)throw Error('连接中断');return {status:'correct',reason:'测试批改结果'};}});
 s.tree.init(()=>{});await tick();s.tree.open();await tick();s.click({kt:'select',id:node.id});s.click({kt:'practice'});await tick();
 assert.deepEqual(calls.slice(0,2),['create','shown']);s.input('kt-answer','第一次答案');s.click({kt:'check'});await tick();
 assert.match(s.tree.view(),/readonly/);s.input('kt-answer','不能覆盖');s.click({kt:'check'});await tick();
 assert.deepEqual(calls[2],calls[3]);assert.equal(calls[3].data.answer,'第一次答案');assert.match(s.tree.view(),/这道题答对了/);
});
test('leaving during generation resumes shown acknowledgement on return without regenerating',async()=>{
 let resolveCreate,shown=0,created=0;
 const node=seed.nodes.find(n=>n.kind==='concept');
 const s=setup(respond,{createVerification:()=>{created++;return new Promise(resolve=>resolveCreate=resolve);},showVerification:async()=>{shown++;}});
 s.tree.init(()=>s.tree.afterRender());await tick();s.tree.open();await tick();s.click({kt:'select',id:node.id});s.click({kt:'practice'});s.tree.leave();
 resolveCreate({verification:{id:'pending-v',nodeId:node.id,curriculumId:seed.curriculum.id,question:'延迟生成的测试题'}});await tick();assert.equal(shown,0);
 s.tree.open();await tick();assert.equal(created,1);assert.equal(shown,1);
 s.input('kt-answer','本次作答');assert.match(s.tree.view(),/data-kt="check" >提交作答/);
});
test('section states and repeated difficulty remain visible while the branch is collapsed',async()=>{
 const p=projection(),section=p.nodes.find(n=>n.id==='sec5-2-solve-linear-equations'),leaf=p.nodes.find(n=>n.id==='kp-equation-remove-parentheses');
 section.visualState='growing';section.progress={totalConcepts:5,coveredConcepts:4,litConcepts:3,practiceConcepts:1};section.attention={type:'practice',label:'1 个知识点再巩固',reason:'下方有 1 个知识点近期反复遇到困难，可以点开看看。'};
 leaf.visualState='lit';leaf.attention={type:'practice',label:'再巩固一下',reason:'最近 5 道题中，4 道还需要订正。'};
 const s=setup(url=>url==='/api/curricula'?respond(url):Promise.resolve({ok:true,json:async()=>p}));s.tree.init(()=>{});await tick();
 s.click({kt:'chapter',id:section.parentId});s.click({kt:'toggle',id:section.id});
 assert.match(s.tree.view(),/4\/5 个有足迹/);assert.match(s.tree.view(),/1 个知识点再巩固/);
 s.click({kt:'select',id:section.id});assert.doesNotMatch(s.tree.view(),/kt-section-detail|id="kt-detail"/);
 s.click({kt:'select',id:leaf.id});assert.match(s.tree.view(),/最近 5 道题中，4 道还需要订正/);assert.match(s.tree.view(),/kt-node attention selected/);
});

test('chapter selection collapses the catalog and does not open redundant details',async()=>{
 const s=setup(respond);s.tree.init(()=>{});await tick();
 s.click({kt:'catalog'});assert.match(s.tree.view(),/kt-catalog is-open/);
 s.click({kt:'chapter',id:seed.nodes.find(n=>n.kind==='chapter'&&n.code==='5').id});
 assert.doesNotMatch(s.tree.view(),/kt-catalog is-open|id="kt-detail"|kt-detail-empty/);
});

test('graph gives every visible child one connected parent and keeps node boxes disjoint',()=>{
 const {layoutTree}=setup();
 for(const chapter of seed.nodes.filter(n=>n.kind==='chapter')){
  const sections=seed.nodes.filter(n=>n.parentId===chapter.id).map(node=>({node,expanded:true,leaves:seed.nodes.filter(n=>n.parentId===node.id)}));
  for(const expanded of [true,false]){
   const graph=layoutTree(chapter,sections.map(s=>({...s,expanded})));
   assert.equal(graph.edges.length,graph.nodes.length-1);
   for(const n of graph.nodes.filter(n=>n.node.id!==chapter.id)){
    const edge=graph.edges.find(e=>e.child===n.node.id),parent=graph.nodes.find(p=>p.node.id===edge.parent);
    assert.equal(edge.x2,n.x);assert.equal(edge.y2,n.y);assert.equal(edge.y1,parent.y);assert.equal(edge.x1,parent.x+parent.width);
   }
   for(let i=0;i<graph.nodes.length;i++)for(const b of graph.nodes.slice(i+1)){
    const a=graph.nodes[i];assert.ok(a.x+a.width<=b.x||b.x+b.width<=a.x||a.y+a.height/2<=b.y-b.height/2||b.y+b.height/2<=a.y-a.height/2,'node boxes must not overlap');
   }
  }
 }
});
test('filtered chapter expand action targets the displayed chapter, not an earlier selection',async()=>{
 const s=setup(respond);s.tree.init(()=>{});await tick();
 s.input('kt-search','去分母');assert.match(s.tree.view(),/kt-connections/);
 s.click({kt:'expand'});s.input('kt-search','');s.click({kt:'chapter',id:seed.nodes.find(n=>n.kind==='chapter'&&n.code==='5').id});
 assert.match(s.tree.view(),/展开分支/);
});
