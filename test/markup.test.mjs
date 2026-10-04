import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inline,links,lineHTML,lineHTMLs,contexts,renameReferences,titleKey,splitLink,firstImage,blockEnd,codeBlockRange,diffLines,pageHref} from '../public/markup.js';

test('titles ignore case and space/underscore differences',()=>{
 assert.equal(titleKey('Foo Bar'),titleKey('foo_bar'));
 assert.equal(titleKey('  ＡＢ  '),'ａｂ');
 assert.notEqual(titleKey('a'),titleKey('b'));
});
test('bare URLs become links without swallowing trailing punctuation',()=>{
 const html=inline('見て https://example.com/a?b=1#c. 次(https://example.com/x_(y))です。');
 assert.match(html,/href="https:\/\/example\.com\/a\?b=1#c"[^>]*>https:\/\/example\.com\/a\?b=1#c<\/a>\./);
 assert.match(html,/href="https:\/\/example\.com\/x_\(y\)"/);
 assert.ok(!inline('xhttps://example.com').includes('<a '));
 assert.ok(!inline('http://').includes('<a '));
 assert.match(inline('https://a.example/"><script>'),/&quot;/);
});
test('double brackets are bold and their inner text is not a link',()=>{
 assert.match(inline('[[太字]]'),/class="strong"[^>]*>太字</);
 assert.deepEqual(links('[[太字]] [リンク] [* [入れ子]]'),['リンク','入れ子']);
});
test('icon notation renders images from the linked page and repeats',()=>{
 const exists=t=>t==='Alice'?{icon:'/uploads/a.png'}:false;
 const html=inline('[Alice.icon*2] [Bob.icon]',exists);
 assert.equal((html.match(/class="icon-image"/g)||[]).length,2);
 assert.match(html,/icon missing[^>]*><span class="icon-fallback">B<\/span>/);
 assert.deepEqual(links('[Alice.icon*3] [Bob.icon]'),['Alice','Bob']);
 assert.ok(!inline('[X.icon]',()=>({icon:'javascript:alert(1)'})).includes('javascript:'));
 assert.deepEqual(splitLink('Alice.icon*3'),{title:'Alice',icon:3,line:null});
 assert.deepEqual(splitLink('Page#L12'),{title:'Page',icon:0,line:12});
});
test('images may be linked in either order and gyazo links expand',()=>{
 assert.match(inline('[https://e.com https://e.com/i.png]'),/<a class="external" href="https:\/\/e\.com"[^>]*><img class="embedded-image" loading="lazy" src="https:\/\/e\.com\/i\.png"/);
 assert.match(inline('[https://e.com/i.png https://e.com]'),/<a class="external" href="https:\/\/e\.com"[^>]*><img/);
 assert.match(inline('[https://gyazo.com/0123456789abcdef0123456789abcdef]'),/src="https:\/\/gyazo\.com\/0123456789abcdef0123456789abcdef\/raw"/);
 assert.equal(firstImage('前\n[/uploads/a.png]\n[https://e.com/b.jpg]'),'/uploads/a.png');
 assert.equal(firstImage('画像なし [リンク]'),null);
});
test('math, youtube and project links use inert markup',()=>{
 assert.match(inline('[$ a^2 "x"]'),/<code class="math" data-tex="a\^2 &quot;x&quot;">/);
 assert.match(inline('[https://youtu.be/dQw4w9WgXcQ]'),/data-youtube="dQw4w9WgXcQ"/);
 assert.match(inline('[https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3]'),/data-youtube="dQw4w9WgXcQ"/);
 assert.ok(!inline('[https://youtu.be/short]').includes('data-youtube'));
 assert.match(inline('[/proj x/Page 1]'),/href="#\/p\/proj%20x\/page\/Page%201"/);
 assert.deepEqual(links('[/proj/Page] [$ x]'),[]);
});
test('page links may target a line and links with labels are not pages',()=>{
 assert.match(inline('[ページ#L3]',()=>true),/href="#\/page\/%E3%83%9A%E3%83%BC%E3%82%B8#L3"/);
 assert.equal(pageHref('A B',4),'#/page/A%20B#L4');
 assert.deepEqual(links('[ページ#L3] [名前 https://example.org] [Foo bar]'),['ページ','Foo bar']);
});
test('renaming matches titles case-insensitively and keeps suffixes',()=>{
 assert.equal(renameReferences('[foo] [FOO.icon*2] [foo#L3] #Foo [[foo]] `[foo]`','Foo','新'),'[新] [新.icon*2] [新#L3] #新 [[foo]] `[foo]`');
});
test('code blocks are highlighted per language without leaking markup',()=>{
 const html=lineHTMLs(['code:a.js',' const s = "<b>"; // hi',' /* multi',' line */ x()','','code:none',' const y'],()=>true);
 assert.match(html[1],/tok-k">const</);
 assert.match(html[1],/tok-s">&quot;&lt;b&gt;&quot;</);
 assert.match(html[1],/tok-c">\/\/ hi</);
 assert.match(html[2],/tok-c">\/\* multi</);
 assert.match(html[3],/tok-c">line \*\/</);
 assert.match(html[3],/tok-f">x</);
 assert.ok(!html[6].includes('tok-'));
 assert.match(html[0],/block-name">a\.js</);
 assert.match(html[0],/copy-code/);
});
test('block helpers find children and code ranges',()=>{
 const ls=['A',' a1','  a2',' a3','B','code:x',' 1',' 2','','C'];
 assert.equal(blockEnd(ls,0),4);assert.equal(blockEnd(ls,1),3);assert.equal(blockEnd(ls,4),5);
 assert.deepEqual(codeBlockRange(ls,6),{start:5,end:8});
 assert.deepEqual(codeBlockRange(ls,5),{start:5,end:8});
 assert.equal(codeBlockRange(ls,0),null);
});
test('line diff marks added, removed and unchanged lines',()=>{
 assert.deepEqual(diffLines('a\nb\nc','a\nx\nc'),[{type:'same',text:'a'},{type:'del',text:'b'},{type:'add',text:'x'},{type:'same',text:'c'}]);
 assert.deepEqual(diffLines('','a').map(d=>d.type),['del','add']);
 assert.ok(diffLines(Array(3000).fill('x').join('\n'),Array(3000).fill('y').join('\n')).length>0);
});

test('star decoration around an image carries its level for sizing',()=>{
 const html=lineHTML('  [***** [https://example.com/a.png]][https://example.com/b.png]',()=>true);
 assert.match(html,/padding-left:44px/);
 assert.match(html,/class="strong size-4 level-5[^"]*"><img class="embedded-image"[^>]*a\.png/);
 assert.equal((html.match(/embedded-image/g)||[]).length,2);
});
