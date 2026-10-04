#!/bin/bash
# VPS上で実行する「全部入り」（setup-all.sh がMacから呼びます。単独で実行してもOK・何度でも安全）
#   Node.js 22.13+ の導入 → ファイアウォール → パスワード設定 → vps-setup.sh（systemd/Nginx/バックアップ/HTTPS）
set -euo pipefail

DOMAIN="${DOMAIN:-notes.sugiduino.net}"
APP_DIR="${APP_DIR:-$HOME/local-scrapbox}"
DATA_DIR="${DATA_DIR:-/var/lib/local-scrapbox}"
export DOMAIN APP_DIR DATA_DIR

[ -f "$APP_DIR/server.mjs" ] || { echo "$APP_DIR にアプリがありません。Macから setup-all.sh を実行してください。"; exit 1; }

node_ok() { command -v node >/dev/null && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'; }

echo "== sudo（パスワードを聞かれます） =="
sudo -v

echo "== 1/4 Node.js =="
if node_ok; then
  echo "OK: $(node -v)"
else
  echo "Node.js 22 を導入します"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
  node_ok || { echo "Node.js 22.13以降を用意できませんでした。"; exit 1; }
  echo "OK: $(node -v)"
fi

echo "== 2/4 ファイアウォール =="
if command -v ufw >/dev/null && sudo ufw status | grep -q "Status: active"; then
  sudo ufw allow 80/tcp >/dev/null && sudo ufw allow 443/tcp >/dev/null && echo "ufw: 80/443 を許可しました"
else
  echo "ufw は無効なので変更しません（さくらのVPSのパケットフィルタは、コントロールパネルで 80/443 を許可してください）"
fi

echo "== 3/4 ログインパスワード =="
sudo mkdir -p "$DATA_DIR"
sudo chown "$(id -un):$(id -gn)" "$DATA_DIR"
if [ -f "$DATA_DIR/auth.json" ]; then
  echo "設定済みなのでそのまま使います（変えるときは deploy/README.md の「パスワードを変える」）"
else
  SCRAPBOX_DATA_DIR="$DATA_DIR" node "$APP_DIR/set-password.mjs"
fi

echo "== 4/4 常駐・Nginx・バックアップ・HTTPS =="
bash "$APP_DIR/deploy/vps-setup.sh"
