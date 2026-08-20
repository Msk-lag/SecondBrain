import { Inject, Injectable } from "@nestjs/common";
import { sql, type Database, type NoteRelationTypeDirection, type NoteType } from "@secondbrain/db";
import type { GraphEdge, GraphNode, GraphResponse, NoteRelationType } from "@secondbrain/shared";
import { DRIZZLE } from "../../db/db.module";

/**
 * `GET /graph` のノード上限(M2-1 §設計決定4 参照)。要件 §5「MVP は2D表示で数百ノート規模で
 * 操作可能な fps を保つ」を満たす値。初版は500だったが、2026-08-19 の Fable 5 + Codex 独立議論
 * (§独立議論の反映)で「未検証の上限は小さい側が安全」という判断により 300 へ引き下げた
 * (要件の「数百ノート」は満たしたまま。上限を引き上げる場合はこの定数1行の変更で足りる)。
 */
export const GRAPH_NODE_LIMIT = 300;

/**
 * `GET /graph` のエッジ上限(M2-1 §設計決定4 参照)。関係判定の判定候補は1保存あたり5件上限
 * (`RELATION_CANDIDATES_LIMIT`。apps/worker の relation-candidates.ts 参照)であり、
 * `note_a_id < note_b_id` への正規化によりエッジ数はノート数の2〜3倍に収束する見積もりから、
 * `GRAPH_NODE_LIMIT` の3倍を上限とする。
 */
export const GRAPH_EDGE_LIMIT = 900;

/**
 * `GET /graph` の処理中件数 SQL(§設計決定6)の生行。`COUNT(*)` は mysql2 の既定設定では
 * number で返るが、BIGINT を経由する集計関数の型は環境依存になり得るため防御的に
 * `Number()` で正規化する(findGraph 側)。
 */
interface ProcessingCountRawRow {
  count: number | string;
}

/**
 * `GET /graph` のノード SQL(§設計決定7)の生行。`notes` を参照するクエリは常に明示列投影で
 * embedding(raw VECTOR バイナリ)を含めない(notes.service.ts の `NOTE_COLUMNS`・D0 指摘[4]と
 * 同じ規律。`select().from(notes)` は禁止で raw SQL の明示列のみを使う)。`bodyPreview` は
 * `LEFT(body, 120)` で、body が NULL(screenshot ノート)の場合は NULL のまま返る。
 */
interface GraphNodeRawRow {
  id: string;
  title: string | null;
  type: NoteType;
  bodyPreview: string | null;
}

/**
 * `GET /graph` のエッジ SQL(§設計決定4・7)の生行。`noteAId`/`noteBId` は DB の a/b 正規化上の
 * 役割そのもの(`toGraphEdgeEndpoints` の入力)。`relatedness` は `decimal(3,2)` 列のため
 * mysql2 既定設定では文字列で返る(notes.service.ts の `RelationRawRow` と同じ注意点)。
 * このクエリは `notes` を JOIN しない(§設計決定4: 誘導部分グラフ方式の副次効果。ノード ID
 * 集合で両端を絞り込み済みのため相手ノートの列を読む必要が無い)。
 */
interface GraphEdgeRawRow {
  id: string;
  noteAId: string;
  noteBId: string;
  relationType: string;
  typeDirection: NoteRelationTypeDirection;
  description: string;
  relatedness: string;
}

function toGraphNode(row: GraphNodeRawRow): GraphNode {
  return { id: row.id, title: row.title, type: row.type, bodyPreview: row.bodyPreview };
}

/**
 * DB の `type_direction`(note_a/note_b という正規化上の役割基準)を、ネットワーク全体視点の
 * `source`/`target`/`directed` へ変換する(M2-1 §設計決定3・`packages/shared/src/contracts/
 * graph.ts` の変換表と同一。**変換表はここと契約コメントの2箇所に書いてあるが意味している
 * a/b エンコードは同じであり、実装を追加するときはどちらか一方だけを直して不整合を生まない
 * こと**)。ネットワーク全体には「閲覧中のノート」という基準が存在しないため、
 * `notes.service.ts` の `toApiTypeDirection`(閲覧ノート視点への変換)とは別の関数として
 * 切り出す。source 側を閲覧ノートとみなすと常に outgoing になる向きと一致する。
 * 純関数として export し、spec で3分岐を個別に検証する(計画 実装手順2 参照)。
 *
 * | DB の `type_direction` | `source` | `target` | `directed` |
 * |---|---|---|---|
 * | `a-to-b` | `note_a_id` | `note_b_id` | `true` |
 * | `b-to-a` | `note_b_id` | `note_a_id` | `true` |
 * | `none` | `note_a_id` | `note_b_id` | `false` |
 */
export function toGraphEdgeEndpoints(
  typeDirection: NoteRelationTypeDirection,
  noteAId: string,
  noteBId: string,
): { source: string; target: string; directed: boolean } {
  if (typeDirection === "none") {
    return { source: noteAId, target: noteBId, directed: false };
  }
  if (typeDirection === "a-to-b") {
    return { source: noteAId, target: noteBId, directed: true };
  }
  // b-to-a: 読みの左項(source)が note_b 側になる(表の3行目)。
  return { source: noteBId, target: noteAId, directed: true };
}

function toGraphEdge(row: GraphEdgeRawRow): GraphEdge {
  const { source, target, directed } = toGraphEdgeEndpoints(
    row.typeDirection,
    row.noteAId,
    row.noteBId,
  );
  return {
    id: row.id,
    source,
    target,
    directed,
    // relationType は worker の応答境界検証(relation-judge クライアント)で7値固定語彙へ
    // 既に正規化済みのため、ここでは再検証せず公開型へキャストする
    // (notes.service.ts の toRelationItem と同じ規律)。
    relationType: row.relationType as NoteRelationType,
    description: row.description,
    // decimal(3,2) は mysql2 既定設定では文字列で返る(GraphEdgeRawRow のコメント参照)。
    relatedness: Number(row.relatedness),
  };
}

@Injectable()
export class GraphService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * 知識ネットワーク全体(ノード=ノート、エッジ=F-19 の確定関係)を1リクエストで取得する
   * (M2-1 §設計決定2〜7 参照)。
   *
   * **3クエリを単一トランザクションの一貫スナップショットで読む(§設計決定7。指摘[2]対応)**:
   * 独立した3クエリのままだと、エッジ取得後・件数取得前に worker が関係をコミットした場合に
   * 「古いエッジ + processingNoteCount: 0」が成立し、web がポーリングを止めてしまう。
   * MariaDB/InnoDB の REPEATABLE READ はトランザクション内の最初の一貫読み取りでスナップショット
   * を確立するため、`db.transaction()` の内側で3クエリを実行すれば同一スナップショットで
   * 読める。**実行順は必ず「(1) 処理中件数 → (2) ノード → (3) エッジ」**(独立クエリにしては
   * ならない)。件数を最初に読むのは、万一この一貫性が効かない構成であっても「古いエッジ +
   * processingNoteCount: 0」という、停止信号がグラフより新しくなる(危険な)側ではなく、
   * 停止信号がグラフより新しくならない(安全な)側へ倒すため。読み取り専用のため書き込み
   * ロックは取得しない。
   */
  async findGraph(userId: string): Promise<GraphResponse> {
    return this.db.transaction(async (tx) => {
      // (1) 処理中件数(§設計決定6)。
      const countResult = await tx.execute<ProcessingCountRawRow>(sql`
        SELECT COUNT(*) AS count FROM notes
         WHERE user_id = ${userId} AND deleted_at IS NULL
           AND ( status IN ('pending','processing')
              -- (a) スクショ解析中(enrichment 未着手)。(b)(c) だけでは解析中にポーリングが
              -- 止まり、デモの中心である「貼ると繋がる」が自動反映されない。
              OR enrichment_status = 'pending'
              -- (b) 埋め込み待ち・実行中。
              OR relation_status = 'pending'
              -- (c) 関係判定中。
              OR (enrichment_status = 'completed'
                  AND relation_fingerprint IS NOT NULL
                  AND relation_fingerprint <> embedding_fingerprint) )
              -- (d) 内容更新後の再判定待ち。relation_fingerprint IS NULL の行(M1-4a 期の
              -- 既存ノート)は NULL 比較で自然に除外され、待っても変化しないものを数えない。
      `);
      const countRows = countResult[0] as unknown as ProcessingCountRawRow[];
      const processingNoteCount = Number(countRows[0]?.count ?? 0);

      // (2) ノード。created_at DESC, id DESC で上限+1件取得し、超過分は先頭 GRAPH_NODE_LIMIT
      // 件へ切り詰める(新しいノートを優先する。§設計決定4)。`select().from(notes)` は
      // embedding を含む全列を SELECT してしまうため使わない(D0 指摘[4])。
      const nodeResult = await tx.execute<GraphNodeRawRow>(sql`
        SELECT n.id AS id, n.title AS title, n.type AS type, LEFT(n.body, 120) AS bodyPreview
          FROM notes AS n
         WHERE n.user_id = ${userId} AND n.deleted_at IS NULL
         ORDER BY n.created_at DESC, n.id DESC
         LIMIT ${sql.raw(String(GRAPH_NODE_LIMIT + 1))}
      `);
      const nodeRows = nodeResult[0] as unknown as GraphNodeRawRow[];
      const truncatedNodes = nodeRows.length > GRAPH_NODE_LIMIT;
      const limitedNodeRows = truncatedNodes ? nodeRows.slice(0, GRAPH_NODE_LIMIT) : nodeRows;
      const nodes = limitedNodeRows.map(toGraphNode);

      // (3) エッジ。**確定したノード ID 集合を WHERE に渡してから上限を適用する**(指摘[1]。
      // 順序を逆にすると上限外ノートの高関連度エッジが枠を占有し、返却ノード同士のエッジが
      // DB にあるのに落ちて疎なグラフになる)。ノード0件のときは空の `IN ()` が MariaDB の
      // 構文エラーになるため、エッジ SQL 自体を発行しない(受入条件7)。
      let edges: GraphEdge[] = [];
      let truncatedEdges = false;
      if (nodes.length > 0) {
        // 文字列連結ではなく `sql.join` でバインド変数として展開する(SQL インジェクション
        // 対策)。同じ `nodeIdList` を note_a_id/note_b_id 両方の IN 句で再利用する
        // (drizzle の SQL ノードはレンダリング時に副作用の無い再帰トラバースで文字列化される
        // ため、同一オブジェクトの再利用は安全)。
        const nodeIdList = sql.join(
          nodes.map((node) => sql`${node.id}`),
          sql`, `,
        );
        const edgeResult = await tx.execute<GraphEdgeRawRow>(sql`
          SELECT nr.id AS id, nr.note_a_id AS noteAId, nr.note_b_id AS noteBId,
                 nr.relation_type AS relationType, nr.type_direction AS typeDirection,
                 nr.description AS description, nr.relatedness AS relatedness
            FROM note_relations AS nr
           WHERE nr.user_id = ${userId} AND nr.deleted_at IS NULL
             AND nr.note_a_id IN (${nodeIdList}) AND nr.note_b_id IN (${nodeIdList})
           ORDER BY nr.relatedness DESC, nr.id ASC
           LIMIT ${sql.raw(String(GRAPH_EDGE_LIMIT + 1))}
        `);
        const edgeRows = edgeResult[0] as unknown as GraphEdgeRawRow[];
        truncatedEdges = edgeRows.length > GRAPH_EDGE_LIMIT;
        const limitedEdgeRows = truncatedEdges ? edgeRows.slice(0, GRAPH_EDGE_LIMIT) : edgeRows;
        edges = limitedEdgeRows.map(toGraphEdge);
      }

      // 認可の多重防御(§設計決定5): `nr.user_id` 一致に加え、ノード ID 集合自体が
      // user_id 一致・未削除(上の (2) の WHERE)で絞り込み済みであることにより、
      // 両端ノートの所有者一致が担保される(エッジ SQL は notes を JOIN しない)。
      return {
        nodes,
        edges,
        truncated: { nodes: truncatedNodes, edges: truncatedEdges },
        processingNoteCount,
      };
    });
  }
}
