import {
  dropMariadbTestDatabase,
  resetMariadbTestDatabase,
} from "../src/testing/reset-mariadb-database.js";

/**
 * `packages/db/test/notes-migration.integration.spec.ts` 専用のセットアップ(§ テスト方針・
 * § テスト分離の方針 参照)。root 資格情報(テストセットアップ専用。アプリ実行時コードからは
 * 引き続き参照しない)を使い、`beforeAll` で対象 DB を必ずクリーンな空 DB へ収束させてから
 * (`CREATE DATABASE IF NOT EXISTS` による使い回しはしない)マイグレーション適用検証を行う。
 * MinIO・Redis・HTTP は一切関与しない、純粋な DB マイグレーションテスト。
 */
export const NOTES_MIGRATION_TEST_DB = "secondbrain_test";

beforeAll(async () => {
  await resetMariadbTestDatabase({ databaseName: NOTES_MIGRATION_TEST_DB });
}, 60_000);

afterAll(async () => {
  await dropMariadbTestDatabase(NOTES_MIGRATION_TEST_DB);
}, 60_000);
