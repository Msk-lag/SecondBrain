#!/usr/bin/env bash
# check-diff-coverage.sh — diff カバレッジ検査の単一実装(CI とローカル共用、規則 CI-1/ADR-0003 決定8)
#
# 使い方:
#   scripts/check-diff-coverage.sh [--compare <ref>] [--require] [--fail-under <n>]
#
# オプション:
#   --compare <ref>     比較先 ref(既定: origin/main)
#   --require           diff-cover / python3 が無い場合を失敗扱いにする(CI 用)。
#                        未指定時(ローカル既定)は無い場合 SKIPPED として exit 0。
#   --fail-under <n>     diff-cover の --fail-under に渡す閾値(既定: 100)
#
# 前提: 事前に `pnpm test:coverage` 等で各パッケージの coverage/lcov.info が生成済みであること。
#
# 本スクリプトは Git Bash(Windows では git 同梱)を前提とする。CI は ubuntu で実行。
#
# 終了コード: 0=合格(または非 --require 時のスキップ) 1=失敗

set -u

COMPARE_REF="origin/main"
REQUIRE=0
FAIL_UNDER=100

while [ $# -gt 0 ]; do
  case "$1" in
    --compare)
      COMPARE_REF="$2"
      shift 2
      ;;
    --require)
      REQUIRE=1
      shift
      ;;
    --fail-under)
      FAIL_UNDER="$2"
      shift 2
      ;;
    *)
      echo "ERROR: 不明な引数: $1" >&2
      exit 1
      ;;
  esac
done

# リポジトリルートへ移動する(このスクリプトが scripts/ 直下にある前提)。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || exit 1

MERGED_LCOV="coverage/merged-lcov.info"

echo "check-diff-coverage: lcov をマージしています ($MERGED_LCOV)..." >&2
node scripts/merge-lcov.mjs "$MERGED_LCOV" >&2
MERGE_RC=$?
if [ "$MERGE_RC" -ne 0 ]; then
  echo "ERROR: lcov のマージに失敗しました(終了コード ${MERGE_RC})。" >&2
  exit 1
fi

# python3(無ければ python)を探す。
PYTHON_BIN=""
if command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="python3"
elif command -v python >/dev/null 2>&1; then
  PYTHON_BIN="python"
fi

if [ -z "$PYTHON_BIN" ]; then
  if [ "$REQUIRE" -eq 1 ]; then
    echo "ERROR: python3/python が見つかりません(--require 指定時は diff カバレッジ検査必須)。" >&2
    exit 1
  fi
  echo "SKIPPED: diff coverage は CI で必須検査(ローカルは Python 環境がある場合のみ)" >&2
  exit 0
fi

DIFF_COVER_BIN=""
if command -v diff-cover >/dev/null 2>&1; then
  DIFF_COVER_BIN="diff-cover"
elif "$PYTHON_BIN" -m diff_cover.diff_cover_tool --help >/dev/null 2>&1; then
  DIFF_COVER_BIN="$PYTHON_BIN -m diff_cover.diff_cover_tool"
fi

if [ -z "$DIFF_COVER_BIN" ]; then
  if [ "$REQUIRE" -eq 1 ]; then
    echo "ERROR: diff-cover が見つかりません(--require 指定時は diff カバレッジ検査必須)。'pip install diff-cover' を実行してください。" >&2
    exit 1
  fi
  echo "SKIPPED: diff coverage は CI で必須検査(ローカルは Python 環境がある場合のみ)" >&2
  exit 0
fi

mkdir -p coverage

# diff-cover の --exclude と ADDED_LINES 集計の除外規則を一箇所に集約する(両者が必ず同じ
# パターン集合を参照することで、G-5 のような不一致 — 除外対象だけの差分が fail-closed 判定で
# 不当に失敗する — を構造的に防ぐ)。
DIFF_COVER_EXCLUDE_GLOBS=(
  '**/*.spec.ts'
  '**/*.spec.tsx'
  '**/*.d.ts'
  '**/setupTests.ts'
  '**/main.ts'
  '**/main.tsx'
)

path_is_diff_cover_excluded() {
  local path="$1" pat
  for pat in "${DIFF_COVER_EXCLUDE_GLOBS[@]}"; do
    # shellcheck disable=SC2053
    if [[ "$path" == $pat ]]; then
      return 0
    fi
  done
  return 1
}

echo "check-diff-coverage: diff-cover を実行しています(compare=${COMPARE_REF}, fail-under=${FAIL_UNDER})..." >&2
# shellcheck disable=SC2086
$DIFF_COVER_BIN "$MERGED_LCOV" \
  --compare-branch "$COMPARE_REF" \
  --fail-under "$FAIL_UNDER" \
  --json-report coverage/diff-cover.json \
  --exclude "${DIFF_COVER_EXCLUDE_GLOBS[@]}"
DIFF_COVER_RC=$?

# fail-closed 検査: 追加行があるのに diff-cover の計測対象が空(total_num_lines=0)なら
# パス不一致等で診断がすり抜けている疑いがあるため、diff-cover の終了コードに関わらず失敗させる。
ADDED_LINES=0
NUMSTAT_OUTPUT="$(git diff --numstat "${COMPARE_REF}...HEAD" -- 'apps/*/src/**/*.ts' 'apps/*/src/**/*.tsx' 'packages/*/src/**/*.ts' 2>/dev/null || true)"
if [ -n "$NUMSTAT_OUTPUT" ]; then
  while IFS=$'\t' read -r added _deleted path; do
    [ -z "$path" ] && continue
    if path_is_diff_cover_excluded "$path"; then
      continue
    fi
    if [ "$added" = "-" ]; then
      continue
    fi
    ADDED_LINES=$((ADDED_LINES + added))
  done <<< "$NUMSTAT_OUTPUT"
fi

if [ "$ADDED_LINES" -gt 0 ]; then
  TOTAL_NUM_LINES=0
  if [ -f coverage/diff-cover.json ]; then
    TOTAL_NUM_LINES="$("$PYTHON_BIN" -c "
import json, sys
try:
    with open('coverage/diff-cover.json', encoding='utf-8') as f:
        data = json.load(f)
    print(int(data.get('total_num_lines', 0) or 0))
except Exception:
    print(0)
" 2>/dev/null || echo 0)"
  fi

  if [ "$TOTAL_NUM_LINES" -eq 0 ]; then
    echo "ERROR: 差分で ${ADDED_LINES} 行が追加されていますが、diff-cover の計測対象(total_num_lines)が0でした。" >&2
    echo "       lcov の SF: パスと git diff のパスが一致していない疑いがあります(fail-closed)。" >&2
    exit 1
  fi
fi

exit "$DIFF_COVER_RC"
