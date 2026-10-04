// Local Scrapbox（Macアプリ）のページにある Scrapbox・Gyazo の画像を、手元にダウンロードして差し替える。
// 非公開のScrapboxプロジェクトなら、ログインCookie（connect.sid）を聞く。入力は画面に出さず、保存もしない。
const BASE = (process.env.SCRAPBOX_URL || 'http://127.0.0.1:3210').replace(/\/$/, '');
async function api(route, method = 'GET', body) {
  const res = await fetch(BASE + '/api' + route, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || String(res.status));
  return data;
}
function askHidden(question) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) return reject(new Error('ターミナルから実行してください'));
    process.stdout.write(question);
    let value = '';
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
    const onData = chunk => {
      for (const ch of chunk) {
        if (ch === '\u0003') { process.stdin.setRawMode(false); process.stdout.write('\n'); process.exit(130); }
        if (ch === '\r' || ch === '\n') { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', onData); process.stdout.write('\n'); return resolve(value.trim()); }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1); else value += ch;
      }
    };
    process.stdin.on('data', onData);
  });
}
async function run(projects, cookie) {
  const total = { found: 0, downloaded: 0, reused: 0, pagesChanged: 0, failed: [], needAuth: false, dir: '' };
  for (const p of projects) {
    const r = await api('/localize-images?project=' + encodeURIComponent(p.id), 'POST', cookie ? { cookie } : {});
    for (const k of ['found', 'downloaded', 'reused', 'pagesChanged']) total[k] += r[k];
    total.failed.push(...r.failed); total.needAuth ||= r.needAuth; total.dir = r.dir;
  }
  return total;
}

let state;
try { state = await api('/state'); } catch { console.error(`✖ Local Scrapbox に接続できません（${BASE}）。アプリを一度開いてから、もう一度実行してください。`); process.exit(1); }
console.log('画像をダウンロードしています…');
let result = await run(state.projects);
console.log(`  見つかった外部画像: ${result.found}　ダウンロード: ${result.downloaded}　ページの書き換え: ${result.pagesChanged}`);
if (result.needAuth) {
  console.log(`
非公開のScrapboxプロジェクトの画像があります（${result.failed.length}枚）。ログインCookieがあれば取り込めます。
  1. ふだんのブラウザで https://scrapbox.io にログインした状態で、開発者ツールを開く（Chromeなら ⌥⌘I）
  2. Application（Safariなら「ストレージ」）→ Cookies → https://scrapbox.io → 「connect.sid」の値をコピー
  3. 下に貼り付けて Enter（画面には表示されません。保存もしません）
何も入力せずに Enter を押すと、ここで終わります。`);
  const cookie = await askHidden('connect.sid: ');
  if (cookie) {
    result = await run(state.projects, cookie);
    console.log(`  ダウンロード: ${result.downloaded}　ページの書き換え: ${result.pagesChanged}`);
    if (result.needAuth) console.log('  ⚠ まだ取り込めない画像があります。Cookieの値が正しいか、ログインが有効かを確認してください。');
  }
}
if (result.failed.length) {
  console.log(`\n取り込めなかった画像: ${result.failed.length}枚（元のURLのまま残しています）`);
  for (const f of result.failed.slice(0, 10)) console.log(`  ${f.url}（${f.status}）`);
  if (result.failed.length > 10) console.log(`  ほか ${result.failed.length - 10}枚`);
}
console.log(`\n✔ 完了。画像は ${result.dir} に保存しました。もう一度実行しても、取り込み済みの画像はダウンロードしません。`);
