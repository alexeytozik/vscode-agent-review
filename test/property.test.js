'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {changes,decide}=require('../core');
function random(seed){return maximum=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return Math.floor(seed/4294967296*maximum);};}
for(let seed=1;seed<=300;seed++)test('mixed decisions preserve exact text; seed '+seed,()=>{
  const pick=random(seed),eol=seed%2?'\n':'\r\n',bom=seed%5===0?'\uFEFF':'',count=3+pick(16),kind=seed%3;
  const blocks=Array.from({length:count},(_,index)=>({prefix:'anchor-'+index+eol,before:kind===0&&index%3===0?'':'old-'+index+'-😺'+eol,after:kind===1&&index%3===0?'':'new-'+index+'-ёж'+eol,suffix:'separator-'+index+eol}));
  const render=use=>bom+blocks.map((block,index)=>block.prefix+use(block,index)+block.suffix).join('')+(seed%7?'':'tail');
  let baseline=render(block=>block.before),current=render(block=>block.after);
  const decisions=new Map();
  while(changes(baseline,current).hunks.length){
    const diff=changes(baseline,current),hunk=diff.hunks[pick(diff.hunks.length)],index=Number(/(?:old|new)-(\d+)/.exec(hunk.before+hunk.after)[1]),action=pick(2)?'accept':'reject';
    assert.ok(!decisions.has(index));decisions.set(index,action);
    const result=decide(baseline,current,diff.revision,hunk.id,action);
    baseline=result.baseline;current=result.current;
    assert.equal(current,render((block,index)=>decisions.get(index)==='reject'?block.before:block.after));
    assert.equal(baseline,render((block,index)=>decisions.get(index)==='accept'?block.after:block.before));
    assert.throws(()=>decide(baseline,current,diff.revision,hunk.id,action),/changed|modified/);
  }
  assert.equal(decisions.size,count);assert.equal(baseline,current);
});
for(const [name,before,after] of [['create-empty',null,''],['delete-empty','',null],['create-unicode',null,'ёж😺\r\n'],['delete-bom','\uFEFFtext\r\n',null],['replace-no-newline','before','after'],['newline-only','one\n','one'],['empty-to-text','','text\n'],['text-to-empty','text\n','']]){
  for(const action of ['accept','reject'])test('exact lifecycle '+name+': '+action,()=>{
    const diff=changes(before,after);let baseline=before,current=after;
    while(changes(baseline,current).hunks.length){const fresh=changes(baseline,current),result=decide(baseline,current,fresh.revision,fresh.hunks[0].id,action);baseline=result.baseline;current=result.current;}
    assert.equal(current,action==='accept'?after:before);assert.equal(baseline,current);assert.ok(diff.hunks.length);
  });
}
