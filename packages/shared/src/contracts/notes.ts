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
 * § AI 解析の出力スキーマ・プロンプト設計 の JSON Schema(`apps/worker/.../
 * claude-vision.client.ts` の `SCREENSHOT_ANALYSIS_SCHEMA`)とおおむね同一の制約を持つが、
 * **件数(tags 最大8個/concepts 最大10個)だけは JSON Schema 側に置けない。** Anthropic の
 * 構造化出力(`output_config.format.json_schema`)は配列型の `minItems`/`maxItems` を
 * サポートしておらず、付けると実機で 400 になるため(2026-08-24 本番障害。実機プローブで
 * 確定。詳細は `SCREENSHOT_ANALYSIS_SCHEMA` 前コメント参照)、件数上限は JSON Schema 側では
 * description・システムプロンプトで Claude に伝えるのみとし、最終的な担保はこの Zod 側の
 * 切り詰め(`transform`)で行う。拒否ではなく切り詰めにしているのは、
 * `relation-judge.client.ts` が DB 列上限超過の `description` を失敗ではなく切り詰めで
 * 扱っている既存方針(要件 §10 項目7)に揃えるため。
 * title/summary は trim 後の空文字列・空白のみを明示的に拒否する
 * (Codex レビュー r8 指摘 [5] への対応。JSON Schema 側の minLength だけでは
 * trim 後に空になるケースを防げないため、アプリ側の Zod 検証で二重に防御する)。
 */
export const screenshotAnalysisResultSchema = z.object({
  title: z.string().trim().min(1).max(100),
  summary: z.string().trim().min(1).max(500),
  tags: z.array(z.string().max(50)).transform((a) => a.slice(0, 8)),
  concepts: z.array(z.string().max(50)).transform((a) => a.slice(0, 10)),
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
 * - "failed": 埋め込み生成が失敗した。`similar` は常に空配列を返す(`findRelated` は
 *   `status === 'failed'` を検出した時点で早期 return し、類似検索そのものを行わない。
 *   古い〔生成成功時点の〕候補を保持し続けることはしない。M1-4b 実装時にコードと不一致だった
 *   旧記述を是正した)。
 */
export const relatedNotesStatusSchema = z.enum(["generating", "ready", "failed"]);
export type RelatedNotesStatus = z.infer<typeof relatedNotesStatusSchema>;

/**
 * AI が判定した関係の種類(7値固定語彙。M1-4b §設計決定1 参照)。
 *
 * **注意: `packages/db/src/schema/note-relations.ts` の `noteRelationTypeValues` と
 * 値を二重管理している。** `packages/shared` は `packages/db` に依存していない
 * (`packages/shared/package.json` に `@secondbrain/db` が無い)ため import できず、
 * ここで再定義する。**語彙を変更する場合は両方のファイルを必ず同時に直すこと。**
 * AI 出力がこれ以外の場合は worker 側の応答境界検証で "other" へ丸められる
 * (この場合 typeDirection は "none" になる)。
 */
export const noteRelationTypeValues = [
  "same-theme",
  "cause-solution",
  "claim-counter",
  "concept-hierarchy",
  "tech-example",
  "problem-remedy",
  "other",
] as const;
export const noteRelationTypeSchema = z.enum(noteRelationTypeValues);
export type NoteRelationType = z.infer<typeof noteRelationTypeSchema>;

/**
 * 関係の向き(**API 消費者〔詳細画面のノート〕視点へ変換済み**。DB の `type_direction`
 * (a-to-b/b-to-a/none。note_a/note_b という正規化上の役割基準)をそのまま露出しない
 * (M1-4b 計画の指示。相手ノート ID だけでは a/b どちらの役割かを web が判断できないため)。
 *
 * - "outgoing": 詳細画面のノートが種類の左項の役割を持つ(例: cause-solution で
 *   このノートが原因側)
 * - "incoming": 詳細画面のノートが種類の右項の役割を持つ(例: cause-solution で
 *   このノートが解決策側)
 * - "none": 向きの無い関係(same-theme/other)
 *
 * **apps/api 側の変換表**(M1-4b §設計決定1 の a/b エンコード表の逆変換。source
 * 〔判定契機ノート〕ではなく note_a/note_b の役割のみに依存する。source が
 * どちらであっても以下は成立する):
 *
 * | 詳細画面のノートが | DB の type_direction | API の typeDirection |
 * |---|---|---|
 * | note_a | a-to-b | outgoing |
 * | note_a | b-to-a | incoming |
 * | note_b | a-to-b | incoming |
 * | note_b | b-to-a | outgoing |
 * | — | none | none |
 */
export const relationTypeDirectionSchema = z.enum(["outgoing", "incoming", "none"]);
export type RelationTypeDirection = z.infer<typeof relationTypeDirectionSchema>;

/**
 * `GET /notes/:id/related` の `relations` 配列の要素(M1-4b §設計決定1・10 参照)。
 * 永続化された確定エッジ1件を、詳細画面のノート視点で表現する。相手ノートの識別・表示に
 * 必要な項目は `relatedNoteItemSchema` に揃える(`distance` は持たない。関係の強さは
 * `relatedness` で表現する)。embedding 本体は含めない(`relatedNoteItemSchema` と同じ理由)。
 */
export const relationItemSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  type: noteTypeSchema,
  excerpt: z.string().nullable(),
  relationType: noteRelationTypeSchema,
  typeDirection: relationTypeDirectionSchema,
  // なぜ繋がるかの説明(日本語)。DB 側 varchar(500) と同じ上限(境界検証で切り詰め済み)。
  description: z.string().max(500),
  // 0〜1(境界検証で clamp・小数第2位丸め済みの値のみ DB に書き込まれる)。
  relatedness: z.number().min(0).max(1),
});
export type RelationItem = z.infer<typeof relationItemSchema>;

/**
 * 関係判定ステージ(`relations`)自体の可用性を表すアプリケーション概念
 * (M1-4b §設計決定10 の状態遷移表を要約。DB の `relation_status`
 * 〔pending/completed/failed/NULL〕をそのまま公開せず、`relation_fingerprint` との
 * 一致判定も含めてこのアプリケーション概念へ変換する。判定ロジックは apps/api 側
 * `notes.service.ts` 参照)。**上から順に評価する7規則から派生**:
 *
 * 1. 埋め込みが `generating`(`status==='generating'`) → `generating`(継続。埋め込み完了後に
 *    関係判定が続く)
 * 2. 埋め込みが `failed`(`status==='failed'`) → `failed`(**停止**。関係判定は永久に走らない)
 * 3. 一度も判定されておらず投入予定も無い(`relation_status`/`relation_fingerprint` とも
 *    NULL。M1-4a 期の既存ノート) → `not_started`(停止)
 * 4. 現在の内容に対する判定が完了(`relation_status==='completed'` かつ fingerprint 一致)
 *    → `ready`(停止。終端)
 * 5. 現在の内容に対する判定が失敗(`relation_status==='failed'` かつ fingerprint 一致)
 *    → `failed`(停止。終端)
 * 6. 現在の内容を判定中(`relation_status==='pending'` かつ fingerprint 一致) → `generating`
 *    (継続)
 * 7. fingerprint 不一致(status を問わず。現在の内容に対する判定がこれから走る)
 *    → `generating`(継続)
 *
 * web は `relationStatus === 'generating'` の間ポーリングを継続し、それ以外(終端)で停止する。
 * `relations` は `relationStatus` の値によらず常に返す(永続化された確定エッジは現在の
 * embedding 状態に依存しない事実であり、`generating`/`failed` でも古い確定結果を消さない
 * ため。相手ノート側の関係判定でこのノートが候補側として登録されたエッジもあるため、
 * `not_started`〔このノート自身は未判定〕でも `relations` が非空になりうる)。
 */
export const relationStatusSchema = z.enum(["not_started", "generating", "ready", "failed"]);
export type RelationStatus = z.infer<typeof relationStatusSchema>;

export const relatedNotesResponseSchema = z.object({
  status: relatedNotesStatusSchema,
  relationStatus: relationStatusSchema,
  relations: z.array(relationItemSchema),
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
  // (Fable 5 + Codex 独立議論 論点2 で確定)。`relationStatus`/`relations` は M1-4b で追加した
  // 確定エッジ(種類・説明・関連度)群であり、`status`/`similar` とは独立した状態遷移を持つ
  // (relationStatusSchema のコメント・M1-4b §設計決定10 参照)。
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
