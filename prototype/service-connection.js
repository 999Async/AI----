(function(root){
  'use strict';
  const LOCAL_ORIGIN='http://127.0.0.1:4178';
  const LOCAL_PAGES=new Set(['index.html','prd.html','banxue-pitch.html']);

  if(root.location?.protocol==='file:'){
    const page=(root.location.pathname||'').split('/').pop();
    const target=LOCAL_PAGES.has(page)?page:'index.html';
    root.location.replace(LOCAL_ORIGIN+'/'+target+(root.location.search||'')+(root.location.hash||''));
  }

  function createMonitor(options={}){
    const request=options.fetch||root.fetch?.bind(root);
    const later=options.setTimeout||root.setTimeout?.bind(root);
    const cancel=options.clearTimeout||root.clearTimeout?.bind(root);
    const listeners=new Set();
    let state={phase:'idle',label:'检测服务',detail:'正在检查本机服务',failures:0,health:null};
    let timer=null,inflight=null,stopped=false,experiencedFailure=false;

    function publish(next){
      state=Object.freeze({...state,...next});
      for(const listener of listeners)listener(state);
    }
    function schedule(delay){
      if(stopped||!later)return;
      if(timer!==null&&cancel)cancel(timer);
      timer=later(()=>{timer=null;check();},delay);
    }
    async function run(){
      const previous=state.phase;
      if(previous==='idle')publish({phase:'checking',label:'检测服务',detail:'正在检查本机服务'});
      const controller=new AbortController();
      const deadline=later?later(()=>controller.abort(),4000):null;
      try{
        if(!request)throw Error('fetch unavailable');
        const response=await request('/api/health',{cache:'no-store',signal:controller.signal});
        if(!response.ok)throw Error('health '+response.status);
        const health=await response.json();
        if(health?.status!=='ok')throw Error('invalid health response');
        const phase=health.available?'online':'degraded';
        publish({phase,label:phase==='online'?'服务已连接':'模型未就绪',
          detail:phase==='online'?'本机服务和模型入口正常':'页面服务正常，但未找到 Codex CLI',failures:0,health});
        if(phase==='online'&&experiencedFailure){
          experiencedFailure=false;
          root.dispatchEvent?.(new root.CustomEvent('banxue:service-restored',{detail:health}));
        }
        schedule(20000);
      }catch(error){
        experiencedFailure=true;
        const failures=state.failures+1;
        publish({phase:'recovering',label:'服务恢复中',detail:'守护进程会自动重启，页面正在重连',failures,health:null});
        schedule(Math.min(15000,1000*Math.pow(2,Math.min(failures-1,4))));
      }finally{
        if(deadline!==null&&cancel)cancel(deadline);
      }
      return state;
    }
    function check(){
      if(inflight)return inflight;
      inflight=run().finally(()=>{inflight=null;});
      return inflight;
    }
    function start(){
      stopped=false;
      check();
      return api;
    }
    function stop(){
      stopped=true;
      if(timer!==null&&cancel)cancel(timer);
      timer=null;
    }
    function subscribe(listener){
      listeners.add(listener);listener(state);
      return()=>listeners.delete(listener);
    }
    const api={start,stop,check,subscribe,snapshot:()=>state};
    return api;
  }

  const monitor=createMonitor();
  root.BanxueServiceConnection=monitor;
  if(typeof module!=='undefined')module.exports={createMonitor,LOCAL_ORIGIN};
})(typeof window!=='undefined'?window:globalThis);
