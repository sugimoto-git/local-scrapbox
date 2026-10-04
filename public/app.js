import {escapeHTML as esc, inline, lineHTMLs, links, pageHref, projectHref, titleKey, firstImage, blockEnd, codeBlockRange, diffLines} from './markup.js';
const $ = s => document.querySelector(s);
const indentOf = line => line.match(/^\s*/)[0].length;
let pages=[],pageIndex=new Map(),project={id:'',name:'my-notes',css:'',js:'',jsEnabled:false},projects=[],current=null,activeLine=-1,dirty=false,saveTimer,savePromise=null,editVersion=0,sourceMode=false,query='',sort=localStorage.getItem('sort')||'updated',view=localStorage.getItem('view')||'cards';
let authEnabled=false,filesInfo=null,filesWarned='';
let undoStack=[],redoStack=[],lastUndoAt=0,suggestions=[],suggestionIndex=0,suggestionMode='link',composition=false,routeToken=0,sel=null,drag=null,justDragged=false;
const time = n => new Date(n).toLocaleString('ja-JP',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
const decode = s => {try{return decodeURIComponent(s);}catch{return null;}};

// ---- ページ索引（タイトルの大文字小文字・空白の違いを無視して引く） ----
function setPages(list){pages=list;pageIndex=new Map(list.map(p=>[titleKey(p.title),p]));}
function addPage(p,where='unshift'){if(pages.some(x=>x.id===p.id))return;pages[where](p);setPages(pages);}
const pageByTitle = title => pageIndex.get(titleKey(title));
const iconCache=new WeakMap();
function iconOf(p){const cached=iconCache.get(p);if(cached&&cached.body===p.body)return cached.icon;const icon=firstImage(p.body);iconCache.set(p,{body:p.body,icon});return icon;}
const exists = title => {const p=pageByTitle(title);return p?{icon:iconOf(p)}:false;};
const linkCache=new Map();
function linkKeys(p){const cached=linkCache.get(p.id);if(cached&&cached.body===p.body)return cached.keys;const keys=links(p.body).map(titleKey);linkCache.set(p.id,{body:p.body,keys});return keys;}

async function api(url,options={}) {
 const {global,...init}=options,sep=url.includes('?')?'&':'?';
 const response=await fetch('/api'+url+(project.id&&!global?sep+'project='+encodeURIComponent(project.id):''),{...init,headers:{'Content-Type':'application/json',...init.headers}});
 const data=await response.json();if(response.status===401&&!location.pathname.startsWith('/login')){location.assign('/login');throw new Error(data.error||'ログインが必要です');}if(!response.ok)throw new Error(data.error||'通信に失敗しました');return data;
}
function toast(message) {$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').hidden=true,4200);}
function status(message,error=false) {$('#save-status').textContent=message;$('#save-status').classList.toggle('error',error);}
function count(){ $('#page-count').textContent=pages.length+' pages'; }

// ---- UserScript向けの小さなAPI（Scrapboxの window.scrapbox に似せたもの） ----
const listeners={},userMenuItems=[];
function emit(name,...args){for(const fn of listeners[name]||[])try{fn(...args);}catch(e){console.error(e);}}
window.scrapbox={
 Project:{get name(){return project.name;},get pages(){return pages.map(p=>({title:p.title,updated:p.updated}));}},
 Page:{get title(){return current?current.title:null;},get lines(){return current?current.body.split('\n').map(text=>({text})):[];}},
 PageMenu:{addItem(item){if(item&&typeof item.title==='string'&&typeof item.onClick==='function')userMenuItems.push(item);}},
 on(name,fn){(listeners[name]??=[]).push(fn);},off(name,fn){listeners[name]=(listeners[name]||[]).filter(f=>f!==fn);}
};

// ---- 取り消し・保存 ----
function snapshot(force=false){
 if(!current)return;
 if(force || Date.now()-lastUndoAt>600){
  const previous=undoStack.at(-1);
  if(!previous || previous.title!==current.title || previous.body!==current.body)undoStack.push({title:current.title,body:current.body});
  if(undoStack.length>150)undoStack.shift();lastUndoAt=Date.now();
 }
 redoStack=[];
}
function draftKey(page){return 'draft:'+(page.id || 'new:'+page.title);}
function cacheDraft(page){try{localStorage.setItem(draftKey(page),JSON.stringify({title:page.title,body:page.body,rev:page.rev}));}catch{}}
function changed(){if(!current)return;dirty=true;editVersion++;status('保存中…');cacheDraft(current);clearTimeout(saveTimer);saveTimer=setTimeout(()=>save(),650);queueMicrotask(()=>emit('lines:changed'));}
async function save(){
 if(savePromise){const ok=await savePromise;if(!ok)return false;if(dirty)return save();return true;}
 if(!dirty||!current)return true;
 clearTimeout(saveTimer);
 const page=current,version=editVersion,previousKey=draftKey(page),old=pageIndex.get(titleKey(page.title))?.title||page.title;
 savePromise=(async()=>{try{
  if(!page.title.trim())throw new Error('タイトルを入力してください');
  await ensurePage();
  const payload={title:page.title,body:page.body,pinned:page.pinned,rev:page.rev};
  const data=await api('/pages/'+page.id,{method:'PUT',body:JSON.stringify(payload)});
  setPages(data.pages);page.rev=data.page.rev;page.updated=data.page.updated;
  if(current===page && editVersion===version){
   dirty=false;page.title=data.page.title;page.body=data.page.body;
   try{localStorage.removeItem(previousKey);localStorage.removeItem(draftKey(page));}catch{}
   status('すべてローカルに保存済み');
   if(location.hash===pageHref(old)&&old!==page.title)history.replaceState(null,'',pageHref(page.title));
   if($('#updated-time'))$('#updated-time').textContent='更新 '+time(page.updated);
  }else if(current===page){cacheDraft(page);}
  count();return true;
 }catch(e){status('保存できません · クリックして再試行',true);toast(e.message);return false;}finally{savePromise=null;}})();
 const ok=await savePromise;
 if(ok&&dirty&&current===page)return save();
 return ok;
}

// ---- 一覧 ----
function card(p,terms=[]){
 let ls=p.body.split('\n').filter(Boolean);
 if(terms.length){const hits=ls.filter(l=>terms.some(t=>l.toLocaleLowerCase().includes(t)));if(hits.length)ls=hits;}
 const preview=ls.slice(0,8).map(l=>inline(l,exists)).join('<br>').replace(/<button\b[^>]*>[^<]*<\/button>/g,'');
 return `<a class="card ${p.pinned?'pinned':''}" href="${pageHref(p.title)}" aria-label="${esc(p.title)}"><h2 class="card-title">${esc(p.title)}</h2><div class="card-preview">${preview.replace(/<a\b[^>]*>/g,'<span class="page-link">').replace(/<\/a>/g,'</span>')}</div></a>`;
}
function sorted(list,terms=[]){
 const titleHit=p=>terms.length&&terms.every(t=>p.title.toLocaleLowerCase().includes(t))?1:0;
 return [...list].sort((a,b)=>(b.pinned-a.pinned)||(titleHit(b)-titleHit(a))||(sort==='title'?a.title.localeCompare(b.title,'ja'):sort==='created'?b.created-a.created:b.updated-a.updated));
}
function highlightTerms(root,terms){
 if(!terms.length||!root)return;
 const pattern=new RegExp('('+terms.map(t=>t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|')+')','gi');
 const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),nodes=[];
 while(walker.nextNode())nodes.push(walker.currentNode);
 for(const node of nodes){
  if(!pattern.test(node.data)){pattern.lastIndex=0;continue;}pattern.lastIndex=0;
  const fragment=document.createDocumentFragment();
  node.data.split(pattern).forEach((piece,i)=>{if(i%2){const mark=document.createElement('mark');mark.textContent=piece;fragment.append(mark);}else if(piece)fragment.append(piece);});
  node.replaceWith(fragment);
 }
}
function home(){
 current=null;activeLine=-1;sel=null;document.title=project.name+' · Local Scrapbox';
 const terms=query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean),filtered=sorted(pages.filter(p=>terms.every(t=>(p.title+'\n'+p.body).toLocaleLowerCase().includes(t))),terms);
 $('#app').innerHTML=`<section class="home"><div class="list-toolbar"><span class="summary">${query?esc(query)+' · '+filtered.length+' pages':'すべてのページ'}</span><select id="view-select" class="plain-select" aria-label="表示形式"><option value="cards">カード</option><option value="list">リスト</option></select><select id="sort-select" class="plain-select" aria-label="並び順"><option value="updated">更新日時</option><option value="created">作成日時</option><option value="title">タイトル</option></select></div><div class="cards ${view==='list'?'list-view':''}">${filtered.map(p=>card(p,terms)).join('')}</div>${!filtered.length?`<div class="empty"><h2>${query?'ページが見つかりません':'最初のページを書いてみましょう'}</h2><p>${query?'その言葉を、新しいノートに。':'気になったことを、ひとつずつ。'}</p><button class="primary" id="empty-create">${query?'「'+esc(query)+'」を作る':'新しいページ'}</button></div>`:''}</section>`;
 $('#view-select').value=view;$('#sort-select').value=sort;
 $('#view-select').onchange=e=>{view=e.target.value;localStorage.setItem('view',view);home();};$('#sort-select').onchange=e=>{sort=e.target.value;localStorage.setItem('sort',sort);home();};if($('#empty-create'))$('#empty-create').onclick=()=>newPage(query);
 highlightTerms($('.cards'),terms);renderMath($('.cards'));emit('page:changed',null);
}

// ---- ルーティング（#/page/タイトル#L行 ・ #/p/プロジェクト/page/タイトル） ----
function parseHash(){
 const hash=location.hash;let m=hash.match(/^#\/p\/([^\/#]+)(?:\/page\/([^#]*))?(?:#L(\d+))?$/);
 if(m)return {project:decode(m[1]),title:m[2]===undefined?null:decode(m[2]),line:Number(m[3]||0),bad:decode(m[1])===null||(m[2]!==undefined&&decode(m[2])===null)};
 m=hash.match(/^#\/page\/([^#]*)(?:#L(\d+))?$/);
 if(m)return {project:null,title:decode(m[1]),line:Number(m[2]||0),bad:decode(m[1])===null};
 return {project:null,title:null,line:0,bad:false};
}
async function route(){
 const token=++routeToken;if(dirty && !await save()){if(current)history.replaceState(null,'',pageHref(current.title));return;}
 if(token!==routeToken)return;closeMenu();sel=null;
 const target=parseHash();if(target.bad){location.hash='#/';return;}
 if(target.project&&target.project.toLowerCase()!==project.name.toLowerCase()){
  const other=projects.find(p=>p.name.toLowerCase()===target.project.toLowerCase());
  if(!other){toast('プロジェクトが見つかりません: '+target.project);location.hash='#/';return;}
  try{await loadProject(other.id);}catch(e){toast(e.message);return;}
  if(token!==routeToken)return;
 }
 if(target.title===null){home();return;}
 query='';$('#search').value='';
 const page=pageByTitle(target.title);
 if(!page){current={id:null,title:target.title,body:'',created:Date.now(),updated:Date.now(),rev:0,pinned:0};}
 else{current={...page};if(page.title!==target.title&&!target.project)history.replaceState(null,'',pageHref(page.title,target.line));}
 activeLine=-1;sourceMode=false;undoStack=[];redoStack=[];dirty=false;
 const draft=localStorage.getItem(draftKey(current));
 if(draft){try{const d=JSON.parse(draft);if(d.body!==current.body||d.title!==current.title){if(d.rev===current.rev){Object.assign(current,d);changed();toast('保存前の下書きを復元しました');}else{showDraft(d);}}}catch{}}
 renderPage();
 if(target.line)flashLine(target.line);else window.scrollTo(0,0);
 emit('page:changed',current.title);
}
function flashLine(number){
 const el=$(`[data-line="${number-1}"]`);if(!el)return;
 el.scrollIntoView({block:'center'});el.classList.remove('flash');void el.offsetWidth;el.classList.add('flash');
}

// ---- ページ表示 ----
function renderPage(){
 if(!current)return;document.title=current.title+' - '+project.name;
 $('#app').innerHTML=`<section class="page-layout"><article class="page-paper"><input class="page-title" id="page-title" aria-label="ページタイトル" value="${esc(current.title)}" maxlength="300" placeholder="タイトル"><div id="editor" class="editor" aria-label="ページ本文"></div><div id="editor-tail" class="editor-tail">${current.body?'':'ここに書き始めてください'}</div><div class="page-meta"><span>${current.id?'作成 '+time(current.created):'新しいページ'}</span><span id="updated-time">${current.id?'更新 '+time(current.updated):'書き始めると保存されます'}</span></div></article><aside class="page-tools"><button class="tool-button small" id="page-info" aria-label="ページ情報" title="ページ情報">ⓘ</button><button class="tool-button" id="page-menu" aria-label="ページメニュー" title="ページメニュー">≡</button><button class="tool-button small" id="random" aria-label="ランダムなページ" title="ランダムなページ">⤨</button></aside><section id="related" class="related"></section></section>`;
 $('#page-title').onfocus=()=>snapshot(true);
 $('#page-title').oninput=e=>{snapshot();current.title=e.target.value;changed();};
 $('#page-title').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();activate(0,0);}};
 $('#page-title').onblur=()=>{if(current?.title.trim())save();};
 $('#editor-tail').onclick=()=>{sel=null;const ls=current.body.split('\n');if(ls.at(-1)!==''){snapshot(true);current.body+='\n';changed();}activate(current.body.split('\n').length-1,0);};
 $('#editor').onpointerdown=e=>{
  if(e.button!==0||sourceMode)return;
  const line=e.target.closest('.line');
  if(!line||e.target.closest('a,button,.suggestions')){drag=null;return;}
  drag={start:Number(line.dataset.line),moved:false};
 };
 $('#page-menu').onclick=e=>pageMenu(e.currentTarget);$('#page-info').onclick=()=>pageInfo();$('#random').onclick=()=>{if(pages.length)location.hash=pageHref(pages[Math.floor(Math.random()*pages.length)].title);};
 const paper=$('.page-paper');paper.ondragover=e=>{e.preventDefault();$('.page-layout').classList.add('drop-active');};paper.ondragleave=()=>$('.page-layout').classList.remove('drop-active');paper.ondrop=e=>{e.preventDefault();$('.page-layout').classList.remove('drop-active');uploadImages(e.dataTransfer.files);};
 renderLines();renderRelated();
}
let whitespaceObserver;
function showWhitespace(input){
 const layer=document.createElement('div');
 layer.className='whitespace-layer';layer.setAttribute('aria-hidden','true');
 input.before(layer);
 const sync=()=>{
  const style=getComputedStyle(input);
  for(const property of ['fontFamily','fontSize','fontWeight','fontStyle','lineHeight','letterSpacing','wordSpacing','textIndent','textAlign','tabSize','paddingTop','paddingRight','paddingBottom','paddingLeft'])layer.style[property]=style[property];
  layer.style.left=input.offsetLeft+'px';layer.style.top=input.offsetTop+'px';
  layer.style.width=input.clientWidth+'px';layer.style.height=input.clientHeight+'px';
  layer.innerHTML=input.value.split('\n').map(l=>{const lead=l.match(/^[ \t　 ]*/)[0];return esc(lead)+esc(l.slice(lead.length)).replace(/[ 　 ]/g,space=>'<span class="whitespace-dot">'+space+'</span>');}).join('\n')+'​';
  layer.scrollTop=input.scrollTop;layer.scrollLeft=input.scrollLeft;
 };
 input.addEventListener('input',sync);
 input.addEventListener('scroll',()=>{layer.scrollTop=input.scrollTop;layer.scrollLeft=input.scrollLeft;});
 whitespaceObserver=new ResizeObserver(sync);whitespaceObserver.observe(input);sync();
}
function renderLines(){
 whitespaceObserver?.disconnect();
 if(sourceMode){sel=null;$('#editor').innerHTML='<textarea class="source-editor" id="source-editor" aria-label="本文のソース"></textarea>';const el=$('#source-editor');el.value=current.body;el.onfocus=()=>snapshot(true);el.oninput=()=>{snapshot();current.body=el.value;changed();};showWhitespace(el);return;}
 const ls=current.body.split('\n'),html=lineHTMLs(ls,exists),editor=$('#editor');
 // 中身が変わっていない行は作り直さずに使い回す（画像の読み直しや数式の再描画で画面がちらつかないように）
 const pool=new Map();
 for(const el of editor.children)if(el.classList.contains('line')&&el._html!=null){const list=pool.get(el._html);if(list)list.push(el);else pool.set(el._html,[el]);}
 const nodes=ls.map((l,i)=>{
  let el=pool.get(html[i])?.shift();
  if(el)el.classList.remove('active','flash');
  else{
   el=document.createElement('div');el.className='line';el.tabIndex=0;el.setAttribute('role','group');
   el.innerHTML='<button type="button" class="line-anchor" tabindex="-1" title="この行へのリンクをコピー">¶</button>'+html[i];el._html=html[i];
   el.onclick=e=>{if(justDragged||e.target.closest('a,textarea,button,.suggestions'))return;if(e.target.matches('.embedded-image')){openImage(Number(el.dataset.line),e.target);return;}sel=null;activate(Number(el.dataset.line));};
   el.onkeydown=e=>{if(e.target===el&&(e.key==='Enter'||e.key===' ')){e.preventDefault();sel=null;activate(Number(el.dataset.line));}};
  }
  if(el.dataset.line!==String(i)){el.dataset.line=i;el.setAttribute('aria-label',(i+1)+'行目');el.querySelector(':scope > .line-anchor')?.setAttribute('aria-label',(i+1)+'行目へのリンクをコピー');}
  return el;
 });
 const keep=new Set(nodes);for(const el of [...editor.children])if(!keep.has(el))el.remove();
 nodes.forEach((node,i)=>{const at=editor.children[i];if(at!==node)editor.insertBefore(node,at||null);});
 paintSelection();renderMath($('#editor'));
}
let creating=null;
async function ensurePage(){if(current.id)return;if(creating)return creating;const page=current;creating=api('/pages',{method:'POST',body:JSON.stringify({title:page.title.trim()||'無題のページ',body:''})}).then(p=>{if(p.body)throw new Error('同名ページが別のタブで作成されました。下書きをコピーして再読み込みしてください。');page.id=p.id;page.rev=p.rev;addPage(p,'push');count();}).finally(()=>creating=null);return creating;}
function activate(index,position){
 if(!current||sourceMode)return;sel=null;activeLine=index;renderLines();const line=$(`[data-line="${index}"]`);if(!line)return;
 const plain=!!line.querySelector('.line-content:not(.quote)'); // 通常の行（コード・表・引用以外）
 line.classList.add('active');line._html=null;line.innerHTML='<span class="bullet editing-bullet" hidden>•</span><textarea class="line-input" rows="1" aria-label="行を編集" spellcheck="false"></textarea><div class="suggestions" hidden></div><span class="indent-measure" aria-hidden="true"></span>';
 const input=line.querySelector('textarea');input.value=current.body.split('\n')[index]??'';
 // 編集中も、表示と同じ位置（字下げ1段＝22px）に本文を置く。字下げの空白は見えない幅として先頭に残す。
 const bullet=line.querySelector('.editing-bullet'),measure=line.querySelector('.indent-measure');
 const align=()=>{
  const lead=plain?input.value.match(/^\s*/)[0]:'',quoted=/^>/.test(input.value.slice(lead.length));
  if(!lead||quoted){input.style.paddingLeft='';input.style.textIndent='';input.style.tabSize='';bullet.hidden=true;return;}
  const pad=lead.length*22;input.style.paddingLeft=pad+'px';bullet.style.left=pad+'px';bullet.hidden=false;
  // 字下げにタブがあると、タブ幅は位置で変わるため書き出し位置をそろえられない。編集中だけタブ幅を0にする（字下げは見えない扱い）
  input.style.tabSize=lead.includes('\t')?'0':'';
  // タブの幅は置かれた位置で変わるので、同じ条件の写しで本文の書き出し位置を実測して合わせる
  const cs=getComputedStyle(input);
  for(const prop of ['fontFamily','fontSize','fontWeight','fontStyle','lineHeight','letterSpacing','wordSpacing','tabSize','paddingLeft','paddingRight'])measure.style[prop]=cs[prop];
  measure.style.width=input.clientWidth+'px';measure.style.left=input.offsetLeft+'px';measure.style.top=input.offsetTop+'px';
  measure.textContent=lead;const mark=document.createElement('span');mark.textContent='x';measure.append(mark);
  let indent=0;
  for(let k=0;k<5;k++){
   measure.style.textIndent=indent+'px';
   const dx=mark.getBoundingClientRect().left-measure.getBoundingClientRect().left-pad;
   if(Math.abs(dx)<0.25)break;indent-=dx;
  }
  input.style.textIndent=indent+'px';
 };
 const resize=()=>{align();input.style.height='0';input.style.height=Math.max(30,input.scrollHeight)+'px';};resize();input.focus();input.setSelectionRange(position??input.value.length,position??input.value.length);
 hideSuggestions();
 input.oncompositionstart=()=>composition=true;input.oncompositionend=()=>{composition=false;updateSuggestions(input);};
 input.oninput=()=>{snapshot();const ls=current.body.split('\n');ls[index]=input.value;current.body=ls.join('\n');resize();changed();updateSuggestions(input);};
 input.onkeydown=e=>lineKey(e,input,index);
 input.onpaste=e=>{const imgs=[...(e.clipboardData?.files||[])];if(imgs.length){e.preventDefault();uploadImages(imgs);return;}const text=e.clipboardData.getData('text/plain');if(text.includes('\n')){e.preventDefault();replaceInLine(input,index,text.replace(/\r/g,''));}};
 input.onblur=e=>{if(composition)return;setTimeout(()=>{if(current&&line.isConnected&&activeLine===index&&!line.contains(document.activeElement)){activeLine=-1;renderLines();renderRelated();}},0);};
 input.scrollIntoView({block:'nearest'});
 showWhitespace(input);
}
function replaceInLine(input,index,text){snapshot(true);const ls=current.body.split('\n');const next=input.value.slice(0,input.selectionStart)+text+input.value.slice(input.selectionEnd);ls.splice(index,1,...next.split('\n'));current.body=ls.join('\n');changed();const inserted=text.split('\n');activate(index+inserted.length-1,inserted.length>1?inserted.at(-1).length:input.selectionStart+text.length);}

// ---- ブロック（自分より深いインデントの行を連れて）移動 ----
function moveRange(ls,start,end,direction){
 const indent=indentOf(ls[start]);
 if(direction<0){
  if(start===0)return null;
  let target=start-1;while(target>0&&ls[target].trim()&&indentOf(ls[target])>indent)target--;
  const moved=ls.splice(start,end-start);ls.splice(target,0,...moved);return target;
 }
 if(end>=ls.length)return null;
 const next=blockEnd(ls,end),moved=ls.splice(start,end-start);ls.splice(start+(next-end),0,...moved);return start+(next-end);
}

// ---- 複数行の選択 ----
const selRange=()=>[Math.min(sel.anchor,sel.head),Math.max(sel.anchor,sel.head)];
function paintSelection(){
 document.querySelectorAll('#editor .line').forEach(el=>{const n=Number(el.dataset.line),on=!!sel&&n>=selRange()[0]&&n<=selRange()[1];el.classList.toggle('selected',on);});
}
function selectLines(anchor,head){
 const last=current.body.split('\n').length-1;
 sel={anchor:Math.max(0,Math.min(last,anchor)),head:Math.max(0,Math.min(last,head))};activeLine=-1;
 if($('.line-input'))renderLines();else paintSelection();
 window.getSelection()?.removeAllRanges();document.activeElement?.blur?.();
}
function clearSelection(){if(!sel)return;sel=null;paintSelection();}
const selectedText=()=>current.body.split('\n').slice(selRange()[0],selRange()[1]+1).join('\n');
function replaceSelectedLines(newLines,caretLine,caretPos){
 const [a,b]=selRange(),ls=current.body.split('\n');snapshot(true);ls.splice(a,b-a+1,...newLines);
 current.body=ls.join('\n');changed();sel=null;
 activate(Math.min(caretLine??a,current.body.split('\n').length-1),caretPos??0);
}
function deleteSelectedLines(){
 const [a,b]=selRange(),ls=current.body.split('\n');
 if(ls.length===b-a+1){replaceSelectedLines([''],0,0);return;}
 replaceSelectedLines([],a>0?a-1:0,a>0?ls[a-1].length:0);
}
function selectionKey(e){
 const [a,b]=selRange(),ls=current.body.split('\n'),last=ls.length-1;
 if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='a'){selectLines(0,last);return true;}
 if(e.metaKey||e.ctrlKey)return false;
 if(e.key==='Escape'){clearSelection();return true;}
 if(e.altKey&&['ArrowUp','ArrowDown'].includes(e.key)){
  const direction=e.key==='ArrowUp'?-1:1,moved=moveRange(ls,a,b+1,direction);
  if(moved===null)return true;snapshot(true);current.body=ls.join('\n');changed();
  const size=b-a;sel={anchor:moved,head:moved+size};renderLines();return true;
 }
 if(e.key==='ArrowUp'||e.key==='ArrowDown'){
  const delta=e.key==='ArrowUp'?-1:1;
  if(e.shiftKey)selectLines(sel.anchor,sel.head+delta);
  else activate(delta<0?Math.max(0,a-1):Math.min(last,b+1));
  return true;
 }
 if(e.key==='Backspace'||e.key==='Delete'){deleteSelectedLines();return true;}
 if(e.key==='Tab'){
  snapshot(true);
  for(let i=a;i<=b;i++)ls[i]=e.shiftKey?(/^\s/.test(ls[i])?ls[i].slice(1):ls[i]):' '+ls[i];
  current.body=ls.join('\n');changed();renderLines();return true;
 }
 if(e.key==='Enter'){activate(sel.head);return true;}
 if(e.key.length===1&&!e.altKey){replaceSelectedLines([e.key],a,1);return true;}
 return false;
}
function lineAtY(y){
 const lines=[...document.querySelectorAll('#editor .line')];if(!lines.length)return null;
 if(y<lines[0].getBoundingClientRect().top)return 0;
 for(const el of lines){const r=el.getBoundingClientRect();if(y>=r.top&&y<=r.bottom)return Number(el.dataset.line);}
 return lines.length-1;
}
document.addEventListener('pointermove',e=>{
 if(!drag||!(e.buttons&1)||!current)return;
 const index=lineAtY(e.clientY);if(index===null)return;
 if(!drag.moved&&index===drag.start)return;
 drag.moved=true;document.body.classList.add('selecting');selectLines(drag.start,index);
});
document.addEventListener('pointerup',()=>{
 document.body.classList.remove('selecting');
 if(drag?.moved){justDragged=true;setTimeout(()=>justDragged=false,0);}
 drag=null;
});
const editingText=e=>e.target.closest?.('input,textarea,select');
document.addEventListener('copy',e=>{if(!sel||!current||$('#dialog').open||editingText(e))return;e.clipboardData.setData('text/plain',selectedText());e.preventDefault();toast('コピーしました');});
document.addEventListener('cut',e=>{if(!sel||!current||$('#dialog').open||editingText(e))return;e.clipboardData.setData('text/plain',selectedText());e.preventDefault();deleteSelectedLines();});
document.addEventListener('paste',e=>{if(!sel||!current||$('#dialog').open||editingText(e))return;const text=e.clipboardData.getData('text/plain').replace(/\r/g,'');e.preventDefault();const lines=text.split('\n'),[a]=selRange();replaceSelectedLines(lines,a+lines.length-1,lines.at(-1).length);});

// ---- 行の編集 ----
function lineKey(e,input,index){
 if(e.isComposing||composition)return;
 if(!e.altKey&&suggestions.length){
  if(suggestionMode==='tag'){
   if(e.key==='Tab'&&!e.shiftKey){e.preventDefault();chooseSuggestion(input,suggestions[suggestionIndex]);return;}
   if(e.key==='Escape'){hideSuggestions();return;}
  }else if(['ArrowUp','ArrowDown','Enter','Escape'].includes(e.key)){
   if(e.key==='Escape'){hideSuggestions();return;}e.preventDefault();if(e.key==='Enter'){chooseSuggestion(input,suggestions[suggestionIndex]);return;}suggestionIndex=(suggestionIndex+(e.key==='ArrowDown'?1:-1)+suggestions.length)%suggestions.length;paintSuggestions(input);return;
  }
 }
 const start=input.selectionStart,end=input.selectionEnd,ls=current.body.split('\n');
 if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='a'){
  if(input.value===''||(start===0&&end===input.value.length)){e.preventDefault();selectLines(0,ls.length-1);}
  return;
 }
 if(e.key==='['){e.preventDefault();const selected=input.value.slice(start,end);replaceInLine(input,index,'['+selected+']');if(!selected){const next=$('.line-input');next.setSelectionRange(start+1,start+1);updateSuggestions(next);}return;}
 if(e.key===']'&&start===end&&input.value[start]===']'){e.preventDefault();input.setSelectionRange(start+1,start+1);hideSuggestions();return;}
 if(e.key==='Backspace'&&start===end&&input.value.slice(start-1,start+1)==='[]'){e.preventDefault();input.setSelectionRange(start-1,start+1);replaceInLine(input,index,'');return;}
 if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='b'&&start!==end){e.preventDefault();replaceInLine(input,index,'[* '+input.value.slice(start,end)+']');return;}
 if(e.altKey&&['ArrowUp','ArrowDown'].includes(e.key)){
  e.preventDefault();snapshot(true);const moved=moveRange(ls,index,blockEnd(ls,index),e.key==='ArrowUp'?-1:1);
  if(moved===null)return;current.body=ls.join('\n');changed();activate(moved,start);return;
 }
 if(e.shiftKey&&!e.altKey&&!e.metaKey&&!e.ctrlKey&&e.key==='ArrowUp'&&index>0&&(input.scrollHeight<=35||input.selectionStart===0)){e.preventDefault();selectLines(index,index-1);return;}
 if(e.shiftKey&&!e.altKey&&!e.metaKey&&!e.ctrlKey&&e.key==='ArrowDown'&&index<ls.length-1&&(input.scrollHeight<=35||input.selectionEnd===input.value.length)){e.preventDefault();selectLines(index,index+1);return;}
 if(e.key==='Enter'&&!e.metaKey&&!e.ctrlKey){e.preventDefault();snapshot(true);const prefix=input.value.match(/^\s*/)[0];if(input.value.trim()===''&&prefix){ls[index]='';current.body=ls.join('\n');changed();activate(index,0);return;}ls.splice(index,1,input.value.slice(0,start),prefix+input.value.slice(end));current.body=ls.join('\n');changed();activate(index+1,prefix.length);}
 else if(e.key==='Backspace'&&start===0&&end===0&&index>0){e.preventDefault();snapshot(true);const pos=ls[index-1].length;ls.splice(index-1,2,ls[index-1]+input.value);current.body=ls.join('\n');changed();activate(index-1,pos);}
 else if(e.key==='Delete'&&start===input.value.length&&end===start&&index<ls.length-1){e.preventDefault();snapshot(true);ls.splice(index,2,input.value+ls[index+1]);current.body=ls.join('\n');changed();activate(index,start);}
 else if(e.key==='Tab'){e.preventDefault();snapshot(true);const amount=e.shiftKey?(/^\s/.test(input.value)?-1:0):1;ls[index]=amount<0?input.value.slice(1):amount>0?' '+input.value:input.value;current.body=ls.join('\n');changed();activate(index,Math.max(0,start+amount));}
 else if(e.key==='ArrowUp'&&!e.shiftKey&&index>0&&start===end&&(start===0||input.scrollHeight<=35)){e.preventDefault();activate(index-1,Math.min(start,ls[index-1].length));}
 else if(e.key==='ArrowDown'&&!e.shiftKey&&index<ls.length-1&&start===end&&(end===input.value.length||input.scrollHeight<=35)){e.preventDefault();activate(index+1,Math.min(start,ls[index+1].length));}
 else if(e.key==='Escape'){e.preventDefault();input.blur();}
}
function hideSuggestions(){suggestions=[];document.querySelectorAll('.suggestions').forEach(el=>el.hidden=true);}
function updateSuggestions(input){
 if(composition)return;
 const before=input.value.slice(0,input.selectionStart);
 let match=before.match(/\[([^\[\]]*)$/),mode='link';
 if(!match){match=before.match(/(?:^|\s)#([^\s\[\]#]*)$/);mode='tag';}
 if(!match){hideSuggestions();return;}
 const needle=match[1].toLocaleLowerCase();
 suggestionMode=mode;suggestions=pages.map(p=>p.title).filter(t=>t.toLocaleLowerCase().includes(needle)&&titleKey(t)!==titleKey(current.title)&&(mode==='link'||!/\s/.test(t))).slice(0,7);
 suggestionIndex=0;paintSuggestions(input);
}
function paintSuggestions(input){const el=input.nextElementSibling;if(!el)return;el.hidden=!suggestions.length;el.innerHTML=suggestions.map((t,i)=>`<button class="suggestion ${i===suggestionIndex?'selected':''}" type="button">${esc(t)}</button>`).join('');el.querySelectorAll('button').forEach((button,i)=>button.onmousedown=e=>{e.preventDefault();chooseSuggestion(input,suggestions[i]);});}
function chooseSuggestion(input,title){
 const before=input.value.slice(0,input.selectionStart);
 if(suggestionMode==='tag'){const start=before.lastIndexOf('#');input.setSelectionRange(start,input.selectionEnd);hideSuggestions();replaceInLine(input,activeLine,'#'+title+' ');return;}
 const start=before.lastIndexOf('['),end=input.selectionEnd+(input.value[input.selectionEnd]===']'?1:0);input.setSelectionRange(start,end);hideSuggestions();replaceInLine(input,activeLine,'['+title+']');
}

// ---- 関連ページ ----
function renderRelated(filter=''){
 if(!current||!$('#related'))return;const titles=links(current.body),keys=titles.map(titleKey),own=titleKey(current.title);
 const backlinks=pages.filter(p=>p.id!==current.id&&linkKeys(p).includes(own)),direct=pages.filter(p=>p.id!==current.id&&keys.includes(titleKey(p.title)));
 const unique=[...new Map([...backlinks,...direct].map(p=>[p.id,p])).values()],match=p=>!filter||(p.title+' '+p.body).toLocaleLowerCase().includes(filter.toLocaleLowerCase());
 let content=`<input class="related-filter" id="related-filter" aria-label="関連ページを検索" placeholder="関連ページを検索" value="${esc(filter)}"><h3 class="related-heading">Links <span>${unique.length} pages</span></h3><div class="cards">${unique.filter(match).map(p=>card(p)).join('')}</div>`;
 const missing=titles.filter(t=>!pageByTitle(t));if(missing.length)content+='<h3 class="related-heading">New Links</h3><div class="new-links">'+missing.map(t=>`<a class="new-link" href="${pageHref(t)}">${esc(t)}</a>`).join('')+'</div>';
 for(const title of titles){const related=pages.filter(p=>p.id!==current.id&&!unique.some(x=>x.id===p.id)&&linkKeys(p).includes(titleKey(title))&&match(p));if(related.length)content+=`<h3 class="related-heading"><a href="${pageHref(title)}">${esc(title)}</a><span>${related.length} pages</span></h3><div class="cards">${related.map(p=>card(p)).join('')}</div>`;}
 if($('#related')._html===content&&!filter)return;$('#related')._html=filter?null:content;$('#related').innerHTML=content;renderMath($('#related'));$('#related-filter').oninput=e=>{const value=e.target.value,pos=e.target.selectionStart;renderRelated(value);$('#related-filter').focus();$('#related-filter').setSelectionRange(pos,pos);};
}

// ---- 数式（KaTeXを同梱・必要になった時だけ読み込む） ----
let katexLoading=null;
function loadKatex(){
 if(window.katex)return Promise.resolve(window.katex);
 if(!katexLoading)katexLoading=new Promise((resolve,reject)=>{
  const link=document.createElement('link');link.rel='stylesheet';link.href='/vendor/katex/katex.min.css';document.head.append(link);
  const script=document.createElement('script');script.src='/vendor/katex/katex.min.js';script.onload=()=>resolve(window.katex);script.onerror=()=>{katexLoading=null;reject(new Error('数式ライブラリを読み込めません'));};document.head.append(script);
 });
 return katexLoading;
}
async function renderMath(root){
 const targets=[...(root||document).querySelectorAll('code.math:not([data-rendered])')];if(!targets.length)return;
 try{
  const katex=await loadKatex();
  for(const el of targets){if(!el.isConnected)continue;el.dataset.rendered='1';try{katex.render(el.dataset.tex,el,{throwOnError:false,displayMode:false,output:'html'});el.classList.add('math-rendered');}catch{el.classList.add('math-error');}}
 }catch{}
}

// ---- メニュー・ダイアログ ----
function closeMenu(){$('#menu').hidden=true;$('#project-menu').setAttribute('aria-expanded','false');}
function menu(items,anchor){const el=$('#menu');if(!el.hidden){closeMenu();return;}el.innerHTML=items.map(item=>item==='-'?'<hr>':item.header?`<div class="menu-label">${esc(item.label)}</div>`:`<button type="button" ${item.danger?'class="danger"':''}>${esc(item.label)}</button>`).join('');const actions=items.filter(i=>i!=='-'&&!i.header);el.querySelectorAll('button').forEach((b,i)=>b.onclick=()=>{closeMenu();actions[i].action();});el.hidden=false;const r=anchor.getBoundingClientRect();el.style.left=Math.min(r.left,innerWidth-245)+'px';el.style.top=r.bottom+5+'px';$('#project-menu').setAttribute('aria-expanded','true');}
function dialog(title,content){$('#dialog-content').innerHTML=`<button class="dialog-close" aria-label="閉じる">×</button><h2>${esc(title)}</h2>${content}`;$('#dialog .dialog-close').onclick=()=>$('#dialog').close();if(!$('#dialog').open)$('#dialog').showModal();}
function confirmButton(button,label,action){
 let armed=false,timer;const original=button.textContent;
 button.onclick=()=>{if(!armed){armed=true;button.textContent=label;button.classList.add('armed');timer=setTimeout(()=>{armed=false;button.textContent=original;button.classList.remove('armed');},4000);return;}clearTimeout(timer);action();};
}
function newPage(prefill=''){dialog('新しいページ',`<form id="new-form"><input class="field" id="new-title" aria-label="新しいページのタイトル" placeholder="タイトル" value="${esc(prefill)}" required maxlength="300"><div class="dialog-actions"><button class="primary" type="submit">作成する</button></div></form>`);$('#new-form').onsubmit=async e=>{e.preventDefault();const title=$('#new-title').value.trim();if(!title)return;try{if(dirty&&!await save())return;const p=await api('/pages',{method:'POST',body:JSON.stringify({title})});addPage(p);$('#dialog').close();count();if(location.hash===pageHref(p.title))await route();else location.hash=pageHref(p.title);}catch(e){toast(e.message);}};}
function pageMenu(anchor){menu([{label:current.pinned?'ピン止めを外す':'ホームにピン止め',action:async()=>{current.pinned=current.pinned?0:1;changed();if(!await save())return;toast(current.pinned?'ホームにピン止めしました':'ピン止めを外しました');}},{label:sourceMode?'通常の編集に戻る':'本文をまとめて編集',action:()=>{sourceMode=!sourceMode;activeLine=-1;renderLines();renderRelated();}},{label:'画像を追加',action:()=>$('#image-file').click()},'-',{label:'ページのリンクをコピー',action:()=>copyText(location.origin+'/'+pageHref(current.title),'リンクをコピーしました')},{label:'編集履歴',action:showHistory},{label:'ページを複製',action:duplicate},{label:'テキストを書き出す',action:()=>download(current.title+'.txt',current.title+'\n'+current.body,'text/plain')},...(filesInfo?.reveal?[{label:'Finderで表示',action:async()=>{if(dirty&&!await save())return;api('/pages/'+current.id+'/reveal',{method:'POST',body:'{}'}).catch(e=>toast(e.message));}}]:[]),...(userMenuItems.length?['-',...userMenuItems.map(item=>({label:item.title,action:()=>{try{item.onClick();}catch(e){console.error(e);}}}))]:[]),'-',{label:'ゴミ箱に移動',danger:true,action:deletePage}],anchor);}
function projectMenu(anchor){menu([{label:'すべてのページ',action:async()=>{if(dirty&&!await save())return;query='';$('#search').value='';location.hash='#/';home();}},{label:'新しいページ',action:()=>newPage()},'-',{header:true,label:'プロジェクト'},...projects.map(p=>({label:(p.id===project.id?'✓ ':'　')+p.name+'（'+p.count+'）',action:()=>switchProject(p.id)})),{label:'　新しいプロジェクトを作る…',action:newProject},'-',{label:'JSONを読み込む',action:()=>$('#import-file').click()},{label:'JSONを書き出す',action:()=>exportJSON(false)},{label:'JSONを書き出す（画像を含む）',action:()=>exportJSON(true)},{label:'ゴミ箱',action:showTrash},...(filesInfo?.reveal?[{label:'メモのフォルダを開く',action:()=>api('/reveal',{method:'POST',body:'{}'}).catch(e=>toast(e.message))}]:[]),'-',{label:'プロジェクト設定',action:settings},{label:'書き方のヒント',action:()=>location.hash=pageHref('書き方のヒント')},...(authEnabled?['-',{label:'ログアウト',action:logout}]:[])],anchor);}
async function logout(){if(dirty&&!await save())return;try{await api('/logout',{method:'POST',body:'{}',global:true});}catch{}location.assign('/login');}
function download(filename,content,type){const native=window.webkit?.messageHandlers?.saveFile;if(native){native.postMessage({filename,content:String(content)});return;}const url=URL.createObjectURL(new Blob([content],{type}));const a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
async function copyText(text,message){try{await navigator.clipboard.writeText(text);toast(message);}catch{toast('コピーできませんでした');}}
async function exportJSON(full){if(dirty&&!await save())return;try{const data=await api('/export'+(full?'?full=1':''));download(project.name+'.json',JSON.stringify(data,null,2),'application/json');toast(full?'画像を含めてJSONを書き出しました':'JSONを書き出しました');}catch(e){toast(e.message);}}
async function showHistory(){
 if(!current?.id){toast('編集履歴はまだありません');return;}if(dirty&&!await save())return;const id=current.id;
 try{
  const rows=await api('/pages/'+id+'/history');
  const diff=(row,i)=>{
   const after=i===0?current:rows[i-1],parts=diffLines(row.body,after.body);
   const shown=parts.map((p,n)=>p.type!=='same'||(parts[n-1]&&parts[n-1].type!=='same')||(parts[n+1]&&parts[n+1].type!=='same')?p:null);
   const lines=[];let skipped=false;shown.forEach(p=>{if(!p){skipped=true;return;}if(skipped&&lines.length)lines.push('<div class="diff-gap">⋯</div>');skipped=false;lines.push(`<div class="diff-line diff-${p.type}"><span class="diff-mark">${p.type==='add'?'+':p.type==='del'?'−':'&nbsp;'}</span>${esc(p.text)||'&nbsp;'}</div>`);});
   const titleNote=row.title!==after.title?`<div class="diff-line diff-del"><span class="diff-mark">−</span>タイトル: ${esc(row.title)}</div><div class="diff-line diff-add"><span class="diff-mark">+</span>タイトル: ${esc(after.title)}</div>`:'';
   return titleNote+(parts.every(p=>p.type==='same')&&!titleNote?'<p class="dialog-note">内容の変更はありません。</p>':lines.join(''));
  };
  dialog('編集履歴',rows.length?'<p class="dialog-note">各エントリーは、その編集で変わった行を示します。過去の内容は復元できます。</p><div class="history-list">'+rows.map((r,i)=>`<details class="history-entry"><summary>${time(r.saved)} · ${esc(r.title)}</summary><div class="diff">${diff(r,i)}</div><details class="full-text"><summary>この時点の全文</summary><pre>${esc(r.body)}</pre></details><button data-restore="${i}">この内容を復元</button></details>`).join('')+'</div>':'<p class="dialog-note">編集履歴はまだありません。</p>');
  $('#dialog').querySelectorAll('[data-restore]').forEach(b=>b.onclick=async()=>{if(current?.id!==id)return;const row=rows[+b.dataset.restore];snapshot(true);current.body=row.body;current.title=row.title;changed();if(await save()){$('#dialog').close();renderPage();toast('過去の内容を復元しました');}});
 }catch(e){toast(e.message);}
}
async function duplicate(){if(dirty&&!await save())return;try{let title=current.title+' のコピー',n=2;while(pageByTitle(title))title=current.title+' のコピー '+n++;const p=await api('/pages',{method:'POST',body:JSON.stringify({title,body:current.body})});addPage(p);count();location.hash=pageHref(p.title);}catch(e){toast(e.message);}}
async function deletePage(){if(!current.id){location.hash='#/';return;}if(dirty&&!await save())return;try{await api('/pages/'+current.id,{method:'DELETE',body:'{}'});setPages(pages.filter(p=>p.id!==current.id));current=null;dirty=false;count();location.hash='#/';toast('ゴミ箱に移動しました。メニューから復元できます。');}catch(e){toast(e.message);}}
async function showTrash(){
 try{
  const rows=await api('/trash');
  dialog('ゴミ箱',`<p class="dialog-note">削除したページは、ここから復元できます。完全に削除すると元に戻せません。</p><div class="history-list">${rows.length?rows.map(p=>`<div class="trash-row"><span>${esc(p.title)}</span><span class="trash-actions"><button data-id="${p.id}">復元</button><button data-purge="${p.id}" class="danger">完全に削除</button></span></div>`).join(''):'<p class="dialog-note">ゴミ箱は空です。</p>'}</div>${rows.length?'<div class="dialog-actions"><button class="secondary danger" id="empty-trash">ゴミ箱を空にする</button></div>':''}`);
  $('#dialog').querySelectorAll('[data-id]').forEach(b=>b.onclick=async()=>{try{const p=await api('/pages/'+b.dataset.id+'/restore',{method:'POST',body:'{}'});addPage(p);count();await showTrash();if(!current)home();toast('復元しました');}catch(e){toast(e.message);}});
  $('#dialog').querySelectorAll('[data-purge]').forEach(b=>confirmButton(b,'本当に削除',async()=>{try{await api('/pages/'+b.dataset.purge+'?permanent=1',{method:'DELETE',body:'{}'});await showTrash();toast('完全に削除しました');}catch(e){toast(e.message);}}));
  if($('#empty-trash'))confirmButton($('#empty-trash'),'本当に空にする',async()=>{try{const r=await api('/trash',{method:'DELETE',body:'{}'});await showTrash();toast(r.removed+'ページを完全に削除しました');}catch(e){toast(e.message);}});
 }catch(e){toast(e.message);}
}

// ---- プロジェクト ----
function applyProject(){
 $('#project-name').textContent=project.name;$('#user-css').textContent=project.css||'';
 document.getElementById('user-js')?.remove();
 if(project.jsEnabled){const script=document.createElement('script');script.id='user-js';script.src='/user.js?project='+encodeURIComponent(project.id)+'&t='+Date.now();document.head.append(script);}
}
async function loadProject(id){
 const state=await api('/state'+(id?'?project='+encodeURIComponent(id):''),{global:true});
 setPages(state.pages);project=state.project;projects=state.projects;authEnabled=!!state.auth;filesInfo=state.files||null;
 if(filesInfo?.error&&filesWarned!==filesInfo.error){filesWarned=filesInfo.error;dialog('メモのフォルダを開けません',`<p class="dialog-note">${esc(filesInfo.error)}</p><p class="dialog-note">許可したあと、この画面を再読み込みしてください（15秒ほどで自動で再開します）。</p>`);}
 try{localStorage.setItem('project',project.id);}catch{}
 applyProject();count();connectEvents();
}
async function switchProject(id){
 if(id===project.id)return;if(dirty&&!await save())return;
 const next=projects.find(p=>p.id===id);
 try{localStorage.setItem('project',id);}catch{}
 if(project.jsEnabled||next?.jsEnabled){history.replaceState(null,'','#/');location.reload();return;}
 try{await loadProject(id);query='';$('#search').value='';current=null;if(location.hash==='#/')home();else location.hash='#/';toast(project.name+' に切り替えました');}catch(e){toast(e.message);}
}
function newProject(){
 dialog('新しいプロジェクト',`<form id="project-form"><input class="field" id="project-title" aria-label="プロジェクト名" placeholder="プロジェクト名" required maxlength="100"><p class="dialog-note">ページはプロジェクトごとに分かれます。他のプロジェクトのページには [/プロジェクト名/ページ名] でリンクできます。</p><div class="dialog-actions"><button class="primary" type="submit">作成する</button></div></form>`);
 $('#project-form').onsubmit=async e=>{e.preventDefault();try{if(dirty&&!await save())return;const result=await api('/projects',{method:'POST',body:JSON.stringify({name:$('#project-title').value}),global:true});$('#dialog').close();projects=result.projects;await switchProject(result.project.id);}catch(err){toast(err.message);}};
}
function settings(){
 dialog('プロジェクト設定',`<form id="settings-form"><label class="field-label" for="project-input">プロジェクト名</label><input class="field" id="project-input" value="${esc(project.name)}" required maxlength="100">
<label class="field-label" for="css-input">カスタムCSS（UserCSS）</label><textarea class="field code-field" id="css-input" rows="5" spellcheck="false" placeholder=".page-paper { font-size: 17px; }">${esc(project.css||'')}</textarea>
<label class="field-label"><input type="checkbox" id="js-enabled" ${project.jsEnabled?'checked':''}> UserScriptを有効にする</label>
<textarea class="field code-field" id="js-input" rows="5" spellcheck="false" placeholder="scrapbox.PageMenu.addItem({title:'文字数', onClick(){ alert(scrapbox.Page.lines.join('').length); }});">${esc(project.js||'')}</textarea>
<p class="dialog-note">UserScriptはこの画面の中で任意のコードを実行します。自分で書いた、または内容を理解しているものだけを入れてください。使える機能は scrapbox.Page / scrapbox.Project / scrapbox.PageMenu.addItem / scrapbox.on('page:changed' | 'lines:changed') です。<br>Local Scrapbox · ${filesInfo?esc('メモは '+filesInfo.dir+(project.folder?'/'+project.folder:'')+' に1ページ1つの .txt ファイルとして保存されます（ファイル名がタイトル）。ほかのアプリで編集しても反映されます。'):authEnabled?'サーバーで動くノート。':'このMacだけで動くノート。データは data/scrapbox.sqlite に保存されます。'}<br>Scrapbox / Cosenseとは独立したローカル実装です。</p>
<div class="dialog-actions">${projects.length>1?'<button type="button" class="secondary danger" id="delete-project">このプロジェクトを削除</button>':''}<button class="primary">保存</button></div></form>`);
 $('#settings-form').onsubmit=async e=>{e.preventDefault();try{
  const body={name:$('#project-input').value.trim(),css:$('#css-input').value,js:$('#js-input').value,jsEnabled:$('#js-enabled').checked},scriptChanged=body.js!==project.js||body.jsEnabled!==project.jsEnabled;
  const result=await api('/projects/'+project.id,{method:'PUT',body:JSON.stringify(body),global:true});
  project=result.project;projects=result.projects;$('#project-name').textContent=project.name;$('#user-css').textContent=project.css||'';$('#dialog').close();document.title=(current?current.title+' - ':'')+project.name;
  if(scriptChanged){toast('UserScriptを反映するため再読み込みします');setTimeout(()=>location.reload(),700);}else toast('設定を保存しました');
 }catch(err){toast(err.message);}};
 if($('#delete-project'))confirmButton($('#delete-project'),'ページも含めて完全に削除',async()=>{try{const gone=project.id,result=await api('/projects/'+gone,{method:'DELETE',body:'{}',global:true});projects=result.projects;$('#dialog').close();try{localStorage.removeItem('project');}catch{}dirty=false;history.replaceState(null,'','#/');await loadProject(projects[0].id);current=null;home();toast('プロジェクトを削除しました');}catch(err){toast(err.message);}});
}
function pageInfo(){dialog('ページ情報',`<p class="dialog-note">${esc(current.title)}</p><p class="dialog-note">作成　${time(current.created)}<br>更新　${time(current.updated)}<br>${current.body.split('\n').length} 行 · ${current.body.length} 文字<br>${links(current.body).length} リンク</p>`);}
function showDraft(d){dialog('保存前の下書きがあります',`<p class="dialog-note">別のタブでページが更新されています。下書きをコピーしてから、必要な内容を貼り付けてください。</p><textarea class="field" aria-label="復元用の下書き" rows="10">${esc(d.title+'\n'+d.body)}</textarea>`);}
// ---- 画像の拡大表示と大きさの変更（[** [画像URL]] の * の数で大きさが変わる。Scrapboxと同じ書き方） ----
const IMAGE_TOKEN=/\[(\*+)\s+\[((?:https?:\/\/|\/uploads\/)[^\s\[\]]+)\]\]|\[((?:https?:\/\/|\/uploads\/)[^\s\[\]]+)\]/g;
const isImageSource=url=>/\.(png|jpe?g|gif|webp|avif)(\?.*)?$/i.test(url)||/^https?:\/\/gyazo\.com\/[0-9a-f]{32}$/i.test(url);
function imageTokens(line){const out=[];for(const m of line.matchAll(IMAGE_TOKEN)){const url=m[2]||m[3];if(isImageSource(url))out.push({start:m.index,end:m.index+m[0].length,stars:m[1]?m[1].length:0,url});}return out;}
function openImage(lineIndex,img){
 const resizable=[...document.querySelectorAll(`.line[data-line="${lineIndex}"] .embedded-image`)].filter(x=>!x.closest('a'));
 const nth=resizable.indexOf(img);
 let viewer=$('#image-viewer');
 if(!viewer){viewer=document.createElement('div');viewer.id='image-viewer';viewer.className='image-viewer';viewer.setAttribute('role','dialog');viewer.setAttribute('aria-label','画像');document.body.append(viewer);}
 const render=()=>{
  const token=imageTokens(current.body.split('\n')[lineIndex]??'')[nth];
  const level=token?Math.max(1,token.stars):1;
  viewer.innerHTML=`<img src="${esc(img.src)}" alt="画像"><div class="image-viewer-bar">${token?`<button type="button" data-step="-1" aria-label="小さく" ${level<=1?'disabled':''}>−</button><span>大きさ ${level}</span><button type="button" data-step="1" aria-label="大きく" ${level>=8?'disabled':''}>＋</button>`:''}<a href="${esc(img.src)}" target="_blank" rel="noopener noreferrer">元の画像を開く</a><button type="button" class="image-viewer-close" aria-label="閉じる">×</button></div>`;
  viewer.querySelectorAll('[data-step]').forEach(b=>b.onclick=e=>{e.stopPropagation();resizeImage(lineIndex,nth,Number(b.dataset.step));render();});
  viewer.querySelector('.image-viewer-close').onclick=close;
 };
 const close=()=>{viewer.hidden=true;document.removeEventListener('keydown',onKey,true);};
 const onKey=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();}};
 viewer.onclick=e=>{if(e.target===viewer)close();};
 document.addEventListener('keydown',onKey,true);
 viewer.hidden=false;render();
}
function resizeImage(lineIndex,nth,step){
 const ls=current.body.split('\n'),line=ls[lineIndex]??'',token=imageTokens(line)[nth];if(!token)return;
 const level=Math.min(8,Math.max(1,Math.max(1,token.stars)+step));
 const next=level<=1?`[${token.url}]`:`[${'*'.repeat(level)} [${token.url}]]`;
 snapshot(true);ls[lineIndex]=line.slice(0,token.start)+next+line.slice(token.end);current.body=ls.join('\n');changed();renderLines();
}
async function uploadImages(files){if(!current)return;const target=current;for(const file of [...files]){try{if(file.size>10*1024*1024)throw new Error('画像は10MBまでです');const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(file);});const result=await api('/upload',{method:'POST',body:JSON.stringify({data})});if(current!==target){toast('画像の追加先ページに戻ってから、再度追加してください');return;}snapshot(true);const ls=current.body.split('\n'),token='['+result.url+']',input=activeLine>=0?$('.line-input'):null;
if(input){const line=activeLine,from=input.selectionStart,to=input.selectionEnd;ls[line]=input.value.slice(0,from)+token+input.value.slice(to);current.body=ls.join('\n');changed();activate(line,from+token.length);}
else{ls.push(token);current.body=ls.join('\n');changed();activeLine=-1;renderLines();}
toast('画像を追加しました');}catch(e){toast(e.message);}}}

// ---- 別のタブ・ウインドウでの変更を反映 ----
let events,refreshTimer;
function connectEvents(){
 events?.close();
 if(!window.EventSource)return;
 events=new EventSource('/api/events?project='+encodeURIComponent(project.id));
 events.onmessage=e=>{let data={};try{data=JSON.parse(e.data);}catch{}if(data.type==='projects')refreshProjects();scheduleRefresh();};
}
async function refreshProjects(){try{const r=await api('/projects',{global:true});projects=r.projects;}catch{}}
function scheduleRefresh(delay=300){clearTimeout(refreshTimer);refreshTimer=setTimeout(refresh,delay);}
async function refresh(){
 if(savePromise||creating){scheduleRefresh();return;}
 try{
  const state=await api('/state');
  if(savePromise||creating||dirty){scheduleRefresh(1500);return;}
  project={...project,...state.project};projects=state.projects;
  const before=pages.map(p=>p.id+':'+p.rev).join();setPages(state.pages);count();
  $('#project-name').textContent=project.name;$('#user-css').textContent=project.css||'';
  if(!current){if(before!==pages.map(p=>p.id+':'+p.rev).join()&&!$('#dialog').open)home();return;}
  if(!current.id||dirty)return;
  const fresh=pages.find(p=>p.id===current.id);
  if(!fresh){toast('このページは別の場所で削除されました');current=null;location.hash='#/';return;}
  if(fresh.rev===current.rev)return;
  const caret=$('.line-input')?.selectionStart,line=activeLine;
  current={...fresh};undoStack=[];redoStack=[];
  $('#page-title').value=current.title;renderLines();renderRelated();
  if(line>=0&&line<current.body.split('\n').length)activate(line,caret);
  $('#updated-time').textContent='更新 '+time(current.updated);
  toast('別のタブでの変更を反映しました');
 }catch{}
}

// ---- 全体のイベント ----
$('#project-menu').onclick=e=>projectMenu(e.currentTarget);$('#new-page').onclick=()=>newPage();$('#help').onclick=()=>location.hash=pageHref('書き方のヒント');$('#profile').onclick=settings;$('#save-status').onclick=()=>save();
$('#search').oninput=async e=>{query=e.target.value;if(dirty&&!await save())return;if(location.hash!=='#/')history.replaceState(null,'','#/');home();};
$('#search').onkeydown=async e=>{if(e.key==='Escape'){if(dirty&&!await save())return;e.target.value='';query='';history.replaceState(null,'','#/');home();e.target.blur();}if(e.key==='Enter'){const first=$('.card');if(first)location.hash=first.getAttribute('href');else if(query)newPage(query);}};
$('#dialog').addEventListener('click',e=>{if(e.target===$('#dialog')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();}});
document.addEventListener('click',e=>{
 if(!e.target.closest('#menu,#project-menu,#page-menu'))closeMenu();
 const play=e.target.closest('.embed-play');
 if(play){const holder=play.closest('.embed-youtube'),id=holder.dataset.youtube;if(/^[\w-]{11}$/.test(id))holder.innerHTML=`<iframe class="youtube-frame" src="https://www.youtube-nocookie.com/embed/${id}?autoplay=1" title="YouTube" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;return;}
 const anchor=e.target.closest('.line-anchor');
 if(anchor&&current){const number=Number(anchor.closest('.line').dataset.line)+1;history.replaceState(null,'',pageHref(current.title,number));copyText(location.origin+'/'+pageHref(current.title,number),number+'行目へのリンクをコピーしました');flashLine(number);return;}
 const copy=e.target.closest('.copy-code');
 if(copy&&current){const ls=current.body.split('\n'),range=codeBlockRange(ls,Number(copy.closest('.line').dataset.line));if(range)copyText(ls.slice(range.start+1,range.end).map(l=>l.replace(/^\t|^ /,'')).join('\n'),'コードをコピーしました');}
});
document.addEventListener('keydown',e=>{
 if(e.isComposing)return;
 if(sel&&current&&!$('#dialog').open&&!editingText(e)&&selectionKey(e)){e.preventDefault();return;}
 if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();$('#search').focus();$('#search').select();}
 if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){e.preventDefault();newPage();}
 if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='s'){e.preventDefault();save();}
 if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='z'&&current&&!$('#dialog').open){e.preventDefault();const from=e.shiftKey?redoStack:undoStack,to=e.shiftKey?undoStack:redoStack;if(from.length){to.push({title:current.title,body:current.body});Object.assign(current,from.pop());changed();const line=activeLine;sel=null;renderPage();if(line>=0)activate(Math.min(line,current.body.split('\n').length-1));}}
 if(e.key==='Escape')closeMenu();
});
$('#import-file').onchange=async e=>{const file=e.target.files[0];e.target.value='';if(!file)return;try{if(dirty&&!await save())return;const data=JSON.parse(await file.text());const result=await api('/import',{method:'POST',body:JSON.stringify(data)});setPages(result.pages);count();if(!current)home();else renderRelated();toast(`${result.added}ページを読み込みました${result.skipped?'（同名の'+result.skipped+'ページは変更せずスキップ）':''}${result.images?'・画像'+result.images+'枚を復元':''}`);}catch(e){toast(e.message);}};
$('#image-file').onchange=e=>{uploadImages(e.target.files);e.target.value='';};
window.addEventListener('hashchange',route);window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&dirty)save();});
async function start(){
 try{
  let stored='';try{stored=localStorage.getItem('project')||'';}catch{}
  try{await loadProject(stored);}catch{await loadProject('');}
  await route();status('すべてローカルに保存済み');
 }catch(e){$('#app').innerHTML='<div class="empty"><h2>ノートを開けませんでした</h2><p>'+esc(e.message)+'</p><button id="retry" class="primary">再試行</button></div>';$('#retry').onclick=start;status('接続できません',true);}
}
function registerAgentTools(){
 const context=document.modelContext;
 if(!context?.registerTool)return;
 const tools=[{
  name:'search_local_pages',title:'ローカルノートを検索',
  description:'Search page titles and text in this local notebook. Returns titles and short excerpts without changing data.',
  inputSchema:{type:'object',properties:{query:{type:'string'}},required:['query'],additionalProperties:false},
  annotations:{readOnlyHint:true,untrustedContentHint:true},
  execute(input){if(!input||typeof input.query!=='string')throw new Error('query must be a string');const terms=input.query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);return {pages:pages.filter(p=>terms.every(t=>(p.title+'\n'+p.body).toLocaleLowerCase().includes(t))).slice(0,30).map(p=>({title:p.title,excerpt:p.body.slice(0,180)}))};}
 },{
  name:'start_local_page_creation',title:'新しいページの作成画面を開く',
  description:'Open the new-page dialog with a proposed title. Does not create a page until the user submits the form.',
  inputSchema:{type:'object',properties:{title:{type:'string',minLength:1,maxLength:300}},required:['title'],additionalProperties:false},
  annotations:{readOnlyHint:false,untrustedContentHint:false},
  execute(input){if(!input||typeof input.title!=='string'||!input.title.trim()||input.title.length>300)throw new Error('A title of 1–300 characters is required');newPage(input.title);return {status:'creation_dialog_open'};}
 }];
 for(const tool of tools){try{Promise.resolve(context.registerTool(tool)).catch(()=>{});}catch{}}
}
start().then(registerAgentTools);
// Macアプリの中では「ブラウザで開く」ボタンを出す（今のページをふだん使いのブラウザで開く）
{const native=window.webkit?.messageHandlers?.openInBrowser;
 if(native){const b=document.createElement('button');b.id='open-browser';b.className='nav-button browser-button';b.type='button';b.title='ブラウザで開く（⇧⌘B）';b.setAttribute('aria-label','ブラウザで開く');b.textContent='↗';
  b.onclick=async()=>{if(dirty)await save();native.postMessage(location.href);};
  $('#new-page').before(b);}}
// Macアプリのメニュー（ファイル → 新規ページ ⌘N）から呼ばれる
window.scrapboxNewPage=()=>newPage();
// Macアプリを終了する前に、入力中の内容を保存しきる
window.scrapboxFlush=async()=>{try{if(savePromise)await savePromise;if(dirty)await save();}catch{}return true;};
