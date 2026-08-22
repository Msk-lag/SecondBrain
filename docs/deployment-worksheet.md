# デプロイ作業票(人間が実行する手順)

**この文書は「何を、どの順に、手を動かすか」だけを書く。** なぜそうするのかと設計判断は
`docs/deployment.md` にある。各ステップの末尾に参照先(§N)を示す。

- 想定所要時間: **合計 3〜4時間**(AWS の作成待ちを含む。デモ投入を除く)
- 実行者: 人間(AWS コンソール操作・SSH・秘密の配置はエージェントが代行できない)
- 進め方: 1ステップ実行 → **確認**の出力を見る → 合っていれば次へ。合わなければ止まる

---

## 記入欄(進めながら埋める)

作業中この表を手元に置き、決まった値を書き込む。後のステップで何度も使う。

| 記号 | 内容 | 値 |
|---|---|---|
| `HOST` | 公開ホスト名(例 `secondbrain-msk.duckdns.org`) | |
| `EIP` | EC2 の Elastic IP | |
| `RDS_EP` | RDS のエンドポイント(`xxx.rds.amazonaws.com`) | |
| `RDS_USER` | RDS のマスターユーザー名 | |
| `RDS_PW` | RDS のマスターパスワード | |
| `SG_EC2` | EC2 用セキュリティグループ ID(`sg-...`) | |
| `SG_RDS` | RDS 用セキュリティグループ ID(`sg-...`) | |
| `MYIP` | 自宅のグローバル IP(SSH 許可元) | |
| `NODE_BIN` | EC2 上の node の絶対パス | |

**秘密の値(`RDS_PW` 等)はこの文書に書き込まない。** 手元のパスワードマネージャ等に置く。

---

## P0. 事前に用意する(30分・AWS の外)

- [ ] **`OPENAI_API_KEY`** を取得する(https://platform.openai.com/api-keys)
- [ ] **`ANTHROPIC_API_KEY`** を取得する(https://console.anthropic.com/settings/keys)
  - ⚠️ 現在ローカルにある値は **401 で無効**。使い回さず新規に取り直すこと
- [ ] OpenAI 側で**使用上限(Usage limits)を設定**する(想定外課金の防止)
- [ ] 自宅のグローバル IP を調べて `MYIP` に記入する

```bash
curl -s https://checkip.amazonaws.com
```

### ⚠️ リージョンを先に確定する

**P2 以降で作るセキュリティグループ・VPC・RDS・EC2 は、すべて同一リージョン・
同一 VPC に無ければ接続できない。** 後からリージョンを変えると P2 からやり直しになる。

- [ ] 使うリージョンを1つ決める(例: `ap-northeast-1`)
- [ ] **そのリージョンで MariaDB 11.8 が選べることを先に確認する**
  - RDS コンソール → データベースの作成 → 標準作成 → エンジン **MariaDB** →
    エンジンバージョンの一覧に **11.8** があるか見るだけでよい(作成はしない)
  - 無ければ**別リージョンで同じ確認をしてから**リージョンを決める
  - ⚠️ **11.4 以前は MariaDB Vector 非対応**なので使えない
- [ ] 以降、コンソール右上のリージョン表示が常にこの値であることを確認しながら進める

ここで 11.8 が見つかるリージョンが1つも無い場合は、**作業を止めて相談する**
(構成の前提が崩れるため)。

---

## P1. DuckDNS でホスト名を取る(5分)

- [ ] https://www.duckdns.org/ を開き、GitHub 等でログインする
- [ ] `sub domain` に希望名(例 `secondbrain-msk`)を入れて **add domain**
- [ ] `HOST` に `<希望名>.duckdns.org` を記入する
- [ ] ページに表示される **token** を控える(P5 で使う)

現時点では IP が未確定なのでそのままでよい。P5 で更新する。

> 独自ドメインを使う場合もここで用意する。以降の手順は `HOST` が違うだけで同一。(§3)

---

## P2. セキュリティグループを2つ作る(10分)

**RDS 用は EC2 用を参照するので、EC2 用を先に作る。**

### P2-1. EC2 用(`SG_EC2`)

- [ ] EC2 コンソール → セキュリティグループ → **セキュリティグループを作成**
- [ ] 名前: `secondbrain-ec2` / VPC: デフォルト
- [ ] インバウンドルールを3つ:

| タイプ | ポート | ソース |
|---|---|---|
| SSH | 22 | **カスタム → `MYIP`/32** |
| HTTP | 80 | Anywhere-IPv4(`0.0.0.0/0`) |
| HTTPS | 443 | Anywhere-IPv4(`0.0.0.0/0`) |

- [ ] **3000 / 6379 / 9000 / 9001 は追加しない**
- [ ] 作成後、`SG_EC2` に ID を記入する

> 80 を全開にするのは Let's Encrypt の HTTP-01 検証に必要だから。(§2)

### P2-2. RDS 用(`SG_RDS`)

- [ ] 名前: `secondbrain-rds` / VPC: デフォルト
- [ ] インバウンドルールを1つだけ:

| タイプ | ポート | ソース |
|---|---|---|
| MySQL/Aurora | 3306 | **カスタム → `SG_EC2`(セキュリティグループを指定)** |

- [ ] `0.0.0.0/0` にしない
- [ ] `SG_RDS` に ID を記入する

---

## P3. RDS を作る(操作15分 + 作成待ち10〜20分)

- [ ] RDS コンソール → **データベースの作成**
- [ ] 作成方法: **標準作成**
- [ ] エンジン: **MariaDB**
- [ ] エンジンバージョン: **11.8**(一覧に無ければ P3-X へ)
- [ ] テンプレート: 開発/テスト(または無料利用枠)
- [ ] DB インスタンス識別子: `secondbrain`
- [ ] マスターユーザー名 / パスワード: **ローカルとは別の値**を生成 → `RDS_USER` / `RDS_PW`
- [ ] インスタンスクラス: `db.t4g.micro`
- [ ] ストレージ: gp3 / 20GB
- [ ] 接続: **パブリックアクセス なし**
- [ ] VPC セキュリティグループ: **既存を選択 → `secondbrain-rds`**(既定の default を外す)
- [ ] **追加設定 → 最初のデータベース名: `secondbrain`**
  - ⚠️ **ここが最重要。空のまま作ると DB が作られず、後の `pnpm db:migrate` が失敗する。**
    RDS は後から「最初のデータベース名」を変更できない
- [ ] 自動バックアップ: 有効(既定)
- [ ] 作成 → **利用可能**になるまで待つ
- [ ] エンドポイントを `RDS_EP` に記入する

### P3-X. 11.8 が選べない場合

P0 でリージョンを確認しているはずなので、通常ここには来ない。来た場合は**リージョンを
間違えている**可能性が高いので、まずコンソール右上のリージョン表示を確認する。

本当に選べない場合、**リージョンを変えるなら P2 からやり直す**
(セキュリティグループと VPC はリージョン固有で、別リージョンからは選択できない。
RDS と EC2 が別リージョン・別 VPC になると接続できない)。ここで詰まったら相談する。

---

## P4. EC2 を作る(10分)

- [ ] EC2 コンソール → **インスタンスを起動**
- [ ] 名前: `secondbrain`
- [ ] AMI: **Amazon Linux 2023**
- [ ] インスタンスタイプ: **t3.small**
  - ⚠️ `t3.micro`(1GB)は Vite / Nest のビルド中に OOM で落ちる可能性が高い
- [ ] キーペア: 新規作成(`.pem` をダウンロードして安全な場所へ)
- [ ] ネットワーク設定 → **既存のセキュリティグループを選択 → `secondbrain-ec2`**
- [ ] ストレージ: **30GB** gp3
- [ ] 起動

### Elastic IP を割り当てる

- [ ] EC2 コンソール → Elastic IP → **Elastic IP アドレスの割り当て** → 割り当て
- [ ] 作成した EIP を選択 → **アクション → Elastic IP アドレスの関連付け** → 上のインスタンス
- [ ] `EIP` に記入する

> パブリック IPv4 は使用中でも課金されるため、EIP を付けても追加コストは増えない。
> 再起動で IP が変わらなくなる分だけ得。(§2)

---

## P5. DuckDNS を EIP に向ける(2分)

- [ ] DuckDNS のページで、該当サブドメインの `current ip` に `EIP` を入れて **update ip**
- [ ] 手元の PC から反映を確認する:

```bash
nslookup <HOST>
```

**確認**: 応答の Address が `EIP` と一致すること。一致するまで先へ進まない。(§3)

---

## P6. EC2 に SSH で入り、下ごしらえをする(20分)

### 接続(Windows)

`.pem` の権限を絞ってから接続する。PowerShell では:

```powershell
icacls "$env:USERPROFILE\Downloads\secondbrain.pem" /inheritance:r /grant:r "$env:USERNAME:R"
ssh -i "$env:USERPROFILE\Downloads\secondbrain.pem" ec2-user@<EIP>
```

**確認**: `[ec2-user@ip-... ~]$` のプロンプトが出ること。

### 下ごしらえ(以降すべて EC2 上で実行)

`docs/deployment.md` §4 のコマンドブロックをそのまま貼り付ける。内訳:

- [ ] `dnf update` / `git` / `rsync`
- [ ] **Node 24**
- [ ] **Docker** + `usermod -aG docker ec2-user`
- [ ] **Docker Compose v2 プラグイン**(⚠️ AL2023 の `docker` パッケージに同梱されない)
- [ ] **アプリ実行用ユーザー `secondbrain`**(docker グループに入れない)
- [ ] **Caddy**
- [ ] **スワップ 2GB**(ビルド時の OOM 対策)

`usermod` の後は**一度ログアウトして再接続する**(グループ反映のため)。

```bash
exit
# 再接続してから
docker ps                 # sudo 無しで通ること
docker compose version    # v2 系が出ること
node -v                   # v24.x
id secondbrain            # docker が含まれないこと
command -v node           # → NODE_BIN に記入
```

**確認**: 上の4つがすべて期待どおり。`docker compose` が無ければ P6 のプラグイン導入をやり直す。

---

## P7. リポジトリを配置する(5分)

リポジトリは PRIVATE なので **deploy key** を使う。(§5)

```bash
sudo mkdir -p /srv/secondbrain && sudo chown ec2-user:ec2-user /srv/secondbrain
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ''
cat ~/.ssh/id_ed25519.pub
```

- [ ] 表示された公開鍵を GitHub の **リポジトリ → Settings → Deploy keys → Add deploy key** へ登録
  - Allow write access は**オフのまま**でよい

```bash
git clone git@github.com:Msk-lag/SecondBrain.git /srv/secondbrain/app
cd /srv/secondbrain/app

sudo chown -R ec2-user:secondbrain /srv/secondbrain/app
sudo chmod -R g+rX /srv/secondbrain/app
```

**確認**: `git log --oneline -1` が最新コミットを表示する。

---

## P8. `.env` を作る(インフラ接続情報のみ)(10分)

`/srv/secondbrain/app/.env` を作る。**AI キー・`JWT_SECRET`・MinIO root は書かない。**
テンプレートは `docs/deployment.md` §6-1 にある。埋める値:

- `CORS_ORIGIN=https://<HOST>`
- `MARIADB_HOST=<RDS_EP>` / `MARIADB_USER=<RDS_USER>` / `MARIADB_PASSWORD=<RDS_PW>`
- `MARIADB_DATABASE=secondbrain`
- **`MARIADB_SSL=true`** ← ⚠️ 未設定だと DB 接続が全滅する
- MinIO のアプリ用資格情報(`MINIO_APP_ACCESS_KEY` / `MINIO_APP_SECRET_KEY`)は
  適当な強いランダム文字列を生成して入れる

```bash
# ランダム値の生成(必要な回数だけ実行)
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"

# 作成後
sudo chown ec2-user:secondbrain /srv/secondbrain/app/.env
sudo chmod 640 /srv/secondbrain/app/.env
```

**確認**: `grep -c MARIADB_SSL .env` が `1` を返す。

> ここでアプリが使う DB ユーザーは RDS のマスターユーザーのままにしている。
> ランタイム用の最小権限ユーザーへの分離は **Issue #79 で risk-accepted とした**
> (実機で grant を検証できない状態で決め打ちすると、権限不足が本番でのみ
> 実行時エラーとして出るため)。理由は `docs/deployment.md` §6-5。

---

## P9. ⛔ 最初の関門 — RDS で VECTOR が使えるか実測する(15分)

**ここが通らなければ、この構成では動かない。先へ進まず相談すること。**

```bash
cd /srv/secondbrain/app
sudo corepack enable
pnpm install --frozen-lockfile     # t3.small で数分かかる

pnpm db:migrate                    # migration 0000〜0006
pnpm poc:vector                    # VECTOR 型 + VEC_DISTANCE_COSINE
```

**確認**:

- `pnpm db:migrate` がエラー無く完了する
- `pnpm poc:vector` の最後に
  `OK: MariaDB VECTOR type + VEC_DISTANCE_COSINE returned the expected similarity order.`
  が出て、表の `dist` が `near-a` < `near-b` < `far` の順になっている

**失敗したときの見分け方**:

| メッセージ | 原因 |
|---|---|
| `ER_ACCESS_DENIED` / 接続できない | `MARIADB_HOST` / 資格情報の誤り、または `SG_RDS` が `SG_EC2` を許可していない |
| TLS 関連のエラー | `MARIADB_SSL=true` を書いていない |
| `Unknown database 'secondbrain'` | **P3 で「最初のデータベース名」を入れ忘れた**。`CREATE DATABASE secondbrain;` で回復できる |
| `VECTOR` 構文エラー / 関数が無い | **RDS のバージョンが Vector 非対応。ここで停止して相談する** |

(§1)

---

## P10. 残りの秘密を配置する(15分)

用途ごとに置き場所を分ける。**アプリが読む `.env` には入れない。**(§6-2〜§6-4)

```bash
sudo mkdir -p /etc/secondbrain

# api 専用(JWT_SECRET)
node -e "console.log('JWT_SECRET=' + require('crypto').randomBytes(32).toString('hex'))" \
  | sudo tee /etc/secondbrain/api.env > /dev/null
sudo chmod 600 /etc/secondbrain/api.env
```

- [ ] `/etc/secondbrain/worker.env` を作り、`OPENAI_API_KEY=` と `ANTHROPIC_API_KEY=` の2行を書く
- [ ] `/etc/secondbrain/minio-root.env` を作り、`MINIO_ROOT_USER=` と `MINIO_ROOT_PASSWORD=` の2行を書く

```bash
sudo chmod 600 /etc/secondbrain/worker.env
sudo chown ec2-user:ec2-user /etc/secondbrain/minio-root.env
sudo chmod 600 /etc/secondbrain/minio-root.env
```

**確認**:

```bash
sudo -u secondbrain cat /etc/secondbrain/minio-root.env   # 「許可がありません」で失敗すれば正しい
```

---

## P11. ミドルウェアを起動する(5分)

```bash
cd /srv/secondbrain/app
COMPOSE="docker compose --env-file .env --env-file /etc/secondbrain/minio-root.env -f docker-compose.prod.yml"
$COMPOSE up -d
$COMPOSE ps
curl -fsS http://127.0.0.1:9000/minio/health/live && echo "minio: live"
```

**確認**: redis が healthy、`minio: live` が出る、`minio-init` が `Exited (0)`。(§7)

---

## P12. リバースプロキシと常駐サービスを設定する(15分)

### Caddy

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
echo "SB_PUBLIC_HOST=<HOST>" | sudo tee /etc/caddy/caddy.env > /dev/null
sudo systemctl edit caddy
```

エディタが開くので、`[Service]` の下に次の1行を書いて保存する:

```
EnvironmentFile=/etc/caddy/caddy.env
```

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl enable --now caddy
sudo systemctl status caddy --no-pager | head -5
```

**確認**: `validate` が通り、`active (running)` になる。

### systemd(api / worker)

- [ ] `deploy/secondbrain-api.service` と `deploy/secondbrain-worker.service` の
      **`ExecStart` の node パスを `NODE_BIN` に書き換える**(既定は `/usr/bin/node`)

```bash
sudo cp deploy/secondbrain-api.service deploy/secondbrain-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable secondbrain-api secondbrain-worker
```

まだ起動しない(P13 のビルド後に起動する)。

> ⚠️ worker の初回起動で `note-purge` が論理削除済みデータを**物理削除する**。
> 本番は空 DB なので問題ないが、認識しておく。(§8)

---

## P13. ビルドしてデプロイする(15分)

```bash
cd /srv/secondbrain/app
SB_PUBLIC_HOST=<HOST> bash deploy/deploy.sh
```

スクリプトが各段で検証しながら、ビルド → 静的ファイル配置 → migration →
api/worker/caddy の再起動 → `/api/health` の確認までを行う。

**確認**: 最後に `{"status":"ok"}` と「完了」が出る。

**途中で止まった場合**:

| メッセージ | 対処 |
|---|---|
| `web バンドルに http://localhost:3000 が残っている` | `SB_PUBLIC_HOST` を付けずに実行した。付け直す |
| `dist/main.js が存在しないか空` | ビルド失敗。直前のログを見る(メモリ不足ならスワップを確認) |
| `systemctl is-active` が `failed` | `sudo journalctl -u secondbrain-api -n 50 --no-pager` で原因を見る |

(§9)

### HTTPS の確認

手元の PC のブラウザで `https://<HOST>/` を開く。

**確認**: 鍵アイコンが出て警告が無い。ログイン画面が表示される。

証明書が取れない場合は §13 を参照(80 が閉じている / DNS 未反映 / 名前が違う)。

---

## P14. ⛔ AI キーが本当に有効か確かめる(5分)

**「設定されている」と「有効である」は別物。** ここを飛ばすと、後で
「ノートは増えるのにエッジが一本も張られない」状態を延々と調べることになる。

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

**確認**: `openai:200` と `anthropic:200` の両方。**片方でも 401 なら先へ進まない。**(§9-2)

---

## P15. ⛔ スモークテスト — ここを通って初めて「デプロイ成功」(15分)

- [ ] `https://<HOST>/` でユーザー登録 → ログイン
- [ ] **メモを2件**作成する(内容は関連しそうなもの。例: 「肉料理」「ハンバーグ」)
  - ⚠️ **1件では候補ノートが無いのでエッジは張られない。** 仕様どおりの挙動だが、
    「壊れている」と誤認しやすい。必ず2件
- [ ] 2件目の処理完了を待つ

```bash
# EC2 上で確認
sudo journalctl -u secondbrain-worker -n 50 --no-pager

mariadb -h <RDS_EP> -u <RDS_USER> -p --ssl secondbrain -e "
  SELECT id, enrichment_status, relation_status FROM notes ORDER BY created_at DESC LIMIT 5;
  SELECT COUNT(*) AS edges FROM note_relations;
"
```

**確認**:

- 2件とも `enrichment_status='completed'`
- `edges` が **1以上**
- worker のログに実ジョブの処理記録がある
- ログに DB のパスワードや接続文字列が出ていない

(§10)

---

## P16. デモコンテンツを投入する = E2E 通し確認(60〜90分)

原稿は `.ai/demo-content/draft.md`(17件・料理題材)。**Git 管理外なので手元の PC にある。**

守ること:

- [ ] **必ず番号順に投入する**(投入順がそのままネットワークの形を決める)
- [ ] **1件ずつ AI 処理の完了を待ってから次を入れる**
- [ ] ペアの2件目の直後に `/network` でエッジを確認し、**狙いが外れたら後続を貼る前に貼り直す**
- [ ] 1件目はエッジが張られない(候補ゼロ。仕様どおり)

**確認**:

- 17件すべて投入できた
- `/network` でノードと関係線が意図した形になっている
- 孤立ノート2件が孤立したまま描かれている(トグルの実演材料)
- **ノートを保存すると `/network` を開いたままノードが増える**(要件 §2.1 の中心体験)

(§11)

---

## P17. 提出

- [ ] `https://<HOST>/` を提出用 URL として控える
- [ ] 審査者が触れるよう、デモ用アカウントの ID / パスワードを用意する(または新規登録可を明記)

---

## P18. 撤収(提出・レビュー期間の終了後)

**やらないと課金が続く。**(§14)

⚠️ **書き込み元を止めてからスナップショットを取ること。** 稼働したまま EBS スナップ
ショットを取ると、MinIO のオブジェクトとメタデータの更新途中が保存され、復元しても
整合性が保証できない。

```bash
# 1. 外部からの書き込みを止める
sudo systemctl stop caddy

# 2. アプリを止める(worker を先に。実行中ジョブの書き込みを止めるため)
sudo systemctl stop secondbrain-worker secondbrain-api

# 3. MinIO を正常終了させる
cd /srv/secondbrain/app
docker compose --env-file .env --env-file /etc/secondbrain/minio-root.env \
  -f docker-compose.prod.yml stop

# 4. 書き込みが残っていないことを確認
sync
```

- [ ] 上の1〜4で全て停止した
- [ ] **EBS スナップショットを取る**(MinIO のデータ保全)
- [ ] **RDS のスナップショットを取る**
- [ ] 両方のスナップショットが **completed** になったことをコンソールで確認する
- [ ] EC2 を終了する
- [ ] **Elastic IP を解放する**(解放し忘れが最も多い課金原因)
- [ ] RDS を削除する(削除時のスナップショット作成を求められたら取っておく)

---

## 詰まったときの一覧

症状別の切り分け表は `docs/deployment.md` §13 にある。

判断に迷ったら**その場で止めて、実行したコマンドと出力を添えて相談する**。
特に P9(VECTOR)・P14(AI キー)・P15(スモーク)は、通らないまま先へ進むと
原因の切り分けが難しくなる。
