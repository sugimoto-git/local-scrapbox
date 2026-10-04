import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {inline,links,contexts,lineHTML,renameReferences} from '../public/markup.js';

const dataDir=mkdtempSync(path.join(tmpdir(),'local-scrapbox-test-'));
let child,base;
async function boot(){
 child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:'0',SCRAPBOX_DATA_DIR:dataDir},stdio:['ignore','pipe','pipe']});
 base=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(new Error('Startup timeout')),5000);child.stdout.on('data',data=>{output+=data;const m=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});child.on('exit',code=>{clearTimeout(timer);reject(new Error('Server exit '+code));});});
}
async function stop(){if(child && child.exitCode===null){const exit=once(child,'exit');child.kill();await exit;}}
async function request(route,method='GET',body,headers={}){const response=await fetch(base+'/api'+route,{method,headers:{'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,data:await response.json()};}
const create=async(title,body='')=>(await request('/pages','POST',{title,body})).data;
const update=async(p,patch)=>(await request('/pages/'+p.id,'PUT',{...p,...patch}));
before(boot);
after(async()=>{await stop();rmSync(dataDir,{recursive:true,force:true});});

test('markup escapes HTML, URLs and unsafe schemes',()=>{
 assert.ok(!inline('<img src=x onerror=alert(1)>').includes('<img'));
 assert.ok(!inline('[javascript:alert(1)]').includes('href="javascript:'));
 assert.match(inline('[https://example.com/?q=" onclick="a label]'),/&quot;/);
 assert.match(inline('[* 太字 [リンク]]'),/class="strong/);
 assert.match(inline('[/ 斜体] [- 取消]'),/italic/);
 assert.match(inline('[未作成]',()=>false),/missing/);
});
test('link graph ignores inline code and code blocks',()=>{
 assert.deepEqual(links('[ノート] #日記\n`[literal]`\ncode:js\n [ignored]\n\n[* [読書]] [https://example.com 外部]'),['ノート','日記','読書']);
 assert.deepEqual(contexts(['code:js',' const a=1;','','table:表',' A\tB']),[{}, {code:true}, {}, {}, {table:true}]);
 assert.match(lineHTML(' a\tb',()=>true,{table:true}),/table-row/);
});
test('renaming preserves literal code and URLs while changing nested links',()=>{
 assert.equal(renameReferences('[* [旧名]] #旧名\n`[旧名]`\ncode:js\n [旧名]\n\n[https://example.com/#旧名 URL]','旧名','新名'), '[* [新名]] #新名\n`[旧名]`\ncode:js\n [旧名]\n\n[https://example.com/#旧名 URL]');
});
test('new pages persist and duplicate creation returns the existing page',async()=>{
 const p=await create('保存テスト','日本語\n[ページリンク] #日記');
 assert.equal(p.body,'日本語\n[ページリンク] #日記');
 const dupe=await create('保存テスト','上書き禁止');assert.equal(dupe.id,p.id);assert.equal(dupe.body,p.body);
 const state=(await request('/state')).data;assert.ok(state.pages.some(x=>x.id===p.id));
});
test('rename updates backlinks and hashtags atomically',async()=>{
 const p=await create('旧タイトル','本文');const ref=await create('リンク元','[旧タイトル] #旧タイトル [旧タイトル.icon]');
 const result=await update(p,{title:'新しい タイトル'});assert.equal(result.status,200);
 const r=result.data.pages.find(x=>x.id===ref.id);assert.equal(r.body,'[新しい タイトル] [新しい タイトル] [新しい タイトル.icon]');
});
test('stale revisions cannot silently overwrite newer edits',async()=>{
 const p=await create('同時編集','初期');const first=await update(p,{body:'新しい内容'});assert.equal(first.status,200);
 const stale=await update(p,{body:'古い内容'});assert.equal(stale.status,409);
 assert.equal((await request('/state')).data.pages.find(x=>x.id===p.id).body,'新しい内容');
});
test('rename collisions roll back without damaging pages',async()=>{
 const a=await create('名前A','A');await create('名前B','B');
 assert.equal((await update(a,{title:'名前B',body:'破損させない'})).status,409);
 assert.equal((await request('/state')).data.pages.find(x=>x.id===a.id).body,'A');
});
test('history retains the previous title and text',async()=>{
 const p=await create('履歴','最初');await update(p,{body:'次の内容'});
 const history=(await request('/pages/'+p.id+'/history')).data;assert.equal(history[0].body,'最初');assert.equal(history[0].title,'履歴');
});
test('deleted pages can be restored without losing content',async()=>{
 const p=await create('ゴミ箱確認','元の内容');assert.equal((await request('/pages/'+p.id,'DELETE',{})).status,200);
 assert.ok(!(await request('/state')).data.pages.some(x=>x.id===p.id));
 assert.ok((await request('/trash')).data.some(x=>x.id===p.id));
 const restored=(await request('/pages/'+p.id+'/restore','POST',{})).data;assert.equal(restored.body,'元の内容');
});
test('import accepts Scrapbox lines and never overwrites existing pages',async()=>{
 await create('既存','変更しない');
 const imported=await request('/import','POST',{pages:[{title:'インポート',lines:['インポート','日本語','[既存]']},{title:'既存',lines:['既存','新しい内容']} ]});
 assert.equal(imported.data.added,1);assert.equal(imported.data.skipped,1);assert.equal(imported.data.pages.find(x=>x.title==='インポート').body,'日本語\n[既存]');
 const invalid=await request('/import','POST',{pages:[{title:'未追加',lines:['本文']},{title:'壊れたページ',lines:[null]}]});assert.equal(invalid.status,400);
 assert.ok(!(await request('/state')).data.pages.some(x=>x.title==='未追加'));
 const exported=(await request('/export')).data;assert.deepEqual(exported.pages.find(x=>x.title==='インポート').lines,['インポート','日本語','[既存]']);
});
test('local image uploads are served and dangerous files are rejected',async()=>{
 const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1sAAAAASUVORK5CYII=';
 const uploaded=await request('/upload','POST',{data:png});assert.equal(uploaded.status,201);
 const img=await fetch(base+uploaded.data.url);assert.equal(img.status,200);assert.equal(img.headers.get('content-type'),'image/png');
 assert.equal((await request('/upload','POST',{data:'data:image/svg+xml;base64,PHN2Zz4='})).status,400);
});
test('cross-origin reads and writes and filesystem traversal are rejected',async()=>{
 assert.equal((await request('/state','GET',undefined,{Origin:'https://other.example'})).status,403);
 assert.equal((await request('/pages','POST',{title:'攻撃'},{Origin:'https://other.example'})).status,403);
 assert.equal((await fetch(base+'/data/scrapbox.sqlite')).status,404);
 assert.equal((await fetch(base+'/%2e%2e/server.mjs')).status,404);
});
test('database survives a complete server restart',async()=>{
 const p=await create('再起動確認','再起動後も残る');await stop();await boot();
 assert.equal((await request('/state')).data.pages.find(x=>x.id===p.id).body,'再起動後も残る');
});
