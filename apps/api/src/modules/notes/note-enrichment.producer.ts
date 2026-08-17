import { Logger } from "@nestjs/common";
import type { Queue } from "bullmq";
import {
  noteEnrichmentJobId,
  NOTE_ENRICHMENT_JOB_OPTIONS,
  NOTE_ENRICHMENT_QUEUE_NAME,
  type NoteEnrichmentJobPayload,
} from "@secondbrain/shared";

// queue.add() 自体のアプリケーション側デッドライン(screenshots.producer.ts の
// ENQUEUE_TIMEOUT_MS と同じ考え方。Redis 停止時でも数秒以内に呼び出し元へ制御を返すため)。
const ENQUEUE_TIMEOUT_MS = 3_000;

const logger = new Logger("NoteEnrichmentProducer");

/**
 * note-enrichment キューへのジョブ投入を一元化する共通ヘルパー(screenshots.producer.ts の
 * enqueueScreenshotAnalysis と同じパターン)。memo ノート作成直後・ノート更新(PUT)直後の
 * 両方から呼ばれる(M1-4a 計画 §設計決定4・§担当スコープ2 参照)。
 *
 * fail-closed の投入順序(D0 指摘[3]対応): 呼び出し元は必ず DB へ
 * `enrichment_status='pending'` を書き込んだ後にこの関数を呼ぶこと(NotesService.create/update
 * が insert/update 時に書き込み済み)。`queue.add()` 自体を約3秒の `Promise.race` で保護し、
 * 失敗時(Redis 停止・タイムアウトを含む)はログに記録するのみで例外は re-throw しない
 * (呼び出し元は常に処理を継続してよい。DB 側の pending 状態は既に書き込み済みのため、
 * 回収バッチ `note-enrichment-requeue` が取りこぼしを再投入する)。
 */
export async function enqueueNoteEnrichment(queue: Queue, noteId: string): Promise<void> {
  const payload: NoteEnrichmentJobPayload = { noteId };
  const jobId = noteEnrichmentJobId(noteId);

  const addPromise = queue.add(NOTE_ENRICHMENT_QUEUE_NAME, payload, {
    ...NOTE_ENRICHMENT_JOB_OPTIONS,
    jobId,
  });
  // 監視用の後始末は Promise.race のタイムアウト完了ではなく、素の addPromise 自体の
  // settle(resolve/reject いずれも)に直接結び付け、いずれのハンドラも re-throw しない
  // (未処理 rejection を防ぐ。screenshots.producer.ts と同じパターン)。
  addPromise.then(
    () => undefined,
    () => undefined,
  );

  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("note-enrichment job enqueue timed out"));
    }, ENQUEUE_TIMEOUT_MS);
    timer.unref?.();
  });

  try {
    await Promise.race([addPromise, timeoutPromise]);
  } catch {
    // err の内容(接続情報等を含みうる)はログに出さない
    // (§ failureReason のサニタイズ方針・screenshots.producer.ts の classifyUploadError と同じ方針)。
    logger.warn(`note-enrichment job enqueue failed: ${JSON.stringify({ noteId })}`);
  } finally {
    // addPromise が先に settle しても timeoutPromise のタイマーは既定では満了まで残り続ける
    // (screenshots.producer.ts と同じ配慮)。
    clearTimeout(timer!);
  }
}
