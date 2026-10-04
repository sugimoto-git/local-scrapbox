// Local Scrapbox（Macアプリ）の中身をすべて消して、Scrapbox のバックアップ（JSON）を入れる。
// 消す前に、今の中身を丸ごとバックアップする（全プロジェクトの画像込みJSON＋データベースのコピー）。
//   使い方は import-backup.sh を参照
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [jsonPath] = process.argv.slice(2);
const BASE = (process.env.SCRAPBOX_URL || 'http://127.0.0.1:3210').replace(/\/$/, '');
const DATA_DIR = process.env.SCRAPBOX_DATA_DIR || path.join(process.env.HOME, 'Library/Application Support/Local Scrapbox/data');
const BACKUP_ROOT = process.env.SCRAPBOX_BACKUP_DIR || path.join(path.dirname(DATA_DIR), 'backups');

function die(message) { console.error('\n✖ ' + message); process.exit(1); }
async function api(route, method = 'GET', body) {
  const res = await fetch(BASE + '/api' + route, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${route}: ${data.error || res.status}`);
  return data;
}
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');

if (!jsonPath || !existsSync(jsonPath)) die('バックアップのJSONファイルを指定してください。');
let backup;
try { backup = JSON.parse(readFileSync(jsonPath, 'utf8')); } catch { die('JSONとして読めません: ' + jsonPath); }
if (!Array.isArray(backup.pages)) die('Scrapbox のバックアップ形式（pages の配列）ではありません。');
const projectName = String(backup.displayName || backup.name || 'my-notes').replace(/[\r\n/]/g, ' ').trim().slice(0, 100) || 'my-notes';

let state;
try { state = await api('/state'); } catch { die(`Local Scrapbox に接続できません（${BASE}）。アプリを一度開いてから、もう一度実行してください。`); }
if (!state.files) die('このサーバーはファイル保存（Macアプリ版）ではありません。対象を確認してください。');
if (state.files.error) die(state.files.error);

// いまの中身を表示して確認
const projects = state.projects;
const root = projects[0];
console.log('いまの Local Scrapbox:');
for (const p of projects) console.log(`  ・${p.name}（${p.count}ページ）`);
console.log(`メモのフォルダ: ${state.files.dir}`);
console.log(`\nこれをすべて消して（ゴミ箱と編集履歴も含む）、次を入れます:`);
console.log(`  ・${projectName}（${backup.pages.length}ページ）  ← ${path.basename(jsonPath)}`);
if (!process.env.SCRAPBOX_YES) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('\n実行しますか？ 消す前のバックアップは自動で取ります [y/N] ')).trim().toLowerCase();
  rl.close();
  if (answer !== 'y' && answer !== 'yes') { console.log('やめました。何も変更していません。'); process.exit(0); }
}

// 1. バックアップ
const dir = path.join(BACKUP_ROOT, 'before-import-' + stamp());
mkdirSync(dir, { recursive: true });
for (const p of projects) {
  const data = await api('/export?full=1&project=' + encodeURIComponent(p.id));
  const trash = await api('/trash?project=' + encodeURIComponent(p.id));
  writeFileSync(path.join(dir, `${p.name.replace(/[\\/:]/g, '_')}.json`), JSON.stringify({ ...data, trash }, null, 2));
}
const dbFile = path.join(DATA_DIR, 'scrapbox.sqlite');
if (existsSync(dbFile)) new DatabaseSync(dbFile, { readOnly: true }).prepare('VACUUM INTO ?').run(path.join(dir, 'scrapbox.sqlite'));
console.log(`\n1/3 バックアップしました: ${dir}`);

// 2. すべて消す（2つ目以降のプロジェクトは削除、最初のプロジェクトは空にする）
for (const p of projects.slice(1)) await api('/projects/' + p.id, 'DELETE', {});
for (let round = 0; round < 3; round++) {
  const { pages } = await api('/state?project=' + root.id);
  if (!pages.length) break;
  for (const page of pages) await api('/pages/' + page.id, 'DELETE', {});
}
await api('/trash?project=' + root.id, 'DELETE', {});
const left = (await api('/state?project=' + root.id)).pages;
console.log(`2/3 消しました${left.length ? `（ほかのアプリで編集中だったため残ったページ: ${left.map(p => p.title).join(', ')}）` : ''}`);

// 3. 取り込み
const result = await api('/import?project=' + root.id, 'POST', readFileSync(jsonPath, 'utf8'));
await api('/projects/' + root.id, 'PUT', { name: projectName });
const after = await api('/state?project=' + root.id);
console.log(`3/3 取り込みました: ${result.added}ページ${result.skipped ? `（同名のため飛ばした: ${result.skipped}）` : ''}`);
console.log(`\n✔ 完了: プロジェクト「${after.project.name}」に ${after.pages.length} ページ`);
console.log(`  メモ: ${state.files.dir}`);
console.log(`  消す前のバックアップ: ${dir}`);
const external = backup.pages.some(p => (p.lines || []).some(l => /scrapbox\.io\/files|gyazo\.com/.test(typeof l === 'string' ? l : l?.text || '')));
if (external) console.log('  画像は元の Scrapbox / Gyazo を参照したままです（Scrapbox のプロジェクトが非公開だと表示されないことがあります）。');
