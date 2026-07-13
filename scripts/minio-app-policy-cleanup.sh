#!/bin/sh
# scripts/minio-app-policy.sh で作成したアプリ用 MinIO サービスアカウント・ポリシー・バケットの後始末。
# 自己完結スクリプトとする(呼び出し側〔統合テストの afterAll 等〕が別コンテナ/別プロセスであっても
# alias 状態を引き継ぐ必要が無いようにするため)。
#
# 使い方:
#   minio-app-policy-cleanup.sh <mc-endpoint> <alias> <app-access-key> <bucket-name> <policy-name>
#
# `<bucket-name>`・`<app-access-key>`・`<policy-name>` は全て `secondbrain-test-` で
# 始まる名前でなければならない(テスト専用の命名規則。詳細は下記 assert_test_only_name
# 参照)。以前は削除対象バケット名を引数で二重入力させる確認方式だったが、実際の呼び出し元
# (統合テストヘルパー)は常に同じ値を二回渡すため、環境変数の設定ミスで既存の別バケットを
# 指すという本当の事故を防げていなかった(Codex コードレビュー 2026-07-13 指摘 [E-1] の
# BLOCKER再発への対応)。本スクリプトはテスト用リソースの後始末専用であり、命名規則の
# 強制によって、誤って本番の「secondbrain」バケット・ユーザー・ポリシーを対象に実行される
# こと自体を構造的に防ぐ。
#
# 秘密値は環境変数から読む:
#   MC_ROOT_USER      - MinIO root アクセスキー
#   MC_ROOT_PASSWORD  - MinIO root シークレットキー
#
# 存在しないリソースへの削除操作はエラー扱いにしない(既に清掃済み・途中失敗からの再実行を許容する)。
# ただし各手順の終了コードは記録し、到達できた範囲までは必ず試みる。

MC_ENDPOINT="$1"
MC_ALIAS="$2"
APP_ACCESS_KEY="$3"
BUCKET_NAME="$4"
POLICY_NAME="$5"

if [ -z "$MC_ENDPOINT" ] || [ -z "$MC_ALIAS" ] || [ -z "$APP_ACCESS_KEY" ] || [ -z "$BUCKET_NAME" ] || [ -z "$POLICY_NAME" ]; then
  echo "usage: minio-app-policy-cleanup.sh <mc-endpoint> <alias> <app-access-key> <bucket-name> <policy-name>" >&2
  exit 1
fi

# 本番の "secondbrain" バケット・ユーザー・ポリシーはこの接頭辞を持たないため、
# 誤ってそれらを指定した場合はここで確実に拒否する(Codex コードレビュー 2026-07-13
# 指摘 [E-1] BLOCKER への対応)。
assert_test_only_name() {
  # $1: 値, $2: エラーメッセージ用ラベル
  case "$1" in
    secondbrain-test-*) ;;
    *)
      echo "ERROR: $2 '$1' must start with 'secondbrain-test-' (this script only cleans up test-only resources; refusing to risk destroying non-test resources)" >&2
      exit 1
      ;;
  esac
}
assert_test_only_name "$BUCKET_NAME" "bucket name"
assert_test_only_name "$APP_ACCESS_KEY" "app access key"
assert_test_only_name "$POLICY_NAME" "policy name"

if [ -z "$MC_ROOT_USER" ] || [ -z "$MC_ROOT_PASSWORD" ]; then
  echo "MC_ROOT_USER / MC_ROOT_PASSWORD must be set in the environment" >&2
  exit 1
fi

# `mc alias set` は秘密値をプロセス引数として渡す(実行中のみプロセス一覧等から一時的に
# 観測されうる。既知の残存リスクとして受容)ものの、URL エンコード無しで資格情報を扱える
# ため、有効な MinIO 資格情報(base64 系の `+`/`/`/`=` 等を含みうる)を安全に受け付けられる。
# `MC_HOST_<alias>` 環境変数方式は r6 で一度導入したが、URL エンコード関連の問題が
# r6([B-1]・[E-2]:未エンコードによる実害)・r7([B-2]:過剰な事前検証による有効な資格情報の
# 拒否)と2ラウンド連続で発生したため差し戻した(Codex コードレビュー r7 指摘 [B-2] への
# 対応。minio-app-policy.sh と同じ方針)。`~/.mc/config.json` への資格情報の永続化のみ、
# 専用の一時ディレクトリを使い終了時に削除することで防ぐ。
MC_CONFIG_DIR="$(mktemp -d)"
# このスクリプトは意図的に `set -e` を使わない(個々の削除コマンドの失敗を記録しつつ
# 後続手順を続行する設計のため)。そのため `mktemp -d` 自体の失敗も自動では検出されず、
# 空文字列や不正なパスのまま `MC_CONFIG_DIR` として使われてしまう
# (Codex コードレビュー r8 指摘 [E-3] への対応)。ここだけは明示的に検証して即座に停止する。
if [ -z "$MC_CONFIG_DIR" ] || [ ! -d "$MC_CONFIG_DIR" ]; then
  echo "ERROR: mktemp -d failed to create a usable MC_CONFIG_DIR" >&2
  exit 1
fi
export MC_CONFIG_DIR
trap 'rm -rf "$MC_CONFIG_DIR"' EXIT

if ! mc alias set "$MC_ALIAS" "$MC_ENDPOINT" "$MC_ROOT_USER" "$MC_ROOT_PASSWORD"; then
  # alias 設定の失敗を無視して続行すると、同名の alias が別環境を指したまま
  # ローカル設定に残っていた場合、意図しないエンドポイントに対して削除系コマンドが
  # 実行され得る(Codex コードレビュー r3 指摘 [E-1] への対応)。ここで確実に停止する。
  echo "ERROR: mc alias set failed for '$MC_ALIAS' -> '$MC_ENDPOINT'; aborting cleanup" >&2
  exit 1
fi

# 各手順は「対象が存在しない」場合(冪等な再実行・既に清掃済み)だけを成功相当として
# 許容し、それ以外の失敗(認証・接続障害等)は記録したうえで残りの手順を続行し、
# 最後に非ゼロ終了する(Codex コードレビュー r4 指摘 [E-2] への対応。以前は全失敗を
# `|| true` で無条件に無視し、常に「cleaned up」と成功表示していた)。
# 「存在しない」の判定は既知のエラーコード(XMinioAdminNoSuchUser)に加え、mc の
# バージョン差で将来出現しうる一般的な「not found」系の文言も広く許容する
# (Codex コードレビュー r5 指摘 [E-2] への対応。現行の mc バージョンでは
# `policy remove`/`rb` は対象不在でも exit 0 になることを実 MinIO で確認済みだが、
# 将来のバージョン変更に対しても冪等性を保証するため)。
CLEANUP_HAD_REAL_FAILURE=0

is_not_found_error() {
  # $1: コマンドの標準出力+標準エラー
  case "$1" in
    *XMinioAdminNoSuchUser*) return 0 ;;
    *"does not exist"*) return 0 ;;
    *"NoSuchBucket"*) return 0 ;;
    *) return 1 ;;
  esac
}

DETACH_OUTPUT="$(mc admin policy detach "$MC_ALIAS" "$POLICY_NAME" --user="$APP_ACCESS_KEY" --json 2>&1)"
if [ $? -ne 0 ] && ! is_not_found_error "$DETACH_OUTPUT"; then
  echo "WARNING: policy detach failed: $DETACH_OUTPUT" >&2
  CLEANUP_HAD_REAL_FAILURE=1
fi

REMOVE_POLICY_OUTPUT="$(mc admin policy remove "$MC_ALIAS" "$POLICY_NAME" --json 2>&1)"
if [ $? -ne 0 ] && ! is_not_found_error "$REMOVE_POLICY_OUTPUT"; then
  echo "WARNING: policy remove failed: $REMOVE_POLICY_OUTPUT" >&2
  CLEANUP_HAD_REAL_FAILURE=1
fi

REMOVE_USER_OUTPUT="$(mc admin user remove "$MC_ALIAS" "$APP_ACCESS_KEY" --json 2>&1)"
if [ $? -ne 0 ] && ! is_not_found_error "$REMOVE_USER_OUTPUT"; then
  echo "WARNING: user remove failed: $REMOVE_USER_OUTPUT" >&2
  CLEANUP_HAD_REAL_FAILURE=1
fi

RB_OUTPUT="$(mc rb --force "${MC_ALIAS}/${BUCKET_NAME}" --json 2>&1)"
if [ $? -ne 0 ] && ! is_not_found_error "$RB_OUTPUT"; then
  echo "WARNING: bucket removal failed: $RB_OUTPUT" >&2
  CLEANUP_HAD_REAL_FAILURE=1
fi

if [ "$CLEANUP_HAD_REAL_FAILURE" -eq 1 ]; then
  echo "minio-app-policy-cleanup.sh: cleanup finished WITH ERRORS for user '$APP_ACCESS_KEY', policy '$POLICY_NAME', bucket '$BUCKET_NAME' (see WARNING lines above)" >&2
  exit 1
fi

echo "minio-app-policy-cleanup.sh: cleaned up user '$APP_ACCESS_KEY', policy '$POLICY_NAME', bucket '$BUCKET_NAME'"
