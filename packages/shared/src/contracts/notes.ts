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

/**
 * `GET /notes/:id/related` のレスポンス項目(M1-4a §設計決定3 参照)。詳細画面の
 * 「類似ノート」リスト表示に必要な最小フィールドのみを持つ。embedding 本体(VECTOR)は
 * 絶対に含めない(D0 指摘[4]の回帰観点。生バイナリを公開レスポンスへ混入させない)。
 */
export const relatedNoteItemSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  type: noteTypeSchema,
  // 一覧行に表示する抜粋。summary があればそれを、無ければ本文/抽出テキストの冒頭等
  // API 側で決定した1本の文字列に正規化して返す(呼び出し側で summary/body/extractedText の
  // 優先順位を判断させない)。
  excerpt: z.string().nullable(),
  // VEC_DISTANCE_COSINE の距離(0に近いほど類似)。
  distance: z.number(),
});
export type RelatedNoteItem = z.infer<typeof relatedNoteItemSchema>;

/**
 * 類似候補ビュー(related)自体の可用性を表すアプリケーション概念(Fable 5 + Codex 独立議論
 * 論点2 で確定。DB の `enrichment_status`(pending/completed/failed/NULL)をそのまま公開せず、
 * このアプリケーション概念へ変換して返す。判定ロジックは apps/api 側
 * `notes.service.ts` の `toRelatedStatus` 参照)。
 *
 * - "generating": 埋め込み未生成(生成中)。`similar` は常に空配列。クライアントはポーリングを
 *   続けてよい。
 * - "ready": 生成済み。`similar` が空配列でも「類似候補が無かった」ことを意味し、
 *   ポーリングを止めてよい(空配列と「未生成」を区別できることが本フィールド導入の目的)。
 * - "failed": 埋め込み生成が失敗した。`similar` には古い(生成成功時点の)候補が入り得る。
 */
export const relatedNotesStatusSchema = z.enum(["generating", "ready", "failed"]);
export type RelatedNotesStatus = z.infer<typeof relatedNotesStatusSchema>;

export const relatedNotesResponseSchema = z.object({
  status: relatedNotesStatusSchema,
  similar: z.array(relatedNoteItemSchema),
});
export type RelatedNotesResponse = z.infer<typeof relatedNotesResponseSchema>;

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
  // 意味的に近い過去ノートの類似候補探索(M1-4a §設計決定3 参照)。距離昇順で最大5件。
  // 404 方針は既存エンドポイントと同じく「対象が存在しない」「他ユーザー所有」を区別しない
  // (§ API の 404 方針 参照)。レスポンスの `status`(relatedNotesStatusSchema 参照)は
  // 「生成中で空配列」と「生成済みで類似なし」をクライアントが区別するためのフィールド
  // (Fable 5 + Codex 独立議論 論点2 で確定)。
  related: {
    method: "GET",
    path: "/notes/:id/related",
    responses: {
      200: relatedNotesResponseSchema,
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
