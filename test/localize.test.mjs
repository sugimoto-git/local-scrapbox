// 外部画像（Scrapbox・Gyazo）の取り込み。scrapbox.io の代わりにテスト用の画像サーバーを使う
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {existsSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {boot,tempDir,removeDir} from './helpers.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1sAAAAASUVORK5CYII=','base64');
let remote,origin,dir,app;const seen=[];
before(async()=>{
 remote=http.createServer((req,res)=>{
  seen.push({url:req.url,cookie:req.headers.cookie||''});
  if(req.url.startsWith('/files/bbbbbbbbbbbbbbbbbbbbbbbb')&&req.headers.cookie!=='connect.sid=secret-session-value'){res.writeHead(302,{Location:'/login'});return res.end();}
  if(req.url==='/login'){res.writeHead(200,{'Content-Type':'text/html'});return res.end('<html>login</html>');}
  if(req.url.includes('cccccccc')){res.writeHead(404);return res.end();}
  res.writeHead(200,{'Content-Type':'image/png'});res.end(png);
 });
 await new Promise(r=>remote.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+remote.address().port;
 dir=tempDir();app=await boot(path.join(dir,'data'),{SCRAPBOX_NOTES_DIR:path.join(dir,'notes'),SCRAPBOX_UPLOADS_DIR:path.join(dir,'notes','.images'),SCRAPBOX_REMOTE_ORIGIN:origin});
});
after(async()=>{await app.stop();remote.close();removeDir(dir);});

test('remote images are downloaded and links point to the local copies',async()=>{
 const page=await app.create('画像のページ',' [https://scrapbox.io/files/aaaaaaaaaaaaaaaaaaaaaaaa.png]\n  [***** [https://scrapbox.io/files/bbbbbbbbbbbbbbbbbbbbbbbb.png]][https://gyazo.com/0123456789abcdef0123456789abcdef]\n本文の https://scrapbox.io/files/aaaaaaaaaaaaaaaaaaaaaaaa.png はそのまま\n[https://scrapbox.io/files/cccccccccccccccccccccccc.png]');
 let r=(await app.request('/localize-images','POST',{})).data;
 assert.equal(r.found,4);assert.equal(r.downloaded,2);assert.equal(r.needAuth,true,'the private one asks for login');
 assert.equal(r.failed.length,2);
 let body=(await app.request('/state')).data.pages.find(p=>p.id===page.id).body;
 assert.ok(body.startsWith(' [/uploads/scrapbox-aaaaaaaaaaaaaaaaaaaaaaaa.png]'));
 assert.ok(body.includes('[/uploads/gyazo-0123456789abcdef0123456789abcdef.png]'));
 assert.ok(body.includes('本文の https://scrapbox.io/files/aaaaaaaaaaaaaaaaaaaaaaaa.png はそのまま'),'bare text is left alone');
 assert.ok(seen.some(s=>s.url==='/0123456789abcdef0123456789abcdef/raw'),'gyazo page URL is fetched as /raw');
 // ログインCookieを渡すと非公開の画像も取れる。Cookieは scrapbox.io への問い合わせにだけ付く
 r=(await app.request('/localize-images','POST',{cookie:'secret-session-value'})).data;
 assert.equal(r.downloaded,1);assert.equal(r.needAuth,false);assert.equal(r.failed.length,1);assert.equal(r.failed[0].status,404);
 body=(await app.request('/state')).data.pages.find(p=>p.id===page.id).body;
 assert.ok(body.includes('[***** [/uploads/scrapbox-bbbbbbbbbbbbbbbbbbbbbbbb.png]]'));
 assert.ok(!seen.some(s=>s.url.includes('0123456789abcdef')&&s.cookie),'cookie never sent to other hosts');
 // ファイル（.txt）にも反映され、画像は配信される
 assert.ok(readFileSync(path.join(dir,'notes','画像のページ.txt'),'utf8').includes('/uploads/scrapbox-bbbbbbbbbbbbbbbbbbbbbbbb.png'));
 assert.ok(existsSync(path.join(dir,'notes','.images','scrapbox-aaaaaaaaaaaaaaaaaaaaaaaa.png')));
 assert.equal((await fetch(app.base+'/uploads/scrapbox-aaaaaaaaaaaaaaaaaaaaaaaa.png')).status,200);
 // 2回目は何もしない（取り込み済み）
 const before=seen.length;
 r=(await app.request('/localize-images','POST',{})).data;
 assert.equal(r.found,1);assert.equal(r.pagesChanged,0);
 assert.equal(seen.length-before,1,'only the still-missing image is retried');
});
