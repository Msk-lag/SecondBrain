import { randomUUID } from "node:crypto";
import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, lt, notes, or, type Database, type Note } from "@secondbrain/db";
import type { CreateMemoNoteRequest, ListNotesQuery, UpdateNoteRequest } from "@secondbrain/shared";
import { DRIZZLE } from "../../db/db.module";

export interface NoteListResult {
  items: Note[];
  nextCursor: string | null;
}

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

@Injectable()
export class NotesService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async list(userId: string, query: ListNotesQuery): Promise<NoteListResult> {
    const cursorFilter = query.cursor ? decodeCursor(query.cursor) : null;
    const whereClause = cursorFilter
      ? and(
          eq(notes.userId, userId),
          or(
            lt(notes.createdAt, new Date(cursorFilter.createdAt)),
            and(
              eq(notes.createdAt, new Date(cursorFilter.createdAt)),
              lt(notes.id, cursorFilter.id),
            ),
          ),
        )
      : eq(notes.userId, userId);

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
    return { items, nextCursor };
  }

  /**
   * 存在確認+所有権確認を1クエリで行う。get/update/delete の 404 判定はすべてこれに一本化し、
   * MySQL の affected rows(no-op 更新で 0 になり得る)には依存しない。
   */
  async findOwned(userId: string, id: string): Promise<Note | null> {
    const rows = await this.db
      .select()
      .from(notes)
      .where(and(eq(notes.id, id), eq(notes.userId, userId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async create(userId: string, input: CreateMemoNoteRequest): Promise<Note> {
    const id = randomUUID();
    await this.db.insert(notes).values({
      id,
      userId,
      type: "memo",
      title: input.title ?? null,
      body: input.body,
      summary: null,
      tags: [],
    });
    const created = await this.findOwned(userId, id);
    if (!created) {
      throw new Error("ノート作成直後の取得に失敗しました");
    }
    return created;
  }

  async update(userId: string, id: string, patch: UpdateNoteRequest): Promise<Note | null> {
    const existing = await this.findOwned(userId, id);
    if (!existing) {
      return null;
    }
    await this.db
      .update(notes)
      .set(patch)
      .where(and(eq(notes.id, id), eq(notes.userId, userId)));
    return this.findOwned(userId, id);
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const existing = await this.findOwned(userId, id);
    if (!existing) {
      return false;
    }
    await this.db.delete(notes).where(and(eq(notes.id, id), eq(notes.userId, userId)));
    return true;
  }
}
