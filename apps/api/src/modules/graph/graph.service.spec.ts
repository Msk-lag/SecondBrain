import type { Database } from "@secondbrain/db";
import {
  GRAPH_EDGE_LIMIT,
  GRAPH_NODE_LIMIT,
  GraphService,
  toGraphEdgeEndpoints,
} from "./graph.service";

/**
 * drizzle-orm の `sql` タグが生成する `SQL` インスタンス(`queryChunks`)を、実際の依存追加
 * 無しに実行時のダックタイピングで概ねのクエリ文字列へ復元するテスト専用ヘルパー
 * (apps/api の notes.service.spec.ts・apps/worker の note-enrichment.processor.spec.ts と
 * 同じ実装をここでも複製する。`sql.join()` が返すネストした `SQL` インスタンスも
 * `queryChunks` を持つため、追加対応なしに再帰で文字列化できる)。
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

/**
 * `db.transaction(async (tx) => ...)`(§設計決定7)をモックする。`tx.execute` は呼び出し順に
 * `executeQueue` から1件ずつ `[rows, fields]` タプルを払い出す(notes.service.spec.ts の
 * `createMockDb` の `executeQueue` と同じ方式)。GraphService は `select()`/`insert()` 等の
 * クエリビルダを使わないため、`transaction` 以外のメソッドはモックしない。
 */
function createMockDb(executeQueue: [unknown[], unknown[]][]) {
  const queue = [...executeQueue];
  const execute = vi
    .fn()
    .mockImplementation(() => Promise.resolve(queue.length > 0 ? queue.shift() : [[], []]));
  const transaction = vi
    .fn()
    .mockImplementation(async (callback: (tx: { execute: typeof execute }) => Promise<unknown>) =>
      callback({ execute }),
    );
  const db = { transaction } as unknown as Database;
  return { db, execute, transaction };
}

function makeNodeRow(id: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    title: `タイトル${id}`,
    type: "memo",
    bodyPreview: `本文プレビュー${id}`,
    ...overrides,
  };
}

function makeNodeRows(count: number) {
  return Array.from({ length: count }, (_, i) => makeNodeRow(`node-${i}`));
}

function makeEdgeRow(id: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    noteAId: "node-1",
    noteBId: "node-2",
    relationType: "same-theme",
    typeDirection: "none",
    description: "説明文",
    relatedness: "0.50",
    ...overrides,
  };
}

function makeEdgeRows(count: number) {
  return Array.from({ length: count }, (_, i) => makeEdgeRow(`edge-${i}`));
}

describe("toGraphEdgeEndpoints(M2-1 §設計決定3 の変換表)", () => {
  it("a-to-b なら source=note_a_id・target=note_b_id・directed=true", () => {
    expect(toGraphEdgeEndpoints("a-to-b", "note-a", "note-b")).toEqual({
      source: "note-a",
      target: "note-b",
      directed: true,
    });
  });

  it("b-to-a なら source が note_b_id へ反転する(directed=true)", () => {
    const result = toGraphEdgeEndpoints("b-to-a", "note-a", "note-b");
    expect(result.source).toBe("note-b");
    expect(result.target).toBe("note-a");
    expect(result.directed).toBe(true);
  });

  it("none なら source=note_a_id・target=note_b_id のまま directed=false", () => {
    expect(toGraphEdgeEndpoints("none", "note-a", "note-b")).toEqual({
      source: "note-a",
      target: "note-b",
      directed: false,
    });
  });
});

describe("GraphService.findGraph", () => {
  it("ノート0件のユーザーは空配列と processingNoteCount:0 を返し、エッジ SQL を発行しない(受入条件7・12)", async () => {
    const { db, execute, transaction } = createMockDb([
      [[{ count: 0 }], []],
      [[], []],
    ]);
    const service = new GraphService(db);

    const result = await service.findGraph("user-1");

    expect(result).toEqual({
      nodes: [],
      edges: [],
      truncated: { nodes: false, edges: false },
      processingNoteCount: 0,
    });
    // 件数 → ノードの2回のみ。ノードが0件のためエッジ SQL は発行されない(空 IN() 回避)。
    expect(execute).toHaveBeenCalledTimes(2);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("3クエリが単一トランザクション内で「件数 → ノード → エッジ」の順に実行され、ノード SQL・エッジ SQL に ORDER BY と LIMIT(上限+1件)が含まれる(受入条件8。モックが上限内・期待順の行を返す他のテストでは検出できない ORDER BY・LIMIT 欠落への退行の回帰観点)", async () => {
    const { db, execute, transaction } = createMockDb([
      [[{ count: 1 }], []],
      [makeNodeRows(1), []],
      [[], []],
    ]);
    const service = new GraphService(db);

    await service.findGraph("user-1");

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(3);
    const [countSql, nodeSql, edgeSql] = execute.mock.calls.map(([query]) =>
      extractSqlText(query).replace(/\s+/g, " "),
    );
    expect(countSql).toContain("SELECT COUNT(*) AS count FROM notes");
    expect(nodeSql).toContain("FROM notes AS n");
    expect(edgeSql).toContain("FROM note_relations AS nr");

    // ORDER BY・LIMIT が削除されると、ノード SQL では古いノートが新しい順の代わりに残り、
    // エッジ SQL では relatedness の低いエッジが残る・全行取得によりハードキャップが形骸化する
    // (§設計決定4)。LIMIT の数値は定数から組み立て、定数を変更した場合にテストが追随するように
    // する。
    expect(nodeSql).toContain("ORDER BY n.created_at DESC, n.id DESC");
    expect(nodeSql).toContain(`LIMIT ${GRAPH_NODE_LIMIT + 1}`);
    expect(edgeSql).toContain("ORDER BY nr.relatedness DESC, nr.id ASC");
    expect(edgeSql).toContain(`LIMIT ${GRAPH_EDGE_LIMIT + 1}`);
  });

  it("ノード上限ちょうど(GRAPH_NODE_LIMIT件)では truncated.nodes が false", async () => {
    const nodeRows = makeNodeRows(GRAPH_NODE_LIMIT);
    const { db } = createMockDb([
      [[{ count: 0 }], []],
      [nodeRows, []],
      [[], []],
    ]);
    const service = new GraphService(db);

    const result = await service.findGraph("user-1");

    expect(result.truncated.nodes).toBe(false);
    expect(result.nodes).toHaveLength(GRAPH_NODE_LIMIT);
  });

  it("ノード上限超過(GRAPH_NODE_LIMIT+1件)では truncated.nodes が true・先頭 GRAPH_NODE_LIMIT 件へ切り詰め、エッジ SQL は note_a_id・note_b_id 双方を AND で絞り込み、双方のバインド値が切り詰め後のノード ID 集合と過不足なく一致する(誘導部分グラフ。指摘[1]の回帰観点。受入条件4・5)", async () => {
    const nodeRows = makeNodeRows(GRAPH_NODE_LIMIT + 1);
    const { db, execute } = createMockDb([
      [[{ count: 0 }], []],
      [nodeRows, []],
      [[], []],
    ]);
    const service = new GraphService(db);

    const result = await service.findGraph("user-1");

    expect(result.truncated.nodes).toBe(true);
    expect(result.nodes).toHaveLength(GRAPH_NODE_LIMIT);
    // created_at DESC で先頭(新しい順)が残る。ここでは配列順=作成順の代替として
    // node-0(先頭)〜node-299(300番目)が残り、node-300(301番目)が切り捨てられる。
    expect(result.nodes[0]?.id).toBe("node-0");
    expect(result.nodes[GRAPH_NODE_LIMIT - 1]?.id).toBe("node-299");

    // エッジ SQL(3回目の execute 呼び出し)を検証する。順序を逆にする(先にエッジを取得して
    // から端点フィルタする)と、上限外ノートの高関連度エッジが900枠を占有してしまう(指摘[1])。
    const edgeSqlText = extractSqlText(execute.mock.calls[2]?.[0]).replace(/\s+/g, " ");
    const expectedNodeIds = result.nodes.map((node) => node.id);

    // note_a_id と note_b_id 双方の IN 句が存在し、AND で結ばれていることを構造的に確認する
    // (note_a_id だけを絞る実装や、両者を OR で結ぶ実装はこの正規表現にマッチせず落ちる)。
    expect(edgeSqlText).toMatch(/nr\.note_a_id IN \([^)]*\) AND nr\.note_b_id IN \([^)]*\)/);

    // 双方の IN 句のバインド値を個別に取り出し、切り詰め後のノード ID 集合(300件・順序も含む)
    // と完全一致することを確認する。過不足があれば(片方だけ絞られる・切り捨てたノードが
    // 混入する等)ここで検出できる。
    const noteAIdsMatch = /nr\.note_a_id IN \(([^)]*)\)/.exec(edgeSqlText);
    const noteBIdsMatch = /nr\.note_b_id IN \(([^)]*)\)/.exec(edgeSqlText);
    const noteAIds = (noteAIdsMatch?.[1] ?? "").split(",").map((id) => id.trim());
    const noteBIds = (noteBIdsMatch?.[1] ?? "").split(",").map((id) => id.trim());
    expect(noteAIds).toEqual(expectedNodeIds);
    expect(noteBIds).toEqual(expectedNodeIds);
    expect(noteAIds).not.toContain("node-300");
    expect(noteBIds).not.toContain("node-300");
  });

  it("エッジ上限ちょうど(GRAPH_EDGE_LIMIT件)では truncated.edges が false", async () => {
    const { db } = createMockDb([
      [[{ count: 0 }], []],
      [makeNodeRows(2), []],
      [makeEdgeRows(GRAPH_EDGE_LIMIT), []],
    ]);
    const service = new GraphService(db);

    const result = await service.findGraph("user-1");

    expect(result.truncated.edges).toBe(false);
    expect(result.edges).toHaveLength(GRAPH_EDGE_LIMIT);
  });

  it("エッジ上限超過(GRAPH_EDGE_LIMIT+1件)では truncated.edges が true・先頭 GRAPH_EDGE_LIMIT 件(relatedness 降順の先頭)へ切り詰める(受入条件6)", async () => {
    const { db } = createMockDb([
      [[{ count: 0 }], []],
      [makeNodeRows(2), []],
      [makeEdgeRows(GRAPH_EDGE_LIMIT + 1), []],
    ]);
    const service = new GraphService(db);

    const result = await service.findGraph("user-1");

    expect(result.truncated.edges).toBe(true);
    expect(result.edges).toHaveLength(GRAPH_EDGE_LIMIT);
    expect(result.edges[0]?.id).toBe("edge-0");
    expect(result.edges[GRAPH_EDGE_LIMIT - 1]?.id).toBe(`edge-${GRAPH_EDGE_LIMIT - 1}`);
  });

  it.each([
    ["1.00", 1],
    ["0.00", 0],
    ["0.10", 0.1],
  ])(
    "relatedness(decimal 列)は文字列 %s から数値 %d へ変換される(mysql2 既定設定では文字列で返るため)",
    async (raw, expected) => {
      const { db } = createMockDb([
        [[{ count: 0 }], []],
        [makeNodeRows(2), []],
        [[makeEdgeRow("edge-1", { relatedness: raw })], []],
      ]);
      const service = new GraphService(db);

      const result = await service.findGraph("user-1");

      expect(result.edges[0]?.relatedness).toBe(expected);
      expect(typeof result.edges[0]?.relatedness).toBe("number");
    },
  );

  it("processingNoteCount は COUNT(*) が文字列で返っても Number() で数値へ正規化される", async () => {
    const { db } = createMockDb([
      [[{ count: "7" }], []],
      [[], []],
    ]);
    const service = new GraphService(db);

    const result = await service.findGraph("user-1");

    expect(result.processingNoteCount).toBe(7);
    expect(typeof result.processingNoteCount).toBe("number");
  });

  it("処理中件数 SQL が(理論上あり得ないが)0行を返した場合でも processingNoteCount は 0 になる防御分岐", async () => {
    const { db } = createMockDb([
      [[], []],
      [[], []],
    ]);
    const service = new GraphService(db);

    const result = await service.findGraph("user-1");

    expect(result.processingNoteCount).toBe(0);
  });

  it("bodyPreview が NULL(スクショノート)の場合はそのまま null を返す", async () => {
    const { db } = createMockDb([
      [[{ count: 0 }], []],
      [[makeNodeRow("node-1", { bodyPreview: null })], []],
      [[], []],
    ]);
    const service = new GraphService(db);

    const result = await service.findGraph("user-1");

    expect(result.nodes[0]?.bodyPreview).toBeNull();
  });

  it("bodyPreview が空文字の場合はそのまま空文字を返す", async () => {
    const { db } = createMockDb([
      [[{ count: 0 }], []],
      [[makeNodeRow("node-1", { bodyPreview: "" })], []],
      [[], []],
    ]);
    const service = new GraphService(db);

    const result = await service.findGraph("user-1");

    expect(result.nodes[0]?.bodyPreview).toBe("");
  });

  it("発行される3クエリのいずれにも embedding 列名・SELECT * 相当が含まれない(受入条件11。D0 指摘[4]の回帰観点)", async () => {
    const { db, execute } = createMockDb([
      [[{ count: 0 }], []],
      [makeNodeRows(1), []],
      [makeEdgeRows(1), []],
    ]);
    const service = new GraphService(db);

    await service.findGraph("user-1");

    expect(execute).toHaveBeenCalledTimes(3);
    for (const [query] of execute.mock.calls) {
      const text = extractSqlText(query);
      // 単語境界付きで `embedding` 単体のみを検出する。禁止対象は raw VECTOR 列
      // (`notes.embedding`)であって、`embedding_fingerprint` / `embedding_model` という
      // 別の varchar 列ではない(前者は §設計決定6 条件(d) が WHERE で参照することを
      // 要求している正当な列であり、`\b` は `g` と `_` の間で一致しないため除外される)。
      expect(text).not.toMatch(/\bembedding\b/i);
      expect(text).not.toMatch(/select\s*\*/i);
    }
    // エッジ SQL は notes を JOIN しない(§設計決定4の副次効果。誘導部分グラフ方式のため
    // 相手ノートの列を読む必要が無い)。
    const edgeSqlText = extractSqlText(execute.mock.calls[2]?.[0]);
    expect(edgeSqlText).not.toContain("FROM notes");
    expect(edgeSqlText).not.toContain("JOIN notes");
  });
});
