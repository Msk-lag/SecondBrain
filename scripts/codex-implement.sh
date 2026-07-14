#!/usr/bin/env bash
# codex-implement.sh — Codex CLI による実装実行ラッパー(規則 ROUTE-1、bash 版)
#
# 使い方:
#   scripts/codex-implement.sh --packet <実装パケット md のパス> \
#       --allowed-paths <glob>[,<glob>...] \
#       [--model <codex-model-id>] [--timeout-sec <n>]
#
# 詳細仕様: docs/adr/0003-review-dod-and-orchestration.md 決定7(規則 ROUTE-1)、
#           docs/templates/implementation-packet.md
#
# 終了コード: 0=成功(範囲内変更のみ) 2=Codex CLI 不在 3=タイムアウト
#             5=事前検証・引数エラー(--packet のリポジトリ外/秘密情報パターン一致・
#             realpath 不在環境でのシンボリックリンク packet 拒否を含む)
#             6=事後検証違反(範囲外変更・HEAD 変化・ブランチ変化・staged 非空・
#             ignored ファイル新規出現・任意 ref の作成/削除/移動)
#             8=Codex 実行失敗(タイムアウト以外の非ゼロ終了)
#
# 設計メモ:
#   - workspace-write サンドボックスで実行するため、実装対象は必ず feature/* ブランチ・
#     クリーンな作業ツリーに限定する(事前検証)。
#   - Codex は git 操作(add/commit/push/branch)禁止という指示をプロンプトに含めるが、
#     指示のみでは強制力が無いため、事後に HEAD・ブランチ名・staged・ignored ファイル一覧・
#     全 ref(for-each-ref)の不変性を機械検証する(git 操作自体を隔離実行環境で禁止するわけ
#     ではないため、範囲外変更が成功裏に行われる可能性をこの事後検証で検出する設計)。
#   - --allowed-paths の glob は "*" が単一パス階層内の任意文字列(パス区切り "/" を含まない)に、
#     "**" が階層をまたぐ任意文字列に一致する(一般的な glob 方言と同じ区別)。
#   - realpath が利用できない環境では --packet がシンボリックリンクの場合を拒否する
#     (シンボリックリンクの解決先がリポジトリ境界チェックをすり抜けるのを防ぐため)。
#
# 残余リスク(検出できない範囲):
#   - 既存の ignored ファイルの「内容」変更(node_modules 等、全内容のハッシュ比較は検査コスト
#     過大なため対象外)。

set -u

usage() {
  cat <<'EOF'
Usage: codex-implement.sh --packet <path-to-implementation-packet.md>
                           --allowed-paths <glob>[,<glob>...]
                           [--model <codex-model-id>]
                           [--timeout-sec <n>]
EOF
}

require_value() {
  if [ "$#" -lt 2 ]; then
    echo "ERROR: $1 には値が必要です" >&2
    usage >&2
    exit 5
  fi
}

PACKET_ARG=""
ALLOWED_PATHS_ARG=""
MODEL_ARG=""
TIMEOUT_SEC=1800
SAW_PACKET=0
SAW_ALLOWED=0

while [ $# -gt 0 ]; do
  case "$1" in
    --packet) require_value "$@"; PACKET_ARG="$2"; SAW_PACKET=1; shift 2 ;;
    --allowed-paths) require_value "$@"; ALLOWED_PATHS_ARG="$2"; SAW_ALLOWED=1; shift 2 ;;
    --model) require_value "$@"; MODEL_ARG="$2"; shift 2 ;;
    --timeout-sec) require_value "$@"; TIMEOUT_SEC="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: 不明な引数: $1" >&2; usage >&2; exit 5 ;;
  esac
done

if [ "$SAW_PACKET" -ne 1 ] || [ -z "$PACKET_ARG" ]; then
  echo "ERROR: --packet は必須です" >&2
  usage >&2
  exit 5
fi
if [ "$SAW_ALLOWED" -ne 1 ] || [ -z "$ALLOWED_PATHS_ARG" ]; then
  echo "ERROR: --allowed-paths は必須です" >&2
  usage >&2
  exit 5
fi

case "$TIMEOUT_SEC" in
  ''|*[!0-9]*)
    echo "ERROR: --timeout-sec は正の整数で指定してください(指定値: '${TIMEOUT_SEC}')" >&2
    exit 5 ;;
esac
if [ "$TIMEOUT_SEC" -le 0 ]; then
  echo "ERROR: --timeout-sec は正の整数で指定してください" >&2
  exit 5
fi

IFS=',' read -r -a ALLOWED_PATTERNS <<< "$ALLOWED_PATHS_ARG"
_tmp_patterns=()
for p in "${ALLOWED_PATTERNS[@]}"; do
  p="$(printf '%s' "$p" | sed -E 's/^ +| +$//g')"
  [ -n "$p" ] && _tmp_patterns+=("$p")
done
ALLOWED_PATTERNS=("${_tmp_patterns[@]}")
if [ "${#ALLOWED_PATTERNS[@]}" -eq 0 ]; then
  echo "ERROR: --allowed-paths に有効なパターンがありません" >&2
  exit 5
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$REPO_ROOT" ]; then
  echo "ERROR: git リポジトリ内で実行してください" >&2
  exit 5
fi
REPO_ROOT="$(cd "$REPO_ROOT" && pwd)"

# codex-consult.sh の classify_secret_path と同一基準の secret パターンガード
classify_secret_path() {
  local p="$1" base
  base="$(basename "$p")"
  case "$base" in .env*) echo "secret-pattern(.env*)"; return ;; esac
  case "$p" in *.pem) echo "secret-pattern(*.pem)"; return ;; esac
  case "$p" in *key*) echo "secret-pattern(*key*)"; return ;; esac
  case "$p" in *secret*) echo "secret-pattern(*secret*)"; return ;; esac
  case "$p" in *credentials*) echo "secret-pattern(*credentials*)"; return ;; esac
  echo ""
}

# --- packet ファイルの実体解決(シンボリックリンク解決込み)+ リポジトリ配下限定 + secret ガード ---
# 注意: exit はこの関数呼び出し自体(コマンド置換の外)で行うため、subshell 内で exit しても
# 呼び出し元プロセスへ伝播しない、という既知の落とし穴(G-7 相当)を避けている。
resolve_packet_path() {
  local raw="$1" candidate abs_p rel_p reason
  candidate="$raw"
  if [ ! -f "$candidate" ]; then
    candidate="$REPO_ROOT/$raw"
  fi
  if [ ! -f "$candidate" ]; then
    echo "ERROR: --packet のファイルが存在しません: ${raw}" >&2
    exit 5
  fi
  if command -v realpath >/dev/null 2>&1; then
    abs_p="$(realpath "$candidate" 2>/dev/null)"
  else
    # realpath 不在環境ではシンボリックリンクの解決先を安全に検証できないため、
    # --packet がシンボリックリンクの場合は fail-closed で拒否する。
    if [ -L "$candidate" ]; then
      echo "ERROR: --packet がシンボリックリンクです。realpath が利用できない環境ではシンボリックリンクの packet を受け付けません: ${raw}" >&2
      exit 5
    fi
    abs_p="$(cd "$(dirname "$candidate")" && pwd)/$(basename "$candidate")"
  fi
  if [ -z "$abs_p" ] || [ ! -f "$abs_p" ]; then
    echo "ERROR: --packet の実体パスを解決できませんでした: ${raw}" >&2
    exit 5
  fi
  case "$abs_p" in
    "$REPO_ROOT"/*) ;;
    *) echo "ERROR: --packet はリポジトリ配下である必要があります(シンボリックリンクの解決先を含む): ${raw} -> ${abs_p}" >&2; exit 5 ;;
  esac
  rel_p="${abs_p#"$REPO_ROOT"/}"
  reason="$(classify_secret_path "$rel_p")"
  if [ -n "$reason" ]; then
    echo "ERROR: --packet が除外パターンに一致するため使用できません: ${raw} (${reason})" >&2
    exit 5
  fi
  RESOLVED_PACKET_PATH="$abs_p"
}

RESOLVED_PACKET_PATH=""
resolve_packet_path "$PACKET_ARG"
PACKET_PATH="$RESOLVED_PACKET_PATH"

# --- 事前検証: ブランチ ---
CURRENT_BRANCH="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null)"
case "$CURRENT_BRANCH" in
  feature/*) ;;
  *)
    echo "ERROR: 現在のブランチが feature/* ではありません(現在: '${CURRENT_BRANCH}')。codex-implement は feature ブランチでのみ実行できます" >&2
    exit 5 ;;
esac

# --- 事前検証: 作業ツリーがクリーンであること ---
STATUS_OUT="$(git -C "$REPO_ROOT" status --porcelain)"
if [ -n "$STATUS_OUT" ]; then
  echo "ERROR: 作業ツリーがクリーンではありません(git status --porcelain が空ではありません)。事前にコミット/退避してください" >&2
  exit 5
fi

# --- 事前検証: staged (index) が空であること(クリーン要件に含まれるはずだが明示検査する) ---
STAGED_PRE="$(git -C "$REPO_ROOT" diff --cached --name-only)"
if [ -n "$STAGED_PRE" ]; then
  echo "ERROR: index に staged な変更があります(codex-implement は staged が空の状態でのみ実行できます)" >&2
  exit 5
fi

# --- 開始時 HEAD・ブランチ・ignored ファイル一覧の記録(事後検証で不変性を確認するため) ---
START_HEAD="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null)"
if [ -z "$START_HEAD" ]; then
  echo "ERROR: 開始時の HEAD を取得できませんでした" >&2
  exit 5
fi
START_BRANCH="$CURRENT_BRANCH"
PRE_IGNORED="$(git -C "$REPO_ROOT" status --porcelain --ignored=matching | grep '^!! ' || true)"
PRE_REFS="$(git -C "$REPO_ROOT" for-each-ref --format='%(refname) %(objectname)')"

if ! command -v codex >/dev/null 2>&1; then
  echo "ERROR: codex CLI が見つかりません(PATH を確認してください)" >&2
  echo "EXIT:2"
  exit 2
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/codex-implement.XXXXXX")"
cleanup() {
  [ -n "${WORK_DIR:-}" ] && [ -d "$WORK_DIR" ] && rm -rf "$WORK_DIR"
}
trap cleanup EXIT INT TERM

# glob -> ERE 変換(ps1 版 Convert-GlobToRegex と同一仕様)。
# "*" は単一パス階層内の任意文字列(パス区切り "/" を含まない)、"**" は階層をまたぐ任意文字列。
convert_glob_to_regex() {
  local g="$1"
  g="${g#./}"
  g="$(printf '%s' "$g" | sed \
    -e 's/\\/\\\\/g' \
    -e 's/\./\\./g' \
    -e 's/\^/\\^/g' \
    -e 's/\$/\\$/g' \
    -e 's/+/\\+/g' \
    -e 's/(/\\(/g' \
    -e 's/)/\\)/g' \
    -e 's/\[/\\[/g' \
    -e 's/\]/\\]/g' \
    -e 's/{/\\{/g' \
    -e 's/}/\\}/g' \
    -e 's/|/\\|/g')"
  g="$(printf '%s' "$g" | sed -e 's/\*\*/@@DOUBLESTAR@@/g')"
  g="$(printf '%s' "$g" | sed -e 's/\*/[^\/]*/g')"
  g="$(printf '%s' "$g" | sed -e 's/@@DOUBLESTAR@@/.*/g')"
  g="$(printf '%s' "$g" | sed -e 's/?/[^\/]/g')"
  printf '^%s$' "$g"
}

path_matches_any_glob() {
  local path="$1" pat rx
  path="${path//\\//}"
  for pat in "${ALLOWED_PATTERNS[@]}"; do
    rx="$(convert_glob_to_regex "$pat")"
    if [[ "$path" =~ $rx ]]; then
      return 0
    fi
  done
  return 1
}

PROMPT_FILE="$WORK_DIR/prompt.txt"
{
  echo "=== CODEX IMPLEMENTATION TASK ==="
  echo "date: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  echo "branch: $CURRENT_BRANCH"
  echo "start-head: $START_HEAD"
  echo
  echo "あなたは実装担当です。以下の実装パケットに厳密に従ってください。変更可能パス以外に触れた場合は失敗扱いになります。git 操作(add/commit/push/branch)は一切禁止です。停止条件に該当したら作業を止めて理由を報告してください。"
  echo
  echo "=== IMPLEMENTATION PACKET ==="
  cat "$PACKET_PATH"
  echo
  echo "=== END OF INPUT ==="
} > "$PROMPT_FILE"

OUT_DIR="$REPO_ROOT/.ai/implement-runs"
mkdir -p "$OUT_DIR"
STAMP="$(date -u +"%Y%m%dT%H%M%SZ")"
FINAL_PATH="$OUT_DIR/${STAMP}-implement.md"
suffix=2
while [ -e "$FINAL_PATH" ]; do
  FINAL_PATH="$OUT_DIR/${STAMP}-implement-r${suffix}.md"
  suffix=$((suffix + 1))
done

STDOUT_FILE="$WORK_DIR/codex.stdout.log"
STDERR_FILE="$WORK_DIR/codex.stderr.log"

run_with_timeout() {
  local t="$1"; shift
  "$@" &
  local pid=$! elapsed=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$elapsed" -ge "$t" ]; then
      kill "$pid" 2>/dev/null
      sleep 1
      kill -9 "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      return 124
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  wait "$pid"
}

codex_call() {
  # `codex exec` に `-a/--ask-for-approval` は存在しない。workspace-write サンドボックスの
  # 指定だけで非対話実行される。--model 指定時のみ -m を付与する。
  codex exec \
    --skip-git-repo-check \
    ${MODEL_ARG:+-m "$MODEL_ARG"} \
    -C "$REPO_ROOT" \
    -s workspace-write \
    -o "$FINAL_PATH" \
    - < "$PROMPT_FILE" > "$STDOUT_FILE" 2> "$STDERR_FILE"
}

run_with_timeout "$TIMEOUT_SEC" codex_call
RC=$?

REL_SAVED="${FINAL_PATH#"$REPO_ROOT"/}"

if [ "$RC" -eq 124 ]; then
  echo "ERROR: codex exec がタイムアウトしました(${TIMEOUT_SEC}秒)。作業ツリーの状態を確認し、必要なら手動で後始末してください(revert はこのラッパーの責務外)" >&2
  exit 3
fi

if [ "$RC" -ne 0 ]; then
  echo "ERROR: codex exec が非ゼロ終了しました(終了コード ${RC})。実装は失敗として扱います" >&2
  if [ -s "$FINAL_PATH" ]; then
    echo "ERROR: 部分出力ファイル(失敗時成果物): ${REL_SAVED}" >&2
  fi
  if [ -s "$STDERR_FILE" ]; then
    echo "ERROR: codex stderr の末尾:" >&2
    tail -n 5 "$STDERR_FILE" >&2 || true
  fi
  echo "EXIT:8"
  exit 8
fi

# --- 事後検証 1: HEAD が開始時と同一(commit されていないこと) ---
END_HEAD="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null)"
if [ "$END_HEAD" != "$START_HEAD" ]; then
  echo "ERROR: 事後検証違反: HEAD が開始時( ${START_HEAD} )から変化しています(現在: ${END_HEAD})。Codex が git commit 等の操作を行った可能性があります。revert はせず報告のみ行います" >&2
  echo "SAVED: ${REL_SAVED}"
  echo "EXIT:6"
  exit 6
fi

# --- 事後検証 1b: ブランチ名が開始時と同一であること(checkout/branch 操作の検出) ---
END_BRANCH="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null)"
if [ "$END_BRANCH" != "$START_BRANCH" ]; then
  echo "ERROR: 事後検証違反: ブランチが開始時( ${START_BRANCH} )から変化しています(現在: ${END_BRANCH})。revert はせず報告のみ行います" >&2
  echo "SAVED: ${REL_SAVED}"
  echo "EXIT:6"
  exit 6
fi

# --- 事後検証 1c: staged (index) が空のままであること(git add 操作の検出) ---
STAGED_POST="$(git -C "$REPO_ROOT" diff --cached --name-only)"
if [ -n "$STAGED_POST" ]; then
  echo "ERROR: 事後検証違反: index に staged な変更が検出されました(Codex が git add を実行した可能性)。revert はせず報告のみ行います" >&2
  echo "  - staged files:" >&2
  printf '%s\n' "$STAGED_POST" | sed 's/^/    - /' >&2
  echo "SAVED: ${REL_SAVED}"
  echo "EXIT:6"
  exit 6
fi

# --- 事後検証 1d: ignored ファイルの新規出現がないこと(--ignored=matching の事前/事後比較) ---
POST_IGNORED="$(git -C "$REPO_ROOT" status --porcelain --ignored=matching | grep '^!! ' || true)"
declare -A _PRE_IGNORED_SET=()
if [ -n "$PRE_IGNORED" ]; then
  while IFS= read -r _line; do
    [ -z "$_line" ] && continue
    _PRE_IGNORED_SET["$_line"]=1
  done <<< "$PRE_IGNORED"
fi
NEW_IGNORED=()
if [ -n "$POST_IGNORED" ]; then
  while IFS= read -r _line; do
    [ -z "$_line" ] && continue
    if [ -z "${_PRE_IGNORED_SET[$_line]:-}" ]; then
      NEW_IGNORED+=("$_line")
    fi
  done <<< "$POST_IGNORED"
fi
if [ "${#NEW_IGNORED[@]}" -gt 0 ]; then
  echo "ERROR: 事後検証違反: 新規に出現した ignored ファイルが検出されました(既存 ignored ファイルの内容変更は検出対象外)。revert はせず報告のみ行います" >&2
  for f in "${NEW_IGNORED[@]}"; do
    echo "  - ${f}" >&2
  done
  echo "SAVED: ${REL_SAVED}"
  echo "EXIT:6"
  echo "NEW_IGNORED:"
  for f in "${NEW_IGNORED[@]}"; do
    echo "  - ${f}"
  done
  exit 6
fi

# --- 事後検証 1e: 任意の ref(ブランチ・タグ等)の作成・削除・移動がないこと(for-each-ref の事前/事後比較) ---
POST_REFS="$(git -C "$REPO_ROOT" for-each-ref --format='%(refname) %(objectname)')"
if [ "$POST_REFS" != "$PRE_REFS" ]; then
  echo "ERROR: 事後検証違反: git ref(ブランチ・タグ等)の作成・削除・移動が検出されました。revert はせず報告のみ行います" >&2
  echo "SAVED: ${REL_SAVED}"
  echo "EXIT:6"
  exit 6
fi

# --- 事後検証 2: 変更ファイルが --allowed-paths の範囲内であること ---
FINAL_STATUS_OUT="$(git -C "$REPO_ROOT" status --porcelain)"

CHANGED_STATUS=()
CHANGED_PATH=()
CHANGED_OLDPATH=()

if [ -n "$FINAL_STATUS_OUT" ]; then
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    status="${line:0:2}"
    rest="${line:3}"
    case "$rest" in
      *" -> "*)
        old_path="${rest%% -> *}"
        new_path="${rest#* -> }"
        ;;
      *)
        old_path=""
        new_path="$rest"
        ;;
    esac
    # git がクォートした特殊パス(非 ASCII・空白等)の簡易アンクォート(先頭・末尾の " のみ除去。残余リスク)。
    new_path="${new_path%\"}"; new_path="${new_path#\"}"
    if [ -n "$old_path" ]; then
      old_path="${old_path%\"}"; old_path="${old_path#\"}"
    fi
    CHANGED_STATUS+=("$status")
    CHANGED_PATH+=("$new_path")
    CHANGED_OLDPATH+=("$old_path")
  done <<< "$FINAL_STATUS_OUT"
fi

if [ "${#CHANGED_PATH[@]}" -eq 0 ]; then
  echo "ERROR: 事後検証: Codex 実行後に変更ファイルがありません(何も実装されなかった可能性があります)" >&2
  echo "SAVED: ${REL_SAVED}"
  echo "EXIT:0"
  echo "CHANGED_FILES: (none)"
  exit 0
fi

OUT_OF_SCOPE=()
for idx in "${!CHANGED_PATH[@]}"; do
  p="${CHANGED_PATH[$idx]}"
  op="${CHANGED_OLDPATH[$idx]}"
  if ! path_matches_any_glob "$p"; then
    OUT_OF_SCOPE+=("$p")
  fi
  if [ -n "$op" ] && ! path_matches_any_glob "$op"; then
    OUT_OF_SCOPE+=("${op} (rename-source)")
  fi
done

if [ "${#OUT_OF_SCOPE[@]}" -gt 0 ]; then
  echo "ERROR: 事後検証違反: --allowed-paths の範囲外の変更が検出されました。revert はせず報告のみ行います" >&2
  for f in "${OUT_OF_SCOPE[@]}"; do
    echo "  - ${f}" >&2
  done
  echo "SAVED: ${REL_SAVED}"
  echo "EXIT:6"
  echo "OUT_OF_SCOPE:"
  for f in "${OUT_OF_SCOPE[@]}"; do
    echo "  - ${f}"
  done
  exit 6
fi

# --- 合格: 変更ファイル一覧 + diff stat + 出力ファイルパスを要約 ---
echo "SAVED: ${REL_SAVED}"
echo "CHANGED_FILES:"
for idx in "${!CHANGED_PATH[@]}"; do
  if [ -n "${CHANGED_OLDPATH[$idx]}" ]; then
    echo "  - [${CHANGED_STATUS[$idx]}] ${CHANGED_OLDPATH[$idx]} -> ${CHANGED_PATH[$idx]}"
  else
    echo "  - [${CHANGED_STATUS[$idx]}] ${CHANGED_PATH[$idx]}"
  fi
done
echo "DIFF_STAT:"
git -C "$REPO_ROOT" diff --stat
echo "EXIT:0"
exit 0
