import { OpenAiEmbeddingError } from "./openai-embedding.client";

/**
 * note-enrichment キュー(producer・processor 双方)向けの例外サニタイズ
 * (Codex 再レビュー HIGH 指摘対応)。
 *
 * `apps/worker/src/queues/screenshot-analysis/sanitize-error.ts`・
 * `apps/worker/src/common/classify-maintenance-error.ts` と同じ設計思想を踏襲する:
 * 例外を `instanceof` チェックのみで固定分類(category)へ変換し、ログには固定メッセージ +
 * category のみを出力する。`err.message`・`err.stack`・`String(err)` 等、外部ライブラリ
 * (ioredis/BullMQ の Redis 接続エラー・mysql2 ドライバのエラー)が保持しうる文字列内容は
 * 一切読み取らない・ログへ出力しない(接続情報・認証情報がログへ残ることを防ぐ)。
 *
 * screenshot-analysis 側の `sanitizeError` をそのまま流用しない理由: あちらは Anthropic SDK
 * (Claude Vision)固有の例外型(`Anthropic.APIError`・`ClaudeRefusalError` 等)を分類するための
 * 実装であり、note-enrichment の例外(BullMQ の enqueue タイムアウト・OpenAI embeddings
 * クライアントのエラー・DB 操作タイムアウト)とは分類対象が異なる。同じ「instanceof のみで
 * 固定分類へ変換する」方式に倣った、note-enrichment 専用の最小実装として本ファイルを設ける。
 */
export type NoteEnrichmentErrorCategory =
  "enqueue_timeout" | "db_timeout" | "openai_error" | "invalid_payload" | "unknown_error";

/**
 * `enqueueNoteEnrichment`(note-enrichment.producer.ts)の `Promise.race` によるタイムアウトが
 * `queue.add()` 自体の完了を待たずに reject する際に投げるマーカーエラー。message は固定文言
 * のみで構成されており、それ自体はログに出しても安全だが、分類は instanceof のみで行う
 * (メッセージの内容には依存しない)。
 */
export class NoteEnrichmentEnqueueTimeoutError extends Error {
  constructor() {
    super("note-enrichment job enqueue timed out");
    this.name = "NoteEnrichmentEnqueueTimeoutError";
    Object.setPrototypeOf(this, NoteEnrichmentEnqueueTimeoutError.prototype);
  }
}

/**
 * note-enrichment.processor.ts の `withDbTimeout` がタイムアウト時に投げるマーカーエラー。
 * 上記と同じ理由でメッセージ内容には依存せず、instanceof のみで分類する。
 */
export class NoteEnrichmentDbTimeoutError extends Error {
  constructor() {
    super("note enrichment db operation timed out");
    this.name = "NoteEnrichmentDbTimeoutError";
    Object.setPrototypeOf(this, NoteEnrichmentDbTimeoutError.prototype);
  }
}

/**
 * `NoteEnrichmentProcessor.process()` が job.data(BullMQ 経由の信頼できない外部入力)を
 * `noteEnrichmentJobPayloadSchema` で検証した結果、構造が不正(noteId 欠落・型不一致等)、または
 * noteId が UUID 形式でない場合に投げるマーカーエラー(Codex 最終セキュリティ監査 LOW 指摘対応)。
 * message は固定文言のみで構成し、Zod の検証エラー(issue.message)や payload の値そのものは
 * 一切含めない(instanceof のみで分類する他のマーカーエラーと同じ方針)。
 */
export class NoteEnrichmentInvalidPayloadError extends Error {
  constructor() {
    super("note enrichment job payload is invalid");
    this.name = "NoteEnrichmentInvalidPayloadError";
    Object.setPrototypeOf(this, NoteEnrichmentInvalidPayloadError.prototype);
  }
}

/**
 * 例外を固定分類(NoteEnrichmentErrorCategory)へ変換する。`instanceof` チェックのみで判定し、
 * `err.message`・`err.cause`・`err.stack` 等の文字列内容は一切読み取らない。
 */
export function classifyEnrichmentError(err: unknown): NoteEnrichmentErrorCategory {
  if (err instanceof NoteEnrichmentEnqueueTimeoutError) {
    return "enqueue_timeout";
  }
  if (err instanceof NoteEnrichmentDbTimeoutError) {
    return "db_timeout";
  }
  if (err instanceof NoteEnrichmentInvalidPayloadError) {
    return "invalid_payload";
  }
  if (err instanceof OpenAiEmbeddingError) {
    return "openai_error";
  }
  return "unknown_error";
}

/**
 * category ごとの固定メッセージ(利用者向け文言ではなく、BullMQ の failedReason/stacktrace として
 * Redis に永続化されても安全な、内容を持たない定型文)。
 * `apps/worker/src/queues/screenshot-analysis/sanitize-error.ts` の `USER_MESSAGES` と同じ発想だが、
 * こちらは利用者表示用ではなく BullMQ 永続化専用のため、日本語の丁寧文ではなく処理名を含む短い
 * 固定文とする。
 */
const SANITIZED_MESSAGES: Record<NoteEnrichmentErrorCategory, string> = {
  enqueue_timeout: "note enrichment job enqueue timed out",
  db_timeout: "note enrichment db operation timed out",
  openai_error: "note enrichment openai embeddings call failed",
  invalid_payload: "note enrichment job payload is invalid",
  unknown_error: "note enrichment operation failed",
};

/**
 * BullMQ へ伝播させる、サニタイズ済みの例外(Codex レビュー HIGH 指摘対応)。
 *
 * BullMQ は失敗理由(`failedReason`)とスタックトレースをジョブデータとして Redis に永続化する
 * ため、ログ出力だけをサニタイズしても、`process()` から re-throw する生の例外(OpenAI クライアント・
 * mysql2 ドライバ由来。接続情報・認証情報を含みうる)がそのまま Redis に残ってしまう。この型は
 * `message` を固定文言のみで構成し(`category` から一意に決まる)、`cause` に原例外を保持しない
 * (`cause` を保持すると、BullMQ 経由でシリアライズされる際に間接的に漏洩しうるため —
 * `apps/worker/src/queues/screenshot-analysis/sanitize-error.ts` の `SanitizedException` と同じ方針)。
 * `stack` も `new Error()` 呼び出し時点で新規生成されるため、原例外のスタック(接続文字列等を含みうる
 * 内部フレーム情報)を引き継がない。
 */
export class SanitizedNoteEnrichmentError extends Error {
  readonly category: NoteEnrichmentErrorCategory;

  constructor(category: NoteEnrichmentErrorCategory) {
    super(SANITIZED_MESSAGES[category]);
    this.name = "SanitizedNoteEnrichmentError";
    this.category = category;
    Object.setPrototypeOf(this, SanitizedNoteEnrichmentError.prototype);
  }
}

/**
 * 任意の例外(原例外)を分類したうえで `SanitizedNoteEnrichmentError` へ変換する。
 * `process()` の全失敗経路は、BullMQ へ例外を伝播させる直前に必ずこの関数を通す
 * (原例外そのものを re-throw しない)。
 */
export function toSanitizedEnrichmentError(err: unknown): SanitizedNoteEnrichmentError {
  return new SanitizedNoteEnrichmentError(classifyEnrichmentError(err));
}
