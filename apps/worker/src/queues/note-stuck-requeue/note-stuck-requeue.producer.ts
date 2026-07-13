import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import {
  NOTE_STUCK_REQUEUE_JOB_NAME,
  NOTE_STUCK_REQUEUE_QUEUE_NAME,
  NOTE_STUCK_REQUEUE_SCHEDULER_ID,
} from "./note-stuck-requeue-queue";

/** 10分ごと(§ stuck ノート再投入バッチ 参照)。 */
export const NOTE_STUCK_REQUEUE_CRON_PATTERN = "*/10 * * * *";
/** repeatable job 自身の実行履歴の保持上限(Codex レビュー r27 指摘 [4] 参照)。 */
const HISTORY_KEEP_COUNT = 20;

/**
 * BullMQ repeatable job(固定 jobSchedulerId で冪等登録)を module 起動時に登録する
 * (§ stuck ノート再投入バッチ・§ 実装手順14 参照)。
 */
@Injectable()
export class NoteStuckRequeueProducer implements OnModuleInit {
  private readonly logger = new Logger(NoteStuckRequeueProducer.name);

  constructor(@InjectQueue(NOTE_STUCK_REQUEUE_QUEUE_NAME) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      NOTE_STUCK_REQUEUE_SCHEDULER_ID,
      { pattern: NOTE_STUCK_REQUEUE_CRON_PATTERN },
      {
        name: NOTE_STUCK_REQUEUE_JOB_NAME,
        opts: {
          removeOnComplete: { count: HISTORY_KEEP_COUNT },
          removeOnFail: { count: HISTORY_KEEP_COUNT },
        },
      },
    );
    this.logger.log("registered note-stuck-requeue repeatable job scheduler");
  }
}
