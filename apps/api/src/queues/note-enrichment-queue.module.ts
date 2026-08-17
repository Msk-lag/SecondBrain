import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { NOTE_ENRICHMENT_QUEUE_NAME } from "@secondbrain/shared";

/**
 * `BullModule.registerQueue` を import しつつ `BullModule` を re-export する専用モジュール。
 * `screenshot-analysis-queue.module.ts` と同じパターン(§ apps/api: BullMQ 設定+キューモジュール
 * の DI 公開範囲 参照)。`NotesModule` がこのモジュールを import して
 * `@InjectQueue(NOTE_ENRICHMENT_QUEUE_NAME)` を解決する(memo 作成時・ノート更新時の enqueue、
 * M1-4a 計画 §担当スコープ1・2 参照)。
 */
@Module({
  imports: [BullModule.registerQueue({ name: NOTE_ENRICHMENT_QUEUE_NAME })],
  exports: [BullModule],
})
export class NoteEnrichmentQueueModule {}
