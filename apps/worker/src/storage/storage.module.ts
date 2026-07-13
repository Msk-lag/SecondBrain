import { Global, Module } from "@nestjs/common";
import { createMinioClientFromEnv, type MinioClient } from "@secondbrain/storage";

export const MINIO_CLIENT = "MINIO_CLIENT";

/**
 * `@secondbrain/storage` の MinIO クライアントを DI 提供する薄いモジュール。
 * apps/api/src/storage/storage.module.ts と同等のパターン(Codex レビュー r5 指摘 [1] への対応)。
 * ScreenshotAnalysisProcessor(画像取得)・NotePurgeProcessor(画像削除)の両方が利用する想定。
 */
@Global()
@Module({
  providers: [
    {
      provide: MINIO_CLIENT,
      useFactory: (): MinioClient => createMinioClientFromEnv(),
    },
  ],
  exports: [MINIO_CLIENT],
})
export class StorageModule {}
