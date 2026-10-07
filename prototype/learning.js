/* Cross-homework learning records. Counts are evidence summaries, never mastery scores. */
(function(root){
  'use strict';
  const DOMAINS=[
    {id:'numbers',name:'数与运算'}, {id:'expressions',name:'代数式求值'},
    {id:'algebra',name:'整式运算'}, {id:'equations',name:'方程'},
    {id:'geometry',name:'图形与几何'}, {id:'data',name:'数据与概率'}
  ];
  const RULES=[
    ['brackets','去括号与分配律','algebra',/分配律|去括号|整式化简/],
    ['like-terms','合并同类项','algebra',/合并同类项/],
    ['expression-value','代数式求值','expressions',/代数式求值|整体代入|求值/],
    ['linear-equation','一元一次方程','equations',/一元一次|相反数.*方程|方程.*相反数/],
    ['equation','列式与解方程','equations',/方程|列式|等量关系/],
    ['algebra','整式运算','algebra',/整式|多项式|单项式|化简/],
    ['numbers','有理数运算','numbers',/有理数|正负数|相反数|绝对值|分数|四则|加法|减法|乘法|除法/],
    ['geometry','图形性质与计算','geometry',/几何|三角|四边|圆|面积|周长|角度|勾股|平行|垂直/],
    ['data','统计与概率','data',/统计|概率|平均数|中位数|众数|数据/]
  ];
  function classify(q){
    const source=q.skill||q.kind||'';
    const rule=RULES.find(r=>r[3].test(source));
    return rule?{id:rule[0],name:rule[1],domain:rule[2]}:{id:'unclassified',name:'待归类',domain:null};
  }
  function validMemory(q){
    const events=new Set((q.events||[]).map(e=>e.id));
    return q.memory?.status==='ready'&&q.memory.evidenceRevision===q.revision
      ?(q.memory.entries||[]).filter(e=>e.evidenceIds?.length&&e.evidenceIds.every(id=>events.has(id)))
      :[];
  }
  function reasoningCue(q){
    const entries=validMemory(q),entry=entries.find(e=>e.kind==='inference')||entries.find(e=>e.kind==='fact');
    const text=entry?.text||'';
    if(/符号|去括号/.test(text))return '括号前后的符号';
    if(/相反数/.test(text))return '相反数怎么列式';
    if(/整体代入/.test(text))return '整体代入这一步';
    if(/等量关系|周长.*边|边.*周长/.test(text))return '先找等量关系再列式';
    return '';
  }
  function similarPastWrong(tasks,currentTask,currentQuestion){
    const target=classify(currentQuestion),targetCue=reasoningCue(currentQuestion);
    if(target.id==='unclassified')return null;
    const currentSkill=String(currentQuestion.skill||'').trim(),candidates=[];
    for(const pastTask of tasks||[]){
      if(pastTask.mode!=='api'||pastTask.phase!=='work'||pastTask.id===currentTask?.id||!Array.isArray(pastTask.questions))continue;
      for(const q of pastTask.questions){
        const attempts=(q.attempts||[]).filter(a=>!a.superseded);
        const wasWrong=(q.initialStatus||q.status)==='wrong'||attempts.some(a=>a.status==='wrong');
        const skill=classify(q);
        if(!wasWrong||skill.id!==target.id)continue;
        const cue=reasoningCue(q),cueMatch=Boolean(targetCue&&cue===targetCue);
        const exactSkill=Boolean(currentSkill&&String(q.skill||'').trim()===currentSkill);
        candidates.push({
          taskId:pastTask.id,questionId:q.id,taskTitle:pastTask.title,number:q.number,
          at:pastTask.updatedAt||pastTask.createdAt,question:q.text,skill:q.skill||skill.name,
          reason:cueMatch?`解题时都容易卡在“${cue}”`:`同属“${skill.name}”考点`,
          score:cueMatch?3:exactSkill?2:1
        });
      }
    }
    return candidates.sort((a,b)=>b.score-a.score||new Date(b.at)-new Date(a.at))[0]||null;
  }
  function aggregate(tasks,mode='api'){
    const selected=tasks.filter(t=>t.mode===mode&&t.phase==='work'&&Array.isArray(t.questions));
    const groups=new Map(),all=[];
    for(const task of selected){for(const q of task.questions){
      const skill=classify(q),attempts=(q.attempts||[]).filter(a=>!a.superseded),latest=attempts.at(-1);
      const original=q.status,wrong=original==='wrong'||attempts.some(a=>a.status==='wrong');
      const status=latest?.status==='correct'?'corrected':latest?.status||original;
      const helped=!!(q.help||q.external||attempts.some(a=>a.help||a.external));
      const memory=validMemory(q);
      const record={taskId:task.id,questionId:q.id,taskTitle:task.title,number:q.number,at:task.updatedAt||task.createdAt,
        q,skill,attempts,latest,status,wrong,helped,memory};
      if(!groups.has(skill.id))groups.set(skill.id,{...skill,records:[],correct:0,graded:0,wrong:0,pending:0,corrected:0,uncertain:0,assisted:0});
      const group=groups.get(skill.id);group.records.push(record);
      if(['correct','wrong'].includes(original)){group.graded++;if(original==='correct')group.correct++;}
      if(wrong)group.wrong++;
      if(['wrong','unanswered'].includes(status))group.pending++;
      if(status==='uncertain')group.uncertain++;
      if(status==='corrected'){group.corrected++;if(helped)group.assisted++;}
      all.push(record);
    }}
    const list=[...groups.values()].map(g=>({...g,rate:g.graded?Math.round(100*g.correct/g.graded):null,
      records:g.records.sort((a,b)=>new Date(b.at)-new Date(a.at))})).sort((a,b)=>b.pending-a.pending||b.uncertain-a.uncertain||b.assisted-a.assisted||b.records.length-a.records.length||a.name.localeCompare(b.name,'zh-CN'));
    const domains=DOMAINS.map(d=>{const matching=list.filter(g=>g.domain===d.id);const graded=matching.reduce((n,g)=>n+g.graded,0),correct=matching.reduce((n,g)=>n+g.correct,0);return {...d,graded,correct,rate:graded?Math.round(100*correct/graded):null};});
    return {groups:list,domains,records:all,tasks:selected.length,questions:all.length,
      pending:list.reduce((n,g)=>n+g.pending,0),corrected:list.reduce((n,g)=>n+g.corrected,0),
      uncertain:list.reduce((n,g)=>n+g.uncertain,0),assisted:list.reduce((n,g)=>n+g.assisted,0)};
  }
  function plan(summary){
    const priority=summary.groups.find(g=>g.pending)||summary.groups.find(g=>g.uncertain)||summary.groups.find(g=>g.assisted)||summary.groups[0];
    if(!priority)return null;
    const record=priority.records.find(r=>['wrong','unanswered'].includes(r.status))||priority.records.find(r=>r.status==='uncertain')||priority.records.find(r=>r.helped)||priority.records[0];
    const inference=record.memory.find(e=>e.kind==='inference'), fact=record.memory.find(e=>e.kind==='fact');
    const observed=inference?.text||fact?.text||(record.status==='uncertain'?'题目材料或批改结果仍需核对，暂不形成能力判断。':record.helped?'这道题在提示或他人帮助后完成，尚不能算独立掌握。':record.status==='wrong'||record.status==='unanswered'?`在「${priority.name}」相关作答中仍有需要订正的步骤。`:'已有作答记录，但还缺少一次独立验证。');
    const action=record.status==='uncertain'?'先回到原题核对题干与原答，再决定是否需要辅导。':record.status==='wrong'||record.status==='unanswered'?'回到最近错题，从原答中最具体的一步开始；需要时再逐级增加提示。':record.helped?'暂时撤掉提示，用相关题再次尝试，避免把帮助后完成误认为已经会了。':'保留当前方法，下次从相关题直接开始，不重复已经完成的讲解。';
    const cue=/符号|去括号/.test(observed)?'括号前后的符号':/相反数/.test(observed)?'相反数怎么列式':/整体代入/.test(observed)?'整体代入这一步':priority.name;
    const nextStep=record.status==='uncertain'?'核对题目和原答':record.status==='wrong'||record.status==='unanswered'?'先自己找出错的一步':record.helped?'不看提示，再做一道同类题':'再做一道同类题';
    return {priority,record,observed,action,cue,nextStep,verification:'只有在不看提示的相关新题中独立完成，才把这次学习更新为“可独立完成”。'};
  }
  root.LearningSummary={aggregate,classify,plan,similarPastWrong,domains:DOMAINS};
  if(!root.document)return;
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let active=false,loading=false,error='',tasks=[],repaint=()=>{},generation=0,filter='all',query='';
  const expanded=new Set(),showAll=new Set();
  const icon=(name)=>`<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${name==='arrow'?'M5 12h14 m-5-5 5 5-5 5':name==='chevron'?'m8 5 7 7-7 7':name==='search'?'M10 17a7 7 0 1 1 0-14 7 7 0 0 1 0 14 M15 15l6 6':'M5 4h14v16H5z M8 8h8 M8 12h8 M8 16h4'}"/></svg>`;
  const emptyArt=()=>'<img class="lr-empty-art" src="assets/learning-empty-v2.png?v=1" width="1254" height="1254" alt="" aria-hidden="true">';
  const date=value=>new Date(value).toLocaleDateString('zh-CN',{month:'numeric',day:'numeric'});
  function session(value){try{value?sessionStorage.setItem('banxue-learning-page','api'):sessionStorage.removeItem('banxue-learning-page');}catch{}}
  function leave(){active=false;session(false);generation++;}
  async function open(){
    active=true;loading=true;error='';root.HomeworkFlow.leave();
    session(true);repaint();const serial=++generation;
    try{
      await root.HomeworkFlow.flush();const records=await root.HomeworkService.store.list();
      if(serial!==generation)return;
      tasks=records;
      session(true);loading=false;repaint();document.getElementById('page-title')?.focus({preventScroll:true});window.scrollTo(0,0);
    }catch{if(serial!==generation)return;loading=false;error='学习记录暂时无法读取，作业中的内容仍会保留。';repaint();}
  }
  function radar(domains){
    const cx=180,cy=164,r=105,point=(i,value)=>{const a=-Math.PI/2+i*Math.PI/3;return [cx+Math.cos(a)*r*value,cy+Math.sin(a)*r*value];};
    const coords=values=>values.map((v,i)=>point(i,v).map(n=>n.toFixed(2)).join(',')).join(' ');
    const allKnown=domains.every(d=>d.rate!==null);
    return `<figure class="lr-radar"><svg viewBox="0 0 360 330" role="img" aria-labelledby="lr-radar-title lr-radar-desc"><title id="lr-radar-title">各知识领域的原答正确率</title><desc id="lr-radar-desc">${esc(domains.map(d=>`${d.name}：${d.rate===null?'暂无作答数据':d.rate+'%，'+d.correct+'/'+d.graded+'题次'}`).join('；'))}。未记录的领域不记为零分。</desc>${[.25,.5,.75,1].map(v=>`<polygon points="${coords(domains.map(()=>v))}" class="lr-radar-grid"/>`).join('')}${domains.map((d,i)=>{const [x,y]=point(i,1);return `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" class="lr-radar-axis"/>`;}).join('')}${allKnown?`<polygon points="${coords(domains.map(d=>d.rate/100))}" class="lr-radar-area"/>`:''}${domains.map((d,i)=>{const [x,y]=point(i,1.38),p=point(i,(d.rate||0)/100);return `<text x="${x}" y="${y-2}" text-anchor="middle" class="lr-radar-label">${d.name}</text><text x="${x}" y="${y+15}" text-anchor="middle" class="lr-radar-value">${d.rate===null?'暂无记录':d.rate+'%'}</text>${d.rate!==null?`<circle cx="${p[0]}" cy="${p[1]}" r="5" class="lr-radar-point"/>`:''}`;}).join('')}<text x="${cx+7}" y="${cy-r*.5+4}" class="lr-radar-scale">50%</text></svg><figcaption><span class="lr-dot"></span>原答正确率 <span class="lr-chart-note">暂无记录不计零分</span></figcaption></figure>`;
  }
  function overview(summary){
    const next=plan(summary),record=next.record;
    const todos=summary.records.map(item=>{
      if(['wrong','unanswered'].includes(item.status))return {item,label:`订正第 ${item.number} 题`,rank:0};
      if(item.status==='corrected'&&item.helped)return {item,label:`自己再做第 ${item.number} 题`,rank:1};
      if(item.status==='uncertain')return {item,label:`核对第 ${item.number} 题`,rank:2};
      return null;
    }).filter(Boolean).sort((a,b)=>a.rank-b.rank||new Date(b.item.at)-new Date(a.item.at));
    const todoList=todos.length?`<ul class="lr-todo-list">${todos.map(({item,label})=>`<li><button type="button" data-learning="question" data-task="${esc(item.taskId)}" data-question="${esc(item.questionId)}"><span class="lr-todo-marker" aria-hidden="true"></span><span><strong>${label}</strong><small>${esc(item.skill.name)} · ${esc(item.taskTitle)} · ${date(item.at)}</small></span>${icon('arrow')}</button></li>`).join('')}</ul>`:'<p class="lr-todo-empty">暂时没有待做的题。</p>';
    return `<section class="lr-action-board" aria-label="学习行动"><div class="lr-action-path"><article><h3>你卡在</h3><p>${esc(next.cue)}</p><small>${esc(record.taskTitle)} · 第 ${record.number} 题</small></article></div><section class="lr-todo" aria-labelledby="lr-todo-title"><h3 id="lr-todo-title">待做</h3>${todoList}</section></section>`;
  }
  function recordRow(record){
    const q=record.q,labels={correct:'原答正确',corrected:'已订正',wrong:'待订正',unanswered:'未作答',uncertain:'待核对'};
    return `<article class="lr-question"><header><div><p class="lr-source">${esc(record.taskTitle)} · 第 ${record.number} 题 · ${date(record.at)}</p><h4>${esc(q.text)}</h4></div><span class="hw-tag ${record.status}">${labels[record.status]||'待核对'}</span></header>${q.formula?`<p class="lr-formula">${esc(q.formula)}</p>`:''}<div class="lr-answer-line"><span>原答</span><p>${esc(q.original)||'未识别到作答'}</p></div>${record.latest?`<div class="lr-answer-line"><span>最近订正</span><p>${esc(record.latest.value)}</p></div>`:''}<p class="lr-help">${record.attempts.length} 次订正 · ${record.helped?'有提示或他人帮助 · ':''}尚未独立验证</p><details class="lr-evidence"><summary>学习记录与依据</summary>${record.memory.length?record.memory.map(entry=>`<div class="lr-memory"><span>${{fact:'学习事实',inference:'暂定判断',progress:'学习进度'}[entry.kind]||'学习记录'}</span><p>${esc(entry.text)}</p><details><summary>查看依据</summary>${entry.evidenceIds.map(id=>(q.events||[]).find(e=>e.id===id)).filter(Boolean).map(e=>`<p>${esc(e.detail)}</p>`).join('')}</details></div>`).join(''):`<p>${q.memory?.status==='updating'?'学习判断正在更新。':q.memory?.status==='error'?'学习判断暂未更新，作答记录已保留。':'目前没有可用于汇总的学习判断。'}</p>`}${q.materialHistory?.length?`<details><summary>识别核对前的材料</summary>${q.materialHistory.map(h=>`<p>${esc(h.text)} ${esc(h.formula)}<br>原答：${esc(h.original)}</p>`).join('')}<p>这些旧材料下的作答不计入当前状态。</p></details>`:''}</details><button class="text-button" data-learning="question" data-task="${esc(record.taskId)}" data-question="${esc(record.questionId)}">${['wrong','unanswered'].includes(record.status)?'回到这题订正':'查看原题与讨论'} ${icon('arrow')}</button></article>`;
  }
  function groupRow(group){
    const isOpen=expanded.has(group.id),wrong=group.records.filter(r=>r.wrong),all=showAll.has(group.id)||!wrong.length;
    return `<section class="lr-group" id="knowledge-${group.id}"><button class="lr-group-toggle" data-learning="toggle" data-id="${group.id}" aria-expanded="${isOpen}" aria-controls="knowledge-content-${group.id}"><div class="lr-group-heading"><h3>${esc(group.name)}</h3><p>${group.records.length} 道题 · ${new Set(group.records.map(r=>r.taskId)).size} 份作业${group.id==='unclassified'?' · 暂不纳入雷达图':''}</p></div><div class="lr-group-progress">${group.pending?`<span class="lr-pending">${group.pending} 题待订正</span>`:group.uncertain?`<span>${group.uncertain} 题待核对</span>`:group.corrected?`<span>${group.corrected} 题已订正</span>`:'<span>已有作答记录</span>'}<small>${group.assisted?'有帮助完成，待独立验证':group.rate===null?'原答暂无可判定数据':'原答正确 '+group.correct+' / '+group.graded+' 题次'}</small></div>${icon('chevron')}</button><div id="knowledge-content-${group.id}" class="lr-group-content" ${isOpen?'':'hidden'}>${isOpen?`<div class="lr-group-summary"><p>${group.wrong?`记录中有 ${group.wrong} 道错题，${group.corrected} 道题已订正。`:'当前没有错题记录，可以回看相关作答。'}${group.assisted?'帮助后的订正单独保留，不作为独立掌握证据。':''}</p>${wrong.length?`<div class="lr-record-filter" aria-label="${esc(group.name)}记录范围"><button id="lr-wrong-${group.id}" data-learning="record-filter" data-id="${group.id}" data-value="wrong" aria-pressed="${!all}">错题 ${wrong.length}</button><button id="lr-all-${group.id}" data-learning="record-filter" data-id="${group.id}" data-value="all" aria-pressed="${all}">全部 ${group.records.length}</button></div>`:''}</div>${(all?group.records:wrong).map(recordRow).join('')}`:''}</div></section>`;
  }
  function view(){
    const summary=aggregate(tasks,'api'),groups=summary.groups.filter(g=>(filter!=='pending'||g.pending||g.uncertain||g.assisted)&&(!query||g.name.includes(query)||g.records.some(r=>(r.q.skill||'').includes(query))));
    return `<main id="main" class="page-with-title lr-page"><header class="page-header lr-header"><div><h1 class="page-title" id="page-title" tabindex="-1">学习记录</h1></div></header>${loading?'<section class="lr-empty" role="status"><h2>正在整理</h2><p>马上就好。</p></section>':error?`<section class="lr-empty" role="alert"><h2>暂时打不开记录</h2><p>${esc(error)}</p><button class="btn secondary" data-learning="reload">再试一次</button></section>`:!summary.questions?`<section class="lr-empty">${emptyArt()}<h2>还没有学习记录</h2><p>先完成一份作业吧。</p><button class="btn" data-action="prepare">上传作业</button></section>`:`${overview(summary)}<section class="lr-knowledge" aria-labelledby="lr-knowledge-title"><div class="lr-section-heading"><div><h2 id="lr-knowledge-title">知识点</h2><p>点开可看原答和订正。</p></div><label class="lr-search">${icon('search')}<span class="sr-only">搜索知识点</span><input id="lr-search" type="search" placeholder="搜索知识点" value="${esc(query)}" autocomplete="off"></label></div><div class="lr-list-toolbar"><div class="lr-filter"><button id="lr-filter-all" data-learning="filter" data-value="all" aria-pressed="${filter==='all'}">全部 ${summary.groups.length}</button><button id="lr-filter-pending" data-learning="filter" data-value="pending" aria-pressed="${filter==='pending'}">要继续 ${summary.groups.filter(g=>g.pending||g.uncertain||g.assisted).length}</button></div></div><div class="lr-groups">${groups.length?groups.map(groupRow).join(''):'<p class="lr-list-empty">没有找到。换个词试试。</p>'}</div></section>`}</main>`;
  }
  function afterRender(){if(!active)return;document.querySelectorAll('.navigation .nav-item').forEach(el=>{const selected=el.dataset.action==='result';el.classList.toggle('active',selected);selected?el.setAttribute('aria-current','page'):el.removeAttribute('aria-current');});}
  function update(snapshot){tasks=tasks.filter(t=>t.id!==snapshot.id);tasks.push(snapshot);if(active&&!loading)repaint();}
  function init(paint){repaint=paint;let saved;try{saved=sessionStorage.getItem('banxue-learning-page');}catch{}if(saved)open();}
  document.addEventListener('click',async e=>{
    const el=e.target.closest('[data-learning]');if(!el)return;const action=el.dataset.learning,id=el.dataset.id;
    if(action==='reload'){open();return;}
    if(action==='filter'){filter=el.dataset.value;repaint();return;}
    if(action==='toggle'){expanded.has(id)?expanded.delete(id):expanded.add(id);repaint();document.querySelector(`[data-learning="toggle"][data-id="${id}"]`)?.focus({preventScroll:true});return;}
    if(action==='expand'){expanded.add(id);filter='all';query='';repaint();document.getElementById('knowledge-'+id)?.scrollIntoView({block:'start'});document.querySelector(`[data-learning="toggle"][data-id="${id}"]`)?.focus({preventScroll:true});return;}
    if(action==='record-filter'){el.dataset.value==='all'?showAll.add(id):showAll.delete(id);repaint();return;}
    if(action==='question'){await root.HomeworkFlow.openQuestion(el.dataset.task,el.dataset.question);}
  });
  document.addEventListener('input',e=>{if(e.target.id==='lr-search'){query=e.target.value.trim();repaint();}});
  root.LearningRecords={init,open,leave,view,afterRender,update,isActive:()=>active};
})(typeof window==='undefined'?globalThis:window);
