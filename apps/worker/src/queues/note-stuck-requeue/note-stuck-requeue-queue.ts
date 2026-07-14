import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";
import { SCREENSHOT_ANALYSIS_QUEUE_NAME } from "@secondbrain/shared";

/** stuck 再投入バッチ自身の(BullMQ repeatable job としての)キュー名。 */
export const NOTE_STUCK_REQUEUE_QUEUE_NAME = "note-stuck-requeue";
export const NOTE_STUCK_REQUEUE_JOB_NAME = "note-stuck-requeue";
export const NOTE_STUCK_REQUEUE_SCHEDULER_ID = "note-stuck-requeue-cron";

/**
 * stuck 再投入バッチ専用の fail-fast Redis 接続オプション(§ stuck 再投入バッチ専用の
 * fail-fast Redis 接続・Codex レビュー r37 指摘 [2] 参照。apps/api/src/config/redis.config.ts
 * と同様の設定)。screenshot-analysis キューの Worker 接続(`maxRetriesPerRequest: null` が
 * BullMQ の要件上必須)とは完全に別の接続にすることで、Redis 長期停止時にコマンドが無期限に
 * キューイングされて蓄積することを防ぐ。
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

export function getFailFastRedisConnectionOptions() {
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

/**
 * stuck 再投入バッチが `getJob`/`getState`/`add` に使う、screenshot-analysis キュー名を
 * 指す専用 `Queue` インスタンス(§ stuck ノート再投入バッチ 参照。Worker 用接続とは別の
 * fail-fast 接続を使う)。NestJS provider として生成し、`OnModuleDestroy` で `close()` を
 * 呼ぶ(§ この専用 Queue の終了処理を明示する・Codex レビュー r38 指摘 [1] 参照)。`close()`
 * は複数回呼ばれても安全(冪等)。
 */
@Injectable()
export class NoteStuckRequeueScreenshotQueue implements OnModuleDestroy {
  readonly queue: Queue;
  private closed = false;

  constructor() {
    this.queue = new Queue(SCREENSHOT_ANALYSIS_QUEUE_NAME, {
      connection: getFailFastRedisConnectionOptions(),
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.queue.close();
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}
