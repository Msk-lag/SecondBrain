import { Logger } from "@nestjs/common";
import type { Queue } from "bullmq";
import {
  noteEnrichmentJobId,
  NOTE_ENRICHMENT_JOB_OPTIONS,
  NOTE_ENRICHMENT_QUEUE_NAME,
  type NoteEnrichmentJobPayload,
} from "@secondbrain/shared";
import {
  classifyEnrichmentError,
  NoteEnrichmentEnqueueTimeoutError,
} from "./sanitize-enrichment-error";

// queue.add() 自体のアプリケーション側デッドライン(apps/api/src/modules/screenshots/
// screenshots.producer.ts の ENQUEUE_TIMEOUT_MS と同じ考え方。Redis 停止時でも数秒以内に
// 呼び出し元へ制御を返す)。
const ENQUEUE_TIMEOUT_MS = 3_000;

const logger = new Logger("NoteEnrichmentProducer");

/**
 * note-enrichment キューへのジョブ投入を一元化するヘルパー(M1-4a 計画 §設計決定4 の
 * 投入契機(b)スクショ AI 解析の completeAnalysis 成功直後、から呼ばれる)。
 * `enqueueScreenshotAnalysis`(apps/api/src/modules/screenshots/screenshots.producer.ts)と
 * 同じパターン: `queue.add()` 自体を約3秒の `Promise.race` で保護し、失敗時(Redis 停止・
 * タイムアウトを含む)はログに記録するのみで例外は re-throw しない(呼び出し元の
 * completeAnalysis 自体は正常に完了させ、DB 側の `enrichment_status='pending'` が既に
 * 書き込まれているため、回収バッチ note-enrichment-requeue が取りこぼしを再投入する
 * ── § fail-closed の投入順序 参照)。
 */
export async function enqueueNoteEnrichment(queue: Queue, noteId: string): Promise<void> {
  const payload: NoteEnrichmentJobPayload = { noteId };
  const jobId = noteEnrichmentJobId(noteId);

  const addPromise = queue.add(NOTE_ENRICHMENT_QUEUE_NAME, payload, {
    ...NOTE_ENRICHMENT_JOB_OPTIONS,
    jobId,
  });
  // 監視用の後始末(未処理 rejection 防止。screenshots.producer.ts と同じパターン)。
  addPromise.then(
    () => undefined,
    () => undefined,
  );

  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new NoteEnrichmentEnqueueTimeoutError());
    }, ENQUEUE_TIMEOUT_MS);
    timer.unref?.();
  });

  try {
    await Promise.race([addPromise, timeoutPromise]);
  } catch (err) {
    // 生の err.message / String(err) はログに出さない(Redis 接続情報・認証情報を含む例外が
    // そのままログへ残ることを防ぐ。Codex 再レビュー HIGH 指摘対応)。固定メッセージ +
    // 安全な分類(category)のみを出力する。
    const category = classifyEnrichmentError(err);
    logger.warn(`note-enrichment job enqueue failed noteId=${noteId} category=${category}`);
  } finally {
    clearTimeout(timer!);
  }
}
