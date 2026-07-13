import { noteSchema, type Note } from "../contracts/notes.js";

/**
 * DB 行(内部列を含む)を受け取るための緩い型。
 * notes テーブルには imageKey・processingGeneration・processingAttemptToken・deletedAt 等、
 * 公開レスポンスに含めてはならない内部列が存在するため、`toPublicNote` の入力としては
 * これらを含む任意の追加キーを許容する(§ 公開レスポンスからの内部列除外(response projection) 参照)。
 * createdAt/updatedAt は DB ドライバ(drizzle-orm/mysql2)から Date インスタンスとして
 * 返ってくるため、string も許容する。
 */
export type NoteRow = Omit<Note, "createdAt" | "updatedAt"> &
  Record<string, unknown> & {
    createdAt: Date | string;
    updatedAt: Date | string;
  };

/**
 * DB 行(内部列を含む)から公開 Note 型のみを実行時に取り出す。
 *
 * 実装は `noteSchema.parse(row)`(Zod の z.object は既定で未知キーを strip するため、
 * imageKey・processingGeneration・processingAttemptToken・deletedAt を含む行を渡しても、
 * これらは戻り値に含まれない — § 公開レスポンスからの内部列除外(response projection)・
 * Codex レビュー r20 指摘 [3] への対応)。createdAt/updatedAt のみ、parse 前に
 * ISO 文字列へ正規化する(noteSchema は z.string() のため Date インスタンスのままでは
 * 検証に失敗する)。
 */
export function toPublicNote(row: NoteRow): Note {
  return noteSchema.parse({
    ...row,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
  });
}
