// メモを「1ページ＝1つの .txt ファイル」としてフォルダに保存する（Macアプリ版で使用）。
//   ファイル名 = ページのタイトル、中身 = 本文。最初のプロジェクトはフォルダ直下、ほかのプロジェクトはサブフォルダ。
//   データベースは、編集履歴・ゴミ箱・ピン止め・設定などの付帯情報と検索用に使い、本文の正本はファイル。
//   アプリでの変更はすぐファイルへ書き、ほかのアプリでの編集・名前変更・削除はアプリへ取り込む。
//   自分が書いた内容と違うファイル（ほかで編集されたもの）は、上書き・削除せずに「競合」コピーとして残す。
import { readdirSync, statSync, readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync, watch, cpSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { titleKey } from './public/markup.js';

const EXT = '.txt';
const MAX_FILE = 2_000_000;
const hash = text => createHash('sha256').update(text).digest('hex');
const lower = name => name.normalize('NFC').toLowerCase();
const hidden = name => name.startsWith('.');
const toFileText = body => body + '\n';
export function fromFileText(text) {
  let t = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  return t.endsWith('\n') ? t.slice(0, -1) : t;
}

// タイトル ⇄ ファイル名。Macのファイル名に使えない・紛らわしい文字だけを全角に置き換える。
function safeName(text, suffix) {
  let base = text.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\//g, '／').replace(/:/g, '：').trim();
  if (base.startsWith('.')) base = '．' + base.slice(1);
  if (!base) base = 'untitled';
  while (Buffer.byteLength(base + suffix) > 240) base = [...base].slice(0, -1).join('');
  return base + suffix;
}
export const fileNameFor = title => safeName(title, EXT);
export const folderNameFor = name => safeName(name, '');
export function titleFromFileName(name) {
  return name.normalize('NFC').replace(/\.txt$/i, '').replace(/ ~\d+$/, '').replace(/／/g, '/').replace(/：/g, ':').replace(/^．/, '.').trim();
}
const sameFile = (a, b) => { try { const x = statSync(a), y = statSync(b); return x.ino === y.ino && x.dev === y.dev; } catch { return false; } };
const diskHash = file => { try { return hash(readFileSync(file, 'utf8')); } catch { return null; } };
function stamp() { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; }

export function createFileStore({ db, dir, dataDir, saveHistory, renameLinks, notify }) {
  let error = null;
  const columns = db.prepare('PRAGMA table_info(pages)').all().map(c => c.name);
  for (const [name, type] of [['file', 'TEXT'], ['file_hash', 'TEXT'], ['file_mtime', 'REAL'], ['file_size', 'INTEGER']]) if (!columns.includes(name)) db.exec(`ALTER TABLE pages ADD COLUMN ${name} ${type}`);
  if (!db.prepare('PRAGMA table_info(projects)').all().some(c => c.name === 'folder')) db.exec('ALTER TABLE projects ADD COLUMN folder TEXT');

  const projectRows = () => db.prepare('SELECT * FROM projects ORDER BY created, rowid').all();
  const projectById = id => db.prepare('SELECT * FROM projects WHERE id=?').get(id);
  const byKey = (pid, title) => db.prepare('SELECT * FROM pages WHERE project_id=? AND title_key=? AND deleted=0').get(pid, titleKey(title));
  const setFile = (id, file, h, full) => {
    const st = full ? statSync(full) : null;
    db.prepare('UPDATE pages SET file=?,file_hash=?,file_mtime=?,file_size=? WHERE id=?').run(file, h, st ? st.mtimeMs : null, st ? st.size : null, id);
  };
  const projectDir = p => path.join(dir, p.folder || '');

  function check() {
    try { mkdirSync(dir, { recursive: true }); readdirSync(dir); error = null; return true; }
    catch (e) {
      error = e.code === 'EPERM' || e.code === 'EACCES'
        ? `メモのフォルダ（${dir}）を読み書きできません。システム設定 → プライバシーとセキュリティ → ファイルとフォルダ（またはフルディスクアクセス）で node に「書類」フォルダへのアクセスを許可してください。`
        : `メモのフォルダ（${dir}）を開けません: ${e.message}`;
      return false;
    }
  }

  // プロジェクトとフォルダの対応。最初のプロジェクトはフォルダ直下（folder = ''）。
  function freeFolder(wanted, selfId) {
    const taken = projectRows().filter(p => p.id !== selfId && p.folder).map(p => lower(p.folder));
    let name = wanted;
    for (let n = 2; taken.includes(lower(name)); n++) name = `${wanted} ${n}`;
    return name;
  }
  function assignFolders() {
    const rows = projectRows();
    if (rows.length && !rows.some(p => p.folder === '')) db.prepare("UPDATE projects SET folder='' WHERE id=?").run(rows[0].id);
    for (const p of projectRows()) if (p.folder === null) db.prepare('UPDATE projects SET folder=? WHERE id=?').run(freeFolder(folderNameFor(p.name), p.id), p.id);
  }
  assignFolders();

  // 同じフォルダ内で、ほかのページやほかのファイルとぶつからないファイル名を選ぶ
  function freeName(pdir, page, wanted) {
    const others = new Set(db.prepare('SELECT id,file FROM pages WHERE project_id=? AND deleted=0 AND file IS NOT NULL AND id<>?').all(page.project_id, page.id).map(r => lower(r.file)));
    const current = page.file ? path.join(pdir, page.file) : null;
    const base = wanted.slice(0, -EXT.length);
    for (let n = 1; ; n++) {
      const name = n === 1 ? wanted : `${base} ~${n}${EXT}`, full = path.join(pdir, name);
      if (others.has(lower(name))) continue;
      if (existsSync(full) && !(current && sameFile(full, current))) continue;
      return name;
    }
  }
  const acceptable = (file, wanted) => file === wanted || new RegExp(`^${wanted.slice(0, -EXT.length).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ~\\d+\\.txt$`).test(file);
  let conflicts = 0;
  // ほかで書き換えられたファイルは消さずに「（競合 日時）」付きの名前で残す（次の取り込みで別ページになる）
  function keepConflict(full) {
    const base = path.basename(full, EXT), d = path.dirname(full);
    let target = path.join(d, `${base}（競合 ${stamp()}）${EXT}`);
    for (let n = 2; existsSync(target); n++) target = path.join(d, `${base}（競合 ${stamp()} ${n}）${EXT}`);
    renameSync(full, target); conflicts++;
  }
  function writeAtomic(full, text) {
    const tmp = path.join(path.dirname(full), `.${path.basename(full)}.${randomUUID().slice(0, 8)}.tmp`);
    writeFileSync(tmp, text); renameSync(tmp, full);
  }

  // データベース → ファイル（アプリでの変更を書き出す）
  function push(pid) {
    if (error && !check()) return;
    const project = projectById(pid);
    if (!project || project.folder === null) return;
    const pdir = projectDir(project);
    const before = conflicts;
    for (const page of db.prepare('SELECT * FROM pages WHERE project_id=? ORDER BY deleted DESC, rowid').all(pid)) {
      if (page.deleted) {
        if (!page.file) continue;
        const full = path.join(pdir, page.file);
        if (existsSync(full)) { if (diskHash(full) === page.file_hash) unlinkSync(full); else keepConflict(full); }
        setFile(page.id, null, null, null);
        continue;
      }
      mkdirSync(pdir, { recursive: true });
      const wanted = fileNameFor(page.title);
      let name = page.file;
      if (!name || !acceptable(name, wanted)) {
        const target = freeName(pdir, page, wanted), old = name && path.join(pdir, name);
        if (old && existsSync(old)) {
          if (diskHash(old) === page.file_hash) renameSync(old, path.join(pdir, target));
          else keepConflict(old);
        }
        name = target;
      }
      const full = path.join(pdir, name), text = toFileText(page.body), h = hash(text);
      if (h !== page.file_hash || !existsSync(full) || name !== page.file) {
        if (existsSync(full)) { const now = diskHash(full); if (now !== h && now !== page.file_hash) keepConflict(full); }
        if (diskHash(full) !== h) writeAtomic(full, text);
        setFile(page.id, name, h, full);
      }
    }
    if (conflicts !== before) setTimeout(run, 50);
  }
  const pushAll = () => { for (const p of projectRows()) push(p.id); };

  // ファイル → データベース（ほかのアプリでの変更を取り込む）。変わったプロジェクトのIDを返す。
  function reconcileProject(project) {
    const pdir = projectDir(project);
    let names = [];
    try { names = readdirSync(pdir, { withFileTypes: true }).filter(e => e.isFile() && !hidden(e.name) && e.name.toLowerCase().endsWith(EXT)).map(e => e.name); }
    catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e; }
    const mapped = db.prepare('SELECT * FROM pages WHERE project_id=? AND deleted=0 AND file IS NOT NULL').all(project.id);
    const byFile = new Map(mapped.map(p => [lower(p.file), p]));
    const seen = new Set(), fresh = [];
    let changed = false;
    for (const name of names) {
      const full = path.join(pdir, name);
      let st; try { st = statSync(full); } catch { continue; }
      if (st.size > MAX_FILE) continue;
      const page = byFile.get(lower(name));
      if (!page) { fresh.push({ name, full, st }); continue; }
      seen.add(page.id);
      if (page.file !== name) { // 大文字小文字だけの名前変更（Macでは同じファイル）
        db.prepare('UPDATE pages SET file=? WHERE id=?').run(name, page.id);
        const title = titleFromFileName(name);
        if (title !== page.title && titleKey(title) === page.title_key) { db.prepare('UPDATE pages SET title=?,updated=?,rev=rev+1 WHERE id=?').run(title, Date.now(), page.id); changed = true; }
      }
      if (st.mtimeMs === page.file_mtime && st.size === page.file_size) continue;
      const text = readFileSync(full, 'utf8'), h = hash(text);
      if (h === page.file_hash) { setFile(page.id, name, h, full); continue; }
      saveHistory(page);
      db.prepare('UPDATE pages SET body=?,updated=?,rev=rev+1,file_hash=?,file_mtime=?,file_size=? WHERE id=?').run(fromFileText(text), Math.max(Date.now(), page.updated + 1), h, st.mtimeMs, st.size, page.id);
      changed = true;
    }
    const missing = mapped.filter(p => !seen.has(p.id));
    for (const f of fresh) {
      const text = readFileSync(f.full, 'utf8'), h = hash(text);
      let title = titleFromFileName(f.name);
      if (!title || title.length > 300) continue;
      const index = missing.findIndex(p => p.file_hash === h);
      if (index >= 0) { // 名前が変わっただけ（中身が同じ）
        const page = missing[index];
        if (lower(fileNameFor(page.title)) === lower(f.name)) title = page.title;
        const other = byKey(project.id, title);
        if (!other || other.id === page.id) {
          missing.splice(index, 1);
          db.prepare('UPDATE pages SET title=?,title_key=?,updated=?,rev=rev+1 WHERE id=?').run(title, titleKey(title), Date.now(), page.id);
          setFile(page.id, f.name, h, f.full);
          if (title !== page.title) renameLinks(project.id, page.title, title);
          changed = true; continue;
        }
      }
      let unique = title, file = f.name;
      for (let n = 2; byKey(project.id, unique); n++) unique = `${title} (${n})`;
      const id = randomUUID(), created = Math.round(f.st.birthtimeMs || f.st.mtimeMs), updated = Math.round(f.st.mtimeMs);
      db.prepare('INSERT INTO pages(id,title,title_key,body,created,updated,project_id) VALUES(?,?,?,?,?,?,?)').run(id, unique, titleKey(unique), fromFileText(text), created, updated, project.id);
      if (unique !== title) { // ファイル名とタイトルをそろえる
        const target = freeName(pdir, { id, project_id: project.id, file: null }, fileNameFor(unique));
        renameSync(f.full, path.join(pdir, target)); file = target;
      }
      setFile(id, file, h, path.join(pdir, file));
      changed = true;
    }
    for (const page of missing) { // ほかで削除された → ゴミ箱へ（中身はデータベースに残る）
      saveHistory(page);
      db.prepare('UPDATE pages SET deleted=1,file=NULL,file_hash=NULL,file_mtime=NULL,file_size=NULL,updated=?,rev=rev+1 WHERE id=?').run(Date.now(), page.id);
      changed = true;
    }
    return changed;
  }

  function reconcile() {
    if (!check()) return { changed: [], projectsChanged: false };
    let projectsChanged = false;
    const folders = readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && !hidden(e.name)).map(e => e.name);
    const known = () => projectRows().filter(p => p.folder);
    for (const folder of folders) {
      if (known().some(p => lower(p.folder) === lower(folder))) continue;
      // フォルダ名が変わっただけなら、同じプロジェクトとして扱う
      const files = new Set(readdirSync(path.join(dir, folder)).map(lower));
      const moved = known().find(p => !existsSync(projectDir(p)) && db.prepare('SELECT file FROM pages WHERE project_id=? AND deleted=0 AND file IS NOT NULL').all(p.id).some(r => files.has(lower(r.file))));
      if (moved) {
        const name = lower(moved.name) === lower(moved.folder) && !projectRows().some(p => p.id !== moved.id && lower(p.name) === lower(folder)) ? folder.slice(0, 100) : moved.name;
        db.prepare('UPDATE projects SET folder=?,name=? WHERE id=?').run(folder, name, moved.id);
      } else {
        let name = folder.slice(0, 100), n = 2;
        while (projectRows().some(p => lower(p.name) === lower(name))) name = `${folder.slice(0, 95)} (${n++})`;
        db.prepare('INSERT INTO projects(id,name,created,folder) VALUES(?,?,?,?)').run(randomUUID(), name, Date.now(), folder);
      }
      projectsChanged = true;
    }
    const changed = [];
    db.exec('BEGIN IMMEDIATE');
    try { for (const p of projectRows()) if (reconcileProject(p)) changed.push(p.id); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw e; }
    return { changed, projectsChanged };
  }

  // 取り込み → 取り込みで生じた変更（リンク名の書き換えなど）の書き出し → 開いている画面へ通知
  function run() {
    try {
      const { changed, projectsChanged } = reconcile();
      for (const id of changed) { push(id); notify(id); }
      if (projectsChanged || changed.length) notify(null, { type: 'projects' });
    } catch (e) { console.error('ファイルの取り込みに失敗しました:', e); }
  }

  let timer = null, watcher = null;
  function start() {
    if (check()) { run(); pushAll(); }
    if (process.env.SCRAPBOX_NO_WATCH === '1') return; // テスト用
    try {
      watcher = watch(dir, { recursive: true }, (event, name) => {
        if (name && String(name).split(/[\\/]/).some(hidden)) return;
        clearTimeout(timer); timer = setTimeout(run, 300);
      });
      watcher.on('error', () => {});
    } catch {}
    setInterval(() => { const was = error; if (check()) { if (was) pushAll(); run(); } }, 15000).unref();
  }

  // プロジェクトの作成・名前変更・削除
  function projectCreated(id) {
    const p = projectById(id);
    db.prepare('UPDATE projects SET folder=? WHERE id=?').run(freeFolder(folderNameFor(p.name), id), id);
    if (check()) mkdirSync(projectDir(projectById(id)), { recursive: true });
  }
  function projectRenamed(id) {
    const p = projectById(id);
    if (!p.folder) return; // フォルダ直下のプロジェクトは名前だけ変わる
    const folder = freeFolder(folderNameFor(p.name), id);
    if (folder === p.folder) return;
    const from = projectDir(p), to = path.join(dir, folder);
    if (existsSync(from) && !existsSync(to)) renameSync(from, to);
    db.prepare('UPDATE projects SET folder=? WHERE id=?').run(folder, id);
  }
  function isRoot(id) { return projectById(id)?.folder === ''; }
  function projectDeleted(project) {
    if (!project.folder) return;
    const from = projectDir(project);
    if (!existsSync(from)) return;
    const to = path.join(dataDir, 'deleted-folders', `${project.folder} ${stamp()}`);
    mkdirSync(path.dirname(to), { recursive: true });
    try { renameSync(from, to); } catch { cpSync(from, to, { recursive: true }); rmSync(from, { recursive: true, force: true }); }
  }

  // Finderで表示（macOSのみ）
  function reveal(pageId, projectId) {
    if (process.platform !== 'darwin') return false;
    let target;
    if (pageId) {
      const page = db.prepare('SELECT * FROM pages WHERE id=?').get(pageId), project = page && projectById(page.project_id);
      if (!page || !page.file || !project) return false;
      target = ['-R', path.join(projectDir(project), page.file)];
    } else {
      const project = projectById(projectId);
      if (!project) return false;
      target = [projectDir(project)];
    }
    execFile('open', target, () => {});
    return true;
  }

  const isEmpty = () => { try { return !readdirSync(dir).some(n => !hidden(n)); } catch { return true; } };
  return { dir, get error() { return error; }, start, push, pushAll, run, reconcile, projectCreated, projectRenamed, projectDeleted, isRoot, reveal, isEmpty, check };
}
