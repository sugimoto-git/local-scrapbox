#!/bin/bash
# Local Scrapbox（Macアプリ）の中身をすべて消して、Scrapbox のバックアップ（JSON）を入れる。
#   bash ~/Documents/開発/local-scrapbox/macos/import-backup.sh バックアップ.json
# 消す前の中身は ~/Library/Application Support/Local Scrapbox/backups に丸ごと保存します。
set -euo pipefail
LABEL="net.sugiduino.local-scrapbox"
DIR="$(cd "$(dirname "$0")" && pwd)"
JSON="${1:-}"
[ -n "${JSON}" ] && [ -f "${JSON}" ] || { echo "使い方: bash ${DIR}/import-backup.sh バックアップ.json"; exit 1; }

node_ok() { "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' >/dev/null 2>&1; }
NODE=""
for candidate in "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node "${HOME}/.volta/bin/node" "${HOME}"/.nvm/versions/node/*/bin/node; do
  if [ -n "${candidate}" ] && [ -x "${candidate}" ] && node_ok "${candidate}"; then NODE="${candidate}"; break; fi
done
[ -n "${NODE}" ] || { echo "Node.js 22.13 以降が見つかりません。"; exit 1; }

if [ ! -f "${HOME}/Library/LaunchAgents/${LABEL}.plist" ]; then
  echo "Macアプリ版がまだ入っていません。先に次を実行してください:"
  echo "  bash ${DIR}/install.sh"
  exit 1
fi
# 常駐が止まっていたら起こす
if ! curl -fsS -o /dev/null http://127.0.0.1:3210/api/projects 2>/dev/null; then
  launchctl kickstart "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 || true
  for i in $(seq 1 20); do curl -fsS -o /dev/null http://127.0.0.1:3210/api/projects 2>/dev/null && break; sleep 0.5; done
fi
exec "${NODE}" --no-warnings "${DIR}/import-backup.mjs" "${JSON}"
