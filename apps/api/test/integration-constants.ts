/**
 * apps/api の統合テスト専用の固定値(§ テスト方針・テスト分離の方針 参照)。
 * DB 名・バケット名・Redis DB index はワークスペースごとに分離済み(packages/db・apps/worker の
 * それぞれの統合テストとは別の値を使う)。
 */
export const API_TEST_DB_NAME = "secondbrain_test_api";

export const API_TEST_BUCKET = "secondbrain-test-api";
export const API_TEST_CONTROL_BUCKET = "secondbrain-test-control";
export const API_TEST_POLICY_NAME = "secondbrain-test-api-policy";
export const API_TEST_APP_ACCESS_KEY = "secondbrain-test-api-app";
// 本番の MINIO_APP_SECRET_KEY とは別の、テスト専用の固定値(ローカル使い捨て MinIO インスタンス
// 向けであり実際の秘密情報ではない)。
export const API_TEST_APP_SECRET_KEY = "secondbrain-test-api-app-secret-0001";

// 専用 Redis DB index(§ テスト分離の方針 参照。apps/worker は 3、packages/db は Redis 未使用)。
export const API_TEST_REDIS_DB = 2;
