#!/bin/bash
# Local Scrapbox を Mac アプリとして入れる（初回も更新も、これを実行するだけ。何度実行しても安全）
#   bash ~/Documents/開発/local-scrapbox/macos/install.sh
#
# やること:
#   1. アプリ本体を ~/Library/Application Support/Local Scrapbox/app にコピー
#   2. 初回だけ、今までのノート（このフォルダの data/）を移す（元のデータは消さない）
#   3. ログイン時に自動で起動し、常駐する設定（LaunchAgent）
#   4. 「Local Scrapbox.app」（専用ウインドウ）を作って、アプリケーションフォルダに置く
# メモは ~/Documents/scrapbox に、1ページ1つの .txt ファイルとして保存されます。
set -euo pipefail

LABEL="net.sugiduino.local-scrapbox"
APP_NAME="Local Scrapbox"
PORT="${PORT:-3210}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
SUPPORT="${HOME}/Library/Application Support/Local Scrapbox"
APP_DIR="${SUPPORT}/app"
DATA_DIR="${SUPPORT}/data"
NOTES_DIR="${SCRAPBOX_NOTES_DIR:-${HOME}/Documents/scrapbox}"
UPLOADS_DIR="${NOTES_DIR}/.images"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOG="${DATA_DIR}/server.log"
UID_NUM="$(id -u)"
URL="http://127.0.0.1:${PORT}/"

step() { printf '\n== %s\n' "$1"; }
die() { printf '\n✖ %s\n' "$1" >&2; exit 1; }

# ---- 1. Node.js ----
step "1/6 Node.js を探します"
node_ok() { "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' >/dev/null 2>&1; }
NODE=""
for candidate in "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node "${HOME}/.volta/bin/node" "${HOME}"/.nvm/versions/node/*/bin/node; do
  if [ -n "${candidate}" ] && [ -x "${candidate}" ] && node_ok "${candidate}"; then NODE="${candidate}"; break; fi
done
if [ -z "${NODE}" ]; then
  die "Node.js 22.13 以降が見つかりません。https://nodejs.org から LTS 版を入れるか、Homebrew なら「brew install node」を実行してから、もう一度実行してください。"
fi
echo "OK: ${NODE}（$("${NODE}" -v)）"

# ---- 2. 動いているものを止める ----
step "2/6 準備"
if launchctl print "gui/${UID_NUM}/${LABEL}" >/dev/null 2>&1; then
  launchctl bootout "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true
  sleep 1
fi
if pgrep -f "${APP_NAME}.app/Contents/MacOS/LocalScrapbox" >/dev/null 2>&1; then
  osascript -e "tell application id \"${LABEL}.app\" to quit" >/dev/null 2>&1 || true
  sleep 1
fi
if lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "ポート ${PORT} を別のプログラムが使っています:"
  lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN | sed -n '1,3p'
  die "「起動.command」で開いたターミナルが残っていたら閉じてから、もう一度実行してください。"
fi
echo "OK"

# ---- 3. アプリ本体をコピー ----
step "3/6 アプリ本体をコピーします"
mkdir -p "${APP_DIR}" "${DATA_DIR}"
rsync -a --delete \
  --exclude 'data' --exclude '.git' --exclude '.claude' --exclude 'node_modules' --exclude '_backup*' \
  --exclude 'deploy' --exclude 'test' --exclude '.DS_Store' --exclude '起動.command' \
  "${SRC}/" "${APP_DIR}/"
echo "OK: ${APP_DIR}"

# ---- 4. 今までのノートを移す（初回だけ） ----
step "4/6 ノートの保存先: ${NOTES_DIR}"
mkdir -p "${NOTES_DIR}" || die "${NOTES_DIR} を作れません。ターミナルに「書類」フォルダへのアクセスを許可してください。"
if [ ! -f "${DATA_DIR}/scrapbox.sqlite" ] && [ -f "${SRC}/data/scrapbox.sqlite" ]; then
  echo "今までのノート（${SRC}/data）を移します。元のデータはそのまま残します。"
  "${NODE}" --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite");
    const [from, to] = process.argv.slice(1);
    new DatabaseSync(from, { readOnly: true }).prepare("VACUUM INTO ?").run(to);
  ' "${SRC}/data/scrapbox.sqlite" "${DATA_DIR}/scrapbox.sqlite"
  if [ -d "${SRC}/data/uploads" ]; then
    mkdir -p "${UPLOADS_DIR}"
    for f in "${SRC}/data/uploads"/*; do [ -f "${f}" ] && [ ! -e "${UPLOADS_DIR}/$(basename "${f}")" ] && cp "${f}" "${UPLOADS_DIR}/" || true; done
  fi
  echo "OK: 移しました（各ページは、このあと起動したときに .txt ファイルになります）"
else
  echo "OK"
fi

# ---- 5. 常駐の設定（ログイン時に自動起動） ----
step "5/6 常駐の設定"
xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
mkdir -p "$(dirname "${PLIST}")"
cat > "${PLIST}" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "${NODE}")</string>
    <string>--no-warnings</string>
    <string>$(xml "${APP_DIR}/server.mjs")</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml "${APP_DIR}")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOST</key><string>127.0.0.1</string>
    <key>PORT</key><string>${PORT}</string>
    <key>SCRAPBOX_DATA_DIR</key><string>$(xml "${DATA_DIR}")</string>
    <key>SCRAPBOX_NOTES_DIR</key><string>$(xml "${NOTES_DIR}")</string>
    <key>SCRAPBOX_UPLOADS_DIR</key><string>$(xml "${UPLOADS_DIR}")</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$(xml "${LOG}")</string>
  <key>StandardErrorPath</key><string>$(xml "${LOG}")</string>
</dict>
</plist>
PLIST_EOF
plutil -lint "${PLIST}" >/dev/null || die "常駐の設定ファイルが不正です: ${PLIST}"
for i in 1 2 3 4 5; do
  if launchctl bootstrap "gui/${UID_NUM}" "${PLIST}" 2>/dev/null; then break; fi
  [ "${i}" = 5 ] && die "常駐の登録に失敗しました（launchctl bootstrap）。少し待ってから、もう一度実行してください。"
  sleep 1
done
launchctl enable "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true

echo "起動を待っています…"
READY=""
for i in $(seq 1 30); do
  if curl -fsS -o /dev/null "${URL}api/projects" 2>/dev/null; then READY=1; break; fi
  sleep 0.5
done
[ -n "${READY}" ] || die "サーバーが起動しませんでした。ログ: ${LOG}"

# 「書類」フォルダへのアクセス許可（初回は macOS が確認を出すことがあります）
STATE=""
for i in $(seq 1 45); do
  STATE="$(curl -fsS "${URL}api/state" 2>/dev/null || true)"
  case "${STATE}" in *'"error":null'*) break ;; esac
  if [ "${i}" = 1 ]; then
    echo "「node」が「書類」フォルダへのアクセスを求める確認が出たら「許可」を押してください。"
  fi
  if [ "${i}" = 10 ]; then
    echo "確認が出ない場合は、システム設定 → プライバシーとセキュリティ → ファイルとフォルダ（またはフルディスクアクセス）で node を許可してください。"
    open "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders" >/dev/null 2>&1 || true
  fi
  sleep 2
done
case "${STATE}" in
  *'"error":null'*) echo "OK: ${URL}（メモ: ${NOTES_DIR}）" ;;
  *) echo "⚠ まだメモのフォルダを読めません。許可したあと、アプリを開き直せば続きから動きます。ログ: ${LOG}" ;;
esac

# ---- 6. Local Scrapbox.app ----
step "6/6 アプリを作ります"
if [ -w /Applications ]; then APPS="/Applications"; else APPS="${HOME}/Applications"; mkdir -p "${APPS}"; fi
APP_PATH="${APPS}/${APP_NAME}.app"
BUILD="$(mktemp -d)"
BUNDLE="${BUILD}/${APP_NAME}.app"
mkdir -p "${BUNDLE}/Contents/MacOS" "${BUNDLE}/Contents/Resources"

NATIVE=""
if xcode-select -p >/dev/null 2>&1 && command -v swiftc >/dev/null 2>&1; then
  echo "専用ウインドウのアプリをビルドします（30秒ほどかかります）"
  if swiftc -O -o "${BUNDLE}/Contents/MacOS/LocalScrapbox" "${SRC}/macos/main.swift" -framework Cocoa -framework WebKit 2> "${BUILD}/build.log"; then
    NATIVE=1
  else
    echo "⚠ ビルドに失敗しました（ログ: ${BUILD}/build.log）。ブラウザのウインドウで開く版を作ります。"
    sed -n '1,20p' "${BUILD}/build.log"
  fi
else
  echo "⚠ Xcode のコマンドラインツールがないため、ブラウザのウインドウで開く版を作ります。"
  echo "  専用ウインドウ版にするには「xcode-select --install」を実行してから、もう一度このスクリプトを実行してください。"
fi
if [ -z "${NATIVE}" ]; then
  cat > "${BUNDLE}/Contents/MacOS/LocalScrapbox" <<LAUNCH_EOF
#!/bin/bash
launchctl kickstart "gui/\$(id -u)/${LABEL}" >/dev/null 2>&1 || true
if [ -d "/Applications/Google Chrome.app" ]; then
  exec open -na "Google Chrome" --args --app="${URL}"
else
  exec open "${URL}"
fi
LAUNCH_EOF
  chmod +x "${BUNDLE}/Contents/MacOS/LocalScrapbox"
fi

ICON_KEY=""
if [ -f "${SRC}/macos/icon.png" ] && command -v iconutil >/dev/null 2>&1; then
  SET="${BUILD}/AppIcon.iconset"; mkdir -p "${SET}"
  for s in 16 32 128 256 512; do
    sips -z "${s}" "${s}" "${SRC}/macos/icon.png" --out "${SET}/icon_${s}x${s}.png" >/dev/null
    d=$((s * 2)); sips -z "${d}" "${d}" "${SRC}/macos/icon.png" --out "${SET}/icon_${s}x${s}@2x.png" >/dev/null
  done
  if iconutil -c icns "${SET}" -o "${BUNDLE}/Contents/Resources/AppIcon.icns" 2>/dev/null; then
    ICON_KEY="<key>CFBundleIconFile</key><string>AppIcon</string>"
  fi
fi

cat > "${BUNDLE}/Contents/Info.plist" <<INFO_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>${LABEL}.app</string>
  <key>CFBundleExecutable</key><string>LocalScrapbox</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>$(date +%Y%m%d%H%M)</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  ${ICON_KEY}
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
    <key>NSAllowsArbitraryLoadsInWebContent</key><true/>
  </dict>
  <key>ScrapboxURL</key><string>${URL}</string>
  <key>ScrapboxNotesDir</key><string>$(xml "${NOTES_DIR}")</string>
  <key>ScrapboxAgentLabel</key><string>${LABEL}</string>
</dict>
</plist>
INFO_EOF
plutil -lint "${BUNDLE}/Contents/Info.plist" >/dev/null || die "Info.plist が不正です"
codesign --force --sign - "${BUNDLE}" >/dev/null 2>&1 || true

rm -rf "${APP_PATH}"
mv "${BUNDLE}" "${APP_PATH}"
rm -rf "${BUILD}"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "${APP_PATH}" >/dev/null 2>&1 || true
echo "OK: ${APP_PATH}$([ -n "${NATIVE}" ] && echo '（専用ウインドウ版）' || echo '（ブラウザのウインドウ版）')"

# Dock に追加（確認してから）
if ! defaults read com.apple.dock persistent-apps 2>/dev/null | grep -q "${APP_NAME}.app"; then
  printf '\nDock に追加しますか？ [Y/n] '
  read -r ANSWER || ANSWER="n"
  case "${ANSWER}" in
    n|N|no|NO) echo "追加しませんでした（あとから ${APP_PATH} を Dock にドラッグすれば追加できます）" ;;
    *)
      defaults write com.apple.dock persistent-apps -array-add "<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>$(xml "${APP_PATH}")</string><key>_CFURLStringType</key><integer>0</integer></dict></dict></dict>"
      killall Dock >/dev/null 2>&1 || true
      echo "Dock に追加しました" ;;
  esac
fi

open "${APP_PATH}"
cat <<DONE_EOF

✔ 完了
  アプリ: ${APP_PATH}（Dock・Launchpad・Spotlight から開けます）
  メモ:   ${NOTES_DIR}（1ページ1つの .txt。ほかのアプリで編集しても反映されます）
  履歴・設定: ${DATA_DIR}
  ログイン時に自動で起動して常駐します。やめるときは: bash ${SRC}/macos/uninstall.sh
  アプリを更新したときも、このスクリプトをもう一度実行してください。
DONE_EOF
