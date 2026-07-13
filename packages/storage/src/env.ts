import { fileURLToPath } from "node:url";
import { config } from "dotenv";

/**
 * リポジトリルートの .env を読み込む(既に設定済みの環境変数は上書きしない)。
 * cwd に依存しないよう、このファイルからの相対位置で解決する
 * (src/ と dist/ は同じ深さにあるためビルド後も同じパスになる。packages/db/src/env.ts と同じパターン)。
 */
export function loadRootEnv(): void {
  config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });
}

export interface MinioEnvConfig {
  host: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
  bucket: string;
}

/**
 * MinIO 接続設定をアプリ用サービスアカウントの環境変数から読み出す。
 * root 資格情報(MINIO_ROOT_USER/MINIO_ROOT_PASSWORD)は初期セットアップ専用であり、
 * アプリコードからは一切参照しない(§アプリ用 MinIO アクセスキーの権限最小化 参照)。
 */
export function minioConfigFromEnv(): MinioEnvConfig {
  const accessKey = process.env.MINIO_APP_ACCESS_KEY;
  if (!accessKey) {
    throw new Error("MINIO_APP_ACCESS_KEY environment variable is required but not set");
  }
  const secretKey = process.env.MINIO_APP_SECRET_KEY;
  if (!secretKey) {
    throw new Error("MINIO_APP_SECRET_KEY environment variable is required but not set");
  }
  const bucket = process.env.MINIO_BUCKET;
  if (!bucket) {
    throw new Error("MINIO_BUCKET environment variable is required but not set");
  }
  return {
    host: process.env.MINIO_HOST ?? "localhost",
    port: Number(process.env.MINIO_API_PORT ?? 9000),
    useSSL: process.env.MINIO_USE_SSL === "true",
    accessKey,
    secretKey,
    bucket,
  };
}
