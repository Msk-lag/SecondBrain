import { Module } from "@nestjs/common";
import { PerUserUploadLimiter } from "./upload-rate-limit";
import { UploadRateLimitGuard } from "./upload-rate-limit.guard";

/**
 * `PerUserUploadLimiter`/`UploadRateLimitGuard` を独立したモジュールとして切り出す。
 * `POST /notes/:id/retry` にも同じレート制限を適用する必要があり(Codex コードレビュー
 * 2026-07-13 r9 指摘 [A-3] への対応。retry には従来レート制限が無く、failed ノートへの
 * retry を繰り返すことでアップロード制限を迂回して Claude API 呼び出し=AI課金を無制限に
 * 消費できた)、NotesModule・ScreenshotsModule の双方からこの provider を利用したい。
 * ScreenshotsModule が NotesModule を import している(画像配信の所有権確認に
 * NotesService.findOwned を使うため)ため、NotesModule 側から直接 ScreenshotsModule を
 * import すると循環依存になる。依存を持たない本モジュールを両者が個別に import すること
 * でこれを避ける。
 */
@Module({
  providers: [PerUserUploadLimiter, UploadRateLimitGuard],
  exports: [PerUserUploadLimiter, UploadRateLimitGuard],
})
export class UploadRateLimitModule {}
