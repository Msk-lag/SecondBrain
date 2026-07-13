import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { SCREENSHOT_ANALYSIS_QUEUE_NAME } from "@secondbrain/shared";

/**
 * `BullModule.registerQueue` を import しつつ `BullModule` を re-export する専用モジュール。
 * apps/api/src/queues/screenshot-analysis-queue.module.ts と同じパターン(§ ジョブ契約の
 * 一元化・Codex レビュー r10 指摘 [1] 参照)。`ScreenshotAnalysisModule`(@Processor の
 * 登録に必要)・`NoteStuckRequeueModule` の両方がこれを import する(§ 実装手順13 参照)。
 */
@Module({
  imports: [BullModule.registerQueue({ name: SCREENSHOT_ANALYSIS_QUEUE_NAME })],
  exports: [BullModule],
})
export class ScreenshotAnalysisQueueModule {}
