// Macアプリ版の「1ページ＝1ファイル」保存（SCRAPBOX_NOTES_DIR）
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,readdirSync,renameSync,unlinkSync,mkdirSync,statSync} from 'node:fs';
import path from 'node:path';
import {boot,tempDir,removeDir} from './helpers.mjs';
import {fileNameFor,titleFromFileName,fromFileText} from '../filestore.mjs';

const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function start(dir,extra={}){
 const notes=path.join(dir,'notes');
 const app=await boot(path.join(dir,'data'),{SCRAPBOX_NOTES_DIR:notes,SCRAPBOX_UPLOADS_DIR:path.join(notes,'.images'),...extra});
 app.notes=notes;
 app.file=(name,folder='')=>path.join(notes,folder,name);
 app.state=async(project='')=>(await app.request('/state'+(project?'?project='+project:''))).data;
 app.page=async(title,project='')=>(await app.state(project)).pages.find(p=>p.title===title);
 return app;
}
const txt=(app,name,folder)=>readFileSync(app.file(name,folder),'utf8');
const names=(dir)=>readdirSync(dir).filter(n=>!n.startsWith('.')).sort();

test('file names round-trip titles that Mac file names cannot hold',()=>{
 assert.equal(fileNameFor('買い物/リスト: 週末'),'買い物／リスト： 週末.txt');
 assert.equal(titleFromFileName('買い物／リスト： 週末.txt'),'買い物/リスト: 週末');
 assert.equal(fileNameFor('.hidden'),'．hidden.txt');
 assert.equal(titleFromFileName('．hidden.txt'),'.hidden');
 assert.ok(Buffer.byteLength(fileNameFor('あ'.repeat(300)))<=240);
 assert.equal(fromFileText('﻿a\r\nb\r\n'),'a\nb');
});

test('pages are written as files and app edits, renames and trash follow',async()=>{
 const dir=tempDir(),app=await start(dir);
 try{
  assert.ok(existsSync(app.file('はじめに.txt')),'seed notes become files');
  const a=await app.create('買い物/リスト','牛乳\n卵');
  assert.equal(txt(app,'買い物／リスト.txt'),'牛乳\n卵\n');
  const ref=await app.create('参照する','[買い物/リスト] を見る');
  const r=await app.request('/pages/'+a.id,'PUT',{...a,title:'週末の買い物',body:'牛乳\n卵\nパン'});
  assert.equal(r.status,200);
  assert.ok(!existsSync(app.file('買い物／リスト.txt')));
  assert.equal(txt(app,'週末の買い物.txt'),'牛乳\n卵\nパン\n');
  assert.equal(txt(app,'参照する.txt'),'[週末の買い物] を見る\n','link rename reaches the other file');
  const page=r.data.page;
  await app.request('/pages/'+page.id,'DELETE',{});
  assert.ok(!existsSync(app.file('週末の買い物.txt')),'trash removes the file');
  await app.request('/pages/'+page.id+'/restore','POST',{});
  assert.equal(txt(app,'週末の買い物.txt'),'牛乳\n卵\nパン\n','restore writes it back');
  void ref;
 }finally{await app.stop();removeDir(dir);}
});

test('edits, new files, renames and deletions made in other apps are picked up',async()=>{
 const dir=tempDir(),app=await start(dir);
 try{
  const a=await app.create('外部編集','元の文');
  await app.create('リンク元','[外部編集] へ');
  writeFileSync(app.file('外部編集.txt'),'書き換えた文\r\n');
  let page=await app.page('外部編集');
  assert.equal(page.body,'書き換えた文');assert.ok(page.rev>a.rev,'rev bumps so open editors see a conflict');
  const history=(await app.request('/pages/'+a.id+'/history')).data;
  assert.equal(history[0].body,'元の文','previous text kept in history');

  writeFileSync(app.file('テキストエディットで作成.txt'),'新しいメモ\n');
  assert.equal((await app.page('テキストエディットで作成')).body,'新しいメモ');

  renameSync(app.file('外部編集.txt'),app.file('名前を変えた.txt'));
  page=await app.page('名前を変えた');
  assert.equal(page?.id,a.id,'rename keeps the same page (history, pins)');
  await wait(100);
  assert.equal(txt(app,'リンク元.txt'),'[名前を変えた] へ\n','links follow a Finder rename');

  unlinkSync(app.file('名前を変えた.txt'));
  assert.equal(await app.page('名前を変えた'),undefined);
  const trash=(await app.request('/trash')).data;
  assert.ok(trash.some(p=>p.id===a.id&&p.body==='書き換えた文'),'deleted file goes to trash with its text');
 }finally{await app.stop();removeDir(dir);}
});

test('changes from other apps are picked up without reloading (file watcher)',async()=>{
 const dir=tempDir(),app=await start(dir);
 try{
  writeFileSync(app.file('監視.txt'),'x\n');
  let found=false;
  for(let i=0;i<40&&!found;i++){await wait(100);found=(await fetch(app.base+'/api/projects').then(r=>r.json())).projects[0].count>=12;}
  assert.ok(found,'watcher imports without /api/state');
 }finally{await app.stop();removeDir(dir);}
});

test('an unsaved edit from another app is never overwritten',async()=>{
 const dir=tempDir(),app=await start(dir,{SCRAPBOX_NO_WATCH:'1'});
 try{
  const a=await app.create('競合','A');
  writeFileSync(app.file('競合.txt'),'外で書いた\n');
  const r=await app.request('/pages/'+a.id,'PUT',{...a,body:'アプリで書いた'}); // 取り込み前に保存
  assert.equal(r.status,200);
  assert.equal(txt(app,'競合.txt'),'アプリで書いた\n');
  const copy=names(app.notes).find(n=>n.startsWith('競合（競合'));
  assert.ok(copy,'the other version is kept as a conflict copy');
  assert.equal(txt(app,copy),'外で書いた\n');
  assert.ok((await app.state()).pages.some(p=>p.title===titleFromFileName(copy)),'and shows up as its own page');
  // ゴミ箱へ移す前にほかで編集されていた場合も、消さずに残す
  const b=await app.create('消す前に編集','B');
  writeFileSync(app.file('消す前に編集.txt'),'大事な追記\n');
  await app.request('/pages/'+b.id,'DELETE',{});
  const kept=names(app.notes).find(n=>n.startsWith('消す前に編集（競合'));
  assert.ok(kept);assert.equal(txt(app,kept),'大事な追記\n');
 }finally{await app.stop();removeDir(dir);}
});

test('the editor sees a conflict when a file changed underneath it',async()=>{
 const dir=tempDir(),app=await start(dir);
 try{
  const a=await app.create('開いているページ','A');
  writeFileSync(app.file('開いているページ.txt'),'外で書いた\n');
  await app.state();
  const r=await app.request('/pages/'+a.id,'PUT',{...a,body:'古い版から保存'});
  assert.equal(r.status,409);
  assert.equal(txt(app,'開いているページ.txt'),'外で書いた\n');
 }finally{await app.stop();removeDir(dir);}
});

test('projects are folders: create, rename, external folder, delete',async()=>{
 const dir=tempDir(),app=await start(dir);
 try{
  const root=(await app.state()).project;
  const created=(await app.request('/projects','POST',{name:'研究'})).data.project;
  assert.ok(statSync(path.join(app.notes,'研究')).isDirectory());
  await app.create('論文メモ','関連研究',created.id);
  assert.equal(txt(app,'論文メモ.txt','研究'),'関連研究\n');
  await app.request('/projects/'+created.id,'PUT',{name:'研究ノート'});
  assert.ok(existsSync(app.file('論文メモ.txt','研究ノート')));
  mkdirSync(path.join(app.notes,'買い物'));writeFileSync(app.file('週末.txt','買い物'),'パン\n');
  const state=await app.state();
  const shop=state.projects.find(p=>p.name==='買い物');
  assert.ok(shop,'a new folder becomes a project');
  assert.equal((await app.page('週末',shop.id)).body,'パン');
  assert.equal((await app.request('/projects/'+root.id,'DELETE',{})).status,409,'the root folder project cannot be deleted');
  assert.equal((await app.request('/projects/'+created.id,'DELETE',{})).status,200);
  assert.ok(!existsSync(path.join(app.notes,'研究ノート')));
  const kept=readdirSync(path.join(dir,'data','deleted-folders'));
  assert.ok(kept.some(n=>n.startsWith('研究ノート')),'deleted project folder is kept aside, not erased');
 }finally{await app.stop();removeDir(dir);}
});

test('an existing database moves into files once, and restarts do not rewrite files',async()=>{
 const dir=tempDir();
 let app=await boot(path.join(dir,'data'));
 const live=await app.create('移行するページ','本文');
 const gone=await app.create('捨てたページ','x');await app.request('/pages/'+gone.id,'DELETE',{});
 await app.stop();
 app=await start(dir);
 try{
  assert.equal(txt(app,'移行するページ.txt'),'本文\n');
  assert.ok(!existsSync(app.file('捨てたページ.txt')),'trashed pages stay out of the folder');
  assert.equal((await app.page('移行するページ')).id,live.id,'same page ids (history kept)');
  const before=statSync(app.file('移行するページ.txt')).mtimeMs;
  await app.stop();await wait(50);
  app=await start(dir);
  assert.equal(statSync(app.file('移行するページ.txt')).mtimeMs,before);
  assert.equal((await app.state()).pages.filter(p=>p.title==='移行するページ').length,1);
 }finally{await app.stop();removeDir(dir);}
});

test('a fresh install over an existing notes folder imports it instead of adding samples',async()=>{
 const dir=tempDir(),notes=path.join(dir,'notes');
 mkdirSync(notes,{recursive:true});writeFileSync(path.join(notes,'前からあるメモ.txt'),'残す\n');
 const app=await start(dir);
 try{
  const titles=(await app.state()).pages.map(p=>p.title);
  assert.deepEqual(titles,['前からあるメモ']);
 }finally{await app.stop();removeDir(dir);}
});

test('images are stored in the uploads folder inside the notes folder',async()=>{
 const dir=tempDir(),app=await start(dir);
 try{
  const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1sAAAAASUVORK5CYII=';
  const {data}=await app.request('/upload','POST',{data:png});
  assert.ok(existsSync(path.join(app.notes,'.images',path.basename(data.url))));
  assert.equal((await fetch(app.base+data.url)).status,200);
 }finally{await app.stop();removeDir(dir);}
});
