import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,readdirSync} from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {boot,tempDir,removeDir} from './helpers.mjs';

const dataDir=tempDir();
let app;
before(async()=>{app=await boot(dataDir);});
after(async()=>{await app.stop();removeDir(dataDir);});
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1sAAAAASUVORK5CYII=';

test('titles are unique regardless of case and spacing',async()=>{
 const foo=await app.create('Foo Bar','x');
 const dupe=await app.create('foo_bar','y');assert.equal(dupe.id,foo.id);assert.equal(dupe.body,'x');
 const other=await app.create('Baz','z');
 const clash=await app.request('/pages/'+other.id,'PUT',{...other,title:'FOO BAR'});assert.equal(clash.status,409);
 const sameKey=await app.request('/pages/'+foo.id,'PUT',{...foo,title:'foo bar'});assert.equal(sameKey.status,200);
 assert.equal(sameKey.data.page.title,'foo bar');
});
test('renaming a page rewrites links written in another case',async()=>{
 const target=await app.create('Target Page','');const ref=await app.create('Referrer','[target page] #TARGET_PAGE [Target Page.icon]');
 const renamed=await app.request('/pages/'+target.id,'PUT',{...target,title:'New Name'});
 assert.equal(renamed.data.pages.find(p=>p.id===ref.id).body,'[New Name] [New Name] [New Name.icon]');
});
test('trashed pages can be deleted permanently and the trash can be emptied',async()=>{
 const a=await app.create('捨てる1','a'),b=await app.create('捨てる2','b'),keep=await app.create('残す','c');
 assert.equal((await app.request('/pages/'+a.id+'?permanent=1','DELETE',{})).status,409);
 for(const p of [a,b])assert.equal((await app.request('/pages/'+p.id,'DELETE',{})).status,200);
 assert.equal((await app.request('/pages/'+a.id+'?permanent=1','DELETE',{})).status,200);
 assert.equal((await app.request('/pages/'+a.id+'/history')).status,404);
 assert.ok(!(await app.request('/trash')).data.some(p=>p.id===a.id));
 assert.ok((await app.request('/trash')).data.some(p=>p.id===b.id));
 const emptied=await app.request('/trash','DELETE',{});assert.equal(emptied.status,200);assert.ok(emptied.data.removed>=1);
 assert.deepEqual((await app.request('/trash')).data,[]);
 assert.ok((await app.request('/state')).data.pages.some(p=>p.id===keep.id));
});
test('import keeps Scrapbox created/updated times (seconds)',async()=>{
 const result=await app.request('/import','POST',{pages:[{title:'昔のページ',created:1500000000,updated:1600000000,lines:['昔のページ','本文']},{title:'時刻なし',lines:['時刻なし','x']}]});
 assert.equal(result.data.added,2);
 const old=result.data.pages.find(p=>p.title==='昔のページ');
 assert.equal(old.created,1500000000000);assert.equal(old.updated,1600000000000);
 const fresh=result.data.pages.find(p=>p.title==='時刻なし');assert.ok(Date.now()-fresh.updated<60000);
 const dupe=await app.request('/import','POST',{pages:[{title:'昔のページ'.toUpperCase(),lines:['x']},{title:'昔のページ',lines:['y']}]});
 assert.equal(dupe.data.skipped,2);
});
test('projects are isolated and can be created, renamed and deleted',async()=>{
 const before=(await app.request('/projects')).data.projects;assert.equal(before.length,1);
 const created=await app.request('/projects','POST',{name:'Work'});assert.equal(created.status,201);
 const work=created.data.project;
 assert.equal((await app.request('/projects','POST',{name:'work'})).status,409);
 for(const bad of ['','a/b',' ','x'.repeat(101)])assert.equal((await app.request('/projects','POST',{name:bad})).status,400);
 const page=await app.create('仕事','メモ',work.id);
 assert.equal((await app.request('/state?project='+work.id)).data.pages.length,1);
 assert.ok(!(await app.request('/state')).data.pages.some(p=>p.id===page.id));
 const samename=await app.create('仕事','別プロジェクトの同名');assert.notEqual(samename.id,page.id);
 const renamed=await app.request('/pages/'+page.id,'PUT',{...page,title:'仕事2'});assert.equal(renamed.status,200);
 assert.equal((await app.request('/state?project=nope')).status,404);
 assert.equal((await app.request('/projects/'+work.id,'PUT',{name:'Job'})).data.project.name,'Job');
 assert.equal((await app.request('/projects/'+work.id,'DELETE',{})).status,200);
 assert.equal((await app.request('/pages/'+page.id,'PUT',{...page,title:'x'})).status,404);
 const [only]=(await app.request('/projects')).data.projects;
 assert.equal((await app.request('/projects/'+only.id,'DELETE',{})).status,409);
});
test('project CSS and UserScript are stored, and the script is served only when enabled',async()=>{
 const {project}=(await app.request('/state')).data;
 const put=await app.request('/projects/'+project.id,'PUT',{css:'.x{color:red}',js:'window.__x=1;'});
 assert.equal(put.data.project.css,'.x{color:red}');assert.equal(put.data.project.jsEnabled,false);
 const off=await fetch(app.base+'/user.js?project='+project.id);
 assert.equal(off.headers.get('content-type'),'text/javascript; charset=utf-8');assert.ok(!(await off.text()).includes('__x'));
 await app.request('/projects/'+project.id,'PUT',{jsEnabled:true});
 assert.equal(await (await fetch(app.base+'/user.js?project='+project.id)).text(),'window.__x=1;');
 assert.equal((await app.request('/projects/'+project.id,'PUT',{css:5})).status,400);
 assert.equal((await app.request('/projects/'+project.id,'PUT',{js:'x'.repeat(500001)})).status,400);
 const rebound=await new Promise((resolve,reject)=>{const req=http.request(app.base+'/user.js?project='+project.id,{headers:{Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});
 assert.equal(rebound,403);
});
test('full export carries uploaded images and import restores them',async()=>{
 const {url}=(await app.request('/upload','POST',{data:png})).data;
 await app.create('画像ページ','[/uploads/'+url.split('/').pop()+']\n[/uploads/missing-file.png]');
 const exported=(await app.request('/export?full=1')).data;
 assert.deepEqual(Object.keys(exported.images),[url]);assert.equal(exported.images[url],png);
 assert.ok(!('images' in (await app.request('/export')).data));
 const other=tempDir(),second=await boot(other);
 try{
  const imported=await second.request('/import','POST',exported);
  assert.ok(imported.data.added>=1);assert.equal(imported.data.images,1);
  const img=await fetch(second.base+url);assert.equal(img.status,200);assert.equal(img.headers.get('content-type'),'image/png');
  const again=await second.request('/import','POST',exported);assert.equal(again.data.images,0);
  const bad=await second.request('/import','POST',{pages:[],images:{'/uploads/../../evil.png':png,'/uploads/a.jpg':png,'/uploads/ok.svg':'data:image/svg+xml;base64,PHN2Zz4='}});
  assert.equal(bad.data.images,0);
 }finally{await second.stop();removeDir(other);}
});
test('changes are pushed to other tabs over server-sent events',async()=>{
 const response=await fetch(app.base+'/api/events'),reader=response.body.getReader();
 assert.equal(response.headers.get('content-type'),'text/event-stream');
 try{
  const seen=(async()=>{let text='';for(;;){const {value,done}=await reader.read();if(done)return text;text+=new TextDecoder().decode(value);const m=text.match(/data: (\{.*\})/);if(m)return JSON.parse(m[1]);}})();
  await app.create('通知テスト','x');
  const event=await Promise.race([seen,new Promise((_,reject)=>setTimeout(()=>reject(new Error('no event')),3000))]);
  assert.equal(event.type,'changed');
 }finally{await reader.cancel();}
});
test('vendored KaTeX assets are served but nothing else can be reached',async()=>{
 const js=await fetch(app.base+'/vendor/katex/katex.min.js');assert.equal(js.status,200);assert.match(js.headers.get('content-type'),/javascript/);
 const css=await fetch(app.base+'/vendor/katex/katex.min.css');assert.equal(css.status,200);
 const font=(await css.text()).match(/fonts\/[\w.-]+\.woff2/)[0];
 const woff=await fetch(app.base+'/vendor/katex/'+font);assert.equal(woff.status,200);assert.equal(woff.headers.get('content-type'),'font/woff2');
 assert.match(js.headers.get('content-security-policy'),/frame-src https:\/\/www\.youtube-nocookie\.com/);
 for(const bad of ['/vendor/katex/../../server.mjs','/vendor/katex/%2e%2e/%2e%2e/server.mjs','/vendor/katex/fonts/../../../server.mjs','/vendor/other.js','/test/app.test.mjs'])assert.equal((await fetch(app.base+bad)).status,404,bad);
});
test('v1 databases are migrated in place after a backup, keeping every page',async()=>{
 const legacy=tempDir();
 const db=new DatabaseSync(path.join(legacy,'scrapbox.sqlite'));
 db.exec(`CREATE TABLE pages (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', created INTEGER, updated INTEGER, pinned INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0, rev INTEGER DEFAULT 1);
  CREATE UNIQUE INDEX active_title ON pages(title) WHERE deleted=0;
  CREATE TABLE history (id INTEGER PRIMARY KEY, page_id TEXT, title TEXT, body TEXT, saved INTEGER);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  INSERT INTO settings VALUES('initialized','true'),('projectName','旧プロジェクト');
  INSERT INTO pages(id,title,body,created,updated,pinned,deleted) VALUES('a','Note','one',1,10,1,0),('b','note','two',2,20,0,0),('c','NOTE','three',3,30,0,0),('d','Gone','bye',4,40,0,1),('e','gone','again',5,50,0,0);
  INSERT INTO history(page_id,title,body,saved) VALUES('a','Note','older',5);`);
 db.close();
 const migrated=await boot(legacy);
 try{
  const state=(await migrated.request('/state')).data;
  assert.equal(state.project.name,'旧プロジェクト');assert.equal(state.projects.length,1);
  assert.deepEqual(state.pages.map(p=>p.title).sort(),['NOTE (3)','Note','gone','note (2)']);
  assert.equal(state.pages.find(p=>p.title==='Note').body,'one');assert.equal(state.pages.find(p=>p.title==='Note').pinned,1);
  assert.equal((await migrated.request('/trash')).data[0].title,'Gone');
  assert.equal((await migrated.request('/pages/a/history')).data.length,1);
  assert.equal((await migrated.request('/pages/a/restore','POST',{})).status,200);
  assert.ok(readdirSync(legacy).some(f=>/^backup-before-v2-.*\.sqlite$/.test(f)));
  const backup=new DatabaseSync(path.join(legacy,readdirSync(legacy).find(f=>f.startsWith('backup-before-v2'))));
  assert.equal(backup.prepare('SELECT COUNT(*) n FROM pages').get().n,5);backup.close();
  assert.equal((await migrated.create('NOTE','dup')).body,'one');
  await migrated.stop();
  const reopened=await boot(legacy);
  try{assert.equal((await reopened.request('/state')).data.pages.length,4);assert.equal(readdirSync(legacy).filter(f=>f.startsWith('backup-before')).length,1);}finally{await reopened.stop();}
 }finally{await migrated.stop();removeDir(legacy);}
});
test('a fresh database starts with sample notes in a default project and no backup',async()=>{
 const fresh=tempDir(),server=await boot(fresh);
 try{
  const state=(await server.request('/state')).data;
  assert.equal(state.project.name,'my-notes');assert.ok(state.pages.length>=10);
  assert.ok(!readdirSync(fresh).some(f=>f.startsWith('backup')));
  assert.ok(existsSync(path.join(fresh,'uploads')));
 }finally{await server.stop();removeDir(fresh);}
});
test('requests flagged as cross-site by the browser cannot read the API or the UserScript',async()=>{
 const status=(route,site)=>fetch(app.base+route,{headers:{'Sec-Fetch-Site':site}}).then(r=>r.status);
 for(const route of ['/api/state','/api/export','/user.js'])for(const site of ['cross-site','same-site'])assert.equal(await status(route,site),403,route+' '+site);
 for(const site of ['same-origin','none'])assert.equal(await status('/api/state',site),200);
 assert.equal(await status('/','cross-site'),200);
});
test('the backup script snapshots the database, images and login settings, and keeps only recent snapshots',async()=>{
 const {execFileSync}=await import('node:child_process');
 const {mkdirSync,writeFileSync,readdirSync}=await import('node:fs');
 const data=tempDir(),dest=tempDir();
 const server=await boot(data);
 try{
  await server.create('バックアップ対象','中身');
  const {url}=(await server.request('/upload','POST',{data:png})).data;
  writeFileSync(path.join(data,'auth.json'),'{"hash":"h","secret":"s"}');
  for(const day of ['20200101','20200102','20200103'])writeFileSync(path.join(dest,`scrapbox-${day}.sqlite`),'old');
  const run=()=>execFileSync(process.execPath,['--no-warnings','deploy/backup.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,SCRAPBOX_DATA_DIR:data,BACKUP_DIR:dest,BACKUP_KEEP:'2'}}).toString();
  assert.match(run(),/バックアップ: .*scrapbox-\d{8}\.sqlite（古い2件を削除）/);
  const files=readdirSync(dest);
  const snapshot=files.find(f=>/^scrapbox-\d{8}\.sqlite$/.test(f)&&f>'scrapbox-2021');
  assert.ok(snapshot);assert.equal(files.filter(f=>/^scrapbox-\d{8}\.sqlite$/.test(f)).length,2);
  const backup=new DatabaseSync(path.join(dest,snapshot));
  assert.ok(backup.prepare("SELECT COUNT(*) n FROM pages WHERE title='バックアップ対象'").get().n===1);backup.close();
  assert.ok(existsSync(path.join(dest,'uploads',url.split('/').pop())));assert.ok(existsSync(path.join(dest,'auth.json')));
  assert.doesNotThrow(run);
 }finally{await server.stop();removeDir(data);removeDir(dest);}
});
