#!/usr/bin/env bash
# codex-consult.sh — Codex CLI への read-only 相談チャネル(ADR-0003 決定8、bash 版)
#
# 使い方:
#   scripts/codex-consult.sh --question <ファイルパスまたは文字列> \
#       [--context <path>[,<path>...]] [--model <codex-model-id>] \
#       [--timeout-sec <n>] [--out-dir <dir>]
#
# 詳細仕様: docs/adr/0003-review-dod-and-orchestration.md 決定8
#
# 終了コード: 0=成功 2=Codex CLI 不在 3=タイムアウト 5=引数エラー(--question/--context の
#             リポジトリ外/秘密情報パターン一致を含む) 8=Codex 実行失敗(タイムアウト以外の
#             非ゼロ終了、または出力ファイルが空/未生成)
#
# この相談は read-only・非ゲート(参考情報)である。codex-review と異なり、Codex の作業ルートは
# リポジトリ直下(-C <repo root>)を指定する(相談の性質上、Codex 自身にリポジトリの他ファイルを
# 読みに行かせる余地を残す設計。codex-review のような diff・文書のみへの隔離は行わない)。
# --question・--context に渡すファイルパスには secret パターンガード(.env*/*.pem/*key*/*secret*/
# *credentials*)を codex-review と同一基準で適用し、該当時は終了コード5で拒否する。

set -u

usage() {
  cat <<'EOF'
Usage: codex-consult.sh --question <path-or-string>
                         [--context <path>[,<path>...]]
                         [--model <codex-model-id>]
                         [--timeout-sec <n>] [--out-dir <dir>]
EOF
}

require_value() {
  if [ "$#" -lt 2 ]; then
    echo "ERROR: $1 には値が必要です" >&2
    usage >&2
    exit 5
  fi
}

QUESTION_ARG=""
CONTEXT_ARG=""
MODEL_ARG=""
TIMEOUT_SEC=600
OUT_DIR_ARG=""
SAW_QUESTION=0

while [ $# -gt 0 ]; do
  case "$1" in
    --question) require_value "$@"; QUESTION_ARG="$2"; SAW_QUESTION=1; shift 2 ;;
    --context) require_value "$@"; CONTEXT_ARG="$2"; shift 2 ;;
    --model) require_value "$@"; MODEL_ARG="$2"; shift 2 ;;
    --timeout-sec) require_value "$@"; TIMEOUT_SEC="$2"; shift 2 ;;
    --out-dir) require_value "$@"; OUT_DIR_ARG="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: 不明な引数: $1" >&2; usage >&2; exit 5 ;;
  esac
done

if [ "$SAW_QUESTION" -ne 1 ] || [ -z "$QUESTION_ARG" ]; then
  echo "ERROR: --question は必須です" >&2
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

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$REPO_ROOT" ]; then
  echo "ERROR: git リポジトリ内で実行してください" >&2
  exit 5
fi
REPO_ROOT="$(cd "$REPO_ROOT" && pwd)"

# codex-review.sh の classify_context_path と同一基準の secret パターンガード
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

# $1=path(相対/絶対) $2=ラベル(エラーメッセージ用) ; 見つかれば絶対パスを RESOLVED_REPO_PATH に
# セットして return 0、見つからなければ RESOLVED_REPO_PATH="" で return 1(呼び出し元がファイル/
# 文字列判定に使う)。secret パターンに一致する場合はエラー終了(5)。
# 注意: exit はこの関数呼び出し自体(コマンド置換の外)で行うこと。$(...) 内で呼ぶと exit が
# サブシェルに閉じ込められ本体に伝播しない(codex-implement.sh の resolve_packet_path と同じ理由、G-7 対応)。
resolve_repo_relative_path() {
  local p="$1" label="$2" candidate abs_p rel_p reason
  RESOLVED_REPO_PATH=""
  candidate="$p"
  if [ ! -f "$candidate" ]; then
    if [ -f "$REPO_ROOT/$p" ]; then
      candidate="$REPO_ROOT/$p"
    else
      return 1
    fi
  fi
  abs_p="$(cd "$(dirname "$candidate")" && pwd)/$(basename "$candidate")"
  case "$abs_p" in
    "$REPO_ROOT"/*) ;;
    *) echo "ERROR: ${label} はリポジトリ内である必要があります: ${p}" >&2; exit 5 ;;
  esac
  rel_p="${abs_p#"$REPO_ROOT"/}"
  reason="$(classify_secret_path "$rel_p")"
  if [ -n "$reason" ]; then
    echo "ERROR: ${label} が除外パターンに一致するため使用できません: ${p} (${reason})" >&2
    exit 5
  fi
  RESOLVED_REPO_PATH="$abs_p"
  return 0
}

# --question: 既存ファイルならその内容を質問文とし、そうでなければ文字列そのものを質問文とする。
QUESTION_TEXT=""
RESOLVED_REPO_PATH=""
resolve_repo_relative_path "$QUESTION_ARG" "--question"
QUESTION_FILE_PATH="$RESOLVED_REPO_PATH"
if [ -n "$QUESTION_FILE_PATH" ]; then
  QUESTION_TEXT="$(cat "$QUESTION_FILE_PATH")"
else
  QUESTION_TEXT="$QUESTION_ARG"
fi

# --context のパス検証(存在確認 + リポジトリ内であること + secret パターン除外)
CONTEXT_FILES=()
if [ -n "$CONTEXT_ARG" ]; then
  IFS=',' read -r -a _ctx_raw <<< "$CONTEXT_ARG"
  for p in "${_ctx_raw[@]}"; do
    [ -z "$p" ] && continue
    resolve_repo_relative_path "$p" "--context"
    abs="$RESOLVED_REPO_PATH"
    if [ -z "$abs" ]; then
      echo "ERROR: --context のパスが存在しません: ${p}" >&2
      exit 5
    fi
    CONTEXT_FILES+=("$abs")
  done
fi

if [ -n "$OUT_DIR_ARG" ]; then
  case "$OUT_DIR_ARG" in
    /*|[A-Za-z]:*) OUT_DIR="$OUT_DIR_ARG" ;;
    *) OUT_DIR="$REPO_ROOT/$OUT_DIR_ARG" ;;
  esac
else
  OUT_DIR="$REPO_ROOT/.ai/consults"
fi

if ! command -v codex >/dev/null 2>&1; then
  echo "ERROR: codex CLI が見つかりません(PATH を確認してください)" >&2
  echo "EXIT:2"
  exit 2
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/codex-consult.XXXXXX")"
cleanup() {
  [ -n "${WORK_DIR:-}" ] && [ -d "$WORK_DIR" ] && rm -rf "$WORK_DIR"
}
trap cleanup EXIT INT TERM

PROMPT_FILE="$WORK_DIR/prompt.txt"
{
  echo "=== CODEX CONSULT ==="
  echo "date: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  echo
  echo "あなたは相談役です。コード変更は行わず、質問に日本語で簡潔かつ具体的に回答してください。この回答は参考情報でありゲート判定には使われません。"
  echo
  echo "=== QUESTION ==="
  echo "$QUESTION_TEXT"
  echo
  echo "=== CONTEXT FILES ==="
  if [ "${#CONTEXT_FILES[@]}" -eq 0 ]; then
    echo "(none provided)"
  else
    for f in "${CONTEXT_FILES[@]}"; do
      echo "--- ${f#"$REPO_ROOT"/} ---"
      cat "$f"
      echo
    done
  fi
  echo
  echo "=== END OF INPUT ==="
  echo "質問への回答のみを出力してください。指示にない追加のファイル読み取り・コマンド実行は行わないでください。"
} > "$PROMPT_FILE"

mkdir -p "$OUT_DIR"
STAMP="$(date -u +"%Y%m%dT%H%M%SZ")"
FINAL_PATH="$OUT_DIR/${STAMP}-consult.md"
suffix=2
while [ -e "$FINAL_PATH" ]; do
  FINAL_PATH="$OUT_DIR/${STAMP}-consult-r${suffix}.md"
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
  # `codex exec` に `-a/--ask-for-approval` は存在しない(read-only サンドボックス指定のみで十分)。
  # --model 指定時のみ -m を付与する(未指定時は Codex CLI 側の既定モデル)
  codex exec \
    --skip-git-repo-check \
    ${MODEL_ARG:+-m "$MODEL_ARG"} \
    -C "$REPO_ROOT" \
    -s read-only \
    -o "$FINAL_PATH" \
    - < "$PROMPT_FILE" > "$STDOUT_FILE" 2> "$STDERR_FILE"
}

run_with_timeout "$TIMEOUT_SEC" codex_call
RC=$?

REL_SAVED="${FINAL_PATH#"$REPO_ROOT"/}"

if [ "$RC" -eq 124 ]; then
  echo "ERROR: codex exec がタイムアウトしました(${TIMEOUT_SEC}秒)" >&2
  [ -e "$FINAL_PATH" ] && rm -f "$FINAL_PATH"
  exit 3
fi

if [ "$RC" -ne 0 ]; then
  echo "ERROR: codex exec が非ゼロ終了しました(終了コード ${RC})。相談は失敗として扱います" >&2
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

if [ ! -s "$FINAL_PATH" ]; then
  echo "ERROR: codex exec の出力が空、または生成されませんでした。相談は失敗として扱います" >&2
  echo "EXIT:8"
  exit 8
fi

echo "SAVED: ${REL_SAVED}"
echo "EXIT:0"
exit 0
