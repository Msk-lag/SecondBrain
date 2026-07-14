#!/bin/sh
# アプリ用 MinIO サービスアカウント(バケット限定・最小権限)を宣言済み状態へ収束させる共有スクリプト。
# docker-compose.yml の minio-init サービスと、統合テストの integration-setup の両方から
# 同一内容で呼び出すことで「本番相当のポリシー」と「テストが検証するポリシー」を一致させる。
# (計画書 §アプリ用 MinIO アクセスキーの権限最小化 参照)
#
# 使い方:
#   minio-app-policy.sh <mc-endpoint> <alias> <app-access-key> <bucket-name> <policy-name>
#
# 位置引数はいずれも秘密値を含まない(プロセス一覧・docker inspect 等に平文で残り得るため)。
# 秘密値は環境変数から読む:
#   MC_ROOT_USER      - MinIO root アクセスキー(初期セットアップ専用)
#   MC_ROOT_PASSWORD  - MinIO root シークレットキー
#   MC_APP_SECRET_KEY - アプリ用サービスアカウントのシークレットキー
#
# 各手順の失敗はスクリプト全体を非ゼロ終了させる(set -e)。
# 既存リソースが無い場合の削除操作等、無視してよいものだけ個別に許容する。

set -e

MC_ENDPOINT="$1"
MC_ALIAS="$2"
APP_ACCESS_KEY="$3"
BUCKET_NAME="$4"
POLICY_NAME="$5"

if [ -z "$MC_ENDPOINT" ] || [ -z "$MC_ALIAS" ] || [ -z "$APP_ACCESS_KEY" ] || [ -z "$BUCKET_NAME" ] || [ -z "$POLICY_NAME" ]; then
  echo "usage: minio-app-policy.sh <mc-endpoint> <alias> <app-access-key> <bucket-name> <policy-name>" >&2
  exit 1
fi

if [ -z "$MC_ROOT_USER" ] || [ -z "$MC_ROOT_PASSWORD" ] || [ -z "$MC_APP_SECRET_KEY" ]; then
  echo "MC_ROOT_USER / MC_ROOT_PASSWORD / MC_APP_SECRET_KEY must be set in the environment" >&2
  exit 1
fi

# `MC_HOST_<alias>` 環境変数ベースの認証は、資格情報を URL の userinfo 部へ埋め込む必要が
# あるため、URL 予約文字を含む有効な MinIO 資格情報(base64 系の `+`/`/`/`=` 等を含みうる)を
# 安全に扱えない(Codex コードレビュー r6 指摘 [B-1]・[E-2]〔未エンコードによる実害〕、r7
# 指摘 [B-2]〔過剰な事前検証による有効な資格情報の拒否〕と2ラウンド連続で問題が発生した
# ため、`mc alias set` へ差し戻す。プロセス引数への秘密値の一時的な露出(実行中のみ・
# `docker inspect` 等からの観測可能性)は既知の残存リスクとして受容し、`~/.mc/config.json`
# への資格情報の永続化のみを `MC_CONFIG_DIR` のスコープ化で防ぐ)。
POLICY_FILE="$(mktemp)"
# `POLICY_FILE` 作成の直後、後始末用の完全な trap(下記)を登録する前に暫定の trap を
# 登録する。これが無いと、次の `mktemp -d`(MC_CONFIG_DIR)が失敗した場合に `set -e` で
# 即座に終了し、trap 未登録のまま `POLICY_FILE` が残り続ける(Codex コードレビュー
# 2026-07-13 r6 指摘 [E-2] への対応)。
trap 'rm -f "$POLICY_FILE"' EXIT
MC_CONFIG_DIR="$(mktemp -d)"
export MC_CONFIG_DIR
# mc put は成功したが mc cat/rm が途中で失敗した場合、検証用オブジェクトがバケットに
# 残り続ける(Codex コードレビュー r7 指摘 [E-2] への対応)。VERIFY_OBJECT_KEY/VERIFY_ALIAS を
# 空文字で初期化し、実際に mc put した後にのみ設定、mc rm が正常終了した後に再度空へ戻す
# ことで、EXIT trap 側は「まだ削除できていない検証用オブジェクトがあれば削除する」を
# 安全に判定できる。
VERIFY_OBJECT_KEY=""
VERIFY_ALIAS=""
# `VERIFY_OBJECT_FILE` は本来これより後(検証用オブジェクト作成時)に設定されるが、
# それより前に何らかの処理が失敗した場合、下記 trap 内の `rm -f "$POLICY_FILE"
# "$VERIFY_OBJECT_FILE"` が未初期化のまま参照されることになる。未初期化の変数は
# 空文字列に展開されるため実害は無い(実際の mc イメージで `rm -f x ""` が exit 0 に
# なることを確認済み)が、`rm` の空文字列引数に対する挙動は実装依存であり、将来の
# イメージ更新でも保証されない。ここで明示的に空文字列で初期化しておくことで、
# `rm` の実装に依存せず安全に振る舞うようにする(Codex コードレビュー 2026-07-13 r7
# 指摘 [E-1] への対応)。
VERIFY_OBJECT_FILE=""
# 検証用 alias(VERIFY_ALIAS)の認証情報は MC_CONFIG_DIR 内に保存されているため、
# `mc rm` によるリモートの後始末は MC_CONFIG_DIR を削除するより先に行う必要がある
# (Codex コードレビュー r8 指摘 [E-4] への対応。以前は MC_CONFIG_DIR を先に削除しており、
# 検証用 alias の設定が失われた状態で `mc rm` を試みるため、途中失敗時のリモートオブジェクト
# 後始末が常に失敗していた)。
# 後始末の `mc rm` には root 資格情報(MC_ALIAS)を使う。trap が実際に必要になる典型的な
# ケースはアプリ資格情報(VERIFY_ALIAS)の GetObject/DeleteObject 権限検証failureであり、
# その場合はアプリ資格情報自身での削除も同じ理由で失敗しうる(Codex コードレビュー
# 2026-07-13 r8 指摘 [E-2] への対応。以前は同じ VERIFY_ALIAS〔アプリ資格情報〕を後始末にも
# 使っていた)。root 資格情報の alias(MC_ALIAS)は本トラップ登録より後の `mc alias set` で
# 確立されるが、VERIFY_OBJECT_KEY が設定されるのはその成功後(検証用オブジェクト作成時)
# のみであるため、VERIFY_OBJECT_KEY が非空の時点では MC_ALIAS は必ず有効である。
trap 'if [ -n "$VERIFY_OBJECT_KEY" ]; then mc rm "${MC_ALIAS}/${BUCKET_NAME}/${VERIFY_OBJECT_KEY}" >/dev/null 2>&1 || true; fi; rm -f "$POLICY_FILE" "$VERIFY_OBJECT_FILE"; rm -rf "$MC_CONFIG_DIR"' EXIT

# `minio/mc` イメージには `sed`/`grep` 等の外部コマンドが含まれない(最小構成イメージのため)。
# `mc --json` の出力(コンパクトな1行 JSON。キーと値の間にスペースを含まない形式)から
# 文字列フィールドを取り出すのに、POSIX シェル標準のパラメータ展開のみを使う
# (`${var#pattern}`/`${var%%pattern}` は sh/dash/ash いずれでも組み込みで動作する)。
#
# 抽出結果を `echo` で返すと、値が `-n` 等のオプション文字列に解釈されうる、または
# バックスラッシュがエスケープシーケンスとして解釈されうる(挙動は `echo` の実装依存。
# 例えば既存グループ名/ポリシー名が `-n` だった場合、出力が抑制されて空文字列と誤認され、
# 呼び出し元がその名前の脱退・削除・検証を静かにスキップしてしまう。Codex コードレビュー
# 2026-07-13 r7 指摘 [E-2] への対応)。`printf '%s\n'` はオプション解釈もエスケープ解釈も
# 行わないため、抽出した値をそのまま安全に返せる。
extract_json_string_field() {
  # $1: JSON 文字列, $2: フィールド名
  json_value="$1"
  field_name="$2"
  after_key="${json_value#*\"${field_name}\":\"}"
  if [ "$after_key" = "$json_value" ]; then
    printf '%s\n' ""
    return
  fi
  printf '%s\n' "${after_key%%\"*}"
}

# 複数の直接ポリシーが付与されている場合、`mc admin user info` の policyName は
# カンマ区切りの1文字列("policy-a,policy-b")として返る。一方 `mc admin policy detach` は
# カンマ区切りではなく空白区切りの複数引数(POLICY [POLICY...])を受け付ける仕様のため、
# カンマ区切り文字列をそのまま渡すと「そのような名前のポリシーは存在しない」扱いで
# 静かに失敗し、目的のポリシー以外が残ってしまう(Codex コードレビュー r5 指摘 [E-3] への対応)。
# `set --` で関数のローカル位置パラメータへ分解することで、呼び出し元(トップレベル)の
# $1〜$5 を破壊せずに1件ずつ detach できる。
detach_all_policies_except() {
  # $1: カンマ区切りのポリシー名一覧(policyName の値), $2: 保持するポリシー名
  policy_list="$1"
  keep_policy="$2"
  old_ifs="$IFS"
  IFS=,
  set -- $policy_list
  IFS="$old_ifs"
  for existing_policy in "$@"; do
    if [ -n "$existing_policy" ] && [ "$existing_policy" != "$keep_policy" ]; then
      mc admin policy detach "$MC_ALIAS" "$existing_policy" --user="$APP_ACCESS_KEY" 2>/dev/null || true
    fi
  done
}

# `mc admin user info --json` の `memberOf` は `[{"name":"g1"},{"name":"g2"}]` 形式
# (文字列の配列ではなくオブジェクトの配列)なので、`extract_json_string_field` とは別に
# 複数件を順に取り出すループが必要。
list_member_of_groups() {
  # $1: `mc admin user info --json` の出力全体
  json_value="$1"
  remaining="${json_value#*\"memberOf\":[}"
  if [ "$remaining" = "$json_value" ]; then
    return
  fi
  remaining="${remaining%%]*}"
  while true; do
    after_key="${remaining#*\"name\":\"}"
    if [ "$after_key" = "$remaining" ]; then
      break
    fi
    # `echo` ではなく `printf '%s\n'` を使う理由は extract_json_string_field と同じ
    # (グループ名が `-n` 等の場合の echo 実装依存の誤動作を防ぐ。Codex コードレビュー
    # 2026-07-13 r7 指摘 [E-2] への対応)。
    printf '%s\n' "${after_key%%\"*}"
    remaining="${after_key#*\"}"
  done
}

# --- root 資格情報でエイリアスを設定する ---
mc alias set "$MC_ALIAS" "$MC_ENDPOINT" "$MC_ROOT_USER" "$MC_ROOT_PASSWORD"

# `BUCKET_NAME` を検証・エスケープせず下記の heredoc(IAM ポリシー JSON)の Resource へ
# 文字列連結でそのまま埋め込んでいたため、引用符等を含む値で別の Statement や広範な
# Action/Resource を注入できた(Codex コードレビュー r10 指摘 [E-2] への対応)。
# S3/MinIO のバケット命名規則(小文字英数字・ハイフン・ドットのみ、先頭末尾は英数字、
# 3〜63文字、連続ドット禁止、ドット区切り各ラベルも先頭末尾は英数字、IPv4形式禁止)に
# 沿って厳格に検証することで、JSON構造を壊しうる文字も併せて排除する
# (以前の検証は文字種・全体の先頭末尾・長さのみで、`a..b`・`a.-b`・`a-.b`・IPv4形式等の
# 不正な値を許可していた。Codex コードレビュー 2026-07-13 r2 指摘 [E-2] への対応)。
assert_valid_s3_bucket_name() {
  # $1: バケット名
  name="$1"
  case "$name" in
    '' | *[!a-z0-9.-]*)
      echo "internal error: bucket name '$name' must match [a-z0-9.-]+ (S3/MinIO naming rules; also prevents JSON policy injection)" >&2
      exit 1
      ;;
  esac
  name_length=${#name}
  if [ "$name_length" -lt 3 ] || [ "$name_length" -gt 63 ]; then
    echo "internal error: bucket name '$name' must be 3-63 characters long" >&2
    exit 1
  fi
  case "$name" in
    *..*)
      echo "internal error: bucket name '$name' must not contain two adjacent periods" >&2
      exit 1
      ;;
  esac
  # 末尾がドットの場合(例: `abc.`)、`IFS=.` による `set --` はシェルのフィールド分割の
  # 仕様上、末尾の空フィールドを保持しないため(`set -- $name` 後の `$#`/`$@` に空ラベルが
  # 現れない)、下記のラベルごとの先頭末尾検証だけでは末尾ドットを検出できない
  # (Codex コードレビュー 2026-07-13 r9 指摘 [E-2] への対応)。ラベル分割の前に、名前全体の
  # 先頭・末尾が英数字であることを直接検証することで、この抜けを塞ぐ。
  case "$name" in
    [!a-z0-9]* | *[!a-z0-9])
      echo "internal error: bucket name '$name' must start and end with a lowercase letter or digit" >&2
      exit 1
      ;;
  esac
  # ドット区切りの各ラベルの先頭末尾検証と、IPv4アドレス形式(ドット区切りちょうど4要素、
  # かつ各要素が数字のみ)の判定を同じ分割結果に対して行う。当初、IPv4判定を
  # `[0-9]*.[0-9]*.[0-9]*.[0-9]*` という文字種を問わない case パターンで行っていたが、
  # `*` がドット・非数字を含む任意の文字列にも一致するため、`1a.2b.3c.4d` のような
  # 正当なバケット名まで誤って拒否していた(Codex コードレビュー 2026-07-13 r4 指摘
  # [E-2] への対応。ラベルごとに分割し「ちょうど4要素かつ全要素が数字のみ」の場合に
  # 限定することで、数字を含むが英字も混じる正当な名前は拒否しないようにする)。
  # (`set --` は本関数のローカル位置パラメータのみを書き換える。detach_all_policies_except
  # と同じ安全なパターン)。
  old_ifs="$IFS"
  IFS=.
  set -- $name
  IFS="$old_ifs"
  label_count=$#
  all_labels_numeric=1
  for label in "$@"; do
    case "$label" in
      [a-z0-9] | [a-z0-9]*[a-z0-9]) ;;
      *)
        echo "internal error: bucket name '$name' has an invalid label '$label' (each dot-separated label must start and end with a lowercase letter or digit)" >&2
        exit 1
        ;;
    esac
    case "$label" in
      '' | *[!0-9]*) all_labels_numeric=0 ;;
    esac
  done
  if [ "$label_count" -eq 4 ] && [ "$all_labels_numeric" -eq 1 ]; then
    echo "internal error: bucket name '$name' must not be formatted as an IPv4 address" >&2
    exit 1
  fi
}
assert_valid_s3_bucket_name "$BUCKET_NAME"

# --- 対象バケットの作成(冪等) ---
# このスクリプトは「宣言済み状態への収束」を謳っており、cleanup 側もこのスクリプトが
# バケットを作成する前提で書かれている(Codex コードレビュー r6 指摘 [E-1] への対応)。
# IAM(ポリシー・ユーザー・シークレット)の変更より前にバケット作成を行うことで、
# 不正なバケット名や作成失敗によって IAM リソースだけが変更された部分状態が残ることを
# 防ぐ(Codex コードレビュー 2026-07-13 r2 指摘 [E-2] への対応。以前は IAM 変更が先で、
# バケット名検証をすり抜けた不正な名前や一時的な通信障害で `mc mb` が失敗すると、
# ポリシー・ユーザーのシークレットだけが更新済みの中途半端な状態が残り得た)。
mc mb --ignore-existing "${MC_ALIAS}/${BUCKET_NAME}"

# --- GetObject/PutObject/DeleteObject のみを許可するポリシーを生成する ---
# ListBucket は含めない(§バケット限定ポリシーの権限範囲 参照。既知のオブジェクトキーへの
# 操作のみが必要であり、バケット内のオブジェクト一覧を列挙する権限は不要かつ最小権限違反)。
cat > "$POLICY_FILE" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject"
      ],
      "Resource": [
        "arn:aws:s3:::${BUCKET_NAME}/*"
      ]
    }
  ]
}
EOF

# --- 宣言済み状態への収束(既存状態の「無視」ではない) ---
# `policy create` は既存ポリシーがあっても常に上書きする(内容の upsert)。
mc admin policy create "$MC_ALIAS" "$POLICY_NAME" "$POLICY_FILE"

# 既存ユーザーかどうかを先に判定する。既存ユーザーの場合、シークレットをアプリ側に
# 既知の値へ更新する前に、不要な直接ポリシー・グループ所属を先に収束させる。逆順(先に
# シークレットを更新してから権限を収束)だと、権限収束が失敗した場合に「アプリが知っている
# シークレットで過剰な権限が使える」窓が生じる(Codex コードレビュー r7 指摘 [E-1] への対応)。
# 新規ユーザーの場合はそもそも既存の権限が無いためこの窓自体が発生しない。
#
# `mc admin user info` は成功時・失敗時いずれも JSON を標準出力へ書く(エラー時も
# `{"status":"error",...}` が stdout に出る)ため、出力の非空判定では成功/失敗を区別
# できない(以前はこれにより、対象ユーザーが存在しない場合でも常に「既存ユーザー」の分岐に
# 入ってしまっていた)。`if VAR="$(cmd)"; then` の形で実際の終了コードを使って判定する。
if USER_INFO_OUTPUT="$(mc admin user info "$MC_ALIAS" "$APP_ACCESS_KEY" --json 2>&1)"; then
  CURRENT_POLICY="$(extract_json_string_field "$USER_INFO_OUTPUT" policyName)"
  if [ -n "$CURRENT_POLICY" ]; then
    detach_all_policies_except "$CURRENT_POLICY" "$POLICY_NAME"
  fi
  # 既存ユーザーがグループに所属していると、直接付与されたポリシーだけを見ても実効権限を
  # 完全には把握できない(グループ経由で別の強い権限が残りうる。Codex コードレビュー r4
  # 指摘 [E-1] への対応)。このアプリ用アカウントはグループに属さない前提のため、
  # 所属しているグループがあれば(ユーザーは削除せず)すべて脱退させる。
  list_member_of_groups "$USER_INFO_OUTPUT" | while IFS= read -r group_name; do
    [ -z "$group_name" ] && continue
    mc admin group remove "$MC_ALIAS" "$group_name" "$APP_ACCESS_KEY" 2>/dev/null || true
  done

  # 上記の detach/group-remove は個々に `|| true` で失敗を無視しているため、実際に権限が
  # 収束したかをここで確認してからシークレット更新へ進む(Codex コードレビュー r8 指摘
  # [E-1] への対応。以前は収束の成否を確認せず `mc admin user add` へ進んでおり、収束が
  # 実際には失敗していても既知のシークレットが過剰権限アカウントへ設定されうる窓があった。
  # 最終検証〔本ファイル後段〕はこの窓を検知はするが、その時点では既にシークレット更新後
  # であるため遅すぎる)。
  PRE_UPDATE_USER_INFO_JSON="$(mc admin user info "$MC_ALIAS" "$APP_ACCESS_KEY" --json)"
  PRE_UPDATE_POLICY="$(extract_json_string_field "$PRE_UPDATE_USER_INFO_JSON" policyName)"
  case ",$PRE_UPDATE_POLICY," in
    ",$POLICY_NAME," | ",,") ;; # 目的のポリシーのみ、またはこの後アタッチする(現状無付与)
    *)
      echo "verification failed: could not converge policies before secret rotation (current: '$PRE_UPDATE_POLICY')" >&2
      exit 1
      ;;
  esac
  PRE_UPDATE_REMAINING_GROUPS="$(list_member_of_groups "$PRE_UPDATE_USER_INFO_JSON")"
  if [ -n "$PRE_UPDATE_REMAINING_GROUPS" ]; then
    echo "verification failed: user still belongs to group(s) before secret rotation: $PRE_UPDATE_REMAINING_GROUPS" >&2
    exit 1
  fi
else
  CURRENT_POLICY=""
  # 失敗時、「対象ユーザーが存在しない」ことが確認できる場合のみ新規ユーザーとして続行する。
  # それ以外の失敗(認証・接続障害等)では、既存の過剰権限ユーザーに対する一時的な取得失敗を
  # 「新規ユーザー」と誤認して権限収束をスキップし、そのままシークレットを設定してしまう
  # 危険があるため、ここで確実に停止する(Codex コードレビュー r8 指摘 [E-2] への対応)。
  case "$USER_INFO_OUTPUT" in
    *XMinioAdminNoSuchUser*) ;;
    *)
      echo "ERROR: mc admin user info failed for a reason other than 'user does not exist'; aborting: $USER_INFO_OUTPUT" >&2
      exit 1
      ;;
  esac
fi

# 権限収束(既存ユーザーの場合)を終えた後にシークレットを確定させる(新規ユーザーなら
# 作成、既存ユーザーなら secret の upsert)。
mc admin user add "$MC_ALIAS" "$APP_ACCESS_KEY" "$MC_APP_SECRET_KEY"

# 目的のポリシーをアタッチする(同一ポリシーへの再アタッチが「既にアタッチ済み」エラーに
# なりうる mc バージョンがあるため、事前確認で不要な再アタッチ自体はスキップする)。
case ",$CURRENT_POLICY," in
  *",$POLICY_NAME,"*) ;; # 既に目的のポリシーが含まれている(単独付与済み)
  *) mc admin policy attach "$MC_ALIAS" "$POLICY_NAME" --user="$APP_ACCESS_KEY" ;;
esac

# --- 適用後の検証: アタッチされているポリシー名が一致し、グループ所属が無いこと ---
VERIFY_USER_INFO_JSON="$(mc admin user info "$MC_ALIAS" "$APP_ACCESS_KEY" --json)"
VERIFY_POLICY="$(extract_json_string_field "$VERIFY_USER_INFO_JSON" policyName)"
if [ "$VERIFY_POLICY" != "$POLICY_NAME" ]; then
  echo "verification failed: attached policy is '$VERIFY_POLICY', expected '$POLICY_NAME'" >&2
  exit 1
fi
VERIFY_REMAINING_GROUPS="$(list_member_of_groups "$VERIFY_USER_INFO_JSON")"
if [ -n "$VERIFY_REMAINING_GROUPS" ]; then
  echo "verification failed: user still belongs to group(s): $VERIFY_REMAINING_GROUPS" >&2
  exit 1
fi

# --- 適用後の検証: 実際の資格情報が有効であること(Put/Get/Remove が成功すること) ---
VERIFY_ALIAS="${MC_ALIAS}-app-verify"
mc alias set "$VERIFY_ALIAS" "$MC_ENDPOINT" "$APP_ACCESS_KEY" "$MC_APP_SECRET_KEY"

VERIFY_OBJECT_FILE="$(mktemp)"
echo "minio-app-policy verification $(date -u +%Y%m%dT%H%M%SZ)" > "$VERIFY_OBJECT_FILE"
# 秒単位の時刻だけだと同一秒内の並行実行(統合テスト等)でキーが衝突しうる
# (Codex コードレビュー r4 指摘 [E-3] への対応)。`mktemp` が既に生成したランダムな
# ファイル名部分を含めることで、並行実行ごとに一意なキーにする。
VERIFY_OBJECT_KEY="__minio-app-policy-verify__/$(basename "$VERIFY_OBJECT_FILE")-$(date -u +%s)"

mc put "$VERIFY_OBJECT_FILE" "${VERIFY_ALIAS}/${BUCKET_NAME}/${VERIFY_OBJECT_KEY}"
mc cat "${VERIFY_ALIAS}/${BUCKET_NAME}/${VERIFY_OBJECT_KEY}" > /dev/null
mc rm "${VERIFY_ALIAS}/${BUCKET_NAME}/${VERIFY_OBJECT_KEY}"
# 正常に削除できたので EXIT trap での再削除(後始末)は不要にする。
VERIFY_OBJECT_KEY=""

# --- バケット自体の匿名アクセスを明示的に無効化する ---
# IAM ポリシー(GetObject/PutObject/DeleteObject のみ許可)は「認証済みユーザーに何を許可するか」の
# 制御であり、バケット自体の匿名/公開アクセス設定とは独立している。既存バケットの再利用を想定し、
# 過去に匿名アクセスが設定されていた場合でも無条件に none へ収束させる(冪等な操作)。
mc anonymous set none "${MC_ALIAS}/${BUCKET_NAME}"

# --- 適用後の検証: 匿名アクセスが無効(非公開)になっていること ---
# `mc anonymous set none` は匿名ポリシーを除去する(=非公開に戻す)操作だが、
# `mc anonymous get` はその結果を "none" ではなく "private" として報告する
# (get が返す値は private/download/upload/public のいずれかで、"none" は
# set 側のみが受け付ける入力値であり get の出力には現れない)。
# 出力全体に対する部分一致(`*private*`)ではなく、末尾の状態値を正確に取り出して一致を
# 検証する(Codex コードレビュー r7 指摘 [E-3] への対応。バケット名等に偶然 "private" という
# 文字列が含まれる場合の偽陽性を避けるため)。
ANONYMOUS_STATUS="$(mc anonymous get "${MC_ALIAS}/${BUCKET_NAME}")"
# 出力形式は `` Access permission for `<bucket>` is `<status>` `` (末尾の単語がバッククォート
# で囲まれた状態値)。末尾の単語を取り出して正確に一致させる。
ANONYMOUS_STATUS_LAST_WORD="${ANONYMOUS_STATUS##* }"
if [ "$ANONYMOUS_STATUS_LAST_WORD" != '`private`' ]; then
  echo "verification failed: anonymous access is not 'private' (got: $ANONYMOUS_STATUS)" >&2
  exit 1
fi

echo "minio-app-policy.sh: applied policy '$POLICY_NAME' to user '$APP_ACCESS_KEY' on bucket '$BUCKET_NAME' (anonymous access: none)"
