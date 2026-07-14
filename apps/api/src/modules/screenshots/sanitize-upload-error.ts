import { isDuplicateEntryError } from "@secondbrain/db";
import { DbPoolInsertLimitError } from "./db-pool-insert-limit";

export type UploadErrorOperation = "minio_upload" | "db_insert" | "compensation_delete" | "enqueue";

export type UploadErrorCategory =
  | "minio_upload_failed"
  | "db_insert_confirmed_failed"
  | "db_insert_ambiguous"
  | "compensation_delete_failed"
  | "enqueue_failed"
  | "unknown_error";

export interface ClassifiedUploadError {
  category: UploadErrorCategory;
  noteId: string;
}

/**
 * アップロード経路(§ アップロード時(ScreenshotsController.upload)の順序と補償・
 * § アップロード経路のエラーログサニタイズ 参照)で発生した例外を、呼び出しフェーズ
 * (operation)と noteId を呼び出し元から明示的に受け取ったうえで分類する。
 *
 * `operation` と、instanceof・構造化エラーコード(mysql2 の `err.code === "ER_DUP_ENTRY"`
 * は `operation === "db_insert"` の場合のみ確定的失敗に分類し、それ以外の db_insert 系
 * エラーは不確定な失敗に分類する)の組み合わせのみで `category` を決定し、
 * `err.message`・`err.stack`・`err.cause`・`err.request`・`err.response` 等の文字列内容や
 * リクエスト/レスポンス本体は一切読み取らない(§ failureReason のサニタイズ方針 の
 * classifyError と同一パターン)。
 */
export function classifyUploadError(
  operation: UploadErrorOperation,
  noteId: string,
  err: unknown,
): ClassifiedUploadError {
  switch (operation) {
    case "minio_upload":
      return { category: "minio_upload_failed", noteId };
    case "compensation_delete":
      return { category: "compensation_delete_failed", noteId };
    case "enqueue":
      return { category: "enqueue_failed", noteId };
    case "db_insert":
      return classifyDbInsertError(noteId, err);
    default:
      return { category: "unknown_error", noteId };
  }
}

/**
 * insert 自体を一度も呼んでいないことが instanceof チェックだけで確実に判定できる
 * `DbPoolInsertLimitError`、および MariaDB がクエリを同期的に拒否したことが確実な一意
 * 制約違反(`ER_DUP_ENTRY`)のみを確定的な失敗として扱う。再照会には頼らない
 * (§ アップロード時(ScreenshotsController.upload)の順序と補償・Codex レビュー
 * r22 指摘 [1]・r23 指摘 [1] 参照)。それ以外(接続断・タイムアウト等)は、insert が DB
 * 側でどこまで進行したか確定できない不確定な失敗として扱う。
 */
function classifyDbInsertError(noteId: string, err: unknown): ClassifiedUploadError {
  if (err instanceof DbPoolInsertLimitError || isDuplicateEntryError(err)) {
    return { category: "db_insert_confirmed_failed", noteId };
  }
  return { category: "db_insert_ambiguous", noteId };
}
