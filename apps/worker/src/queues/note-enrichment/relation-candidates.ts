import { sql, type Database } from "@secondbrain/db";

/**
 * 関係判定ステージの候補取得クエリ(M1-4b 計画 §設計決定8 参照)。
 *
 * **意図的な二重実装である**: 「M1-4a の `findRelated` と同条件」の候補取得は
 * `apps/api/src/modules/notes/notes.service.ts` の `findRelated` に既に存在するが、
 * worker から api のコードを呼ぶことはできない(別プロセス・別デプロイ単位)ため、
 * 同等の SQL を worker 側にも新規作成している。**両者の条件(embedding_model の一致・
 * enrichment_status='completed'・deleted_at IS NULL・LIMIT 5)を変更する場合は、
 * 必ず両ファイルを同時に見直すこと。** worker 側はこれに加えて `embedding_fingerprint`
 * を SELECT する点が api 側と異なる(§設計決定6 のエッジ upsert で両端 fingerprint の
 * 一致を検証するために必要。api 側の類似候補表示にはこの列は不要)。
 */
export const RELATION_CANDIDATES_LIMIT = 5;

interface RawRelationCandidateRow {
  id: string;
  title: string | null;
  type: string;
  summary: string | null;
  body: string | null;
  extracted_text: string | null;
  embedding_fingerprint: string | null;
}

/** 関係判定ステージが Claude へ渡す候補ノート1件(§設計決定6 の upsert で使う
 * `embeddingFingerprint` を必ず保持する)。 */
export interface RelationCandidate {
  id: string;
  title: string | null;
  type: string;
  summary: string | null;
  body: string | null;
  extractedText: string | null;
  embeddingFingerprint: string;
}

/**
 * 保存ノート(noteId)の embedding と近い既存ノートを距離昇順で最大 `RELATION_CANDIDATES_LIMIT`
 * 件取得する。`notes.service.ts` の `findRelated` と同じ条件(§設計決定8 のクエリそのもの):
 * - 対象ノート(target)・候補ノード双方とも `enrichment_status = 'completed'` かつ
 *   `embedding IS NOT NULL`(古い/未生成の embedding を候補計算に使わない)
 * - `embedding_model` が一致する行のみ(異なるモデルのベクトル空間を比較しない。NULL 安全な
 *   `<=>` で比較する)
 * - 候補側は `deleted_at IS NULL`(論理削除済みノートを候補にしない)
 *
 * **既知の制約**(§設計決定8 に明文化): 候補側ノートが `pending`(内容更新済みで
 * 再生成待ち)の間はこの条件で除外されるため、その組は今回の判定では対象外になる。
 * F-16(一括発見)が無い以上、自動では再判定されない。「古い embedding に基づく誤った
 * 関係を作る」よりは安全という意図的な挙動。
 */
export async function findRelationCandidates(
  db: Database,
  userId: string,
  noteId: string,
): Promise<RelationCandidate[]> {
  const result = await db.execute<RawRelationCandidateRow>(sql`
    SELECT
      n.id AS id,
      n.title AS title,
      n.type AS type,
      n.summary AS summary,
      n.body AS body,
      n.extracted_text AS extracted_text,
      n.embedding_fingerprint AS embedding_fingerprint
    FROM notes AS n
    CROSS JOIN (
      SELECT embedding, embedding_model FROM notes
       WHERE id = ${noteId} AND enrichment_status = 'completed'
    ) AS target
    WHERE n.user_id = ${userId}
      AND n.deleted_at IS NULL
      AND n.id != ${noteId}
      AND n.embedding IS NOT NULL
      AND n.enrichment_status = 'completed'
      AND target.embedding IS NOT NULL
      AND n.embedding_model <=> target.embedding_model
    ORDER BY VEC_DISTANCE_COSINE(n.embedding, target.embedding) ASC
    LIMIT ${sql.raw(String(RELATION_CANDIDATES_LIMIT))}
  `);
  const rows = result[0] as unknown as RawRelationCandidateRow[];

  return rows
    .filter(
      // enrichment_status='completed' の行は writeBackEmbedding/completeWithoutNewEmbedding が
      // 常に embedding_fingerprint を同時に設定するため理論上 null にはならないが、万一の
      // 不整合時にこの候補だけを静かに除外する防御(呼び出し元の upsert が
      // embeddingFingerprint: string を要求するため、ここで型を確定させる)。
      (row): row is RawRelationCandidateRow & { embedding_fingerprint: string } =>
        row.embedding_fingerprint !== null,
    )
    .map((row) => ({
      id: row.id,
      title: row.title,
      type: row.type,
      summary: row.summary,
      body: row.body,
      extractedText: row.extracted_text,
      embeddingFingerprint: row.embedding_fingerprint,
    }));
}
