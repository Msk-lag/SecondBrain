import { Inject, Logger } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { and, asc, eq, gt, lt, notes, type Database } from "@secondbrain/db";
import { MinioClient } from "@secondbrain/storage";
import {
  MaintenanceTimeoutError,
  SanitizedMaintenanceException,
  classifyMaintenanceError,
} from "../../common/classify-maintenance-error";
import { DRIZZLE } from "../../db/db.module";
import { MINIO_CLIENT } from "../../storage/storage.module";

export const NOTE_PURGE_QUEUE_NAME = "note-purge";

/** 論理削除から30日経過したノートを物理削除する(§ NotePurgeModule・§ 実装手順15 参照)。 */
const RETENTION_DAYS = 30;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * 対象を一度に全件 SELECT すると、件数が増えるほどメモリ使用量・SELECT時間が増え、
 * `max_statement_time` を超えた場合は1件も purge できなくなる(Codex コードレビュー r3
 * 指摘 [A-3] への対応)。id による keyset pagination で固定件数ずつ取得する。
 */
const PURGE_BATCH_SIZE = 100;
/** 1回のジョブ実行あたりの上限バッチ数(特定行が恒常的に失敗し続けた場合の無限ループ防止)。 */
const MAX_PURGE_BATCHES = 1000;

/**
 * 対象ノートの検索 SELECT・行削除 DELETE いずれも10秒のアプリケーションタイムアウトで包む
 * (§ このアプリケーションレベルタイムアウトの適用範囲 参照)。MinIO の `deleteObject` 自体は
 * `packages/storage` 側の既定タイムアウト(15秒)で既に保護されているため、ここでは
 * 追加でラップしない。
 */
const OPERATION_TIMEOUT_MS = 10_000;

/**
 * `promiseFactory` を引数に取る(戻り値の Promise を直接受け取らない)理由:drizzle-orm の
 * クエリビルダーは `.then()` を呼ぶたびに `execute()` を再実行する遅延 thenable であり、
 * ネイティブ Promise ではない。そのため、呼び出し元の SELECT/DELETE をそのまま渡すと、
 * 下記の `.then(ok, ok)` と `Promise.race` の双方が個別に execute() を呼び、同一クエリが
 * 2回実行されてしまう(統合テストで発見)。`promiseFactory()` の呼び出しを1回に固定し、
 * `Promise.resolve()` でネイティブ Promise へ変換してから以降で使い回すことで、この
 * 二重実行を構造的に防ぐ。
 */
function withTimeout<T>(promiseFactory: () => Promise<T>): Promise<T> {
  const promise = Promise.resolve(promiseFactory());
  promise.then(
    () => undefined,
    () => undefined,
  );
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new MaintenanceTimeoutError());
    }, OPERATION_TIMEOUT_MS);
    timer.unref?.();
  });
  // 元の処理が先に成功しても `timeoutPromise` のタイマーはそのままでは満了まで残り続け、
  // 大量件数を逐次処理するバッチ(最大10万件)ではタイマーとクロージャーが短時間に
  // 蓄積してしまう(Codex コードレビュー r6 指摘 [A-4] への対応)。`unref()` はプロセス
  // 終了を妨げないだけでタイマー自体は解放しないため、決着後に必ず `clearTimeout` する。
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

interface PurgeTargetRow {
  id: string;
  imageKey: string | null;
}

/**
 * 論理削除から30日経過したノートを物理削除するバッチ(§ NotePurgeModule 参照)。毎日3時の
 * repeatable job(登録は `NotePurgeProducer` が行う)。
 */
@Processor(NOTE_PURGE_QUEUE_NAME)
export class NotePurgeProcessor extends WorkerHost {
  private readonly logger = new Logger(NotePurgeProcessor.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(MINIO_CLIENT) private readonly storage: MinioClient,
  ) {
    super();
  }

  async process(): Promise<void> {
    const cutoff = new Date(Date.now() - RETENTION_MS);
    // purgeOne が失敗した行は次回の SELECT でも条件に一致し続けるため、id による
    // keyset pagination(前回バッチの最後の id より大きい行のみを対象にする)で
    // 成功・失敗に関わらず必ず前進させる(同一行で無限ループしない)。
    let cursor: string | null = null;

    for (let batch = 0; batch < MAX_PURGE_BATCHES; batch++) {
      let targets: PurgeTargetRow[];
      try {
        targets = await withTimeout(() =>
          this.db
            .select({ id: notes.id, imageKey: notes.imageKey })
            .from(notes)
            .where(
              cursor === null
                ? lt(notes.deletedAt, cutoff)
                : and(lt(notes.deletedAt, cutoff), gt(notes.id, cursor)),
            )
            .orderBy(asc(notes.id))
            .limit(PURGE_BATCH_SIZE),
        );
      } catch (err) {
        const sanitized = classifyMaintenanceError(err);
        this.logger.error(`note-purge: failed to load purge targets: ${JSON.stringify(sanitized)}`);
        throw new SanitizedMaintenanceException(sanitized);
      }

      if (targets.length === 0) {
        return;
      }

      for (const target of targets) {
        await this.purgeOne(target);
      }

      cursor = targets[targets.length - 1].id;

      if (targets.length < PURGE_BATCH_SIZE) {
        return;
      }
    }
  }

  private async purgeOne(target: PurgeTargetRow): Promise<void> {
    try {
      if (target.imageKey) {
        // deleteObject 自体のタイムアウトは packages/storage 側の既定値(15秒)で保護される。
        await this.storage.deleteObject(target.imageKey);
      }
      await withTimeout(() => this.db.delete(notes).where(eq(notes.id, target.id)));
    } catch (err) {
      const sanitized = classifyMaintenanceError(err);
      this.logger.warn(
        `note-purge: skipping noteId=${target.id} due to error: ${JSON.stringify(sanitized)}`,
      );
    }
  }
}
