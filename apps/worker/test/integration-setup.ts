import { Queue } from "bullmq";
import { createPool, dbConnectionOptionsFromEnv, loadRootEnv, runMigrations } from "@secondbrain/db";
// テストDBのDROP/RESETはroot資格情報を使う破壊的操作のため、パッケージのメイン
// エントリーポイントではなくテスト専用サブパスから明示的に import する
// (Codex コードレビュー r6 指摘 [D-3] への対応。packages/db/src/index.ts 参照)。
import {
  dropMariadbTestDatabase,
  resetMariadbTestDatabase,
} from "@secondbrain/db/dist/testing/reset-mariadb-database.js";
import {
  WORKER_TEST_APP_ACCESS_KEY,
  WORKER_TEST_APP_SECRET_KEY,
  WORKER_TEST_BUCKET,
  WORKER_TEST_DB_NAME,
  WORKER_TEST_POLICY_NAME,
  WORKER_TEST_REDIS_DB,
} from "./integration-constants";
import { createBucketIfMissing, removeBucketIfExists, runMinioAppPolicyScript } from "./minio-admin";

// setupFiles はテスト対象ファイルより先に完全実行される(vitest の既定動作)。ここで同期的に
// .env を読み込み、後続の非同期セットアップ(root 資格情報での DB/MinIO 操作)が
// MARIADB_ROOT_PASSWORD・MINIO_ROOT_USER・MINIO_ROOT_PASSWORD を確実に参照できるようにする
// (vitest.integration.config.ts の `test.env` による上書きは、この呼び出しより先に適用済みの
// ため、MARIADB_DATABASE 等のテスト用上書きが dotenv によって巻き戻されることはない)。
loadRootEnv();

/**
 * `apps/worker/test/screenshot-analysis.integration.spec.ts` 専用のセットアップ
 * (§ テスト方針・§ テスト分離の方針・§ テスト用 MinIO 資格情報の方針 参照)。
 */

async function resetDatabase(): Promise<void> {
  await resetMariadbTestDatabase({
    databaseName: WORKER_TEST_DB_NAME,
    grantToUser: process.env.MARIADB_USER,
  });

  const pool = createPool({ ...dbConnectionOptionsFromEnv(), database: WORKER_TEST_DB_NAME });
  try {
    await runMigrations(pool);
  } finally {
    await pool.end();
  }
}

async function resetBucket(): Promise<void> {
  await removeBucketIfExists(WORKER_TEST_BUCKET);
  await createBucketIfMissing(WORKER_TEST_BUCKET);
  await runMinioAppPolicyScript(
    "minio-app-policy.sh",
    [WORKER_TEST_BUCKET, WORKER_TEST_APP_ACCESS_KEY, WORKER_TEST_POLICY_NAME],
    WORKER_TEST_APP_SECRET_KEY,
  );
}

// 接続先を検証せずに FLUSHDB すると、環境変数の設定ミスや共有環境での実行時に無関係な
// データを全消去しうる(Codex コードレビュー r7 指摘 [A-2] への対応)。既定では
// localhost 系のホストのみ許可し、それ以外は `ALLOW_INTEGRATION_TEST_REDIS_FLUSHDB=1` の
// 明示的な opt-in が無い限り拒否する。
const ALLOWED_TEST_REDIS_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * BullMQ の `Queue` が内部で保持する ioredis 接続(`.client` getter)を経由して `FLUSHDB` する
 * (`ioredis` を新規依存として追加せず、既存の `bullmq` 依存だけで完結させる)。
 */
async function flushRedisDb(): Promise<void> {
  const host = process.env.REDIS_HOST ?? "localhost";
  if (!ALLOWED_TEST_REDIS_HOSTS.has(host) && process.env.ALLOW_INTEGRATION_TEST_REDIS_FLUSHDB !== "1") {
    throw new Error(
      `refusing to FLUSHDB against REDIS_HOST='${host}': only ${[...ALLOWED_TEST_REDIS_HOSTS].join(", ")} ` +
        "are allowed by default. Set ALLOW_INTEGRATION_TEST_REDIS_FLUSHDB=1 to override for an " +
        "explicitly provisioned test-only Redis instance.",
    );
  }
  const port = Number(process.env.REDIS_PORT ?? 6379);
  const queue = new Queue("integration-test-flush-helper", {
    connection: { host, port, db: WORKER_TEST_REDIS_DB },
  });
  try {
    const client = await queue.client;
    await client.flushdb();
  } finally {
    await queue.close();
  }
}

beforeAll(async () => {
  await resetDatabase();
  await resetBucket();
  await flushRedisDb();
}, 120_000);

afterAll(async () => {
  await dropMariadbTestDatabase(WORKER_TEST_DB_NAME);
  await runMinioAppPolicyScript(
    "minio-app-policy-cleanup.sh",
    [WORKER_TEST_BUCKET, WORKER_TEST_APP_ACCESS_KEY, WORKER_TEST_POLICY_NAME],
    WORKER_TEST_APP_SECRET_KEY,
  );
}, 120_000);
