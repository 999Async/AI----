const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {test}=require('node:test');

const source=fs.readFileSync(__dirname+'/service-connection.js','utf8');

function load(overrides={}){
  const events=[];
  const location=overrides.location||{protocol:'http:',pathname:'/index.html',search:'',hash:'',replace:()=>{}};
  const context=vm.createContext({
    module:{exports:{}},location,
    fetch:overrides.fetch||(()=>Promise.reject(Error('offline'))),
    setTimeout:overrides.setTimeout||(()=>1),clearTimeout:()=>{},AbortController,
    CustomEvent:class{constructor(type,init){this.type=type;this.detail=init?.detail;}},
    addEventListener:()=>{},dispatchEvent:event=>events.push(event),
    document:{visibilityState:'visible',addEventListener:()=>{}},
  });
  context.window=context;
  vm.runInContext(source,context);
  return {api:context.BanxueServiceConnection,events,location};
}

test('file pages redirect to the supervised local HTTP origin and preserve the route',()=>{
  let target='';
  load({location:{protocol:'file:',pathname:'/tmp/prototype/index.html',search:'?demo=1',hash:'#knowledge',replace:value=>target=value}});
  assert.equal(target,'http://127.0.0.1:4178/index.html?demo=1#knowledge');
});

test('monitor reports recovery and emits an event after the service returns',async()=>{
  let online=false;
  const {api,events}=load({fetch:async()=>{
    if(!online)throw Error('offline');
    return {ok:true,json:async()=>({status:'ok',available:true,model:'gpt-test'})};
  }});
  await api.check();
  assert.equal(api.snapshot().phase,'recovering');
  online=true;
  await api.check();
  assert.equal(api.snapshot().phase,'online');
  assert.equal(events.filter(event=>event.type==='banxue:service-restored').length,1);
});

test('monitor distinguishes a running API from an unavailable model runtime',async()=>{
  const {api}=load({fetch:async()=>({ok:true,json:async()=>({status:'ok',available:false,model:null})})});
  await api.check();
  assert.equal(api.snapshot().phase,'degraded');
  assert.equal(api.snapshot().label,'模型未就绪');
});
