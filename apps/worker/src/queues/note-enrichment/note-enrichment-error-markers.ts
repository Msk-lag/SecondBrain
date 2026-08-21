/**
 * note-enrichment キュー向けマーカー例外のうち、`sanitize-enrichment-error.ts` へ直接置くと
 * 循環 import になるものだけを切り出した小さなモジュール(Issue #70 / A-1 対応)。
 *
 * `sanitize-enrichment-error.ts` は既に `openai-embedding.client.ts` から
 * `OpenAiEmbeddingError` を import している(instanceof 分類のため)。一方
 * `NoteEnrichmentMissingApiKeyError` は `openai-embedding.client.ts`(`OPENAI_API_KEY`)・
 * `relation-judge.client.ts`(`ANTHROPIC_API_KEY`)の双方の `*FromEnv` ファクトリが
 * 「投げる側」として import する必要がある。もしこのマーカー型を `sanitize-enrichment-error.ts`
 * にそのまま追加すると、`openai-embedding.client.ts` → `sanitize-enrichment-error.ts` →
 * `openai-embedding.client.ts` という循環 import になる(実行時には解決される可能性が高いが、
 * 脆く lint で検知されうる)。そのためこのマーカー型だけを独立したこのモジュールへ切り出し、
 * `sanitize-enrichment-error.ts`(分類する側)と各クライアント(投げる側)の双方がここから
 * import する形にする。
 *
 * 既存の enqueue タイムアウト・db タイムアウト・invalid payload の3マーカーは循環を起こさない
 * ため、影響範囲を最小にするためこのファイルへは移動していない(`sanitize-enrichment-error.ts`
 * に残置したまま)。
 */

/**
 * `openai-embedding.client.ts` の `createOpenAiEmbeddingClientFromEnv()`(`OPENAI_API_KEY`)・
 * `relation-judge.client.ts` の `createRelationJudgeClientFromEnv()`(`ANTHROPIC_API_KEY`)が
 * 必須の API キー環境変数が未設定(未設定・空文字・空白のみ)の場合に投げるマーカーエラー。
 * message は固定文言のみで構成されており、それ自体はログに出しても安全だが、分類は
 * instanceof のみで行う(メッセージの内容には依存しない。他のマーカーエラーと同じ方針)。
 *
 * どちらのキーが欠けているかはこの型では区別しない(category は1つで十分。呼び出し元は
 * どちらの `*FromEnv` を呼んだかを既に知っているため、区別が必要ならその呼び出し元の
 * 責務とする)。
 */
export class NoteEnrichmentMissingApiKeyError extends Error {
  constructor() {
    super("note enrichment required api key environment variable is not set");
    this.name = "NoteEnrichmentMissingApiKeyError";
    Object.setPrototypeOf(this, NoteEnrichmentMissingApiKeyError.prototype);
  }
}
