import { StorageTimeoutError } from "@secondbrain/storage";

/**
 * メンテナンスジョブ(`NoteStuckRequeueProcessor`・`NotePurgeProcessor`)の例外サニタイズ
 * (§ メンテナンスジョブの例外サニタイズ・Codex レビュー r21 指摘 [2] 参照)。
 *
 * BullMQ は re-throw された例外の message/stack を Redis 上のジョブ情報(failedReason/
 * stacktrace)へそのまま保存するため、DB接続文字列・SQL文・MinIO のオブジェクトキー等が
 * 非公開情報として残ってしまう。§ failureReason のサニタイズ方針 の `sanitizeError` と同じ
 * 設計思想で、re-throw する例外・出力するログの双方を「固定分類名」のみで構成する(元の例外の
 * message・stack・cause・接続情報は一切引き継がない)。
 */
export type MaintenanceErrorCategory = "db_timeout" | "storage_error" | "unknown_error";

export interface SanitizedMaintenanceError {
  category: MaintenanceErrorCategory;
}

/**
 * `NoteStuckRequeueProcessor`・`NotePurgeProcessor` それぞれのファイル内で定義する
 * `withTimeout` ヘルパー(DB 操作・BullMQ 経由の Redis 操作いずれも10秒のアプリケーション
 * タイムアウトで包む)がタイムアウト時に投げる共有マーカーエラー。
 */
export class MaintenanceTimeoutError extends Error {
  constructor() {
    super("maintenance job operation timed out");
    this.name = "MaintenanceTimeoutError";
    Object.setPrototypeOf(this, MaintenanceTimeoutError.prototype);
  }
}

/**
 * instanceof チェックのみで分類する(err.message 等の文字列内容は一切読まない)。
 */
function classifyMaintenanceErrorCategory(err: unknown): MaintenanceErrorCategory {
  if (err instanceof MaintenanceTimeoutError) {
    return "db_timeout";
  }
  if (err instanceof StorageTimeoutError) {
    return "storage_error";
  }
  return "unknown_error";
}

/**
 * 例外を固定分類のみへ変換する(§ メンテナンスジョブの例外サニタイズ 参照)。
 */
export function classifyMaintenanceError(err: unknown): SanitizedMaintenanceError {
  return { category: classifyMaintenanceErrorCategory(err) };
}

/**
 * サニタイズ済みエラーを実際に throw するためのラッパー。message は固定分類名のみで
 * 構成されるため、BullMQ の failedReason/stacktrace・アプリケーションログのいずれに
 * 記録されても安全。
 */
export class SanitizedMaintenanceException extends Error {
  readonly category: MaintenanceErrorCategory;

  constructor(sanitized: SanitizedMaintenanceError) {
    super(`maintenance job failed: ${sanitized.category}`);
    this.name = "SanitizedMaintenanceException";
    this.category = sanitized.category;
    Object.setPrototypeOf(this, SanitizedMaintenanceException.prototype);
  }
}
