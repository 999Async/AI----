/* Homework transport and persistence. API data is untrusted and validated. */
(function (root) {
  'use strict';
  const text = (v, max = 16000) => typeof v === 'string' ? v.slice(0, max) : '';
  const statuses = ['correct', 'wrong', 'unanswered', 'uncertain'];
  const suggestionTypes = ['diagnose', 'method', 'extend'];
  const id = () => root.crypto?.randomUUID?.() || Date.now() + '-' + Math.random().toString(36).slice(2);
  function box(value) {
    if(!Array.isArray(value)||value.length!==4||value.some(n=>typeof n!=='number'||!Number.isFinite(n)||n<0||n>1))return null;
    const [x,y,w,h]=value;
    return w>0&&h>0&&x+w<=1.000001&&y+h<=1.000001?[x,y,Math.min(w,1-x),Math.min(h,1-y)]:null;
  }
  function question(raw, index) {
    if (!raw || typeof raw.id !== 'string' || !raw.id || typeof raw.text !== 'string' || !raw.text.trim()) throw Error('批改结果缺少题目内容，请重试。');
    return {
      id: text(raw.id, 200), number: index + 1, text: text(raw.text), formula: text(raw.formula),
      box: box(raw.box), original: text(raw.original), status: statuses.includes(raw.status) ? raw.status : 'uncertain',
      reason: text(raw.reason) || '还需要核对题目与作答。', skill: text(raw.skill, 200),
      messages: [], attempts: [], events: [], materialHistory: [], draft: '', answer: '',
      panel: 'overview', togetherMode: 'chat', canvas: null, help: false, external: false, revision: 0,
      suggestions: { status: 'idle', items: [], basedOnRevision: -1, requestId: null, error: '' },
      memory: { status: 'idle', entries: [], evidenceRevision: 0 },
      recognitionText: null, recognitionAnswer: null, error: null
    };
  }
  function graded(raw) {
    if (!raw || typeof raw.id !== 'string' || !Array.isArray(raw.questions)) throw Error('批改服务返回的内容不完整，请重试。');
    const questions = raw.questions.map(question);
    if (new Set(questions.map(q => q.id)).size !== questions.length) throw Error('题目编号重复，暂时无法显示，请重试。');
    return { id: raw.id, title: text(raw.title, 200) || '我的作业', questions };
  }
  function record(q, type, detail) {
    q.revision++;
    const event = { id: id(), type, detail: text(detail), at: new Date().toISOString(), revision: q.revision };
    q.events.push(event);
    return event;
  }
  function memoryResult(raw, q) {
    if (!raw || !Array.isArray(raw.entries)) throw Error('学习记录未完整生成，请重试。');
    const evidence = new Set(q.events.map(e => e.id));
    return raw.entries.map(item => {
      if (!item || !['fact', 'inference', 'progress'].includes(item.kind) || !text(item.text).trim() || !Array.isArray(item.evidenceIds) || !item.evidenceIds.length || item.evidenceIds.some(e => !evidence.has(e))) throw Error('学习判断缺少有效依据，暂未采用。');
      return { kind: item.kind, text: text(item.text, 1200), evidenceIds: [...new Set(item.evidenceIds)] };
    });
  }
  function suggestedQuestions(raw, field = 'questions') {
    const items = raw?.[field];
    if (!Array.isArray(items) || items.length > 3) throw Error('推荐问题未完整生成，请重试。');
    const seen = new Set();
    return items.map(item => {
      if (typeof item?.text !== 'string' || item.text.length > 120) throw Error('推荐问题未完整生成，请重试。');
      const value = item.text.trim();
      const normalized = value.replace(/\s+/g, '');
      if (!suggestionTypes.includes(item.type) || !value || seen.has(normalized)) throw Error('推荐问题未完整生成，请重试。');
      seen.add(normalized);
      return { type: item.type, text: value };
    });
  }
  function canvasDiagram(command) {
    const fields=['tool','kind','x','y','width','height'];
    if(!command||Object.keys(command).length!==fields.length||fields.some(field=>!Object.hasOwn(command,field))||
      command.tool!=='diagram'||command.kind!=='rectangle_about_side'||
      ['x','y','width','height'].some(field=>!Number.isInteger(command[field]))||
      command.x<0||command.y<300||command.width<500||command.height<150||
      command.x+command.width>1200||command.y+command.height>760)
      throw Error('画板回复包含无法显示的教学图，请重试。');
    return {tool:'diagram',kind:'rectangle_about_side',x:command.x,y:command.y,width:command.width,height:command.height};
  }
  function payload(q) {
    return { id: q.id, text: q.text, formula: q.formula, original: q.original, skill: q.skill,
      status: q.status, reason: q.reason, messages: q.messages.map(({execution, ...message})=>message), attempts: q.attempts,
      help: q.help, external: q.external, revision: q.revision, events: q.events,
      memory: q.memory.status === 'ready' && q.memory.evidenceRevision === q.revision ? q.memory.entries : [] };
  }
  const progressListeners = new Set();
  function emitProgress(event) { for (const listener of progressListeners) listener(event); }
  async function readStream(response, requestId, strictRequestId=true) {
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '', result, finished = false;
    function consume(line) {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); } catch { throw Error('服务返回的执行事件不完整，请重试。'); }
      if (event.type === 'heartbeat') return;
      if (strictRequestId && event.requestId !== requestId) throw Error('执行事件与当前请求不一致，请重试。');
      if (event.type === 'error') { emitProgress(event); throw Error(text(event.message, 500) || '本次处理未完成，请重试。'); }
      if (event.type === 'progress') emitProgress(event);
      if (event.type === 'result') { result = event.data; finished = true; emitProgress({...event, data:undefined}); }
    }
    try {
      while (true) {
        const {value, done} = await reader.read();
        buffer += decoder.decode(value, {stream:!done});
        if (buffer.length > 2000000) throw Error('服务结果过长，请缩小任务范围。');
        let split;
        while ((split = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0,split)); buffer = buffer.slice(split+1); }
        if (done) break;
      }
      consume(buffer);
      if (!finished) throw Error('连接中断，结果尚未接收完整。重试会接续原来的请求。');
      return result;
    } finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
  }
  async function request(path, data, requestId, strictRequestId=true) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 330000);
    try {
      const form = typeof FormData !== 'undefined' && data instanceof FormData;
      const response = await fetch(path.startsWith('/api/') ? path : '/api/homework' + path, {
        method: 'POST', credentials: 'same-origin', signal: controller.signal,
        headers: { ...(form ? {} : {'Content-Type': 'application/json'}), 'Idempotency-Key': requestId },
        body: form ? data : JSON.stringify(data)
      });
      if ([404, 405, 501].includes(response.status)) throw Error('批改服务尚未连接。图片和输入已保留，可稍后重试。');
      if (!response.ok) {
        const failure = response.headers.get('content-type')?.includes('application/json') ? await response.json().catch(()=>null) : null;
        throw Error(text(failure?.error, 500) || (response.status === 413 ? '服务暂时无法处理这张大图，请缩小图片后再试。' : '服务暂时未能完成处理，内容已保留，请重试。'));
      }
      if (response.headers.get('content-type')?.includes('application/x-ndjson')) return await readStream(response, requestId, strictRequestId);
      if (!response.headers.get('content-type')?.includes('application/json')) throw Error('批改服务尚未返回有效结果，请检查服务连接。');
      return await response.json();
    } catch (error) {
      if (error.name === 'AbortError') throw Error('等待时间较长，内容已保留。你可以重试这次操作。');
      if (error instanceof TypeError) throw Error('无法连接服务，请检查网络后重试。');
      throw error;
    } finally { clearTimeout(timer); }
  }
  const api = {
    async regions(task, requestId) {
      const raw=await request('/'+encodeURIComponent(task.remoteId)+'/regions',{},requestId);
      const ids=new Set(task.questions.map(q=>q.id));
      if(!Array.isArray(raw?.regions)||raw.regions.length!==ids.size||new Set(raw.regions.map(r=>r.id)).size!==ids.size||raw.regions.some(r=>!ids.has(r.id)))throw Error('题目定位未对应到原题，请重试。');
      return raw.regions.map(r=>({id:r.id,box:box(r.box)}));
    },
    async grade(file, note, requestId) { const data = new FormData(); data.append('image', file, file.name || 'homework.png'); data.append('note', note); return graded(await request('', data, requestId)); },
    async chat(task, q, message, requestId) {
      const raw = await request('/' + encodeURIComponent(task.remoteId) + '/tutor', { question: payload(q), message }, requestId);
      if (!text(raw?.text).trim() || typeof raw.help !== 'boolean') throw Error('辅导内容不完整，请重试。');
      return { text: text(raw.text), help: raw.help, title: text(raw.title, 200),
        suggestedQuestions: suggestedQuestions(raw, 'suggestedQuestions') };
    },
    async suggestions(task, q, requestId) {
      return suggestedQuestions(await request('/' + encodeURIComponent(task.remoteId) + '/suggestions', {question:payload(q)}, requestId));
    },
    async canvas(task, q, board, requestId) {
      const raw = await request('/' + encodeURIComponent(task.remoteId) + '/canvas', { question: payload(q), ...board }, requestId);
      if (!raw || !Array.isArray(raw.commands) || !raw.commands.length || raw.commands.length > 3 || typeof raw.help !== 'boolean') throw Error('画板回复不完整，请重试。');
      const commands = raw.commands.map(command => {
        if(command?.tool==='diagram')return canvasDiagram(command);
        if (!command || command.tool !== 'write_text' || !text(command.text, 1200).trim() ||
            !Number.isInteger(command.x) || !Number.isInteger(command.y) ||
            !Number.isInteger(command.fontSize) || !Number.isInteger(command.maxWidth) ||
            command.x<0||command.y<300||command.y>700||command.fontSize<20||command.fontSize>54||
            command.maxWidth<180||command.x+command.maxWidth>1200||typeof command.lineHeight !== 'number' ||
            !Number.isFinite(command.lineHeight)||command.lineHeight<1.2||command.lineHeight>1.8) throw Error('画板回复包含无法显示的内容，请重试。');
        return { tool:'write_text', x:command.x, y:command.y, text:text(command.text,1200),
          fontSize:command.fontSize, maxWidth:command.maxWidth, lineHeight:command.lineHeight };
      });
      return { intent:text(raw.intent,40), help:raw.help, commands };
    },
    async check(task, q, answer, requestId) {
      const raw = await request('/' + encodeURIComponent(task.remoteId) + '/check', {question: payload(q), answer}, requestId);
      if (!['correct', 'wrong', 'uncertain'].includes(raw?.status) || !text(raw.reason).trim()) throw Error('检查结果不完整，请重试。');
      return {status:raw.status, reason:text(raw.reason)};
    },
    async recognize(task, q, requestId) {
      const raw = await request('/' + encodeURIComponent(task.remoteId) + '/recognition', {question: payload(q)}, requestId);
      if (!statuses.includes(raw?.status) || !text(raw.reason).trim()) throw Error('重新批改的结果不完整，请重试。');
      return {status:raw.status, reason:text(raw.reason)};
    },
    async remember(task, q, requestId) {
      return memoryResult(await request('/' + encodeURIComponent(task.remoteId) + '/memory', {question:payload(q)}, requestId), q);
    },
    async recommendation(requestId) { return request('/api/recommendation', {}, requestId, false); },
    async createVerification(data, requestId) { return request('/api/verification', data, requestId); },
    async showVerification(id, requestId) { return request('/api/verification/' + encodeURIComponent(id) + '/shown', {}, requestId); },
    async checkVerification(id, data, requestId) { return request('/api/verification/' + encodeURIComponent(id) + '/check', data, requestId); }
  };
  let connection;
  function db() {
    if (!connection) connection = new Promise((resolve,reject) => {
      const opening = indexedDB.open('banxue-homework',1);
      opening.onupgradeneeded=()=>opening.result.createObjectStore('tasks',{keyPath:'id'});
      opening.onsuccess=()=>resolve(opening.result);
      opening.onerror=()=>reject(Error('此浏览器暂时无法保存学习记录。'));
      opening.onblocked=()=>reject(Error('另一个页面占用了学习记录，请关闭后重试。'));
    });
    return connection.catch(error=>{connection=null;throw error;});
  }
  async function transaction(mode,run) {
    const database=await db();
    return new Promise((resolve,reject)=>{
      const tx=database.transaction('tasks',mode),req=run(tx.objectStore('tasks'));
      tx.oncomplete=()=>resolve(req.result);
      tx.onerror=tx.onabort=()=>reject(Error('学习记录保存失败，请重试；当前页面的内容仍保留。'));
    });
  }
  const store={put:task=>transaction('readwrite',s=>s.put(task)),get:key=>transaction('readonly',s=>s.get(key)),list:()=>transaction('readonly',s=>s.getAll())};
  root.HomeworkService={id,box,question,graded,record,memoryResult,suggestedQuestions,canvasDiagram,payload,api,store,onProgress:listener=>{progressListeners.add(listener);return ()=>progressListeners.delete(listener);}};
})(typeof window === 'undefined' ? globalThis : window);
