/* Student homework workspace. No secrets or model calls are embedded here. */
(function (root) {
  'use strict';
  const S=root.HomeworkService;
  let task=null, active=false, repaint=()=>{}, navigateHome=()=>{}, recent=[], history=[], drawer=false, imageURL='', saveState='saved', saveQueue=Promise.resolve(), sequence=0, canvasReturnY=0;
  const operations=new Map(), memoryJobs=new Map(), suggestionJobs=new Map(), executions=new Map(), regionJobs=new Set();
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const brief=(value,max=34)=>{const text=String(value??'').trim(),sentence=text.split(/[。！？；]/)[0];return sentence.length<=max?sentence:sentence.slice(0,max-1)+'…';};
  function choiceQuestion(value){
    const text=String(value??''),marker=/([A-D])\s*[.．、]\s*/g,matches=[...text.matchAll(marker)];
    const isFourChoice=matches.length===4&&matches.every((match,index)=>match[1]===String.fromCharCode(65+index));
    if(!isFourChoice)return null;
    const stem=text.slice(0,matches[0].index).trim();
    const options=matches.map((match,index)=>text.slice(match.index+match[0].length,matches[index+1]?.index??text.length).trim().replace(/[；;]\s*$/,''));
    return !stem||options.some(option=>!option)?null:{stem,options};
  }
  function questionText(value){
    const text=String(value??''),choice=choiceQuestion(text);
    if(!choice)return `<p class="hw-question-stem">${esc(text)}</p>`;
    return `<p class="hw-question-stem">${esc(choice.stem)}</p><ol class="hw-question-options" aria-label="选项">${choice.options.map((option,index)=>`<li><span class="hw-option-label">${String.fromCharCode(65+index)}．</span><span>${esc(option)}</span></li>`).join('')}</ol>`;
  }
  const studentCue=(value,q)=>{const text=String(value??'');if(/符号|去括号/.test(text))return '括号前后的符号';if(/相反数/.test(text))return '相反数怎么列式';if(/整体代入/.test(text))return '整体代入这一步';return brief(q?.skill||text,16);};
  const glyphs={send:'M12 19V5 M5 12l7-7 7 7',back:'m14 6-6 6 6 6',check:'m5 12 4 4L19 6',close:'m6 6 12 12 M18 6 6 18',chat:'M4 4h16v12H9l-5 4z M8 8h8 M8 12h5',arrow:'M4 12h15 m-6-6 6 6-6 6',paper:'M6 3h9l4 4v14H6z M14 3v5h5 M9 12h7 M9 16h5',edit:'m15 4 5 5 M4 20l5-1L20 8l-5-5L4 14z',info:'M12 11v6 M12 7v.1 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',clock:'M12 8v5l3 2 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',refresh:'M20 7v5h-5 M4 17v-5h5 M5 7a8 8 0 0 1 14-1l1 6 M4 12l1 6a8 8 0 0 0 14-1',book:'M4 5c3-1 5-1 8 1 3-2 5-2 8-1v14c-3-1-5-1-8 1-3-2-5-2-8-1z M12 6v14'};
  const icon=name=>`<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${glyphs[name]||glyphs.paper}"/></svg>`;
  const historyEmptyArt=()=>'<img class="upload-history-empty-art" src="assets/history-empty-v3.png?v=1" width="512" height="512" alt="" aria-hidden="true">';
  const button=(label,action,style='secondary',extra='')=>`<button type="button" class="btn ${style}" data-hw="${action}" ${extra}>${label}</button>`;
  const date=value=>new Date(value).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
  const current=()=>task?.questions.find(q=>q.id===task.selected);
  const opKey=(t,q)=>t.id+':'+q.id;
  const attempts=q=>q.attempts.filter(a=>!a.superseded);
  function outcome(q) {const a=attempts(q).at(-1);return a?.status==='correct'?'corrected':a?.status||q.status;}
  const labels={correct:'原答正确',wrong:'需订正',unanswered:'未作答',uncertain:'待核对',corrected:'已订正'};
  const tag=(status)=>`<span class="hw-tag ${status}">${labels[status]||'待核对'}</span>`;
  function announce(message){const el=document.getElementById('announcer');if(el)el.textContent=message;}
  function render(){
    const history=document.getElementById('hw-chat-history'),material=document.querySelector('.hw-material-body'),record=document.querySelector('.hw-record-content');
    const positions={chat:history?.scrollTop,material:material?.scrollTop,record:record?.scrollTop};
    repaint();
    if(positions.material!=null){const el=document.querySelector('.hw-material-body');if(el)el.scrollTop=positions.material;}
    if(positions.record!=null){const el=document.querySelector('.hw-record-content');if(el)el.scrollTop=positions.record;}
    if(positions.chat!=null){const el=document.getElementById('hw-chat-history');if(el)el.scrollTop=positions.chat;}
  }
  function session(value){try{value?sessionStorage.setItem('banxue-active-homework',value):sessionStorage.removeItem('banxue-active-homework');}catch{/* Persistence status is handled by IndexedDB. */}}
  function validMemory(q){return q.memory?.status==='ready'&&q.memory.evidenceRevision===q.revision?q.memory.entries||[]:[];}
  function recentItem(t){
    const priority=t.questions.find(q=>['wrong','unanswered'].includes(outcome(q)))||t.questions.find(q=>outcome(q)==='uncertain')||t.questions.find(q=>outcome(q)==='corrected'&&(q.help||q.external))||t.questions[0];
    const memory=priority?validMemory(priority):[], insight=memory.find(e=>e.kind==='inference')||memory.find(e=>e.kind==='fact'), progress=memory.find(e=>e.kind==='progress');
    const status=priority?outcome(priority):'';
    const next=!priority?'查看批改结果':['wrong','unanswered'].includes(status)?`继续第 ${priority.number} 题`:status==='uncertain'?`核对第 ${priority.number} 题`:status==='corrected'&&(priority.help||priority.external)?`自己再试第 ${priority.number} 题`:'继续这份作业';
    const remembered=insight?.text||priority?.reason||progress?.text||'保留原答与学习过程，下次从当前进度继续。';
    return {id:t.id,title:t.title,mode:t.mode,purpose:t.purpose||'homework',phase:t.phase,updatedAt:t.updatedAt,count:t.questions.length,done:t.questions.filter(q=>outcome(q)==='corrected').length,questionId:priority?.id,remembered,cue:studentCue(remembered,priority),next};
  }
  function refreshHistory(records){history=records.filter(t=>t.mode==='api');recent=history.slice().sort((a,b)=>new Date(b.updatedAt)-new Date(a.updatedAt)).slice(0,8).map(recentItem);}
  function updateRecent(t){if(t.mode!=='api')return;refreshHistory([...history.filter(item=>item.id!==t.id),t]);}
  function savingLabel(){return saveState==='error'?'本地保存失败':saveState==='saving'?'正在保存…':'已保存在此浏览器';}
  function refreshSaveLabel(){document.querySelectorAll('[data-hw-save]').forEach(el=>{el.textContent=savingLabel();el.classList.toggle('hw-save-error',saveState==='error');});}
  function save(t=task){
    if(!t)return Promise.resolve();
    t.updatedAt=new Date().toISOString();const snapshot=structuredClone(t), serial=++sequence;
    saveState='saving';refreshSaveLabel();
    saveQueue=saveQueue.catch(()=>{}).then(()=>S.store.put(snapshot)).then(()=>{updateRecent(snapshot);root.LearningRecords?.update(snapshot);if(snapshot.mode==='api')root.LearningRecommendation?.invalidate();if(serial===sequence){saveState='saved';refreshSaveLabel();}}).catch(()=>{if(serial===sequence){saveState='error';refreshSaveLabel();render();}});
    return saveQueue;
  }
  function setTask(t){
    task=t;active=true;drawer=false;session(t.id);
    if(imageURL)URL.revokeObjectURL(imageURL);
    imageURL=t.image?URL.createObjectURL(t.image):'';
    task.questions.forEach(q=>{
      q.togetherMode=q.togetherMode==='canvas'?'canvas':'chat';root.HomeworkCanvas?.ensure(q);
      if(!q.suggestions||!Array.isArray(q.suggestions.items))q.suggestions={status:'idle',items:[],basedOnRevision:-1,requestId:null,error:''};
      else{
        try{q.suggestions.items=S.suggestedQuestions({questions:q.suggestions.items});}catch{q.suggestions={status:'idle',items:[],basedOnRevision:-1,requestId:null,error:''};}
      }
      if(q.suggestions.status==='loading'){q.suggestions.status='error';q.suggestions.error='上次推荐问题尚未准备完成，可以重试。';}
      if(q.pending&&!operations.has(opKey(t,q))){q.error={...q.pending,message:'上次回应尚未接收完整，重试可继续接收原请求。'};if(q.execution)q.execution.state='error';}
      if(q.memory.status==='updating'){if(q.memory.execution)q.memory.execution.state='error';q.memory.status='error';q.memory.error='上次学习记录尚未更新完成，可以重试。';}
    });
    render();document.getElementById('page-title')?.focus({preventScroll:true});
  }
  async function ensureRegions(t, retry=false){
    if(t.mode!=='api'||t.phase!=='work'||!t.remoteId||!S.api.regions||regionJobs.has(t.id)||(!retry&&(t.regionsState==='ready'||t.regionsState==='error'||t.questions.every(q=>Object.hasOwn(q,'box')))))return;
    regionJobs.add(t.id);t.regionsState='loading';if(task===t)render();
    try{
      const regions=await S.api.regions(t,'regions-v1-'+t.remoteId);
      for(const region of regions){const q=t.questions.find(q=>q.id===region.id);if(q)q.box=region.box;}
      t.regionsState='ready';t.regionsError='';
    }catch(error){t.regionsState='error';t.regionsError=error.message;}
    finally{regionJobs.delete(t.id);await save(t);if(task===t)render();}
  }
  function makeTask(image,note,purpose){return {version:1,id:S.id(),remoteId:null,mode:'api',purpose:purpose||'homework',title:purpose==='single'?'题目答疑':'作业批改',image:image||null,note:note||'',phase:'prepare',questions:[],selected:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),requestId:S.id(),gradeError:'',filter:'all'};}
  function startUpload(image,note,purpose){setTask(makeTask(image,note,purpose));grade();}
  async function resume(id,questionId){try{if(task?.id===id){if(questionId&&task.questions.some(q=>q.id===questionId)){task.selected=questionId;task.filter='all';}active=true;drawer=false;session(id);render();return;}const t=await S.store.get(id);if(!t)throw Error();if(t.phase==='grading'){if(t.execution)t.execution.state='error';t.phase='error';t.gradeError='上次批改尚未完成，图片已保留，请重试。';}if(questionId&&t.questions.some(q=>q.id===questionId)){t.selected=questionId;t.filter='all';}setTask(t);}catch{announce('这份作业暂时无法读取，请重试。');}}
  function trackExecution(t,target,requestId,action){
    if(t.mode!=='api')return;
    target.execution={requestId,action,state:'running',events:[],startedAt:Date.now()};
    executions.set(requestId,{task:t,target});
    refreshExecution();
  }
  function loadingDots(label='正在整理回复'){
    return `<div class="hw-reply-loading" role="status" aria-label="${esc(label)}"><span aria-hidden="true"></span><span aria-hidden="true"></span><span aria-hidden="true"></span></div>`;
  }
  function executionPanel(execution){
    if(execution?.state!=='running'||['grade','chat','memory'].includes(execution.action))return '';
    return loadingDots('正在处理');
  }
  function executionSlot(target,name){return `<div data-hw-execution="${name}">${executionPanel(target?.execution)}</div>`;}
  function refreshExecution(){
    if(!active)return;
    document.querySelectorAll('[data-hw-execution]').forEach(el=>{
      const target=el.dataset.hwExecution==='grade'?task:el.dataset.hwExecution==='memory'?current()?.memory:current();
      const state=[target?.execution?.requestId,target?.execution?.state].join(':');
      if(el.dataset.executionState===state)return;
      el.dataset.executionState=state;el.innerHTML=executionPanel(target?.execution);
    });
  }
  function failExecution(requestId,message){
    const tracked=executions.get(requestId);if(!tracked)return;
    tracked.target.execution.state='error';
    tracked.target.execution.events.push({label:message,at:Date.now()/1000});
    executions.delete(requestId);save(tracked.task);refreshExecution();
  }
  S.onProgress(event=>{
    const tracked=executions.get(event.requestId);if(!tracked)return;
    const execution=tracked.target.execution;
    if(event.type==='progress'&&!execution.events.some(e=>e.seq===event.seq))execution.events.push({seq:event.seq,label:event.label,at:event.at});
    if(event.type==='result'||event.type==='error'){
      execution.state=event.type==='result'?'done':'error';
      if(event.type==='error')execution.events.push({label:event.message,at:Date.now()/1000});
      executions.delete(event.requestId);save(tracked.task);
    }
    refreshExecution();
  });
  async function grade(){
    const t=task;if(!t||t.phase==='grading')return;
    t.phase='grading';t.gradeError='';trackExecution(t,t,t.requestId,'grade');render();await save(t);
    try{
      const result=await S.api.grade(t.image,t.note,t.requestId);
      t.remoteId=result.id;t.questions=result.questions;t.title=result.title;t.selected=result.questions[0]?.id||null;t.phase=result.questions.length?'work':'empty';
      t.questions.forEach(q=>{q.initialStatus=q.status;S.record(q,'grade',q.reason);});
      await save(t);if(task===t){render();announce(t.questions.length?'批改结果已显示，可以按题查看。':'这张图片中没有找到可批改的题目。');}
      const suggestionTarget=t.questions.find(q=>['wrong','unanswered'].includes(outcome(q)))||t.questions.find(q=>outcome(q)==='uncertain')||t.questions[0];
      if(suggestionTarget)loadSuggestions(t,suggestionTarget);
      t.questions.forEach(q=>remember(t,q));
    }catch(error){failExecution(t.requestId,error.message);t.phase='error';t.gradeError=error.message;await save(t);if(task===t){render();announce(error.message);}}
  }
  function remember(t,q){
    const key=opKey(t,q);clearTimeout(memoryJobs.get(key));
    q.memory.status='updating';q.memory.error='';save(t);if(task===t)render();
    memoryJobs.set(key,setTimeout(async()=>{
      memoryJobs.delete(key);const revision=q.revision, snapshot=structuredClone(q);
      try{
        const memoryRequestId='memory-'+t.id+'-'+q.id+'-'+revision;trackExecution(t,q.memory,memoryRequestId,'memory');
        const entries=await S.api.remember(t,snapshot,memoryRequestId);
        if(q.revision!==revision)return;
        q.memory={status:'ready',entries,evidenceRevision:revision,at:new Date().toISOString(),execution:q.memory.execution};
      }catch(error){failExecution('memory-'+t.id+'-'+q.id+'-'+revision,error.message);if(q.revision!==revision)return;q.memory.status='error';q.memory.error=error.message;}
      await save(t);if(task===t)render();
    },500));
  }
  async function loadSuggestions(t,q,retry=false){
    const key=opKey(t,q),state=q.suggestions;
    if(!S.api.suggestions||suggestionJobs.has(key)||state.status==='loading'||(!retry&&state.status==='ready'&&state.basedOnRevision===q.revision))return;
    const revision=q.revision,requestId=retry&&state.requestId?state.requestId:S.id();
    q.suggestions={...state,status:'loading',requestId,error:''};suggestionJobs.set(key,requestId);
    if(task===t&&current()===q&&q.panel==='chat'){render();document.getElementById('hw-message')?.focus({preventScroll:true});}
    await save(t);
    try{
      const items=await S.api.suggestions(t,q,requestId);
      if(q.revision!==revision||q.suggestions.requestId!==requestId)return;
      q.suggestions={status:'ready',items,basedOnRevision:revision,requestId:null,error:''};
    }catch(error){
      if(q.revision!==revision||q.suggestions.requestId!==requestId)return;
      q.suggestions={...q.suggestions,status:'error',error:error.message};
    }finally{
      suggestionJobs.delete(key);await save(t);
      if(task===t&&current()===q&&q.panel==='chat'){render();document.getElementById('hw-message')?.focus({preventScroll:true});}
    }
  }
  async function perform(kind,provided,retryId){
    const t=task,q=current();if(!t||!q)return;
    const key=opKey(t,q);if(operations.has(key))return;
    const data=provided??(kind==='chat'?q.draft:kind==='check'?q.answer:kind==='canvas'?root.HomeworkCanvas?.capture(q):null);
    if((kind==='chat'||kind==='check')&&!String(data).trim()){announce(kind==='chat'?'先写下你的想法。':'先填写订正答案。');document.getElementById(kind==='chat'?'hw-message':'hw-answer')?.focus();return;}
    if(kind==='recognize'&&!q.recognitionText?.trim()){announce('请补全题干，再重新批改。');document.getElementById('hw-recognition-text')?.focus();return;}
    if(kind==='canvas'&&(!data||!data.strokeCount)){announce('先在画板上写一笔，再让伴学查看。');return;}
    const requestId=retryId||S.id();trackExecution(t,q,requestId,kind);operations.set(key,{kind,data,requestId});q.pending={kind,data,requestId};q.error=null;
    if(kind==='recognize'&&!retryId){
      q.materialHistory.push({text:q.text,formula:q.formula,original:q.original,status:q.status,at:new Date().toISOString()});
      q.text=q.recognitionText;q.formula='';q.original=q.recognitionAnswer||'';q.status='uncertain';q.reason='材料已核对，等待重新批改。';q.attempts.forEach(a=>a.superseded=true);
      S.record(q,'recognition','核对题目与原答：'+q.text+'；原答：'+q.original);q.memory={status:'idle',entries:[],evidenceRevision:0};q.suggestions={status:'idle',items:[],basedOnRevision:-1,requestId:null,error:''};
    }
    render();if(kind==='chat'){const history=document.getElementById('hw-chat-history');if(history)history.scrollTop=history.scrollHeight;}await save(t);
    try{
      const response=await S.api[kind](t,q,data,requestId);
      if(kind==='chat'){
        const event=S.record(q,'message',data);
        q.messages.push({id:event.id,role:'student',text:data,at:event.at},{id:S.id(),role:'assistant',text:response.text,title:response.title,kind:response.kind,help:response.help,at:new Date().toISOString(),execution:q.execution?structuredClone(q.execution):undefined});
        if(response.help){q.help=true;S.record(q,'help',response.text);}
        q.suggestions={status:'ready',items:response.suggestedQuestions,basedOnRevision:q.revision,requestId:null,error:''};
        if(q.draft===data)q.draft='';q.panel='chat';
      }else if(kind==='canvas'){
        root.HomeworkCanvas.applyResponse(q,response);
        const reply=response.commands.map(command=>command.tool==='write_text'?command.text:'教学图：长方形绕一边旋转得到圆柱').join('；');
        const event=S.record(q,response.help?'help':'message','画板回复：'+reply);
        if(response.help)q.help=true;
        q.canvas.lastResponseEventId=event.id;q.panel='chat';q.togetherMode='canvas';
      }else if(kind==='check'){
        const event=S.record(q,'attempt',data+'；检查结果：'+response.reason);
        q.attempts.push({id:S.id(),value:data,status:response.status,reason:response.reason,help:q.help,external:q.external,at:event.at,eventId:event.id});q.panel='answer';
        if(q.answer===data)q.answer='';
      }else{
        q.status=response.status;q.reason=response.reason;q.panel='overview';q.recognitionText=null;q.recognitionAnswer=null;
        S.record(q,'regrade',response.reason);
      }
      operations.delete(key);delete q.pending;await save(t);remember(t,q);if(task===t){render();announce(kind==='chat'?'辅导回复已到达。':kind==='canvas'?'伴学已把回复写到画板。':kind==='check'?'订正检查完成。':'材料已重新核对。');if(current()===q&&kind==='chat'){const history=document.getElementById('hw-chat-history');if(history)history.scrollTop=history.scrollHeight;}}
    }catch(error){failExecution(requestId,error.message);operations.delete(key);delete q.pending;q.error={kind,data,requestId,message:error.message};await save(t);if(task===t){render();announce(error.message);}}
  }
  // Recognition has a different transport signature; keep call sites uniform.
  {const fn=S.api.recognize;S.api.recognize=(t,q,data,requestId)=>fn(t,q,requestId);}
  function paperContent(){
    return imageURL?`<div class="hw-image-map"><img class="hw-original-image" src="${imageURL}" alt="你上传的作业原图">${task.phase==='work'?task.questions.map(q=>{const box=S.box(q.box);if(!box)return '';const [x,y,w,h]=box;return `<button type="button" class="hw-question-region ${q.id===task.selected?'selected':''}" style="left:${x*100}%;top:${y*100}%;width:${w*100}%;height:${h*100}%" data-hw="select" data-region="true" data-id="${esc(q.id)}" aria-label="查看第 ${q.number} 题，${esc(q.skill||labels[outcome(q)])}" aria-pressed="${q.id===task.selected}"><span>${q.number}</span></button>`;}).join(''):''}</div>${task.regionsState==='loading'?'<div class="hw-region-status" role="status">正在定位题目…</div>':task.regionsState==='error'?`<div class="hw-region-status"><button type="button" class="text-button" data-hw="retry-regions" title="${esc(task.regionsError)}">框选暂未加载，重试</button></div>`:task.phase==='work'&&!task.questions.every(q=>Object.hasOwn(q,'box'))?'<div class="hw-region-status"><button type="button" class="text-button" data-hw="retry-regions" title="用 Codex 定位原图中的题目">显示题目框选</button></div>':''}`:'<p class="hw-empty">原图暂时无法读取，请返回重新选择。</p>';
  }
  function originalPanel(){return `<section class="hw-material" aria-label="作业原图"><div class="hw-material-body">${paperContent()}</div></section>`;}
  function header(){const title=/\.(?:jpe?g|png|webp|heic|gif)$/i.test(task.title)?(task.purpose==='single'?'题目答疑':'作业批改'):task.title;return `<header class="page-header hw-header"><div><h1 class="page-title" id="page-title" tabindex="-1">${esc(title)}</h1></div></header>`;}
  function preparation(){let content='';
    if(task.phase==='prepare')content='<div class="hw-loading" role="status"><h2>准备读取图片</h2></div>';
    else if(task.phase==='grading')content='<div class="hw-loading" role="status" aria-live="polite" aria-label="正在批改作业"><h2>正在批改作业</h2><div class="hw-skeleton" aria-hidden="true"><i></i><i></i><i></i></div></div>';
    else if(task.phase==='empty')content=`<h2>没有找到题目</h2><p>请换一张清楚、完整的图片。</p>${button('重新选择图片','upload','')}`;
    else content=`<div role="alert"><span class="hw-error-icon">${icon('info')}</span><h2>这次没有完成</h2><p>${esc(task.gradeError)}</p></div><div class="hw-actions">${button('重试','grade','')}${button('返回图片','upload','secondary')}</div>`;
    return `<div class="hw-grid hw-preparation">${originalPanel()}<section class="hw-preparation-panel">${content}${executionSlot(task,'grade')}</section></div>`;
  }
  function questionNavigation(){
    const counts={all:task.questions.length,wrong:task.questions.filter(q=>['wrong','unanswered'].includes(outcome(q))).length,uncertain:task.questions.filter(q=>outcome(q)==='uncertain').length};
    if(task.filter!=='all'&&!counts[task.filter])task.filter='all';
    const originalCounts=Object.fromEntries(['correct','wrong','unanswered','uncertain'].map(status=>[status,task.questions.filter(q=>q.status===status).length]));
    const summary=`<div class="hw-grading-summary" aria-label="整份作业的原答批改结果"><span class="correct">正确 <b>${originalCounts.correct}</b> 题</span><span class="wrong">错误 <b>${originalCounts.wrong}</b> 题</span>${originalCounts.unanswered?`<span>未作答 <b>${originalCounts.unanswered}</b> 题</span>`:''}${originalCounts.uncertain?`<span>待核对 <b>${originalCounts.uncertain}</b> 题</span>`:''}</div>`;
    const visible=task.questions.filter(q=>task.filter==='all'||(task.filter==='wrong'?['wrong','unanswered'].includes(outcome(q)):outcome(q)==='uncertain'));
    const filters=[['all','全部'],['wrong','待订正'],['uncertain','待核对']].filter(([value])=>value==='all'||counts[value]>0);
    return `<div class="hw-question-toolbar"><div class="hw-filters" aria-label="按批改结果筛选">${filters.map(([value,label])=>`<button type="button" data-hw="filter" data-value="${value}" aria-pressed="${task.filter===value}">${label}<span>${counts[value]}</span></button>`).join('')}</div>${summary}<div class="hw-question-picker"><span class="hw-question-label">题号</span><nav class="hw-question-nav" aria-label="作业题号">${visible.map(q=>`<button type="button" class="${outcome(q)} ${q.id===task.selected?'selected':''}" data-hw="select" data-id="${esc(q.id)}" aria-current="${q.id===task.selected?'true':'false'}" aria-label="第 ${q.number} 题，${labels[outcome(q)]}"><span>${q.number}</span></button>`).join('')||'<span class="hw-caption">没有符合条件的题目。选择「全部」继续查看。</span>'}</nav></div></div>`;
  }
  function memoryCue(q){
    const similar=root.LearningSummary?.similarPastWrong(history,task,q);
    if(!similar)return '';
    return `<aside class="hw-memory-cue" aria-label="与本题相似的历史错题"><div><span>${icon('clock')}相似旧错题</span><p>${esc(similar.taskTitle)} · 第 ${similar.number} 题：${esc(brief(similar.question,42))}</p></div><div><span>${icon('arrow')}相似在</span><p>${esc(similar.reason)}</p></div><button type="button" class="text-button" data-hw="past-question" data-task="${esc(similar.taskId)}" data-question="${esc(similar.questionId)}">查看旧题</button></aside>`;
  }
  function recognition(q,busy){return `<div class="hw-recognition"><h3>核对识别内容</h3><p class="hw-caption">对照左侧原图修改。这里是在修正识别内容，原答会保留在变更记录中。</p><label for="hw-recognition-text">题干与公式</label><textarea class="input" id="hw-recognition-text" data-hw-field="recognitionText" maxlength="8000">${esc(q.recognitionText??[q.text,q.formula].filter(Boolean).join('\n'))}</textarea><label for="hw-recognition-answer">图片中的原答</label><textarea class="input hw-math-input" id="hw-recognition-answer" data-hw-field="recognitionAnswer" maxlength="4000">${esc(q.recognitionAnswer??q.original)}</textarea><div class="hw-actions">${button(busy?'正在重新批改…':'确认内容，重新批改','recognize','',busy?'disabled':'')}${button('取消','overview','quiet',busy?'disabled':'')}</div></div>`;}
  function overview(q){return `<div class="hw-overview"><div class="hw-original-answer"><div class="hw-original-answer-heading"><h3>图片中的原答</h3><button class="text-button" data-hw="recognition">${icon('edit')}识别有误？</button></div><p class="student-writing">${esc(q.original)||'未识别到作答'}</p></div>${questionFormula(q,'solution')}<section class="hw-verdict ${q.status}"><h3>${q.status==='uncertain'?'这处需要你核对':q.status==='correct'?'原答正确':q.status==='unanswered'?'这道题还没有作答':'先核对这一步'}</h3><p>${esc(q.reason)}</p></section><div class="hw-actions">${q.status==='uncertain'?button('核对题目与原答','recognition',''):button(q.status==='correct'?'说说我的解法':'我来订正','answer','')}${button('帮我分析','chat','secondary')}</div></div>`;}
  function suggestionPanel(q,busy){
    const state=q.suggestions;
    if(state.status==='loading')return '<div class="hw-suggestion-status" role="status">正在准备和这题相关的问题…</div>';
    if(state.status==='error')return `<div class="hw-suggestion-status error"><span>推荐问题暂时没准备好，你仍可以直接提问。</span><button type="button" class="text-button" data-hw="retry-suggestions" title="${esc(state.error)}">重试</button></div>`;
    if(state.status==='idle')return '<div class="hw-suggestion-status"><span>不知道第一句怎么问？</span><button type="button" class="text-button" data-hw="retry-suggestions">帮我想几个问题</button></div>';
    if(!state.items.length)return '<div class="hw-suggestion-status">暂时没有合适的推荐问题，你可以直接写自己的问题。</div>';
    return `<div class="hw-chat-suggestions" aria-labelledby="hw-suggestions-label"><p id="hw-suggestions-label">你可以这样问，也可以直接写自己的问题</p><div>${state.items.map((item,index)=>`<button type="button" class="hw-suggestion" data-hw="suggestion" data-index="${index}" ${busy?'disabled':''}>${esc(item.text)}</button>`).join('')}</div></div>`;
  }
  function chat(q,busy){
    const mode=q.togetherMode==='canvas'?'canvas':'chat';
    const switcher=`<div class="hw-together-switch" role="group" aria-label="一起想的交互方式"><button type="button" data-hw="together-chat" aria-pressed="${mode==='chat'}">对话</button><button type="button" data-hw="together-canvas" aria-pressed="${mode==='canvas'}">画板</button></div>`;
    if(mode==='canvas')return `<section class="hw-together">${switcher}${root.HomeworkCanvas.view(q,busy)}</section>`;
    const op=operations.get(opKey(task,q));
    const start=!q.messages.length&&!q.draft.trim()&&op?.kind!=='chat'?'<div class="hw-chat-start"><p>哪一步不太确定？</p></div>':'';
    return `<section class="hw-together">${switcher}<div class="hw-chat"><div class="hw-chat-history" id="hw-chat-history" aria-label="本题讨论记录">${q.messages.length?q.messages.map(m=>`<article class="hw-message ${m.role}" aria-label="${m.role==='student'?'我的消息':'辅导回复'}">${m.title?`<h3>${esc(m.title)}</h3>`:''}<p>${esc(m.text)}</p></article>`).join(''):start}${op?.kind==='chat'?`<article class="hw-message student" aria-label="正在发送的消息"><p>${esc(op.data)}</p></article>${loadingDots()}`:''}</div>${suggestionPanel(q,busy)}<div class="hw-chat-compose"><label class="sr-only" for="hw-message">我的思路或问题</label><textarea id="hw-message" data-hw-field="draft" maxlength="4000" placeholder="写下你的思路，或说说哪里不确定…">${esc(q.draft)}</textarea><div class="hw-compose-bottom"><span>⌘ / Ctrl + Enter 发送</span><button type="button" class="hw-compose-send" data-hw="send" aria-label="发送消息" title="发送消息（⌘ / Ctrl + Enter）" ${busy?'disabled':''}>${icon('send')}</button></div></div>${q.messages.length?button('回到这道题，我来订正 '+icon('arrow'),'answer','secondary'):''}</div></section>`;
  }
  function isCanvasFocus(){
    const q=current();
    return !!(active&&q?.panel==='chat'&&q.togetherMode==='canvas'&&q.canvas?.focus);
  }
  function setCanvasFocus(q,focus){
    if(!q)return;
    const state=root.HomeworkCanvas?.ensure(q);if(!state)return;
    if(focus)canvasReturnY=Number(window.scrollY)||0;
    state.focus=focus;save();render();
    window.scrollTo(0,focus?0:canvasReturnY);
    document.getElementById(focus?'hw-question-canvas':'hw-current')?.focus?.({preventScroll:true});
    announce(focus?'已进入全屏画板，按 Esc 可退出。':'已退出全屏画板。');
  }
  function canvasFocusPage(q){
    const busy=operations.has(opKey(task,q));
    return `<main id="main" class="hw-canvas-page">${saveState==='error'?`<div class="hw-save-warning" role="alert">当前内容尚未保存成功，请暂时保留此页面。${button('重试保存','save','secondary')}</div>`:''}${root.HomeworkCanvas.view(q,busy,true)}${q.error?`<div class="hw-request-error" role="alert"><p>${esc(q.error.message)}</p>${button('重试这次操作','retry','secondary')}${button('关闭提示','dismiss-error','quiet')}</div>`:''}</main>`;
  }
  function questionFormula(q,placement='question'){
    if(!q.formula||choiceQuestion(q.text))return '';
    // Older records combine the problem's expression and worked calculation in this field.
    // Mark completed numeric calculations without labelling a given equation as a solution.
    const value=q.formula.trim(),alreadyLabelled=/^(解|答)\s*[:：]/.test(value);
    const worked=alreadyLabelled||((value.match(/[=＝≈]/g)||[]).length>1)||(/[=＝≈]/.test(value)&&/[+＋×÷*/−-]/.test(value)&&!/[a-zA-Z]/.test(value));
    if((placement==='solution')!==worked)return '';
    return `<p class="hw-formula">${worked&&!alreadyLabelled?'<span class="hw-solution-label">解：</span>':''}${esc(value)}</p>`;
  }
  function answerPanel(q,busy){const latest=attempts(q).at(-1);return `<section class="hw-answer"><label for="hw-answer">订正答案与步骤</label><div class="hw-chat-compose hw-answer-compose"><textarea class="hw-math-input" id="hw-answer" data-hw-field="answer" maxlength="6000" placeholder="写出新的答案，也可以补充关键步骤。">${esc(q.answer)}</textarea><div class="hw-compose-bottom"><button type="button" class="hw-compose-send" data-hw="check" aria-label="${busy?'正在检查订正':'发送订正答案'}" title="发送订正答案（⌘ / Ctrl + Enter）" ${busy?'disabled':''}>${icon('send')}</button></div></div>${latest?`<div class="hw-answer-feedback ${latest.status}" role="status"><h3>${latest.status==='correct'?'这次订正正确':latest.status==='uncertain'?'这次结果仍需核查':'再检查一下自己的步骤'}</h3><p>${esc(latest.reason)}</p><p class="hw-caption">${latest.status==='correct'?'已记录本次订正；尚未独立验证。':'你可以继续修改，或请伴学一起分析。'}</p></div>`:''}${latest?.status==='correct'?`<div class="hw-actions">${button('继续下一题 '+icon('arrow'),'next','secondary')}${button('查看学习记录','records','quiet')}</div>`:''}${q.attempts.length?`<details class="hw-attempts"><summary>查看 ${q.attempts.length} 次作答</summary>${q.attempts.slice().reverse().map((a,i)=>`<div><p><strong>第 ${q.attempts.length-i} 次</strong><span>${a.superseded?'材料更新前的记录':a.status==='correct'?'检查正确':a.status==='wrong'?'需订正':'待核查'}</span></p><pre>${esc(a.value)}</pre><small>${date(a.at)}${a.help||a.external?' · 有帮助':''}</small></div>`).join('')}</details>`:''}</section>`;}
  function workPanel(q){const busy=operations.has(opKey(task,q));return `<section class="hw-work-panel"><div class="hw-current-heading"><h2 id="hw-current" tabindex="-1">第 ${q.number} 题${q.skill?' · '+esc(q.skill):''}</h2>${tag(outcome(q))}</div><div class="hw-current-question">${questionText(q.text)}${questionFormula(q)}${q.materialHistory.length?'<span class="hw-caption">题目材料已核对，原始内容可在学习记录中追溯。</span>':''}</div>${memoryCue(q)}${q.panel!=='recognition'?`<div class="hw-tabs" aria-label="当前题工作区">${[['overview','批改结果'],['chat','一起想'],['answer','订正']].map(([value,label])=>`<button data-hw="${value}" aria-pressed="${q.panel===value}">${label}</button>`).join('')}</div>`:''}<div class="hw-panel-body">${q.panel==='recognition'?recognition(q,busy):q.panel==='chat'?chat(q,busy):q.panel==='answer'?answerPanel(q,busy):overview(q)}${q.panel==='chat'?'':executionSlot(q,'question')}${q.error?`<div class="hw-request-error" role="alert"><p>${esc(q.error.message)}</p>${button('重试这次操作','retry','secondary')}${button('关闭提示','dismiss-error','quiet')}</div>`:''}</div></section>`;}
  function view(){if(!task)return '';const q=current();if(q&&isCanvasFocus())return canvasFocusPage(q);return `<main id="main" class="page-with-title hw-page">${header()}${saveState==='error'?`<div class="hw-save-warning" role="alert">当前内容尚未保存成功，请暂时保留此页面。${button('重试保存','save','secondary')}</div>`:''}${task.phase==='work'?`${executionSlot(task,'grade')}${questionNavigation()}<div class="hw-grid">${originalPanel()}${workPanel(q||task.questions[0])}</div>`:preparation()}</main>`;}
  function afterRender(){if(!active)return;const nav=document.querySelector('.hw-question-nav'),selected=nav?.querySelector('[aria-current=true]');if(selected){const bounds=nav.getBoundingClientRect(),item=selected.getBoundingClientRect();if(item.right>bounds.right)nav.scrollLeft+=item.right-bounds.right+4;else if(item.left<bounds.left)nav.scrollLeft-=bounds.left-item.left+4;}document.querySelectorAll('.navigation .nav-item').forEach(el=>{el.classList.toggle('active',el.dataset.action==='prepare');});const q=current();if(q?.panel==='chat'&&q.togetherMode==='canvas')root.HomeworkCanvas?.mount(document.querySelector('.hw-canvas'),q,rerender=>{save();if(rerender)render();});}
  function openRecords(){root.LearningRecords.open();}
  async function openQuestion(taskId,questionId){await resume(taskId);if(task?.id!==taskId||!task.questions.some(q=>q.id===questionId))return false;root.LearningRecords.leave();task.selected=questionId;task.filter='all';save();render();document.getElementById('page-title')?.focus({preventScroll:true});window.scrollTo(0,0);return true;}
  function recentHTML(){if(!recent.length)return '';return `<section class="recent-section hw-recent"><div class="section-head"><h2>最近作业</h2></div>${recent.slice(0,3).map(t=>`<div class="recent-row"><span class="recent-icon">${icon('paper')}</span><div class="recent-content"><h3>${esc(t.title)}</h3><p>${t.count} 道题${t.done?' · '+t.done+' 道已订正':''} · ${date(t.updatedAt)}</p></div><button class="text-button" data-hw="resume" data-id="${esc(t.id)}">继续 ${icon('arrow')}</button></div>`).join('')}</section>`;}
  function historyHTML(){
    const records=recent.filter(t=>t.purpose!=='single').slice(0,6);
    return `<section class="upload-history" aria-labelledby="upload-history-title"><div class="upload-history-head"><h2 id="upload-history-title">历史批改记录</h2></div>${records.length?`<div class="upload-history-list">${records.map(t=>`<article class="upload-history-row"><span class="upload-history-icon">${icon('paper')}</span><div class="upload-history-content"><h3>${esc(t.title||'我的作业')}</h3><p>${t.count?`${t.count} 道题${t.done?' · '+t.done+' 道已订正':''}`:'批改未完成'} · ${date(t.updatedAt)}</p></div><button type="button" class="text-button" data-hw="resume" data-id="${esc(t.id)}">${esc(t.next)} ${icon('arrow')}</button></article>`).join('')}</div>`:`<div class="upload-history-empty">${historyEmptyArt()}<p>还没有历史批改记录哦</p></div>`}</section>`;
  }
  function leave(){const q=current();if(q?.canvas)q.canvas.focus=false;active=false;drawer=false;session(null);}
  async function init(paint,home){repaint=paint;navigateHome=home;
    try{const records=await S.store.list();refreshHistory(records);let key;try{key=sessionStorage.getItem('banxue-active-homework');}catch{}if(key&&records.some(t=>t.id===key&&t.mode==='api'))await resume(key);else render();}catch{saveState='error';}
  }
  document.addEventListener('input',e=>{
    const field=e.target.dataset.hwField;if(!field||!task)return;
    const q=current();if(q){q[field]=e.target.value;save();}
  });
  document.addEventListener('click',e=>{
    const el=e.target.closest('[data-hw]');if(!el||el.disabled)return;
    const action=el.dataset.hw,q=current();
    if(action==='resume'){resume(el.dataset.id,el.dataset.question);return;}
    if(action==='home'){leave();navigateHome();return;}
    if(action==='upload'){if(task.mode==='api'&&task.image)root.BanxueUpload.restore('homework',task.image,task.note);leave();document.querySelector('[data-action="prepare"]')?.click();return;}
    if(action==='grade'){grade();return;}
    if(action==='records'){openRecords();return;}
    if(action==='past-question'){openQuestion(el.dataset.task,el.dataset.question);return;}
    if(action==='retry-regions'){ensureRegions(task,true);return;}
    if(action==='save'){save().then(render);return;}
    if(!q)return;
    if(action==='select'||action==='return-question'){if(!task.questions.some(item=>item.id===el.dataset.id))return;task.selected=el.dataset.id;task.filter='all';drawer=false;if(el.dataset.region)current().panel='overview';save();render();if(el.dataset.region){document.getElementById('hw-current')?.focus({preventScroll:true});if(window.matchMedia('(max-width:740px)').matches)document.querySelector('.hw-work-panel')?.scrollIntoView({block:'start'});}announce('已切换题目，未自动请求辅导。');return;}
    if(action==='filter'){task.filter=el.dataset.value;render();return;}
    if(action==='retry-memory'){const target=task.questions.find(item=>item.id===el.dataset.id)||q;remember(task,target);return;}
    if(action==='external'){const target=task.questions.find(item=>item.id===el.dataset.id)||q;target.external=!target.external;S.record(target,'external',target.external?'学生补充：本题曾有他人帮助。':'学生撤回误填的他人帮助；实际辅导记录仍保留。');remember(task,target);return;}
    if(action==='next'){const candidates=task.questions.filter(item=>!['correct','corrected'].includes(outcome(item))&&item.id!==q.id);if(candidates.length){task.selected=candidates[0].id;task.filter='all';save();render();}else{openRecords();}return;}
    if(action==='suggestion'){
      const item=q.suggestions.items[Number(el.dataset.index)];if(!item)return;
      q.draft=item.text;save();render();const input=document.getElementById('hw-message');input?.focus({preventScroll:true});input?.setSelectionRange?.(input.value.length,input.value.length);announce('问题已填入输入框，可以修改后发送。');return;
    }
    if(action==='retry-suggestions'){loadSuggestions(task,q,true);return;}
    if(action==='canvas-focus-enter'){setCanvasFocus(q,true);return;}
    if(action==='canvas-focus-exit'){setCanvasFocus(q,false);return;}
    if(['overview','chat','answer','recognition'].includes(action)){
      q.panel=action;if(action==='recognition'){q.recognitionText??=[q.text,q.formula].filter(Boolean).join('\n');q.recognitionAnswer??=q.original;}
      save();render();document.getElementById(action==='chat'&&q.togetherMode!=='canvas'?'hw-message':action==='answer'?'hw-answer':action==='recognition'?'hw-recognition-text':'hw-current')?.focus({preventScroll:true});if(action==='chat'&&q.togetherMode!=='canvas')loadSuggestions(task,q);return;
    }
    if(action==='together-chat'||action==='together-canvas'){
      q.togetherMode=action==='together-canvas'?'canvas':'chat';
      const state=root.HomeworkCanvas?.ensure(q);if(state)state.focus=false;
      q.panel='chat';save();render();
      if(q.togetherMode==='chat')loadSuggestions(task,q);
      return;
    }
    if(action==='send')perform('chat');else if(action==='canvas-send')perform('canvas');else if(action==='check')perform('check');else if(action==='recognize')perform('recognize');
    else if(action==='retry'&&q.error)perform(q.error.kind,q.error.data,q.error.requestId);
    else if(action==='dismiss-error'){q.error=null;render();}
  });
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'&&isCanvasFocus()){e.preventDefault();setCanvasFocus(current(),false);return;}
    if(['hw-message','hw-answer'].includes(e.target?.id)&&e.key==='Enter'&&(e.metaKey||e.ctrlKey)&&!e.isComposing){e.preventDefault();perform(e.target.id==='hw-answer'?'check':'chat');}
  });
  root.HomeworkFlow={init,view,afterRender,recentHTML,historyHTML,startUpload,resume,leave,openQuestion,flush:()=>saveQueue,isActive:()=>active,isCanvasFocus,hasRecent:()=>recent.length>0,openLatest:openRecords};
})(window);
