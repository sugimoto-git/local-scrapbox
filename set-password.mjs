// サーバーで公開するときのログインパスワードを設定する。
//   SCRAPBOX_DATA_DIR=/var/lib/local-scrapbox node set-password.mjs
// data/auth.json にハッシュだけを保存します。パスワードを変えると、既存のログインはすべて無効になります。
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword, newSecret } from './auth.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.SCRAPBOX_DATA_DIR || path.join(root, 'data');

function ask(question) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) return reject(new Error('端末（ターミナル）から実行してください'));
    process.stdout.write(question);
    let value = '';
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
    const onData = chunk => {
      for (const ch of chunk) {
        if (ch === '\u0003') { process.stdin.setRawMode(false); process.stdout.write('\n'); process.exit(130); }
        if (ch === '\r' || ch === '\n') { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', onData); process.stdout.write('\n'); return resolve(value); }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1); else value += ch;
      }
    };
    process.stdin.on('data', onData);
  });
}

try {
  const first = await ask('新しいパスワード（12文字以上）: ');
  if (first.length < 12) throw new Error('12文字以上にしてください');
  if (first !== await ask('もう一度: ')) throw new Error('2回の入力が一致しません');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({ hash: hashPassword(first), secret: newSecret() }), { mode: 0o600 });
  console.log('設定しました: ' + path.join(dataDir, 'auth.json'));
  console.log('サーバーが起動中なら再起動してください。');
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
