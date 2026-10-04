#!/bin/bash
# Macのターミナルで、これ1本で初回セットアップを最後まで行う。
#   bash ~/Documents/開発/local-scrapbox/deploy/setup-all.sh
# 事前に必要なのは、DNSで notes.sugiduino.net → VPSのIP のAレコードを作っておくことだけです。
# 途中で聞かれるもの: VPSのSSHパスワード（またはパスフレーズ）、sudoのパスワード、アプリのログインパスワード（新規に決める）、certbotのメールアドレス
set -euo pipefail

export VPS="${VPS:-ubuntu@153.126.174.161}"
DOMAIN="${DOMAIN:-notes.sugiduino.net}"
VPS_IP="${VPS#*@}"
cd "$(dirname "$0")"

echo "== DNSの確認 =="
# 普段のDNS → 1.1.1.1 → 8.8.8.8 の順に問い合わせ、IPv4アドレスの行だけを見る
lookup() {
  local server out
  for server in "" 1.1.1.1 8.8.8.8; do
    out="$(dig +short +time=3 +tries=1 ${server:+@$server} A "$DOMAIN" 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || true)"
    if [ -n "$out" ]; then echo "$out"; return 0; fi
  done
  return 0
}
FOUND="$(lookup | tr '\n' ' ')"
if [[ " $FOUND " != *" ${VPS_IP} "* ]]; then
  echo "$DOMAIN がまだ ${VPS_IP} を指していません（今の応答: ${FOUND:-なし}）。"
  echo "DNS管理画面で A レコード（notes → ${VPS_IP}）を追加し、反映されてからもう一度実行してください。"
  echo "（HTTPS証明書の取得にDNSが必要です。反映前に進めたい場合は SKIP_DNS_CHECK=1 を付けてください）"
  [ "${SKIP_DNS_CHECK:-}" = 1 ] || exit 1
else
  echo "OK: $DOMAIN → ${VPS_IP}"
fi

# SSH接続を使い回して、パスワード入力を1回で済ませる
SOCK="/tmp/sb-ssh-$$"
export SSH_OPTS="-o ControlMaster=auto -o ControlPath=$SOCK -o ControlPersist=15m"
trap 'ssh $SSH_OPTS -O exit "$VPS" >/dev/null 2>&1 || true' EXIT

echo "== 1/2 ファイルをVPSへ送る =="
SETUP_ALL=1 bash ./deploy.sh

echo "== 2/2 VPS上でセットアップ（ここからVPS側の画面になります） =="
ssh $SSH_OPTS -t "$VPS" "DOMAIN='$DOMAIN' bash ~/local-scrapbox/deploy/vps-all.sh"

echo
echo "完了: https://$DOMAIN を開いて、決めたパスワードでログインしてください。"
echo "更新するときは:  bash $(pwd)/deploy.sh"
