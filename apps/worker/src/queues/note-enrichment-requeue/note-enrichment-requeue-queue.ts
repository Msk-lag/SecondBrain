import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";
import { NOTE_ENRICHMENT_QUEUE_NAME } from "@secondbrain/shared";
import { getFailFastRedisConnectionOptions } from "../note-stuck-requeue/note-stuck-requeue-queue";

/** enrichment 回収バッチ自身の(BullMQ repeatable job としての)キュー名。 */
export const NOTE_ENRICHMENT_REQUEUE_QUEUE_NAME = "note-enrichment-requeue";
export const NOTE_ENRICHMENT_REQUEUE_JOB_NAME = "note-enrichment-requeue";
export const NOTE_ENRICHMENT_REQUEUE_SCHEDULER_ID = "note-enrichment-requeue-cron";

/**
 * enrichment 回収バッチが `getJob`/`getState`/`add` に使う、note-enrichment キュー名を指す
 * 専用 `Queue` インスタンス(note-stuck-requeue-queue.ts の `NoteStuckRequeueScreenshotQueue`
 * と同じパターン)。Worker 用接続(`maxRetriesPerRequest: null` が BullMQ の要件上必須)とは
 * 別の fail-fast Redis 接続(`getFailFastRedisConnectionOptions`。note-stuck-requeue-queue.ts
 * から再利用し、Redis 接続設定を重複定義しない)を使うことで、Redis 長期停止時にコマンドが
 * 無期限にキューイングされて蓄積することを防ぐ。
 */
@Injectable()
export class NoteEnrichmentRequeueTargetQueue implements OnModuleDestroy {
  readonly queue: Queue;
  private closed = false;

  constructor() {
    this.queue = new Queue(NOTE_ENRICHMENT_QUEUE_NAME, {
      connection: getFailFastRedisConnectionOptions(),
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.queue.close();
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}
