// 日次バックアップ: SQLiteの一貫したスナップショット ＋ 画像 ＋ ログイン設定を、日付付きで保存し、古いものを消す。
//   SCRAPBOX_DATA_DIR=/var/lib/local-scrapbox BACKUP_DIR=/var/backups/local-scrapbox node deploy/backup.mjs
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync, cpSync, existsSync, readdirSync, copyFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = process.env.SCRAPBOX_DATA_DIR || path.join(root, 'data');
const dest = process.env.BACKUP_DIR || '/var/backups/local-scrapbox';
const keep = Number(process.env.BACKUP_KEEP || 14);
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');

mkdirSync(dest, { recursive: true, mode: 0o700 });
const file = path.join(dest, `scrapbox-${stamp}.sqlite`);
rmSync(file, { force: true });
const db = new DatabaseSync(path.join(dataDir, 'scrapbox.sqlite'));
db.prepare('VACUUM INTO ?').run(file);
db.close();
chmodSync(file, 0o600);
if (existsSync(path.join(dataDir, 'uploads'))) cpSync(path.join(dataDir, 'uploads'), path.join(dest, 'uploads'), { recursive: true, force: false, errorOnExist: false });
if (existsSync(path.join(dataDir, 'auth.json'))) { copyFileSync(path.join(dataDir, 'auth.json'), path.join(dest, 'auth.json')); chmodSync(path.join(dest, 'auth.json'), 0o600); }
const old = readdirSync(dest).filter(f => /^scrapbox-\d{8}\.sqlite$/.test(f)).sort().slice(0, -keep);
for (const f of old) rmSync(path.join(dest, f));
console.log(`バックアップ: ${file}${old.length ? `（古い${old.length}件を削除）` : ''}`);
