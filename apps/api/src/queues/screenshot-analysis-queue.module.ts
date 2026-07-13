import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { SCREENSHOT_ANALYSIS_QUEUE_NAME } from "@secondbrain/shared";

/**
 * `BullModule.registerQueue` を import しつつ `BullModule` を re-export する専用モジュール。
 * `AppModule` に `BullModule.registerQueue()` を直接書くだけでは、sibling モジュールである
 * `ScreenshotsModule`・`NotesModule` から `@InjectQueue` を解決できない
 * (NestJS のプロバイダーは親モジュールから兄弟の feature module へ暗黙に継承されないため)。
 * `ScreenshotsModule`・`NotesModule` の両方がこのモジュールを明示的に import する。
 * (§ ジョブ契約の一元化・§ apps/api: BullMQ 設定+キューモジュールの DI 公開範囲 参照)
 */
@Module({
  imports: [BullModule.registerQueue({ name: SCREENSHOT_ANALYSIS_QUEUE_NAME })],
  exports: [BullModule],
})
export class ScreenshotAnalysisQueueModule {}
