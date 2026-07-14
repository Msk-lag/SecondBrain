import { Module } from "@nestjs/common";
import { ScreenshotAnalysisQueueModule } from "../../queues/screenshot-analysis-queue.module";
import { NotesModule } from "../notes/notes.module";
import { ScreenshotsController } from "./screenshots.controller";
import { UploadRateLimitModule } from "./upload-rate-limit.module";

@Module({
  // NotesModule: 画像配信の所有権確認に NotesService.findOwned を使うため
  // (Codex レビュー r11 指摘 [3] 参照)。ScreenshotAnalysisQueueModule: アップロード
  // 直後のジョブ投入に screenshot-analysis キューへの @InjectQueue を使うため。
  // UploadRateLimitModule: PerUserUploadLimiter・UploadRateLimitGuard を NotesModule
  // (retry エンドポイント)とも共有するため独立モジュールへ切り出し済み(Codex コードレビュー
  // 2026-07-13 r9 指摘 [A-3] への対応)。
  imports: [ScreenshotAnalysisQueueModule, NotesModule, UploadRateLimitModule],
  controllers: [ScreenshotsController],
})
export class ScreenshotsModule {}
