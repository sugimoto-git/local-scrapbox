import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { seed } from './seed.mjs';
import { renameReferences, titleKey } from './public/markup.js';
import { verifyPassword, createSession, checkSession, parseCookies, createLimiter } from './auth.mjs';
import { createFileStore } from './filestore.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.SCRAPBOX_DATA_DIR || path.join(root, 'data');
// Macアプリ版: メモを1ページ1ファイルの .txt としてこのフォルダに保存する（未設定ならデータベースだけに保存）
const NOTES_DIR = process.env.SCRAPBOX_NOTES_DIR ? path.resolve(process.env.SCRAPBOX_NOTES_DIR) : null;
const uploadsDir = process.env.SCRAPBOX_UPLOADS_DIR ? path.resolve(process.env.SCRAPBOX_UPLOADS_DIR) : path.join(dataDir, 'uploads');
// ---- 公開設定（既定はこのMacだけ：127.0.0.1 ＋ ログインなし） ----
//   HOST            待ち受けアドレス（既定 127.0.0.1）
//   PORT            ポート（既定 3210）
//   ALLOWED_HOSTS   localhost 以外に許可するホスト名（カンマ区切り。例: notes.example.com）
//   TRUST_PROXY=1   Nginx等の背後で動かす（X-Forwarded-Proto / X-Forwarded-For を信頼する）
// ホストの許可やlocalhost以外への待ち受けは、パスワード（data/auth.json）を設定しないと起動しません。
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3210);
const EXTRA_HOSTS = (process.env.ALLOWED_HOSTS || '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const SESSION_MS = 30 * 24 * 3600 * 1000;
const SCHEMA_VERSION = 2;
const IMAGE_LIMIT = 10 * 1024 * 1024;
mkdirSync(dataDir, { recursive: true });
try { mkdirSync(uploadsDir, { recursive: true }); } catch (e) { console.error('画像フォルダを作れません: ' + e.message); }
function loadAuth() {
  const file = path.join(dataDir, 'auth.json');
  if (!existsSync(file)) return null;
  try { const a = JSON.parse(readFileSync(file, 'utf8')); if (typeof a.hash === 'string' && typeof a.secret === 'string' && a.secret.length >= 32) return a; } catch {}
  console.error('auth.json を読み取れません。node set-password.mjs で設定し直してください。'); process.exit(1);
}
const auth = loadAuth();
if (!auth && (EXTRA_HOSTS.length || !['127.0.0.1', 'localhost', '::1'].includes(HOST))) {
  console.error('外部に公開するには、先にパスワードを設定してください:\n  SCRAPBOX_DATA_DIR=' + dataDir + ' node set-password.mjs'); process.exit(1);
}
const limiter = createLimiter();
const db = new DatabaseSync(path.join(dataDir, 'scrapbox.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS pages (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', created INTEGER, updated INTEGER, pinned INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0, rev INTEGER DEFAULT 1);
 CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY, page_id TEXT, title TEXT, body TEXT, saved INTEGER);
 CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
 CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created INTEGER, css TEXT NOT NULL DEFAULT '', js TEXT NOT NULL DEFAULT '', js_enabled INTEGER NOT NULL DEFAULT 0);
`);

function transaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const v = fn(); db.exec('COMMIT'); return v; } catch (e) { db.exec('ROLLBACK'); throw e; } }
function fail(status, message) { throw Object.assign(new Error(message), { status }); }

// v1 (単一プロジェクト・大文字小文字を区別するタイトル) から v2 への移行。
// 既存のページがある場合は、移行前にデータフォルダへ完全なバックアップを残す。
function migrate() {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version >= SCHEMA_VERSION) return;
  if (db.prepare('SELECT COUNT(*) n FROM pages').get().n > 0) {
    const file = path.join(dataDir, `backup-before-v${SCHEMA_VERSION}-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
    db.prepare('VACUUM INTO ?').run(file);
    console.log('移行前のバックアップ: ' + file);
  }
  transaction(() => {
    const columns = db.prepare('PRAGMA table_info(pages)').all().map(c => c.name);
    if (!columns.includes('project_id')) db.exec('ALTER TABLE pages ADD COLUMN project_id TEXT');
    if (!columns.includes('title_key')) db.exec('ALTER TABLE pages ADD COLUMN title_key TEXT');
    db.exec('DROP INDEX IF EXISTS active_title');
    let project = db.prepare('SELECT * FROM projects ORDER BY created, rowid LIMIT 1').get();
    if (!project) {
      const name = db.prepare("SELECT value FROM settings WHERE key='projectName'").get()?.value || 'my-notes';
      project = { id: randomUUID(), name };
      db.prepare('INSERT INTO projects(id,name,created) VALUES(?,?,?)').run(project.id, project.name, Date.now());
    }
    db.prepare('UPDATE pages SET project_id=? WHERE project_id IS NULL').run(project.id);
    // 大文字小文字だけが違う既存タイトルが衝突する場合は、後のページに (2) を付けて両方残す。
    const used = new Set();
    for (const row of db.prepare('SELECT id,title,project_id,deleted FROM pages ORDER BY deleted, created, rowid').all()) {
      let title = row.title, key = titleKey(title);
      if (!row.deleted) {
        for (let n = 2; used.has(row.project_id + '\0' + key); n++) { title = `${row.title} (${n})`; key = titleKey(title); }
        used.add(row.project_id + '\0' + key);
      }
      db.prepare('UPDATE pages SET title=?,title_key=? WHERE id=?').run(title, key, row.id);
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS active_title_key ON pages(project_id, title_key) WHERE deleted=0');
    db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
  });
}
migrate();

const defaultProject = () => db.prepare('SELECT * FROM projects ORDER BY created, rowid LIMIT 1').get();
function saveHistory(p) { db.prepare('INSERT INTO history(page_id,title,body,saved) VALUES(?,?,?,?)').run(p.id, p.title, p.body, Date.now()); }
const files = NOTES_DIR ? createFileStore({ db, dir: NOTES_DIR, dataDir, saveHistory, renameLinks: (...a) => renameLinks(...a), notify: (...a) => notify(...a) }) : null;
const sync = pid => { try { files?.push(pid); } catch (e) { console.error('ファイルへの書き出しに失敗しました:', e); } };
if (!db.prepare("SELECT value FROM settings WHERE key='initialized'").get() && files && !files.isEmpty()) db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('initialized', 'true');
if (!db.prepare("SELECT value FROM settings WHERE key='initialized'").get()) {
  const insert = db.prepare('INSERT INTO pages(id,title,title_key,body,created,updated,pinned,project_id) VALUES(?,?,?,?,?,?,?,?)');
  const now = Date.now(), pid = defaultProject().id;
  for (let i = 0; i < seed.length; i++) insert.run(randomUUID(), seed[i].title, titleKey(seed[i].title), seed[i].body, now - i * 3600000, now - i * 3600000, seed[i].pinned ? 1 : 0, pid);
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('initialized', 'true');
}

const projects = () => db.prepare('SELECT p.id, p.name, p.js_enabled AS jsEnabled, (SELECT COUNT(*) FROM pages g WHERE g.project_id=p.id AND g.deleted=0) AS count FROM projects p ORDER BY p.created, p.rowid').all();
const projectInfo = p => ({ id: p.id, name: p.name, css: p.css, js: p.js, jsEnabled: !!p.js_enabled, folder: p.folder ?? undefined });
function projectFrom(url) {
  const id = url.searchParams.get('project');
  if (!id) return defaultProject();
  return db.prepare('SELECT * FROM projects WHERE id=?').get(id) || fail(404, 'プロジェクトがありません');
}
const all = pid => db.prepare('SELECT * FROM pages WHERE project_id=? AND deleted=0 ORDER BY updated DESC').all(pid);
const trashed = pid => db.prepare('SELECT * FROM pages WHERE project_id=? AND deleted=1 ORDER BY updated DESC').all(pid);
const get = id => db.prepare('SELECT * FROM pages WHERE id=?').get(id);
const byKey = (pid, title) => db.prepare('SELECT * FROM pages WHERE project_id=? AND title_key=? AND deleted=0').get(pid, titleKey(title));
function titleOf(title) { if (typeof title !== 'string' || !title.trim() || title.length > 300 || /[\r\n]/.test(title)) fail(400, 'タイトルは1〜300文字で入力してください'); return title.trim(); }
function bodyOf(body) { if (typeof body !== 'string' || body.length > 2000000) fail(400, '本文が不正、または長すぎます'); return body; }
function projectNameOf(name, selfId) {
  if (typeof name !== 'string' || !name.trim() || name.length > 100 || /[\r\n\/]/.test(name)) fail(400, 'プロジェクト名は「/」を含まない1〜100文字で入力してください');
  const trimmed = name.trim();
  if (projects().some(p => p.id !== selfId && p.name.toLowerCase() === trimmed.toLowerCase())) fail(409, '同じ名前のプロジェクトが既にあります');
  return trimmed;
}
function timestamp(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value < 1e11 ? Math.round(value * 1000) : Math.round(value); // Scrapboxは秒、内部はミリ秒
}
function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }
async function readJSON(req, limit = 30 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) fail(413, `ファイルが大きすぎます（上限${Math.round(limit / 1024 / 1024)}MB）`); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'JSONを読み取れません'); }
}
function renameLinks(pid, oldTitle, newTitle) {
  for (const p of all(pid)) {
    const next = renameReferences(p.body, oldTitle, newTitle);
    if (next !== p.body) { saveHistory(p); db.prepare('UPDATE pages SET body=?,updated=?,rev=rev+1 WHERE id=?').run(next, Date.now(), p.id); }
  }
}

// 別のタブ・ウインドウへ変更を知らせる（Server-Sent Events）
const clients = new Set();
function notify(projectId, data = { type: 'changed' }) {
  const message = `data: ${JSON.stringify({ project: projectId, ...data })}\n\n`;
  for (const client of clients) if (!projectId || client.projectId === projectId) client.res.write(message);
}
setInterval(() => { for (const client of clients) client.res.write(': ping\n\n'); }, 25000).unref();

const IMAGE_URL = /\/uploads\/[\w-]+\.(?:png|jpg|gif|webp)/g;
function exportProject(project, full) {
  const pages = all(project.id), out = {
    name: project.name, displayName: project.name, exported: Math.floor(Date.now() / 1000),
    pages: pages.map(p => ({ id: p.id, title: p.title, created: Math.floor(p.created / 1000), updated: Math.floor(p.updated / 1000), pin: !!p.pinned, lines: [p.title, ...p.body.split('\n')] }))
  };
  if (full) {
    out.images = {};
    for (const p of pages) for (const url of p.body.match(IMAGE_URL) || []) {
      const file = path.join(uploadsDir, path.basename(url));
      if (out.images[url] || !existsSync(file)) continue;
      const ext = path.extname(url).slice(1);
      out.images[url] = `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${readFileSync(file).toString('base64')}`;
    }
  }
  return out;
}
// ---- 外部の画像（Scrapbox・Gyazo）を手元に取り込む ----
// ページ内の https://scrapbox.io/files/… と Gyazo の画像をダウンロードして画像フォルダに保存し、本文のリンクを手元の画像に書き換える。
// 非公開のScrapboxプロジェクトでは、呼び出し側が渡した connect.sid を scrapbox.io への問い合わせにだけ使う（保存しない）。
const REMOTE_IMAGE = /https:\/\/(?:scrapbox\.io\/files\/[0-9a-f]{24,32}\.(?:png|jpe?g|gif|webp)|gyazo\.com\/[0-9a-f]{32}(?:\/raw)?|i\.gyazo\.com\/[0-9a-f]{32}\.(?:png|jpe?g|gif|webp))/gi;
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
function localName(url) {
  const m = url.match(/scrapbox\.io\/files\/([0-9a-f]+)/i) || url.match(/gyazo\.com\/([0-9a-f]{32})/i);
  return (url.includes('scrapbox.io') ? 'scrapbox-' : 'gyazo-') + m[1].toLowerCase();
}
async function downloadImage(url, cookie) {
  let target = /^https:\/\/gyazo\.com\/[0-9a-f]{32}$/i.test(url) ? url + '/raw' : url;
  if (process.env.SCRAPBOX_REMOTE_ORIGIN) target = target.replace(/^https:\/\/[^/]+/, process.env.SCRAPBOX_REMOTE_ORIGIN); // テスト用
  const headers = { 'User-Agent': 'LocalScrapbox/1.0' };
  if (cookie && /^https:\/\/scrapbox\.io\//i.test(url)) headers.Cookie = 'connect.sid=' + cookie;
  const res = await fetch(target, { headers, redirect: 'follow', signal: AbortSignal.timeout(30000) });
  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (res.status === 401 || res.status === 403 || (res.ok && type.startsWith('text/html'))) return { auth: true, status: res.status };
  if (!res.ok) return { status: res.status };
  if (!IMAGE_TYPES[type]) return { status: 'unsupported ' + type };
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > 30 * 1024 * 1024) return { status: 'too large' };
  return { bytes, ext: IMAGE_TYPES[type] };
}
async function localizeImages(pid, cookie) {
  const pages = all(pid), urls = new Set();
  for (const p of pages) for (const group of p.body.match(/\[[^\[\]\n]*\]/g) || []) for (const m of group.matchAll(REMOTE_IMAGE)) urls.add(m[0]);
  const mapped = new Map(), failed = [];
  let downloaded = 0, reused = 0, needAuth = false;
  const queue = [...urls];
  const worker = async () => {
    for (let url; (url = queue.shift());) {
      const base = localName(url);
      const existing = ['png', 'jpg', 'gif', 'webp'].map(ext => base + '.' + ext).find(name => existsSync(path.join(uploadsDir, name)));
      if (existing) { mapped.set(url, '/uploads/' + existing); reused++; continue; }
      try {
        const r = await downloadImage(url, cookie);
        if (r.bytes) { writeFileSync(path.join(uploadsDir, base + '.' + r.ext), r.bytes); mapped.set(url, '/uploads/' + base + '.' + r.ext); downloaded++; }
        else { if (r.auth) needAuth = true; failed.push({ url, status: r.status }); }
      } catch (e) {
        if (/redirect/i.test(String(e.cause?.message || e.message))) needAuth = true; // ログインページへの転送が続く
        failed.push({ url, status: e.name === 'TimeoutError' ? 'timeout' : String(e.cause?.message || e.message) });
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  let changed = 0;
  transaction(() => {
    for (const p of all(pid)) {
      // 角括弧の中（[URL] / [*** [URL]] / [リンク URL]）だけを書き換える。本文にむき出しのURLはリンクの文字なので残す
      const body = p.body.replace(/\[[^\[\]\n]*\]/g, group => group.replace(REMOTE_IMAGE, url => {
        const local = mapped.get(url);
        return local && new RegExp(`[\\[\\s]${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\]\\s])`).test(group) ? local : url;
      }));
      if (body !== p.body) { saveHistory(p); db.prepare('UPDATE pages SET body=?,rev=rev+1 WHERE id=?').run(body, p.id); changed++; }
    }
  });
  return { found: urls.size, downloaded, reused, failed, needAuth, pagesChanged: changed, dir: uploadsDir };
}
function restoreImages(images) {
  let restored = 0;
  if (!images || typeof images !== 'object') return restored;
  for (const [url, data] of Object.entries(images)) {
    const name = String(url).match(/^\/uploads\/([\w-]+\.(png|jpg|gif|webp))$/), image = String(data).match(/^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/=]+)$/);
    if (!name || !image || (image[1] === 'jpeg' ? 'jpg' : image[1]) !== name[2]) continue;
    const file = path.join(uploadsDir, name[1]);
    if (existsSync(file)) continue;
    const bytes = Buffer.from(image[2], 'base64');
    if (bytes.length > IMAGE_LIMIT) continue;
    writeFileSync(file, bytes); restored++;
  }
  return restored;
}
function importPages(pid, input) {
  if (!input || !Array.isArray(input.pages) || input.pages.length > 10000) fail(400, 'Scrapbox形式のJSONを選んでください');
  const incoming = input.pages.map(p => {
    const title = titleOf(p?.title);
    if (!Array.isArray(p.lines) || !p.lines.every(x => typeof x === 'string' || (x && typeof x.text === 'string'))) fail(400, 'ページの行データが不正です');
    const lines = p.lines.map(x => typeof x === 'string' ? x : x.text);
    if (lines[0] === title) lines.shift();
    return { title, body: bodyOf(lines.join('\n')), pinned: p.pin ? 1 : 0, created: timestamp(p.created), updated: timestamp(p.updated) };
  });
  let added = 0, skipped = 0;
  transaction(() => {
    for (const p of incoming) {
      if (byKey(pid, p.title)) { skipped++; continue; }
      const now = Date.now(), created = p.created ?? p.updated ?? now, updated = p.updated ?? created;
      db.prepare('INSERT INTO pages(id,title,title_key,body,created,updated,pinned,project_id) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), p.title, titleKey(p.title), p.body, created, updated, p.pinned, pid);
      added++;
    }
  });
  return { added, skipped, images: restoreImages(input.images) };
}

const STATIC = ['/', '/index.html', '/app.js', '/markup.js', '/style.css', '/favicon.svg', '/login.js'];
const VENDOR = /^\/vendor\/katex\/(?:katex\.min\.(?:js|css)|LICENSE|fonts\/[\w.-]+\.woff2)$/;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: http: data:; font-src 'self'; frame-src https://www.youtube-nocookie.com; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

export const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host || '', hostname = host.replace(/:\d+$/, '').toLowerCase(), extra = EXTRA_HOSTS.includes(hostname);
    if (!/^(127\.0\.0\.1|localhost)$/.test(hostname) && !extra) fail(403, 'Local access only');
    if (req.headers.origin && req.headers.origin !== `http://${host}` && !(extra && req.headers.origin === `https://${host}`)) fail(403, 'Origin not allowed');
    const url = new URL(req.url, `http://${host}`), route = url.pathname, method = req.method;
    const secure = TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https';
    const clientKey = TRUST_PROXY ? (String(req.headers['x-forwarded-for'] || '').split(',').at(-1).trim() || req.socket.remoteAddress) : req.socket.remoteAddress;
    const loggedIn = !auth || checkSession(auth.secret, parseCookies(req.headers.cookie).sb_session);
    const cookie = (value, maxAge) => `sb_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
    // 他のサイト（同じlocalhostの別ポートを含む）からのAPI・UserScript取得を拒否する
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none' && (route.startsWith('/api/') || route === '/user.js')) fail(403, 'Origin not allowed');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const openRoute = ['/login', '/login.js', '/style.css', '/favicon.svg', '/api/login', '/api/logout', '/api/session'].includes(route);
    if (!loggedIn && !openRoute) {
      if (route.startsWith('/api/') || route === '/user.js' || route.startsWith('/uploads/') || route.startsWith('/vendor/')) fail(401, 'ログインが必要です');
      res.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' }); return res.end();
    }
    if (route.startsWith('/api/')) {
      if (method !== 'GET' && !req.headers['content-type']?.startsWith('application/json')) fail(415, 'JSON required');
      if (files && method !== 'GET' && !['/api/login', '/api/logout'].includes(route) && !files.check()) fail(503, files.error);
      if (route === '/api/session' && method === 'GET') return json(res, 200, { authRequired: !!auth, authenticated: loggedIn });
      if (route === '/api/login' && method === 'POST') {
        if (!auth) fail(404, 'ログインは設定されていません');
        if (limiter.blocked(clientKey)) fail(429, '失敗が続いたため、しばらく待ってからやり直してください');
        const input = await readJSON(req);
        if (typeof input.password !== 'string' || input.password.length > 1000 || !verifyPassword(input.password, auth.hash)) {
          limiter.fail(clientKey); await new Promise(resolve => setTimeout(resolve, 400)); fail(401, 'パスワードが違います');
        }
        limiter.clear(clientKey);
        res.setHeader('Set-Cookie', cookie(createSession(auth.secret, SESSION_MS), SESSION_MS / 1000));
        return json(res, 200, { ok: true });
      }
      if (route === '/api/logout' && method === 'POST') { res.setHeader('Set-Cookie', cookie('', 0)); return json(res, 200, { ok: true }); }
      if (route === '/api/events' && method === 'GET') {
        const client = { res, projectId: projectFrom(url).id };
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write('retry: 2000\n\n');
        clients.add(client);
        req.on('close', () => clients.delete(client));
        return;
      }
      if (route === '/api/state' && method === 'GET') {
        files?.run();
        const project = projectFrom(url);
        return json(res, 200, { pages: all(project.id), projectName: project.name, project: projectInfo(project), projects: projects(), auth: !!auth, files: files ? { dir: files.dir, error: files.error, reveal: process.platform === 'darwin' } : null });
      }
      if (route === '/api/projects' && method === 'GET') return json(res, 200, { projects: projects() });
      if (route === '/api/projects' && method === 'POST') {
        const input = await readJSON(req), id = randomUUID();
        db.prepare('INSERT INTO projects(id,name,created) VALUES(?,?,?)').run(id, projectNameOf(input.name), Date.now());
        files?.projectCreated(id);
        notify(null, { type: 'projects' });
        return json(res, 201, { project: projectInfo(db.prepare('SELECT * FROM projects WHERE id=?').get(id)), projects: projects() });
      }
      const projectMatch = route.match(/^\/api\/projects\/([\w-]+)$/);
      if (projectMatch) {
        const project = db.prepare('SELECT * FROM projects WHERE id=?').get(projectMatch[1]) || fail(404, 'プロジェクトがありません');
        if (method === 'PUT') {
          const input = await readJSON(req);
          const name = input.name === undefined ? project.name : projectNameOf(input.name, project.id);
          const css = input.css === undefined ? project.css : typeof input.css === 'string' && input.css.length <= 500000 ? input.css : fail(400, 'CSSが不正、または長すぎます');
          const js = input.js === undefined ? project.js : typeof input.js === 'string' && input.js.length <= 500000 ? input.js : fail(400, 'スクリプトが不正、または長すぎます');
          const enabled = input.jsEnabled === undefined ? project.js_enabled : input.jsEnabled ? 1 : 0;
          db.prepare('UPDATE projects SET name=?,css=?,js=?,js_enabled=? WHERE id=?').run(name, css, js, enabled, project.id);
          if (name !== project.name) files?.projectRenamed(project.id);
          notify(null, { type: 'projects' });
          return json(res, 200, { project: projectInfo(db.prepare('SELECT * FROM projects WHERE id=?').get(project.id)), projects: projects() });
        }
        if (method === 'DELETE') {
          if (projects().length < 2) fail(409, '最後のプロジェクトは削除できません');
          if (files?.isRoot(project.id)) fail(409, 'このプロジェクトはメモのフォルダ直下のファイルなので削除できません');
          files?.projectDeleted(project);
          transaction(() => {
            db.prepare('DELETE FROM history WHERE page_id IN (SELECT id FROM pages WHERE project_id=?)').run(project.id);
            db.prepare('DELETE FROM pages WHERE project_id=?').run(project.id);
            db.prepare('DELETE FROM projects WHERE id=?').run(project.id);
          });
          notify(null, { type: 'projects' });
          return json(res, 200, { projects: projects() });
        }
      }
      if (route === '/api/reveal' && method === 'POST') return json(res, 200, { ok: !!files?.reveal(null, projectFrom(url).id) });
      if (route === '/api/trash' && method === 'GET') return json(res, 200, trashed(projectFrom(url).id));
      if (route === '/api/trash' && method === 'DELETE') {
        const project = projectFrom(url);
        const removed = transaction(() => {
          db.prepare('DELETE FROM history WHERE page_id IN (SELECT id FROM pages WHERE project_id=? AND deleted=1)').run(project.id);
          return Number(db.prepare('DELETE FROM pages WHERE project_id=? AND deleted=1').run(project.id).changes);
        });
        return json(res, 200, { removed });
      }
      if (route === '/api/export' && method === 'GET') return json(res, 200, exportProject(projectFrom(url), url.searchParams.get('full') === '1'));
      if (route === '/api/pages' && method === 'POST') {
        const project = projectFrom(url), input = await readJSON(req), title = titleOf(input.title), existing = byKey(project.id, title);
        if (existing) return json(res, 200, existing);
        const id = randomUUID(), now = Date.now();
        db.prepare('INSERT INTO pages(id,title,title_key,body,created,updated,project_id) VALUES(?,?,?,?,?,?,?)').run(id, title, titleKey(title), bodyOf(input.body ?? ''), now, now, project.id);
        sync(project.id);
        notify(project.id);
        return json(res, 201, get(id));
      }
      const match = route.match(/^\/api\/pages\/([\w-]+)(?:\/(history|restore|reveal))?$/);
      if (match) {
        const p = get(match[1]); if (!p) fail(404, 'ページがありません');
        if (match[2] === 'history' && method === 'GET') return json(res, 200, db.prepare('SELECT * FROM history WHERE page_id=? ORDER BY id DESC LIMIT 100').all(p.id));
        if (match[2] === 'reveal' && method === 'POST') return json(res, 200, { ok: !!files?.reveal(p.id) });
        if (match[2] === 'restore' && method === 'POST') {
          db.prepare('UPDATE pages SET deleted=0,updated=?,rev=rev+1 WHERE id=?').run(Date.now(), p.id);
          sync(p.project_id);
          notify(p.project_id);
          return json(res, 200, get(p.id));
        }
        if (!match[2] && method === 'PUT') {
          const input = await readJSON(req);
          if (p.deleted) fail(409, 'このページは削除されています');
          if (input.rev !== p.rev) fail(409, '別のタブで更新されました。内容をコピーして再読み込みしてください。');
          const title = titleOf(input.title), body = bodyOf(input.body);
          transaction(() => {
            saveHistory(p);
            db.prepare('UPDATE pages SET title=?,title_key=?,body=?,pinned=?,updated=?,rev=rev+1 WHERE id=?').run(title, titleKey(title), body, input.pinned ? 1 : 0, Date.now(), p.id);
            if (title !== p.title) renameLinks(p.project_id, p.title, title);
          });
          sync(p.project_id);
          notify(p.project_id);
          return json(res, 200, { page: get(p.id), pages: all(p.project_id) });
        }
        if (!match[2] && method === 'DELETE') {
          if (url.searchParams.get('permanent')) {
            if (!p.deleted) fail(409, 'ゴミ箱にあるページだけ完全に削除できます');
            transaction(() => { db.prepare('DELETE FROM history WHERE page_id=?').run(p.id); db.prepare('DELETE FROM pages WHERE id=?').run(p.id); });
            return json(res, 200, { ok: true });
          }
          saveHistory(p);
          db.prepare('UPDATE pages SET deleted=1,updated=?,rev=rev+1 WHERE id=?').run(Date.now(), p.id);
          sync(p.project_id);
          notify(p.project_id);
          return json(res, 200, { ok: true });
        }
      }
      if (route === '/api/settings' && method === 'PUT') {
        const project = projectFrom(url), input = await readJSON(req);
        db.prepare('UPDATE projects SET name=? WHERE id=?').run(projectNameOf(input.projectName, project.id), project.id);
        files?.projectRenamed(project.id);
        notify(null, { type: 'projects' });
        return json(res, 200, { ok: true });
      }
      if (route === '/api/import' && method === 'POST') {
        const project = projectFrom(url), result = importPages(project.id, await readJSON(req, 300 * 1024 * 1024));
        if (result.added) { sync(project.id); notify(project.id); }
        return json(res, 200, { ...result, pages: all(project.id) });
      }
      if (route === '/api/localize-images' && method === 'POST') {
        const project = projectFrom(url), input = await readJSON(req);
        const cookie = typeof input.cookie === 'string' && /^[\w%.:+\/=-]{10,1000}$/.test(input.cookie.trim()) ? input.cookie.trim() : '';
        const result = await localizeImages(project.id, cookie);
        if (result.pagesChanged) { sync(project.id); notify(project.id); }
        return json(res, 200, result);
      }
      if (route === '/api/upload' && method === 'POST') {
        const input = await readJSON(req), m = String(input.data).match(/^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/=]+)$/);
        if (!m) fail(400, 'PNG・JPEG・GIF・WebP画像を選んでください');
        const bytes = Buffer.from(m[2], 'base64'); if (bytes.length > IMAGE_LIMIT) fail(413, '画像は10MBまでです');
        const filename = randomUUID() + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
        writeFileSync(path.join(uploadsDir, filename), bytes);
        return json(res, 201, { url: '/uploads/' + filename });
      }
      fail(404, 'Not found');
    }
    if (method !== 'GET' && method !== 'HEAD') fail(405, 'Method not allowed');
    if (route === '/user.js') {
      const project = projectFrom(url);
      res.writeHead(200, { 'Content-Type': TYPES['.js'], 'Cache-Control': 'no-store' });
      return res.end(method === 'HEAD' ? undefined : project.js_enabled ? project.js : '// UserScriptは無効です\n');
    }
    if (route === '/login' && (!auth || loggedIn)) { res.writeHead(302, { Location: '/' }); return res.end(); }
    let filename;
    if (/^\/uploads\/[\w-]+\.(png|jpg|gif|webp)$/.test(route)) filename = path.join(uploadsDir, path.basename(route));
    else if (route === '/login') filename = path.join(root, 'public', 'login.html');
    else if (STATIC.includes(route)) filename = path.join(root, 'public', route === '/' ? 'index.html' : route);
    else if (VENDOR.test(route)) filename = path.join(root, 'public', route);
    else fail(404, 'Not found');
    if (!existsSync(filename)) fail(404, 'Not found');
    res.setHeader('Content-Security-Policy', CSP);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(filename)] || 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(method === 'HEAD' ? undefined : readFileSync(filename));
  } catch (e) {
    const conflict = String(e.message).includes('UNIQUE constraint');
    json(res, conflict ? 409 : e.status || 500, { error: conflict ? '同じタイトルのページが既にあります' : e.status ? e.message : '保存処理に失敗しました' });
    if (!e.status && !conflict) console.error(e);
  }
});
files?.start();
server.listen(PORT, HOST, () => console.log(`Local Scrapbox: http://${HOST}:${server.address().port}\n保存先: ${files ? files.dir + '（メモ） / ' + dataDir + '（履歴・設定）' : dataDir}${files?.error ? '\n⚠ ' + files.error : ''}${auth ? '\nログイン: 有効' : ''}`));
