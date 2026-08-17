import { Inject, Logger } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import type { Job } from "bullmq";
import { sql, type Database } from "@secondbrain/db";
import {
  NOTE_ENRICHMENT_QUEUE_NAME,
  noteEnrichmentJobPayloadSchema,
  type NoteEnrichmentJobPayload,
} from "@secondbrain/shared";
import { DRIZZLE } from "../../db/db.module";
import {
  buildEmbeddingInputText,
  computeEmbeddingFingerprint,
  isEmbeddingInputEmpty,
  type EmbeddingInputSnapshot,
} from "./note-enrichment-fingerprint";
import {
  OPENAI_EMBEDDING_CLIENT_FACTORY,
  OPENAI_EMBEDDING_MODEL,
  type OpenAiEmbeddingClientFactory,
} from "./openai-embedding.client";
import {
  classifyEnrichmentError,
  NoteEnrichmentDbTimeoutError,
  NoteEnrichmentInvalidPayloadError,
  toSanitizedEnrichmentError,
} from "./sanitize-enrichment-error";

/**
 * notes.id は `randomUUID()`(RFC 4122 v4。apps/api/src/modules/notes/notes.service.ts 参照)で
 * 生成される。ジョブ payload の noteId がこの形式であることを実行時に検証する(Codex 最終
 * セキュリティ監査 LOW 指摘対応)。バージョン・variant ビットまでは強制せず、8-4-4-4-12 の
 * 16進数という一般的な UUID の見た目のみを見る緩いチェックに留める(目的は「不正・旧形式の
 * job.data に対して未サニタイズの TypeError が BullMQ に保存される」ことの防止であり、
 * 厳密な v4 判定はこの目的には過剰なため)。
 */
const UUID_LIKE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * DB 操作(SELECT・UPDATE)いずれも10秒のアプリケーションタイムアウトで包む
 * (note-purge.processor.ts・note-stuck-requeue.processor.ts・screenshot-analysis.processor.ts
 * と同じ方針)。
 */
const DB_OPERATION_TIMEOUT_MS = 10_000;

/**
 * `promiseFactory` を引数に取る理由は他の queue 実装内の同名ヘルパーと同じ
 * (drizzle-orm のクエリビルダー/execute() は `.then()` のたびに再実行される遅延 thenable
 * であり、二重実行を防ぐため `promiseFactory()` の呼び出しを1回に固定する)。
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
      reject(new NoteEnrichmentDbTimeoutError());
    }, DB_OPERATION_TIMEOUT_MS);
    timer.unref?.();
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

/**
 * raw SQL(`db.execute`)で取得する行の生の形(customType の `fromDriver` を経由しない。
 * tags は JSON.parse 前の文字列のまま)。
 */
interface RawNoteSnapshotRow {
  id: string;
  title: string | null;
  summary: string | null;
  body: string | null;
  extracted_text: string | null;
  tags: string;
  updated_at: Date;
  deleted_at: Date | null;
  embedding_fingerprint: string | null;
  enrichment_status: string | null;
}

/**
 * 書き戻しの条件付き UPDATE(CAS)に使うスナップショット(M1-4a 計画 §設計決定4「書き戻しは
 * 条件付き UPDATE で保護する」参照)。`tagsRaw` は customType を経由しない生の JSON 文字列で
 * 一貫させる(WHERE 句の `tags <=> ?` 比較も同じ生の文字列を使う)。
 */
interface NoteEnrichmentSnapshot extends EmbeddingInputSnapshot {
  id: string;
  updatedAt: Date;
  embeddingFingerprint: string | null;
  enrichmentStatus: string | null;
}

/**
 * ジョブ開始時に取得したスナップショットと現在の行が一致することを保証する WHERE 断片。
 * `updated_at` の一致に加え、内容列も `<=>`(NULL 安全等価)で比較する。`updated_at` は
 * 秒精度(fsp=0)のため、同一秒内に入った PUT 更新を `updated_at` 単独では検知できない
 * (§設計決定4 参照。この列の fsp 変更は行わない方針で確定済み)。
 *
 * `deleted_at IS NULL` も CAS 条件に含める(Codex D0 レビュー MEDIUM 指摘への対応)。
 * `loadSnapshot` はスナップショット取得時点で論理削除済みの行を除外するが、OpenAI 呼び出し
 * 中に論理削除が入り、かつ `updated_at`・内容列が開始時点と同値のまま(同一秒内の削除など)
 * だった場合、この条件を含めないと CAS が成立してしまい、削除済みノートへ embedding や
 * `completed`/`failed` を書き戻してしまう。この条件により、削除済みノートへの書き戻しは
 * すべての経路(writeBackEmbedding・completeWithoutNewEmbedding・
 * completeWithClearedEmbedding・markFailed)で affected rows = 0 となり、何も書かず正常終了する
 * (既存の CAS 不成立時の挙動と同じ)。
 *
 * 内容列(`title`/`summary`/`body`/`extracted_text`/`tags`)の比較は `BINARY` でバイト単位に
 * 固定する(Codex 再レビュー HIGH 指摘への対応)。MariaDB のデフォルト照合順序は
 * case-insensitive(`utf8mb4_general_ci` 等)であり、素の `<=>` はこの列の照合順序に従って
 * 比較されるため、大文字小文字のみの変更など照合順序上「同値」とみなされる変更が誤って
 * 「一致」判定されてしまう。`updated_at` が秒精度で同一秒内の更新を検知できない以上、
 * 内容列の比較が同一秒内更新を検出する唯一のフェンスであり、それがバイト単位の一致を
 * 保証しないと、同一秒内に大文字小文字だけを変えた PUT が CAS を素通りしてしまい、古い
 * 入力から生成した fingerprint・embedding で `completed` を上書きし、PUT が設定した
 * `enrichment_status='pending'` を消してしまう(回収バッチは `pending` しか拾わないため
 * 恒久的に不整合となる)。`BINARY <col>` はバイナリ文字列へキャストしたうえでバイト単位に
 * 比較するが `<=>` の NULL 安全性(NULL 同士は等しい)はそのまま維持される。
 *
 * 代替案として「PUT ごとに確実に変化する世代番号(`content_version` 列)を CAS に使う」方式も
 * 検討した。こちらは fsp=0 の制約ごと問題が消え CAS 条件も単純化される根本対応だが、
 * スキーマ変更・migration・全書き戻し経路の修正を要し規模が大きいため、今回はスキーマ変更を
 * 伴わないバイナリ比較で対処する(将来のリファクタ候補として記録)。
 */
function snapshotCasCondition(snapshot: NoteEnrichmentSnapshot) {
  return sql`
    id = ${snapshot.id}
    AND updated_at = ${snapshot.updatedAt}
    AND deleted_at IS NULL
    AND BINARY title <=> ${snapshot.title}
    AND BINARY summary <=> ${snapshot.summary}
    AND BINARY body <=> ${snapshot.body}
    AND BINARY extracted_text <=> ${snapshot.extractedText}
    AND BINARY tags <=> ${snapshot.tagsRaw}
  `;
}

/**
 * `markFailed` 専用の CAS 条件(Codex D0 レビュー HIGH 指摘への対応)。`withDbTimeout` は
 * タイムアウト時に `db.execute` 自体をキャンセルしない(実行中のクエリはバックグラウンドで
 * 継続する)ため、`writeBackEmbedding` の UPDATE がアプリケーションタイムアウト後に遅れて
 * 成功することがある。その UPDATE は `embedding_fingerprint`・`enrichment_status` のみを
 * 変更し、`title`/`summary`/`body`/`extracted_text`/`tags`/`updated_at` には触れないため、
 * `snapshotCasCondition`(入力列と `updated_at` の一致のみを見る)だけでは、遅れて成功した
 * 書き戻しの後でも一致してしまい、`markFailed` が completed な行を誤って failed に戻して
 * しまう。ジョブ開始時スナップショットの `embedding_fingerprint`・`enrichment_status` を
 * `<=>` で追加比較し、既に completed へ遷移済みの行には一致しないようにする。
 *
 * `embedding_fingerprint`・`enrichment_status` は意図的に `BINARY` を付けず、素の `<=>` の
 * ままにしている。`embedding_fingerprint` は SHA-256 の hex 文字列(`[0-9a-f]{64}`)のみを
 * 保持し、`computeEmbeddingFingerprint` が常に小文字 hex で生成するため大文字小文字の混同が
 * 起こり得ず、`enrichment_status` も `'pending'|'completed'|'failed'` の固定 enum 相当の値
 * しか取らない(アプリケーションが大文字小文字違いの値を書き込む経路が無い)。どちらも
 * `snapshotCasCondition` の内容列(自由入力なテキスト)とは異なり照合順序に依存した誤検知の
 * 余地が無いため、バイナリ比較を強制する理由が無いと判断した。
 */
function markFailedCasCondition(snapshot: NoteEnrichmentSnapshot) {
  return sql`
    ${snapshotCasCondition(snapshot)}
    AND embedding_fingerprint <=> ${snapshot.embeddingFingerprint}
    AND enrichment_status <=> ${snapshot.enrichmentStatus}
  `;
}

/**
 * embedding 生成(enrichment)ジョブの Worker(M1-4a 計画 §設計決定4・実装手順4 参照)。
 * M1-3 の claim/fencing(processing_generation・processing_attempt_token)は使わない
 * (このジョブは screenshot-analysis と異なり外部への機密送信のキャンセルを要さない)。
 * 書き戻しはすべて `snapshotCasCondition`(`markFailed` のみ、それを拡張した
 * `markFailedCasCondition`)による条件付き UPDATE で保護する。
 */
@Processor(NOTE_ENRICHMENT_QUEUE_NAME)
export class NoteEnrichmentProcessor extends WorkerHost {
  private readonly logger = new Logger(NoteEnrichmentProcessor.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(OPENAI_EMBEDDING_CLIENT_FACTORY)
    private readonly createEmbeddingClient: OpenAiEmbeddingClientFactory,
  ) {
    super();
  }

  /**
   * BullMQ はジョブの失敗理由(`failedReason`)とスタックトレースを Redis へ永続化するため、
   * ログ出力のサニタイズ(下記 catch 内 `classifyEnrichmentError` の利用)だけでは不十分で、
   * `process()` から BullMQ へ伝播する例外そのもの(re-throw する値)もサニタイズが必要
   * (Codex 再レビュー HIGH 指摘対応。`apps/worker/src/queues/screenshot-analysis/sanitize-error.ts`
   * の `toSanitizedException` と同じ方針)。
   *
   * このメソッド全体を外側の try/catch で覆い、スナップショット取得・fingerprint 計算・
   * 早期完了処理(completeWithoutNewEmbedding・completeWithClearedEmbedding)・OpenAI 呼び出し・
   * 書き戻し・markFailed のいずれで例外が発生しても、最終的に BullMQ へ渡す例外は必ず
   * `toSanitizedEnrichmentError` を通した `SanitizedNoteEnrichmentError`(固定メッセージ + 安全な
   * category のみ、`cause` に原例外を保持しない)にする。原例外(接続情報・認証情報を含みうる)は
   * この関数のスコープ内(ログの category 判定・リトライ要否の判定)にのみ使い、外へは一切出さない。
   *
   * リトライ判定(attempts・isFinalAttempt に基づく re-throw / markFailed の使い分け)は内側の
   * try/catch(OpenAI 呼び出し〜書き戻しの経路)でこれまでどおり行う。非最終試行では原例外を
   * 内側で re-throw し、それを外側 catch がサニタイズして BullMQ へ渡す(BullMQ 側のリトライ挙動
   * 自体は変えない。渡す例外の中身のみをサニタイズする)。
   *
   * `job.data` の分解(noteId 取得)と `job.opts` の参照は、この外側 try の内側で行う(Codex
   * 最終セキュリティ監査 LOW 指摘対応)。以前はこれらが外側 try より前にあり、不正・旧形式の
   * job.data(例: noteId 欠落)に対する分解が生の TypeError を BullMQ へそのまま伝播させ得た
   * (「全経路をサニタイズ」が厳密には成立していなかった)。`resolveNoteId` で
   * `noteEnrichmentJobPayloadSchema` による構造検証と UUID 形式検証を行い、不正な場合は
   * `NoteEnrichmentInvalidPayloadError`(固定メッセージのみ)を投げる。BullMQ のリトライ挙動
   * (attempts 判定)自体は変えない — この例外も他の例外と同じく外側 catch でサニタイズされて
   * 伝播し、ジョブの attempts 設定に従って通常どおりリトライされる。
   */
  async process(job: Job<NoteEnrichmentJobPayload>): Promise<void> {
    try {
      const noteId = this.resolveNoteId(job.data);
      const attempts = job.opts.attempts ?? 1;
      const isFinalAttempt = job.attemptsMade + 1 >= attempts;

      const snapshot = await withDbTimeout(() => this.loadSnapshot(noteId));
      if (snapshot === null) {
        // ノートが存在しない、または論理削除済み(実装手順4 手順1 参照)。何もせず正常終了する。
        return;
      }

      const fingerprint = computeEmbeddingFingerprint(snapshot);

      if (snapshot.embeddingFingerprint === fingerprint) {
        // 冪等スキップ: 保存済み fingerprint と一致(内容不変)。OpenAI API を呼ばず
        // enrichment_status のみを completed へ揃える(実装手順4 手順3 参照)。
        await withDbTimeout(() => this.completeWithoutNewEmbedding(snapshot, fingerprint));
        return;
      }

      if (isEmbeddingInputEmpty(snapshot)) {
        // 連結入力が実質空(全フィールド空)へ変化した。API を呼ばず skip して completed と
        // するが、以前に生成された embedding が残っていると空内容のノートが古い埋め込みで
        // 類似候補に出続けてしまう(類似検索は embedding IS NOT NULL のみで絞るため)。
        // embedding・embedding_model を NULL 化して候補から正しく外す
        // (fingerprint 一致〔冪等スキップ〕の分岐とは異なり、こちらは内容が変化した結果の
        // 遷移であるため embedding 列も更新対象に含める)。
        await withDbTimeout(() => this.completeWithClearedEmbedding(snapshot, fingerprint));
        return;
      }

      try {
        const inputText = buildEmbeddingInputText(snapshot);
        const client = this.createEmbeddingClient();
        const embedding = await client.embed(inputText);
        await withDbTimeout(() => this.writeBackEmbedding(snapshot, embedding, fingerprint));
      } catch (err) {
        // 生の err.message / String(err) はログに出さない(OpenAI embeddings クライアント・
        // DB ドライバの例外に接続情報等が含まれる可能性を排除する。Codex 再レビュー HIGH 指摘
        // 対応・sanitize-enrichment-error.ts 参照)。固定メッセージ + 安全な分類(category)のみ
        // を出力する。
        const category = classifyEnrichmentError(err);
        if (!isFinalAttempt) {
          this.logger.warn(
            `note-enrichment attempt failed, will retry noteId=${noteId} category=${category}`,
          );
          // 原例外はここでは re-throw するが、BullMQ へ渡る前に必ず下の外側 catch で
          // サニタイズされる(この関数のスコープを出ない)。
          throw err;
        }
        this.logger.warn(
          `note-enrichment: final attempt failed noteId=${noteId} category=${category}`,
        );
        await withDbTimeout(() => this.markFailed(snapshot));
        // ビジネス上は失敗だが、BullMQ のジョブ自体は正常終了させる(re-throw しない。
        // screenshot-analysis.processor.ts と同じ方針)。markFailed 自体が失敗した場合は
        // この try に catch が無いため、そのまま外側 catch へ伝播しサニタイズされる。
      }
    } catch (err) {
      throw toSanitizedEnrichmentError(err);
    }
  }

  /**
   * `job.data`(信頼できない外部入力。BullMQ 経由で任意の JSON が来うる)を
   * `noteEnrichmentJobPayloadSchema` で検証したうえで noteId を取り出す(Codex 最終セキュリティ
   * 監査 LOW 指摘対応)。構造的に不正(noteId 欠落・型不一致・`data` が null 等)な場合、および
   * 構造は正しくても noteId が UUID 形式でない場合のいずれも `NoteEnrichmentInvalidPayloadError`
   * を投げる。
   *
   * Zod の `safeParse` が失敗時に返す `issue.message` は読み取らない・ログにも出さない
   * (通常は payload の値そのものを含まないが、念のため一切参照しないことで、仮に将来 Zod 側の
   * メッセージ仕様が変わって値を含むようになった場合の漏洩経路も塞ぐ)。呼び出し元へ渡すのは
   * 固定メッセージのみを持つこのマーカーエラーのみであり、原 payload の内容はどの経路でも
   * Error のメッセージ・スタックに含まれない。
   */
  private resolveNoteId(data: unknown): string {
    const parsed = noteEnrichmentJobPayloadSchema.safeParse(data);
    if (!parsed.success || !UUID_LIKE_PATTERN.test(parsed.data.noteId)) {
      throw new NoteEnrichmentInvalidPayloadError();
    }
    return parsed.data.noteId;
  }

  private async loadSnapshot(noteId: string): Promise<NoteEnrichmentSnapshot | null> {
    // mysql2 ドライバの `db.execute<T>()` は(scripts/poc/mariadb-vector-poc.ts と同様)
    // 型引数 T を実際の戻り値型へは反映しない既知の制約があるため、`result[0]` を
    // `unknown` 経由で明示的にキャストする(poc スクリプトと同じパターン)。
    const result = await this.db.execute<RawNoteSnapshotRow>(sql`
      SELECT id, title, summary, body, extracted_text, tags, updated_at, deleted_at,
             embedding_fingerprint, enrichment_status
        FROM notes
       WHERE id = ${noteId}
       LIMIT 1
    `);
    const rows = result[0] as unknown as RawNoteSnapshotRow[];
    const row = rows[0];
    if (!row || row.deleted_at !== null) {
      return null;
    }
    return {
      id: row.id,
      title: row.title,
      summary: row.summary,
      body: row.body,
      extractedText: row.extracted_text,
      tagsRaw: row.tags,
      updatedAt: row.updated_at,
      embeddingFingerprint: row.embedding_fingerprint,
      enrichmentStatus: row.enrichment_status,
    };
  }

  /**
   * OpenAI 呼び出しを伴う正常系の書き戻し(M1-4a 計画 §設計決定4「書き戻しは条件付き UPDATE
   * で保護する」参照)。affectedRows が0件(実行中に PUT 更新が入った)場合、MariaDB が
   * WHERE 不一致で単に0行を更新するだけであり、この関数は何もせず正常に return する
   * (enrichment_status='pending' は PUT 側が既に再設定済みのため、回収バッチまたは次回
   * enqueue が新内容で再処理し収束する)。
   */
  private async writeBackEmbedding(
    snapshot: NoteEnrichmentSnapshot,
    embedding: number[],
    fingerprint: string,
  ): Promise<void> {
    const vectorText = `[${embedding.join(",")}]`;
    const result = await this.db.execute(sql`
      UPDATE notes
         SET embedding = VEC_FromText(${vectorText}),
             embedding_model = ${OPENAI_EMBEDDING_MODEL},
             embedding_fingerprint = ${fingerprint},
             enrichment_status = 'completed'
       WHERE ${snapshotCasCondition(snapshot)}
    `);
    this.logCasMismatchIfAny("writeBackEmbedding", snapshot.id, result);
  }

  /**
   * fingerprint 一致(冪等スキップ)専用。内容が不変なので embedding 列には触れず、
   * fingerprint・enrichment_status のみを揃える。同じスナップショット条件付き UPDATE で
   * 保護する(処理中に PUT で内容が変わった場合、誤って completed で上書きしないため)。
   */
  private async completeWithoutNewEmbedding(
    snapshot: NoteEnrichmentSnapshot,
    fingerprint: string,
  ): Promise<void> {
    const result = await this.db.execute(sql`
      UPDATE notes
         SET embedding_fingerprint = ${fingerprint},
             enrichment_status = 'completed'
       WHERE ${snapshotCasCondition(snapshot)}
    `);
    this.logCasMismatchIfAny("completeWithoutNewEmbedding", snapshot.id, result);
  }

  /**
   * 入力が実質空へ変化した場合専用。過去に生成された embedding が残っていると、空内容の
   * ノートが古い埋め込みで類似候補に出続けてしまう(類似検索は `embedding IS NOT NULL` の
   * みで絞るため)。embedding・embedding_model を NULL 化して候補から正しく除外する。
   * こちらも同じスナップショット条件付き UPDATE で保護する。
   */
  private async completeWithClearedEmbedding(
    snapshot: NoteEnrichmentSnapshot,
    fingerprint: string,
  ): Promise<void> {
    const result = await this.db.execute(sql`
      UPDATE notes
         SET embedding = NULL,
             embedding_model = NULL,
             embedding_fingerprint = ${fingerprint},
             enrichment_status = 'completed'
       WHERE ${snapshotCasCondition(snapshot)}
    `);
    this.logCasMismatchIfAny("completeWithClearedEmbedding", snapshot.id, result);
  }

  /**
   * リトライ枠(attempts:3)を消化した最終失敗(M1-4a 計画 §設計決定4 参照)。利用者向け
   * 文言列は持たない(失敗理由はログのみ)。
   *
   * ジョブ開始時のスナップショット条件付き UPDATE(CAS)で保護する: これが無いと、
   * (1) ジョブAが実行中(古いスナップショット) → (2) PUT 更新が入り
   * `enrichment_status='pending'` が再設定される(同一 jobId で active のため新規 enqueue は
   * 重複抑止で入らないことがある) → (3) ジョブAが OpenAI 失敗 → 最終試行で無条件 UPDATE
   * すると `enrichment_status='failed'` が新しい `pending` を上書きしてしまい、回収バッチは
   * `pending` のみを対象とするためこの行を永久に拾えなくなる、という不整合が起こりうる
   * (コーディネーターからの指摘。§実装スコープ 参照)。affected rows = 0(実行中に PUT
   * 更新が入った)場合は何も書かず正常終了し、`enrichment_status='pending'` が維持されたまま
   * 回収バッチ・次回 enqueue が新内容で再処理して収束する(writeBackEmbedding と同じ収束方針)。
   *
   * さらに `markFailedCasCondition` により `embedding_fingerprint`・`enrichment_status` も
   * スナップショット一致を要求する(Codex D0 レビュー HIGH 指摘への対応)。`withDbTimeout` は
   * タイムアウト時に進行中の `db.execute` をキャンセルしないため、`writeBackEmbedding` の
   * UPDATE がアプリケーションタイムアウト後に遅れて成功することがある。その UPDATE は
   * 入力列・`updated_at` を変更しないため、それらだけを見る CAS では遅延成功後にも一致して
   * しまい、埋め込み保存に成功した行を誤って `failed` に戻してしまう。
   */
  private async markFailed(snapshot: NoteEnrichmentSnapshot): Promise<void> {
    const result = await this.db.execute(sql`
      UPDATE notes
         SET enrichment_status = 'failed'
       WHERE ${markFailedCasCondition(snapshot)}
    `);
    this.logCasMismatchIfAny("markFailed", snapshot.id, result);
  }

  /**
   * CAS(条件付き UPDATE)の affected rows が 0 件(=更新競合が発生し、WHERE 条件に一致する
   * 行が無かった)場合を debug ログに残す(Fable 5 + Codex 独立議論 論点1 参照)。競合自体は
   * 各 UPDATE メソッドのコメントの通り設計上想定済みで正常系として扱う(re-throw しない)が、
   * 競合の発生頻度を運用時に把握できるよう、ログのみ追加する。`result[0]` の型は mysql2
   * ドライバの `db.execute()` の戻り値であり、SELECT の行配列と同様に型引数へは反映されない
   * ため、`loadSnapshot` と同じ理由で `unknown` 経由の明示キャストを行う。
   */
  private logCasMismatchIfAny(operation: string, noteId: string, result: unknown): void {
    const [header] = result as [{ affectedRows: number }, unknown];
    if (header.affectedRows === 0) {
      this.logger.debug(
        `note-enrichment: CAS mismatch (affected rows 0, likely concurrent update) operation=${operation} noteId=${noteId}`,
      );
    }
  }
}
