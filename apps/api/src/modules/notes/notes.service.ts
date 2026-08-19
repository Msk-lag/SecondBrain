import { randomUUID } from "node:crypto";
import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import {
  and,
  desc,
  eq,
  isNull,
  lt,
  notes,
  or,
  sql,
  type Database,
  type Note,
  type NoteRelationTypeDirection,
  type NoteType,
} from "@secondbrain/db";
import {
  toPublicNote,
  type CreateMemoNoteRequest,
  type Note as PublicNote,
  type ListNotesQuery,
  type NoteRelationType,
  type RelatedNoteItem,
  type RelatedNotesResponse,
  type RelatedNotesStatus,
  type RelationItem,
  type RelationStatus,
  type RelationTypeDirection,
  type UpdateNoteRequest,
} from "@secondbrain/shared";
import { DRIZZLE } from "../../db/db.module";

export interface NoteListResult {
  items: PublicNote[];
  nextCursor: string | null;
}

/**
 * 公開レスポンス投影前の DB 行の型。embedding(raw VECTOR バイナリ)のみを除いた
 * 内部列込みの型(§ notes 参照クエリの列投影監査 参照。M1-4a 計画 手順5b・D0 指摘[4])。
 * declaration 出力(apps/api の tsconfig.json は declaration: true)のため、
 * NotesService の public メソッドの戻り値型としてここで export する必要がある。
 */
export type NoteRecord = Omit<Note, "embedding">;

/**
 * embedding 列(raw VECTOR バイナリ)を明示的に除外した列投影。`select().from(notes)` の
 * ような全列選択は、TypeScript 上は customType の `data: never` によって embedding への
 * アクセスが型エラーになるように見えても、実行時に発行される SQL は実際に embedding 列を
 * 含む全列を SELECT してしまう(`never` 型はクエリビルダ経由の書き込み・読み出しの型を
 * 塞ぐだけで、生成される SQL 自体は変えない)。list/findOwned はレスポンス・ログ等へ
 * 埋め込みの生バイナリが混入しないよう、この明示列リストで SELECT する
 * (D0 指摘[4]対応・M1-4a 計画 手順5b 参照)。
 */
const NOTE_COLUMNS = {
  id: notes.id,
  userId: notes.userId,
  type: notes.type,
  title: notes.title,
  body: notes.body,
  summary: notes.summary,
  tags: notes.tags,
  status: notes.status,
  failureReason: notes.failureReason,
  imageKey: notes.imageKey,
  imageMimeType: notes.imageMimeType,
  concepts: notes.concepts,
  extractedText: notes.extractedText,
  deletedAt: notes.deletedAt,
  processingGeneration: notes.processingGeneration,
  processingAttemptToken: notes.processingAttemptToken,
  embeddingModel: notes.embeddingModel,
  embeddingFingerprint: notes.embeddingFingerprint,
  enrichmentStatus: notes.enrichmentStatus,
  // 関係判定ステージの状態2列(M1-4b §設計決定2 参照)。findRelated の relationStatus 派生
  // (toRelationStatus)が読む。DB 生値は公開レスポンスへそのまま出さない
  // (toRelatedStatus と同じ規律)。
  relationStatus: notes.relationStatus,
  relationFingerprint: notes.relationFingerprint,
  createdAt: notes.createdAt,
  updatedAt: notes.updatedAt,
} as const;

// 類似候補探索(GET /notes/:id/related)の設定値(M1-4a §設計決定3 参照)。
const RELATED_NOTES_LIMIT = 5;
const EXCERPT_MAX_LENGTH = 120;

interface RelatedNoteRawRow {
  id: string;
  title: string | null;
  type: NoteType;
  summary: string | null;
  body: string | null;
  extractedText: string | null;
  distance: number;
}

/**
 * `GET /notes/:id/related` の `relations`(確定エッジ)取得 SQL の生行(M1-4b §設計決定10 参照)。
 * noteAId/noteBId は「詳細画面のノートが a/b どちらの役割か」を JS 側で判定する
 * (toApiTypeDirection)ために保持する。other.* は相手ノートの表示用列(excerpt 生成含む)、
 * nr.* はエッジ本体の列。relatedness は decimal(3,2) 列のため mysql2 既定設定
 * (decimalNumbers 未指定)では文字列で返る点に注意(toRelationItem で Number() へ変換する)。
 */
interface RelationRawRow {
  noteAId: string;
  noteBId: string;
  otherId: string;
  title: string | null;
  type: NoteType;
  summary: string | null;
  body: string | null;
  extractedText: string | null;
  relationType: string;
  typeDirection: NoteRelationTypeDirection;
  description: string;
  relatedness: string;
}

/**
 * summary → body → extracted_text の優先順で最初に非空の値を採用し、
 * EXCERPT_MAX_LENGTH を超える場合は末尾を省略記号で切り詰める
 * (計画 §担当スコープ3 参照。apps/web の getDisplayTitle と同じ「trim→slice→…」方針)。
 * `RelatedNoteRawRow`(similar 側)・`RelationRawRow`(relations 側)の両方から呼べるよう、
 * 必要な3列のみを構造的に受け取る(M1-4b 計画 §(d) 参照。既存関数を再利用)。
 */
function buildExcerpt(row: {
  summary: string | null;
  body: string | null;
  extractedText: string | null;
}): string | null {
  const candidates = [row.summary, row.body, row.extractedText];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) {
      return trimmed.length <= EXCERPT_MAX_LENGTH
        ? trimmed
        : `${trimmed.slice(0, EXCERPT_MAX_LENGTH)}…`;
    }
  }
  return null;
}

function toRelatedNoteItem(row: RelatedNoteRawRow): RelatedNoteItem {
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    excerpt: buildExcerpt(row),
    distance: row.distance,
  };
}

/**
 * DB の `type_direction`(a/b 正規化上の役割基準)を、詳細画面のノート視点
 * (`outgoing`/`incoming`/`none`)へ変換する(M1-4b §設計決定1 の a/b エンコード表の逆変換。
 * `packages/shared/src/contracts/notes.ts` の `relationTypeDirectionSchema` コメントの変換表と
 * 同一)。**source_note_id には依存しない**(閲覧ノートが note_a か note_b かのみで決まる)。
 * 純関数として切り出し、spec で4分岐(a-to-b×viewedIsA true/false、b-to-a×同様。none は
 * viewedIsA を問わず none)を全て検証する(M1-4b 計画 §(c) 参照)。
 *
 * | 閲覧ノートが | DB | API |
 * |---|---|---|
 * | note_a | a-to-b | outgoing |
 * | note_a | b-to-a | incoming |
 * | note_b | a-to-b | incoming |
 * | note_b | b-to-a | outgoing |
 * | — | none | none |
 */
export function toApiTypeDirection(
  dbDirection: NoteRelationTypeDirection,
  viewedIsA: boolean,
): RelationTypeDirection {
  if (dbDirection === "none") {
    return "none";
  }
  if (viewedIsA) {
    return dbDirection === "a-to-b" ? "outgoing" : "incoming";
  }
  return dbDirection === "a-to-b" ? "incoming" : "outgoing";
}

/**
 * `note_relations` の生行1件を、詳細画面のノート視点の `RelationItem` へ変換する
 * (M1-4b §設計決定10 参照)。`viewedNoteId` と `row.noteAId` の一致で閲覧ノートが note_a/note_b
 * どちらかを判定し(source_note_id は使わない)、`toApiTypeDirection` へ渡す。excerpt は
 * similar 側(`toRelatedNoteItem`)と同じ `buildExcerpt` を再利用する(M1-4b 計画 §(d) 参照)。
 * `relationType` は DB 側(worker の応答境界検証)で既に7値固定語彙へ正規化済みのため、
 * ここでは再検証せずそのまま公開型へキャストする。
 */
function toRelationItem(row: RelationRawRow, viewedNoteId: string): RelationItem {
  const viewedIsA = row.noteAId === viewedNoteId;
  return {
    id: row.otherId,
    title: row.title,
    type: row.type,
    excerpt: buildExcerpt(row),
    relationType: row.relationType as NoteRelationType,
    typeDirection: toApiTypeDirection(row.typeDirection, viewedIsA),
    description: row.description,
    // decimal(3,2) は mysql2 既定設定では文字列で返る(RelationRawRow のコメント参照)。
    relatedness: Number(row.relatedness),
  };
}

/**
 * DB の `enrichment_status`(pending/completed/failed/NULL)を、related API が公開する
 * アプリケーション概念(generating/ready/failed)へ変換する(Fable 5 + Codex 独立議論 論点2 で
 * 確定。§relatedNotesStatusSchema 参照)。DB 生値をそのまま公開しない。
 *
 * NULL は「M1-4a 以前に作られた旧データ / enrichment 対象外」を表し、無条件に "generating" へ
 * マップしてはならない(実 DB には screenshot ノートの解析(notes.status)自体が failed で
 * enrichment が永遠に始まらない行が実在する。これを "generating" にするとクライアントの
 * ポーリングが無限に続いてしまう)。判別不能なケースは必ず終端状態(ready/failed)へ倒す
 * (ポーリングの fail-safe は「止まる」方向。停止して空表示のまま固まるより安全)。
 */
function toRelatedStatus(
  target: Pick<NoteRecord, "enrichmentStatus" | "status">,
): RelatedNotesStatus {
  switch (target.enrichmentStatus) {
    case "pending":
      return "generating";
    case "completed":
      return "ready";
    case "failed":
      return "failed";
    case null:
    default:
      // enrichment_status が NULL の場合、screenshot ノートの解析状態(notes.status)から
      // 推定する。解析中(pending/processing)はまだ enrichment が始まっていないだけなので
      // "generating" へ倒すが、解析自体が失敗した行は enrichment が永遠に始まらないため
      // "failed"(終端)へ倒す。解析 completed は本来 enrichment_status も非 NULL のはずだが
      // (原則発生しない)、防御的に "ready"(終端)へ倒す。
      switch (target.status) {
        case "pending":
        case "processing":
          return "generating";
        case "failed":
          return "failed";
        case "completed":
        default:
          return "ready";
      }
  }
}

/**
 * DB の `relation_status`/`relation_fingerprint`(pending/completed/failed/NULL + fingerprint)を、
 * related API が公開するアプリケーション概念 `relationStatus` へ変換する(M1-4b §設計決定10・
 * `packages/shared/src/contracts/notes.ts` の `relationStatusSchema` コメントの7規則表と同一。
 * **上から順に**評価し、最初に一致した規則の結果を返す)。DB 生値は公開しない
 * (`toRelatedStatus` と同じ規律)。
 *
 * `status`(埋め込み・類似検索の可用性。`toRelatedStatus` の戻り値)を第2引数に取る。
 * 規則1・2はこの `status` のみで決まり、規則3以降で初めて関係判定固有の2列を見る。
 * 純関数として切り出し、spec で7規則すべてを個別に検証する(M1-4b 計画 §(b) 参照)。
 */
export function toRelationStatus(
  target: Pick<NoteRecord, "relationStatus" | "relationFingerprint" | "embeddingFingerprint">,
  status: RelatedNotesStatus,
): RelationStatus {
  // 規則1: 埋め込みが生成中 → 関係判定も継続(embedding 完了後に関係判定が続くため)。
  if (status === "generating") {
    return "generating";
  }
  // 規則2: 埋め込みが失敗 → 関係判定は永久に走らないため終端の failed(ここが重要。旧実装は
  // status !== 'ready' を一括で generating にしていたためポーリングが止まらなかった)。
  if (status === "failed") {
    return "failed";
  }
  // ここに到達するのは status === 'ready'(埋め込み確定済み)の場合のみ。

  // 規則3: 一度も判定されておらず投入予定も無い(M1-4a 期の既存ノート)。
  if (target.relationStatus === null && target.relationFingerprint === null) {
    return "not_started";
  }

  // fingerprint 一致 = 現在の内容に対する判定(試行 or 完了)であること。
  const fingerprintMatches =
    target.relationFingerprint !== null &&
    target.relationFingerprint === target.embeddingFingerprint;

  // 規則4: 現在の内容に対する判定が完了(終端)。
  if (target.relationStatus === "completed" && fingerprintMatches) {
    return "ready";
  }
  // 規則5: 現在の内容に対する判定が失敗(終端。relation_fingerprint は「最後に試行した」値の
  // ため、これが成立するのは今の内容で判定して失敗した場合のみ)。
  if (target.relationStatus === "failed" && fingerprintMatches) {
    return "failed";
  }
  // 規則6: 現在の内容を判定中(継続)。
  if (target.relationStatus === "pending" && fingerprintMatches) {
    return "generating";
  }
  // 規則7: 上記いずれにも該当しない = fingerprint 不一致(内容が変わっており、現在の内容に
  // 対する判定がこれから走る。status を問わない)。
  return "generating";
}

export type MarkPendingForRetryResult =
  "not_found" | "not_retryable" | { note: PublicNote; generation: number };

interface Cursor {
  createdAt: string;
  id: string;
}

function encodeCursor(note: Pick<Note, "createdAt" | "id">): string {
  const payload: Cursor = { createdAt: note.createdAt.toISOString(), id: note.id };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new BadRequestException("cursor が不正です。");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Cursor).id !== "string" ||
    (parsed as Cursor).id.length === 0 ||
    typeof (parsed as Cursor).createdAt !== "string" ||
    Number.isNaN(new Date((parsed as Cursor).createdAt).getTime())
  ) {
    throw new BadRequestException("cursor が不正です。");
  }
  return parsed as Cursor;
}

const SCREENSHOT_BODY_EDIT_REJECTED_MESSAGE = "スクショノートの本文は編集できません。";
const SCREENSHOT_FIELDS_LOCKED_MESSAGE =
  "AI解析が完了するまでタイトル・要約・タグは編集できません。";

@Injectable()
export class NotesService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async list(userId: string, query: ListNotesQuery): Promise<NoteListResult> {
    const cursorFilter = query.cursor ? decodeCursor(query.cursor) : null;
    const baseFilter = and(eq(notes.userId, userId), isNull(notes.deletedAt));
    const whereClause = cursorFilter
      ? and(
          baseFilter,
          or(
            lt(notes.createdAt, new Date(cursorFilter.createdAt)),
            and(
              eq(notes.createdAt, new Date(cursorFilter.createdAt)),
              lt(notes.id, cursorFilter.id),
            ),
          ),
        )
      : baseFilter;

    const rows = await this.db
      .select(NOTE_COLUMNS)
      .from(notes)
      .where(whereClause)
      .orderBy(desc(notes.createdAt), desc(notes.id))
      .limit(query.limit + 1);

    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;
    const last = items[items.length - 1];
    const nextCursor = hasMore && last ? encodeCursor(last) : null;
    return { items: items.map((row) => toPublicNote(row)), nextCursor };
  }

  /**
   * 存在確認+所有権確認+論理削除済み除外を1クエリで行う。get/update/delete/retry の
   * 404 判定・screenshot 画像配信の所有権確認(ScreenshotsController)はすべてこれに
   * 一本化し、MySQL の affected rows(no-op 更新で 0 になり得る)には依存しない。
   * 内部列(imageKey 等)を含む DB 行をそのまま返す(公開レスポンスへの投影は呼び出し側の
   * 責務。§ 公開レスポンスからの内部列除外(response projection) 参照)。
   */
  async findOwned(userId: string, id: string): Promise<NoteRecord | null> {
    const rows = await this.db
      .select(NOTE_COLUMNS)
      .from(notes)
      .where(and(eq(notes.id, id), eq(notes.userId, userId), isNull(notes.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * memo ノート作成(§担当スコープ2 (a) 参照)。`enrichment_status='pending'` を insert 時に
   * 直接書き込むことで、fail-closed の投入順序(DB 書き込み → enqueue)を1文で満たす
   * (呼び出し元の Controller が insert 成功後に enrichment ジョブを投入する)。
   */
  async create(userId: string, input: CreateMemoNoteRequest): Promise<PublicNote> {
    const id = randomUUID();
    await this.db.insert(notes).values({
      id,
      userId,
      type: "memo",
      title: input.title ?? null,
      body: input.body,
      summary: null,
      tags: [],
      // concepts は DEFAULT の無い NOT NULL 列のため明示的に insert する
      // (§ memo ノート作成時の concepts 初期値 参照。Codex レビュー r3 指摘 [1])。
      concepts: [],
      enrichmentStatus: "pending",
    });
    const created = await this.findOwned(userId, id);
    if (!created) {
      throw new Error("ノート作成直後の取得に失敗しました");
    }
    return toPublicNote(created);
  }

  async update(userId: string, id: string, patch: UpdateNoteRequest): Promise<PublicNote | null> {
    const existing = await this.findOwned(userId, id);
    if (!existing) {
      return null;
    }

    if (existing.type === "screenshot" && patch.body !== undefined) {
      throw new BadRequestException(SCREENSHOT_BODY_EDIT_REJECTED_MESSAGE);
    }
    const editsAiManagedFields =
      patch.title !== undefined || patch.summary !== undefined || patch.tags !== undefined;
    if (existing.type === "screenshot" && existing.status !== "completed" && editsAiManagedFields) {
      throw new BadRequestException(SCREENSHOT_FIELDS_LOCKED_MESSAGE);
    }

    // 更新対象フィールドが1つも無い場合(空の PATCH)、drizzle の `.set({})` は SET 句が
    // 空の不正な UPDATE 文になり DB 側のエラーになる。更新対象が無いので DB へは書き込まず
    // 現在の値をそのまま返す(Codex コードレビュー r1 指摘 [A-1] への対応)。
    if (Object.keys(patch).length === 0) {
      return toPublicNote(existing);
    }

    // 更新対象フィールド(title/body/summary/tags)は enrichment の入力そのものであるため、
    // 内容変更の有無を問わず enrichment_status='pending' を同一 UPDATE 文で書き込む
    // (§担当スコープ2 (c) 参照。fail-closed の投入順序: この書き込みが確定してから
    // Controller が enqueue する。fingerprint 一致時は worker 側でスキップされる)。
    const [result] = await this.db
      .update(notes)
      .set({ ...patch, enrichmentStatus: "pending" })
      .where(and(eq(notes.id, id), eq(notes.userId, userId), isNull(notes.deletedAt)));

    if (result.affectedRows === 0) {
      // 同値更新(no-op)による 0 件か、確認から UPDATE までの間に論理削除されたことによる
      // 0 件かを再確認で判別する(§ NotesService.update の read-check-write 競合・
      // Codex レビュー r24 指摘 [3]・r25 指摘 [1] 参照)。
      const current = await this.findOwned(userId, id);
      return current ? toPublicNote(current) : null;
    }

    const updated = await this.findOwned(userId, id);
    return updated ? toPublicNote(updated) : null;
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const existing = await this.findOwned(userId, id);
    if (!existing) {
      return false;
    }
    await this.db
      .update(notes)
      .set({ deletedAt: new Date() })
      .where(and(eq(notes.id, id), eq(notes.userId, userId)));
    return true;
  }

  /**
   * ユーザー起点の再実行(§ retry(ユーザー起点の再実行)の冪等性 参照)。
   * `status !== "failed"` の場合・確認から UPDATE までの間に他リクエストが先に retry
   * した/論理削除された場合はいずれも "not_retryable" を返す(並行 retry 時に二重投入しない)。
   */
  async markPendingForRetry(userId: string, id: string): Promise<MarkPendingForRetryResult> {
    const existing = await this.findOwned(userId, id);
    if (!existing) {
      return "not_found";
    }
    if (existing.status !== "failed") {
      return "not_retryable";
    }

    const [result] = await this.db
      .update(notes)
      .set({
        status: "pending",
        failureReason: null,
        processingGeneration: sql`${notes.processingGeneration} + 1`,
      })
      .where(
        and(
          eq(notes.id, id),
          eq(notes.userId, userId),
          eq(notes.status, "failed"),
          isNull(notes.deletedAt),
        ),
      );

    if (result.affectedRows === 0) {
      return "not_retryable";
    }

    const updated = await this.findOwned(userId, id);
    if (!updated) {
      return "not_retryable";
    }
    return { note: toPublicNote(updated), generation: updated.processingGeneration };
  }

  /**
   * 意味的に近い過去ノートの類似候補探索(GET /notes/:id/related。M1-4a §設計決定3 参照)。
   * 戻り値 null は呼び出し元(Controller)が 404 と解釈する(既存の404方針を踏襲。
   * 存在しない/他ユーザー所有/論理削除済みを区別しない)。
   *
   * レスポンスに `status`(generating/ready/failed)を含む(Fable 5 + Codex 独立議論 論点2 で
   * 確定。§relatedNotesStatusSchema 参照)。埋め込みは非同期生成のため、保存直後は
   * `similar` が空配列になるが、`status` が無いと「生成中」か「生成済みだが類似なし」かを
   * クライアントが区別できず、永久に空表示のままになってしまう。
   *
   * **status と類似検索結果の一貫性(楽観的検証。Codex 再レビュー HIGH 指摘対応)**:
   * `findOwned`(status 取得)と類似検索(`db.execute`)は別クエリであり同一トランザクションに
   * 含まれないため、「status=completed を先に読む → 直後に PUT で body が変わり
   * enrichment_status='pending' へ遷移(embedding 列自体は worker が新しい embedding を
   * 書き戻すまで更新されない)→ 類似検索は更新前の古い embedding を使う → レスポンスの
   * status は ready のまま」というレースが起こり得る。これを防ぐため、類似検索の実行後に
   * 対象ノートの status を再読み取りし、最初に観測した status と異なっていれば
   * (=検索の実行中に対象ノートの状態が変化した=検索結果が古いスナップショットに基づく
   * 可能性がある)結果を確定させず `generating` を返してポーリングを継続させる
   * (トランザクションで囲む方式・単一クエリに統合する方式も検討したが、追加クエリ1回で
   * 完結しトランザクション管理も不要なこの方式を採用した。詳細は実装時の報告を参照)。
   *
   * この楽観的検証には ABA 問題の穴がある(検索中に `completed → pending → completed` と
   * 一巡すると前後の status が同じになり変化を検知できない)。Codex 最終セキュリティ監査
   * MEDIUM 指摘への対応として、status が `failed` の場合は類似検索自体を行わず空配列を返す
   * ように変更した(以前の「failed でも既存 embedding があれば返す」という判断を覆した)。
   * ABA 問題の完全解決(単調増加する世代番号等)はスコープ外。詳細は下記の分岐のコメントを
   * 参照。
   */
  async findRelated(userId: string, id: string): Promise<RelatedNotesResponse | null> {
    const target = await this.findOwned(userId, id);
    if (!target) {
      return null;
    }

    // ↑ status/embeddingFingerprint/relationStatus/relationFingerprint はすべてこの
    // findOwned 1回で読む(M1-4b §設計決定10「読み取り順序の不変条件」参照)。類似検索が
    // 終わった後、下記の再読み取りでこの値と比較する(このメソッド冒頭のコメント参照)。
    const status = toRelatedStatus(target);
    // relationStatus は status(埋め込みの可用性)と関係判定固有の2列から派生する
    // (toRelationStatus の7規則。§(b) 参照)。この時点の target(最初の読み取り)を使う。
    const relationStatus = toRelationStatus(target, status);

    // relations(確定エッジ)は generating/failed/ready のいずれの分岐でも取得する
    // (M1-4b §設計決定10)。永続化されたエッジは embedding 非依存の確定事実であり、
    // 「古い embedding による距離計算結果を確定表示しない」という早期 return の理由は
    // similar(embedding 依存の類似検索)にのみ当てはまるため。
    const relations = await this.fetchRelations(userId, id);

    if (status === "generating" || status === "failed") {
      // 生成中(generating)は候補が存在し得ない(embedding 未確定)ため、無駄なフルスキャンを
      // 避けて即座に空配列を返す(ポーリング中の無駄なクエリを避ける)。
      //
      // failed も類似検索を行わず空配列を返す(Codex 最終セキュリティ監査 MEDIUM 指摘対応。
      // ABA 問題への対処)。**以前は「failed でも既存 embedding があれば類似候補を返す
      // (隠すより有益)」という判断だったが、今回の指摘によりこれを覆す**: failed 時に
      // 残存する embedding は「生成に失敗した=更新後の内容を反映していない古いもの」であり、
      // 利用者には「古い内容に基づく類似結果」だと分からないまま確定表示されてしまう。空配列に
      // して「生成できませんでした」とだけ伝えるほうが誠実、という判断による。
      //
      // 併せて、下記 SQL の target サブクエリにも `enrichment_status = 'completed'` 条件を
      // 追加した。対象ノートの embedding が確定済み(completed)の場合のみ検索対象にすることで、
      // この早期 return と合わせて「古い embedding が使われる経路」を二重に塞ぐ。
      //
      // **完全解決はスコープ外**: 検索中に `completed → pending → completed` と一巡した場合、
      // 前後の status が同じになるため上記いずれの対処でも変化を検知できない(ABA 問題の根本
      // 原因)。完全な対策には、単一 SQL / 同一トランザクションでのスナップショット化、または
      // 単調増加する世代番号(`content_version` 列。Fable 5 が推奨していたものと同じ結論)が
      // 必要だが、スキーマ変更を伴い規模が大きいため、今回はスキーマ変更を伴わないこの2点の
      // 対処で実害を大幅に減らすに留め、根本解決は将来のリファクタとする(Issue 化済み)。
      //
      // いずれの分岐も類似検索自体を行わないため、以降の再読み取りによる楽観的検証も不要。
      // relations は上で取得済みのものをそのまま返す(空にしない)。
      return { status, relationStatus, relations, similar: [] };
    }

    // mysql2/drizzle の db.execute() は [rows, fields] のタプルを返す
    // (scripts/poc/mariadb-vector-poc.ts と同じパターン。TypeScript の型定義だけでは
    // タプルとして推論されないため `as unknown as` でキャストする)。
    //
    // ベクトルインデックスは使わずフルスキャン+`ORDER BY distance LIMIT 5`。対象ノートの
    // embedding 自体は customType の設計上そもそも JS 側へ読み出せない(§ NOTE_COLUMNS
    // 参照)ため、相関サブクエリ(`target`)で DB 内のみで距離計算する。ここへ到達するのは
    // status === "ready"(enrichment_status='completed')の場合のみ(generating/failed は
    // 上の早期 return で既に空配列を返している)。それでも念のため、対象ノートの embedding が
    // NULL(未生成)の場合は `target.embedding IS NOT NULL` 条件で全候補が除外され、結果的に
    // 空配列を返す防御を残す。
    //
    // 候補は対象ノートと同じ `embedding_model` の行のみに絞る(§10-3「モデル名・
    // バージョン列により将来差し替え可」対応。Codex D0 レビュー MEDIUM 指摘)。
    // embedding_model はモデルごとに異なるベクトル空間を表すため、異なるモデルの行同士の
    // cosine 距離には意味が無い。NULL 安全性のため `<=>`(null-safe equal)で比較する
    // (worker は embedding と embedding_model を常に同時に書き込む/NULL化するため
    // 通常は両方 NULL または両方非NULL だが、`<=>` により万一の不整合時も無意味な比較を
    // しない側に倒す)。
    //
    // target サブクエリにも `enrichment_status = 'completed'` を条件として追加する(Codex
    // 最終セキュリティ監査 MEDIUM 指摘対応)。対象ノート自体が failed(生成失敗後に古い
    // embedding が残存)の場合、上の早期 return で既に検索を行わないが、万一その判定が
    // 崩れても(将来の改修等)対象ノートの embedding が completed でなければこのサブクエリが
    // 空になり、`target.embedding IS NOT NULL` 条件で全候補が除外される。上の早期 return と
    // 合わせた二重の防御。
    //
    // 候補ノート側(n)も `enrichment_status = 'completed'` の行のみに絞る(Codex 再レビュー
    // MEDIUM 指摘対応)。候補が `pending`(内容更新済みで再生成待ち)のままだと、まだ古い
    // 内容の embedding が距離計算に使われてしまい、実際には似ていないノートが混入し得る。
    // `enrichment_status IS NULL`(migration 0005 で是正できなかった行=解析失敗で埋め込み
    // 入力が空)は元々 `embedding IS NULL` のため既にこの条件の手前で除外されており影響は
    // 無い。一方 `pending` の行は一時的に候補から外れることになるが、これは「古い embedding
    // に基づく誤った類似結果を出す」より「再生成が完了するまで候補に出さない」ほうが安全
    // という判断による(意図的な挙動。フィルタ漏れではない)。
    //
    // NOT EXISTS で既にエッジのある相手を除外する(M1-4b §設計決定10。相手ノートが
    // relations に既出であれば similar に重複させない)。note_relations は
    // `note_a_id < note_b_id` に正規化されているため、`LEAST`/`GREATEST` で (n.id, id) の
    // 正規化ペアを作って照合する(source_note_id には依存しない)。
    const result = await this.db.execute<RelatedNoteRawRow>(sql`
      SELECT
        n.id AS id,
        n.title AS title,
        n.type AS type,
        n.summary AS summary,
        n.body AS body,
        n.extracted_text AS extractedText,
        VEC_DISTANCE_COSINE(n.embedding, target.embedding) AS distance
      FROM notes AS n
      CROSS JOIN (
        SELECT embedding, embedding_model FROM notes
         WHERE id = ${id} AND enrichment_status = 'completed'
      ) AS target
      WHERE n.user_id = ${userId}
        AND n.deleted_at IS NULL
        AND n.id != ${id}
        AND n.embedding IS NOT NULL
        AND n.enrichment_status = 'completed'
        AND target.embedding IS NOT NULL
        AND n.embedding_model <=> target.embedding_model
        AND NOT EXISTS (
          SELECT 1 FROM note_relations AS r
           WHERE r.deleted_at IS NULL
             AND r.user_id = ${userId}
             AND r.note_a_id = LEAST(n.id, ${id})
             AND r.note_b_id = GREATEST(n.id, ${id})
        )
      ORDER BY distance ASC
      LIMIT ${sql.raw(String(RELATED_NOTES_LIMIT))}
    `);
    const rows = result[0] as unknown as RelatedNoteRawRow[];

    // 楽観的検証(このメソッド冒頭のコメント参照): 類似検索の実行中に対象ノートの status が
    // 変化していないかを再読み取りで確認する。`findOwned` の再呼び出しが 404 相当(存在しない/
    // 削除された)を返した場合は、この検証の対象外(元々 200 で返すべきリクエストが処理途中で
    // 消えた極めて稀な競合)としてここでは確定させず、最初に観測した status/結果をそのまま
    // 返す(このレースは本 HIGH 指摘の対象=内容更新によるスナップショット不一致とは別種の
    // 事象であり、過剰に generating へ倒すと削除済みノートに対して永久にポーリングさせて
    // しまいかねないため)。
    //
    // status に加えて embedding_fingerprint も比較する(M1-4b §設計決定10。ABA 問題
    // 〔検索中に completed → pending → completed と一巡すると前後の status が同じになり
    // 変化を検知できない〕の実害を、スキーマ変更ゼロでほぼ消すため)。
    const recheckedTarget = await this.findOwned(userId, id);
    if (
      recheckedTarget &&
      (toRelatedStatus(recheckedTarget) !== status ||
        recheckedTarget.embeddingFingerprint !== target.embeddingFingerprint)
    ) {
      // 検索実行中に status/fingerprint が変化した = 使用した embedding が最新の内容を
      // 反映していない可能性がある。similar は確定させず generating へ倒すが、relations は
      // embedding 非依存の確定事実なので破棄しない(上で取得済みのものをそのまま返す)。
      //
      // `relationStatus` も併せて `generating` へ倒す(Codex D0 レビュー HIGH 指摘対応)。
      // 初回読み取りから派生した `relationStatus` をそのまま返すと、`status` が `generating`
      // なのに `relationStatus` が `ready` という、状態遷移表の規則1(status が generating なら
      // relationStatus も generating)に反する組み合わせを返しうる。実害は表示側にあり、
      // ここで検知した変化は「判定に使われた内容が既に古い」ことを意味するため relations も
      // 陳腐化しているが、`ready` のまま返すと web が「前回の結果です」の注記を出さず、
      // 古い関係を確定情報として表示してしまう(§設計決定11)。
      return { status: "generating", relationStatus: "generating", relations, similar: [] };
    }

    return { status, relationStatus, relations, similar: rows.map(toRelatedNoteItem) };
  }

  /**
   * `note_relations` から対象ノートを端点とする有効な確定エッジを取得し、詳細画面のノート
   * 視点(`RelationItem`)へ変換する(M1-4b §設計決定10 参照)。`findRelated` の全分岐
   * (generating/failed/ready)で呼ばれるため、embedding の状態には一切依存しない。
   *
   * エッジ自身が `deleted_at IS NULL` であること・相手ノートが `user_id` 一致かつ
   * `deleted_at IS NULL` であることを JOIN の WHERE で確認する(論理削除済みエッジ・相手が
   * 論理削除済みのエッジは返さない。M1-4b 計画 §(a) 参照)。相手ノート(other)の判定に
   * `source_note_id` は使わない(閲覧ノートが note_a か note_b かのみで決まる。
   * `toApiTypeDirection` のコメント参照)。
   */
  private async fetchRelations(userId: string, id: string): Promise<RelationItem[]> {
    const result = await this.db.execute<RelationRawRow>(sql`
      SELECT
        nr.note_a_id AS noteAId,
        nr.note_b_id AS noteBId,
        other.id AS otherId,
        other.title AS title,
        other.type AS type,
        other.summary AS summary,
        other.body AS body,
        other.extracted_text AS extractedText,
        nr.relation_type AS relationType,
        nr.type_direction AS typeDirection,
        nr.description AS description,
        nr.relatedness AS relatedness
      FROM note_relations AS nr
      JOIN notes AS other
        ON other.id = IF(nr.note_a_id = ${id}, nr.note_b_id, nr.note_a_id)
      WHERE (nr.note_a_id = ${id} OR nr.note_b_id = ${id})
        AND nr.user_id = ${userId}
        AND nr.deleted_at IS NULL
        AND other.user_id = ${userId}
        AND other.deleted_at IS NULL
      ORDER BY nr.relatedness DESC, nr.id ASC
    `);
    const rows = result[0] as unknown as RelationRawRow[];
    return rows.map((row) => toRelationItem(row, id));
  }
}
