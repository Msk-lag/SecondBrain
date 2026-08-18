import { Inject, Logger } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { and, asc, eq, gt, isNull, notes, sql, type Database } from "@secondbrain/db";
import {
  noteEnrichmentJobId,
  NOTE_ENRICHMENT_JOB_OPTIONS,
  NOTE_ENRICHMENT_QUEUE_NAME,
  type NoteEnrichmentJobPayload,
} from "@secondbrain/shared";
import {
  MaintenanceTimeoutError,
  SanitizedMaintenanceException,
  classifyMaintenanceError,
} from "../../common/classify-maintenance-error";
import { DRIZZLE } from "../../db/db.module";
import {
  NOTE_ENRICHMENT_REQUEUE_QUEUE_NAME,
  NoteEnrichmentRequeueTargetQueue,
} from "./note-enrichment-requeue-queue";

/**
 * DB 操作(SELECT)・専用 fail-fast Redis 接続経由の BullMQ 操作(getJob・getState・remove・add)
 * いずれも10秒のアプリケーションタイムアウトで包む(note-stuck-requeue.processor.ts と
 * 同じ方針)。
 */
const OPERATION_TIMEOUT_MS = 10_000;

/**
 * 対象を一度に全件 SELECT すると、バックログが増えるほどメモリ使用量・SELECT 時間が増える
 * (note-purge.processor.ts・note-stuck-requeue.processor.ts と同じ配慮)。id による keyset
 * pagination で固定件数ずつ取得する。
 */
const STALE_NOTE_BATCH_SIZE = 100;
/** 1回のジョブ実行あたりの上限バッチ数(特定行が恒常的に失敗し続けた場合の無限ループ防止)。 */
const MAX_STALE_NOTE_BATCHES = 1000;

/**
 * `promiseFactory` を引数に取る理由は note-stuck-requeue.processor.ts の同名ヘルパーと同じ
 * (drizzle-orm のクエリビルダーは `.then()` のたびに再実行される遅延 thenable であり、
 * 二重実行を防ぐため `promiseFactory()` の呼び出しを1回に固定する)。
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
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

/**
 * `enrichment_status = 'pending' AND deleted_at IS NULL AND updated_at < NOW() - INTERVAL
 * 1 MINUTE`(M1-4a 計画 §設計決定4「回収バッチ」・Fable 5 + Codex 独立議論 論点1 参照)。
 * 当初は10分だったが、note-enrichment-requeue.producer.ts のコメントの通り、jobId が
 * ノート単位で固定であるためこの回収バッチが主要な鮮度保証経路として機能しており、1分へ
 * 短縮して最悪ケースの遅延を縮める。リトライのバックオフ幅(5s→10s、計15秒程度)より
 * 十分大きいマージンを保っている。これ以上短くすると、連続編集中に `updated_at` が動き
 * 続けることによる自然なデバウンス効果(望ましい挙動)が弱まるため、1分を下限とする。
 */
function staleEnrichmentFilter() {
  return and(
    eq(notes.enrichmentStatus, "pending"),
    isNull(notes.deletedAt),
    sql`${notes.updatedAt} < NOW() - INTERVAL 1 MINUTE`,
  );
}

/**
 * 削除してよい(=終端状態で残存している)ジョブの状態のみを列挙する肯定形の判定
 * (Codex 再レビュー HIGH 指摘対応)。
 *
 * 設計原則: 判定は肯定形(削除してよい状態を列挙する)で書く。否定形
 * (in-flight でなければ削除する、のように「除外リストに無いものは全部削除」とする)
 * にすると、BullMQ に新しい状態(`prioritized`・`waiting-children` 等)が追加された場合や
 * 想定外の状態文字列が返った場合に、正常に待機しているジョブまで削除してしまう。
 * 特に `prioritized` ジョブを回収バッチのたびに削除・再追加すると、キュー内の順序が
 * 後退し続けて starvation を起こしうる。安全側は常に「削除しない」方向に倒す。
 */
const REMOVABLE_TERMINAL_JOB_STATES = new Set(["completed", "failed"]);

/**
 * note-enrichment 回収バッチ(M1-4a 計画 §設計決定4・Fable 5 + Codex 独立議論 論点1 参照)。
 * 1分ごとの repeatable job(cron 1分間隔。登録は NoteEnrichmentRequeueProducer が行う)。
 * note-stuck-requeue と異なり、note-enrichment には generation/attempt token による
 * fencing が無いため、DB 側で世代を進める UPDATE は行わない(決定的な jobId
 * (`noteEnrichmentJobId(noteId)`)をそのまま使い、completed/failed の終端状態で残存して
 * いる場合のみ削除してから再投入する。それ以外の非終端状態・未知の状態では何もしない。
 * 実際の書き戻しは NoteEnrichmentProcessor の条件付き UPDATE(CAS)で保護される)。
 */
@Processor(NOTE_ENRICHMENT_REQUEUE_QUEUE_NAME)
export class NoteEnrichmentRequeueProcessor extends WorkerHost {
  private readonly logger = new Logger(NoteEnrichmentRequeueProcessor.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly targetQueue: NoteEnrichmentRequeueTargetQueue,
  ) {
    super();
  }

  async process(): Promise<void> {
    // requeueIfStillStale が失敗した行は次回の SELECT でも条件に一致し続けるため、id による
    // keyset pagination(前回バッチの最後の id より大きい行のみを対象にする)で成功・失敗に
    // 関わらず必ず前進させる(同一行で無限ループしない)。
    let cursor: string | null = null;

    for (let batch = 0; batch < MAX_STALE_NOTE_BATCHES; batch++) {
      let staleNoteIds: string[];
      try {
        const rows = await withTimeout(() =>
          this.db
            .select({ id: notes.id })
            .from(notes)
            .where(
              cursor === null
                ? staleEnrichmentFilter()
                : and(staleEnrichmentFilter(), gt(notes.id, cursor)),
            )
            .orderBy(asc(notes.id))
            .limit(STALE_NOTE_BATCH_SIZE),
        );
        staleNoteIds = rows.map((row) => row.id);
      } catch (err) {
        const sanitized = classifyMaintenanceError(err);
        this.logger.error(
          `note-enrichment-requeue: failed to load stale notes: ${JSON.stringify(sanitized)}`,
        );
        throw new SanitizedMaintenanceException(sanitized);
      }

      if (staleNoteIds.length === 0) {
        return;
      }

      for (const noteId of staleNoteIds) {
        await this.requeueIfStillStale(noteId);
      }

      cursor = staleNoteIds[staleNoteIds.length - 1];

      if (staleNoteIds.length < STALE_NOTE_BATCH_SIZE) {
        return;
      }
    }
  }

  private async requeueIfStillStale(noteId: string): Promise<void> {
    try {
      const jobId = noteEnrichmentJobId(noteId);
      const job = await withTimeout(() => this.targetQueue.queue.getJob(jobId));
      const state = job ? await withTimeout(() => job.getState()) : undefined;

      // 不変条件(Fable 5 の指摘。将来この前提を崩す変更をしないこと): この in-flight 判定は
      // `noteEnrichmentJobId(noteId)` がノートごとに決定的(世代や fingerprint 等を含まず、
      // 同一ノートに対して常に同じ jobId を返す)であることに依存している。もし将来
      // jobId に世代・fingerprint を含める変更(note-stuck-requeue の
      // `screenshotAnalysisJobId(noteId, generation)` のような fencing)を行うと、この
      // getJob(jobId) は「今回投入しようとしている新しい jobId」を見ることになり、
      // 実際に active な(古い世代の)ジョブを検出できなくなる。その結果、この判定は
      // 常に「対象ジョブなし」と誤判定し、active なジョブが存在するにもかかわらず重複投入が
      // 発生する。jobId の決定性を変える場合は、この in-flight 判定ロジック自体の見直しが
      // 必須。
      if (state !== undefined && !REMOVABLE_TERMINAL_JOB_STATES.has(state)) {
        // 非終端状態(waiting/active/delayed/prioritized/waiting-children 等)、および
        // BullMQ が将来追加しうる未知の状態文字列はすべてここに含まれる。誤って重複投入
        // したり、正常に待機中のジョブを削除したりしないよう、何もせず次回の回収に委ねる。
        return;
      }

      // ここに到達するのは、ジョブが存在しない(job === undefined)か、
      // completed/failed の終端状態で残存している場合のみ。
      //
      // 終端状態で残存している場合は再投入前に明示的に削除する必要がある。
      // `removeOnComplete`/`removeOnFail` が true でも BullMQ は同一 jobId のジョブが
      // 実際に残存している間は `add()` を重複として無視する(Codex D0 レビュー HIGH 指摘:
      // 「終端ジョブは残存しない」という前提は誤りで、実際には残存した終端ジョブに対する
      // `add()` が無視され、対象ノートが `pending` のまま滞留し続けていた)。
      if (job !== undefined) {
        try {
          await withTimeout(() => job.remove());
        } catch (removeErr) {
          // 削除は他プロセスとの競合(同時に削除された等)で失敗しうる。削除失敗自体で
          // このノートの再投入処理全体を落とさず、ログのみに留めて `add()` へ進む
          // (既に他プロセスが削除済みであれば `add()` は成功するはず)。
          const sanitized = classifyMaintenanceError(removeErr);
          this.logger.warn(
            `note-enrichment-requeue: failed to remove stale job before requeue noteId=${noteId}: ${JSON.stringify(sanitized)}`,
          );
        }
      }

      const payload: NoteEnrichmentJobPayload = { noteId };
      await withTimeout(() =>
        this.targetQueue.queue.add(NOTE_ENRICHMENT_QUEUE_NAME, payload, {
          ...NOTE_ENRICHMENT_JOB_OPTIONS,
          jobId,
        }),
      );
    } catch (err) {
      const sanitized = classifyMaintenanceError(err);
      this.logger.warn(
        `note-enrichment-requeue: skipping noteId=${noteId} due to error: ${JSON.stringify(sanitized)}`,
      );
    }
  }
}
