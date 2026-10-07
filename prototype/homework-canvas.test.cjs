const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {test}=require('node:test');

function setup(){
  const context=vm.createContext({document:{createElement:()=>({})},PENECHO_DRAW:null});
  context.window=context;
  vm.runInContext(fs.readFileSync(__dirname+'/homework-canvas.js','utf8'),context);
  const drawing={font:'',measureText:text=>({width:[...String(text)].reduce((sum,char)=>sum+(char.charCodeAt(0)>255?28:17),0)})};
  return {canvas:context.HomeworkCanvas,drawing};
}

test('short questions keep the compact seed area',()=>{
  const {canvas,drawing}=setup();
  const layout=canvas.questionLayout(drawing,{text:'计算 2+3',formula:''});
  assert.equal(layout.cardHeight,190);
  assert.equal(layout.dividerY,270);
});

test('question seed keeps a stable visual size from inline to fullscreen',()=>{
  const {canvas,drawing}=setup();
  const question={
    text:'3. 如图，将平面图形绕轴旋转一周，得到的几何体是（）。A. 柱体；B. 棱锥；C. 圆锥；D. 圆柱',
    formula:''
  };
  const inlineScale=.68;
  const fullscreenScale=1;
  const inline=canvas.questionLayout(drawing,question,inlineScale);
  const fullscreen=canvas.questionLayout(drawing,question,fullscreenScale);

  assert.ok(Math.abs(inline.fontSize*inlineScale-fullscreen.fontSize*fullscreenScale)<=3);
  assert.ok(fullscreen.cardWidth*fullscreenScale<=940);
  assert.ok(fullscreen.cardHeight*fullscreenScale<=inline.cardHeight*inlineScale*1.25);
});

test('canvas header keeps only the student prompt',()=>{
  const {canvas}=setup();
  const html=canvas.view({},false);
  assert.match(html,/<div class="hw-canvas-intro">[\s\S]*<strong>写下你的思路吧<\/strong>/);
  assert.match(html,/data-hw="canvas-focus-enter"/);
  assert.doesNotMatch(html,/模型只在你主动发送后查看画板|题目已放入画板|画板内容已保存/);
});

test('focused canvas is a dedicated workspace with an explicit exit',()=>{
  const {canvas}=setup();
  const html=canvas.view({number:3},false,true);
  assert.match(html,/class="hw-canvas hw-canvas-focus"/);
  assert.match(html,/<h1[^>]*>第 3 题画板<\/h1>/);
  assert.match(html,/data-hw="canvas-focus-exit"/);
  assert.match(html,/按 Esc 退出/);
  assert.doesNotMatch(html,/data-hw="canvas-focus-enter"/);
});

test('long multiple-choice questions put each option on a new line and grow the card',()=>{
  const {canvas,drawing}=setup();
  const layout=canvas.questionLayout(drawing,{
    text:'4. 下列说法正确的是（）。A. 单项式ab²的次数是2；B. 单项式ab²的系数为0；C. 多项式b²−abc的次数是2；D. 多项式b²−abc的二次项系数是1',
    formula:'ab²的次数为3；b²−abc的二次项系数为1'
  });
  const starts=layout.lines.filter(line=>/^[A-D]\. /.test(line)).map(line=>line.slice(0,1));
  assert.equal(starts.join(','),'A,B,C,D');
  assert.doesNotMatch(layout.content,/ab²的次数为3/);
  assert.ok(layout.cardHeight>190);
  assert.ok(layout.dividerY>270);
  assert.ok(layout.writingLabelY>layout.cardBottom);
});

test('a standalone formula remains visible for a non-choice question',()=>{
  const {canvas,drawing}=setup();
  const layout=canvas.questionLayout(drawing,{text:'化简下列式子',formula:'2(x−3)+4'});
  assert.match(layout.content,/2\(x−3\)\+4/);
});

test('rectangle rotation diagram deterministically closes the cylinder and ties arrows to meaning',()=>{
  const {canvas}=setup();
  const geometry=canvas.diagramGeometry({tool:'diagram',kind:'rectangle_about_side',x:40,y:380,width:1120,height:340});
  assert.deepEqual(Array.from(geometry.axis),[geometry.source.x,geometry.source.y-18,geometry.source.x,geometry.source.y+geometry.source.h+18]);
  assert.deepEqual(Array.from(geometry.result.leftSide),[geometry.result.cx-geometry.result.rx,geometry.result.topY,geometry.result.cx-geometry.result.rx,geometry.result.bottomY]);
  assert.deepEqual(Array.from(geometry.result.rightSide),[geometry.result.cx+geometry.result.rx,geometry.result.topY,geometry.result.cx+geometry.result.rx,geometry.result.bottomY]);
  assert.ok(geometry.rotation.centerX<geometry.source.x+geometry.source.w);
  assert.ok(geometry.transition.endX<geometry.result.cx-geometry.result.rx);
});
