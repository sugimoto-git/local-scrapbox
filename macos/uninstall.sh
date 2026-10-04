#!/bin/bash
# Local Scrapbox の常駐とアプリを取り除く。メモ（~/Documents/scrapbox）と履歴・設定は消しません。
#   bash ~/Documents/開発/local-scrapbox/macos/uninstall.sh
set -uo pipefail
LABEL="net.sugiduino.local-scrapbox"
APP_NAME="Local Scrapbox"
SUPPORT="${HOME}/Library/Application Support/Local Scrapbox"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"

if pgrep -f "${APP_NAME}.app/Contents/MacOS/LocalScrapbox" >/dev/null 2>&1; then
  osascript -e "tell application id \"${LABEL}.app\" to quit" >/dev/null 2>&1 || true
  sleep 1
fi
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
rm -f "${PLIST}"
for dir in /Applications "${HOME}/Applications"; do
  [ -d "${dir}/${APP_NAME}.app" ] && rm -rf "${dir}/${APP_NAME}.app" && echo "削除: ${dir}/${APP_NAME}.app"
done
rm -rf "${SUPPORT}/app"
echo
echo "✔ 常駐とアプリを取り除きました。"
echo "  残したもの: メモ ${HOME}/Documents/scrapbox、履歴・設定 ${SUPPORT}/data"
echo "  Dock にアイコンが残っていたら、Dock の外へドラッグして外してください。"
