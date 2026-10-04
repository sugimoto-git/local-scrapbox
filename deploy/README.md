# サーバーへ公開する手順（notes.sugiduino.net）

さくらのVPS（`153.126.174.161`）に、`https://notes.sugiduino.net` で公開します。ノートは最初は空です。ログインはアプリ内のパスワードで行います。

構成：ブラウザ → Nginx（HTTPS） → アプリ（`127.0.0.1:3210`、systemdで常駐）。データはVPSの `/var/lib/local-scrapbox` に置き、毎日バックアップします。

## 最短：1本で実行

DNS（手順1）だけ先に済ませたら、あとはMacのターミナルでこれだけです。

```sh
bash ~/Documents/開発/local-scrapbox/deploy/setup-all.sh
```

手順2〜5（Node.js・ファイル送信・パスワード設定・常駐/Nginx/HTTPS）を続けて行います。途中で聞かれるのは、VPSのログイン、sudoのパスワード、アプリのログインパスワード（新規に決める）、certbotのメールアドレスです。DNSがまだなら、確認して止まります。以下は、各手順を1つずつ行いたいとき・詰まったときの詳細です。

`Mac:` と書かれたものはMacのターミナル、`VPS:` はVPSにログインした状態のターミナルで実行します。VPSへは `ssh ubuntu@153.126.174.161` で入り、抜けるときは `exit` です。

## 1. DNS（Mac不要・ブラウザで作業）

sugiduino.net のDNS管理画面で、次のAレコードを追加します。

| 種類 | ホスト名 | 値 |
|---|---|---|
| A | notes | 153.126.174.161 |

反映確認（Mac）：

```sh
dig +short notes.sugiduino.net
```

`153.126.174.161` と出れば完了です（数分〜1時間ほどかかることがあります）。手順5の証明書取得は、これが出てから行ってください。

## 2. VPSにNode.js 22.13以上を入れる（未導入の場合）

VPS:

```sh
node -v
```

`v22.13` 以上ならこの手順は不要です。無い、または古い場合：

```sh
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v
```

## 3. Macからファイルを送る

Mac:

```sh
bash ~/Documents/開発/local-scrapbox/deploy/deploy.sh
```

ノート・画像・ログイン設定（VPS側の `/var/lib/local-scrapbox`）には触れません。Macの `data/` も送りません。初回は「続きはVPS上での作業」と表示されて終わります。

## 4. パスワードを決める

VPS:

```sh
sudo mkdir -p /var/lib/local-scrapbox
sudo chown $USER:$USER /var/lib/local-scrapbox
SCRAPBOX_DATA_DIR=/var/lib/local-scrapbox node ~/local-scrapbox/set-password.mjs
```

12文字以上のパスワードを2回入力します（入力は画面に表示されません）。ハッシュだけが `auth.json` に保存され、パスワード自体は残りません。

## 5. 常駐設定・Nginx・HTTPSをまとめて設定

VPS:

```sh
bash ~/local-scrapbox/deploy/vps-setup.sh
```

途中でsudoのパスワードを聞かれます。次を自動で行います：nginx・certbotの導入、systemdサービスの登録と起動、Nginxの設定、毎日3:17のバックアップ登録、HTTPS証明書の取得（メールアドレスなどを聞かれたら答えてください）。何度実行しても安全です。

終わったら https://notes.sugiduino.net を開き、手順4のパスワードでログインします。

## 更新するとき

アプリを直したあと、Macから手順3をもう一度実行するだけです（自動で再起動します）。

## バックアップと復元

- 毎日3:17に、SQLiteのバックアップと画像を `/var/backups/local-scrapbox` へ保存します（古いものは自動で整理）。ログは同じ場所の `backup.log` です。
- 手動で取る：`SCRAPBOX_DATA_DIR=/var/lib/local-scrapbox BACKUP_DIR=/var/backups/local-scrapbox node ~/local-scrapbox/deploy/backup.mjs`
- 手元にも保管したい場合は、アプリの左上メニュー「JSONを書き出す（画像を含む）」が使えます。

## パスワードを変える

VPS:

```sh
SCRAPBOX_DATA_DIR=/var/lib/local-scrapbox node ~/local-scrapbox/set-password.mjs
sudo systemctl restart local-scrapbox
```

変更すると、すべての端末のログインが無効になります。

## 困ったとき

| 症状 | 確認 |
|---|---|
| 502 Bad Gateway | `systemctl status local-scrapbox` と `journalctl -u local-scrapbox -n 50` |
| アプリが起動しない | ログに「パスワード未設定」と出ていれば手順4をやり直す |
| 証明書の取得に失敗 | `dig +short notes.sugiduino.net` がVPSのIPか確認し、`bash ~/local-scrapbox/deploy/vps-setup.sh` を再実行 |
| ログインできない（連続失敗） | 15分待つか、`sudo systemctl restart local-scrapbox` |
| ファイアウォール | さくらのVPSのパケットフィルタで 80/443 を許可（`sudo ufw status` も確認） |

## 環境変数（vps-setup.sh が設定します）

| 名前 | 意味 |
|---|---|
| `HOST` | 待ち受けアドレス。サーバーでは `127.0.0.1`（Nginx経由のみ） |
| `PORT` | 待ち受けポート（既定 3210） |
| `SCRAPBOX_DATA_DIR` | データの場所 |
| `ALLOWED_HOSTS` | 許可するドメイン（カンマ区切り）。これ以外のHostは拒否 |
| `TRUST_PROXY` | `1` でNginxの `X-Forwarded-*` を信頼（IP別の回数制限・Secure Cookie用） |
