export const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Scrapboxと同じく、タイトルは大文字小文字と空白/アンダースコアの違いを区別しない
export const titleKey = title => String(title).trim().toLowerCase().replace(/\s/g, '_');
export const pageHref = (title, line) => '#/page/' + encodeURIComponent(title) + (line ? '#L' + line : '');
export const projectHref = (project, title, line) => '#/p/' + encodeURIComponent(project) + (title ? '/page/' + encodeURIComponent(title) + (line ? '#L' + line : '') : '');
const safeURL = s => /^(https?:\/\/|\/uploads\/)/i.test(s);
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif)(\?.*)?$/i;
const isImageURL = s => safeURL(s) && !/\s/.test(s) && IMAGE_EXT.test(s);
const isHttpURL = s => /^https?:\/\/\S+$/.test(s);
const GYAZO = /^https?:\/\/gyazo\.com\/([0-9a-f]{32})$/i;
const YOUTUBE = /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/watch\?(?:[^\s#]*&)?v=|youtu\.be\/)([\w-]{11})(?:[&?#]\S*)?$/;
const LINK_SKIP = /^(https?:|\/uploads\/|[*\-\/~_$]|\/.+\/)|\shttps?:\/\/\S+$/;

// [ページ名] [ページ名.icon] [ページ名.icon*3] [ページ名#L12] を分解する
export function splitLink(value) {
  let title = value, icon = 0, line = null;
  const l = title.match(/^(.+?)#L(\d+)$/);
  if (l) { title = l[1]; line = Number(l[2]); }
  const i = title.match(/^(.+)\.icon(?:\*(\d+))?$/);
  if (i) { title = i[1]; icon = Math.min(Number(i[2] || 1), 20); }
  return { title, icon, line };
}
// [[太字]] のように角括弧一組全体が内側を包んでいるか
function wrapsGroup(inner) {
  if (inner[0] !== '[' || inner.at(-1) !== ']') return false;
  let level = 0;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '[') level++;
    if (inner[i] === ']' && --level === 0) return i === inner.length - 1;
  }
  return false;
}
export function firstImage(body) {
  const m = body.match(/\[((?:https?:\/\/|\/uploads\/)[^\s\[\]]+\.(?:png|jpe?g|gif|webp|avif)(?:\?[^\s\[\]]*)?)\]/i) || body.match(/\[(https?:\/\/gyazo\.com\/[0-9a-f]{32})\]/i);
  if (!m) return null;
  const g = m[1].match(GYAZO);
  return g ? 'https://gyazo.com/' + g[1] + '/raw' : m[1];
}

export function links(text) {
  const result = new Set();
  let inCode = false;
  for (let line of text.split('\n')) {
    if (!/^\s/.test(line)) inCode = line.startsWith('code:');
    if (inCode || /^table:/.test(line)) continue;
    line = line.replace(/`[^`]*`/g, '');
    for (const match of line.matchAll(/\[([^\[\]\n]+)\]|(?:^|\s)#([^\s\[\]#]+)/g)) {
      // [[太字]] の内側 [太字] はリンクではない
      if (match[1] !== undefined && line[match.index - 1] === '[' && line[match.index + match[0].length] === ']') continue;
      const value = match[1] ?? match[2];
      if (!LINK_SKIP.test(value)) result.add(splitLink(value).title);
    }
  }
  return [...result];
}

function imageHTML(src) { return '<img class="embedded-image" loading="lazy" src="' + escapeHTML(src) + '" alt="添付画像">'; }
function externalHTML(url, label) { return '<a class="external" href="' + escapeHTML(url) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>'; }
function iconHTML(title, found, count) {
  const src = found && typeof found === 'object' && found.icon && safeURL(found.icon) ? found.icon : '';
  const inner = src ? '<img class="icon-image" loading="lazy" src="' + escapeHTML(src) + '" alt="' + escapeHTML(title) + '">' : '<span class="icon-fallback">' + escapeHTML([...title][0] || '?') + '</span>';
  return ('<a class="page-link icon ' + (found ? '' : 'missing') + '" href="' + pageHref(title) + '" title="' + escapeHTML(title) + '">' + inner + '</a>').repeat(count);
}
function bareURL(text, i) {
  if (text[i] !== 'h' || !/^https?:\/\//.test(text.slice(i, i + 8)) || (i > 0 && /[A-Za-z0-9]/.test(text[i - 1]))) return null;
  const match = text.slice(i).match(/^https?:\/\/[A-Za-z0-9\-._~:\/?#@!$&'()*+,;=%]+/);
  if (!match) return null;
  let url = match[0];
  for (;;) {
    const last = url.at(-1);
    if (/[.,;:!?'*]/.test(last) || (last === ')' && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length)) url = url.slice(0, -1);
    else break;
  }
  return /^https?:\/\/.+\S/.test(url) && url.length > 8 ? url : null;
}

export function inline(text, exists = () => true, depth = 0) {
  if (depth > 8) return escapeHTML(text);
  let out = '', i = 0;
  while (i < text.length) {
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i) { out += '<code>' + escapeHTML(text.slice(i + 1, end)) + '</code>'; i = end + 1; continue; }
    }
    if (text[i] === '[') {
      let level = 1, end = i + 1;
      for (; end < text.length && level; end++) { if (text[end] === '[') level++; if (text[end] === ']') level--; }
      if (!level) {
        const inner = text.slice(i + 1, end - 1), deco = inner.match(/^([*\-\/~_]+)\s([\s\S]*)$/);
        const parts = inner.match(/^(\S+)\s+(\S+)$/);
        if (deco) {
          const stars = (deco[1].match(/\*/g) || []).length;
          const classes = [stars ? 'strong size-' + Math.min(stars, 4) + ' level-' + Math.min(stars, 8) : '', deco[1].includes('-') ? 'strike' : '', deco[1].includes('/') ? 'italic' : '', deco[1].includes('_') ? 'underline' : '', deco[1].includes('~') ? 'muted' : ''].join(' ');
          out += '<span class="' + classes + '">' + inline(deco[2], exists, depth + 1) + '</span>';
        } else if (wrapsGroup(inner)) {
          out += '<span class="strong">' + inline(inner.slice(1, -1), exists, depth + 1) + '</span>';
        } else if (GYAZO.test(inner)) {
          out += imageHTML('https://gyazo.com/' + inner.match(GYAZO)[1] + '/raw');
        } else if (YOUTUBE.test(inner)) {
          out += '<span class="embed-youtube" data-youtube="' + inner.match(YOUTUBE)[1] + '"><button type="button" class="embed-play">▶ YouTubeを再生</button> ' + externalHTML(inner, escapeHTML(inner)) + '</span>';
        } else if (isImageURL(inner)) {
          out += imageHTML(inner);
        } else if (parts && isHttpURL(parts[1]) && isImageURL(parts[2])) {
          out += externalHTML(parts[1], imageHTML(parts[2]));
        } else if (parts && isImageURL(parts[1]) && isHttpURL(parts[2])) {
          out += externalHTML(parts[2], imageHTML(parts[1]));
        } else if (/^https?:\/\//.test(inner)) {
          const split = inner.indexOf(' '), url = split < 0 ? inner : inner.slice(0, split), label = split < 0 ? inner : inner.slice(split + 1);
          out += externalHTML(url, escapeHTML(label));
        } else if (/\shttps?:\/\//.test(inner)) {
          const match = inner.match(/^(.*?)\s(https?:\/\/\S+)$/);
          out += match ? externalHTML(match[2], escapeHTML(match[1])) : escapeHTML(text.slice(i, end));
        } else if (inner.startsWith('$ ')) {
          out += '<code class="math" data-tex="' + escapeHTML(inner.slice(2)) + '">' + escapeHTML(inner.slice(2)) + '</code>';
        } else if (/^\/[^\/\s][^\/]*\/.+/.test(inner) && !inner.startsWith('/uploads/')) {
          const [, project, title] = inner.match(/^\/([^\/]+)\/(.+)$/);
          out += '<a class="page-link project-link" href="' + projectHref(project, title) + '">' + escapeHTML(inner) + '</a>';
        } else if (inner && !inner.includes('[')) {
          const link = splitLink(inner), found = exists(link.title);
          if (link.icon) out += iconHTML(link.title, found, link.icon);
          else out += '<a class="page-link ' + (found ? '' : 'missing') + '" href="' + pageHref(link.title, link.line) + '">' + escapeHTML(inner) + '</a>';
        } else out += escapeHTML(text.slice(i, end));
        i = end; continue;
      }
    }
    const url = bareURL(text, i);
    if (url) { out += externalHTML(url, escapeHTML(url)); i += url.length; continue; }
    if (text[i] === '#' && (i === 0 || /\s/.test(text[i-1]))) {
      const match = text.slice(i).match(/^#([^\s\[\]#]+)/);
      if (match) { out += '<a class="tag" href="' + pageHref(match[1]) + '">#' + escapeHTML(match[1]) + '</a>'; i += match[0].length; continue; }
    }
    out += escapeHTML(text[i++]);
  }
  return out;
}

// ---- コードブロックの色分け（外部ライブラリなし） ----
const words = s => new Set(s.split(/\s+/));
const C_LIKE = { kw: words('if else for while do switch case break continue return new class struct enum union interface implements extends public private protected static final const let var void int long short char float double bool boolean string true false null nil this self super import export from package use fn func function mod impl trait pub mut match where async await try catch finally throw throws typeof instanceof in of default delete yield namespace using go defer chan select'), line: ['//'], block: ['/*', '*/'], str: ['"', "'", '`'] };
const HASH_LIKE = { kw: words('if elif else fi then for do done while until case esac in function def class return import from as with try except finally raise lambda pass break continue yield not and or is None True False self async await global nonlocal end begin unless module require echo export local true false nil'), line: ['#'], str: ['"', "'"] };
const LANGS = {
  js: C_LIKE, ts: C_LIKE, jsx: C_LIKE, tsx: C_LIKE, mjs: C_LIKE, cjs: C_LIKE, javascript: C_LIKE, typescript: C_LIKE, c: C_LIKE, h: C_LIKE, cpp: C_LIKE, hpp: C_LIKE, cc: C_LIKE, cs: C_LIKE, java: C_LIKE, kt: C_LIKE, kotlin: C_LIKE, swift: C_LIKE, go: C_LIKE, rs: C_LIKE, rust: C_LIKE, php: C_LIKE, scala: C_LIKE, dart: C_LIKE, ino: C_LIKE, glsl: C_LIKE,
  py: HASH_LIKE, python: HASH_LIKE, sh: HASH_LIKE, bash: HASH_LIKE, zsh: HASH_LIKE, rb: HASH_LIKE, ruby: HASH_LIKE, pl: HASH_LIKE, r: HASH_LIKE, yml: HASH_LIKE, yaml: HASH_LIKE, toml: HASH_LIKE, ini: HASH_LIKE, conf: HASH_LIKE, makefile: HASH_LIKE,
  json: { kw: words('true false null'), str: ['"'] },
  sql: { kw: words('select from where and or not insert into values update set delete create table drop alter join left right inner outer on group by order having limit as distinct union null is in like between exists case when then else end primary key foreign references index unique default'), ci: true, line: ['--'], block: ['/*', '*/'], str: ["'", '"'] },
  lua: { kw: words('and break do else elseif end false for function if in local nil not or repeat return then true until while'), line: ['--'], str: ['"', "'"] },
  css: { kw: words('important'), block: ['/*', '*/'], str: ['"', "'"], at: true },
  scss: { kw: words('important'), line: ['//'], block: ['/*', '*/'], str: ['"', "'"], at: true },
  html: { kw: words(''), block: ['<!--', '-->'], str: ['"', "'"], tags: true }, xml: { kw: words(''), block: ['<!--', '-->'], str: ['"', "'"], tags: true }, svg: { kw: words(''), block: ['<!--', '-->'], str: ['"', "'"], tags: true }
};
export const codeName = line => line.replace(/^code:/, '').trim();
export function langOf(name) {
  const lower = name.toLowerCase(), ext = lower.includes('.') ? lower.split('.').pop() : lower;
  return LANGS[ext] || null;
}
function tokenizeLine(line, def, state) {
  let out = '', i = 0;
  const emit = (cls, s) => { out += cls ? '<span class="tok-' + cls + '">' + escapeHTML(s) + '</span>' : escapeHTML(s); };
  while (i < line.length) {
    if (state.block) {
      const end = line.indexOf(def.block[1], i);
      if (end < 0) { emit('c', line.slice(i)); i = line.length; } else { emit('c', line.slice(i, end + def.block[1].length)); i = end + def.block[1].length; state.block = false; }
      continue;
    }
    if (def.block && line.startsWith(def.block[0], i)) {
      const end = line.indexOf(def.block[1], i + def.block[0].length);
      if (end < 0) { emit('c', line.slice(i)); i = line.length; state.block = true; }
      else { emit('c', line.slice(i, end + def.block[1].length)); i = end + def.block[1].length; }
      continue;
    }
    const lc = (def.line || []).find(m => line.startsWith(m, i));
    if (lc) { emit('c', line.slice(i)); i = line.length; continue; }
    const ch = line[i];
    if (def.str.includes(ch)) {
      let j = i + 1;
      while (j < line.length && line[j] !== ch) j += line[j] === '\\' ? 2 : 1;
      emit('s', line.slice(i, Math.min(j + 1, line.length))); i = Math.min(j + 1, line.length); continue;
    }
    if (def.tags) { const t = line.slice(i).match(/^<\/?[A-Za-z][\w:-]*|^\/?>/); if (t) { emit('k', t[0]); i += t[0].length; continue; } }
    if (def.at) { const a = line.slice(i).match(/^@[\w-]+/); if (a) { emit('k', a[0]); i += a[0].length; continue; } }
    const num = line.slice(i).match(/^(?:0x[0-9a-f]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)/i);
    if (num && (i === 0 || !/[\w$]/.test(line[i - 1]))) { emit('n', num[0]); i += num[0].length; continue; }
    const word = line.slice(i).match(/^[A-Za-z_$][\w$]*/);
    if (word) {
      const w = word[0], key = def.ci ? w.toLowerCase() : w;
      emit(def.kw.has(key) ? 'k' : line[i + w.length] === '(' ? 'f' : '', w); i += w.length; continue;
    }
    emit('', ch); i++;
  }
  return out;
}

export function lineHTML(line, exists, context = {}) {
  if (context.code) return '<code class="code-line">' + (context.highlighted ?? escapeHTML(line.replace(/^\t|^ /, ''))) + '</code>';
  if (context.table) return '<div class="table-row">' + line.trim().split('\t').map(cell => '<span>' + inline(cell,exists) + '</span>').join('') + '</div>';
  if (/^code:/.test(line)) return '<span class="block-label"><span class="block-name">' + escapeHTML(codeName(line)) + '</span><button type="button" class="copy-code" title="コードをコピー">コピー</button></span>';
  if (/^table:/.test(line)) return '<span class="block-label"><span class="block-name">' + escapeHTML(line.slice(6).trim()) + '</span></span>';
  const indent = (line.match(/^\s*/) || [''])[0].length;
  let content = line.slice(indent);
  const quoted = content.startsWith('>');
  if (quoted) content = content.replace(/^>\s?/, '');
  return '<span class="line-content ' + (quoted ? 'quote' : '') + '" style="padding-left:' + indent * 22 + 'px">' + (indent && !quoted ? '<span class="bullet">•</span>' : '') + (inline(content,exists) || '<br>') + '</span>';
}
export function contexts(lines) {
  let block = '';
  return lines.map(line => {
    if (!/^\s/.test(line)) block = line.startsWith('code:') ? 'code' : line.startsWith('table:') ? 'table' : '';
    return /^\s/.test(line) && block ? {[block]: true} : {};
  });
}
// ページ全体をHTMLにする（コードブロックの色分けは行をまたぐ状態を持つため、まとめて処理する）
export function lineHTMLs(lines, exists) {
  const ctx = contexts(lines);
  let def = null, state = null;
  return lines.map((line, i) => {
    if (!/^\s/.test(line) && line.startsWith('code:')) { def = langOf(codeName(line)); state = { block: false }; }
    if (ctx[i].code) {
      const text = line.replace(/^\t|^ /, '');
      return lineHTML(line, exists, { ...ctx[i], highlighted: def ? tokenizeLine(text, def, state) : escapeHTML(text) });
    }
    return lineHTML(line, exists, ctx[i]);
  });
}
// 行番号 index から始まるブロック（自分より深いインデントが続く範囲）の終端 (含まない)
export function blockEnd(lines, index) {
  const indent = line => line.match(/^\s*/)[0].length;
  const base = indent(lines[index]);
  let end = index + 1;
  while (end < lines.length && lines[end].trim() && indent(lines[end]) > base) end++;
  return end;
}
export function codeBlockRange(lines, index) {
  const ctx = contexts(lines);
  if (!ctx[index].code && !(!/^\s/.test(lines[index]) && lines[index].startsWith('code:'))) return null;
  let start = index;
  while (start > 0 && !(!/^\s/.test(lines[start]) && lines[start].startsWith('code:'))) start--;
  let end = start + 1;
  while (end < lines.length && ctx[end].code) end++;
  return { start, end };
}

export function renameReferences(body, oldTitle, newTitle) {
  const ls = body.split('\n'), ctx = contexts(ls), key = titleKey(oldTitle);
  return ls.map((line, i) => {
    if (ctx[i].code || line.startsWith('code:')) return line;
    return line.split(/(`[^`]*`)/g).map((part, j) => {
      if (j % 2) return part;
      return part.replace(/\[([^\[\]\n]+)\]/g, (whole, title, offset, whole_part) => {
        if (whole_part[offset - 1] === '[' && whole_part[offset + whole.length] === ']') return whole;
        if (LINK_SKIP.test(title)) return whole;
        const link = splitLink(title);
        return titleKey(link.title) === key ? '[' + newTitle + title.slice(link.title.length) + ']' : whole;
      }).replace(/(^|\s)#([^\s\[\]#]+)/g, (whole, space, tag) => titleKey(tag) === key ? space + (/\s/.test(newTitle) ? '[' + newTitle + ']' : '#' + newTitle) : whole);
    }).join('');
  }).join('\n');
}

// 行単位の差分（編集履歴の表示用）
export function diffLines(before, after) {
  const a = before.split('\n'), b = after.split('\n');
  if (a.length * b.length > 4e6) return [...a.map(text => ({ type: 'del', text })), ...b.map(text => ({ type: 'add', text }))];
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ type: 'same', text: a[i] }); i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) out.push({ type: 'del', text: a[i++] });
    else out.push({ type: 'add', text: b[j++] });
  }
  while (i < a.length) out.push({ type: 'del', text: a[i++] });
  while (j < b.length) out.push({ type: 'add', text: b[j++] });
  return out;
}
