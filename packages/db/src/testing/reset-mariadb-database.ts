import mysql from "mysql2/promise";
import { loadRootEnv } from "../env.js";

/**
 * 統合テスト専用の DB リセットユーティリティ(§ テスト方針・テスト分離の方針 参照)。
 * `packages/db`・`apps/api`・`apps/worker` の3つの統合テストセットアップがいずれも
 * 「root 資格情報で対象 DB を DROP → CREATE してから使う」という同一のロジックを必要とするため、
 * 重複を避けてここに集約する(§ テスト分離の方針「共通ロジックが多くなる場合は packages/db 側に
 * テストユーティリティとして切り出すことを実装時に検討する」参照)。
 *
 * root 資格情報(`MARIADB_ROOT_PASSWORD`)はテストセットアップ専用であり、アプリ実行時コードから
 * は引き続き参照しない(§ notes-migration.integration.spec.ts 節 参照)。
 */

/**
 * DB名・GRANT対象ユーザー名はバッククォート/シングルクォートで直接埋め込んで raw SQL を
 * 組み立てるため(mysql2 のプレースホルダは識別子・ユーザー名には使えない)、英数字と
 * アンダースコアのみの許可リスト形式で検証し、クォート文字を含む値でクエリ境界を脱出できない
 * ようにする(root 権限接続での任意 SQL 実行・意図しない DB の DROP を防ぐ。
 * Codex コードレビュー r3 指摘 [D-2] への対応)。
 */
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9_]+$/;

function assertSafeIdentifier(value: string, label: string): void {
  if (!SAFE_IDENTIFIER_PATTERN.test(value)) {
    throw new Error(
      `${label} には英数字とアンダースコアのみ使用できます: ${JSON.stringify(value)}`,
    );
  }
}

/**
 * 文字種の検証だけでは `secondbrain`・`mysql` 等、テスト用ではない有効な DB 名も通ってしまい、
 * 統合テスト設定の誤りや環境変数の取り違えで本番・開発 DB を root 権限で DROP しかねない
 * (Codex コードレビュー 2026-07-13 r4 指摘 [D-2] への対応)。実際に呼び出す3箇所
 * (packages/db・apps/api・apps/worker の統合テストセットアップ)はいずれも
 * `secondbrain_test`(`_worker`/`_api` 等のサフィックス含む)で命名済みのため、この接頭辞を
 * 必須にする(scripts/minio-app-policy-cleanup.sh の `secondbrain-test-` 接頭辞強制と同じ考え方)。
 */
const TEST_DATABASE_NAME_PREFIX = "secondbrain_test";

/**
 * `startsWith(TEST_DATABASE_NAME_PREFIX)` だけでは、区切り文字が無い `secondbrain_testprod`
 * のような紛らわしい非テスト用DB名まで許可してしまう(Codex コードレビュー 2026-07-13 r6
 * 指摘 [D-3] への対応)。完全一致(`secondbrain_test`本体)か、`_`区切りの子DB名
 * (`secondbrain_test_api`等)のみを許可する。
 */
function assertTestOnlyDatabaseName(databaseName: string): void {
  const isExactMatch = databaseName === TEST_DATABASE_NAME_PREFIX;
  const isUnderscoreDelimitedChild = databaseName.startsWith(`${TEST_DATABASE_NAME_PREFIX}_`);
  if (!isExactMatch && !isUnderscoreDelimitedChild) {
    throw new Error(
      `databaseName must be '${TEST_DATABASE_NAME_PREFIX}' or start with '${TEST_DATABASE_NAME_PREFIX}_' to prevent accidentally dropping a non-test database: ${JSON.stringify(databaseName)}`,
    );
  }
}

function rootConnectionConfigFromEnv() {
  loadRootEnv();
  const password = process.env.MARIADB_ROOT_PASSWORD;
  if (!password) {
    throw new Error("MARIADB_ROOT_PASSWORD environment variable is required but not set");
  }
  return {
    host: process.env.MARIADB_HOST ?? "localhost",
    port: Number(process.env.MARIADB_PORT ?? 3306),
    user: "root",
    password,
  };
}

export interface ResetMariadbTestDatabaseOptions {
  /** DROP→CREATE 対象の DB 名(ワークスペースごとに分離済み。§ テスト分離の方針 参照)。 */
  databaseName: string;
  /**
   * 再作成した DB への ALL PRIVILEGES を付与するアプリ実行時ユーザー(`MARIADB_USER` 相当)。
   * MariaDB 公式イメージの初期化は `MARIADB_DATABASE` にのみ権限を付与するため、新規に
   * 作成したテスト用 DB には別途 GRANT が必要(未指定なら GRANT 自体をスキップする)。
   */
  grantToUser?: string;
}

/**
 * 対象 DB を `DROP DATABASE IF EXISTS` → `CREATE DATABASE` で必ずクリーンな空 DB へ収束させる
 * (`CREATE DATABASE IF NOT EXISTS` による使い回しはしない。§ テスト分離の方針・
 * Codex レビュー r23 指摘 [3] 参照)。
 */
export async function resetMariadbTestDatabase(
  options: ResetMariadbTestDatabaseOptions,
): Promise<void> {
  assertSafeIdentifier(options.databaseName, "databaseName");
  assertTestOnlyDatabaseName(options.databaseName);
  if (options.grantToUser) {
    assertSafeIdentifier(options.grantToUser, "grantToUser");
  }

  const connection = await mysql.createConnection(rootConnectionConfigFromEnv());
  try {
    await connection.query(`DROP DATABASE IF EXISTS \`${options.databaseName}\``);
    await connection.query(`CREATE DATABASE \`${options.databaseName}\``);
    if (options.grantToUser) {
      await connection.query(
        `GRANT ALL PRIVILEGES ON \`${options.databaseName}\`.* TO '${options.grantToUser}'@'%'`,
      );
      await connection.query("FLUSH PRIVILEGES");
    }
  } finally {
    await connection.end();
  }
}

/** `afterAll` の後始末用(§ テスト方針 参照)。 */
export async function dropMariadbTestDatabase(databaseName: string): Promise<void> {
  assertSafeIdentifier(databaseName, "databaseName");
  assertTestOnlyDatabaseName(databaseName);

  const connection = await mysql.createConnection(rootConnectionConfigFromEnv());
  try {
    await connection.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
  } finally {
    await connection.end();
  }
}
