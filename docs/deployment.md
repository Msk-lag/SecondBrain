# 初回デプロイ手順書(AWS EC2 + RDS)

対象: Issue #66「[公開前必須] 初回デプロイ時のセキュリティ・動作チェックリスト」

> **実際に手を動かすときは `docs/deployment-worksheet.md` を使うこと。**
> 本書は「なぜそうするのか」と設計判断・#66 との対応を記録する**参照文書**であり、
> 上から順に実行できる形にはなっていない(§1 が §2 の後を指す等の前方参照がある)。
> 作業票のほうは AWS コンソールの操作単位まで落として線形に並べてあり、
> 各ステップから本書の該当節を参照している。

構成は PROJECT.md「デプロイ方式」に従い **EC2 1台 + RDS for MariaDB 11.8**。
アプリ(api / worker / web)は **EC2 のホスト上で直接実行**し、リバースプロキシ
(Caddy)が HTTPS 終端と静的配信を担う。Redis / MinIO のみ Docker Compose で動かす。

> **なぜコンテナ化しないか**: PROJECT.md は当初「Docker Compose でアプリ一式」と
> 書いていたが、pnpm モノレポ用のマルチステージ Dockerfile を新規に3本作って
> 検証する時間的余裕が無いため、ホスト直実行 + リバースプロキシを採用した
> (2026-08-22 決定)。PROJECT.md の記述は本手順書の実績に合わせて改訂済み。

---

## 0. 前提(これが揃わないと先へ進めない)

| # | 前提 | 担当 |
|---|---|---|
| 0-1 | PR #77(M2-2)が main へマージ済み | ユーザー |
| 0-2 | `OPENAI_API_KEY` の実値 | ユーザー |
| 0-3 | `ANTHROPIC_API_KEY` の**有効な**実値(既存値は 401 で無効。§9-2 で検証する) | ユーザー |
| 0-4 | AWS アカウント(EC2 / RDS を作成できる権限) | ユーザー |
| 0-5 | 公開ホスト名(独自ドメイン、または DuckDNS 等の無料サブドメイン) | ユーザー |

以降 `SB_PUBLIC_HOST` は 0-5 で決めたホスト名(例 `secondbrain-xxx.duckdns.org`)を指す。

---

## 1. RDS を作る(**最初にやる。ここで詰むと全部やり直し**)

Issue #66 の最優先項目は「RDS の採用バージョンで `VECTOR` 型と `VEC_DISTANCE_COSINE` が
**実際に**使えるか」である。ローカルの `mariadb:11.8` では確認済みだが **RDS 実機は未検証**。
使えなければ F-7 / F-19 / F-20(このアプリの中心機能)が本番で動かないため、
**EC2 を作る前に、この1点だけを先に潰す**。

1. RDS for MariaDB を作成する
   - エンジンバージョン: **11.8**(MariaDB Vector 対応)
   - インスタンス: `db.t4g.micro`(デモ用途。後から変更可)
   - ストレージ: 20GB gp3
   - **初期データベース名: `secondbrain`**(⚠️ **指定を忘れると DB そのものが作られず、
     `pnpm db:migrate` が接続段階で失敗する**。RDS は初期データベース名を後から
     追加できないので、忘れた場合は管理接続で `CREATE DATABASE secondbrain;` を
     実行してから migration を流すこと)
   - **パブリックアクセス: なし**
   - 自動バックアップ: 有効(既定)
   - マスターユーザー名 / パスワードは**ローカルと別の値**を生成する(#66「秘密情報」)
2. セキュリティグループは **EC2 のセキュリティグループからの 3306 のみ許可**する
   (`0.0.0.0/0` にしない。#66「セキュリティグループ」)
3. EC2 を作った後(§2 の後)、EC2 上から接続して**必ず次を実測する**:

```bash
# EC2 上・リポジトリ配置後に実行する
pnpm db:migrate     # migration 0000〜0006 が通ること
pnpm poc:vector     # VECTOR 型と VEC_DISTANCE_COSINE が実際に動くこと
```

**`pnpm poc:vector` が失敗した場合は、そこで停止してユーザーへ報告する。**
回避策(pgvector 互換への切替等)は MariaDB 制約により存在しないため、
バージョン選定からのやり直しになる。

- [ ] 初期データベース名に `secondbrain` を指定した(または `CREATE DATABASE` 済み)
- [ ] RDS 11.8 で `pnpm db:migrate` が通った
- [ ] RDS 11.8 で `pnpm poc:vector` が通った

---

## 2. EC2 を作る

1. インスタンス: **t3.small 以上**を推奨
   - Vite / Nest のビルドをインスタンス上で行うため、`t3.micro`(1GB)では
     **ビルド中に OOM で落ちる可能性が高い**。t3.small(2GB)+ スワップ2GB を
     用意しておくと安全
2. OS: Amazon Linux 2023
3. ストレージ: 30GB gp3(MinIO のデータもここに載る)
4. セキュリティグループ(インバウンド):

| ポート | ソース | 用途 |
|---|---|---|
| 22 | 自宅の固定 IP のみ | SSH |
| 80 | `0.0.0.0/0` | Let's Encrypt の HTTP-01 検証 + HTTPS へのリダイレクト |
| 443 | `0.0.0.0/0` | 本番アクセス |

**3000 / 6379 / 9000 / 9001 は開けない。** これらは `127.0.0.1` にのみ束縛され、
リバースプロキシと SSH ポートフォワード経由でしか届かない(#66「インフラ」)。

5. **パブリック IPv4 は使用中でも課金対象**(2024-02 以降・約 $0.005/時)。
   Elastic IP を割り当てても追加コストは増えないので、**再起動で IP が変わらないよう
   Elastic IP を付ける**(DNS レコードの貼り直しを防ぐ)。

- [ ] SSH で接続できた
- [ ] SG が上表のとおり(3000 / 6379 / 9000 が閉じている)

---

## 3. ホスト名を EC2 へ向ける

**独自ドメインの場合**: A レコードを Elastic IP へ向ける。

**DuckDNS の場合**: サブドメインを作成し、IP に Elastic IP を設定する。数秒で反映される。

```bash
# 反映確認(EC2 の Elastic IP が返ること)
dig +short "$SB_PUBLIC_HOST"
```

> `*.compute.amazonaws.com`(EC2 の既定 DNS 名)では **Let's Encrypt が証明書を発行しない**。
> 必ず自分で管理できるホスト名を用意すること。

- [ ] `dig` が Elastic IP を返す

---

## 4. サーバーの下ごしらえ

```bash
sudo dnf update -y
sudo dnf install -y git rsync

# Node 24(PROJECT.md の開発環境と揃える)
curl -fsSL https://rpm.nodesource.com/setup_24.x | sudo bash -
sudo dnf install -y nodejs
sudo corepack enable

# Docker
sudo dnf install -y docker
sudo systemctl enable --now docker
sudo usermod -aG docker ec2-user   # 反映のため一度ログアウト・再ログイン

# Docker Compose v2(⚠️ Amazon Linux 2023 の `docker` パッケージには
# Compose プラグインが同梱されない。入れ忘れると §7 で初めて失敗する)
sudo mkdir -p /usr/libexec/docker/cli-plugins
sudo curl -fsSL -o /usr/libexec/docker/cli-plugins/docker-compose \
  "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m)"
sudo chmod +x /usr/libexec/docker/cli-plugins/docker-compose
docker compose version   # v2 系が表示されること

# アプリ実行用の専用ユーザー(ログイン不可・docker グループに入れない)
# ec2-user は docker グループに属するため、api / worker をそのユーザーで動かすと
# アプリの侵害が Docker ソケット経由でホスト root の奪取に直結する。
sudo useradd --system --no-create-home --shell /usr/sbin/nologin secondbrain

# Caddy(リバースプロキシ + 自動 HTTPS)
sudo dnf install -y 'dnf-command(copr)'
sudo dnf copr enable -y @caddy/caddy
sudo dnf install -y caddy

# ビルド時 OOM 対策のスワップ
sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

`node` の絶対パスを確認する(systemd ユニットの `ExecStart` に書く値):

```bash
command -v node    # 例: /usr/bin/node
```

- [ ] `node -v` が 24 系
- [ ] `docker ps` が sudo 無しで通る
- [ ] `docker compose version` が v2 系を返す
- [ ] `secondbrain` ユーザーを作成した(`id secondbrain` が docker を含まないこと)
- [ ] `command -v node` の値を控えた

---

## 5. リポジトリを配置する

リポジトリは PRIVATE のため、読み取り専用の **deploy key** を使う。

```bash
sudo mkdir -p /srv/secondbrain && sudo chown ec2-user:ec2-user /srv/secondbrain
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ''
cat ~/.ssh/id_ed25519.pub
# → GitHub の Settings > Deploy keys へ登録(Allow write access は不要)

git clone git@github.com:Msk-lag/SecondBrain.git /srv/secondbrain/app
cd /srv/secondbrain/app

# 専用ユーザー(§4 で作成)へ読み取りだけを許可する。書き込みは与えない。
# デプロイ(ビルド・配置)は ec2-user が行い、実行は secondbrain が行う。
sudo chown -R ec2-user:secondbrain /srv/secondbrain/app
sudo chmod -R g+rX /srv/secondbrain/app
```

- [ ] `git clone` できた
- [ ] `sudo -u secondbrain cat /srv/secondbrain/app/package.json` が読める

---

## 6. 秘密情報を配置する(**エージェントは触れない。ユーザーが手で行う**)

秘密は用途ごとに置き場所を分ける。

### 6-1. リポジトリルートの `.env`(インフラ接続情報)

`/srv/secondbrain/app/.env` を作る。**AI キーと JWT_SECRET はここに書かない。**

```
NODE_ENV=production
PORT=3000
CORS_ORIGIN=https://<SB_PUBLIC_HOST>

# RDS
MARIADB_HOST=<RDS エンドポイント>
MARIADB_PORT=3306
MARIADB_USER=<RDS のユーザー>
MARIADB_PASSWORD=<RDS のパスワード>
MARIADB_DATABASE=secondbrain
MARIADB_SSL=true

# Redis(ローカルの docker)
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_DB=0

# MinIO(ローカルの docker)
MINIO_HOST=127.0.0.1
MINIO_API_PORT=9000
MINIO_USE_SSL=false
MINIO_BUCKET=secondbrain
MINIO_APP_ACCESS_KEY=<ローカルと別の値>
MINIO_APP_SECRET_KEY=<ローカルと別の値>
```

作成後、専用ユーザーだけが読めるようにする:

```bash
sudo chown ec2-user:secondbrain /srv/secondbrain/app/.env
sudo chmod 640 /srv/secondbrain/app/.env
```

> **`MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` はここに書かない**(§6-4 へ分離する)。
> api / worker が使うのはアプリ用資格情報(`MINIO_APP_*`)だけであり、root 資格情報を
> 同じファイルに置くと、アプリが侵害された際に MinIO 全体の管理操作を取られる
> (Codex D0 指摘 [2])。

> ⚠️ **`MARIADB_SSL=true` は必須。** RDS for MariaDB 11.8 は `require_secure_transport`
> の既定値が `1` のため、**未設定だと DB 接続が全て失敗する**。
> `MARIADB_SSL` は `"true"` / `"false"` **のみ**有効で、それ以外の値は起動時エラーになる。
> AWS の CA バンドルを明示する場合のみ `MARIADB_SSL_CA=/path/to/ca.pem` を足す
> (未指定ならシステム信頼ストアで検証する)。証明書検証を無効化する経路は
> 意図的に用意していないので、繋がらないときは CA の配置で解決すること。

### 6-2. api 専用の秘密

```bash
sudo mkdir -p /etc/secondbrain
node -e "console.log('JWT_SECRET=' + require('crypto').randomBytes(32).toString('hex'))" \
  | sudo tee /etc/secondbrain/api.env > /dev/null
sudo chmod 600 /etc/secondbrain/api.env
```

> プレースホルダ(`changeme*`)・テスト固定値・32バイト未満の値は **api 起動時に
> fail-fast で拒否される**(#63)。上記コマンドが生成する64桁の16進数を使うこと。

### 6-3. worker 専用の秘密(AI キー)

`/etc/secondbrain/worker.env` を作り、`OPENAI_API_KEY` と `ANTHROPIC_API_KEY` の
2行だけを書く。作成後に `sudo chmod 600 /etc/secondbrain/worker.env` を実行する。

AI キーを `.env` ではなくここへ置くのは、#66「`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` を
worker のみへ注入(web/api には渡さない)」を満たすため。実際に api は両キーを
一切参照していない(参照は `apps/worker/` 配下のみ)。

### 6-4. Compose 専用の秘密(MinIO の root 資格情報)

`/etc/secondbrain/minio-root.env` を作り、`MINIO_ROOT_USER` と `MINIO_ROOT_PASSWORD` の
2行だけを書く。所有者は `ec2-user`、権限は `600` にする(`secondbrain` ユーザーからは
読めない状態にすることが目的)。

```bash
sudo chown ec2-user:ec2-user /etc/secondbrain/minio-root.env
sudo chmod 600 /etc/secondbrain/minio-root.env
```

このファイルは §7 の `docker compose --env-file` で読み込む。

### 6-5. RDS のランタイム用ユーザーについて(**今回は未実施**)

Codex D0 指摘 [2] は「RDS にもランタイム用の最小権限ユーザーを作り、migration 用と
分離せよ」としている。**指摘は妥当だが、今回は master ユーザーのまま進める。**

理由: 資格情報を分けると `deploy/deploy.sh` の `pnpm db:migrate` に別系統の資格情報を
渡す仕組みが要り、**デプロイ経路そのものを提出直前に作り替える**ことになる。利用者が
本人のみ・期間限定公開という条件下では、その変更が持ち込むデプロイ失敗リスクのほうが
大きいと判断した。提出後に Issue として対応する。

- [ ] `.env` を作った(AI キー・JWT_SECRET・MinIO root は含めていない)
- [ ] `/etc/secondbrain/api.env`(600)を作った
- [ ] `/etc/secondbrain/worker.env`(600)を作った
- [ ] `/etc/secondbrain/minio-root.env`(600・ec2-user 所有)を作った
- [ ] `sudo -u secondbrain cat /etc/secondbrain/minio-root.env` が **失敗する**
- [ ] 本番の秘密は**すべてローカルと別の値**にした

---

## 7. ミドルウェアを起動する

```bash
cd /srv/secondbrain/app

# --env-file を明示すると既定の .env 読み込みが置き換わるため、両方を渡す。
# MinIO の root 資格情報は minio-root.env 側にしか無い(§6-4)。
COMPOSE="docker compose --env-file .env --env-file /etc/secondbrain/minio-root.env -f docker-compose.prod.yml"
$COMPOSE up -d
$COMPOSE ps
```

開発用の `docker-compose.yml` ではなく **`docker-compose.prod.yml`** を使う
(mariadb を含まず、RDS を前提にしているため)。

MinIO には Compose の healthcheck を置いていない(理由は `docker-compose.prod.yml` の
コメント参照)。死活はホスト側から無認証の readiness endpoint で確認する:

```bash
curl -fsS http://127.0.0.1:9000/minio/health/live && echo "minio: live"
```

- [ ] redis が healthy(`$COMPOSE ps` の STATUS 列)
- [ ] `minio/health/live` が成功する
- [ ] minio-init が正常終了し、バケットとアプリ用ポリシーが作られた
- [ ] MinIO バケットが非公開である(`mc anonymous get local/secondbrain` が `none`)

---

## 8. リバースプロキシと常駐サービスを設定する

```bash
cd /srv/secondbrain/app

# Caddy
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
echo "SB_PUBLIC_HOST=<SB_PUBLIC_HOST>" | sudo tee /etc/caddy/caddy.env > /dev/null
sudo systemctl edit caddy   # [Service] に EnvironmentFile=/etc/caddy/caddy.env を追記
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl enable --now caddy

# systemd(ExecStart の node パスを §4 で控えた値に直してから)
sudo cp deploy/secondbrain-api.service deploy/secondbrain-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable secondbrain-api secondbrain-worker
```

> ⚠️ **worker を起動すると `note-purge` バッチが走り、論理削除済みデータを
> 物理削除する**(#66 P1-5)。復元手段は無い。本番初回は空 DB なので問題ないが、
> 認識しておくこと。

- [ ] `caddy validate` が通る

---

## 9. ビルドしてデプロイする

```bash
cd /srv/secondbrain/app
SB_PUBLIC_HOST=<SB_PUBLIC_HOST> bash deploy/deploy.sh
```

このスクリプトは次を自動で行う(各段で実在確認をする):

1. `VITE_API_BASE_URL=https://<host>/api` を **export してから** web をビルドする
   - Vite は `import.meta.env.VITE_*` を**ビルド時に**埋め込む。export し忘れると
     既定値 `http://localhost:3000` が焼き込まれ、**画面は出るが API 呼び出しが
     全部失敗する**。スクリプトはビルド後のバンドルを grep して検出する
2. `*.tsbuildinfo` を全消しする
   - stale な tsbuildinfo が残ると tsc が「出力済み」と誤認し、**何も emit せず
     exit 0 で成功を装う**(#66 P0-3 / 修正済み #71)。2回目以降のデプロイで
     最も刺さる罠なので保険として消す
3. `pnpm build` → `dist/main.js` と `index.html` の実在を確認する
4. 静的ファイルを `/srv/secondbrain/web` へ配置する
5. `pnpm db:migrate` を流す
6. api / worker / caddy を再起動し、`/api/health` を叩く

### 9-1. HTTPS の確認

```bash
curl -I "https://$SB_PUBLIC_HOST/"               # 200 + 有効な証明書
curl -fsS "https://$SB_PUBLIC_HOST/api/health"   # {"status":"ok"}
```

### 9-2. AI キーの有効性を実リクエストで確認する(#66 P0-2)

「設定されている」ことと「有効である」ことは別物である。ローカルの
`ANTHROPIC_API_KEY` は設定済みだったが直接プローブすると
`401 authentication_error: invalid x-api-key` を返した。**存在確認では不十分。**

worker と同じ資格情報で、それぞれの API へ最小リクエストを1回ずつ投げる。
**`worker.env` は root しか読めない(600)ので、必ず root 権限で読み込むこと。**
シェルの環境変数を素で参照すると、キーが空のまま送られ、**有効なキーでも 401 に
見える**(Codex D0 指摘 [4])。

**キーを親シェルへ展開してはいけない。** `sudo env $(sudo cat ...)` の形にすると、
キーが `env` の引数として渡り、`ps` の出力と sudo の実行記録に平文で残る
(Codex R1 指摘 [8])。下記のように、root のサブシェルの**中で**読み込む。

```bash
sudo sh -c '
  . /etc/secondbrain/worker.env
  curl -s -o /dev/null -w "openai:%{http_code}\n" \
    https://api.openai.com/v1/models -H "Authorization: Bearer $OPENAI_API_KEY"
  curl -s -o /dev/null -w "anthropic:%{http_code}\n" \
    https://api.anthropic.com/v1/models -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01"
'
```

キーはコマンドラインにも出力にも現れない(sudo が記録するのは変数名のままの
スクリプト本文で、展開後の値ではない)。得られるのは HTTP ステータスだけ。

**両方 200 でなければ先へ進まない。** 401 のまま進むと、ノートは増えるのに
エッジが一本も張られない状態になり、**しかも worker は正常起動したまま静かに
失敗し続ける**(起動時 fail-fast しない設計)。

- [ ] `openai:200`
- [ ] `anthropic:200`
- [ ] `deploy.sh` が最後まで通った
- [ ] HTTPS で SPA が表示された
- [ ] `/api/health` が `{"status":"ok"}`

---

## 10. デプロイ後スモークテスト(#66 P1-6)

**ここを通るまで「デプロイ成功」と呼ばない。**

1. 本番 URL でユーザー登録 → ログイン
2. **メモを2件**作成する(1件では不十分 — 後述)
3. 両方が `enrichment_status='completed'` になることを確認
4. `note_relations` が **1行以上**増えることを確認

```bash
# EC2 上から RDS へ接続して確認
mariadb -h <RDS エンドポイント> -u <user> -p --ssl secondbrain -e "
  SELECT id, enrichment_status, relation_status FROM notes ORDER BY created_at DESC LIMIT 5;
  SELECT COUNT(*) AS edges FROM note_relations;
"
```

> ⚠️ **メモ1件では候補ノートが存在せずエッジは生成されない。** 候補0件のときは
> Claude を呼ばずに `relation_status='completed'` で正常終了する。これは設計どおりの
> 挙動だが、**成功と誤認しやすい**。必ず2件で確認すること。

worker が実ジョブを消化していることも合わせて確認する(#66 P0-4):

```bash
sudo journalctl -u secondbrain-worker -n 50 --no-pager
```

- [ ] メモ2件が両方 `completed`
- [ ] `note_relations` が1行以上
- [ ] worker のログに実ジョブの処理記録がある
- [ ] ログに DB 接続情報が出ていない(#66「未知例外ログ」)

---

## 11. デモコンテンツを投入する(= E2E 通し確認)

原稿は `.ai/demo-content/draft.md`(17件・料理題材)にある。

**必ず番号順に投入する。** 候補検索は「意味的に近い既存ノート上位5件」だけを対象とし
(`relation-candidates.ts` の `ORDER BY VEC_DISTANCE_COSINE ASC LIMIT 5`、**しきい値なし**)、
**投入順がそのままネットワークの形を決める**ため。

- 1件目は候補ゼロなのでエッジが張られない(仕様どおり)
- 1ノートあたり最大5本
- **1件ごとに AI 処理の完了を待つ**。ペアの2件目の直後にエッジを確認し、
  狙いが外れたら後続を貼る前に貼り直す
- 孤立ノート2件を意図的に混ぜてある(「何でも繋げる雑な AI ではない」ことの提示 +
  トグルの実演)

- [ ] 17件すべて投入した
- [ ] `/network` でノードと関係線が期待どおり描画された
- [ ] ノート保存 → `/network` を開いたままノードが増える(要件 §2.1 の中心体験)

---

## 12. Issue #66 チェックリストとの対応

| #66 の項目 | 本手順書での扱い |
|---|---|
| RDS で VECTOR が使えるか | §1(**最初に実測する**) |
| JWT の署名アルゴリズム固定・`exp` 検証 | 実装済み(#63・PR #72) |
| `JWT_SECRET` の最小長検証 | 実装済み(#63)。値の生成は §6-2 |
| `CORS_ORIGIN` を本番ドメインに限定 | §6-1。加えて web と api を**同一オリジン**に載せているため、そもそも越境リクエストが発生しない |
| Helmet / CSP | **一部のみ**。HSTS / nosniff / X-Frame-Options / Referrer-Policy は Caddy で適用済み。**CSP は未適用**(react-force-graph の canvas / worker / blob 依存を未検証のまま制限すると中心体験が本番でだけ壊れるため。提出後に実機で段階導入する) |
| アップロードの実体形式・容量検証 | 実装済み(マジックバイト判定)。本手順書での追加作業なし |
| レート制限 | **未実施**(#65。2026-08-22 にユーザー判断で保留。公開直後に対応) |
| 未知例外ログに DB 接続情報が出ないこと | 実装済み(`sanitize-enrichment-error.ts`)。§10 で目視確認する |
| MinIO バケットが非公開 | §7 |
| Redis / MinIO コンソールが公開されていないこと | §2 の SG + `127.0.0.1` 束縛(§7) |
| RDS / Redis / MinIO の TLS | RDS は `MARIADB_SSL=true`(§6-1)。Redis / MinIO は同一ホスト内のループバック接続のため TLS 不要 |
| セキュリティグループ | §2 |
| 本番用の秘密をローカルと別の値で生成 | §6 |
| アプリ実行ユーザーの権限分離 | §4・§5。api / worker は **docker グループに属さない専用ユーザー `secondbrain`** で動かす。`ec2-user` のまま動かすと Docker ソケット経由でホスト root を取られる(Codex D0 指摘 [1]) |
| MinIO root 資格情報の隔離 | §6-4。root 資格情報は Compose 専用ファイルへ分離し、アプリが読む `.env` にはアプリ用資格情報だけを置く(Codex D0 指摘 [2]) |
| RDS のランタイム用最小権限ユーザー | **未実施**(§6-5 に理由を記載。提出後に Issue 化) |
| AI キーを worker のみへ注入 | §6-3(systemd の `EnvironmentFile` で分離) |
| `VITE_` に秘密を含めない | `VITE_API_BASE_URL` のみ。§9 で公開 URL を入れるだけ |
| GitHub の secret scanning / push protection | リポジトリは PRIVATE のまま。public 化する場合に実施 |
| `MARIADB_SSL` / `MARIADB_SSL_CA` を `.env.example` へ記載 | **未実施**。`.env*` はエージェントが触れないためユーザーが手で追記する |
| migration が 0000〜0006 | §1 で `pnpm db:migrate` として実施 |
| P0-3 tsbuildinfo | §9(`deploy.sh` が自動で削除) |
| P0-4 worker の常駐・監視 | §8(systemd `Restart=always`)+ §10 の消化確認 |
| P1-5 note-purge の物理削除 | §8 の警告 |

---

## 13. 詰まったときの切り分け

| 症状 | 原因の第一候補 |
|---|---|
| 画面は出るが API が全部失敗する | `VITE_API_BASE_URL` がビルドへ渡っていない(`deploy.sh` が検出する) |
| `MODULE_NOT_FOUND` で api / worker が即死 | stale な tsbuildinfo で dist が空(§9 の 2) |
| 起動はするが実行中にクラッシュする | 同上の**部分的な** dist。最も厄介な出方 |
| DB 接続が全て失敗する | `MARIADB_SSL=true` が未設定(§6-1) |
| api が起動時に落ちる | `JWT_SECRET` がプレースホルダ / 32バイト未満(§6-2) |
| ノートは増えるがエッジが張られない | AI キーが無効。worker は正常起動したまま静かに失敗する(§9-2) |
| エッジが1本も張られない(メモ1件で確認した) | 仕様どおり。候補0件ではエッジを作らない(§10) |
| 証明書が取得できない | 80 番が閉じている / DNS が未反映 / `*.compute.amazonaws.com` を使っている(§3) |
| ページ再読み込みで 404 | SPA フォールバック未設定。`Caddyfile` の `try_files` を確認(§8) |
| 再起動後に `MODULE_NOT_FOUND` になる | `secondbrain` ユーザーがビルド成果物を読めない。`deploy.sh` の権限再適用が走ったか確認する |
| `docker compose` が見つからない | Compose v2 プラグイン未導入(§4)。AL2023 の `docker` パッケージには同梱されない |
| `up -d` で MINIO_ROOT_USER が未設定と言われる | `--env-file` に `minio-root.env` を渡していない(§7) |

---

## 14. 撤収(提出・レビュー期間の終了後)

PROJECT.md の運用方針どおり、AWS 公開は期間限定とする。

1. EBS スナップショットを取る(MinIO のデータ保全)
2. RDS のスナップショットを取る
3. EC2 を終了し、Elastic IP を解放する(**解放しないと課金が続く**)
4. RDS を削除する
