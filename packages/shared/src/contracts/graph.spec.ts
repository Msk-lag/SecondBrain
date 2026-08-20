import { graphContract, graphEdgeSchema, graphNodeSchema, graphResponseSchema } from "./graph.js";

describe("graphNodeSchema", () => {
  const valid = {
    id: "note-1",
    title: "タイトル",
    type: "memo",
    bodyPreview: "本文冒頭の抜粋",
  };

  it("正常なノードを受理する", () => {
    expect(graphNodeSchema.safeParse(valid).success).toBe(true);
  });

  it("title/bodyPreview に null を受理する(未入力・screenshot ノートの body 無し)", () => {
    const result = graphNodeSchema.safeParse({ ...valid, title: null, bodyPreview: null });
    expect(result.success).toBe(true);
  });

  it("不正な type(3値以外)を拒否する", () => {
    const result = graphNodeSchema.safeParse({ ...valid, type: "invalid" });
    expect(result.success).toBe(false);
  });
});

describe("graphEdgeSchema", () => {
  const valid = {
    id: "rel-1",
    source: "note-1",
    target: "note-2",
    directed: true,
    relationType: "cause-solution",
    description: "原因と解決策の関係にあるため",
    relatedness: 0.8,
  };

  it("正常なエッジを受理する", () => {
    expect(graphEdgeSchema.safeParse(valid).success).toBe(true);
  });

  it("directed: false(向きの無い関係)を受理する", () => {
    const result = graphEdgeSchema.safeParse({ ...valid, directed: false });
    expect(result.success).toBe(true);
  });

  it("relatedness が範囲外(下限未満)の場合を拒否する", () => {
    const result = graphEdgeSchema.safeParse({ ...valid, relatedness: -0.1 });
    expect(result.success).toBe(false);
  });

  it("relatedness が範囲外(上限超過)の場合を拒否する", () => {
    const result = graphEdgeSchema.safeParse({ ...valid, relatedness: 1.1 });
    expect(result.success).toBe(false);
  });

  it("description が 500 文字を超える場合を拒否する", () => {
    const result = graphEdgeSchema.safeParse({ ...valid, description: "a".repeat(501) });
    expect(result.success).toBe(false);
  });

  it("relationType が語彙外の場合を拒否する", () => {
    const result = graphEdgeSchema.safeParse({ ...valid, relationType: "unknown-type" });
    expect(result.success).toBe(false);
  });
});

describe("graphResponseSchema", () => {
  it("空配列 + truncated 双方 false + processingNoteCount 0 を受理する", () => {
    const result = graphResponseSchema.safeParse({
      nodes: [],
      edges: [],
      truncated: { nodes: false, edges: false },
      processingNoteCount: 0,
    });
    expect(result.success).toBe(true);
  });

  it("processingNoteCount が負数の場合を拒否する", () => {
    const result = graphResponseSchema.safeParse({
      nodes: [],
      edges: [],
      truncated: { nodes: false, edges: false },
      processingNoteCount: -1,
    });
    expect(result.success).toBe(false);
  });

  it("processingNoteCount が小数の場合を拒否する", () => {
    const result = graphResponseSchema.safeParse({
      nodes: [],
      edges: [],
      truncated: { nodes: false, edges: false },
      processingNoteCount: 1.5,
    });
    expect(result.success).toBe(false);
  });
});

describe("graphContract", () => {
  it("get の method/path が GET /graph である", () => {
    expect(graphContract.get.method).toBe("GET");
    expect(graphContract.get.path).toBe("/graph");
  });
});
