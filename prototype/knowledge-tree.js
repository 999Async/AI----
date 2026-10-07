/* Textbook hierarchy and server-owned learning footprints. No inferred mastery. */
(function(root){
  'use strict';
  const S=root.HomeworkService;
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const paths={branch:'M6 3v12a3 3 0 0 0 3 3h9 M6 9h12 M15 6l3 3-3 3 M15 15l3 3-3 3',search:'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',arrow:'M5 12h14 m-5-5 5 5-5 5',chevron:'m9 5 7 7-7 7',check:'m5 12 4 4L19 6',attention:'M12 7v6 M12 17v.1',refresh:'M20 8a8 8 0 1 0 0 8 M20 3v5h-5',book:'M4 5c3-1 5-1 8 1 3-2 5-2 8-1v14c-3-1-5-1-8 1-3-2-5-2-8-1z M12 6v14'};
  const icon=n=>`<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[n]||paths.branch}"/></svg>`;
  const labels={unlit:'尚未点亮',growing:'正在生长',lit:'已经点亮'};
  const needsPractice=n=>n?.attention?.type==='practice';
  const stateLabel=n=>needsPractice(n)?n.attention.label:labels[n.visualState];
  const coverage=n=>n.progress?`${n.progress.coveredConcepts}/${n.progress.totalConcepts} 个有足迹`:labels[n.visualState];
  const dot=n=>`<span class="kt-dot ${needsPractice(n)?'attention':n.visualState}" aria-hidden="true">${needsPractice(n)?icon('attention'):n.visualState==='lit'?icon('check'):''}</span>`;
  let active=false,repaint=()=>{},status='idle',error='',tree=null,curricula=[],curriculumId='',chapterId='',selectedId='',query='',recent=false,serial=0;
  const collapsed=new Set(),sessions=new Map();
  let graphView=null,graphKey='',graphSize=null,drag=null;
  let practice=null,composing=false,catalogOpen=false,catalogSource='';
  function buildTree(raw){
    if(!raw||typeof raw.curriculumId!=='string'||typeof raw.displayName!=='string'||!Array.isArray(raw.nodes)||!raw.nodes.length)throw Error('知识树内容不完整，请重新加载。');
    const index=new Map(),children=new Map();
    for(const n of raw.nodes){
      if(!n||typeof n.id!=='string'||!n.id||index.has(n.id)||typeof n.name!=='string'||!['chapter','section','concept'].includes(n.kind)||!Object.hasOwn(labels,n.visualState))throw Error('知识树节点格式不正确，请重新加载。');
      index.set(n.id,n);
    }
    for(const n of raw.nodes){
      if(n.kind==='chapter'?n.parentId!==null:!index.has(n.parentId))throw Error('知识树层级不完整，请重新加载。');
      if(n.kind==='section'&&index.get(n.parentId).kind!=='chapter'||n.kind==='concept'&&index.get(n.parentId).kind!=='section')throw Error('知识树层级不正确，请重新加载。');
      if(!children.has(n.parentId))children.set(n.parentId,[]);
      children.get(n.parentId).push(n);
    }
    for(const list of children.values())list.sort((a,b)=>(a.order||0)-(b.order||0));
    return {...raw,index,children};
  }
  async function get(path){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
    try{const response=await fetch(path,{signal:controller.signal,cache:'no-store'});if(!response.ok)throw Error('暂时无法读取知识树，请检查服务后重试。');return await response.json();}
    catch(e){if(e.name==='AbortError')throw Error('加载时间较长，请再试一次。');if(e instanceof TypeError)throw Error('无法连接学习服务，请检查连接后重试。');throw e;}finally{clearTimeout(timer);}
  }
  function children(id){return tree?.children.get(id)||[];}
  function concepts(id){return children(id).flatMap(n=>n.kind==='concept'?[n]:children(n.id));}
  function matches(n){return (!recent||n.recentlyChanged)&&(!query||[n.name,tree.index.get(n.parentId)?.name,tree.index.get(tree.index.get(n.parentId)?.parentId)?.name].some(s=>s?.includes(query)));}
  function visibleChapters(){return children(null).filter(n=>(!query&&!recent)||concepts(n.id).some(matches));}
  async function load(){
    const ticket=++serial;status='loading';error='';repaint();
    try{
      if(!curricula.length){const result=await get('/api/curricula');if(!Array.isArray(result.curricula)||!result.curricula.length)throw Error('暂时没有可用教材。');if(ticket!==serial)return;curricula=result.curricula;curriculumId=curriculumId||result.defaultCurriculumId;}
      const next=buildTree(await get('/api/learning-tree?curriculumId='+encodeURIComponent(curriculumId)));
      if(ticket!==serial)return;
      tree=next;status='ready';
      if(!tree.index.has(chapterId)){chapterId=children(null).find(n=>n.recentlyChanged)?.id||children(null).find(n=>n.visualState!=='unlit')?.id||children(null)[0]?.id||'';}
      if(selectedId!==chapterId&&!children(chapterId).some(n=>n.id===selectedId)&&!concepts(chapterId).some(n=>n.id===selectedId))selectedId='';
    }catch(e){if(ticket!==serial)return;status='error';error=e.message;}finally{if(ticket===serial)repaint();}
  }
  function setCatalog(open,source='manual'){
    catalogOpen=open;catalogSource=open?source:'';
    const catalog=document.querySelector('.kt-catalog'),toggle=document.querySelector('[data-kt="catalog"]');
    catalog?.classList.toggle('is-open',open);
    toggle?.setAttribute('aria-expanded',String(open));
  }
  function afterRender(){
    if(active&&status==='ready')positionGraph();
    if(active&&status==='ready'&&practice?.verification&&!practice.shown&&!practice.busy&&!practice.error)preparePractice();
  }
  document.addEventListener('pointerover',e=>{
    const catalog=e.target.closest?.('.kt-catalog');
    if(e.pointerType==='mouse'&&catalog&&!catalog.contains(e.relatedTarget))setCatalog(true,'hover');
  });
  document.addEventListener('pointerout',e=>{
    const catalog=e.target.closest?.('.kt-catalog');
    if(catalog&&!catalog.contains(e.relatedTarget)&&!catalog.contains(document.activeElement))setCatalog(false);
  });
  document.addEventListener('focusin',e=>{
    if(e.target.closest?.('.kt-chapters'))setCatalog(true,'hover');
  });
  document.addEventListener('focusout',e=>{
    const catalog=e.target.closest?.('.kt-catalog');
    if(catalog&&!catalog.contains(e.relatedTarget))setCatalog(false);
  });
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'&&catalogOpen){document.querySelector('[data-kt="catalog"]')?.focus({preventScroll:true});setCatalog(false);}
  });
  function open(){active=true;load();window.scrollTo(0,0);document.getElementById('page-title')?.focus({preventScroll:true});}
  function homeHTML(){
    const chapters=tree?children(null):[],changed=tree?.nodes.filter(n=>n.kind==='concept'&&n.recentlyChanged)||[];
    return `<section class="kt-home"><div class="kt-home-mark" aria-hidden="true">${icon('branch')}</div><div class="kt-home-copy"><h2>知识成长树</h2><p>${status==='error'?'暂时无法读取学习足迹，点开重试。':changed.length?`${esc(changed[0].name)}${changed.length>1?'等 '+changed.length+' 个知识点':''}最近有变化`:'按教材章节，看看自己的学习足迹。'}</p></div><div class="kt-mini" aria-hidden="true">${chapters.map(n=>dot(n)).join('')}</div><button class="text-button kt-home-open" data-action="knowledge" aria-label="查看知识树">${icon('arrow')}</button></section>`;
  }
  // Every edge joins a parent's right port to its child's left port.
  // Allocate a disjoint vertical band to each subtree before placing parents.
  function layoutTree(chapter,sections){
    const nodes=[],edges=[];let cursor=32;
    for(const {node,leaves,expanded} of sections){
      const sectionHeight=Math.max(96,Math.ceil(((node.code||'').length+node.name.length+1)/10)*23+50);
      const leafHeights=leaves.map(n=>Math.max(44,Math.ceil(n.name.length/11)*21+22));
      const leafBand=leafHeights.reduce((a,b)=>a+b+10,0)-10;
      const height=Math.max(sectionHeight,expanded?leafBand:sectionHeight),y=cursor+height/2;
      nodes.push({node,x:284,y,width:206,height:sectionHeight,expanded});
      let leafCursor=cursor+(height-leafBand)/2;
      if(expanded)leaves.forEach((leaf,i)=>{
        const ly=leafCursor+leafHeights[i]/2;leafCursor+=leafHeights[i]+10;
        nodes.push({node:leaf,x:564,y:ly,width:224,height:leafHeights[i]});
        edges.push({parent:node.id,child:leaf.id,x1:490,y1:y,x2:564,y2:ly});
      });
      cursor+=height+30;
    }
    const branches=nodes.filter(n=>n.node.kind==='section');
    const y=branches.length?(branches[0].y+branches[branches.length-1].y)/2:100;
    nodes.unshift({node:chapter,x:32,y,width:184,height:112});
    branches.forEach(n=>edges.push({parent:chapter.id,child:n.node.id,x1:216,y1:y,x2:n.x,y2:n.y}));
    return {nodes,edges,width:sections.some(s=>s.expanded)?820:522,height:Math.max(300,cursor+2)};
  }
  function catalogHTML(chapters,chapter){
    return `<div class="kt-catalog ${catalogOpen?'is-open':''}"><button class="kt-catalog-toggle" data-kt="catalog" aria-expanded="${catalogOpen}" aria-controls="kt-chapters" aria-label="展开或收起教材目录">${icon('book')}<span>教材目录</span>${icon('chevron')}</button><nav id="kt-chapters" class="kt-chapters" aria-label="教材章节">${chapters.map(n=>`<button data-kt="chapter" data-id="${esc(n.id)}" aria-label="${esc(n.code||'')} ${esc(n.name)}，${esc(coverage(n))}，${esc(stateLabel(n))}" title="${esc(n.code||'')} ${esc(n.name)}" class="kt-chapter ${chapter?.id===n.id?'active':''}" ${chapter?.id===n.id?'aria-current="true"':''}><span class="kt-chapter-code">${esc(n.code||'')}</span>${dot(n)}<span class="kt-chapter-name">${esc(n.name)}</span><span class="kt-chapter-meta">${esc(n.progress?coverage(n):concepts(n.id).length+' 个知识点')}</span></button>`).join('')}</nav></div>`;
  }
  function graphHTML(chapter){
    const sections=children(chapter.id).map(node=>({node,leaves:children(node.id).filter(matches),expanded:!collapsed.has(node.id)})).filter(s=>s.leaves.length);
    const layout=layoutTree(chapter,sections);graphSize=layout;
    const key=[chapter.id,query,recent,...sections.map(s=>s.node.id+':'+s.expanded)].join('|');
    if(key!==graphKey){graphKey=key;graphView=null;}
    const selected=tree.index.get(selectedId),path=new Set(selected?[selected.id,selected.parentId,chapter.id]:[]);
    const wires=layout.edges.map(e=>`<path class="kt-edge ${path.has(e.child)&&path.has(e.parent)?'is-path':''}" data-parent="${esc(e.parent)}" data-child="${esc(e.child)}" d="M ${e.x1} ${e.y1} C ${e.x1+36} ${e.y1}, ${e.x2-36} ${e.y2}, ${e.x2} ${e.y2}"/>`).join('');
    const nodes=layout.nodes.map(({node:n,x,y,width,height,expanded})=>{
      const style=`left:${x}px;top:${y-height/2}px;width:${width}px;min-height:${height}px`;
      const state=needsPractice(n)?'attention':n.visualState;
      if(n.kind==='chapter')return `<div class="kt-map-root ${state}" style="${style}"><h2 id="kt-chapter-title" tabindex="-1">${esc(n.name)}</h2>${dot(n)}<p>${esc(stateLabel(n))}</p></div>`;
      if(n.kind==='section')return `<button class="kt-section ${state} ${path.has(n.id)?'is-path':''}" style="${style}" data-kt="toggle" data-id="${esc(n.id)}" aria-expanded="${expanded}">${dot(n)}<span class="kt-section-copy"><strong>${esc(n.code||'')} ${esc(n.name)}</strong><small>${esc(coverage(n))}${needsPractice(n)?` · ${esc(n.attention.label)}`:''}</small></span><span class="kt-branch-toggle" aria-hidden="true">${expanded?'−':'+'}</span></button>`;
      return `<button class="kt-node ${state} ${n.id===selectedId?'selected':''}" style="${style}" data-kt="select" data-id="${esc(n.id)}" aria-pressed="${n.id===selectedId}" title="${esc(n.name)} · ${esc(stateLabel(n))}">${dot(n)}<span class="kt-node-name">${esc(n.name)}</span><span class="sr-only">${esc(stateLabel(n))}</span>${n.recentlyChanged?'<span class="kt-new" aria-label="最近24小时有变化"></span>':''}</button>`;
    }).join('');
    return `<div class="kt-map-heading">${catalogHTML(visibleChapters(),chapter)}<button class="text-button" data-kt="expand">${sections.every(s=>!s.expanded)?'展开分支':'收起分支'}</button></div><div class="kt-viewport" tabindex="0" role="region" aria-label="知识树画布，可拖动或使用方向键平移"><div class="kt-map-space"><div class="kt-map" style="width:${layout.width}px;height:${layout.height}px"><svg class="kt-connections" width="${layout.width}" height="${layout.height}" aria-hidden="true">${wires}</svg>${nodes}</div></div></div><div class="kt-map-bottom"><span class="kt-pan-hint">拖动或滑动画布 · 点击知识点</span><div class="kt-zoom" role="group" aria-label="画布缩放"><button data-kt="zoom-out" aria-label="缩小知识树">−</button><output id="kt-zoom-value" aria-label="缩放比例">100%</output><button data-kt="zoom-in" aria-label="放大知识树">+</button><button class="kt-fit" data-kt="fit">适配画布</button></div></div>`;
  }
  function positionGraph(fit=false){
    const viewport=document.querySelector('.kt-viewport'),map=document.querySelector('.kt-map'),space=document.querySelector('.kt-map-space');
    if(!viewport||!map||!space||!graphSize)return;
    if(fit||!graphView){
      graphView={scale:Math.max(fit?.35:.85,Math.min(1,(viewport.clientWidth-32)/graphSize.width,(viewport.clientHeight-24)/graphSize.height)),left:0,top:0};
    }
    const {scale}=graphView;
    const w=Math.max(viewport.clientWidth,graphSize.width*scale+32),h=Math.max(viewport.clientHeight,graphSize.height*scale+24);
    space.style.width=w+'px';space.style.height=h+'px';
    map.style.transform=`translate(${Math.max(16,(w-graphSize.width*scale)/2)}px,${Math.max(12,(h-graphSize.height*scale)/2)}px) scale(${scale})`;
    viewport.scrollLeft=graphView.left;viewport.scrollTop=graphView.top;
    const label=document.getElementById('kt-zoom-value');if(label)label.textContent=Math.round(scale*100)+'%';
    for(const action of ['zoom-in','zoom-out']){const b=document.querySelector(`[data-kt="${action}"]`);if(b)b.disabled=action==='zoom-in'?scale>=1.6:scale<=.35;}
  }
  function zoom(delta){
    const viewport=document.querySelector('.kt-viewport');if(!viewport||!graphView)return;
    const old=graphView.scale,next=Math.max(.35,Math.min(1.6,old+delta));
    graphView={scale:next,left:(viewport.scrollLeft+viewport.clientWidth/2)*next/old-viewport.clientWidth/2,top:(viewport.scrollTop+viewport.clientHeight/2)*next/old-viewport.clientHeight/2};
    positionGraph();
  }
  function detail(){
    const node=tree.index.get(selectedId);
    if(node?.kind!=='concept')return '';
    const parent=tree.index.get(node.parentId);
    const explanation=needsPractice(node)?node.attention.reason:{unlit:'这里还没有学习足迹。可以先试一道题，或上传相关作业。',growing:'已经在这里开始学习。再试一道新题，看看这次能做到哪一步。',lit:'你在这里留下了正确作答的足迹。可以换一道新题，再独立试试。'}[node.visualState];
    return `<aside class="kt-detail ${needsPractice(node)?'kt-detail-practice':''}" id="kt-detail"><div class="kt-detail-heading"><h2 tabindex="-1" id="kt-detail-title">${esc(node.name)}</h2><button class="kt-close" data-kt="deselect" aria-label="关闭知识点详情">收起</button></div><p class="kt-parent">${esc(parent?`${parent.code||''} ${parent.name}`:tree.displayName)}</p><div class="kt-state">${dot(node)}${esc(stateLabel(node))}</div><p class="kt-explanation">${esc(explanation)}</p>${needsPractice(node)?'<p class="kt-next-hint">先回看卡住的地方，再用一道新题试试。之后的作答会继续更新这个提示。</p>':''}<button class="btn kt-start" data-kt="practice" ${practice?.busy?'disabled':''}>${sessions.has(curriculumId+':'+node.id)?'接着做这题':needsPractice(node)?'再试一道新题':node.visualState==='unlit'?'试一道新题':node.nextAction?.type==='verify'?'独立试一题':node.nextAction?.type==='review'?'再练一题':'继续练习'} ${icon('arrow')}</button><button class="text-button" data-action="result">查看学习记录 ${icon('arrow')}</button><details class="kt-about"><summary>这些状态代表什么</summary><p>尚未点亮：没有有效学习记录。正在生长：已经开始学习。已经点亮：留下了正确作答的足迹，可能包含帮助后完成。</p><p>“再巩固一下”表示近期多道题仍待订正。小节和章节按下属知识点汇总，不会因为一道题答对就全部点亮。</p><p>状态记录学习过程，不代表永久掌握。</p></details></aside>`;
  }
  function practiceHTML(){
    if(!practice)return '';
    const p=practice,v=p.verification;
    return `<section class="kt-practice" id="kt-practice" aria-labelledby="kt-practice-title"><header><h2 id="kt-practice-title" tabindex="-1">${esc(p.name)} · 试一题</h2><button class="text-button" data-kt="close-practice" ${p.busy?'disabled':''}>收起练习</button></header>${!v?`<p role="status">${p.busy?'正在准备一道新题…':'题目还没有准备好。'}</p>`:`<p class="kt-practice-question">${esc(v.question)}</p>${p.result?`<div class="kt-feedback" role="status"><h3>${{correct:'这道题答对了',wrong:'这次还需要再想一想',uncertain:'这次还不能确定'}[p.result.status]||'作答已记录'}</h3><p>${esc(p.result.reason)}</p><p class="kt-note">首次作答已保留，知识树已重新读取。</p></div><button class="btn secondary" data-kt="new-practice">再试一道新题</button>`:`<label class="kt-answer-label" for="kt-answer">你的答案与解题步骤</label><textarea id="kt-answer" rows="4" maxlength="16000" placeholder="先自己想一想，写下你的做法。" ${p.frozen?'readonly':''}>${esc(p.answer)}</textarea><label class="kt-external"><input type="checkbox" id="kt-external" ${p.externalHelp?'checked':''} ${p.frozen?'disabled':''}>这次用过提示、答案或他人帮助</label><div class="kt-submit"><button class="btn" data-kt="check" ${p.busy||!p.shown||!p.answer.trim()?'disabled':''}>${p.busy?'正在处理…':p.frozen?'用原作答重试':'提交作答'}</button><span>${p.frozen?'首次作答已固定，重试会使用相同内容。':'只记录首次作答；帮助后的完成会单独保留。'}</span></div>`}`}${p.error?`<div class="kt-error" role="alert"><p>${esc(p.error)}</p>${!v||!p.shown?'<button class="text-button" data-kt="retry-practice">再试一次</button>':''}</div>`:''}</section>`;
  }
  function view(){
    const options=curricula.map(c=>`<option value="${esc(c.id)}" ${c.id===curriculumId?'selected':''}>${esc(c.displayName)}</option>`).join('');
    let content;
    if(status==='loading'||status==='idle')content='<section class="kt-placeholder" role="status"><span class="kt-loading-symbol"></span><h2>正在展开知识树</h2><p>读取教材和你的学习足迹。</p></section>';
    else if(status==='error')content=`<section class="kt-placeholder kt-placeholder-error" role="alert"><h2>知识树暂时打不开</h2><p>${esc(error)}</p><button class="btn secondary" data-kt="refresh">重新加载</button></section>`;
    else{
      const chapters=visibleChapters(),chapter=chapters.find(n=>n.id===chapterId)||chapters[0],allConcepts=tree.nodes.filter(n=>n.kind==='concept');
      const filtered=!!query||recent;
      content=`<div class="kt-toolbar"><label class="kt-search">${icon('search')}<span class="sr-only">搜索知识点或章节</span><input id="kt-search" type="search" placeholder="搜索知识点或章节" value="${esc(query)}" autocomplete="off"></label><div class="kt-filters" aria-label="知识点范围"><button data-kt="filter" data-value="all" aria-pressed="${!recent}">全部知识点</button><button data-kt="filter" data-value="recent" aria-pressed="${recent}">最近变化 <span>${allConcepts.filter(n=>n.recentlyChanged).length}</span></button></div></div><div class="kt-workspace ${tree.index.get(selectedId)?.kind==='concept'?'has-detail':''}"><section class="kt-canvas ${filtered?'filtered':''}" aria-label="章节知识树">${chapter?graphHTML(chapter):`<div class="kt-map-heading">${catalogHTML(chapters,chapter)}</div><div class="kt-no-match"><h2>${recent?'最近还没有变化':'没有找到这个知识点'}</h2><p>${recent?'完成相关作业或练习后，这里会显示新的学习足迹。':'试试更短的词，或换一个名称。'}</p><button class="btn secondary" data-kt="clear">查看全部知识点</button></div>`}</section>${detail()}</div><footer class="kt-legend" aria-label="学习足迹图例">${Object.entries(labels).map(([visualState,label])=>`<span>${dot({visualState})}${label}</span>`).join('')}<span>${dot({attention:{type:'practice'}})}再巩固一下</span><p>点亮是学习足迹，不是掌握度。</p></footer>${practiceHTML()}`;
    }
    return `<main id="main" class="page-with-title kt-page"><header class="page-header kt-page-header"><div class="kt-title-group"><h1 class="page-title" id="page-title" tabindex="-1">知识成长树</h1><div class="kt-header-actions">${icon('book')}<label class="sr-only" for="kt-curriculum">选择教材</label><select id="kt-curriculum" ${status==='loading'||practice?.busy?'disabled':''}>${options||'<option>正在读取教材…</option>'}</select></div></div><button class="kt-refresh" data-kt="refresh" aria-label="刷新知识树" title="刷新知识树" ${status==='loading'?'disabled':''}>${icon('refresh')}</button></header>${content}</main>`;
  }
  function paintFocus(id){
    const input=document.activeElement,selection=input?.id===id?[input.selectionStart,input.selectionEnd]:null;
    repaint();const target=document.getElementById(id);target?.focus({preventScroll:true});
    if(selection&&target?.setSelectionRange)target.setSelectionRange(...selection);
  }
  function savePractice(){try{sessionStorage.setItem('banxue-tree-practice',JSON.stringify([...sessions].map(([k,p])=>[k,{...p,busy:false}])));}catch{}}
  async function preparePractice(){
    const p=practice;if(!p||p.busy)return;p.busy=true;p.error='';repaint();
    try{
      if(!p.verification){const result=await S.api.createVerification({curriculumId:p.curriculumId,nodeId:p.nodeId},p.createKey);const v=result.verification;if(!v||typeof v.id!=='string'||typeof v.question!=='string'||v.nodeId!==p.nodeId||v.curriculumId!==p.curriculumId)throw Error('题目返回不完整，请重试。');p.verification=v;savePractice();repaint();}
      // Only report exposure after the actual question has been painted on this route.
      if(active&&practice===p&&document.querySelector('.kt-practice-question')&&!p.shown){await S.api.showVerification(p.verification.id,p.showKey);p.shown=true;}
    }catch(e){p.error=e.message;}finally{p.busy=false;savePractice();repaint();}
  }
  function startPractice(fresh=false){
    const n=tree.index.get(selectedId);if(!n||n.kind!=='concept')return;
    const key=curriculumId+':'+n.id;
    if(fresh||!sessions.has(key))sessions.set(key,{name:n.name,nodeId:n.id,curriculumId,createKey:S.id(),showKey:S.id(),checkKey:S.id(),answer:'',externalHelp:false,shown:false,frozen:false});
    practice=sessions.get(key);savePractice();repaint();document.getElementById('kt-practice')?.scrollIntoView({block:'start',behavior:'auto'});document.getElementById('kt-practice-title')?.focus({preventScroll:true});preparePractice();
  }
  async function check(){
    const p=practice;if(!p||p.busy||!p.shown||!p.answer.trim()||p.result)return;
    p.frozen=true;p.busy=true;p.error='';savePractice();repaint();
    try{const result=await S.api.checkVerification(p.verification.id,{answer:p.answer,externalHelp:p.externalHelp},p.checkKey);if(!['correct','wrong','uncertain'].includes(result?.status)||typeof result.reason!=='string')throw Error('作答结果不完整，请用原作答重试。');p.result=result;await load();}
    catch(e){p.error=e.message;}finally{p.busy=false;savePractice();repaint();}
  }
  document.addEventListener('click',e=>{
    const catalog=document.querySelector('.kt-catalog');if(catalog&&!catalog.contains(e.target))setCatalog(false);
    const el=e.target.closest('[data-kt]');if(!el)return;const {kt:action,id}=el.dataset;
    if(action==='zoom-in')zoom(.15);
    if(action==='zoom-out')zoom(-.15);
    if(action==='fit')positionGraph(true);
    if(action==='refresh')load();
    if(action==='catalog')setCatalog(!catalogOpen||catalogSource!=='manual');
    if(action==='chapter'){chapterId=id;selectedId='';catalogOpen=false;repaint();document.getElementById('kt-chapter-title')?.focus({preventScroll:true});}
    if(action==='select'){const chosen=tree.index.get(id);if(chosen?.kind!=='concept')return;selectedId=id;if(chosen?.kind==='concept'){collapsed.delete(chosen.parentId);chapterId=tree.index.get(chosen.parentId)?.parentId||chapterId;}repaint();document.getElementById('kt-detail-title')?.focus({preventScroll:true});if(matchMedia('(max-width: 760px)').matches)document.getElementById('kt-detail')?.scrollIntoView({block:'nearest'});}
    if(action==='deselect'){const id=selectedId;selectedId='';repaint();document.querySelector(`[data-kt="select"][data-id="${CSS.escape(id)}"]`)?.focus({preventScroll:true});}
    if(action==='toggle'){collapsed.has(id)?collapsed.delete(id):collapsed.add(id);repaint();document.querySelector(`[data-kt="toggle"][data-id="${CSS.escape(id)}"]`)?.focus({preventScroll:true});}
    if(action==='expand'){const current=visibleChapters().find(n=>n.id===chapterId)||visibleChapters()[0];const sections=children(current?.id),all=sections.every(n=>collapsed.has(n.id));sections.forEach(n=>all?collapsed.delete(n.id):collapsed.add(n.id));repaint();document.querySelector('[data-kt="expand"]')?.focus({preventScroll:true});}
    if(action==='filter'){recent=el.dataset.value==='recent';if(recent)collapsed.clear();selectedId='';repaint();document.querySelector(`[data-kt="filter"][data-value="${el.dataset.value}"]`)?.focus({preventScroll:true});}
    if(action==='clear'){recent=false;query='';paintFocus('kt-search');}
    if(action==='practice')startPractice();
    if(action==='new-practice'){selectedId=practice.nodeId;startPractice(true);}
    if(action==='retry-practice')preparePractice();
    if(action==='close-practice'){practice=null;repaint();document.querySelector('.kt-start')?.focus({preventScroll:true});}
    if(action==='check')check();
  });
  document.addEventListener('scroll',e=>{
    if(e.target.classList?.contains('kt-viewport')&&graphView){graphView.left=e.target.scrollLeft;graphView.top=e.target.scrollTop;}
  },true);
  document.addEventListener('pointerdown',e=>{
    const v=e.target.closest?.('.kt-viewport');if(!v||e.target.closest('button')||e.pointerType!=='mouse'||e.button!==0)return;
    drag={v,x:e.clientX,y:e.clientY,left:v.scrollLeft,top:v.scrollTop};v.setPointerCapture(e.pointerId);v.classList.add('is-dragging');
  });
  document.addEventListener('pointermove',e=>{if(drag){drag.v.scrollLeft=drag.left+drag.x-e.clientX;drag.v.scrollTop=drag.top+drag.y-e.clientY;}});
  for(const type of ['pointerup','pointercancel'])document.addEventListener(type,()=>{drag?.v.classList.remove('is-dragging');drag=null;});
  document.addEventListener('keydown',e=>{
    if(!e.target.classList?.contains('kt-viewport'))return;
    if(e.key==='+'||e.key==='='){e.preventDefault();zoom(.15);}
    if(e.key==='-'){e.preventDefault();zoom(-.15);}
    if(e.key==='0'){e.preventDefault();positionGraph(true);}
  });
  if(root.addEventListener)root.addEventListener('resize',()=>{if(active){graphView=null;positionGraph();};});
  document.addEventListener('compositionstart',e=>{if(e.target.id==='kt-search')composing=true;});
  document.addEventListener('compositionend',e=>{if(e.target.id==='kt-search'){composing=false;query=e.target.value;if(query)collapsed.clear();selectedId='';paintFocus('kt-search');}});
  document.addEventListener('input',e=>{
    if(e.target.id==='kt-search'){query=e.target.value;if(query)collapsed.clear();selectedId='';if(!composing&&!e.isComposing)paintFocus('kt-search');}
    if(e.target.id==='kt-answer'&&practice&&!practice.frozen){practice.answer=e.target.value;savePractice();const button=document.querySelector('[data-kt="check"]');if(button)button.disabled=practice.busy||!practice.shown||!practice.answer.trim();}
  });
  document.addEventListener('change',e=>{
    if(e.target.id==='kt-curriculum'){curriculumId=e.target.value;chapterId='';selectedId='';query='';recent=false;practice=null;load();}
    if(e.target.id==='kt-external'&&practice&&!practice.frozen){practice.externalHelp=e.target.checked;savePractice();}
  });
  root.KnowledgeTree={init(paint){repaint=paint;try{const saved=JSON.parse(sessionStorage.getItem('banxue-tree-practice')||'[]');for(const [k,p] of saved)if(p&&typeof p.answer==='string'&&p.nodeId&&p.curriculumId)sessions.set(k,{...p,busy:false});}catch{}load();},open,leave(){active=false;catalogOpen=false;},isActive:()=>active,view,homeHTML,afterRender,refresh:load};
  if(typeof module!=='undefined')module.exports={buildTree,layoutTree};
})(typeof window==='undefined'?globalThis:window);
