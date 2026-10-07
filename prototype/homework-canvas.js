/*
 * PROTOTYPE — per-question canvas spike.
 *
 * Question: can Banxue preserve the chain “question seed -> student ink ->
 * model reply on canvas -> save and restore” without rebuilding PenEcho's
 * drawing protocol? Student strokes use PenEcho's open-source draw-command
 * contract; verified AI teaching diagrams use deterministic Banxue templates.
 */
(function (root) {
  'use strict';

  const DRAW = root.PENECHO_DRAW;
  const WIDTH = 1200;
  const HEIGHT = 760;
  const PREFERRED_DISPLAY_SCALE = .78;
  const MAX_QUESTION_CARD_CSS_WIDTH = 920;
  const VERSION = 1;
  let active = null;
  let resizeObserver = null;
  let resizeHandler = null;
  let resizeFrame = null;

  function ensure(question) {
    const value = question.canvas;
    if (!value || value.version !== VERSION) {
      question.canvas = {
        version: VERSION,
        width: WIDTH,
        height: HEIGHT,
        strokes: [],
        aiItems: [],
        drafts: [],
        latestInput: null,
        updatedAt: null
      };
    }
    const state = question.canvas;
    state.strokes = Array.isArray(state.strokes) ? state.strokes : [];
    state.aiItems = Array.isArray(state.aiItems) ? state.aiItems : [];
    state.drafts = Array.isArray(state.drafts) ? state.drafts : [];
    state.focus = state.focus === true;
    return state;
  }

  function focusIcon(expanded) {
    const path = expanded
      ? 'M9 4v5H4 M15 4v5h5 M9 20v-5H4 M15 20v-5h5'
      : 'M9 4H4v5 M15 4h5v5 M9 20H4v-5 M15 20h5v-5';
    return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
  }

  function view(question, busy, focus = false) {
    const state = ensure(question);
    const heading = focus
      ? `<div class="hw-canvas-focus-heading"><div><h1 id="page-title" tabindex="-1">第 ${question.number || ''} 题画板</h1><p>在题目下方继续书写，按 Esc 退出</p></div><button type="button" class="btn secondary" data-hw="canvas-focus-exit">${focusIcon(true)}退出全屏</button></div>`
      : `<div class="hw-canvas-intro"><strong>写下你的思路吧</strong><button type="button" class="text-button hw-canvas-focus-button" data-hw="canvas-focus-enter">${focusIcon(false)}全屏书写</button></div>`;
    return `<section class="hw-canvas${focus ? ' hw-canvas-focus' : ''}" aria-label="本题画板">
      ${heading}
      <div class="hw-canvas-stage">
        <canvas id="hw-question-canvas" width="${WIDTH}" height="${HEIGHT}" aria-label="可以用鼠标或手写笔书写的题目画板"></canvas>
      </div>
      <div class="hw-canvas-toolbar" aria-label="画板操作">
        <div>
          <button type="button" class="text-button" data-canvas="undo" ${state.strokes.length ? '' : 'disabled'}>撤销一笔</button>
          <button type="button" class="text-button" data-canvas="clear" ${state.strokes.length ? '' : 'disabled'}>清除我的笔迹</button>
        </div>
        <button type="button" class="btn" data-hw="canvas-send" ${busy || !state.strokes.length ? 'disabled' : ''}>${busy ? '正在看画板…' : '让伴学看看'}</button>
      </div>
      ${state.drafts.length ? `<div class="hw-canvas-draft-actions" role="status"><span>伴学已用文字或教学图回复，确认后保存。</span><div><button type="button" class="btn secondary" data-canvas="reject">丢弃回复</button><button type="button" class="btn" data-canvas="accept">保留到画板</button></div></div>` : ''}
    </section>`;
  }

  function canvasFactory(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  function wrappedLines(context, text, maxWidth, maxLines = 8) {
    const paragraphs = String(text ?? '').replace(/\r/g, '').split('\n');
    const lines = [];
    for (const paragraph of paragraphs) {
      if (!paragraph) {
        lines.push('');
        continue;
      }
      let line = '';
      for (const character of paragraph) {
        const candidate = line + character;
        if (line && context.measureText(candidate).width > maxWidth) {
          lines.push(line);
          line = character;
        } else line = candidate;
        if (lines.length >= maxLines) break;
      }
      if (lines.length >= maxLines) break;
      if (line) lines.push(line);
    }
    if (lines.length > maxLines) lines.length = maxLines;
    return lines;
  }

  function hasChoiceOptions(text) {
    const labels = [...String(text ?? '').matchAll(/(?:^|[\s;；。！？])([A-H])\s*[.．、]/g)].map(match => match[1]);
    return new Set(labels).size >= 2;
  }

  function displayQuestion(question) {
    const text = String(question.text ?? '').replace(/\r/g, '').trim();
    const options = text.replace(/\s*(?:[;；]\s*)?([A-H])\s*[.．、]\s*/g,
      (match, label, offset) => `${offset ? '\n' : ''}${label}. `);
    const formula = hasChoiceOptions(text) ? '' : String(question.formula ?? '').trim();
    return [options, formula].filter(Boolean).join('\n');
  }

  function normalizedDisplayScale(scale) {
    const value = Number(scale);
    return Number.isFinite(value) && value > 0 ? Math.max(.35, Math.min(1.4, value)) : PREFERRED_DISPLAY_SCALE;
  }

  function canvasDisplayScale(canvas) {
    const width = canvas?.getBoundingClientRect?.().width;
    return normalizedDisplayScale(width ? width / WIDTH : PREFERRED_DISPLAY_SCALE);
  }

  function questionLayout(context, question, displayScale = PREFERRED_DISPLAY_SCALE) {
    const scale = normalizedDisplayScale(displayScale);
    const visualFactor = Math.max(.72, Math.min(1.4, PREFERRED_DISPLAY_SCALE / scale));
    const content = displayQuestion(question);
    const cardWidth = Math.min(WIDTH - 88, Math.round(MAX_QUESTION_CARD_CSS_WIDTH / scale));
    const cardX = Math.round((WIDTH - cardWidth) / 2);
    const horizontalPadding = Math.round(34 * visualFactor);
    const maxWidth = cardWidth - horizontalPadding * 2;
    const cardTop = Math.round(38 * visualFactor);
    const labelY = Math.round(82 * visualFactor);
    const textY = Math.round(130 * visualFactor);
    const sizes = [34, 30, 26, 22].map(size => Math.round(size * visualFactor));
    const maximumBaseline = Math.round(458 * visualFactor);
    let fontSize = sizes.at(-1), lineHeight = 30, lines = [];
    for (const size of sizes) {
      const step = Math.round(size * 1.28);
      const capacity = Math.floor((maximumBaseline - textY) / step) + 1;
      context.font = `500 ${size}px system-ui, sans-serif`;
      const candidate = wrappedLines(context, content, maxWidth, 100);
      fontSize = size;lineHeight = step;lines = candidate;
      if (candidate.length <= capacity) break;
    }
    const capacity = Math.floor((maximumBaseline - textY) / lineHeight) + 1;
    if (lines.length > capacity) {
      lines = lines.slice(0, capacity);
      const last = lines.length - 1;
      while (lines[last] && context.measureText(lines[last] + '…').width > maxWidth) lines[last] = lines[last].slice(0, -1);
      lines[last] += '…';
    }
    const cardHeight = Math.max(
      Math.round(190 * visualFactor),
      Math.round(124 * visualFactor) + Math.max(0, lines.length - 1) * lineHeight
    );
    const cardBottom = cardTop + cardHeight;
    const dividerY = cardBottom + Math.round(42 * visualFactor);
    return {
      content,lines,fontSize,lineHeight,cardHeight,cardBottom,dividerY,
      scale,visualFactor,cardX,cardWidth,cardTop,labelY,textY,horizontalPadding,maxWidth,
      writingLabelY:dividerY + Math.round(40 * visualFactor)
    };
  }

  function drawQuestion(context, question, displayScale) {
    const layout = questionLayout(context, question, displayScale);
    const contentX = layout.cardX + layout.horizontalPadding;
    context.save();
    context.fillStyle = '#fbfafc';
    context.fillRect(0, 0, WIDTH, HEIGHT);
    context.fillStyle = '#ffffff';
    context.strokeStyle = '#d8d5df';
    context.lineWidth = 2;
    context.beginPath();
    context.roundRect(layout.cardX, layout.cardTop, layout.cardWidth, layout.cardHeight, Math.round(22 * layout.visualFactor));
    context.fill();
    context.stroke();
    context.fillStyle = '#78678f';
    context.font = `600 ${Math.round(22 * layout.visualFactor)}px system-ui, sans-serif`;
    context.fillText('当前题目', contentX, layout.labelY);
    context.fillStyle = '#292b36';
    context.font = `500 ${layout.fontSize}px system-ui, sans-serif`;
    layout.lines.forEach((line, index) => context.fillText(line, contentX, layout.textY + index * layout.lineHeight));
    context.strokeStyle = '#e2dfea';
    context.setLineDash([8, 10]);
    context.beginPath();
    context.moveTo(54, layout.dividerY);
    context.lineTo(WIDTH - 54, layout.dividerY);
    context.stroke();
    context.setLineDash([]);
    context.fillStyle = '#8a8792';
    context.font = `400 ${Math.round(20 * layout.visualFactor)}px system-ui, sans-serif`;
    context.fillText('从这里继续你的思路', 64, layout.writingLabelY);
    context.restore();
    return layout;
  }

  function drawStroke(context, command, color) {
    if (!DRAW) return;
    const rendered = DRAW.render(command, canvasFactory, color);
    if (rendered) context.drawImage(rendered.image, rendered.x, rendered.y, rendered.image.logicalWidth, rendered.image.logicalHeight);
  }

  function textMetrics(context, command) {
    const fontSize = Math.max(20, Math.min(54, command.fontSize || 30));
    const maxWidth = Math.max(180, Math.min(WIDTH - 80, command.maxWidth || 620));
    context.font = `600 ${fontSize}px system-ui, sans-serif`;
    const lines = wrappedLines(context, command.text, maxWidth - 44, 7);
    const lineHeight = fontSize * Math.max(1.2, Math.min(1.8, command.lineHeight || 1.4));
    return { fontSize, maxWidth, lines, lineHeight, height: Math.max(82, lines.length * lineHeight + 48) };
  }

  function drawAIText(context, command, draft, minimumY = 300) {
    context.save();
    const x = Math.max(30, Math.min(WIDTH - 230, Number(command.x) || 80));
    const y = Math.max(minimumY, Math.min(HEIGHT - 100, Number(command.y) || 390));
    const metrics = textMetrics(context, command);
    const width = Math.min(metrics.maxWidth, WIDTH - x - 30);
    const height = Math.min(metrics.height, HEIGHT - y - 24);
    context.fillStyle = draft ? 'rgba(240,235,249,.96)' : 'rgba(238,246,241,.97)';
    context.strokeStyle = draft ? '#8067a5' : '#769985';
    context.lineWidth = draft ? 3 : 2;
    context.setLineDash(draft ? [10, 8] : []);
    context.beginPath();
    context.roundRect(x, y, width, height, 18);
    context.fill();
    context.stroke();
    context.setLineDash([]);
    context.fillStyle = draft ? '#5b457d' : '#315b45';
    context.font = `600 ${metrics.fontSize}px system-ui, sans-serif`;
    metrics.lines.forEach((line, index) => context.fillText(line, x + 22, y + 34 + metrics.fontSize + index * metrics.lineHeight, width - 44));
    context.restore();
  }

  function drawAIVector(context, command, draft) {
    if (!DRAW) return;
    const rendered = DRAW.render(command, canvasFactory, draft ? '#6f51a0' : '#3f775a');
    if (!rendered) return;
    context.save();
    context.globalAlpha = draft ? 0.78 : 0.96;
    if (draft) {
      context.shadowColor = 'rgba(111,81,160,.2)';
      context.shadowBlur = 8;
    }
    context.drawImage(rendered.image, rendered.x, rendered.y, rendered.image.logicalWidth, rendered.image.logicalHeight);
    context.restore();
  }

  function diagramGeometry(command) {
    if (command?.tool !== 'diagram' || command.kind !== 'rectangle_about_side') return null;
    const x = Number(command.x), y = Number(command.y), width = Number(command.width), height = Number(command.height);
    if (![x,y,width,height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
    const source = {
      x: Math.round(x + width * .08),
      y: Math.round(y + height * .27),
      w: Math.round(width * .18),
      h: Math.round(height * .47)
    };
    const result = {
      cx: Math.round(x + width * .79),
      rx: Math.round(width * .145),
      ry: Math.round(Math.max(12, Math.min(28, height * .08))),
      topY: Math.round(y + height * .28),
      bottomY: Math.round(y + height * .72)
    };
    result.leftSide = [result.cx - result.rx, result.topY, result.cx - result.rx, result.bottomY];
    result.rightSide = [result.cx + result.rx, result.topY, result.cx + result.rx, result.bottomY];
    return {
      source,
      axis: [source.x, source.y - 18, source.x, source.y + source.h + 18],
      rotation: {
        centerX: Math.round(source.x + source.w * .08),
        centerY: Math.round(source.y + source.h * .5),
        rx: Math.round(source.w * .72),
        ry: Math.round(source.h * .62),
        start: Math.PI * .38,
        end: Math.PI * 1.62
      },
      transition: {
        startX: Math.round(source.x + source.w + width * .055),
        endX: Math.round(result.cx - result.rx - width * .055),
        y: Math.round(y + height * .5)
      },
      result
    };
  }

  function arrowHead(context, x, y, angle, size) {
    context.beginPath();
    context.moveTo(x, y);
    context.lineTo(x - size * Math.cos(angle - Math.PI / 6), y - size * Math.sin(angle - Math.PI / 6));
    context.lineTo(x - size * Math.cos(angle + Math.PI / 6), y - size * Math.sin(angle + Math.PI / 6));
    context.closePath();
    context.fill();
  }

  function drawAIDiagram(context, command, draft) {
    const geometry = diagramGeometry(command);
    if (!geometry) return;
    const {source, axis, rotation, transition, result} = geometry;
    const color = draft ? '#6f51a0' : '#3f775a';
    const pale = draft ? 'rgba(111,81,160,.10)' : 'rgba(63,119,90,.10)';
    const fontSize = Math.max(18, Math.min(24, Math.round(command.height * .075)));
    context.save();
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = Math.max(4, Math.min(8, command.width / 145));
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.globalAlpha = draft ? .82 : .98;
    if (draft) {
      context.shadowColor = 'rgba(111,81,160,.18)';
      context.shadowBlur = 7;
    }

    context.fillStyle = pale;
    context.fillRect(source.x, source.y, source.w, source.h);
    context.strokeStyle = color;
    context.strokeRect(source.x, source.y, source.w, source.h);

    context.lineWidth += 2;
    context.beginPath();
    context.moveTo(...axis.slice(0, 2));
    context.lineTo(...axis.slice(2));
    context.stroke();
    context.lineWidth -= 2;

    context.beginPath();
    context.ellipse(rotation.centerX, rotation.centerY, rotation.rx, rotation.ry, 0, rotation.start, rotation.end);
    context.stroke();
    const rotationEndX = rotation.centerX + rotation.rx * Math.cos(rotation.end);
    const rotationEndY = rotation.centerY + rotation.ry * Math.sin(rotation.end);
    const tangentAngle = Math.atan2(rotation.ry * Math.cos(rotation.end), -rotation.rx * Math.sin(rotation.end));
    context.fillStyle = color;
    arrowHead(context, rotationEndX, rotationEndY, tangentAngle, 16);

    context.beginPath();
    context.moveTo(transition.startX, transition.y);
    context.lineTo(transition.endX, transition.y);
    context.stroke();
    arrowHead(context, transition.endX, transition.y, 0, 16);

    context.fillStyle = pale;
    context.beginPath();
    context.ellipse(result.cx, result.topY, result.rx, result.ry, 0, 0, Math.PI * 2);
    context.fill();
    context.beginPath();
    context.moveTo(...result.leftSide.slice(0, 2));
    context.lineTo(...result.leftSide.slice(2));
    context.moveTo(...result.rightSide.slice(0, 2));
    context.lineTo(...result.rightSide.slice(2));
    context.stroke();
    context.beginPath();
    context.ellipse(result.cx, result.topY, result.rx, result.ry, 0, 0, Math.PI * 2);
    context.stroke();
    context.beginPath();
    context.ellipse(result.cx, result.bottomY, result.rx, result.ry, 0, 0, Math.PI * 2);
    context.stroke();

    context.shadowBlur = 0;
    context.fillStyle = color;
    context.font = `600 ${fontSize}px system-ui, sans-serif`;
    context.textAlign = 'center';
    context.fillText('长方形', source.x + source.w / 2, source.y - 28);
    context.fillText('绕这条边旋转一周', rotation.centerX, Math.min(command.y + command.height - 12, source.y + source.h + 52));
    context.fillText('圆柱', result.cx, Math.min(command.y + command.height - 12, result.bottomY + result.ry + 34));
    context.textAlign = 'left';
    context.font = `500 ${Math.max(16, fontSize - 3)}px system-ui, sans-serif`;
    context.fillText('旋转轴', axis[0] - 28, axis[1] - 10);
    context.restore();
  }

  function drawAIItem(context, command, draft, minimumY) {
    if (command?.tool === 'diagram') drawAIDiagram(context, command, draft);
    else if (command?.tool === 'draw') drawAIVector(context, command, draft);
    else if (command?.tool === 'write_text') drawAIText(context, command, draft, minimumY);
  }

  function render(canvas, question, liveCommand = null) {
    const state = ensure(question);
    const context = canvas.getContext('2d');
    const questionSeed = drawQuestion(context, question, canvasDisplayScale(canvas));
    state.strokes.forEach(command => drawStroke(context, command, '#34313a'));
    if (liveCommand) drawStroke(context, liveCommand, '#34313a');
    state.aiItems.forEach(command => drawAIItem(context, command, false, questionSeed.writingLabelY + 24));
    state.drafts.forEach(command => drawAIItem(context, command, true, questionSeed.writingLabelY + 24));
  }

  function pointFor(canvas, event) {
    const bounds = canvas.getBoundingClientRect();
    return {
      x: Math.round((event.clientX - bounds.left) * WIDTH / bounds.width),
      y: Math.round((event.clientY - bounds.top) * HEIGHT / bounds.height),
      pressure: event.pressure > 0 ? event.pressure : 0.5
    };
  }

  function commandFrom(points) {
    if (!DRAW || !points.length) return null;
    if (points.length === 1) points.push({ ...points[0], x: points[0].x + 1 });
    const values = points.flatMap(point => [point.x, point.y]);
    const averagePressure = points.reduce((sum, point) => sum + point.pressure, 0) / points.length;
    const command = { tool: 'draw', origin: [0, 0], types: ['smooth'], items: [values], closed: [], fill: [], arrows: [], width: Math.round(5 + averagePressure * 5), tension: 50 };
    const normalized = DRAW.normalize(command, WIDTH);
    if (!normalized || normalized._draw.bounds.bottom > HEIGHT) return null;
    return command;
  }

  function markChanged(state) {
    state.updatedAt = new Date().toISOString();
  }

  function mount(container, question, onChange) {
    resizeObserver?.disconnect();
    resizeObserver = null;
    if (resizeHandler && root.removeEventListener) root.removeEventListener('resize', resizeHandler);
    if (resizeFrame && root.cancelAnimationFrame) root.cancelAnimationFrame(resizeFrame);
    resizeHandler = null;
    resizeFrame = null;
    const canvas = container?.querySelector('#hw-question-canvas');
    if (!canvas) {
      active = null;
      return;
    }
    const state = ensure(question);
    active = { canvas, question };
    render(canvas, question);
    const renderAfterResize = () => {
      if (resizeFrame && root.cancelAnimationFrame) root.cancelAnimationFrame(resizeFrame);
      if (root.requestAnimationFrame) {
        resizeFrame = root.requestAnimationFrame(() => {
          resizeFrame = null;
          if (active?.canvas === canvas) render(canvas, question);
        });
      } else if (active?.canvas === canvas) render(canvas, question);
    };
    if (root.addEventListener) {
      resizeHandler = renderAfterResize;
      root.addEventListener('resize', resizeHandler);
    }
    if (root.ResizeObserver) {
      let previousWidth = canvas.getBoundingClientRect().width;
      resizeObserver = new root.ResizeObserver(entries => {
        const width = entries[0]?.contentRect?.width;
        if (!Number.isFinite(width) || Math.abs(width - previousWidth) < 1) return;
        previousWidth = width;
        renderAfterResize();
      });
      resizeObserver.observe(canvas);
    }
    let points = null;

    canvas.addEventListener('pointerdown', event => {
      if (event.button !== 0 || state.drafts.length) return;
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      points = [pointFor(canvas, event)];
    });
    canvas.addEventListener('pointermove', event => {
      if (!points || !canvas.hasPointerCapture(event.pointerId)) return;
      event.preventDefault();
      const events = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [event];
      for (const sample of events) {
        const point = pointFor(canvas, sample);
        const previous = points.at(-1);
        if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) >= 2) points.push(point);
      }
      render(canvas, question, commandFrom([...points]));
    });
    const finish = event => {
      if (!points) return;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      const command = commandFrom(points);
      points = null;
      if (!command) return render(canvas, question);
      const normalized = DRAW.normalize(command, WIDTH);
      state.strokes.push(command);
      state.latestInput = { x: normalized.x, y: normalized.y, w: normalized._draw.bounds.w, h: normalized._draw.bounds.h };
      markChanged(state);
      render(canvas, question);
      onChange(true);
    };
    canvas.addEventListener('pointerup', finish);
    canvas.addEventListener('pointercancel', () => { points = null; render(canvas, question); });

    container.querySelectorAll('[data-canvas]').forEach(button => button.addEventListener('click', () => {
      if (button.dataset.canvas === 'undo') {
        state.strokes.pop();
        const normalized = state.strokes.length ? DRAW.normalize(state.strokes.at(-1), WIDTH) : null;
        state.latestInput = normalized ? { x: normalized.x, y: normalized.y, w: normalized._draw.bounds.w, h: normalized._draw.bounds.h } : null;
      }
      else if (button.dataset.canvas === 'clear') { state.strokes = []; state.latestInput = null; }
      else if (button.dataset.canvas === 'accept') {
        state.aiItems.push(...state.drafts);
        state.drafts = [];
      } else if (button.dataset.canvas === 'reject') state.drafts = [];
      markChanged(state);
      onChange(true);
    }));
  }

  function capture(question) {
    if (!active || active.question !== question) return null;
    render(active.canvas, question);
    const state = ensure(question);
    const layout = questionLayout(active.canvas.getContext('2d'), question, canvasDisplayScale(active.canvas));
    return {
      canvasImage: active.canvas.toDataURL('image/png'),
      canvasWidth: WIDTH,
      canvasHeight: HEIGHT,
      replyMinY: Math.min(700, layout.writingLabelY + 24),
      latestInput: state.latestInput,
      strokeCount: state.strokes.length
    };
  }

  function applyResponse(question, response) {
    const state = ensure(question);
    state.drafts = response.commands.map(command => ({ ...command }));
    markChanged(state);
  }

  root.HomeworkCanvas = { ensure, view, mount, capture, applyResponse, questionLayout, diagramGeometry, drawAIDiagram, width: WIDTH, height: HEIGHT };
})(window);
