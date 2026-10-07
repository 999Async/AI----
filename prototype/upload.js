/* Local image onboarding for the real model service. */
(function (root) {
  'use strict';
  const drafts = { single: fresh(), homework: fresh() };
  const MAX_BYTES = 10 * 1024 * 1024;
  let repaint = () => {};
  function fresh() { return { image: null, note: '', phase: 'empty', error: '', loading: false, request: 0 }; }
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const glyph = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${({photo:'M19 13V5H3v14h10 M3 15l5-5 5 5 3-3 3 3 M14 8h.01 M19 16v6 M16 19h6',upload:'M12 16V3 m-4 4 4-4 4 4 M4 15v6h16v-6',check:'m5 12 4 4L19 6',close:'m6 6 12 12 M18 6 6 18',arrow:'M4 12h15 m-6-6 6 6-6 6',info:'M12 11v6 M12 7v.1 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0'})[name]}"/></svg>`;
  const button = (label, action, kind, cls = '', disabled = false) => `<button type="button" id="upload-${action}-${kind}" class="btn ${cls}" data-upload-action="${action}" data-kind="${kind}" ${disabled ? 'disabled' : ''}>${label}</button>`;
  function emptyPicker(kind) {
    const d = drafts[kind];
    const framing=kind === 'single' ? '' : '<p class="upload-framing-tip">请拍全题目、答案和计算步骤。</p>';
    return `<div class="upload-empty">${glyph('photo','upload-photo-icon')}${button('选择图片 '+glyph('upload'),'choose',kind,'',d.loading)}<p>或拖动图片到这里</p><p class="upload-formats">JPG、PNG、WebP · 一次 1 张，最大 10 MB</p>${framing}</div>`;
  }
  function picker(kind) {
    const d = drafts[kind], single = kind === 'single';
    return `<div class="upload-dropzone ${d.image ? 'has-image' : ''} ${d.loading ? 'is-loading' : ''}" data-drop-kind="${kind}" aria-busy="${d.loading}">
      <input class="sr-only" type="file" id="image-${kind}" data-upload-kind="${kind}" accept="image/jpeg,image/png,image/webp" tabindex="-1" aria-label="选择${single ? '题目' : '作业'}图片">
      <div class="upload-picker-content">
        ${d.image ? `<div class="upload-preview"><img src="${d.image.url}" alt="你选择的${single ? '题目' : '作业'}图片"><div class="upload-file"><span title="${escape(d.image.name)}">${escape(d.image.name)}</span><span>${(d.image.size / 1024 / 1024).toFixed(1)} MB</span></div><div class="upload-image-actions">${button('重新选择','choose',kind,'secondary',d.loading)}${button('移除图片','remove',kind,'quiet',d.loading)}</div></div>` : emptyPicker(kind)}
      </div>
      ${single || !d.image ? '' : `<div class="upload-inline-form" aria-label="作业说明与确认">${controls(kind)}</div>`}
      ${d.loading ? '<div class="upload-loading" role="status"><span class="spinner"></span>正在读取图片…</div>' : ''}
    </div>${d.error ? `<p class="upload-error" role="alert">${glyph('info')}${escape(d.error)}</p>` : ''}`;
  }
  function tips() {
    return `<aside class="upload-guide" aria-label="题目拍摄指引"><h2>拍清楚这三处</h2><ol class="upload-tips"><li><span>1</span><div><h3>完整题干</h3><p>题目条件和问题都拍进来。</p></div></li><li><span>2</span><div><h3>图形与符号</h3><p>图形、标注和数学符号保持清楚。</p></div></li><li><span>3</span><div><h3>已有步骤</h3><p>如果已经动笔，把你的思路一起拍上。</p></div></li></ol><div class="framing-example"><p>拍摄示意</p><div class="framing-diagram" aria-label="完整页面应包含题干、图形和已有步骤"><div class="framing-paper" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span><span></span></div><div class="framing-labels"><span>完整题干</span><span>图形清楚</span><span>已有步骤</span></div></div></div></aside>`;
  }
  function noteField(kind) {
    const d = drafts[kind];
    return `<label class="upload-note-label" for="upload-note-${kind}">${kind === 'single' ? '你想问什么？' : '补充说明'}<span>选填</span></label><textarea class="input upload-note" id="upload-note-${kind}" data-upload-note="${kind}" maxlength="500" placeholder="${kind === 'single' ? '写下你的思路，或说说卡住的地方。' : '例如：请重点看看第 2 题的计算步骤。'}">${escape(d.note)}</textarea>${kind === 'single' ? '<p class="upload-field-hint">也可以开始后再说。</p>' : ''}`;
  }
  function controls(kind) {
    const d = drafts[kind], single = kind === 'single';
    return `${noteField(kind)}${single ? `<div class="upload-confirm-status">${glyph(d.image ? 'check' : 'photo')}<div><strong>${d.image ? '图片已就绪' : '图片尚未上传'}</strong><p>${d.image ? '确认题目清晰、完整，再继续。' : '请选择或拖入一张图片。'}</p></div></div>` : ''}${button(single ? '确认图片，开始答疑' : '确认图片，开始批改','confirm',kind,'upload-confirm',!d.image || d.loading)}`;
  }
  function view(kind) {
    const d = drafts[kind], single = kind === 'single';
    const secondary = single ? (d.image ? `<section class="upload-form" aria-label="题目确认">${controls(kind)}</section>` : tips()) : '';
    const history = single ? '' : (root.HomeworkFlow.historyHTML?.() || '');
    return `<main id="main" class="page-with-title upload-page ${single ? 'upload-single' : 'upload-homework'}"><div class="page-header"><div><h1 class="page-title" id="page-title" tabindex="-1">${single ? '题目答疑' : '作业批改'}</h1></div></div><div class="upload-layout"><section class="upload-image-column" aria-label="上传与预览">${picker(kind)}</section>${secondary}</div>${history}</main>`;
  }
  function finishSelection(kind) {
    const active = document.activeElement;
    const mayMoveFocus = !active || active === document.body || active.id === 'image-'+kind || active.id === 'upload-choose-'+kind;
    repaint();
    // A decode can finish after navigation or while a note is being edited.
    // Only advance focus when this upload route is still visible and idle.
    if (mayMoveFocus && document.getElementById('image-'+kind)) {
      document.getElementById(drafts[kind].error ? 'upload-choose-'+kind : 'upload-note-'+kind)?.focus({preventScroll:true});
    }
  }
  async function chooseFiles(kind, files) {
    const d = drafts[kind];
    if (!files?.length) return;
    // Every new selection invalidates any pending decode, including invalid files.
    const request = ++d.request;
    d.loading = false;
    if (files.length !== 1) { d.error = '请一次选择 1 张图片；已有图片不会被替换。'; finishSelection(kind); return; }
    const file = files[0];
    if (!['image/jpeg','image/png','image/webp'].includes(file.type)) { d.error = '暂不支持这种文件，请选择 JPG、PNG 或 WebP 图片。'; finishSelection(kind); return; }
    if (!file.size || file.size > MAX_BYTES) { d.error = file.size ? '图片超过 10 MB，请压缩后重新选择。' : '这张图片是空文件，请重新选择。'; finishSelection(kind); return; }
    const url = URL.createObjectURL(file);
    d.loading = true; d.error = ''; repaint();
    try {
      const image = new Image(); image.src = url;
      await image.decode();
      if (request !== d.request) { URL.revokeObjectURL(url); return; }
      if (!image.naturalWidth || image.naturalWidth * image.naturalHeight > 24000000) throw Error('dimensions');
      if (d.image) URL.revokeObjectURL(d.image.url);
      d.image = {url,name:file.name,size:file.size,file}; d.phase = 'preview';
    } catch (error) {
      URL.revokeObjectURL(url);
      if (request !== d.request) return;
      d.error = error.message === 'dimensions' ? '图片尺寸过大，请缩小至 2400 万像素以内再试。' : '图片无法打开，请换一张完整图片重试。';
    } finally {
      if (request === d.request) { d.loading = false; finishSelection(kind); }
    }
  }
  document.addEventListener('change', event => {
    const kind = event.target.dataset.uploadKind;
    if (drafts[kind]) { const files = [...event.target.files]; event.target.value = ''; chooseFiles(kind, files); }
  });
  document.addEventListener('input', event => {
    const kind = event.target.dataset.uploadNote;
    if (drafts[kind]) drafts[kind].note = event.target.value;
  });
  document.addEventListener('click', event => {
    const control = event.target.closest('[data-upload-action]');
    if (!control || control.disabled) return;
    const kind = control.dataset.kind, d = drafts[kind];
    if (!d) return;
    switch (control.dataset.uploadAction) {
      case 'choose': document.getElementById('image-'+kind)?.click(); return;
      case 'remove': if (d.image) URL.revokeObjectURL(d.image.url); d.image = null; d.error = ''; d.phase = 'empty'; d.request++; break;
      case 'confirm': if (!d.image || d.loading) return; root.HomeworkFlow.startUpload(d.image.file, d.note, kind); return;
      default: return;
    }
    repaint();
    const next = document.querySelector(control.dataset.uploadAction === 'remove' ? '[data-upload-action="choose"]' : '[data-upload-action="confirm"]');
    next?.focus({preventScroll:true});
  });
  for (const type of ['dragenter','dragover','dragleave','drop']) document.addEventListener(type, event => {
    const zone = event.target.closest?.('[data-drop-kind]');
    if (!zone) return;
    event.preventDefault();
    if (type === 'dragenter' || type === 'dragover') { zone.classList.add('is-dragging'); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; }
    if (type === 'dragleave' && !zone.contains(event.relatedTarget)) zone.classList.remove('is-dragging');
    if (type === 'drop') { zone.classList.remove('is-dragging'); chooseFiles(zone.dataset.dropKind, [...event.dataTransfer.files]); }
  });
  root.BanxueUpload = {view, init: render => { repaint = render; }, restore: (kind,file,note) => {
    const d=drafts[kind]; if(!d||!file)return;
    d.request++; if(d.image)URL.revokeObjectURL(d.image.url);
    Object.assign(d,{image:{file,url:URL.createObjectURL(file),name:file.name||'作业图片',size:file.size},note:note||'',phase:'preview',error:'',loading:false});
  }, reset: () => { for (const kind of Object.keys(drafts)) { const d = drafts[kind]; d.request++; if (d.image) URL.revokeObjectURL(d.image.url); Object.assign(d, fresh(), {request:d.request}); } }};
})(window);
