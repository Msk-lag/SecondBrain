import { createHash } from "node:crypto";

/**
 * embedding 入力・fingerprint 計算の元になるノート内容のスナップショット(M1-4a 計画
 * §設計決定2・§設計決定4 参照)。`tagsRaw` は customType の `fromDriver`(JSON.parse)を
 * 経由しない生の JSON 文字列(raw SQL 経由で取得したもの)を渡すこと(呼び出し元の
 * NoteEnrichmentProcessor.loadSnapshot 参照)。
 */
export interface EmbeddingInputSnapshot {
  title: string | null;
  summary: string | null;
  body: string | null;
  extractedText: string | null;
  tagsRaw: string;
}

/**
 * tags 列の生の JSON 文字列を配列へ変換する。不正な JSON・非配列・非文字列要素は
 * 空配列/除外として扱う(fingerprint 計算がこの入力で例外を投げて enrichment ジョブ全体が
 * 失敗することを避けるための防御的な実装)。
 */
function parseTagsArray(tagsRaw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(tagsRaw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((tag): tag is string => typeof tag === "string");
}

interface EmbeddingInputSegments {
  title: string;
  summary: string;
  bodyOrExtractedText: string;
  sortedTags: string[];
}

/**
 * title / summary / body(無ければ extractedText) / tags(安定ソート済み配列)の4セグメントに
 * 正規化する(M1-4a 計画 §設計決定2 参照)。前後の空白のみの入力は空文字列として扱う。
 */
/**
 * UTF-16 コードユニット順の比較。fingerprint の再現性を環境非依存に保つため、
 * ロケール依存の String.localeCompare は使わない(実行環境で順序が変わりうるため)。
 */
function compareByCodeUnit(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

function deriveSegments(snapshot: EmbeddingInputSnapshot): EmbeddingInputSegments {
  return {
    title: (snapshot.title ?? "").trim(),
    summary: (snapshot.summary ?? "").trim(),
    bodyOrExtractedText: (snapshot.body ?? snapshot.extractedText ?? "").trim(),
    // UTF-16 コードユニット順による安定ソート(§設計決定2「tags は JSON 配列を安定ソート」)。
    // tags 自体の中身の順序を変えるだけで集合としての内容が変わらなければ同じ fingerprint になる。
    sortedTags: [...parseTagsArray(snapshot.tagsRaw)].sort(compareByCodeUnit),
  };
}

/**
 * embedding 生成 API へ渡す入力テキスト(区切り `\n` で4セグメントを連結)。fingerprint の
 * 計算にもこの同じ文字列を使う(入力が変われば fingerprint も必ず変わることを保証するため)。
 */
export function buildEmbeddingInputText(snapshot: EmbeddingInputSnapshot): string {
  const segments = deriveSegments(snapshot);
  return [
    segments.title,
    segments.summary,
    segments.bodyOrExtractedText,
    segments.sortedTags.join(","),
  ].join("\n");
}

/** 4セグメントすべてが空(全フィールド空)かどうか(M1-4a 計画 §設計決定4 手順4 参照)。 */
export function isEmbeddingInputEmpty(snapshot: EmbeddingInputSnapshot): boolean {
  const segments = deriveSegments(snapshot);
  return (
    segments.title === "" &&
    segments.summary === "" &&
    segments.bodyOrExtractedText === "" &&
    segments.sortedTags.length === 0
  );
}

/** 埋め込み入力テキストの UTF-8 SHA-256 hex(M1-4a 計画 §設計決定2 参照)。 */
export function computeEmbeddingFingerprint(snapshot: EmbeddingInputSnapshot): string {
  const input = buildEmbeddingInputText(snapshot);
  return createHash("sha256").update(input, "utf8").digest("hex");
}
