/**
 * apps/api 側の BullMQ(screenshot-analysis キューへのジョブ投入専用)Redis 接続オプション。
 * worker 側(apps/worker/src/config/redis.config.ts)はブロッキングコマンドを使う Worker
 * のため `maxRetriesPerRequest: null` を維持するが、api 側は producer(queue.add)としてのみ
 * 使うため、Redis 到達不能時に ioredis が速やかにエラーを返す fail-fast 設定にする
 * (§ apps/api: BullMQ 設定+キューモジュールの DI 公開範囲 参照。Codex レビュー r6 指摘 [1] 対応)。
 */
/**
 * `REDIS_DB` は `Number()` へ渡すだけだと `NaN`・負数・小数でも設定オブジェクトが作られ、
 * 実際の接続時に ioredis の `SELECT` エラーや再接続ループとして遅れて顕在化する
 * (Codex コードレビュー 2026-07-13 指摘 [A-3] への対応)。起動時に非負整数であることを
 * 検証し、不正なら即座に失敗させる。
 */
function parseRedisDbIndex(): number {
  const raw = process.env.REDIS_DB ?? "0";
  const db = Number(raw);
  if (!Number.isInteger(db) || db < 0) {
    throw new Error(`REDIS_DB must be a non-negative integer, got: ${raw}`);
  }
  return db;
}

export function getApiRedisConnectionOptions() {
  const rawPort = process.env.REDIS_PORT ?? "6379";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`REDIS_PORT must be a positive integer, got: ${rawPort}`);
  }

  return {
    host: process.env.REDIS_HOST ?? "localhost",
    port,
    // 統合テストが専用の Redis DB index(§ テスト方針・テスト分離の方針 参照)を使うための
    // 任意設定。未設定時は既定の DB 0(本番・通常のローカル開発と同じ挙動)。
    db: parseRedisDbIndex(),
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    commandTimeout: 3000,
  };
}
