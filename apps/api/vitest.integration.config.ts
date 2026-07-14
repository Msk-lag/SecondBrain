import { defineConfig } from "vitest/config";
import {
  API_TEST_APP_ACCESS_KEY,
  API_TEST_APP_SECRET_KEY,
  API_TEST_BUCKET,
  API_TEST_DB_NAME,
  API_TEST_REDIS_DB,
} from "./test/integration-constants";

/**
 * 統合テスト専用の Vitest 設定(§ テスト方針 参照)。単体テスト用の vitest.config.ts とは
 * 対象パターンを分離する。`test.env` で `AppModule` が読み出す接続先の環境変数(DB 名・
 * MinIO バケット/資格情報・Redis DB index)を、テストファイルの import 解決(≒ AppModule の
 * モジュール評価。`BullModule.forRoot({ connection: getApiRedisConnectionOptions() })` 等が
 * import 時点で評価されるため、テストコード内の代入では手遅れになる)より前に確定させる。
 * `packages/db`/`@secondbrain/storage` 側の `loadRootEnv()` は既存の環境変数を上書きしない
 * ため、ここで設定した値がそのまま使われる。
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.e2e-spec.ts"],
    setupFiles: ["./test/integration-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    env: {
      MARIADB_DATABASE: API_TEST_DB_NAME,
      MINIO_BUCKET: API_TEST_BUCKET,
      MINIO_APP_ACCESS_KEY: API_TEST_APP_ACCESS_KEY,
      MINIO_APP_SECRET_KEY: API_TEST_APP_SECRET_KEY,
      REDIS_DB: String(API_TEST_REDIS_DB),
    },
  },
});
