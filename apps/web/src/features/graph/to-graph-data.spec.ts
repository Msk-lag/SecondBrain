import type { GraphResponse } from "@secondbrain/shared";
import { linkEndpointId, toGraphData } from "./to-graph-data";

function makeResponse(overrides: Partial<GraphResponse> = {}): GraphResponse {
  return {
    nodes: [],
    edges: [],
    truncated: { nodes: false, edges: false },
    processingNoteCount: 0,
    ...overrides,
  };
}

describe("toGraphData", () => {
  it("ノード0件・エッジ0件のとき空の nodes/links/adjacency を返す", () => {
    const { graphData, adjacency } = toGraphData(makeResponse());
    expect(graphData.nodes).toEqual([]);
    expect(graphData.links).toEqual([]);
    expect(adjacency.size).toBe(0);
  });

  it("孤立ノードのみのとき degree=0 で adjacency も空になる", () => {
    const response = makeResponse({
      nodes: [{ id: "note-1", title: "孤立ノート", type: "memo", bodyPreview: "本文" }],
    });

    const { graphData, adjacency } = toGraphData(response);

    expect(graphData.nodes).toEqual([
      { id: "note-1", label: "孤立ノート", type: "memo", degree: 0 },
    ]);
    expect(adjacency.get("note-1")).toBeUndefined();
  });

  it("title が無いノードは getDisplayTitle により bodyPreview から仮タイトルを補う", () => {
    const response = makeResponse({
      nodes: [{ id: "note-1", title: null, bodyPreview: null, type: "screenshot" }],
    });

    const { graphData } = toGraphData(response);

    expect(graphData.nodes[0]?.label).toBe("無題");
  });

  it("全ノード接続済みのとき、両端の degree が加算され source/target 双方で数えられる", () => {
    const response = makeResponse({
      nodes: [
        { id: "a", title: "A", type: "memo", bodyPreview: null },
        { id: "b", title: "B", type: "memo", bodyPreview: null },
        { id: "c", title: "C", type: "memo", bodyPreview: null },
      ],
      edges: [
        {
          id: "e1",
          source: "a",
          target: "b",
          directed: true,
          relationType: "cause-solution",
          description: "説明1",
          relatedness: 0.5,
        },
        {
          id: "e2",
          source: "b",
          target: "c",
          directed: false,
          relationType: "same-theme",
          description: "説明2",
          relatedness: 0.9,
        },
      ],
    });

    const { graphData } = toGraphData(response);
    const degreeById = new Map(graphData.nodes.map((n) => [n.id, n.degree]));

    // b は e1 の target と e2 の source の両方の端点になっているため degree=2。
    expect(degreeById.get("a")).toBe(1);
    expect(degreeById.get("b")).toBe(2);
    expect(degreeById.get("c")).toBe(1);
  });

  it("links は API レスポンスの edges とは別の新しいオブジェクトである(浅いコピーでない)", () => {
    const edge = {
      id: "e1",
      source: "a",
      target: "b",
      directed: true,
      relationType: "cause-solution" as const,
      description: "説明",
      relatedness: 0.5,
    };
    const response = makeResponse({
      nodes: [
        { id: "a", title: "A", type: "memo", bodyPreview: null },
        { id: "b", title: "B", type: "memo", bodyPreview: null },
      ],
      edges: [edge],
    });

    const { graphData } = toGraphData(response);

    expect(graphData.links).toHaveLength(1);
    expect(graphData.links[0]).not.toBe(edge);
    expect(graphData.links[0]).toEqual(edge);
    // nodes 側も入力オブジェクトそのものではないこと。
    expect(graphData.nodes[0]).not.toBe(response.nodes[0]);
  });

  // M2-2 §設計決定2 の最重要の罠に対する退行検知(2026-08-19 独立議論で Codex が指摘)。
  // react-force-graph は渡した links の source/target をノードオブジェクト参照へ
  // 破壊的に書き換える。adjacency が links と同一オブジェクトを参照していると、この
  // 破壊的変更が選択パネル側へ漏れて両端 ID が壊れる。
  it("links の要素を破壊的に書き換えても adjacency 側は影響を受けない", () => {
    const response = makeResponse({
      nodes: [
        { id: "a", title: "A", type: "memo", bodyPreview: null },
        { id: "b", title: "B", type: "memo", bodyPreview: null },
      ],
      edges: [
        {
          id: "e1",
          source: "a",
          target: "b",
          directed: true,
          relationType: "cause-solution",
          description: "説明",
          relatedness: 0.5,
        },
      ],
    });

    const { graphData, adjacency } = toGraphData(response);

    // react-force-graph が行うのと同様に、link オブジェクトの source/target を
    // 文字列からノードオブジェクト参照へ書き換える(force-graph の実挙動の再現)。
    const link = graphData.links[0] as unknown as { source: unknown; target: unknown };
    const nodeA = graphData.nodes[0];
    const nodeB = graphData.nodes[1];
    link.source = nodeA;
    link.target = nodeB;

    const entryForA = adjacency.get("a");
    const entryForB = adjacency.get("b");
    expect(entryForA).toEqual([
      {
        edge: {
          id: "e1",
          directed: true,
          relationType: "cause-solution",
          description: "説明",
          relatedness: 0.5,
        },
        otherNodeId: "b",
        direction: "outgoing",
      },
    ]);
    expect(entryForB).toEqual([
      {
        edge: {
          id: "e1",
          directed: true,
          relationType: "cause-solution",
          description: "説明",
          relatedness: 0.5,
        },
        otherNodeId: "a",
        direction: "incoming",
      },
    ]);
    // adjacency のエントリは links の要素と同一オブジェクトを共有していない。
    expect(adjacency.get("a")?.[0]?.edge).not.toBe(graphData.links[0]);
  });

  // Codex 指摘(HIGH): adjacency から向きが失われ、接続ノード一覧で outgoing/incoming
  // を判別できない問題の退行検知。source 側と target 側で反対の direction になること、
  // directed === false のときは両側とも "none" になることを確認する。
  it("有向エッジは source 側が outgoing・target 側が incoming になる", () => {
    const response = makeResponse({
      nodes: [
        { id: "a", title: "A", type: "memo", bodyPreview: null },
        { id: "b", title: "B", type: "memo", bodyPreview: null },
      ],
      edges: [
        {
          id: "e1",
          source: "a",
          target: "b",
          directed: true,
          relationType: "cause-solution",
          description: "説明",
          relatedness: 0.5,
        },
      ],
    });

    const { adjacency } = toGraphData(response);

    expect(adjacency.get("a")?.[0]?.direction).toBe("outgoing");
    expect(adjacency.get("b")?.[0]?.direction).toBe("incoming");
  });

  it("無向エッジ(directed=false)は source 側・target 側とも direction が none になる", () => {
    const response = makeResponse({
      nodes: [
        { id: "a", title: "A", type: "memo", bodyPreview: null },
        { id: "b", title: "B", type: "memo", bodyPreview: null },
      ],
      edges: [
        {
          id: "e1",
          source: "a",
          target: "b",
          directed: false,
          relationType: "same-theme",
          description: "説明",
          relatedness: 0.5,
        },
      ],
    });

    const { adjacency } = toGraphData(response);

    expect(adjacency.get("a")?.[0]?.direction).toBe("none");
    expect(adjacency.get("b")?.[0]?.direction).toBe("none");
  });
});

// 受入条件5・実装手順4(a): `linkEndpointId()` の単体テスト。文字列ケース・
// オブジェクトケースの両方が必須(片方だけだと他方の退行を検知できない)。
describe("linkEndpointId", () => {
  it("文字列を渡すとそのまま返す", () => {
    expect(linkEndpointId("note-1")).toBe("note-1");
  });

  it("GraphViewNode オブジェクトを渡すと .id を返す", () => {
    expect(linkEndpointId({ id: "note-2", label: "ノート2", type: "memo", degree: 1 })).toBe(
      "note-2",
    );
  });
});
