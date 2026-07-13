import { Queue } from "bullmq";
import {
  createPool,
  dbConnectionOptionsFromEnv,
  loadRootEnv,
  runMigrations,
} from "@secondbrain/db";
// テストDBのDROP/RESETはroot資格情報を使う破壊的操作のため、パッケージのメイン
// エントリーポイントではなくテスト専用サブパスから明示的に import する
// (Codex コードレビュー r6 指摘 [D-3] への対応。packages/db/src/index.ts 参照)。
import {
  dropMariadbTestDatabase,
  resetMariadbTestDatabase,
} from "@secondbrain/db/dist/testing/reset-mariadb-database.js";
import {
  API_TEST_APP_ACCESS_KEY,
  API_TEST_APP_SECRET_KEY,
  API_TEST_BUCKET,
  API_TEST_CONTROL_BUCKET,
  API_TEST_DB_NAME,
  API_TEST_POLICY_NAME,
  API_TEST_REDIS_DB,
} from "./integration-constants";
import {
  createBucketIfMissing,
  removeBucketIfExists,
  runMinioAppPolicyScript,
} from "./minio-admin";

// setupFiles はテスト対象ファイル(screenshots.e2e-spec.ts)より先に完全実行される(vitest の
// 既定動作)。ここで同期的に .env を読み込むことで、後続のテストファイルが `AppModule` を静的
// import した時点(= auth.module.ts の `JwtModule.register({ secret: getRequiredJwtSecret() })`
// が評価される時点)には既に JWT_SECRET 等が process.env に反映されている状態にする
// (vitest.integration.config.ts の `test.env` による上書きは、この呼び出しより先に適用済みの
// ため、MARIADB_DATABASE 等のテスト用上書きが dotenv によって巻き戻されることはない)。
loadRootEnv();

/**
 * `apps/api/test/screenshots.e2e-spec.ts` 専用のセットアップ(§ テスト方針・
 * § テスト分離の方針・§ テスト用 MinIO 資格情報の方針 参照)。
 *
 * `vitest.integration.config.ts` の `test.env` で、`AppModule` が読み出す接続先の環境変数
 * (`MARIADB_DATABASE`・`MINIO_BUCKET`・`MINIO_APP_ACCESS_KEY`・`MINIO_APP_SECRET_KEY`・
 * `REDIS_DB`)は既にテスト専用値へ上書き済み。ここでは、それらの接続先自体を
 * `beforeAll` の時点で既知のクリーンな状態へ収束させる:
 * - DB: `DROP DATABASE IF EXISTS` → `CREATE DATABASE` → マイグレーション適用
 * - MinIO バケット(対象バケット・制御用バケットの双方): 中身ごと削除して再作成し、
 *   本番同等のバケット限定サービスアカウントを発行する
 * - Redis: 対象 DB index を `FLUSHDB`
 */

async function resetDatabase(): Promise<void> {
  loadRootEnv();
  await resetMariadbTestDatabase({
    databaseName: API_TEST_DB_NAME,
    grantToUser: process.env.MARIADB_USER,
  });

  const pool = createPool({ ...dbConnectionOptionsFromEnv(), database: API_TEST_DB_NAME });
  try {
    await runMigrations(pool);
  } finally {
    await pool.end();
  }
}

async function resetBuckets(): Promise<void> {
  await removeBucketIfExists(API_TEST_BUCKET);
  await createBucketIfMissing(API_TEST_BUCKET);
  // 本番同等のバケット限定サービスアカウント資格情報を発行する(root は StorageModule に
  // 注入しない。§ テスト用 MinIO 資格情報の方針 参照)。
  await runMinioAppPolicyScript(
    "minio-app-policy.sh",
    [API_TEST_BUCKET, API_TEST_APP_ACCESS_KEY, API_TEST_POLICY_NAME],
    API_TEST_APP_SECRET_KEY,
  );

  // 制御用バケット(§ MinIO 権限設定の smoke test 参照。Codex レビュー r24 指摘 [4] への対応:
  // このバケットも beforeAll の収束対象に含める)。
  await removeBucketIfExists(API_TEST_CONTROL_BUCKET);
  await createBucketIfMissing(API_TEST_CONTROL_BUCKET);
}

// 接続先を検証せずに FLUSHDB すると、環境変数の設定ミスや共有環境での実行時に無関係な
// データを全消去しうる(Codex コードレビュー r7 指摘 [A-2] への対応)。既定では
// localhost 系のホストのみ許可し、それ以外は `ALLOW_INTEGRATION_TEST_REDIS_FLUSHDB=1` の
// 明示的な opt-in が無い限り拒否する。
const ALLOWED_TEST_REDIS_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * BullMQ の `Queue` が内部で保持する ioredis 接続(`.client` getter)を経由して `FLUSHDB` する。
 * `ioredis` を新規依存として追加せず、既存の `bullmq` 依存だけで完結させる。
 */
async function flushRedisDb(): Promise<void> {
  const host = process.env.REDIS_HOST ?? "localhost";
  if (
    !ALLOWED_TEST_REDIS_HOSTS.has(host) &&
    process.env.ALLOW_INTEGRATION_TEST_REDIS_FLUSHDB !== "1"
  ) {
    throw new Error(
      `refusing to FLUSHDB against REDIS_HOST='${host}': only ${[...ALLOWED_TEST_REDIS_HOSTS].join(", ")} ` +
        "are allowed by default. Set ALLOW_INTEGRATION_TEST_REDIS_FLUSHDB=1 to override for an " +
        "explicitly provisioned test-only Redis instance.",
    );
  }
  const port = Number(process.env.REDIS_PORT ?? 6379);
  const queue = new Queue("integration-test-flush-helper", {
    connection: { host, port, db: API_TEST_REDIS_DB },
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
  await resetBuckets();
  await flushRedisDb();
}, 120_000);

afterAll(async () => {
  await dropMariadbTestDatabase(API_TEST_DB_NAME);
  await runMinioAppPolicyScript(
    "minio-app-policy-cleanup.sh",
    [API_TEST_BUCKET, API_TEST_APP_ACCESS_KEY, API_TEST_POLICY_NAME],
    API_TEST_APP_SECRET_KEY,
  );
  await removeBucketIfExists(API_TEST_CONTROL_BUCKET);
}, 120_000);
