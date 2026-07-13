import { Module } from "@nestjs/common";
import { ScreenshotAnalysisQueueModule } from "../../queues/screenshot-analysis-queue.module";
import { UploadRateLimitModule } from "../screenshots/upload-rate-limit.module";
import { NotesController } from "./notes.controller";
import { NotesService } from "./notes.service";

@Module({
  // retry ハンドラが screenshot-analysis キューへジョブ投入するため
  // (§ ジョブ契約の一元化 参照)。UploadRateLimitModule: retry エンドポイントにも
  // アップロードと同じユーザー単位レート制限を適用するため(Codex コードレビュー
  // 2026-07-13 r9 指摘 [A-3] への対応。以前は retry に制限が無く、failed ノートへの
  // retry を繰り返すことでアップロード制限を迂回してAI課金を無制限に消費できた)。
  imports: [ScreenshotAnalysisQueueModule, UploadRateLimitModule],
  controllers: [NotesController],
  providers: [NotesService],
  // ScreenshotsModule が画像配信の所有権確認(NotesService.findOwned)に使うため export する
  // (Codex レビュー r11 指摘 [3] 参照。sibling モジュール間の provider は自動継承されない)。
  exports: [NotesService],
})
export class NotesModule {}
