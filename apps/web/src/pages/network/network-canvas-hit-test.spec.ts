import type { GraphViewLink, GraphViewNode } from "@/features/graph/to-graph-data";
import type { LabelMeasureContext } from "./network-canvas-hit-test";
import {
  distanceToSegment,
  hitTestLinks,
  hitTestNodes,
  linkHitHalfWidth,
  nodeHitRadius,
} from "./network-canvas-hit-test";

/**
 * force-graph がレイアウト確定後に書き込む `x`/`y` を付与したノード。`GraphViewNode` の型は
 * `x`/`y` を持たない(実装時に絞り込む内部型 `PositionedGraphNode` はこのファイルの外へ
 * export されていないため、テストでは構造的に同じ形のオブジェクトリテラルで代用する)。
 */
type PositionedNode = GraphViewNode & { x: number; y: number };

function positionedNode(overrides: Partial<PositionedNode> = {}): PositionedNode {
  return {
    id: "n1",
    label: "ノード",
    type: "memo",
    degree: 0,
    x: 0,
    y: 0,
    ...overrides,
  };
}

function positionedLink(
  overrides: Partial<GraphViewLink> & {
    source: string | GraphViewNode;
    target: string | GraphViewNode;
  },
): GraphViewLink {
  return {
    id: "e1",
    directed: false,
    relationType: "same-theme",
    description: "",
    relatedness: 0,
    ...overrides,
  };
}

// 既知幅を返すフェイク ctx。`hitTestNodes` のラベル矩形判定の期待値はこの幅からの手計算。
function fakeMeasureContext(width: number): LabelMeasureContext {
  return {
    font: "",
    textAlign: "center",
    textBaseline: "alphabetic",
    measureText: () => ({ width }) as TextMetrics,
  };
}

describe("distanceToSegment", () => {
  it("線分の内側の垂線距離を返す", () => {
    expect(distanceToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(3);
  });

  it("線分の外側では端点までの距離を返す", () => {
    expect(distanceToSegment({ x: 13, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
  });

  it("退化線分(a === b)は点との距離になる", () => {
    expect(distanceToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5);
  });
});

describe("nodeHitRadius", () => {
  it("degree 0, globalScale 1 のとき下限の 10", () => {
    expect(nodeHitRadius({ id: "n1", label: "n", type: "memo", degree: 0 }, 1)).toBe(10);
  });

  it("degree 0, globalScale 5 のとき実半径の 3", () => {
    expect(nodeHitRadius({ id: "n1", label: "n", type: "memo", degree: 0 }, 5)).toBe(3);
  });

  it("degree 8, globalScale 5 のとき実半径の 9", () => {
    expect(nodeHitRadius({ id: "n1", label: "n", type: "memo", degree: 8 }, 5)).toBe(9);
  });

  it("degree 6, globalScale 0.5 のとき下限の 20", () => {
    expect(nodeHitRadius({ id: "n1", label: "n", type: "memo", degree: 6 }, 0.5)).toBe(20);
  });
});

describe("hitTestNodes", () => {
  it("円の内側は当たる", () => {
    const node = positionedNode({ x: 0, y: 0, degree: 0 });

    expect(hitTestNodes([node], { x: 5, y: 0 }, 1, null)).toBe(node);
  });

  it("境界ちょうど(距離 = 半径)は当たる", () => {
    const node = positionedNode({ x: 0, y: 0, degree: 0 });

    expect(hitTestNodes([node], { x: 10, y: 0 }, 1, null)).toBe(node);
  });

  it("円の外側は null", () => {
    const node = positionedNode({ x: 0, y: 0, degree: 0 });

    expect(hitTestNodes([node], { x: 11, y: 0 }, 1, null)).toBeNull();
  });

  it("重なる2ノードでは後から描かれる(index の大きい)ほうを優先する", () => {
    const behind = positionedNode({ id: "behind", x: 0, y: 0, degree: 0 });
    const front = positionedNode({ id: "front", x: 0, y: 0, degree: 0 });

    expect(hitTestNodes([behind, front], { x: 0, y: 0 }, 1, null)).toBe(front);
  });

  it("座標未確定のノードは無視する", () => {
    const bareNode: GraphViewNode = { id: "n1", label: "ノード", type: "memo", degree: 0 };

    expect(hitTestNodes([bareNode], { x: 0, y: 0 }, 1, null)).toBeNull();
  });

  describe("ラベル背景板の矩形判定(globalScale = 2, node(10, 20), degree 0 → 円半径 5)", () => {
    it("矩形内側(円の外)は当たる", () => {
      const node = positionedNode({ x: 10, y: 20, degree: 0 });
      const measureCtx = fakeMeasureContext(40);

      expect(hitTestNodes([node], { x: 10, y: 27 }, 2, measureCtx)).toBe(node);
    });

    it("矩形外側は null", () => {
      const node = positionedNode({ x: 10, y: 20, degree: 0 });
      const measureCtx = fakeMeasureContext(40);

      expect(hitTestNodes([node], { x: 10, y: 40 }, 2, measureCtx)).toBeNull();
    });

    it("measureCtx が null なら矩形判定をしない", () => {
      const node = positionedNode({ x: 10, y: 20, degree: 0 });

      expect(hitTestNodes([node], { x: 10, y: 27 }, 2, null)).toBeNull();
    });

    it("globalScale がしきい値(LABEL_MIN_GLOBAL_SCALE)未満なら矩形判定をしない", () => {
      // degree 0, globalScale 0.5 → 円半径は下限の 20。半径の外側の点で検証する。
      const node = positionedNode({ x: 10, y: 20, degree: 0 });
      const measureCtx = fakeMeasureContext(40);

      expect(hitTestNodes([node], { x: 10, y: 45 }, 0.5, measureCtx)).toBeNull();
    });
  });
});

describe("linkHitHalfWidth", () => {
  it("relatedness 0, globalScale 1 のとき 6.5", () => {
    const link = positionedLink({ source: "n1", target: "n2", relatedness: 0 });

    expect(linkHitHalfWidth(link, 1)).toBe(6.5);
  });

  it("relatedness 1, globalScale 2 のとき 4.25", () => {
    const link = positionedLink({ source: "n1", target: "n2", relatedness: 1 });

    expect(linkHitHalfWidth(link, 2)).toBe(4.25);
  });
});

describe("hitTestLinks", () => {
  it("線分近傍(距離 ≤ 半幅)は当たる", () => {
    const source = positionedNode({ id: "n1", x: 0, y: 0 });
    const target = positionedNode({ id: "n2", x: 10, y: 0 });
    const link = positionedLink({ source, target, relatedness: 0 });

    // globalScale 1, relatedness 0 → 半幅 6.5。(5, 3) は距離 3 で半幅以内。
    expect(hitTestLinks([link], { x: 5, y: 3 }, 1)).toBe(link);
  });

  it("線分から離れていれば null", () => {
    const source = positionedNode({ id: "n1", x: 0, y: 0 });
    const target = positionedNode({ id: "n2", x: 10, y: 0 });
    const link = positionedLink({ source, target, relatedness: 0 });

    expect(hitTestLinks([link], { x: 5, y: 20 }, 1)).toBeNull();
  });

  it("端点が文字列のままの link(初回レイアウト前)は無視する", () => {
    const link = positionedLink({ source: "n1", target: "n2", relatedness: 0 });

    expect(hitTestLinks([link], { x: 5, y: 3 }, 1)).toBeNull();
  });

  it("両端がノードオブジェクトでも座標が未確定なら無視する", () => {
    const source: GraphViewNode = { id: "n1", label: "ノード1", type: "memo", degree: 0 };
    const target: GraphViewNode = { id: "n2", label: "ノード2", type: "memo", degree: 0 };
    const link = positionedLink({ source, target, relatedness: 0 });

    expect(hitTestLinks([link], { x: 50, y: 0 }, 1)).toBeNull();
  });

  it("重なる2線では後から描かれる(index の大きい)ほうを優先する", () => {
    const source = positionedNode({ id: "n1", x: 0, y: 0 });
    const target = positionedNode({ id: "n2", x: 10, y: 0 });
    const behind = positionedLink({ id: "behind", source, target, relatedness: 0 });
    const front = positionedLink({ id: "front", source, target, relatedness: 0 });

    expect(hitTestLinks([behind, front], { x: 5, y: 3 }, 1)).toBe(front);
  });
});
