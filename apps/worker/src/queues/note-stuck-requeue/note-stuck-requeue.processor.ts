import { Inject, Logger } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { and, asc, eq, gt, isNull, notes, or, sql, type Database } from "@secondbrain/db";
import {
  SCREENSHOT_ANALYSIS_JOB_OPTIONS,
  SCREENSHOT_ANALYSIS_QUEUE_NAME,
  screenshotAnalysisJobId,
  type ScreenshotAnalysisJobPayload,
} from "@secondbrain/shared";
import {
  MaintenanceTimeoutError,
  SanitizedMaintenanceException,
  classifyMaintenanceError,
} from "../../common/classify-maintenance-error";
import { DRIZZLE } from "../../db/db.module";
import {
  NOTE_STUCK_REQUEUE_QUEUE_NAME,
  NoteStuckRequeueScreenshotQueue,
} from "./note-stuck-requeue-queue";

/**
 * DB 操作(SELECT・UPDATE)・専用 fail-fast Redis 接続経由の BullMQ 操作(getJob・getState・add)
 * いずれも10秒のアプリケーションタイムアウトで包む(§ このアプリケーションレベルタイムアウトの
 * 適用範囲・§ 実装手順14 参照)。
 */
const OPERATION_TIMEOUT_MS = 10_000;

/**
 * 対象を一度に全件 SELECT すると、バックログが増えるほどメモリ使用量・SELECT時間が増え、
 * `max_statement_time`/アプリタイムアウトを超えた場合は1件も回収できなくなる
 * (note-purge.processor.ts の同種の対応・Codex コードレビュー r4 指摘 [A-4] への対応)。
 * id による keyset pagination で固定件数ずつ取得する。
 */
const STALE_NOTE_BATCH_SIZE = 100;
/** 1回のジョブ実行あたりの上限バッチ数(特定行が恒常的に失敗し続けた場合の無限ループ防止)。 */
const MAX_STALE_NOTE_BATCHES = 1000;

/**
 * `promiseFactory` を引数に取る(戻り値の Promise を直接受け取らない)理由:drizzle-orm の
 * クエリビルダーは `.then()` を呼ぶたびに `execute()` を再実行する遅延 thenable であり、
 * ネイティブ Promise ではない。呼び出し元の SELECT/UPDATE をそのまま渡すと、下記の
 * `.then(ok, ok)` と `Promise.race` の双方が個別に execute() を呼び、同一クエリが2回実行
 * されてしまう(generation の `+1` UPDATE 等、副作用のあるクエリでは実害が大きい。
 * apps/api の統合テストで発見した同種のバグへの対応と同じ考え方)。`promiseFactory()` の
 * 呼び出しを1回に固定し、`Promise.resolve()` でネイティブ Promise へ変換してから以降で
 * 使い回すことで、この二重実行を構造的に防ぐ。
 */
function withTimeout<T>(promiseFactory: () => Promise<T>): Promise<T> {
  const promise = Promise.resolve(promiseFactory());
  // 監視用の後始末(未処理 rejection 防止)。
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
  // 大量件数を逐次処理するバッチではタイマーとクロージャーが短時間に蓄積してしまう
  // (Codex コードレビュー r6 指摘 [A-4] への対応)。`unref()` はプロセス終了を妨げない
  // だけでタイマー自体は解放しないため、決着後に必ず `clearTimeout` する。
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

/**
 * `type='screenshot' AND status IN ('pending','processing') AND deleted_at IS NULL AND
 * updated_at < NOW() - INTERVAL 10 MINUTE`(§ stuck ノート再投入バッチ 参照)。
 */
function staleScreenshotFilter() {
  return and(
    eq(notes.type, "screenshot"),
    or(eq(notes.status, "pending"), eq(notes.status, "processing")),
    isNull(notes.deletedAt),
    sql`${notes.updatedAt} < NOW() - INTERVAL 10 MINUTE`,
  );
}

interface StaleNoteRow {
  id: string;
  processingGeneration: number;
}

const IN_FLIGHT_JOB_STATES = new Set(["waiting", "active", "delayed"]);

// stuck ノート再投入バッチ(§ stuck ノート再投入バッチ・§ 実装手順14 参照)。10分ごとの
// repeatable job(cron 10分間隔。登録は NoteStuckRequeueProducer が行う)。
@Processor(NOTE_STUCK_REQUEUE_QUEUE_NAME)
export class NoteStuckRequeueProcessor extends WorkerHost {
  private readonly logger = new Logger(NoteStuckRequeueProcessor.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly screenshotQueue: NoteStuckRequeueScreenshotQueue,
  ) {
    super();
  }

  async process(): Promise<void> {
    // requeueIfStillStale が失敗した行は次回の SELECT でも条件に一致し続けるため、id による
    // keyset pagination(前回バッチの最後の id より大きい行のみを対象にする)で
    // 成功・失敗に関わらず必ず前進させる(同一行で無限ループしない)。
    let cursor: string | null = null;

    for (let batch = 0; batch < MAX_STALE_NOTE_BATCHES; batch++) {
      // 1. バッチ全体を止める失敗: 対象 id 一覧を取得する SELECT のみが対象。
      let staleNotes: StaleNoteRow[];
      try {
        staleNotes = await withTimeout(() =>
          this.db
            .select({ id: notes.id, processingGeneration: notes.processingGeneration })
            .from(notes)
            .where(
              cursor === null
                ? staleScreenshotFilter()
                : and(staleScreenshotFilter(), gt(notes.id, cursor)),
            )
            .orderBy(asc(notes.id))
            .limit(STALE_NOTE_BATCH_SIZE),
        );
      } catch (err) {
        const sanitized = classifyMaintenanceError(err);
        this.logger.error(
          `note-stuck-requeue: failed to load stale notes: ${JSON.stringify(sanitized)}`,
        );
        throw new SanitizedMaintenanceException(sanitized);
      }

      if (staleNotes.length === 0) {
        return;
      }

      // 2. 1件の id だけをスキップする失敗: id ごとのループ内の失敗はそのループを継続する。
      for (const staleNote of staleNotes) {
        await this.requeueIfStillStale(staleNote);
      }

      cursor = staleNotes[staleNotes.length - 1].id;

      if (staleNotes.length < STALE_NOTE_BATCH_SIZE) {
        return;
      }
    }
  }

  private async requeueIfStillStale(staleNote: StaleNoteRow): Promise<void> {
    try {
      const currentJobId = screenshotAnalysisJobId(staleNote.id, staleNote.processingGeneration);
      const job = await withTimeout(() => this.screenshotQueue.queue.getJob(currentJobId));
      const state = job ? await withTimeout(() => job.getState()) : undefined;

      if (state !== undefined && IN_FLIGHT_JOB_STATES.has(state)) {
        // 処理継続中(waiting/active/delayed): DB 上は stale に見えても正常にキュー内で
        // 進行中と判断し、何もしない(誤って重複投入しない)。
        return;
      }

      // ジョブが存在しない、または completed/failed の終端状態で残存している場合はいずれも
      // 再投入対象とする(§ DB のみに基づく検出の限界 参照)。DB 側で原子的にインクリメント
      // する(JS 側で読み取った古い値を書き戻すと、他経路〔retry 等〕による並行更新を
      // 上書きしうるため)。
      //
      // この getJob/getState 確認から下記 UPDATE までの間に、ワーカーが解析を完了させて
      // completeAnalysis/failAnalysis が先に成功する競合が理論上ありうる(Codex コードレビュー
      // 2026-07-13 r4 指摘 [C-1])。しかし下記 UPDATE の WHERE 句は `staleScreenshotFilter()` を
      // ここで再評価しており、SELECT 時点で読み取った値ではなく UPDATE 実行時点の行の実際の値
      // (`status`・`updated_at`)に対して判定される。completeAnalysis/failAnalysis が先に成功して
      // いれば `status` は既に `pending`/`processing` ではなくなっているため WHERE が一致せず
      // `affectedRows` は 0 になり、下記の分岐で安全にスキップされる(`updated_at` は
      // `notes.updatedAt`(packages/db/src/schema/notes.ts)の `onUpdateNow()` により、
      // completeAnalysis/failAnalysis 自身の UPDATE 時点で自動的に現在時刻へ更新されるため、
      // 仮に status の条件を通過したとしても stale 判定〔10分以上前〕には該当しなくなる)。
      // そのため、完了済みノートが誤って pending へ巻き戻されて解析結果を上書きすることはない。
      const [updateResult] = await withTimeout(() =>
        this.db
          .update(notes)
          .set({
            status: "pending",
            processingGeneration: sql`${notes.processingGeneration} + 1`,
            updatedAt: sql`NOW()`,
          })
          .where(and(eq(notes.id, staleNote.id), staleScreenshotFilter())),
      );

      if (updateResult.affectedRows !== 1) {
        // SELECT からこの UPDATE までの間に他の要因で状態が変わった=既に回収不要と判断する。
        return;
      }

      // MariaDB の UPDATE には RETURNING 相当が無いため、更新後の新しい processingGeneration を
      // 再取得する(§ retry(ユーザー起点の再実行)の冪等性 の markPendingForRetry と同じパターン)。
      const refetched = await withTimeout(() =>
        this.db
          .select({ processingGeneration: notes.processingGeneration })
          .from(notes)
          .where(eq(notes.id, staleNote.id))
          .limit(1),
      );
      // 再取得の時点でさらに削除等が起きていれば行自体が消えている可能性があるため、
      // (TS の配列インデックスアクセスの型は要素の存在を保証しないが、実行時には空配列も
      // あり得るため)件数を明示的に確認してから読み取る。
      if (refetched.length === 0) {
        return;
      }
      const newGeneration = refetched[0].processingGeneration;

      const newJobId = screenshotAnalysisJobId(staleNote.id, newGeneration);
      const payload: ScreenshotAnalysisJobPayload = {
        noteId: staleNote.id,
        generation: newGeneration,
      };
      await withTimeout(() =>
        this.screenshotQueue.queue.add(SCREENSHOT_ANALYSIS_QUEUE_NAME, payload, {
          ...SCREENSHOT_ANALYSIS_JOB_OPTIONS,
          jobId: newJobId,
        }),
      );
    } catch (err) {
      const sanitized = classifyMaintenanceError(err);
      this.logger.warn(
        `note-stuck-requeue: skipping noteId=${staleNote.id} due to error: ${JSON.stringify(sanitized)}`,
      );
    }
  }
}
