import { Global, Module } from "@nestjs/common";
import { createMinioClientFromEnv, type MinioClient } from "@secondbrain/storage";

export const MINIO_CLIENT = "MINIO_CLIENT";

/**
 * `@secondbrain/storage` の MinIO クライアントを DI 提供する薄いモジュール。
 * apps/api/src/db/db.module.ts の @Global() パターンを踏襲する。
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
