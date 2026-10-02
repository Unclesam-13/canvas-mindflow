const Module=require('module');const orig=Module._load;
Module._load=function(r,...a){ if(r==='obsidian') return {Plugin:class{},PluginSettingTab:class{},Setting:class{},Notice:class{},ItemView:class{},Modal:class{},Component:class{},requestUrl:()=>{},normalizePath:x=>x}; return orig.call(this,r,...a);};
global.window={}; 
const assert=require('assert');
const M=require(require('path').join(__dirname,'..','main.js'));
const {FavStore,buildFolderCanvas}=M._fav;
const files={};
const adapter={exists:async p=>p in files||Object.keys(files).some(k=>k.startsWith(p+'/')),read:async p=>files[p],write:async(p,c)=>{files[p]=c},mkdir:async()=>{}};
const sess={id:'S1',title:'怎么理解SVD',rootId:'r',updatedAt:1,nodes:{r:{id:'r',parentId:null,title:'怎么理解SVD',messages:[{id:'u1',role:'user',content:'怎么理解SVD?'},{id:'a1',role:'assistant',content:'答：\\[A=U\\Sigma V^T\\]'}]},c:{id:'c',parentId:'r',anchor:{text:'正交基',msgId:'a1'},title:'正交基?',messages:[{id:'u2',role:'user',content:'正交基?'},{id:'a2',role:'assistant',content:'是..'}]}}};
const chat={app:{vault:{adapter}},store:{folder:()=>'Mindflow',ensureDir:async()=>{},get:async id=>id==='S1'?sess:null}};
// borrow layoutSession from MindflowChat prototype
(async()=>{
 const fav=new FavStore(chat); await fav.load();
 const A=fav.addFolder('线代',null), B=fav.addFolder('SVD',A.id), C=fav.addFolder('空',null);
 assert.equal(fav.pathName(B.id),'线代 / SVD');
 assert.ok(!fav.moveFolder(A.id,B.id),'cycle prevented');
 const r1=fav.addItem(B.id,{type:'qa',sessionId:'S1',nodeId:'r',msgId:'a1',title:'怎么理解SVD?'});
 assert.ok(!r1.existed); assert.ok(fav.addItem(B.id,{type:'qa',sessionId:'S1',nodeId:'r',msgId:'a1',title:'x'}).existed);
 fav.addItem(A.id,{type:'session',sessionId:'S1',title:'怎么理解SVD'});
 fav.addItem(A.id,{type:'session',sessionId:'GONE',title:'已删'});
 assert.equal(fav.count(A.id),3);
 await fav.save(true); assert.ok(files['Mindflow/收藏夹.json']);
 const f2=new FavStore(chat); await f2.load(); assert.equal(f2.data.folders.length,3);
 // layoutSession from the class
 const proto=Object.getPrototypeOf(M._chatProto||{});
 chat.layoutSession=M._layoutSession;
 const d=await buildFolderCanvas(chat,fav,null);
 console.log(JSON.stringify(d.nodes.map(n=>[n.type,n.id,n.label||n.text.slice(0,30),n.x,n.y,n.width,n.height])));
 const ids=new Set(); for(const n of d.nodes){assert.ok(!ids.has(n.id),'dup id '+n.id); ids.add(n.id);}
 for(const e of d.edges){assert.ok(ids.has(e.fromNode)&&ids.has(e.toNode));}
 // nested group inside parent group
 const g=id=>d.nodes.find(n=>n.id==='grp-'+id); const ga=g(A.id),gb=g(B.id);
 assert.ok(gb.x>=ga.x&&gb.y>=ga.y&&gb.x+gb.width<=ga.x+ga.width&&gb.y+gb.height<=ga.y+ga.height);
 const qa=d.nodes.find(n=>n.id===r1.item.id); assert.ok(qa.text.includes('$$A=U\\Sigma V^T$$')&&qa.text.includes('msg=a1'));
 fav.removeFolder(A.id); assert.equal(fav.data.folders.length,1); assert.equal(fav.data.items.length,0);
 await fav.forgetSession('S1');
 console.log('FAV OK');
})().catch(e=>{console.error(e);process.exit(1)});
