import Anthropic from "@anthropic-ai/sdk";
import { ZodError } from "zod";
import { StorageTimeoutError } from "@secondbrain/storage";

/**
 * failureReason のサニタイズ方針(計画書 §failureReason のサニタイズ方針・Codex レビュー指摘 [5]
 * への対応)。
 *
 * サーバーログも生の `Error.message` を使わず、固定分類のみで構成する(Codex レビュー r3 指摘 [5]・
 * r4 指摘 [2] への対応)。JSON パーサーや将来の SDK 変更がモデル出力(=画像内容の書き起こし等、
 * 非公開データ由来の文字列)を `message` に含めるケースを防げないため、`err.message`・`err.request`・
 * `err.response`・`err.cause`・`err.headers` 等、文字列内容やリクエスト/レスポンス本体を保持しうる
 * フィールドは一切読み取らない(SDK の将来変更に対しても安全側に倒す)。分類は `instanceof` チェック
 * のみで行う。
 */
export type ErrorCategory =
  | "image_fetch_failed"
  | "image_processing_timeout"
  | "image_processing_crashed"
  | "claude_api_error"
  | "claude_refusal"
  | "output_validation_failed"
  | "unknown_error";

export interface SanitizedError {
  /** failureReason に保存する文言(§ 上記マッピングのいずれか。category から一意に決まる) */
  userMessage: string;
  logDetail: {
    category: ErrorCategory;
    /** Anthropic SDK の型付き例外クラス(APIError 系)が持つ status のみ。無ければ省略 */
    statusCode?: number;
    noteId: string;
  };
}

/**
 * DB・API レスポンスに保存・公開する failureReason は、あらかじめ定義した短い日本語の
 * 利用者向け文言のみとする(最大500文字。§ notes テーブル拡張 の `varchar(500)` と対応)。
 */
const USER_MESSAGES: Record<ErrorCategory, string> = {
  image_fetch_failed: "画像の取得に失敗しました。もう一度お試しください。",
  image_processing_timeout: "画像の処理に時間がかかりすぎたため中断しました。",
  image_processing_crashed: "画像の処理中に問題が発生しました。",
  claude_api_error: "AI 解析サービスが一時的に利用できませんでした。",
  claude_refusal: "画像の内容を解析できませんでした。",
  output_validation_failed: "AI の応答を処理できませんでした。",
  unknown_error: "予期しないエラーが発生しました。",
};

/**
 * `stop_reason === "refusal"` を検知した際に ClaudeVisionClient が投げる専用エラー型
 * (§ AI 解析の出力スキーマ・プロンプト設計 参照)。
 */
export class ClaudeRefusalError extends Error {
  constructor() {
    super("claude refused to analyze the image");
    this.name = "ClaudeRefusalError";
    Object.setPrototypeOf(this, ClaudeRefusalError.prototype);
  }
}

/**
 * 画像処理(resize-for-claude)の子プロセスが30秒のタイムアウトで SIGKILL された場合に
 * resize-for-claude.ts が投げる専用エラー型(§ 画像処理のハング・クラッシュ耐性 参照)。
 */
export class ImageProcessingTimeoutError extends Error {
  constructor() {
    super("image processing timed out");
    this.name = "ImageProcessingTimeoutError";
    Object.setPrototypeOf(this, ImageProcessingTimeoutError.prototype);
  }
}

/**
 * 画像処理の子プロセスが異常終了(クラッシュ・OOM 等)した場合に resize-for-claude.ts が
 * 投げる専用エラー型(§ 画像処理のハング・クラッシュ耐性 参照)。
 */
export class ImageProcessingCrashedError extends Error {
  constructor() {
    super("image processing child process crashed");
    this.name = "ImageProcessingCrashedError";
    Object.setPrototypeOf(this, ImageProcessingCrashedError.prototype);
  }
}

/**
 * 画像処理の子プロセス自体は正常終了したが、寸法・画素数検査や再圧縮ループが収束しない等の理由で
 * 処理自体が失敗した場合に resize-for-claude.ts が投げる専用エラー型。§ Claude 入力画像の
 * リサイズ・再圧縮 手順4のとおり、この経路は `image_fetch_failed` 相当として扱う(この経路に
 * 到達する画像は現実的にほぼ無い想定)。
 */
export class ImageProcessingFailedError extends Error {
  constructor() {
    super("image processing failed");
    this.name = "ImageProcessingFailedError";
    Object.setPrototypeOf(this, ImageProcessingFailedError.prototype);
  }
}

/**
 * ScreenshotAnalysisProcessor が § 実装手順13 の手順2(loadProcessingInput)・手順3(MinIO からの
 * 画像取得)のいずれかで失敗した場合に投げる専用エラー型。DB タイムアウト・MinIO の NoSuchKey・
 * 接続断など元例外の種類を問わず、この経路の失敗はすべて image_fetch_failed として扱う
 * (§ 外部通信タイムアウトの一貫適用「worker の画像取得(ScreenshotAnalysisProcessor)→
 * sanitizeError の image_fetch_failed 扱い」・§ 実装手順13 手順2 参照)。
 */
export class ImageFetchFailedError extends Error {
  constructor() {
    super("failed to load processing input or fetch the image from storage");
    this.name = "ImageFetchFailedError";
    Object.setPrototypeOf(this, ImageFetchFailedError.prototype);
  }
}

/**
 * instanceof チェックのみで分類する(err.message 等の文字列内容は一切読まない)。
 */
export function classifyError(err: unknown): ErrorCategory {
  if (err instanceof Anthropic.APIError) {
    return "claude_api_error";
  }
  if (err instanceof ClaudeRefusalError) {
    return "claude_refusal";
  }
  if (err instanceof ZodError) {
    return "output_validation_failed";
  }
  // `JSON.parse()` が Claude の応答テキストを解析できなかった場合(不正な JSON・途中で
  // 切れた応答等)は `SyntaxError` を投げる。ZodError と同じく「Claude の出力自体が期待した
  // 形式でなかった」障害であり、原因不明の unknown_error ではなく output_validation_failed
  // として分類・表示すべき(Codex コードレビュー 2026-07-13 指摘 [A-4] への対応)。
  if (err instanceof SyntaxError) {
    return "output_validation_failed";
  }
  if (err instanceof ImageProcessingTimeoutError) {
    return "image_processing_timeout";
  }
  if (err instanceof ImageProcessingCrashedError) {
    return "image_processing_crashed";
  }
  if (err instanceof ImageProcessingFailedError) {
    return "image_fetch_failed";
  }
  if (err instanceof ImageFetchFailedError) {
    return "image_fetch_failed";
  }
  if (err instanceof StorageTimeoutError) {
    return "image_fetch_failed";
  }
  return "unknown_error";
}

/**
 * 例外を固定分類(ErrorCategory)へ変換し、利用者向け文言(userMessage)とログ用の安全な詳細
 * (logDetail: category・statusCode・noteId のみ)を組み立てる。ClaudeVisionClient 呼び出し側が
 * refusal・API エラー・検証失敗をサニタイズして例外化する際に使う(§ failureReason の
 * サニタイズ方針 参照)。
 */
export function sanitizeError(err: unknown, noteId: string): SanitizedError {
  const category = classifyError(err);
  const statusCode =
    err instanceof Anthropic.APIError && typeof err.status === "number" ? err.status : undefined;

  return {
    userMessage: USER_MESSAGES[category],
    logDetail: {
      category,
      ...(statusCode !== undefined ? { statusCode } : {}),
      noteId,
    },
  };
}

/**
 * サニタイズ済みエラーを実際に throw するためのラッパー(通常の Error インスタンスとして
 * 扱えるようにする)。`message` は既に安全な userMessage のみで構成されているため、そのまま
 * failureReason に使ってよい。`logDetail` はログ出力にのみ使う。
 */
export class SanitizedException extends Error {
  readonly category: ErrorCategory;
  readonly logDetail: SanitizedError["logDetail"];

  constructor(sanitized: SanitizedError) {
    super(sanitized.userMessage);
    this.name = "SanitizedException";
    this.category = sanitized.logDetail.category;
    this.logDetail = sanitized.logDetail;
    Object.setPrototypeOf(this, SanitizedException.prototype);
  }
}
