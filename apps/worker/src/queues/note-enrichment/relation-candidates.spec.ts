import type { Database } from "@secondbrain/db";
import { findRelationCandidates, RELATION_CANDIDATES_LIMIT } from "./relation-candidates";

type ExecuteResult = [unknown[], unknown[]];

function createFakeDb(rows: unknown[], executeSpy?: (query: unknown) => void): Database {
  return {
    execute: (query: unknown) => {
      executeSpy?.(query);
      return Promise.resolve([rows, []] satisfies ExecuteResult);
    },
  } as unknown as Database;
}

/**
 * note-enrichment.processor.spec.ts と同じダックタイピングによる SQL 文字列復元ヘルパー
 * (drizzle-orm を直接の依存に追加せずクエリ内容を検証するため)。
 */
function extractSqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks;
  if (!Array.isArray(chunks)) {
    return "";
  }
  return chunks
    .map((chunk) => {
      if (typeof chunk !== "object" || chunk === null) {
        return String(chunk);
      }
      const c = chunk as { queryChunks?: unknown[]; value?: unknown };
      if (Array.isArray(c.queryChunks)) {
        return extractSqlText(c);
      }
      if (Array.isArray(c.value)) {
        return (c.value as unknown[]).map(String).join("");
      }
      if ("value" in c) {
        return String(c.value);
      }
      return "";
    })
    .join("");
}

function rawRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "candidate-1",
    title: "候補タイトル",
    type: "memo",
    summary: "候補要約",
    body: "候補本文",
    extracted_text: null,
    embedding_fingerprint: "fp-candidate-1",
    ...overrides,
  };
}

describe("findRelationCandidates", () => {
  it("LIMIT 5・embedding_model の一致・enrichment_status='completed'・deleted_at IS NULL の条件を含む SQL を発行する(§設計決定8)", async () => {
    const executeSpy = vi.fn();
    const db = createFakeDb([], executeSpy);

    await findRelationCandidates(db, "user-1", "note-1");

    expect(executeSpy).toHaveBeenCalledTimes(1);
    const sqlText = extractSqlText(executeSpy.mock.calls[0][0]);
    expect(sqlText).toContain(`LIMIT ${RELATION_CANDIDATES_LIMIT}`);
    expect(RELATION_CANDIDATES_LIMIT).toBe(5);
    expect(sqlText).toContain("n.embedding_model <=> target.embedding_model");
    expect(sqlText).toContain("n.enrichment_status = 'completed'");
    expect(sqlText).toContain("n.deleted_at IS NULL");
    expect(sqlText).toContain("n.embedding_fingerprint");
    expect(sqlText).toContain("ORDER BY VEC_DISTANCE_COSINE");
  });

  it("行を RelationCandidate 形式(embeddingFingerprint を含む)へマッピングして返す", async () => {
    const db = createFakeDb([rawRow()]);

    const candidates = await findRelationCandidates(db, "user-1", "note-1");

    expect(candidates).toEqual([
      {
        id: "candidate-1",
        title: "候補タイトル",
        type: "memo",
        summary: "候補要約",
        body: "候補本文",
        extractedText: null,
        embeddingFingerprint: "fp-candidate-1",
      },
    ]);
  });

  it("embedding_fingerprint が null の行は防御的に除外する(enrichment_status='completed' なら通常発生しない不整合)", async () => {
    const db = createFakeDb([rawRow({ id: "candidate-2", embedding_fingerprint: null }), rawRow()]);

    const candidates = await findRelationCandidates(db, "user-1", "note-1");

    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).toBe("candidate-1");
  });

  it("候補が0件の場合は空配列を返す", async () => {
    const db = createFakeDb([]);

    const candidates = await findRelationCandidates(db, "user-1", "note-1");

    expect(candidates).toEqual([]);
  });
});
