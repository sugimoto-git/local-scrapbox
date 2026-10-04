#!/bin/bash
# VPS上で1回だけ実行する初期設定（何度実行しても安全です）。
#   bash ~/local-scrapbox/deploy/vps-setup.sh
# 事前に、アプリを ~/local-scrapbox に置き、パスワードを設定しておくこと（deploy/README.md 参照）。
set -euo pipefail

DOMAIN="${DOMAIN:-notes.sugiduino.net}"
APP_DIR="${APP_DIR:-$HOME/local-scrapbox}"
DATA_DIR="${DATA_DIR:-/var/lib/local-scrapbox}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/local-scrapbox}"
PORT="${PORT:-3210}"
RUN_USER="$(id -un)"

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then echo "Node.js が入っていません。deploy/README.md の手順 2 を先に実行してください。"; exit 1; fi
if ! "$NODE_BIN" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'; then
  echo "Node.js 22.13 以降が必要です（今は $("$NODE_BIN" -v)）。"; exit 1
fi
[ -f "$APP_DIR/server.mjs" ] || { echo "$APP_DIR にアプリがありません。Macで deploy/deploy.sh を先に実行してください。"; exit 1; }

# nginx と certbot が無ければ入れる
if ! command -v nginx >/dev/null || ! command -v certbot >/dev/null; then
  echo "nginx / certbot をインストールします"
  sudo apt-get update -y
  sudo apt-get install -y nginx certbot python3-certbot-nginx
fi

sudo mkdir -p "$DATA_DIR" "$BACKUP_DIR"
sudo chown "$RUN_USER:$RUN_USER" "$DATA_DIR" "$BACKUP_DIR"
sudo chmod 700 "$DATA_DIR" "$BACKUP_DIR"
if [ ! -f "$DATA_DIR/auth.json" ]; then
  echo "ログイン用のパスワードが未設定です。先にこれを実行してください（パスワードを2回入力します）:"
  echo "  SCRAPBOX_DATA_DIR=$DATA_DIR $NODE_BIN $APP_DIR/set-password.mjs"
  exit 1
fi

sudo tee /etc/systemd/system/local-scrapbox.service >/dev/null <<UNIT
[Unit]
Description=Local Scrapbox ($DOMAIN)
After=network.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$APP_DIR
Environment=HOST=127.0.0.1 PORT=$PORT SCRAPBOX_DATA_DIR=$DATA_DIR ALLOWED_HOSTS=$DOMAIN TRUST_PROXY=1 NODE_ENV=production
ExecStart=$NODE_BIN --no-warnings server.mjs
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now local-scrapbox
sleep 2
systemctl is-active local-scrapbox
curl -fsS -o /dev/null -w "アプリの応答: %{http_code}（302ならログイン画面へ転送＝正常）\n" -H "Host: $DOMAIN" "http://127.0.0.1:$PORT/" || { echo "アプリが応答しません: journalctl -u local-scrapbox -n 30"; exit 1; }

sed "s/notes\.sugiduino\.net/$DOMAIN/g; s/127\.0\.0\.1:3210/127.0.0.1:$PORT/g" "$APP_DIR/deploy/nginx-notes.conf" | sudo tee /etc/nginx/sites-available/local-scrapbox >/dev/null
sudo ln -sf /etc/nginx/sites-available/local-scrapbox /etc/nginx/sites-enabled/local-scrapbox
sudo nginx -t
sudo systemctl reload nginx

# 毎日3:17にバックアップ（cronに未登録なら追加）
CRON="17 3 * * * SCRAPBOX_DATA_DIR=$DATA_DIR BACKUP_DIR=$BACKUP_DIR $NODE_BIN --no-warnings $APP_DIR/deploy/backup.mjs >> $BACKUP_DIR/backup.log 2>&1"
( crontab -l 2>/dev/null | grep -v 'deploy/backup.mjs' || true; echo "$CRON" ) | crontab -
echo "バックアップ設定: 毎日3:17 → $BACKUP_DIR"

echo
echo "HTTPS証明書を取得します（DNSで $DOMAIN がこのVPSを指している必要があります）。"
sudo certbot --nginx -d "$DOMAIN" --redirect
echo "完了: https://$DOMAIN"
