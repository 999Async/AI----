/* Server-owned learning profile and recommendation. No demo data is accepted here. */
(function(root){
  'use strict';
  const S=root.HomeworkService;
  let state='idle', recommendation=null, active=false, repaint=()=>{}, request=null;
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const icon=()=>'<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14 m-5-5 5 5-5 5"/></svg>';

  async function refresh(force=false){
    if(state==='loading')return request;
    if(!force&&state==='ready')return recommendation;
    state='loading';repaint();
    request=S.api.recommendation(S.id()).then(result=>{
      if(!result||!['ready','insufficient'].includes(result.state))throw Error('学习推荐格式不正确。');
      recommendation=result;state=result.state;repaint();return result;
    }).catch(error=>{recommendation={message:error.message};state='error';repaint();return null;});
    return request;
  }
  function homeHTML(){
    if(state==='loading'||state==='idle')return '<section class="recommendation-card recommendation-loading" aria-label="正在整理学习推荐"><div aria-hidden="true"></div><div aria-hidden="true"></div></section>';
    if(state==='insufficient'){
      const missing=Math.max(0,(recommendation.requiredTasks||2)-(recommendation.observedTasks||0));
      return `<section class="recommendation-card recommendation-empty"><div><h2>${missing?`再完成 ${missing} 份作业`:'再做几道同类题'}</h2><p>${missing?'先多了解你的学习。':'看清反复卡住的地方，再推荐。'}</p></div></section>`;
    }
    if(state==='error')return `<section class="recommendation-card recommendation-empty"><div><h2>学习推荐暂不可用</h2><p>真实作业仍可继续使用。</p></div><button class="text-button" data-recommendation="retry">重试</button></section>`;
    const item=recommendation;
    return `<section class="recommendation-card" aria-labelledby="recommendation-title"><div class="recommendation-main"><span>为你推荐 · ${esc(item.knowledgePoint)}</span><h2 id="recommendation-title">${esc(item.title)}</h2><button class="btn" data-recommendation="open">开始学习 ${icon()}</button></div><div class="recommendation-route" aria-label="本次学习安排"><div><b>1</b><span>一题讲通</span></div><div><b>2</b><span>总结方法</span></div><div><b>3</b><span>新题验证</span></div></div></section>`;
  }
  function view(){
    if(!recommendation||state!=='ready')return '';
    const item=recommendation;
    return `<main id="main" class="page-with-title recommendation-page"><header class="recommendation-header"><button class="back" data-recommendation="back">← 返回首页</button><span>${esc(item.knowledgePoint)}</span><h1 id="page-title" tabindex="-1">${esc(item.title)}</h1><p>${esc(item.gap)}</p></header><section class="recommendation-lesson"><article class="recommendation-example"><span>先看这题</span><h2>${esc(item.example.question)}</h2></article><article class="recommendation-method"><h2>这样想</h2><ol>${item.example.steps.map(step=>`<li>${esc(step)}</li>`).join('')}</ol><div><span>记住方法</span><p>${esc(item.example.method)}</p></div></article><article class="recommendation-transfer"><span>你来试试</span><h2>${esc(item.transferQuestion)}</h2><p>${esc(item.success)}</p></article><details class="recommendation-evidence"><summary>为什么学这个</summary><p>${esc(item.reason)}</p><p>来自 ${item.evidenceIds.length} 条学习记录。</p></details></section></main>`;
  }
  function open(){if(state!=='ready')return;active=true;root.HomeworkFlow.leave();root.LearningRecords.leave();repaint();document.getElementById('page-title')?.focus({preventScroll:true});window.scrollTo(0,0);}
  function leave(){active=false;}
  function invalidate(){if(state==='ready'||state==='insufficient')state='idle';}
  function afterRender(){if(!active)return;document.querySelectorAll('.navigation .nav-item').forEach(el=>el.classList.toggle('active',el.dataset.action==='home'));}
  document.addEventListener('click',event=>{const el=event.target.closest('[data-recommendation]');if(!el)return;if(el.dataset.recommendation==='open')open();else if(el.dataset.recommendation==='back'){leave();repaint();window.scrollTo(0,0);}else if(el.dataset.recommendation==='retry')refresh(true);});
  root.LearningRecommendation={init:paint=>{repaint=paint;refresh();},refresh,invalidate,homeHTML,view,open,leave,afterRender,isActive:()=>active};
})(window);
