import { Module } from "@nestjs/common";
import { NoteEnrichmentQueueModule } from "../note-enrichment-queue.module";
import { ScreenshotAnalysisQueueModule } from "../screenshot-analysis-queue.module";
import { CLAUDE_VISION_CLIENT, createClaudeVisionClientFromEnv } from "./claude-vision.client";
import { ScreenshotAnalysisProcessor } from "./screenshot-analysis.processor";

/**
 * `queues/ping/` パターンを踏襲した module(§ 実装手順13 参照)。`@Processor` が
 * `SCREENSHOT_ANALYSIS_QUEUE_NAME` のキューを解決できるよう `ScreenshotAnalysisQueueModule`
 * を import する(NestJS のプロバイダーは兄弟モジュールへ暗黙に継承されないため)。
 * `NoteEnrichmentQueueModule` は completeAnalysis 成功後に note-enrichment キューへ
 * enqueue するため(M1-4a 計画 §設計決定4 投入契機(b))に import する。
 */
@Module({
  imports: [ScreenshotAnalysisQueueModule, NoteEnrichmentQueueModule],
  providers: [
    ScreenshotAnalysisProcessor,
    { provide: CLAUDE_VISION_CLIENT, useFactory: createClaudeVisionClientFromEnv },
  ],
})
export class ScreenshotAnalysisModule {}
