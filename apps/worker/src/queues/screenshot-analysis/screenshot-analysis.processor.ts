import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { Inject, Logger } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import type { Job } from "bullmq";
import { and, eq, isNull, notes, or, type Database } from "@secondbrain/db";
import {
  SCREENSHOT_ANALYSIS_QUEUE_NAME,
  type ScreenshotAnalysisJobPayload,
  type ScreenshotAnalysisResult,
} from "@secondbrain/shared";
import { MinioClient } from "@secondbrain/storage";
import { DRIZZLE } from "../../db/db.module";
import { MINIO_CLIENT } from "../../storage/storage.module";
import { CLAUDE_VISION_CLIENT, ClaudeVisionClient } from "./claude-vision.client";
import { resizeForClaude } from "./resize-for-claude";
import { ImageFetchFailedError, SanitizedException, sanitizeError } from "./sanitize-error";

/**
 * claimForProcessing・loadProcessingInput・削除再確認・completeAnalysis・failAnalysis の
 * いずれも § DB クエリのハングに対する対策・§ このアプリケーションレベルタイムアウトの適用範囲・
 * § 実装手順13 のとおり10秒のアプリケーションタイムアウトで包む。
 */
const DB_OPERATION_TIMEOUT_MS = 10_000;

/**
 * `Promise.race` による有限デッドライン(§ DB クエリのハングに対する対策 参照。DB 接続プール側の
 * `max_statement_time = 8` と合わせた二重防御)。タイムアウト後に元の Promise が遅れて
 * settle しても未処理 rejection にならないよう、監視用の `.then(ok, ok)` を先に張る
 * (§ アップロード時の順序と補償・db-pool-insert-limit.ts と同じパターン)。
 */
/**
 * `promiseFactory` を引数に取る(戻り値の Promise を直接受け取らない)理由:drizzle-orm の
 * クエリビルダーは `.then()` を呼ぶたびに `execute()` を再実行する遅延 thenable であり、
 * ネイティブ Promise ではない。呼び出し元がクエリをそのまま渡すと、下記の `.then(ok, ok)` と
 * `Promise.race` の双方が個別に execute() を呼び、同一クエリが2回実行されてしまう
 * (apps/api の統合テストで発見した同種のバグへの対応と同じ考え方。§ note-purge/
 * note-stuck-requeue の withTimeout も同じ理由でこの形にしている)。`promiseFactory()` の
 * 呼び出しを1回に固定し、`Promise.resolve()` でネイティブ Promise へ変換してから以降で
 * 使い回すことで、この二重実行を構造的に防ぐ。
 */
function withDbTimeout<T>(promiseFactory: () => Promise<T>): Promise<T> {
  const promise = Promise.resolve(promiseFactory());
  promise.then(
    () => undefined,
    () => undefined,
  );
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("screenshot analysis db operation timed out"));
    }, DB_OPERATION_TIMEOUT_MS);
    timer.unref?.();
  });
  // 元の処理が先に成功しても `timeoutPromise` のタイマーはそのままでは満了まで残り続ける
  // (Codex コードレビュー r6 指摘 [A-4] への対応)。`unref()` はプロセス終了を妨げないだけで
  // タイマー自体は解放しないため、決着後に必ず `clearTimeout` する。
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

// apps/api 側のアップロード上限(10MB)に、画像処理の余地を見込んだマージンを加えた値。
// 通常の経路ではこの上限を超えることは無いが、同一キーのオブジェクトが後から差し替えられた
// 場合やストレージ側の不整合時に、際限なくメモリへ読み込んで Worker がメモリ枯渇するのを防ぐ
// (Codex コードレビュー r9 指摘 [A-3] への対応)。
const MAX_IMAGE_BUFFER_BYTES = 20 * 1024 * 1024;

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    totalBytes += buffer.length;
    if (totalBytes > MAX_IMAGE_BUFFER_BYTES) {
      stream.destroy();
      throw new Error(`image stream exceeded ${MAX_IMAGE_BUFFER_BYTES} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * claude-vision.client.ts が既にサニタイズ済みの `SanitizedException` を投げている場合は
 * そのまま使い(二重サニタイズしない)、それ以外の例外のみ `sanitizeError` に通す。
 */
function toSanitizedException(err: unknown, noteId: string): SanitizedException {
  if (err instanceof SanitizedException) {
    return err;
  }
  return new SanitizedException(sanitizeError(err, noteId));
}

/** `status IN ('pending', 'processing')` 条件(§ 世代番号によるDB書き込みの整合性保証 参照)。 */
function pendingOrProcessing() {
  return or(eq(notes.status, "pending"), eq(notes.status, "processing"));
}

interface ProcessingInput {
  imageKey: string;
  imageMimeType: string;
}

/**
 * `screenshot-analysis` キューの Worker(§ 実装手順13・§ 解析処理(ScreenshotAnalysisProcessor)の
 * 冪等な状態遷移 参照)。`concurrency: 1` を明示指定し、同一 worker プロセス内でこのキューの
 * ジョブは常に1件ずつ逐次実行される(§ 並行処理制御の前提 参照)。
 */
@Processor(SCREENSHOT_ANALYSIS_QUEUE_NAME, { concurrency: 1 })
export class ScreenshotAnalysisProcessor extends WorkerHost {
  private readonly logger = new Logger(ScreenshotAnalysisProcessor.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(MINIO_CLIENT) private readonly storage: MinioClient,
    @Inject(CLAUDE_VISION_CLIENT) private readonly claudeClient: ClaudeVisionClient,
  ) {
    super();
  }

  async process(job: Job<ScreenshotAnalysisJobPayload>): Promise<void> {
    const { noteId, generation } = job.data;
    const attempts = job.opts.attempts ?? 1;
    const isFinalAttempt = job.attemptsMade + 1 >= attempts;

    // 手順1: claimForProcessing(10秒タイムアウト)。claimForProcessing 自体が例外を
    // 投げた場合(token 未取得)は、最終試行であっても failAnalysis を呼ばずサニタイズ済み
    // エラーを re-throw する(§ claimForProcessing 自体が例外を投げた場合の最終試行分岐 参照)。
    let token: string;
    try {
      const claimed = await withDbTimeout(() => this.claimForProcessing(noteId, generation));
      if (claimed === null) {
        // 世代不一致・status 不一致・削除済みのいずれか(正常系の早期リターン)。
        return;
      }
      token = claimed;
    } catch (err) {
      const sanitized = toSanitizedException(err, noteId);
      this.logger.warn(
        `claimForProcessing failed noteId=${noteId}: ${JSON.stringify(sanitized.logDetail)}`,
      );
      throw sanitized;
    }

    try {
      // 手順2: loadProcessingInput(10秒タイムアウト)。取得失敗・タイムアウトはいずれも
      // image_fetch_failed 扱いにする(§ 実装手順13 手順2 参照)。
      const input = await this.loadProcessingInputOrThrow(noteId);

      // 手順3: MinIO から画像取得(packages/storage 側の有限タイムアウトで保護)。
      const buffer = await this.fetchImageBufferOrThrow(input.imageKey);

      // 手順4: resize-for-claude(子プロセスの30秒タイムアウトで保護)。
      const resized = await resizeForClaude({ buffer, mimeType: input.imageMimeType });

      // 手順5: 画像処理が完了した直後・Claude API 呼び出しの直前に、削除状態だけでなく
      // 現在の試行がまだ有効な claim を保持しているか(status/generation/attempt token が
      // 一致するか)も再確認する(10秒タイムアウト)。削除済み・purge済み・失効した claim
      // (BullMQ の重複実行やロック喪失後の再試行で新しい試行が既に token を更新した場合)
      // のいずれでもここで正常終了扱いにし、failAnalysis を呼ばず Claude への送信も行わない
      // (Codex コードレビュー r6 指摘 [A-2](削除)・r8 指摘 [A-1](claim 失効)への対応。
      // completeAnalysis 自体は既に CAS 条件を持つが、外部送信〔課金・機密画像の二重送信〕
      // 自体はその CAS では防げないため、送信前に再確認する)。
      const stillClaimed = await withDbTimeout(() =>
        this.isStillClaimed(noteId, generation, token),
      );
      if (!stillClaimed) {
        return;
      }

      // 手順6: Claude Vision クライアント呼び出し。
      const result = await this.claudeClient.analyze(resized, noteId);

      // 手順7: 成功時 completeAnalysis(processing+世代+token 条件付き。10秒タイムアウト)。
      await withDbTimeout(() => this.completeAnalysis(noteId, generation, token, result));
    } catch (err) {
      // 手順8: 失敗時は最終試行判定で re-throw か failAnalysis かを分岐する。
      const sanitized = toSanitizedException(err, noteId);
      if (!isFinalAttempt) {
        this.logger.warn(
          `screenshot analysis attempt failed, will retry noteId=${noteId}: ` +
            JSON.stringify(sanitized.logDetail),
        );
        throw sanitized;
      }

      try {
        await withDbTimeout(() => this.failAnalysis(noteId, generation, token, sanitized.message));
      } catch (failErr) {
        // failAnalysis 自身が例外を投げた場合の二重防御(§ 解析処理の冪等な状態遷移 参照)。
        // 元例外を re-throw せず、同じ固定分類のみを持つ安全なエラーへ変換する。
        throw toSanitizedException(failErr, noteId);
      }
      // ビジネス上は失敗だが、BullMQ のジョブ自体は正常終了させる(re-throw しない)。
    }
  }

  /**
   * § 試行単位のfencing token(attempt token) 参照。呼ばれるたびに新しい token を生成し、
   * affected rows ベースの単一 CAS UPDATE で claim する。
   */
  private async claimForProcessing(noteId: string, generation: number): Promise<string | null> {
    const token = randomUUID();
    const [result] = await this.db
      .update(notes)
      .set({ status: "processing", processingAttemptToken: token })
      .where(
        and(
          eq(notes.id, noteId),
          eq(notes.processingGeneration, generation),
          pendingOrProcessing(),
          isNull(notes.deletedAt),
        ),
      );
    return result.affectedRows === 1 ? token : null;
  }

  /**
   * job payload には noteId・generation しか無いため、MinIO 取得・Claude 入力に必要な
   * メタデータをここで取得する(Codex レビュー r19 指摘 [2] への対応)。取得失敗・タイムアウトは
   * いずれも `ImageFetchFailedError`(image_fetch_failed 扱い)へ収束させる。
   */
  private async loadProcessingInputOrThrow(noteId: string): Promise<ProcessingInput> {
    try {
      return await withDbTimeout(() => this.loadProcessingInput(noteId));
    } catch {
      throw new ImageFetchFailedError();
    }
  }

  private async loadProcessingInput(noteId: string): Promise<ProcessingInput> {
    const rows = await this.db
      .select({ imageKey: notes.imageKey, imageMimeType: notes.imageMimeType })
      .from(notes)
      .where(eq(notes.id, noteId))
      .limit(1);
    const row = rows[0];
    if (!row || !row.imageKey || !row.imageMimeType) {
      throw new Error("processing input not found");
    }
    return { imageKey: row.imageKey, imageMimeType: row.imageMimeType };
  }

  /**
   * MinIO からの画像取得(§ 外部通信タイムアウトの一貫適用 参照。`packages/storage` 側の
   * 有限タイムアウトで保護済み)。この経路の失敗は種類を問わず `image_fetch_failed` 扱いにする。
   */
  private async fetchImageBufferOrThrow(imageKey: string): Promise<Buffer> {
    try {
      const sourceStream = await this.storage.getObjectStream(imageKey);
      return await streamToBuffer(sourceStream);
    } catch {
      throw new ImageFetchFailedError();
    }
  }

  /**
   * § 削除競合時の Claude 送信キャンセル 参照。completeAnalysis/failAnalysis と同じ
   * CAS 条件(generation・attempt token・status・未削除)で行を再照会し、Claude 呼び出し
   * 直前の時点でもこの試行が claim を保持しているかを確認する。行自体が存在しない
   * (物理削除・purge済み)場合、論理削除された場合、BullMQ の重複実行やロック喪失後の
   * 再試行で別の試行が既に generation/token を更新している場合のいずれも「claim 失効」
   * として扱う(Codex コードレビュー r6 指摘 [A-2](削除の見落とし)・r8 指摘 [A-1]
   * (claim 失効の見落とし)への対応。completeAnalysis 自体の CAS は古い DB 書き込みを
   * 防ぐが、外部 API への送信〔機密画像・課金の重複〕はその CAS だけでは防げない)。
   */
  private async isStillClaimed(
    noteId: string,
    generation: number,
    token: string,
  ): Promise<boolean> {
    const rows = await this.db
      .select({ id: notes.id })
      .from(notes)
      .where(
        and(
          eq(notes.id, noteId),
          eq(notes.processingGeneration, generation),
          eq(notes.processingAttemptToken, token),
          eq(notes.status, "processing"),
          isNull(notes.deletedAt),
        ),
      )
      .limit(1);
    return rows.length === 1;
  }

  private async completeAnalysis(
    noteId: string,
    generation: number,
    token: string,
    result: ScreenshotAnalysisResult,
  ): Promise<void> {
    await this.db
      .update(notes)
      .set({
        status: "completed",
        title: result.title,
        summary: result.summary,
        tags: result.tags,
        concepts: result.concepts,
        extractedText: result.extractedText,
      })
      .where(
        and(
          eq(notes.id, noteId),
          eq(notes.processingGeneration, generation),
          eq(notes.processingAttemptToken, token),
          eq(notes.status, "processing"),
          isNull(notes.deletedAt),
        ),
      );
  }

  private async failAnalysis(
    noteId: string,
    generation: number,
    token: string,
    reason: string,
  ): Promise<void> {
    await this.db
      .update(notes)
      .set({ status: "failed", failureReason: reason })
      .where(
        and(
          eq(notes.id, noteId),
          eq(notes.processingGeneration, generation),
          eq(notes.processingAttemptToken, token),
          eq(notes.status, "processing"),
          isNull(notes.deletedAt),
        ),
      );
  }
}
