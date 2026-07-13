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
} from "@secondbrain/db";
import {
  toPublicNote,
  type CreateMemoNoteRequest,
  type Note as PublicNote,
  type ListNotesQuery,
  type UpdateNoteRequest,
} from "@secondbrain/shared";
import { DRIZZLE } from "../../db/db.module";

export interface NoteListResult {
  items: PublicNote[];
  nextCursor: string | null;
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
      .select()
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
  async findOwned(userId: string, id: string): Promise<Note | null> {
    const rows = await this.db
      .select()
      .from(notes)
      .where(and(eq(notes.id, id), eq(notes.userId, userId), isNull(notes.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

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

    const [result] = await this.db
      .update(notes)
      .set(patch)
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
}
