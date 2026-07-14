/**
 * packages/storage が行う MinIO 操作(uploadObject・getObjectStream・deleteObject)のいずれかが
 * 既定タイムアウト内に完了しなかった場合に投げる専用エラー型。
 * (計画書 §外部通信タイムアウトの一貫適用 参照)
 *
 * 呼び出し側はこのエラー型で分岐する(用途に応じたマッピングは呼び出し側の責務):
 * - アップロード → 502
 * - 画像配信(ヘッダー送信前) → 504
 * - 補償削除・物理削除 → ログ記録のうえ次回実行時の再試行に委ねる
 * - worker の画像取得 → sanitizeError の image_fetch_failed 扱い
 */
export class StorageTimeoutError extends Error {
  readonly operation: string;
  readonly timeoutMs: number;

  constructor(operation: string, timeoutMs: number) {
    super(`MinIO operation "${operation}" timed out after ${timeoutMs}ms`);
    this.name = "StorageTimeoutError";
    this.operation = operation;
    this.timeoutMs = timeoutMs;
    Object.setPrototypeOf(this, StorageTimeoutError.prototype);
  }
}
