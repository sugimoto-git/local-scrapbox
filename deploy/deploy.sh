#!/bin/bash
# MacのターミナルからVPSへ反映する（初回も更新も同じ）。
#   bash ~/Documents/開発/local-scrapbox/deploy/deploy.sh
# データ（ノート・画像・ログイン設定）はVPSの /var/lib/local-scrapbox にあり、ここでは一切触りません。
set -euo pipefail

VPS="${VPS:-ubuntu@153.126.174.161}"
REMOTE_DIR="${REMOTE_DIR:-local-scrapbox}"
SSH_OPTS="${SSH_OPTS:-}"   # setup-all.sh が、接続を使い回すための設定を渡します
cd "$(dirname "$0")/.."

echo "▶ ファイルを $VPS:~/$REMOTE_DIR へ送ります"
# macOS標準のrsyncは --chmod 非対応なので付けない（アプリはubuntuユーザーだけが読めれば動く）
rsync -az -e "ssh $SSH_OPTS" --delete \
  --exclude '.git' --exclude '.claude' --exclude 'data' --exclude 'node_modules' \
  --exclude '_backup*' --exclude '.DS_Store' --exclude '*.log' --exclude '起動.command' --exclude 'macos' \
  ./ "$VPS:$REMOTE_DIR/"

if ssh $SSH_OPTS "$VPS" 'systemctl cat local-scrapbox >/dev/null 2>&1'; then
  echo "▶ 再起動します（VPSのパスワードを聞かれます）"
  ssh $SSH_OPTS -t "$VPS" 'sudo systemctl restart local-scrapbox && sleep 1 && systemctl is-active local-scrapbox'
  echo "✔ 反映しました"
else
  [ -n "${SETUP_ALL:-}" ] && echo "✔ ファイルを送りました" || echo "✔ ファイルを送りました。初回のため、続きは deploy/README.md の手順 4 以降（VPS上での作業）です。"
fi
