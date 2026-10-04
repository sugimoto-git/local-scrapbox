#!/bin/bash
# Local Scrapbox（Macアプリ）のページにある Scrapbox・Gyazo の画像を、手元にダウンロードして差し替える。
#   bash ~/Documents/開発/local-scrapbox/macos/fetch-images.sh
set -euo pipefail
LABEL="net.sugiduino.local-scrapbox"
DIR="$(cd "$(dirname "$0")" && pwd)"
node_ok() { "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' >/dev/null 2>&1; }
NODE=""
for candidate in "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node "${HOME}/.volta/bin/node" "${HOME}"/.nvm/versions/node/*/bin/node; do
  if [ -n "${candidate}" ] && [ -x "${candidate}" ] && node_ok "${candidate}"; then NODE="${candidate}"; break; fi
done
[ -n "${NODE}" ] || { echo "Node.js 22.13 以降が見つかりません。"; exit 1; }
if ! curl -fsS -o /dev/null http://127.0.0.1:3210/api/projects 2>/dev/null; then
  launchctl kickstart "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 || true
  for i in $(seq 1 20); do curl -fsS -o /dev/null http://127.0.0.1:3210/api/projects 2>/dev/null && break; sleep 0.5; done
fi
exec "${NODE}" --no-warnings "${DIR}/fetch-images.mjs"
