import { initContract } from "@ts-rest/core";
import { z } from "zod";

import { noteRelationTypeSchema, noteTypeSchema } from "./notes.js";

const c = initContract();

/**
 * `GET /graph` のノード1件(M2-1 §設計決定2 参照)。ノードは lean に保ち、要約・本文全体・
 * 画像は含めない(F-20 の「ノード選択で要約・種別に応じた内容を確認」は選択時に既存の
 * `GET /notes/:id` / `GET /notes/:id/image` で満たす。同時に読むのは常に1件であり、全ノード
 * ぶんの本文を含めるとペイロードを膨らませるだけである)。
 */
export const graphNodeSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  // memo / url / screenshot(ノード色に使う)。
  type: noteTypeSchema,
  // `LEFT(body, 120)`。**タイトル未入力時のラベル補完専用**。web の既存
  // `getDisplayTitle({ title, body })`(タイトル未入力時は本文冒頭30文字)をそのまま
  // 再利用できるようにするための値であり、要約・本文全体・画像は含めない
  // (ノード選択時に既存の `GET /notes/:id` / `GET /notes/:id/image` で取得する)。
  bodyPreview: z.string().nullable(),
});
export type GraphNode = z.infer<typeof graphNodeSchema>;

/**
 * `GET /graph` のエッジ1件(M2-1 §設計決定2・3 参照)。`note_relations` の確定エッジ
 * (F-19)のみを表す。類似候補(`similar`)は一切含めない(F-7「描画するエッジは F-19 の
 * 確定エッジのみ」)。
 *
 * **`source`/`target`/`directed` の変換表**(DB の `type_direction`〔note_a/note_b という
 * 正規化上の役割基準〕→ ネットワーク全体視点への正規化。ネットワーク全体には「閲覧中の
 * ノート」という基準が無いため、`GET /notes/:id/related` の `typeDirection`
 * 〔詳細画面のノート視点〕とは別の変換が必要):
 *
 * | DB の `type_direction` | `source` | `target` | `directed` |
 * |---|---|---|---|
 * | `a-to-b` | `note_a_id` | `note_b_id` | `true` |
 * | `b-to-a` | `note_b_id` | `note_a_id` | `true` |
 * | `none` | `note_a_id` | `note_b_id` | `false` |
 *
 * 読みは常に **「`source` →(種類の左項→右項)→ `target`」**(例: `cause-solution` なら
 * `source` が原因側)。これは `./notes.js` の `relationTypeDirectionSchema` のコメントで
 * `source`〔閲覧ノート〕を note_a とみなすと常に `outgoing` になる向きと一致する
 * (apps/api 側の変換実装は `toApiTypeDirection` を参照。**変換表はここと
 * `relationTypeDirectionSchema` の2箇所に書いてあるが、意味しているのは同じ a/b エンコード
 * であり、実装を追加するときにどちらか一方だけを直して不整合を生まないこと**)。
 * `{ source, target }` というキー名は react-force-graph の `links` が既定で読む
 * プロパティ名と一致しており、web 側での詰め替えを不要にする。
 */
export const graphEdgeSchema = z.object({
  // note_relations.id
  id: z.string(),
  source: z.string(),
  target: z.string(),
  // same-theme / other は false(向きの無い関係)。
  directed: z.boolean(),
  // 既存の7値固定語彙を再利用(`./notes.js` の noteRelationTypeSchema)。
  relationType: noteRelationTypeSchema,
  // エッジ選択時の AI 説明(日本語)。DB 側 varchar(500) と同じ上限。
  description: z.string().max(500),
  // 0〜1。線の太さに使う。
  relatedness: z.number().min(0).max(1),
});
export type GraphEdge = z.infer<typeof graphEdgeSchema>;

/**
 * `GET /graph` のレスポンス全体(M2-1 §設計決定2・4・6 参照)。
 *
 * **`truncated`(上限到達の表明。§設計決定4)**: 上限は `GRAPH_NODE_LIMIT`(300)/
 * `GRAPH_EDGE_LIMIT`(900)の**ハードキャップ**であり、ページングは採用しない(力学レイアウト
 * はグラフ全体を入力とする一括計算のため、部分集合を渡すとページを跨ぐたびレイアウトが別物
 * になり「ネットワークを眺める」体験が成立しない)。**エッジは必ず「返却ノード集合の誘導
 * 部分グラフ」に絞ってから上限を適用する**(先にエッジ全体を上限で切ってから端点フィルタを
 * かけると、上限外ノートの高関連度エッジが枠を占有し、返却ノード同士のエッジが DB にあるのに
 * 落ちて疎なグラフになる)。上限は「取得を分割する仕組み」ではなく「**描画性能を守る
 * 安全弁**」である。`truncated.nodes` が true のときは上限外ノートへのエッジも表示されない
 * ため、**ノードの次数が実際より少なく見える**(上限外ノートと繋がっていたエッジが不可視に
 * なるだけで、返却されたノード同士のエッジは欠落しない)。
 *
 * **次数(接続数)は API で返さない**(§設計決定5)。「ノードサイズ = 接続数」に使う次数は
 * **返した `edges` 配列から web 側で数える**。DB 上の次数をそのまま返すと、上限で落ちた
 * ぶんのエッジと描画上の次数が食い違うため。
 *
 * `processingNoteCount`(§設計決定6): 「AI が新しい関係を判定中です(N件)」バッジ表示と、
 * **ポーリング間隔の緩急に使うヒント**である。**「0 = 全処理完了」を保証するものではない**
 * (2026-08-19 の Fable 5 + Codex 独立議論で「正しさを保証する値」から「ヒント」へ格下げ)。
 * **web はこの値をポーリングの停止条件に使わない**(M2-1 §設計決定6 / M2-2 §設計決定6)。
 * 算出 SQL には、初回判定対象ノートの埋め込み書き戻し(`enrichment_status='completed'`)
 * から関係判定ステージの claim(`relation_status='pending'`)までの**同一プロセス内・1
 * UPDATE 分の捕捉不能な窓**が残るが、web が本値を停止条件に使わない設計にしたことで、この窓
 * は実害を持たない(バッジが一瞬消えるだけで、ポーリング自体は他の終端条件で止まる)。
 */
export const graphResponseSchema = z.object({
  nodes: z.array(graphNodeSchema),
  edges: z.array(graphEdgeSchema),
  truncated: z.object({
    nodes: z.boolean(),
    edges: z.boolean(),
  }),
  processingNoteCount: z.number().int().min(0),
});
export type GraphResponse = z.infer<typeof graphResponseSchema>;

/**
 * `GET /graph`: 知識ネットワーク全体(ノード=ノート、エッジ=F-19 の確定関係)を1リクエスト
 * で取得する(M2-1 参照)。**`/notes/*` 配下には置かない**(`/notes/graph` は既存
 * `GET /notes/:id` と経路が衝突し、Express の登録順に依存して `:id` 側が先に一致すると 404
 * になりうるため。ts-rest/nest は契約側から順序を保証できないため、衝突しないパスを選んで
 * 問題自体を消している)。
 *
 * **`GET /notes/:id/related` との併存関係**(§設計決定5): `related` は単一ノート視点で
 * 確定エッジ(閲覧視点の向き)+ 類似候補(`similar`)+ ノート単位の2状態を返す。`/graph`
 * は全体視点で確定エッジのみ(エッジ自身の向き。閲覧視点が存在しないため)+ ユーザー単位の
 * 集計状態(`processingNoteCount`)を返す。詳細画面は類似候補も併記する仕様(F-7)であり
 * `/graph` では代替できず、逆に `/graph` へ `similar` を混ぜると F-7(描画するエッジは F-19
 * の確定エッジのみ)に反する。投影列も向きの表現も異なるため SQL の共通化は行わない。
 *
 * **孤立ノートは除外しない**: ノード=ノートという F-20 の定義により、確定エッジを一切
 * 持たないノートも API レベルでは常に `nodes` に含める。既定表示で隠すかどうかは web 側の
 * 表示制御であり、この契約の責務ではない。
 */
export const graphContract = c.router({
  get: {
    method: "GET",
    path: "/graph",
    responses: {
      200: graphResponseSchema,
    },
  },
});
