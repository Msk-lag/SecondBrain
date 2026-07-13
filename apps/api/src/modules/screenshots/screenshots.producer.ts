import { Logger } from "@nestjs/common";
import type { Queue } from "bullmq";
import {
  screenshotAnalysisJobId,
  SCREENSHOT_ANALYSIS_JOB_OPTIONS,
  SCREENSHOT_ANALYSIS_QUEUE_NAME,
  type ScreenshotAnalysisJobPayload,
} from "@secondbrain/shared";
import { classifyUploadError } from "./sanitize-upload-error";

// queue.add() 自体のアプリケーション側デッドライン(§ apps/api: BullMQ 設定 参照。
// Redis 停止時でも数秒以内に呼び出し元へ制御を返すため)。
const ENQUEUE_TIMEOUT_MS = 3_000;

const logger = new Logger("ScreenshotAnalysisProducer");

/**
 * screenshot-analysis キューへのジョブ投入を一元化する共通ヘルパー。アップロード
 * (ScreenshotsController)・retry(NotesController)の両方から呼ばれる
 * (§ ジョブ契約の一元化(Codex レビュー r9 指摘 [2] への対応) 参照)。
 *
 * `queue.add()` 自体を約3秒の `Promise.race` で保護し、失敗時(Redis 停止・タイムアウトを
 * 含む)は `classifyUploadError("enqueue", ...)` でサニタイズしてからログに記録するのみで、
 * 例外は re-throw しない(呼び出し元は常に処理を継続してよい。ノート行は有効な pending
 * 状態のまま存在するため、回復は stuck ノート再投入バッチに委ねる — § アップロード時
 * (ScreenshotsController.upload)の順序と補償 手順5・§ retry(ユーザー起点の再実行)の
 * 冪等性 参照)。
 */
export async function enqueueScreenshotAnalysis(
  queue: Queue,
  noteId: string,
  generation: number,
): Promise<void> {
  const payload: ScreenshotAnalysisJobPayload = { noteId, generation };
  const jobId = screenshotAnalysisJobId(noteId, generation);

  const addPromise = queue.add(SCREENSHOT_ANALYSIS_QUEUE_NAME, payload, {
    ...SCREENSHOT_ANALYSIS_JOB_OPTIONS,
    jobId,
  });
  // 監視用の後始末は Promise.race のタイムアウト完了ではなく、素の addPromise 自体の
  // settle(resolve/reject いずれも)に直接結び付け、いずれのハンドラも re-throw しない
  // (未処理 rejection を防ぐ。db-pool-insert-limit.ts の release パターンと同じ考え方)。
  addPromise.then(
    () => undefined,
    () => undefined,
  );

  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("screenshot-analysis job enqueue timed out"));
    }, ENQUEUE_TIMEOUT_MS);
    timer.unref?.();
  });

  try {
    await Promise.race([addPromise, timeoutPromise]);
  } catch (err) {
    const classified = classifyUploadError("enqueue", noteId, err);
    logger.warn(`screenshot-analysis job enqueue failed: ${JSON.stringify(classified)}`);
  } finally {
    // addPromise が先に settle しても timeoutPromise のタイマーは既定では満了まで残り続ける
    // (Codex コードレビュー r6 指摘 [A-4] への対応。`unref()` はプロセス終了を妨げないだけで
    // タイマー自体は解放しない)。
    clearTimeout(timer!);
  }
}
