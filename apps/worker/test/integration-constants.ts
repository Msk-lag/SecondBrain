/**
 * apps/worker の統合テスト専用の固定値(§ テスト方針・テスト分離の方針 参照)。
 * DB 名・バケット名・Redis DB index はワークスペースごとに分離済み(packages/db・apps/api の
 * それぞれの統合テストとは別の値を使う)。
 */
export const WORKER_TEST_DB_NAME = "secondbrain_test_worker";

export const WORKER_TEST_BUCKET = "secondbrain-test-worker";
export const WORKER_TEST_POLICY_NAME = "secondbrain-test-worker-policy";
export const WORKER_TEST_APP_ACCESS_KEY = "secondbrain-test-worker-app";
// 本番の MINIO_APP_SECRET_KEY とは別の、テスト専用の固定値(ローカル使い捨て MinIO インスタンス
// 向けであり実際の秘密情報ではない)。
export const WORKER_TEST_APP_SECRET_KEY = "secondbrain-test-worker-app-secret-0001";

// 専用 Redis DB index(§ テスト分離の方針 参照。apps/api は 2、packages/db は Redis 未使用)。
export const WORKER_TEST_REDIS_DB = 3;
