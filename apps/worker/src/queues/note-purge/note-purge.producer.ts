import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { NOTE_PURGE_QUEUE_NAME } from "./note-purge.processor";

export const NOTE_PURGE_JOB_NAME = "note-purge";
export const NOTE_PURGE_SCHEDULER_ID = "note-purge-cron";
/** 毎日3時(§ NotePurgeModule 参照)。 */
export const NOTE_PURGE_CRON_PATTERN = "0 3 * * *";
/**
 * cron パターンの評価基準タイムゾーン。明示指定しない場合サーバーのローカルタイムゾーンで
 * 評価され、デプロイ環境のサーバー設定に応じて実行時刻の意味が変わってしまう
 * (Codex コードレビュー r6 指摘 [C-2] への対応。UTC で固定することをユーザーと確認済み)。
 */
export const NOTE_PURGE_CRON_TZ = "UTC";
/** repeatable job 自身の実行履歴の保持上限(Codex レビュー r27 指摘 [4] 参照)。 */
const HISTORY_KEEP_COUNT = 20;

/**
 * BullMQ repeatable job(固定 jobSchedulerId で冪等登録)を module 起動時に登録する
 * (§ NotePurgeModule・§ 実装手順15 参照)。
 */
@Injectable()
export class NotePurgeProducer implements OnModuleInit {
  private readonly logger = new Logger(NotePurgeProducer.name);

  constructor(@InjectQueue(NOTE_PURGE_QUEUE_NAME) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      NOTE_PURGE_SCHEDULER_ID,
      { pattern: NOTE_PURGE_CRON_PATTERN, tz: NOTE_PURGE_CRON_TZ },
      {
        name: NOTE_PURGE_JOB_NAME,
        opts: {
          removeOnComplete: { count: HISTORY_KEEP_COUNT },
          removeOnFail: { count: HISTORY_KEEP_COUNT },
        },
      },
    );
    this.logger.log("registered note-purge repeatable job scheduler");
  }
}
