import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {boot,raw,tempDir,removeDir} from './helpers.mjs';
import {hashPassword,verifyPassword,createSession,checkSession,parseCookies,createLimiter,newSecret} from '../auth.mjs';

const PASSWORD='correct horse battery staple';
test('passwords are hashed with a random salt and verified in constant time',()=>{
 const a=hashPassword(PASSWORD),b=hashPassword(PASSWORD);
 assert.match(a,/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);assert.notEqual(a,b);assert.ok(!a.includes('horse'));
 assert.ok(verifyPassword(PASSWORD,a));assert.ok(!verifyPassword(PASSWORD+'x',a));assert.ok(!verifyPassword('',a));
 for(const bad of ['','x','scrypt$$','scrypt$zz$zz','md5$a$b'])assert.ok(!verifyPassword(PASSWORD,bad));
});
test('session cookies expire and reject tampering or another secret',()=>{
 const secret=newSecret(),now=1e12,token=createSession(secret,1000,now);
 assert.ok(checkSession(secret,token,now+999));assert.ok(!checkSession(secret,token,now+1001));
 assert.ok(!checkSession(newSecret(),token,now));
 const [expires,sig]=token.split('.');
 assert.ok(!checkSession(secret,(Number(expires)+5000)+'.'+sig,now));
 for(const bad of [undefined,'','abc','1.','.x','9999999999999.'+sig.slice(1)])assert.ok(!checkSession(secret,bad,now));
 assert.deepEqual(parseCookies('a=1; sb_session=x.y; b=c=d'),{a:'1',sb_session:'x.y',b:'c=d'});
});
test('the login limiter blocks after repeated failures and forgets after the window',()=>{
 const limiter=createLimiter({max:3,windowMs:1000});
 for(let i=0;i<3;i++){assert.ok(!limiter.blocked('ip',100));limiter.fail('ip',100+i);}
 assert.ok(limiter.blocked('ip',500));assert.ok(!limiter.blocked('other',500));assert.ok(!limiter.blocked('ip',2000));
 limiter.fail('ip',3000);limiter.clear('ip');assert.ok(!limiter.blocked('ip',3001));
});

let dir,app;
const host='notes.example';
const login=(password,headers={})=>raw(app.base,'/api/login',{method:'POST',headers:{Host:host,...headers},body:{password}});
before(async()=>{
 dir=tempDir();
 writeFileSync(path.join(dir,'auth.json'),JSON.stringify({hash:hashPassword(PASSWORD),secret:newSecret()}));
 app=await boot(dir,{ALLOWED_HOSTS:host,TRUST_PROXY:'1'});
});
after(async()=>{await app.stop();removeDir(dir);});

test('without a login, the app, API, uploads and scripts are closed but the login page is open',async()=>{
 const get=(route,headers={})=>raw(app.base,route,{headers:{Host:host,...headers}});
 assert.equal((await get('/api/state')).status,401);
 assert.equal((await get('/api/events')).status,401);
 assert.equal((await get('/user.js')).status,401);
 assert.equal((await get('/uploads/x.png')).status,401);
 assert.equal((await get('/vendor/katex/katex.min.js')).status,401);
 for(const route of ['/','/app.js','/markup.js','/index.html']){const r=await get(route);assert.equal(r.status,302,route);assert.equal(r.headers.location,'/login');}
 for(const route of ['/login','/login.js','/style.css','/favicon.svg'])assert.equal((await get(route)).status,200,route);
 assert.deepEqual((await get('/api/session')).data,{authRequired:true,authenticated:false});
 assert.equal((await raw(app.base,'/api/pages',{method:'POST',headers:{Host:host},body:{title:'x'}})).status,401);
});
test('only the configured public host name is accepted',async()=>{
 assert.equal((await raw(app.base,'/login',{headers:{Host:'evil.example'}})).status,403);
 assert.equal((await raw(app.base,'/login',{headers:{Host:'notes.example.evil.example'}})).status,403);
 assert.equal((await raw(app.base,'/login',{headers:{Host:'NOTES.example:443'}})).status,200);
 assert.equal((await login('x',{Origin:'https://evil.example'})).status,403);
});
test('a wrong password is rejected, the right one sets a hardened cookie that opens the app',async()=>{
 const wrong=await login('nope');assert.equal(wrong.status,401);assert.ok(!wrong.headers['set-cookie']);
 const plain=await login(PASSWORD);assert.equal(plain.status,200);
 const cookieHeader=plain.headers['set-cookie'][0];
 assert.match(cookieHeader,/^sb_session=\d+\.[\w-]+;/);assert.match(cookieHeader,/HttpOnly/);assert.match(cookieHeader,/SameSite=Strict/);assert.ok(!/Secure/.test(cookieHeader));
 const https=await login(PASSWORD,{'X-Forwarded-Proto':'https',Origin:'https://'+host});
 assert.equal(https.status,200);assert.match(https.headers['set-cookie'][0],/; Secure/);
 const cookie=https.headers['set-cookie'][0].split(';')[0];
 const state=await raw(app.base,'/api/state',{headers:{Host:host,Cookie:cookie}});
 assert.equal(state.status,200);assert.equal(state.data.auth,true);assert.ok(state.data.pages.length>0);
 assert.equal((await raw(app.base,'/',{headers:{Host:host,Cookie:cookie}})).status,200);
 assert.equal((await raw(app.base,'/login',{headers:{Host:host,Cookie:cookie}})).headers.location,'/');
 assert.deepEqual((await raw(app.base,'/api/session',{headers:{Host:host,Cookie:cookie}})).data,{authRequired:true,authenticated:true});
 const edit=await raw(app.base,'/api/pages',{method:'POST',headers:{Host:host,Cookie:cookie,Origin:'https://'+host},body:{title:'ログイン後の作成'}});assert.equal(edit.status,201);
 assert.equal((await raw(app.base,'/api/pages',{method:'POST',headers:{Host:host,Cookie:cookie,Origin:'https://evil.example'},body:{title:'x'}})).status,403);
 const tampered=cookie.replace(/\.[\w-]+$/,'.AAAA');
 assert.equal((await raw(app.base,'/api/state',{headers:{Host:host,Cookie:tampered}})).status,401);
 const out=await raw(app.base,'/api/logout',{method:'POST',headers:{Host:host,Cookie:cookie},body:{}});
 assert.equal(out.status,200);assert.match(out.headers['set-cookie'][0],/Max-Age=0/);
});
test('repeated wrong passwords lock that address out for a while, others are unaffected',async()=>{
 const ip='203.0.113.9';
 for(let i=0;i<5;i++)assert.equal((await login('bad'+i,{'X-Forwarded-For':'10.0.0.1, '+ip})).status,401);
 assert.equal((await login(PASSWORD,{'X-Forwarded-For':'10.0.0.1, '+ip})).status,429);
 assert.equal((await login(PASSWORD,{'X-Forwarded-For':'198.51.100.7'})).status,200);
 // 先頭のX-Forwarded-Forを偽装しても、Nginxが付けた末尾のアドレスで判定される
 assert.equal((await login(PASSWORD,{'X-Forwarded-For':'192.0.2.1, '+ip})).status,429);
});
test('the server refuses to be exposed without a password',async()=>{
 const bare=tempDir();
 try{
  await assert.rejects(boot(bare,{HOST:'0.0.0.0'}),/Server exit 1[\s\S]*set-password/);
  await assert.rejects(boot(bare,{ALLOWED_HOSTS:host}),/Server exit 1[\s\S]*set-password/);
  writeFileSync(path.join(bare,'auth.json'),'{broken');
  await assert.rejects(boot(bare),/Server exit 1[\s\S]*auth\.json/);
 }finally{removeDir(bare);}
});
