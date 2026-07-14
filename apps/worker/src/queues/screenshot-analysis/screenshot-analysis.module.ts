import { Module } from "@nestjs/common";
import { ScreenshotAnalysisQueueModule } from "../screenshot-analysis-queue.module";
import { CLAUDE_VISION_CLIENT, createClaudeVisionClientFromEnv } from "./claude-vision.client";
import { ScreenshotAnalysisProcessor } from "./screenshot-analysis.processor";

/**
 * `queues/ping/` パターンを踏襲した module(§ 実装手順13 参照)。`@Processor` が
 * `SCREENSHOT_ANALYSIS_QUEUE_NAME` のキューを解決できるよう `ScreenshotAnalysisQueueModule`
 * を import する(NestJS のプロバイダーは兄弟モジュールへ暗黙に継承されないため)。
 */
@Module({
  imports: [ScreenshotAnalysisQueueModule],
  providers: [
    ScreenshotAnalysisProcessor,
    { provide: CLAUDE_VISION_CLIENT, useFactory: createClaudeVisionClientFromEnv },
  ],
})
export class ScreenshotAnalysisModule {}
