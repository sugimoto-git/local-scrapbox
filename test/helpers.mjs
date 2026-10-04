import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {once} from 'node:events';

export function tempDir(){return mkdtempSync(path.join(tmpdir(),'local-scrapbox-test-'));}
export function removeDir(dir){rmSync(dir,{recursive:true,force:true});}
export async function boot(dataDir,env={}){
 const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:'0',SCRAPBOX_DATA_DIR:dataDir,...env},stdio:['ignore','pipe','pipe']});
 let output='';
 const base=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Startup timeout\n'+output)),8000);child.stdout.on('data',data=>{output+=data;const m=output.match(/http:\/\/[\d.]+:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});child.stderr.on('data',data=>{output+=data;});child.on('exit',code=>{clearTimeout(timer);reject(new Error('Server exit '+code+'\n'+output));});});
 const server={child,base,get output(){return output;},async stop(){if(child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');child.kill();await exit;}}};
 server.request=async(route,method='GET',body,headers={})=>{const response=await fetch(base+'/api'+route,{method,headers:{'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,data:await response.json()};};
 server.create=async(title,body='',project='')=>(await server.request('/pages'+(project?'?project='+project:''),'POST',{title,body})).data;
 return server;
}

// fetchでは書き換えられない Host ヘッダーなどを指定してリクエストする
import http from 'node:http';
export function raw(base,route,{method='GET',headers={},body}={}){
 return new Promise((resolve,reject)=>{
  const req=http.request(base+route,{method,headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers}},res=>{
   let text='';res.setEncoding('utf8');res.on('data',c=>text+=c);
   res.on('end',()=>{let data;try{data=JSON.parse(text);}catch{data=text;}resolve({status:res.statusCode,headers:res.headers,data});});
  });
  req.on('error',reject);
  if(body!==undefined)req.write(typeof body==='string'?body:JSON.stringify(body));
  req.end();
 });
}
