import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { NOTE_ENRICHMENT_QUEUE_NAME } from "@secondbrain/shared";

/**
 * `BullModule.registerQueue` を import しつつ `BullModule` を re-export する専用モジュール
 * (screenshot-analysis-queue.module.ts と同じパターン)。`NoteEnrichmentModule`(@Processor
 * の登録)・`ScreenshotAnalysisModule`(completeAnalysis 成功後に note-enrichment キューへ
 * enqueue するため `@InjectQueue(NOTE_ENRICHMENT_QUEUE_NAME)` を使う)の両方がこれを import する。
 */
@Module({
  imports: [BullModule.registerQueue({ name: NOTE_ENRICHMENT_QUEUE_NAME })],
  exports: [BullModule],
})
export class NoteEnrichmentQueueModule {}
