'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createPatch}=require('diff');const {ReviewModel,rebase,transition}=require('../review-model');
function event(index=0,options={}){const before=options.before??'before\n',after=options.after??'after\n';return {method:'item/completed',type:'fileChange',status:'completed',threadId:'queue',turnId:'turn-'+index,itemId:'change',changes:[{path:'/tmp/review-queue-'+index+'.txt',kind:{type:'update'},diff:createPatch('file',before,after),snapshot:{disk:after,text:after,mode:0o644}}],...options};}
function complete(model,index){model.receive({method:'turn/completed',threadId:'queue',turnId:'turn-'+index});}
for(const count of [0,1,2,50,199,200,201,250])test((count>200?'[regression] ':'')+'saved queue restores all '+count+' requests',()=>{
  const model=new ReviewModel();for(let index=0;index<count;index++){model.receive(event(index));complete(model,index);}
  const snapshot=JSON.parse(JSON.stringify(model.save())),restored=new ReviewModel(snapshot);
  assert.equal(restored.entries().length,count);assert.ok(restored.entries().every(entry=>!entry.turn.running));
});
for(const status of ['failed','cancelled','interrupted','inProgress'])test('unconfirmed operation '+status+' is not actionable',()=>{
  const model=new ReviewModel();model.receive(event(0,{status}));complete(model,0);
  assert.equal(model.entries().length,0);assert.match(model.turns.get('queue/turn-0').warnings[0],/confirmed write/);
});
test('started event alone does not create pending changes',()=>{const model=new ReviewModel();model.receive(event(0,{method:'item/started'}));assert.equal(model.entries().length,0);assert.equal(model.operations.size,1);});
test('duplicate completion is idempotent across serialization',()=>{const model=new ReviewModel(),input=event();model.receive(input);complete(model,0);const restored=new ReviewModel(model.save());restored.receive(input);assert.equal(restored.entries()[0].file.baseline,'before\n');assert.equal(restored.entries().length,1);});
test('the same item id in different requests is independent',()=>{const model=new ReviewModel();model.receive(event(0));model.receive(event(1));assert.equal(model.entries().length,2);});
test('review decisions reject running, missing and stale changes',()=>{
  const model=new ReviewModel();model.receive(event());let entry=model.entries()[0],arg=[entry.turn.key,entry.file.path,entry.revision,entry.hunks[0].id,'reject'];
  assert.throws(()=>model.decide(...arg),/finish/);complete(model,0);model.refresh(entry.turn.key,entry.file.path,'after\nmanual\n');assert.throws(()=>model.decide(...arg),/changed|overlaps/);
  assert.throws(()=>model.decide('missing',...arg.slice(1)),/finish/);
});
test('completed reviewed requests are absent from the persisted queue',()=>{const model=new ReviewModel();model.receive(event());complete(model,0);const entry=model.entries()[0];entry.file.baseline=model.decide(entry.turn.key,entry.file.path,entry.revision,entry.hunks[0].id,'accept').baseline;assert.equal(model.save().turns.length,0);});
for(const [name,before,expected,current] of [['manual-prefix','a\nb\nold\n','a\nb\nNEW\n','manual\na\nb\nNEW\n'],['manual-suffix','old\na\nb\n','NEW\na\nb\n','NEW\na\nb\nmanual\n'],['no-manual-change','old\n','NEW\n','NEW\n']])test('manual rebase roundtrip: '+name,()=>{const result=rebase(before,expected,current);assert.equal(result.expected,current);assert.ok(result.baseline.includes('old'));assert.ok(!result.baseline.includes('NEW'));});
for(const [name,before,expected,current] of [['overlap','old\n','NEW\n','manual\n'],['removed','old\n','NEW\n',null],['recreated','old\n',null,'manual\n'],['new-file-edited',null,'NEW\n','manual\n']])test('unsafe rebase is refused: '+name,()=>assert.throws(()=>rebase(before,expected,current)));
for(const [name,mutate] of [['version',value=>value.version=99],['turns-shape',value=>value.turns={}],['relative-path',value=>value.turns[0].files[0].path='relative.txt'],['oversized-text',value=>value.turns[0].files[0].expected='x'.repeat(1024*1024+1)],['invalid-text-type',value=>value.turns[0].files[0].expected=42]])test('saved-state guard: '+name,()=>{const model=new ReviewModel();model.receive(event());complete(model,0);const snapshot=JSON.parse(JSON.stringify(model.save()));mutate(snapshot);assert.throws(()=>new ReviewModel(snapshot),/Invalid/);});
for(const [name,original] of [['matching','before\n'],['mismatched','manual\n'],['different-result','before\nextra\n']])test('pre-write snapshot verification: '+name,()=>{
  const change=event().changes[0],pair=transition(change,{disk:original,mode:0o755});
  assert.equal(pair.before,'before\n');assert.equal(pair.after,'after\n');assert.equal(pair.mode,0o755);
});
