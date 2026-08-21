import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { sql, type Database, type NoteRelationTypeDirection } from "@secondbrain/db";
import { NoteEnrichmentDbTimeoutError } from "./sanitize-enrichment-error";
import { findRelationCandidates, type RelationCandidate } from "./relation-candidates";
import {
  isRelationJudgeErrorRetryable,
  RelationJudgeError,
  type RelationJudgeClient,
  type RelationJudgeDirection,
  type RelationJudgeResultItem,
} from "./relation-judge.client";

const logger = new Logger("RelationStage");

/**
 * ログ出力用に例外の category を解決する(Issue #70 / A-2 対応)。
 *
 * `RelationJudgeError` は分類済みの category を持つが、それ以外(DB タイムアウト・
 * `RelationStageCompletionRaceError` 等)は持たない。この関数は「ログに出す category を
 * 決める」という単一の関心事だけを担い、`err.message`・`err.stack`・`String(err)` は
 * 一切読まない方針(このファイル群のログ衛生方針。§設計決定9「ログ衛生」参照)をここへ閉じ込める。
 *
 * `runRelationStage` 内の三項演算子として直接書くと(catch 節=ネストレベル1の中にあるため)
 * sonarjs/cognitive-complexity のネストペナルティが加算され、関数全体の認知的複雑度が
 * 上限を超えてしまう。ロジック自体は単純だが、独立したモジュールレベル関数(ネストレベル0)
 * へ切り出すことでそのペナルティを避ける。呼び出し元(runRelationStage)からしか使わないため
 * export はしない。
 */
function resolveJudgeErrorCategory(err: unknown): string {
  return err instanceof RelationJudgeError ? err.category : "unknown";
}

/**
 * `note-enrichment.processor.ts` の `withDbTimeout` と同じ実装(10秒アプリケーション
 * タイムアウト)を意図的に複製している。processor.ts はこのヘルパーを export していない
 * (処理内部のプライベート関数)ため、別ファイルであるこのモジュールから再利用できない。
 * ドリフトを避けたい場合は将来共通ユーティリティへ切り出すことを検討する(スコープ外)。
 */
const DB_OPERATION_TIMEOUT_MS = 10_000;
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

/** 関係判定ステージの入力となる source ノートのスナップショット(processor.ts が
 * `loadSnapshot` で既に取得済みの内容を渡す。fingerprint 一致は手順0の再確認 SELECT が
 * 保証するため、ここで再度 DB から読み直す必要は無い)。 */
export interface RelationStageSourceContent {
  title: string | null;
  summary: string | null;
  body: string | null;
  extractedText: string | null;
}

/**
 * 手順3・4(エッジの条件付き upsert + markRelationCompleted)の affected rows 検証に失敗した
 * 場合の内部マーカー(M1-4b 計画 §設計決定5 手順4「affected rows が1でなければ例外を投げて
 * トランザクション全体を rollback する」参照)。Claude 呼び出し中に判定元ノートの内容が
 * 変わった(embedding_fingerprint が変化した、または論理削除された)ことを意味する。
 * これは Claude の応答品質とは無関係な一過性の競合であり、かつ BullMQ のリトライは
 * `process()` を最初からやり直すため次の試行は最新の内容で再計算される(retry が有効に
 * 働く)。よって `isRelationJudgeErrorRetryable` の非再試行対象(structural_invalid 等)には
 * 含めず、再試行対象として扱う(relation-stage 側で明示的に retryable 判定する)。
 */
class RelationStageCompletionRaceError extends Error {
  constructor() {
    super("relation stage completion update did not affect exactly one row");
    this.name = "RelationStageCompletionRaceError";
    Object.setPrototypeOf(this, RelationStageCompletionRaceError.prototype);
  }
}

/**
 * 関係ステージ専用の CAS 条件(M1-4b 計画 §設計決定3 参照)。既存の `snapshotCasCondition`
 * (BINARY 多列比較 + updated_at)は使わない。`embedding_fingerprint` が既に内容由来の
 * バージョントークンであるため、これだけで「判定に使った内容と DB 上の内容が一致して
 * いること」を保証できる。
 */
function relationCasCondition(noteId: string, fingerprint: string) {
  return sql`
    id = ${noteId} AND deleted_at IS NULL
    AND embedding_fingerprint = ${fingerprint}
    AND enrichment_status = 'completed'
  `;
}

function getAffectedRows(result: unknown): number {
  const [header] = result as [{ affectedRows: number }, unknown];
  return header.affectedRows;
}

interface RawRelationCasRow {
  user_id: string;
  relation_status: string | null;
  relation_fingerprint: string | null;
}

interface RelationCasRow {
  userId: string;
  relationStatus: string | null;
  relationFingerprint: string | null;
}

/** 手順0前半: 現在行を再確認する(§設計決定5 手順0)。 */
async function loadRelationCasRow(
  db: Database,
  noteId: string,
  fingerprint: string,
): Promise<RelationCasRow | null> {
  const result = await db.execute<RawRelationCasRow>(sql`
    SELECT user_id, relation_status, relation_fingerprint
      FROM notes
     WHERE ${relationCasCondition(noteId, fingerprint)}
     LIMIT 1
  `);
  const rows = result[0] as unknown as RawRelationCasRow[];
  const row = rows[0];
  if (!row) {
    return null;
  }
  return {
    userId: row.user_id,
    relationStatus: row.relation_status,
    relationFingerprint: row.relation_fingerprint,
  };
}

/** 手順0後半: `relation_status='pending', relation_fingerprint=fingerprint` を書く(同じ CAS
 * で保護)。affected rows が1なら claim 成功。 */
async function claimRelationPending(
  db: Database,
  noteId: string,
  fingerprint: string,
): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE notes
       SET relation_status = 'pending',
           relation_fingerprint = ${fingerprint},
           updated_at = updated_at
     WHERE ${relationCasCondition(noteId, fingerprint)}
  `);
  return getAffectedRows(result) === 1;
}

/**
 * 手順1(候補0件)専用。`markRelationFailed` と異なり、Claude を呼んでいない=競合以外の
 * 失敗要因が無いため、affected rows 0(claim 後に内容が変わった)でも例外にせず静かに
 * 正常終了する(何も永続化していないため rollback 対象も無い)。
 */
async function markRelationCompleted(
  db: Database,
  noteId: string,
  fingerprint: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE notes
       SET relation_status = 'completed',
           relation_fingerprint = ${fingerprint},
           updated_at = updated_at
     WHERE ${relationCasCondition(noteId, fingerprint)}
  `);
}

/**
 * 手順5(再試行対象外、または最終試行)専用。`relation_status = 'pending' AND
 * relation_fingerprint = fingerprint` を追加条件にする(このステージの claim が
 * 書いた状態からのみ failed へ遷移させる)。これが無いと、`withDbTimeout` がタイムアウト
 * 扱いにした後で手順3・4のトランザクションが遅れて成功した場合(`markFailedCasCondition`
 * が保護しているのと同種の競合)、既に `completed` へ遷移済みの行をこの markRelationFailed
 * が誤って `failed` で上書きしてしまう。追加条件によりその上書きを防ぐ(affected rows 0 で
 * 静かに no-op になる)。
 */
async function markRelationFailed(
  db: Database,
  noteId: string,
  fingerprint: string,
): Promise<void> {
  const result = await db.execute(sql`
    UPDATE notes
       SET relation_status = 'failed',
           relation_fingerprint = ${fingerprint},
           updated_at = updated_at
     WHERE ${relationCasCondition(noteId, fingerprint)}
       AND relation_status = 'pending'
       AND relation_fingerprint = ${fingerprint}
  `);
  if (getAffectedRows(result) === 0) {
    logger.debug(
      `relation stage: markRelationFailed CAS mismatch (likely concurrent update) noteId=${noteId}`,
    );
  }
}

/** DB の `type_direction` へ正規化する(§設計決定1 の a/b 変換表)。 */
function toTypeDirection(
  direction: RelationJudgeDirection,
  sourceIsNoteA: boolean,
): NoteRelationTypeDirection {
  if (direction === "none") {
    return "none";
  }
  if (sourceIsNoteA) {
    return direction === "outgoing" ? "a-to-b" : "b-to-a";
  }
  return direction === "outgoing" ? "b-to-a" : "a-to-b";
}

interface NormalizedEndpoints {
  noteAId: string;
  noteBId: string;
  sourceIsNoteA: boolean;
}

/** `note_a_id < note_b_id` になるよう並べ替える(§設計決定1)。UUID は ASCII 文字のみで
 * 構成されるため、JS の文字列比較(コードユニット順)と MariaDB の `<`(既定照合順序)の
 * 大小関係は一致する。 */
function normalizeEndpoints(sourceNoteId: string, candidateId: string): NormalizedEndpoints {
  const sourceIsNoteA = sourceNoteId < candidateId;
  return {
    noteAId: sourceIsNoteA ? sourceNoteId : candidateId,
    noteBId: sourceIsNoteA ? candidateId : sourceNoteId,
    sourceIsNoteA,
  };
}

/**
 * 手順3・4(§設計決定5・6)。edges の upsert と `markRelationCompleted` を同一トランザクション
 * で行い、completed 更新の affected rows が1でなければ例外を投げてロールバックする。
 */
async function persistRelationResults(
  db: Database,
  noteId: string,
  userId: string,
  fingerprint: string,
  candidatesById: ReadonlyMap<string, RelationCandidate>,
  results: readonly RelationJudgeResultItem[],
): Promise<void> {
  await db.transaction(async (tx) => {
    for (const result of results) {
      const candidate = candidatesById.get(result.candidateId);
      if (!candidate) {
        // judge() は候補集合に無い candidateId を response_invalid として判定失敗にするため、
        // 通常この分岐には到達しない。念のための防御として当該候補だけを無視する。
        continue;
      }

      const { noteAId, noteBId, sourceIsNoteA } = normalizeEndpoints(noteId, candidate.id);
      const typeDirection = toTypeDirection(result.direction, sourceIsNoteA);
      const noteAFingerprint = sourceIsNoteA ? fingerprint : candidate.embeddingFingerprint;
      const noteBFingerprint = sourceIsNoteA ? candidate.embeddingFingerprint : fingerprint;
      const edgeId = randomUUID();

      // §設計決定6 のエッジ upsert SQL そのもの。両端の fingerprint 一致を WHERE に含める
      // ことで、Claude 呼び出し中に候補ノートが編集された場合はこの単文が0行を返し、
      // 当該エッジだけがスキップされる(トランザクション全体は rollback しない。
      // 「自己修復」は候補側が自身の enrichment ジョブで逆向きにこの組を再判定することに
      // 委ねる)。
      await tx.execute(sql`
        INSERT INTO note_relations (
          id, user_id, note_a_id, note_b_id, source_note_id,
          relation_type, type_direction, description, relatedness,
          note_a_fingerprint, note_b_fingerprint, created_at, updated_at
        )
        SELECT ${edgeId}, ${userId}, a.id, b.id, ${noteId},
               ${result.type}, ${typeDirection}, ${result.description}, ${result.relatedness},
               a.embedding_fingerprint, b.embedding_fingerprint, NOW(), NOW()
          FROM notes a JOIN notes b
         WHERE a.id = ${noteAId} AND b.id = ${noteBId}
           AND a.deleted_at IS NULL AND b.deleted_at IS NULL
           AND a.user_id = ${userId} AND b.user_id = ${userId}
           AND a.enrichment_status = 'completed' AND b.enrichment_status = 'completed'
           AND a.embedding_fingerprint = ${noteAFingerprint} AND b.embedding_fingerprint = ${noteBFingerprint}
        ON DUPLICATE KEY UPDATE
          relation_type      = IF(note_relations.deleted_at IS NULL, VALUES(relation_type),      relation_type),
          type_direction     = IF(note_relations.deleted_at IS NULL, VALUES(type_direction),     type_direction),
          description        = IF(note_relations.deleted_at IS NULL, VALUES(description),        description),
          relatedness        = IF(note_relations.deleted_at IS NULL, VALUES(relatedness),        relatedness),
          source_note_id     = IF(note_relations.deleted_at IS NULL, VALUES(source_note_id),     source_note_id),
          note_a_fingerprint = IF(note_relations.deleted_at IS NULL, VALUES(note_a_fingerprint), note_a_fingerprint),
          note_b_fingerprint = IF(note_relations.deleted_at IS NULL, VALUES(note_b_fingerprint), note_b_fingerprint)
      `);
    }

    const completion = await tx.execute(sql`
      UPDATE notes
         SET relation_status = 'completed',
             relation_fingerprint = ${fingerprint},
             updated_at = updated_at
       WHERE ${relationCasCondition(noteId, fingerprint)}
    `);
    if (getAffectedRows(completion) !== 1) {
      // Claude 呼び出し中に判定元ノートの内容が変わった(または論理削除された)。
      // ここで例外を投げることで tx 全体(このループで挿入・更新したエッジすべてを含む)を
      // rollback する(§設計決定5 手順4・受入条件10 参照)。
      throw new RelationStageCompletionRaceError();
    }
  });
}

/**
 * 関係判定ステージ本体(M1-4b 計画 §設計決定5 参照)。`note-enrichment.processor.ts` の
 * `process()` から、embedding の書き戻し(または冪等スキップ)が CAS 成功した後にのみ
 * 呼び出される。
 *
 * 手順0・1(現在行の再確認・claim・候補取得)の DB エラーは意図的にこの関数内で捕捉しない
 * (`loadSnapshot` の DB タイムアウト等が無条件に呼び出し元へ伝播する既存の processor.ts の
 * 挙動と揃え、markRelationFailed を書かずに BullMQ のリトライへ委ねる)。この時点では
 * `relation_status` を書いていないため、終端しないまま残る状態が無い。
 *
 * 一方、**claim(`relation_status='pending'` の書き込み)に成功した後の処理は手順1も含めて
 * すべて try/catch の内側に置く**(Codex D0 レビュー HIGH 指摘への対応)。claim 済みの行は
 * 必ず `completed` か `failed` のどちらかへ終端させる必要があり、終端しないと API の
 * relationStatus が永久に `generating` になってポーリングが止まらないため。catch では再試行可否
 * (`isRelationJudgeErrorRetryable`)と `isFinalAttempt` に基づいて re-throw か
 * `markRelationFailed` かを分岐する(§設計決定5 手順5・§設計決定9「再試行方針」参照)。
 */
export async function runRelationStage(
  db: Database,
  judgeClient: RelationJudgeClient,
  noteId: string,
  fingerprint: string,
  source: RelationStageSourceContent,
  isFinalAttempt: boolean,
): Promise<void> {
  // 手順0: 現在行を再確認し、claim(pending 書き込み)する。
  //
  // ここでの DB エラーは原則そのまま伝播させ、BullMQ のリトライへ委ねる(この試行では
  // まだ `relation_status` を書いていないため、終端しないまま残る状態が無い)。
  //
  // ただし**最終試行に限り、伝播させる前に markRelationFailed を best-effort で試みる**
  // (Codex D0 レビュー HIGH 指摘への対応)。**前の**試行が claim に成功して
  // `relation_status='pending'` を書いた後に Claude が一過性エラーで落ち、その次(最終)の
  // 試行が claim へ到達する前に DB エラーで落ちると、`pending` を終端させる者が誰も
  // いなくなる。その行は enrichment_status='completed' のため回収バッチにも拾われず
  // (回収対象は `enrichment_status='pending'` のみ)、API の relationStatus は規則6で
  // 永久に `generating` となり、web がポーリングを止められない。
  //
  // `markRelationFailed` の CAS は `relation_status='pending' AND relation_fingerprint=?` を
  // 要求するため、この呼び出しは「まさにその取り残された行」だけに命中し、それ以外の状態には
  // 何もしない。失敗した場合(DB 自体が落ちている等)は握り潰し、元のエラーを伝播させる
  // 「best-effort」に留める。
  let current: RelationCasRow | null;
  try {
    current = await withDbTimeout(() => loadRelationCasRow(db, noteId, fingerprint));
    if (current === null) {
      // 行なし(内容が変わった/削除された/embedding がまだ completed でない)。
      return;
    }
    if (current.relationStatus === "completed" && current.relationFingerprint === fingerprint) {
      // 現在の内容に対する判定は既に完了している。Claude を呼ばない(冪等スキップ)。
      return;
    }

    const claimed = await withDbTimeout(() => claimRelationPending(db, noteId, fingerprint));
    if (!claimed) {
      // CAS 不成立(claim 直前に内容が変わった)。
      return;
    }
  } catch (err) {
    if (isFinalAttempt) {
      logger.warn(
        `relation stage: final attempt failed before claim, attempting to terminate a possibly stranded pending row noteId=${noteId}`,
      );
      try {
        await withDbTimeout(() => markRelationFailed(db, noteId, fingerprint));
      } catch {
        // best-effort。ここでの失敗は元のエラーを覆い隠さないよう握り潰す
        // (メッセージ・スタックも参照しない — §設計決定9「ログ衛生」)。
      }
    }
    throw err;
  }

  try {
    // 手順1: 候補取得。
    //
    // **claim(pending 書き込み)より後の処理はすべてこの try の内側に置くこと**
    // (Codex D0 レビュー HIGH 指摘への対応)。以前は手順1がこの try の外にあり、候補取得や
    // 候補0件時の markRelationCompleted が最終試行で失敗すると `relation_status='pending'` が
    // 書かれたまま終端しなかった。その行は API の relationStatus 派生で規則6(pending かつ
    // fingerprint 一致)に該当して永久に `generating` となり、web が延々とポーリングし続ける
    // (回収バッチは `enrichment_status='pending'` しか拾わないが、この行の enrichment_status は
    // `completed` のため再投入もされず、自力では復帰できない)。
    const candidates = await withDbTimeout(() =>
      findRelationCandidates(db, current.userId, noteId),
    );
    if (candidates.length === 0) {
      // 候補が無い(初回ノート等)。Claude を呼ばず completed として記録する。
      await withDbTimeout(() => markRelationCompleted(db, noteId, fingerprint));
      return;
    }

    // 手順2: Claude へ1リクエストで一括判定(応答の境界検証・正規化はクライアント内で行う)。
    const results = await judgeClient.judge(
      source,
      candidates.map((candidate) => ({
        id: candidate.id,
        title: candidate.title,
        summary: candidate.summary,
        body: candidate.body,
        extractedText: candidate.extractedText,
      })),
      noteId,
    );

    // 手順3・4: エッジの条件付き upsert + markRelationCompleted(同一トランザクション)。
    const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    await withDbTimeout(() =>
      persistRelationResults(db, noteId, current.userId, fingerprint, candidatesById, results),
    );
  } catch (err) {
    // 手順5: 再試行対象のエラーかつ非最終試行 → re-throw(processor.ts の外側 catch が
    // サニタイズして BullMQ へ渡す。BullMQ の attempts 判定・リトライ挙動自体は変えない)。
    // `RelationJudgeError` 以外(DB タイムアウト・`RelationStageCompletionRaceError` 等)は
    // `isRelationJudgeErrorRetryable` の既定により再試行対象として扱う。
    //
    // ログには `RelationJudgeError.category`(固定 enum)のみを含める(Issue #70 / A-2 対応。
    // 分類済みの category がログ出力の境界で捨てられており、Anthropic API の 401 等の原因が
    // ログから判別できなくなっていた)。解決ロジックは resolveJudgeErrorCategory 参照。
    const category = resolveJudgeErrorCategory(err);
    if (isRelationJudgeErrorRetryable(err) && !isFinalAttempt) {
      logger.warn(
        `relation stage attempt failed, will retry noteId=${noteId} category=${category}`,
      );
      throw err;
    }
    logger.warn(
      `relation stage: non-retryable or final attempt failure, marking relation_status='failed' noteId=${noteId} category=${category}`,
    );
    await withDbTimeout(() => markRelationFailed(db, noteId, fingerprint));
    // ビジネス上は失敗だが、BullMQ のジョブ自体は正常終了させる(re-throw しない。
    // note-enrichment.processor.ts の markFailed と同じ方針)。markRelationFailed 自体が
    // 失敗した場合はここに catch が無いため、そのまま呼び出し元(processor.ts)の外側 catch へ
    // 伝播しサニタイズされる。
  }
}
