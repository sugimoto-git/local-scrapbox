#!/bin/zsh
# ダブルクリックで Local Scrapbox を開く。まだ Mac アプリとして入っていなければ、インストールから行う。
cd "${0:A:h}"
for app in "/Applications/Local Scrapbox.app" "${HOME}/Applications/Local Scrapbox.app"; do
  if [[ -d "${app}" ]]; then open "${app}"; exit 0; fi
done
export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH}"
bash macos/install.sh
read '?Enterで閉じる'
