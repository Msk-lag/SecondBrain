import { Injectable } from "@nestjs/common";

/**
 * スクショアップロード経路の濫用防止(Codex コードレビュー r3 指摘 [A-1] への対応)。
 * 認証済みユーザーであれば件数・同時実行数の制限なくアップロードでき、MinIO 容量・
 * BullMQ ジョブ・Claude API 課金を無制限に消費できてしまう問題への技術的な安全策。
 *
 * ユーザー単位の「同時実行数」(concurrency)と「一定時間内の件数」(rate)の両方を
 * アプリ内メモリで管理する(単一 api プロセス前提。§ 対象外 の「複数インスタンスでの
 * 厳密な排他制御」節と同じ前提を踏襲。db-pool-insert-limit.ts と同様の設計)。
 * 具体的な上限値は個人開発 MVP・単一ユーザー想定の初期値であり、将来の製品判断で
 * 調整可能なパラメータとして扱う。
 */
export class UploadRateLimitError extends Error {
  constructor() {
    super("アップロードの頻度が上限に達しています。しばらく待ってから再度お試しください。");
    this.name = "UploadRateLimitError";
    Object.setPrototypeOf(this, UploadRateLimitError.prototype);
  }
}

/** ユーザーごとの同時実行(in-flight)上限。 */
export const CONCURRENCY_LIMIT = 3;
/** `RATE_LIMIT_WINDOW_MS` の間にユーザーが行える試行回数の上限。 */
export const RATE_LIMIT = 20;
/** レート制限の時間窓(ミリ秒)。 */
export const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

/**
 * `UploadRateLimitGuard`(Guard・FileInterceptor より前に実行される)と
 * `ScreenshotsController`(release のみ。acquire は Guard 側で行う)の双方から注入される
 * モジュールスコープのシングルトン(Codex コードレビュー r4 指摘 [A-2] への対応:
 * コントローラーのメソッド本体で acquire していると、Multer/FileInterceptor が既に
 * リクエストボディ〔最大10MB〕をメモリへ読み切った後になってしまい、同時実行数を絞っても
 * メモリ枯渇を防げない)。
 */
@Injectable()
export class PerUserUploadLimiter {
  private readonly inFlightByUser = new Map<string, number>();
  private readonly attemptTimestampsByUser = new Map<string, number[]>();

  /**
   * アップロード処理を開始する前に呼ぶ。同時実行数・レートいずれかの上限に達している場合は
   * MinIO へのアップロード等を一度も行わずに `UploadRateLimitError` を投げる。
   */
  acquire(userId: string): void {
    const now = Date.now();
    const timestamps = (this.attemptTimestampsByUser.get(userId) ?? []).filter(
      (t) => now - t < RATE_LIMIT_WINDOW_MS,
    );

    const inFlight = this.inFlightByUser.get(userId) ?? 0;
    if (inFlight >= CONCURRENCY_LIMIT || timestamps.length >= RATE_LIMIT) {
      this.attemptTimestampsByUser.set(userId, timestamps);
      throw new UploadRateLimitError();
    }

    timestamps.push(now);
    this.attemptTimestampsByUser.set(userId, timestamps);
    this.inFlightByUser.set(userId, inFlight + 1);
  }

  /** acquire() で確保した in-flight 枠を解放する(成功/失敗いずれの settle でも呼ぶこと)。 */
  release(userId: string): void {
    const inFlight = this.inFlightByUser.get(userId) ?? 0;
    if (inFlight <= 1) {
      this.inFlightByUser.delete(userId);
    } else {
      this.inFlightByUser.set(userId, inFlight - 1);
    }
  }
}
