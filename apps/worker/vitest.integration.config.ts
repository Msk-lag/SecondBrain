import { defineConfig } from "vitest/config";
import {
  WORKER_TEST_APP_ACCESS_KEY,
  WORKER_TEST_APP_SECRET_KEY,
  WORKER_TEST_BUCKET,
  WORKER_TEST_DB_NAME,
  WORKER_TEST_REDIS_DB,
} from "./test/integration-constants";

/**
 * 統合テスト専用の Vitest 設定(§ テスト方針 参照)。`test.env` で、`AppModule`(および
 * `DbModule`/`StorageModule`/BullMQ 接続オプション)が読み出す接続先の環境変数を、テストファイルの
 * import 解決より前に確定させる(apps/api/vitest.integration.config.ts と同じ理由)。
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.integration.spec.ts"],
    setupFiles: ["./test/integration-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    env: {
      MARIADB_DATABASE: WORKER_TEST_DB_NAME,
      MINIO_BUCKET: WORKER_TEST_BUCKET,
      MINIO_APP_ACCESS_KEY: WORKER_TEST_APP_ACCESS_KEY,
      MINIO_APP_SECRET_KEY: WORKER_TEST_APP_SECRET_KEY,
      REDIS_DB: String(WORKER_TEST_REDIS_DB),
    },
  },
});
