(function(root){
  'use strict';
  let page='home',mode='homework';
  const paths={book:'M4 5c3-1 5-1 8 1 3-2 5-2 8-1v14c-3-1-5-1-8 1-3-2-5-2-8-1z M12 6v14',home:'m3 10 9-7 9 7 M5 9v11h5v-6h4v6h5V9',paper:'M6 3h9l4 4v14H6z M14 3v5h5 M9 12h7 M9 16h5',chat:'M4 4h16v12H9l-5 4z M8 8h8 M8 12h5',branch:'M6 3v12a3 3 0 0 0 3 3h9 M6 9h12 M15 6l3 3-3 3 M15 15l3 3-3 3',clock:'M12 8v5l3 2 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',info:'M12 11v6 M12 7v.1 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0'};
  const routeHashes=new Set(['#home','#homework','#question','#knowledge','#records']);
  const icon=name=>`<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name]||paths.paper}"/></svg>`;
  const brandGlyph=()=>'<svg class="icon brand-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h5a4 4 0 0 1 4 4v11H8a4 4 0 0 1-4-4z"/><path d="M13 9a4 4 0 0 1 4-4h3v11a4 4 0 0 1-4 4h-3"/></svg>';

  function currentSection(){
    if(root.KnowledgeTree?.isActive())return 'knowledge';
    if(root.LearningRecords?.isActive())return 'result';
    if(root.LearningRecommendation?.isActive())return 'home';
    if(root.HomeworkFlow?.isActive())return mode==='single'?'single':'prepare';
    return page;
  }
  function nav(){
    const active=currentSection();
    const item=(action,label,glyph,key)=>`<button class="nav-item ${active===key?'active':''}" data-action="${action}" aria-label="${label}" ${active===key?'aria-current="page"':''}>${icon(glyph)}<span>${label}</span></button>`;
    const service=root.BanxueServiceConnection?.snapshot()||{phase:'idle',label:'检测服务',detail:'正在检查本机服务'};
    return `<aside class="sidebar"><div class="brand"><a class="brand-mark" href="#home" aria-label="学习首页" title="学习首页">${brandGlyph()}</a><span class="brand-word">伴学</span></div><nav class="navigation" aria-label="主导航">${item('home','学习首页','home','home')}${item('prepare','作业批改','paper','prepare')}${item('singlePrep','题目答疑','chat','single')}${item('knowledge','知识成长树','branch','knowledge')}${item('result','学习记录','clock','result')}</nav><div class="sidebar-bottom"><span class="service-status ${service.phase}" id="service-status" role="status" aria-label="${service.label}" title="${service.detail}"><span class="service-dot" aria-hidden="true"></span></span></div></aside>`;
  }
  function updateServiceStatus(state){
    const element=document.getElementById('service-status');if(!element)return;
    element.className='service-status '+state.phase;element.title=state.detail;element.setAttribute('aria-label',state.label);
  }
  function home(){
    return `<main id="main" class="home"><h1 class="sr-only" tabindex="-1" id="page-title">学习首页</h1><div class="intro"><span class="subject-label">${icon('book')}七年级 · 数学</span></div>${root.LearningRecommendation.homeHTML()}<section class="home-tools" aria-labelledby="home-tools-title"><div class="section-head"><h2 id="home-tools-title">开始学习</h2></div><div class="home-entries"><section class="entry-card homework-entry"><div class="entry-icon">${icon('paper')}</div><div class="entry-copy"><h3 id="homework-entry-title">作业批改</h3><p id="homework-entry-description">看错因，按题订正。</p></div><img class="entry-art" src="assets/homework.png" alt="" width="1024" height="1024"><button type="button" class="entry-hit" data-action="prepare" aria-labelledby="homework-entry-title" aria-describedby="homework-entry-description"></button></section><section class="entry-card question-entry"><div class="entry-icon">${icon('chat')}</div><div class="entry-copy"><h3 id="question-entry-title">题目答疑</h3><p id="question-entry-description">从卡住的一步开始。</p></div><img class="entry-art" src="assets/question.png?v=5" alt="" width="1024" height="1024"><button type="button" class="entry-hit" data-action="singlePrep" aria-labelledby="question-entry-title" aria-describedby="question-entry-description"></button></section></div></section>${root.KnowledgeTree.homeHTML()}${root.HomeworkFlow.recentHTML()}</main>`;
  }
  function render(){
    const content=root.KnowledgeTree.isActive()?root.KnowledgeTree.view():root.LearningRecommendation.isActive()?root.LearningRecommendation.view():root.LearningRecords.isActive()?root.LearningRecords.view():root.HomeworkFlow.isActive()?root.HomeworkFlow.view():page==='prepare'?root.BanxueUpload.view('homework'):page==='single'?root.BanxueUpload.view('single'):home();
    const canvasFocus=root.HomeworkFlow.isCanvasFocus?.()===true;
    document.getElementById('app').innerHTML=`<div class="shell${canvasFocus?' hw-focus-shell':''}">${canvasFocus?'':nav()}<div class="main-column">${content}</div></div>`;
    root.KnowledgeTree.afterRender();root.HomeworkFlow.afterRender();root.LearningRecords.afterRender();root.LearningRecommendation.afterRender();
  }
  function leaveFlows(){root.KnowledgeTree.leave();root.LearningRecommendation.leave();root.LearningRecords.leave();root.HomeworkFlow.leave();}
  function go(next,nextMode,preserveHash=false){
    leaveFlows();if(!preserveHash&&routeHashes.has(location.hash))history.replaceState(null,'',location.pathname+location.search);page=next;if(nextMode)mode=nextMode;render();window.scrollTo(0,0);document.getElementById('page-title')?.focus({preventScroll:true});
  }
  function routeFromHash(){
    if(location.hash==='#knowledge'){leaveFlows();root.KnowledgeTree.open();return true;}
    if(location.hash==='#records'){leaveFlows();root.LearningRecords.open();return true;}
    if(location.hash==='#homework'){go('prepare','homework',true);return true;}
    if(location.hash==='#question'){go('single','single',true);return true;}
    if(location.hash==='#home'){go('home',null,true);return true;}
    return false;
  }
  document.addEventListener('click',event=>{
    const control=event.target.closest('[data-action]');if(!control)return;
    if(control.dataset.action==='home'){go('home');root.LearningRecommendation.refresh();root.KnowledgeTree.refresh();}
    else if(control.dataset.action==='prepare')go('prepare','homework');
    else if(control.dataset.action==='singlePrep')go('single','single');
    else if(control.dataset.action==='knowledge'){leaveFlows();history.replaceState(null,'','#knowledge');root.KnowledgeTree.open();}
    else if(control.dataset.action==='result'){leaveFlows();root.LearningRecords.open();}
  });
  root.BanxueUpload.init(render);
  root.HomeworkFlow.init(render,()=>go('home'));
  root.LearningRecords.init(render);
  root.LearningRecommendation.init(render);
  root.KnowledgeTree.init(render);
  window.addEventListener('hashchange',routeFromHash);
  if(!routeFromHash())render();
  root.BanxueServiceConnection?.subscribe(updateServiceStatus);
  root.BanxueServiceConnection?.start();
  window.addEventListener('banxue:service-restored',()=>root.KnowledgeTree.refresh());
})(window);
