#!/usr/bin/env bash
# SecondBrain デプロイ(EC2 1台構成)。リポジトリルートで実行する。
#
#   SB_PUBLIC_HOST=secondbrain-xxx.duckdns.org bash deploy/deploy.sh
#
# 手順の詳細と初回セットアップは docs/deployment.md を参照。
# 本スクリプトは「2回目以降も安全に流せる」ことを目的とし、
# ビルド成果物の実在確認を各段で行う。
set -euo pipefail

WEB_ROOT="${WEB_ROOT:-/srv/secondbrain/web}"

: "${SB_PUBLIC_HOST:?SB_PUBLIC_HOST を指定すること(例: secondbrain-xxx.duckdns.org)}"

# ── web のビルド時定数 ───────────────────────────────────────────────
# Vite は import.meta.env.VITE_* を「ビルド時に」埋め込む。ここで export し忘れると
# 既定値 http://localhost:3000 が焼き込まれ、本番の SPA が自分の PC を叩きに行く。
# 症状は「画面は出るが API 呼び出しが全部失敗する」で、デプロイ後に気づきにくい。
export VITE_API_BASE_URL="https://${SB_PUBLIC_HOST}/api"
echo "==> VITE_API_BASE_URL=${VITE_API_BASE_URL}"

echo "==> 依存の導入"
pnpm install --frozen-lockfile

# tsbuildinfo が残っていると tsc が「出力済み」と誤認し、何も emit せず exit 0 する
# (Issue #66 P0-3)。apps/{api,worker} の build スクリプトは #71 で自分の分を消すように
# なっているが、2回目以降のデプロイで最も刺さる罠なので保険として全消しする。
echo "==> tsbuildinfo の掃除"
find . -name "*.tsbuildinfo" -not -path "*/node_modules/*" -delete

echo "==> ビルド"
pnpm build

echo "==> ビルド成果物の実在確認"
for entry in apps/api/dist/main.js apps/worker/dist/main.js apps/web/dist/index.html; do
  if [ ! -s "$entry" ]; then
    echo "ERROR: ${entry} が存在しないか空。build が失敗を握り潰している可能性がある" >&2
    exit 1
  fi
done

# 本番 SPA が localhost を向いていないことを、焼き込まれた実バンドルで直接確認する。
if grep -rq "http://localhost:3000" apps/web/dist/assets 2>/dev/null; then
  echo "ERROR: web バンドルに http://localhost:3000 が残っている。" >&2
  echo "       VITE_API_BASE_URL がビルドへ渡っていない。" >&2
  exit 1
fi

echo "==> 静的ファイルの配置: ${WEB_ROOT}"
sudo mkdir -p "${WEB_ROOT}"
sudo rsync -a --delete apps/web/dist/ "${WEB_ROOT}/"

# api / worker は docker グループに属さない専用ユーザー secondbrain で動く。
# pnpm install / build が作った新しいファイルにもグループ読み取りを付け直す
# (付け忘れると再起動後に MODULE_NOT_FOUND で落ちる)。
echo "==> 実行ユーザー向けの読み取り権限を再適用"
sudo chown -R "$(id -un)":secondbrain .
sudo chmod -R g+rX .

echo "==> DB マイグレーション"
pnpm db:migrate

echo "==> サービス再起動"
sudo systemctl restart secondbrain-api
sudo systemctl restart secondbrain-worker
sudo systemctl reload caddy

echo "==> 稼働確認"
sleep 3
sudo systemctl is-active secondbrain-api
sudo systemctl is-active secondbrain-worker
curl -fsS "https://${SB_PUBLIC_HOST}/api/health" && echo
echo "==> 完了。次は docs/deployment.md の「デプロイ後スモークテスト」を実施すること。"
