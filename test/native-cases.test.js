'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { native, tick, editor, items, decorations } = require('./native-fixture');
let sequence = 0;
async function fixture(t, execute = () => {}) {
  const api = await native, key = 'case-' + ++sequence, uri = 'file:///' + key + '.txt', ed = editor(uri);
  api.update(ed, key, decorations(items('one')), execute);
  t.after(() => api.clear(key));
  return { api, ed, key, uri, state: () => api.inspect(uri)[0], update: data => api.update(ed, key, decorations(data), execute), buttons: ed.widget.getDomNode().children[0].children };
}

test('[regression] refresh preserves an in-flight decision lock', async t => {
  const calls = [], completions = [];
  t.after(() => { for (const done of completions) done(); });
  const f = await fixture(t, (...args) => { calls.push(args); return new Promise(resolve => completions.push(resolve)); });
  f.buttons[4].click(); await tick(); f.update(items('one'));
  assert.equal(f.state().busy, true, 'Refresh must not unlock an unfinished command');
  f.buttons[4].click(); await tick(); assert.equal(calls.length, 1);
});
test('[regression] refresh preserves the latest pointer target', async t => {
  const f = await fixture(t);
  f.ed.emit('onMouseMove', { target: { position: { lineNumber: 10 }, element: null } });
  f.update(items('one'));
  assert.equal(f.state().current.arg.hunk, 'one:1', 'Unchanged data must not move controls back to the text cursor');
});
test('[regression] stale refresh cannot re-enable controls invalidated by typing', async t => {
  const f = await fixture(t);
  f.ed.emit('onDidChangeModelContent'); f.update(items('one'));
  assert.equal(f.state().invalidated, true, 'The same revision does not prove the changed buffer was refreshed');
  assert.equal(f.state().visible, false);
});
test('[regression] controls stay visible when the selected change is taller than the viewport', async t => {
  const f = await fixture(t); f.update([{ ...items('large')[0], end: 50 }]);
  assert.equal(f.state().visible, true, 'An automatically selected large change needs accessible buttons');
});
test('[regression] controls remain reachable in the middle of a tall change', async t => {
  const f = await fixture(t); f.ed.line = 42; f.ed.scroll = 600;
  f.ed.getVisibleRanges = () => [{ startLineNumber: 31, endLineNumber: 50 }];
  f.update([{ ...items('middle')[0], end: 80 }]);
  assert.equal(f.state().visible, true, 'Visible changes retain controls when both boundaries are off screen');
  assert.ok(f.state().position.preference.top >= 0 && f.state().position.preference.top <= 378);
});
test('[regression] wrapped paragraphs retain controls while scrolled through the same logical line', async t => {
  const f = await fixture(t); f.ed.scroll = 100;
  f.ed.getVisibleRanges = () => [{ startLineNumber: 2, endLineNumber: 2 }];
  f.update(items('wrapped').slice(0, 1));
  assert.equal(f.state().visible, true, 'A wrapped logical line may remain visible after its first visual row scrolls out');
});

for (const [name, position, visible] of [['start',2,true], ['last-change',10,true], ['anchor',3,true], ['unchanged',6,false], ['before',1,false], ['after',50,false]]) {
  test('native pointer target: ' + name, async t => {
    const f = await fixture(t); f.ed.emit('onMouseMove', { target: { position: { lineNumber: position }, element: null } });
    assert.equal(f.state().visible, visible);
  });
}
for (const [name, scroll, visible, top] of [['initial',0,true,40], ['partially-scrolled',20,true,20], ['above-screen',100,false], ['below-screen',-500,false]]) {
  test('native viewport: ' + name, async t => {
    const f = await fixture(t); f.ed.scroll = scroll; f.ed.emit('onDidScrollChange');
    assert.equal(f.state().visible, visible); if (visible) assert.equal(f.state().position.preference.top,top);
  });
}
test('moving through a widget child preserves the displayed target', async t => {
  const f = await fixture(t); f.ed.emit('onMouseMove', { target: { position: { lineNumber:10 }, element:null } });
  f.ed.emit('onMouseMove', { target: { position: { lineNumber:2 }, element:f.buttons[4].children[0] } });
  assert.equal(f.state().current.arg.hunk,'one:1');
});
test('leaving the editor restores the text-cursor target', async t => {
  const f = await fixture(t); f.ed.emit('onMouseMove', { target: { position: { lineNumber:10 }, element:null } });
  f.ed.emit('onMouseLeave'); assert.equal(f.state().current.arg.hunk,'one:0');
});
for (const [name,index,target] of [['previous-wraps',0,'one:1'],['next',2,'one:1']]) {
  test('native navigation: '+name, async t => {
    const calls = [], f = await fixture(t,(...args)=>calls.push(args));
    f.buttons[index].click(); await tick(); assert.equal(calls.length,1);
    assert.equal(calls[0][0],'changeReview.show'); assert.equal(calls[0][1].hunk,target);
  });
}
test('one remaining change hides its counter and navigation', async t => {
  const f = await fixture(t); f.update(items('single').slice(0,1));
  for (const index of [0,1,2]) assert.equal(f.buttons[index].style.display,'none');
});
test('[regression] long lines retain readable action labels and shortcut hints', async t => {
  const f = await fixture(t); f.ed.getOffsetForColumn=()=>1000; f.ed.emit('onDidLayoutChange');
  for (const index of [3,4]) { assert.notEqual(f.buttons[index].reviewLabel.style.display,'none'); assert.equal(f.buttons[index].children.length,2); }
});
test('command failure releases the lock and retains a diagnostic', async t => {
  const f = await fixture(t,()=>Promise.reject(new Error('test failure')));
  f.buttons[4].click(); await tick(); assert.equal(f.state().busy,false); assert.equal(f.state().lastError,'test failure');
});
for (const event of ['onDidChangeModel','onDidDispose']) {
  test('native cleanup: '+event, async t => {
    const calls=[],f=await fixture(t,(...args)=>calls.push(args)), old=f.buttons[4];
    f.ed.emit(event); old.click(); await tick();
    assert.deepEqual(f.api.inspect(f.uri),[]); assert.equal(calls.length,0);
    assert.ok([...f.ed.listeners.values()].every(listeners=>listeners.size===0));
  });
}
test('clearing another decoration key leaves native controls intact', async t => {
  const f=await fixture(t); assert.equal(f.api.update(f.ed,'other',[],()=>{}),false); assert.equal(f.state().visible,true);
});
test('replacing a decoration key disposes previous buttons', async t => {
  const calls=[],f=await fixture(t,(...args)=>calls.push(args)),old=f.buttons[4],next=f.key+'-next';
  t.after(()=>f.api.clear(next));f.api.update(f.ed,next,decorations(items('new')),()=>{});
  old.click(); await tick(); assert.equal(calls.length,0); assert.equal(f.api.inspect(f.uri).length,1);
});
test('native action rejects unsupported actions and stale revisions', async t => {
  const f=await fixture(t); assert.throws(()=>f.api.act(f.uri,'delete',items('one')[0].arg),/Unknown/);
  assert.throws(()=>f.api.act(f.uri,'reject',items('stale')[0].arg),/changed/);
});
test('native transport accepts array-shaped hover messages', async t => {
  const f=await fixture(t),data=decorations(items('array')); data[0].hoverMessage=[data[0].hoverMessage];
  f.api.update(f.ed,f.key,data,()=>{});assert.equal(f.state().current.arg.hunk,'array:0');
});
for (const [name,data] of [['invalid-json','{'],['not-an-array','{}'],['negative-line',JSON.stringify([{...items('invalid')[0],start:-1}])],['inverted-range',JSON.stringify([{...items('invalid')[0],end:1}])],['missing-argument',JSON.stringify([{start:1,end:1,arg:{}}])]]) {
  test('native payload validation: '+name,async t=>{
    const f=await fixture(t);assert.throws(()=>f.api.update(f.ed,f.key,[{hoverMessage:{value:'<!-- change-review-controls:v1 -->'+data}}],()=>{}));
  });
}

for (const platform of ['MacIntel','Win32','Linux x86_64']) {
  const mac=platform==='MacIntel';
  const combinations=[
    ['keep',{key:'y',metaKey:mac,ctrlKey:!mac,shiftKey:mac},'accept'],
    ['undo',{key:'n',metaKey:mac,ctrlKey:!mac,shiftKey:false},'reject'],
    ['no-modifier',{key:'n',metaKey:false,ctrlKey:false,shiftKey:false},null],
    ['alt-modifier',{key:'n',metaKey:mac,ctrlKey:!mac,shiftKey:false,altKey:true},null],
    ['shift-n',{key:'n',metaKey:mac,ctrlKey:!mac,shiftKey:true},null],
    ['unrelated-key',{key:'s',metaKey:mac,ctrlKey:!mac,shiftKey:false},null]
  ];
  for (const [name,keys,action] of combinations) test('native shortcut '+platform+': '+name,async t=>{
    const original=Object.getOwnPropertyDescriptor(globalThis,'navigator');
    Object.defineProperty(globalThis,'navigator',{value:{platform},configurable:true});
    t.after(()=>{if(original)Object.defineProperty(globalThis,'navigator',original);else delete globalThis.navigator;});
    const calls=[],f=await fixture(t,(...args)=>calls.push(args));let stopped=false;
    f.ed.emit('onKeyDown',{...keys,altKey:keys.altKey||false,browserEvent:{key:keys.key},preventDefault(){stopped=true;},stopPropagation(){}});
    await tick();assert.equal(stopped,Boolean(action));assert.equal(calls.length,action?1:0);if(action)assert.equal(calls[0][0],'changeReview.'+action);
  });
}
test('unfocused editor does not intercept review shortcuts',async t=>{
  const calls=[],f=await fixture(t,(...args)=>calls.push(args));f.ed.hasTextFocus=()=>false;
  f.ed.emit('onKeyDown',{browserEvent:{key:'n'},metaKey:true,ctrlKey:true,preventDefault(){assert.fail('Must not intercept');},stopPropagation(){}});
  await tick();assert.equal(calls.length,0);
});
