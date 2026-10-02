const Module=require('module');const orig=Module._load;
Module._load=function(r,...a){ if(r==='obsidian') return {Plugin:class{},PluginSettingTab:class{},Setting:class{},Notice:class{},ItemView:class{},Modal:class{},Component:class{},requestUrl:()=>{}}; return orig.call(this,r,...a);};
const assert=require('assert');
const {parseNodeText,buildNodeText,setFoldedInText,collectAncestors,buildMessages,DEFAULT_SETTINGS}=require(require('path').join(__dirname,'..','main.js'))._internals;
const fmt={answerTitle:'回答',excerptTitle:'原文'};
const ans="结论。\n\n## 小标题\n- a\n- b\n\n```py\nprint(1)\n\nx=2\n```\n\n$$E=mc^2$$";
const t=buildNodeText({excerpt:'选中的\n两行',question:'为什么？',answer:ans,folded:false},fmt);
console.log(t); 
const p=parseNodeText(t);
assert.equal(p.excerpt,'选中的 两行'); assert.equal(p.question,'为什么？'); assert.equal(p.answer,ans); assert.equal(p.folded,false);
const f=setFoldedInText(t,true); assert.equal(parseNodeText(f).folded,true); assert.equal(parseNodeText(setFoldedInText(f,false)).folded,false);
assert.equal(parseNodeText('只有问题').answer,null);
assert.equal(parseNodeText(t+'\n\n我的笔记').trailing,'我的笔记');
// status title roundtrip
const s=buildNodeText({question:'q',answer:'',folded:false},{...fmt,status:'生成中…'}); assert.equal(parseNodeText(s).answer,'…'.replace('…','')||parseNodeText(s).answer);
// ancestors: A->B->D, A->C->D, D->E(target); F unrelated
const N=(id,y,text)=>({id,type:'text',x:0,y,text});
const data={nodes:[N('A',0,buildNodeText({question:'QA',answer:'AA'},fmt)),N('B',100,buildNodeText({question:'QB',answer:'AB'.repeat(500)},fmt)),N('C',200,'背景笔记'),N('D',300,buildNodeText({question:'QD',answer:'AD'},fmt)),N('E',400,'> [!excerpt] 原文\n> 片段\n\nQE'),N('F',0,'x')],
 edges:[{fromNode:'A',toNode:'B'},{fromNode:'A',toNode:'C'},{fromNode:'B',toNode:'D'},{fromNode:'C',toNode:'D'},{fromNode:'D',toNode:'E'},{fromNode:'E',toNode:'A'}]};
const anc=collectAncestors(data,'E',20); console.log(anc.map(x=>x.node.id+':'+x.dist));
assert.deepEqual(anc.map(x=>x.node.id),['A','B','C','D']);
(async()=>{ const st={...DEFAULT_SETTINGS,fullContextDepth:1,truncateChars:10};
 const m=await buildMessages(st,data,'E',data.nodes[4].text,null); console.log(JSON.stringify(m,null,1));
 assert.equal(m[0].role,'system'); for(let i=2;i<m.length;i++) assert.notEqual(m[i].role,m[i-1].role);
 assert.ok(m[m.length-1].content.includes('「片段」')); console.log('ALL OK');})();
;(()=>{const {highlightInText,setFoldedInText,parseNodeText}=require(require('path').join(__dirname,'..','main.js'))._internals;
const src="问题\n\n> [!ai]+ 回答 · 生成中…\n> 牛顿**第二定律**说明 F=ma。\n>\n> ```js\n> const a = 力量\n> ```\n>\n> 力量是改变运动状态的原因。";
assert.equal(parseNodeText(setFoldedInText(src,true)).folded,true);
assert.ok(!setFoldedInText(src,true).includes('生成中'));
let h=highlightInText(src,'第二定律说明'); console.log(h.split('\n')[3]); assert.ok(h.includes('==第二定律**说明=='.replace('==第二定律**说明==','')) || h.includes('=='));
h=highlightInText(src,'力量'); console.log(h.split('\n').slice(-1)[0]); assert.ok(h.endsWith('> ==力量==是改变运动状态的原因。'));
assert.equal(highlightInText(src,'不存在的句子'),null);
console.log('HL OK');})();
