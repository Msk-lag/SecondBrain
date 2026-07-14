import { initContract } from "@ts-rest/core";
import { z } from "zod";

const c = initContract();

export const noteTypeSchema = z.enum(["memo", "url", "screenshot"]);
export type NoteType = z.infer<typeof noteTypeSchema>;

// screenshot ノートの AI 解析ステージ(memo は作成時に "completed" を即時設定する)。
// § notes テーブル拡張・削除の論理削除化 参照。
export const noteStatusSchema = z.enum(["pending", "processing", "completed", "failed"]);
export type NoteStatus = z.infer<typeof noteStatusSchema>;

export const noteSchema = z.object({
  id: z.string(),
  userId: z.string(),
  type: noteTypeSchema,
  title: z.string().nullable(),
  // screenshot ノートはユーザー入力本文が存在しないため null になりうる
  // (§ notes テーブル拡張・削除の論理削除化 参照。抽出原文は extractedText に入る)。
  body: z.string().nullable(),
  summary: z.string().nullable(),
  tags: z.array(z.string()),
  status: noteStatusSchema,
  // サニタイズ済みの短い利用者向け文言のみ(§ failureReason のサニタイズ方針 参照)
  failureReason: z.string().nullable(),
  concepts: z.array(z.string()),
  extractedText: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Note = z.infer<typeof noteSchema>;

export const noteNotFoundSchema = z.object({ message: z.string() });
export const noteConflictSchema = z.object({ message: z.string() });
export const noteBadRequestSchema = z.object({ message: z.string() });

export const createMemoNoteRequestSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  body: z.string().trim().min(1),
});
export type CreateMemoNoteRequest = z.infer<typeof createMemoNoteRequestSchema>;

export const updateNoteRequestSchema = z.object({
  title: z.string().trim().min(1).max(255).nullable().optional(),
  body: z.string().trim().min(1).optional(),
  summary: z.string().trim().nullable().optional(),
  tags: z.array(z.string().trim().min(1)).optional(),
});
export type UpdateNoteRequest = z.infer<typeof updateNoteRequestSchema>;

export const listNotesQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListNotesQuery = z.infer<typeof listNotesQuerySchema>;

export const listNotesResponseSchema = z.object({
  items: z.array(noteSchema),
  nextCursor: z.string().nullable(),
});

/**
 * AI 解析結果(Claude の構造化出力)のランタイム再検証用スキーマ。
 * § AI 解析の出力スキーマ・プロンプト設計 の JSON Schema と同一の制約を持つ。
 * title/summary は trim 後の空文字列・空白のみを明示的に拒否する
 * (Codex レビュー r8 指摘 [5] への対応。JSON Schema 側の minLength だけでは
 * trim 後に空になるケースを防げないため、アプリ側の Zod 検証で二重に防御する)。
 */
export const screenshotAnalysisResultSchema = z.object({
  title: z.string().trim().min(1).max(100),
  summary: z.string().trim().min(1).max(500),
  tags: z.array(z.string().max(50)).min(0).max(8),
  concepts: z.array(z.string().max(50)).min(0).max(10),
  extractedText: z.string().max(3000),
});
export type ScreenshotAnalysisResult = z.infer<typeof screenshotAnalysisResultSchema>;

export const notesContract = c.router({
  list: {
    method: "GET",
    path: "/notes",
    query: listNotesQuerySchema,
    responses: {
      200: listNotesResponseSchema,
    },
  },
  get: {
    method: "GET",
    path: "/notes/:id",
    responses: {
      200: noteSchema,
      404: noteNotFoundSchema,
    },
  },
  create: {
    method: "POST",
    path: "/notes",
    body: createMemoNoteRequestSchema,
    responses: {
      201: noteSchema,
    },
  },
  update: {
    method: "PATCH",
    path: "/notes/:id",
    body: updateNoteRequestSchema,
    responses: {
      200: noteSchema,
      // screenshot ノートへの body 更新拒否・status !== "completed" 中の
      // title/summary/tags 編集拒否(§ notes テーブル拡張・削除の論理削除化 参照)
      400: noteBadRequestSchema,
      404: noteNotFoundSchema,
    },
  },
  delete: {
    method: "DELETE",
    path: "/notes/:id",
    responses: {
      204: z.void(),
      404: noteNotFoundSchema,
    },
  },
  // ユーザー起点の再実行(§ retry(ユーザー起点の再実行)の冪等性 参照)。
  // 対象は screenshot ノートの status === "failed" のみ。
  retry: {
    method: "POST",
    path: "/notes/:id/retry",
    body: c.noBody(),
    responses: {
      200: noteSchema,
      404: noteNotFoundSchema,
      // status !== "failed"(既に処理中・完了済み・並行 retry 等)
      409: noteConflictSchema,
    },
  },
});
