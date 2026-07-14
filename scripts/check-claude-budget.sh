#!/usr/bin/env bash
# check-claude-budget.sh — Claude 側トークン使用状況の推計(規則 ROUTE-1、bash 版)
#
# 使い方:
#   scripts/check-claude-budget.sh
#
# 出力(stdout、1行 JSON):
#   {"state":"green|yellow|red|unknown","blockUsedPct":<num|null>,"reason":"<簡潔な根拠>","fetchedAt":"<ISO8601>"}
#
# 環境変数(既定値を上書き可):
#   CLAUDE_BUDGET_GREEN_MAX  (既定 50)  … アクティブブロック使用率がこの値未満なら green
#   CLAUDE_BUDGET_YELLOW_MAX (既定 70)  … green 超過〜この値以下なら yellow、それ超過なら red
#
# 詳細仕様: docs/adr/0003-review-dod-and-orchestration.md 決定7(規則 ROUTE-1)
#
# 終了コード: 0=判定出力成功(unknown 含む) 5=引数エラー
#
# 設計メモ:
#   - ccusage(https://github.com/ryoppippi/ccusage)は Claude Code のローカル transcript から使用量を
#     推計するサードパーティ CLI であり、契約上の正確な残量とは限らない(ADR-0003 残余リスク)。
#   - @latest は使わずバージョンを固定する(挙動の予期しない変更を避けるため)。本スクリプト作成時点では
#     `npm view ccusage version` を実行できる環境が無かったため、既知の妥当なバージョンを暫定指定して
#     いる。導入時・定期見直し時に実際の最新バージョンを確認し、下記定数を更新すること。
#   - ccusage の出力構造(projected/tokenLimit 系フィールドの有無)はバージョンに依存するため、
#     判定ロジックは Node.js(本リポジトリ前提の Node 24)を子プロセスとして呼び出し、フィールドが
#     見つからない場合は必ず unknown へフォールバックする(fail-safe)。

set -u

# バージョン更新時は `npm view ccusage version` で確認して書き換える(@latest は使わない)。
CCUSAGE_VERSION="20.0.17"
TIMEOUT_SEC=30

usage() {
  cat <<'EOF'
Usage: check-claude-budget.sh
  出力(stdout, 1行 JSON): {"state":"green|yellow|red|unknown","blockUsedPct":<num|null>,"reason":"...","fetchedAt":"..."}
  環境変数: CLAUDE_BUDGET_GREEN_MAX(既定50) / CLAUDE_BUDGET_YELLOW_MAX(既定70)
EOF
}

for a in "$@"; do
  case "$a" in
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: 不明な引数: $a" >&2; usage >&2; exit 5 ;;
  esac
done

now_iso() {
  date -u +"%Y-%m-%dT%H:%M:%S.000Z"
}

emit_unknown() {
  # $1 = reason (JSON 文字列として埋め込むため二重引用符・バックスラッシュを最低限エスケープする)
  local reason_escaped
  reason_escaped="$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  printf '{"state":"unknown","blockUsedPct":null,"reason":"%s","fetchedAt":"%s"}\n' "$reason_escaped" "$(now_iso)"
}

if ! command -v node >/dev/null 2>&1; then
  emit_unknown "node CLI が見つかりません(判定ロジックを実行できないため unknown)"
  exit 0
fi

if ! command -v npx >/dev/null 2>&1; then
  emit_unknown "npx CLI が見つかりません(ccusage を実行できないため unknown)"
  exit 0
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/check-claude-budget.XXXXXX")"
cleanup() {
  [ -n "${WORK_DIR:-}" ] && [ -d "$WORK_DIR" ] && rm -rf "$WORK_DIR"
}
trap cleanup EXIT INT TERM

# decide.js — ccusage の JSON 出力から state/blockUsedPct を判定する共通ロジック(ps1 版と同一内容)。
# 引数: <primaryJsonFile> [<secondaryJsonFile>]
#   primaryJsonFile   : `ccusage blocks --json --active` の生出力
#   secondaryJsonFile : `ccusage blocks --json`(履歴含む全ブロック)の生出力。任意。
# 標準出力: 確定できた場合は最終 JSON(1行)を出力し終了コード0。
# 終了コード: 0=確定出力済み 42=limit フィールドが無く履歴フォールバックが必要(呼び出し元が2回目を実行)
DECIDE_JS="$WORK_DIR/decide.js"
cat > "$DECIDE_JS" <<'NODE_EOF'
"use strict";
const fs = require("fs");

function nowIso() { return new Date().toISOString(); }

function emit(state, pct, reason) {
  const obj = {
    state,
    blockUsedPct: (pct === null || pct === undefined) ? null : Math.round(pct * 10) / 10,
    reason,
    fetchedAt: nowIso(),
  };
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function readJsonFile(p) {
  const text = fs.readFileSync(p, "utf8");
  if (!text || !text.trim()) return null;
  return JSON.parse(text);
}

function extractBlocks(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.blocks)) return parsed.blocks;
  if (parsed && typeof parsed === "object") return [parsed];
  return [];
}

function findNumber(obj, paths) {
  for (const p of paths) {
    const parts = p.split(".");
    let cur = obj;
    let ok = true;
    for (const part of parts) {
      if (cur && typeof cur === "object" && part in cur) {
        cur = cur[part];
      } else {
        ok = false;
        break;
      }
    }
    if (ok && typeof cur === "number" && isFinite(cur)) return { value: cur, path: p };
  }
  return null;
}

const primaryFile = process.argv[2];
const secondaryFile = process.argv[3];

let primary;
try {
  primary = readJsonFile(primaryFile);
} catch (e) {
  emit("unknown", null, "ccusage 出力の JSON 解析に失敗しました: " + e.message);
  process.exit(0);
}

if (!primary) {
  emit("unknown", null, "ccusage の出力が空でした");
  process.exit(0);
}

const blocks = extractBlocks(primary);
let active = blocks.find((b) => b && b.isActive === true);
if (!active && blocks.length === 1) active = blocks[0];

if (!active) {
  emit("unknown", null, "アクティブなブロックが見つかりませんでした");
  process.exit(0);
}

const usedCandidate = findNumber(active, [
  "projection.totalTokens",
  "projectedUsage",
  "tokenLimitStatus.projectedUsage",
  "totalTokens",
  "tokenCounts.totalTokens",
]);

if (!usedCandidate) {
  emit("unknown", null, "ccusage の出力からトークン使用量フィールドを特定できませんでした");
  process.exit(0);
}

let limitCandidate = findNumber(active, ["tokenLimitStatus.limit", "tokenLimit", "limit"]);
if (!limitCandidate) limitCandidate = findNumber(primary, ["tokenLimit", "limit"]);

let limitValue = null;
let limitSource = null;

if (limitCandidate && limitCandidate.value > 0) {
  limitValue = limitCandidate.value;
  limitSource = "active." + limitCandidate.path;
} else if (secondaryFile) {
  let secondary;
  try {
    secondary = readJsonFile(secondaryFile);
  } catch (e) {
    emit("unknown", null, "過去ブロック取得の JSON 解析に失敗しました: " + e.message);
    process.exit(0);
  }
  const histBlocks = extractBlocks(secondary).filter((b) => b && b.isActive !== true);
  let max = 0;
  for (const b of histBlocks) {
    const t = findNumber(b, ["totalTokens", "tokenCounts.totalTokens"]);
    if (t && t.value > max) max = t.value;
  }
  if (max > 0) {
    limitValue = max;
    limitSource = "historical-max-total-tokens";
  } else {
    emit("unknown", null, "limit フィールドが無く、過去ブロックからも上限を推計できませんでした");
    process.exit(0);
  }
} else {
  process.exit(42);
}

const pct = (usedCandidate.value / limitValue) * 100;

const envGreen = Number(process.env.CLAUDE_BUDGET_GREEN_MAX || "50");
const envYellow = Number(process.env.CLAUDE_BUDGET_YELLOW_MAX || "70");
const gm = isFinite(envGreen) ? envGreen : 50;
const ym = isFinite(envYellow) ? envYellow : 70;

let state;
if (pct < gm) state = "green";
else if (pct <= ym) state = "yellow";
else state = "red";

const reason = "blockUsedPct=" + (Math.round(pct * 10) / 10) + "% (used=" + usedCandidate.value +
  "[" + usedCandidate.path + "] / limit=" + limitValue + "[" + limitSource + "])";
emit(state, pct, reason);
process.exit(0);
NODE_EOF

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

PRIMARY_JSON="$WORK_DIR/primary.json"
PRIMARY_STDERR="$WORK_DIR/primary.stderr.log"
run_with_timeout "$TIMEOUT_SEC" npx --yes "ccusage@${CCUSAGE_VERSION}" blocks --json --active \
  > "$PRIMARY_JSON" 2> "$PRIMARY_STDERR"
PRIMARY_RC=$?

if [ "$PRIMARY_RC" -eq 124 ]; then
  emit_unknown "ccusage の実行がタイムアウトしました(${TIMEOUT_SEC}秒)"
  exit 0
fi
if [ "$PRIMARY_RC" -ne 0 ]; then
  ERR_TAIL="$(tail -n 1 "$PRIMARY_STDERR" 2>/dev/null)"
  emit_unknown "ccusage が終了コード ${PRIMARY_RC} で失敗しました(${ERR_TAIL})"
  exit 0
fi
if [ ! -s "$PRIMARY_JSON" ]; then
  emit_unknown "ccusage の出力が空でした"
  exit 0
fi

DECIDE_OUT1="$WORK_DIR/decide1.stdout.log"
run_with_timeout 15 node "$DECIDE_JS" "$PRIMARY_JSON" > "$DECIDE_OUT1"
DECIDE_RC1=$?

if [ "$DECIDE_RC1" -eq 42 ]; then
  SECONDARY_JSON="$WORK_DIR/secondary.json"
  SECONDARY_STDERR="$WORK_DIR/secondary.stderr.log"
  run_with_timeout "$TIMEOUT_SEC" npx --yes "ccusage@${CCUSAGE_VERSION}" blocks --json \
    > "$SECONDARY_JSON" 2> "$SECONDARY_STDERR"
  SECONDARY_RC=$?

  if [ "$SECONDARY_RC" -eq 124 ]; then
    emit_unknown "過去ブロック取得(ccusage)がタイムアウトしました(${TIMEOUT_SEC}秒)"
    exit 0
  fi
  if [ "$SECONDARY_RC" -ne 0 ] || [ ! -s "$SECONDARY_JSON" ]; then
    emit_unknown "limit フィールドが無く、過去ブロックの取得にも失敗しました"
    exit 0
  fi

  DECIDE_OUT2="$WORK_DIR/decide2.stdout.log"
  run_with_timeout 15 node "$DECIDE_JS" "$PRIMARY_JSON" "$SECONDARY_JSON" > "$DECIDE_OUT2"
  DECIDE_RC2=$?
  if [ "$DECIDE_RC2" -ne 0 ] || [ ! -s "$DECIDE_OUT2" ]; then
    emit_unknown "判定ロジック(node)の実行に失敗しました"
    exit 0
  fi
  cat "$DECIDE_OUT2"
  exit 0
fi

if [ "$DECIDE_RC1" -ne 0 ] || [ ! -s "$DECIDE_OUT1" ]; then
  emit_unknown "判定ロジック(node)の実行に失敗しました"
  exit 0
fi
cat "$DECIDE_OUT1"
exit 0
