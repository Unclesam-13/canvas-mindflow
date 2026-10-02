const Module=require('module');const orig=Module._load;
Module._load=function(r,...a){ if(r==='obsidian') return {Plugin:class{},PluginSettingTab:class{},Setting:class{},Notice:class{},ItemView:class{},Modal:class{},Component:class{},requestUrl:()=>{},normalizePath:x=>x,arrayBufferToBase64:b=>Buffer.from(b).toString('base64')}; return orig.call(this,r,...a);};
global.window={};
const assert=require('assert');
const M=require(require('path').join(__dirname,'..','main.js'));
const {buildThreadMessages}=M._chat; const {materializeImages,attKind}=M._attach;
const settings={systemPrompt:'sys',fullContextDepth:3,truncateChars:600};
const s={id:'S',rootId:'r',nodes:{
 r:{id:'r',parentId:null,messages:[{id:'u1',role:'user',content:'看图',attachments:[{kind:'image',name:'a.png',path:'M/附件/a.png',mime:'image/png'},{kind:'file',name:'b.pdf',text:'PDF内容',pages:2}]},{id:'a1',role:'assistant',content:'好'}]},
 c:{id:'c',parentId:'r',anchor:{text:'好'},messages:[{id:'u2',role:'user',content:'再问',attachments:[{kind:'image',name:'c.jpg',path:'M/附件/c.jpg',mime:'image/jpeg'}]}]}}};
(async()=>{
 let m=buildThreadMessages(settings,s,'r'); 
 assert.ok(m[1].content.includes('【附件：b.pdf，共 2 页】')&&m[1].content.includes('PDF内容')); assert.equal(m[1]._images.length,1);
 m=buildThreadMessages(settings,s,'c');
 assert.ok(!m[1]._images && m[1].content.includes('附带了 1 张图片'));
 const last=m[m.length-1]; assert.equal(last._images[0].path,'M/附件/c.jpg');
 const app={vault:{adapter:{readBinary:async p=>{ if(p.endsWith('c.jpg')) return new Uint8Array([1,2,3]).buffer; throw new Error('x');}}}};
 const out=await materializeImages(app,m);
 assert.ok(Array.isArray(out[out.length-1].content)); assert.equal(out[out.length-1].content[1].image_url.url,'data:image/jpeg;base64,AQID');
 assert.ok(out.every(x=>!('_images' in x)));
 assert.equal(attKind({name:'x.PDF',type:''}),'pdf'); assert.equal(attKind({name:'x.docx',type:'application/vnd'}),null); assert.equal(attKind({name:'a.py',type:''}),'text');
 console.log('ATT OK');
})().catch(e=>{console.error(e);process.exit(1)});
