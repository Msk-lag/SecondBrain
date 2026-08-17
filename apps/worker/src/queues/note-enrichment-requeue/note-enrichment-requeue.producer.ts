import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import {
  NOTE_ENRICHMENT_REQUEUE_JOB_NAME,
  NOTE_ENRICHMENT_REQUEUE_QUEUE_NAME,
  NOTE_ENRICHMENT_REQUEUE_SCHEDULER_ID,
} from "./note-enrichment-requeue-queue";

/**
 * 1分ごと(Fable 5 + Codex 独立議論 論点1 の結論を反映)。当初は note-stuck-requeue と同じ
 * 10分間隔だったが、note-enrichment の jobId はノート単位で固定であり、ジョブが active の間に
 * 同じノートが更新されると (a) 新規 enqueue が BullMQ の重複抑止で入らず (b) 実行中ジョブの
 * 結果は CAS 不成立で破棄される、という状態になりうる。この構成自体はリコンサイラ(調停ループ)
 * パターンとして正しいが、10分間隔は元々バックグラウンド修復用のチューニング値であり、実際には
 * 主要な鮮度保証経路として機能していたため、周期を1分へ締めて最悪ケースの遅延を(約20分から)
 * 約2分へ短縮する。閾値(staleEnrichmentFilter の INTERVAL)もあわせて1分へ短縮する
 * (note-enrichment-requeue.processor.ts 参照)。
 */
export const NOTE_ENRICHMENT_REQUEUE_CRON_PATTERN = "* * * * *";
/** repeatable job 自身の実行履歴の保持上限(note-stuck-requeue.producer.ts と同じ値)。 */
const HISTORY_KEEP_COUNT = 20;

/**
 * BullMQ repeatable job(固定 jobSchedulerId で冪等登録)を module 起動時に登録する
 * (note-stuck-requeue.producer.ts と同じパターン)。
 *
 * cron パターンを変更する際の罠(Fable 5 の指摘): BullMQ の「レガシー」repeatable job API
 * (`queue.add(name, data, { repeat: { pattern } })`)は、Redis 上のキーが repeat オプション
 * 自体から導出されるため、pattern/every を変えただけでは旧スケジューラが Redis 上に残存し、
 * 新旧のスケジューラが両方動いてしまう(`removeRepeatable`/`removeRepeatableByKey` で明示的に
 * 削除しない限り消えない)。
 *
 * このモジュールが使う `upsertJobScheduler`(Job Scheduler API、BullMQ v5+)はこれとは別物で、
 * Redis 上のキーは呼び出し時に渡す `jobSchedulerId`(下記 `NOTE_ENRICHMENT_REQUEUE_SCHEDULER_ID`
 * という固定文字列)そのものであり、pattern からは導出されない。同じ jobSchedulerId で
 * `upsertJobScheduler` を呼び直すと、内部の Lua スクリプト(`addJobScheduler`)が
 * 既存スケジューラの次回実行分(delayed job)を確実に削除してから新しい pattern で登録し直す
 * ため、pattern を変更しても旧スケジューラが残存することはない(BullMQ 5.79.2 のソース
 * `job-scheduler.js`/`addJobScheduler-11.lua` で確認済み)。そのため、本モジュールでは
 * `removeJobScheduler`/`removeRepeatable` を別途呼ぶ必要はない。ただし、将来 jobSchedulerId
 * 自体を変更する場合は、旧 id のスケジューラが Redis 上に残り続ける(id が変われば
 * `upsertJobScheduler` は「新規」として扱うため)ので、その場合は移行前に旧 id へ
 * `removeJobScheduler` を呼ぶこと。
 */
@Injectable()
export class NoteEnrichmentRequeueProducer implements OnModuleInit {
  private readonly logger = new Logger(NoteEnrichmentRequeueProducer.name);

  constructor(@InjectQueue(NOTE_ENRICHMENT_REQUEUE_QUEUE_NAME) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      NOTE_ENRICHMENT_REQUEUE_SCHEDULER_ID,
      { pattern: NOTE_ENRICHMENT_REQUEUE_CRON_PATTERN },
      {
        name: NOTE_ENRICHMENT_REQUEUE_JOB_NAME,
        opts: {
          removeOnComplete: { count: HISTORY_KEEP_COUNT },
          removeOnFail: { count: HISTORY_KEEP_COUNT },
        },
      },
    );
    this.logger.log("registered note-enrichment-requeue repeatable job scheduler");
  }
}
