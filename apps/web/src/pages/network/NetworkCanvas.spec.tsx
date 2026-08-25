import { act, fireEvent, render, screen } from "@testing-library/react";
import type { GraphViewData, GraphViewLink, GraphViewNode } from "@/features/graph/to-graph-data";

/**
 * `react-force-graph-2d` は jsdom に canvas が無く実描画できないため、渡された props を
 * module スコープへ捕捉するスタブへ差し替える(M2-2 §設計決定8)。spec からアクセサ props を
 * 直接呼んで検証する。
 */
interface MockCanvasContext {
  font: string;
  textAlign: string;
  textBaseline: string;
  fillStyle: string;
  fillText: ReturnType<typeof vi.fn>;
  measureText: ReturnType<typeof vi.fn>;
  fillRect: ReturnType<typeof vi.fn>;
  beginPath: ReturnType<typeof vi.fn>;
  arc: ReturnType<typeof vi.fn>;
  fill: ReturnType<typeof vi.fn>;
}

interface CapturedForceGraphProps {
  graphData: GraphViewData;
  width: number;
  height: number;
  nodeVal: (node: GraphViewNode) => number;
  nodeColor: (node: GraphViewNode) => string;
  nodeCanvasObjectMode: () => string;
  nodeCanvasObject: (
    node: GraphViewNode & { x: number; y: number },
    ctx: MockCanvasContext,
    globalScale: number,
  ) => void;
  linkWidth: (link: GraphViewLink) => number;
  linkDirectionalArrowLength: (link: GraphViewLink) => number;
  linkColor: (link: GraphViewLink) => string;
  linkHoverPrecision: number;
  nodeRelSize: number;
  nodePointerAreaPaint: (
    node: GraphViewNode & { x: number; y: number },
    color: string,
    ctx: MockCanvasContext,
    globalScale: number,
  ) => void;
  onNodeClick: (node: GraphViewNode, event: MouseEvent) => void;
  onLinkClick: (link: GraphViewLink, event: MouseEvent) => void;
  onBackgroundClick: (event: MouseEvent) => void;
  onEngineStop: () => void;
  // React 19 では関数コンポーネントが `ref` を通常の prop として受け取れる
  // (`forwardRef` 不要)。実物の `ForceGraphMethods` の代わりに `zoomToFit` /
  // `screen2GraphCoords`(恒等関数)/ `zoom`(常に 1)だけを持つスタブをこの ref へ差し込む。
  ref?: {
    current:
      | {
          zoomToFit: ReturnType<typeof vi.fn>;
          screen2GraphCoords: (x: number, y: number) => { x: number; y: number };
          zoom: () => number;
        }
      | undefined;
  };
}

const state = vi.hoisted(() => ({
  props: undefined as CapturedForceGraphProps | undefined,
  zoomToFit: undefined as ReturnType<typeof vi.fn> | undefined,
}));

vi.mock("react-force-graph-2d", () => ({
  default: (props: CapturedForceGraphProps) => {
    state.props = props;
    if (props.ref) {
      state.zoomToFit = vi.fn();
      props.ref.current = {
        zoomToFit: state.zoomToFit,
        // グラフ座標変換は恒等関数として扱う(スタブなのでスクリーン座標=グラフ座標)。
        screen2GraphCoords: (x, y) => ({ x, y }),
        zoom: () => 1,
      };
    }
    return <div data-testid="force-graph-2d-stub" />;
  },
}));

import { NetworkCanvas, type NetworkCanvasProps } from "./NetworkCanvas";
import {
  DEGREE_ZERO_OPACITY,
  LABEL_BASE_FONT_SIZE,
  LABEL_MIN_GLOBAL_SCALE,
  NODE_LABEL_COLOR,
  NODE_TYPE_COLORS,
  SELECTED_NODE_COLOR,
} from "./network-canvas-theme";

type ResizeCallback = ConstructorParameters<typeof ResizeObserver>[0];

// apps/web/src/features/graph/use-element-size.spec.tsx と同じスタブ
// (jsdom の no-op スタブでは計測値が確定しないため、実際に通知を発火させる)。
class MockResizeObserver {
  static readonly instances: MockResizeObserver[] = [];
  callback: ResizeCallback;
  observedElements: Element[] = [];

  constructor(callback: ResizeCallback) {
    this.callback = callback;
    MockResizeObserver.instances.push(this);
  }

  observe(element: Element): void {
    this.observedElements.push(element);
  }

  unobserve(): void {
    // 未使用。
  }

  disconnect(): void {
    // 未使用。
  }

  trigger(contentRect: { width: number; height: number }): void {
    this.callback([{ contentRect } as unknown as ResizeObserverEntry], this);
  }
}

function baseGraphData(): GraphViewData {
  return {
    nodes: [{ id: "n1", label: "メモ1", type: "memo", degree: 2 }],
    links: [
      {
        id: "e1",
        source: "n1",
        target: "n2",
        directed: true,
        relationType: "cause-solution",
        description: "説明",
        relatedness: 0.5,
      },
    ],
  };
}

function renderCanvas(overrides: Partial<NetworkCanvasProps> = {}) {
  const graphData = overrides.graphData ?? baseGraphData();
  const onNodeClick = vi.fn();
  const onLinkClick = vi.fn();
  const onBackgroundClick = vi.fn();
  const utils = render(
    <NetworkCanvas
      graphData={graphData}
      selectedNodeId={null}
      onNodeClick={onNodeClick}
      onLinkClick={onLinkClick}
      onBackgroundClick={onBackgroundClick}
      {...overrides}
    />,
  );
  return { ...utils, graphData, onNodeClick, onLinkClick, onBackgroundClick };
}

function resizeTo(width: number, height: number): void {
  const observer = MockResizeObserver.instances[MockResizeObserver.instances.length - 1];
  act(() => {
    observer?.trigger({ width, height });
  });
}

// nodeCanvasObject / nodePointerAreaPaint の両方の describe で共用する canvas context スタブ
// (sonarjs/no-identical-functions: describe ごとに同一実装のローカル関数を定義しない)。
function mockContext(): MockCanvasContext {
  return {
    font: "",
    textAlign: "",
    textBaseline: "",
    fillStyle: "",
    fillText: vi.fn(),
    // 既知の固定幅を返すスタブ。受入条件6の期待値をこの幅から手計算する。
    measureText: vi.fn(() => ({ width: 40 })),
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
  };
}

// linkWidth / linkColor(いずれも relatedness だけが違う link を要する)で共用するファクトリ
// (sonarjs/no-identical-functions: describe ごとに同一実装のローカル関数を定義しない)。
function relatednessLink(relatedness: number): GraphViewLink {
  return {
    id: "e1",
    source: "n1",
    target: "n2",
    directed: false,
    relationType: "same-theme",
    description: "説明",
    relatedness,
  };
}

// 幾何フォールバック(Brave 対策)の各テストで共用する、座標つきの2ノード+それを結ぶ線の
// フィクスチャ(sonarjs/no-identical-functions: it ごとに同一の組み立てを書かない)。
// nodeA(0,0)・nodeB(100,0)、degree 1 → 判定円の半径は 10(√2 × 3 ≈ 4.24 < 10)。
// relatedness 0.5 → 線の判定半幅は globalScale 1 のとき 7.5。
function twoNodeLinkFixture(): {
  graphData: GraphViewData;
  nodeA: GraphViewNode;
  nodeB: GraphViewNode;
  link: GraphViewLink;
} {
  const nodeA: GraphViewNode = Object.assign(
    { id: "n1", label: "A", type: "memo" as const, degree: 1 },
    { x: 0, y: 0 },
  );
  const nodeB: GraphViewNode = Object.assign(
    { id: "n2", label: "B", type: "memo" as const, degree: 1 },
    { x: 100, y: 0 },
  );
  const link: GraphViewLink = {
    id: "e1",
    source: nodeA,
    target: nodeB,
    directed: false,
    relationType: "same-theme",
    description: "説明",
    relatedness: 0.5,
  };
  return { graphData: { nodes: [nodeA, nodeB], links: [link] }, nodeA, nodeB, link };
}

describe("NetworkCanvas", () => {
  let originalResizeObserver: typeof ResizeObserver;

  beforeEach(() => {
    state.props = undefined;
    state.zoomToFit = undefined;
    originalResizeObserver = globalThis.ResizeObserver;
    MockResizeObserver.instances.length = 0;
    globalThis.ResizeObserver = MockResizeObserver;
    // jsdom は canvas を実装していないため `getContext` が警告を出す
    // ("Error: Not implemented")。`NetworkCanvas` のラベル計測用 ctx 取得
    // (`getMeasureContext`)がこれを呼ぶため null を返すよう固定し、ノイズを抑止する
    // (ラベル矩形の判定は省略される。円の判定は影響しない)。
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  });

  afterEach(() => {
    globalThis.ResizeObserver = originalResizeObserver;
  });

  it("計測値が0(初回レンダー)のときは ForceGraph2D を描画しない", () => {
    renderCanvas();

    expect(screen.queryByTestId("force-graph-2d-stub")).not.toBeInTheDocument();
    expect(state.props).toBeUndefined();
  });

  it("計測値が確定すると ForceGraph2D へ graphData とサイズを渡して描画する", () => {
    const { graphData } = renderCanvas();

    resizeTo(640, 480);

    expect(screen.getByTestId("force-graph-2d-stub")).toBeInTheDocument();
    expect(state.props?.graphData).toBe(graphData);
    expect(state.props?.width).toBe(640);
    expect(state.props?.height).toBe(480);
  });

  it("幅のみ確定して高さが0のときは ForceGraph2D を描画しない", () => {
    renderCanvas();

    resizeTo(640, 0);

    expect(screen.queryByTestId("force-graph-2d-stub")).not.toBeInTheDocument();
  });

  it("onNodeClick / onLinkClick をそのまま転送する", () => {
    const { onNodeClick, onLinkClick } = renderCanvas();
    resizeTo(640, 480);

    const node: GraphViewNode = { id: "n1", label: "メモ1", type: "memo", degree: 2 };
    const link: GraphViewLink = {
      id: "e1",
      source: "n1",
      target: "n2",
      directed: true,
      relationType: "cause-solution",
      description: "説明",
      relatedness: 0.5,
    };
    const clickEvent = new MouseEvent("click");

    state.props?.onNodeClick(node, clickEvent);
    state.props?.onLinkClick(link, clickEvent);

    expect(onNodeClick).toHaveBeenCalledWith(node, clickEvent);
    expect(onLinkClick).toHaveBeenCalledWith(link, clickEvent);
  });

  describe("nodeVal(ノードサイズ = 接続数)", () => {
    it("degree = 0 のとき 1(受入条件3の下限)", () => {
      renderCanvas();
      resizeTo(640, 480);

      expect(state.props?.nodeVal({ id: "n1", label: "メモ", type: "memo", degree: 0 })).toBe(1);
    });

    it("degree = 5 のとき 6(1 + degree)", () => {
      renderCanvas();
      resizeTo(640, 480);

      expect(state.props?.nodeVal({ id: "n1", label: "メモ", type: "memo", degree: 5 })).toBe(6);
    });
  });

  describe("linkWidth(線の太さ = 関連度)", () => {
    it("relatedness = 0 のとき 1.0px(受入条件3の下限)", () => {
      renderCanvas();
      resizeTo(640, 480);

      expect(state.props?.linkWidth(relatednessLink(0))).toBe(1);
    });

    it("relatedness = 1 のとき 5.0px(受入条件3の上限)", () => {
      renderCanvas();
      resizeTo(640, 480);

      expect(state.props?.linkWidth(relatednessLink(1))).toBe(5);
    });
  });

  describe("linkDirectionalArrowLength(向き)", () => {
    it("directed = true のとき矢印長 4", () => {
      renderCanvas();
      resizeTo(640, 480);

      expect(
        state.props?.linkDirectionalArrowLength({
          id: "e1",
          source: "n1",
          target: "n2",
          directed: true,
          relationType: "cause-solution",
          description: "説明",
          relatedness: 0.5,
        }),
      ).toBe(4);
    });

    it("directed = false のとき矢印長 0(same-theme/other)", () => {
      renderCanvas();
      resizeTo(640, 480);

      expect(
        state.props?.linkDirectionalArrowLength({
          id: "e1",
          source: "n1",
          target: "n2",
          directed: false,
          relationType: "same-theme",
          description: "説明",
          relatedness: 0.5,
        }),
      ).toBe(0);
    });
  });

  it("linkHoverPrecision に 10 を渡す(エッジの当たり判定を広げる)", () => {
    renderCanvas();
    resizeTo(640, 480);

    expect(state.props?.linkHoverPrecision).toBe(10);
  });

  it("nodeRelSize に 3 を渡す(既定 4 より小さくして線の露出を確保する)", () => {
    renderCanvas();
    resizeTo(640, 480);

    expect(state.props?.nodeRelSize).toBe(3);
  });

  describe("linkColor(線の色 = 関連度で濃淡)", () => {
    it("relatedness = 0 のとき不透明度 0.35 の基準色を返す", () => {
      renderCanvas();
      resizeTo(640, 480);

      expect(state.props?.linkColor(relatednessLink(0))).toBe("rgba(71, 85, 105, 0.35)");
    });

    it("relatedness = 1 のとき不透明度 0.8 の基準色を返す", () => {
      renderCanvas();
      resizeTo(640, 480);

      expect(state.props?.linkColor(relatednessLink(1))).toBe("rgba(71, 85, 105, 0.8)");
    });

    it("relatedness が異なる link には異なる不透明度を返す", () => {
      renderCanvas();
      resizeTo(640, 480);

      const opacityZero = state.props?.linkColor(relatednessLink(0));
      const opacityMid = state.props?.linkColor(relatednessLink(0.5));
      const opacityFull = state.props?.linkColor(relatednessLink(1));

      expect(opacityZero).not.toBe(opacityMid);
      expect(opacityMid).not.toBe(opacityFull);
      expect(opacityZero).not.toBe(opacityFull);
    });
  });

  it("nodeCanvasObjectMode は常に after を返す(既定の円の後に描画する)", () => {
    renderCanvas();
    resizeTo(640, 480);

    expect(state.props?.nodeCanvasObjectMode()).toBe("after");
  });

  describe("nodeColor(ノードの色)", () => {
    it("選択中のノードは種別・次数に関わらず強調色になる", () => {
      renderCanvas({ selectedNodeId: "n1" });
      resizeTo(640, 480);

      expect(state.props?.nodeColor({ id: "n1", label: "メモ", type: "memo", degree: 0 })).toBe(
        SELECTED_NODE_COLOR,
      );
    });

    it("種別ごとに固定色を返す(memo/url/screenshot)", () => {
      renderCanvas();
      resizeTo(640, 480);

      expect(state.props?.nodeColor({ id: "n1", label: "メモ", type: "memo", degree: 3 })).toBe(
        NODE_TYPE_COLORS.memo,
      );
      expect(state.props?.nodeColor({ id: "n2", label: "URL", type: "url", degree: 3 })).toBe(
        NODE_TYPE_COLORS.url,
      );
      expect(state.props?.nodeColor({ id: "n3", label: "SS", type: "screenshot", degree: 3 })).toBe(
        NODE_TYPE_COLORS.screenshot,
      );
    });

    it("次数0の非選択ノードは種別色を減衰(透明度を落と)した rgba になる(§設計決定3)", () => {
      renderCanvas();
      resizeTo(640, 480);

      const color = state.props?.nodeColor({
        id: "n1",
        label: "メモ",
        type: "memo",
        degree: 0,
      });

      expect(color).toBe("rgba(91, 127, 255, " + DEGREE_ZERO_OPACITY + ")");
    });
  });

  describe("nodeCanvasObject(ラベル描画)", () => {
    it("globalScale がしきい値未満のときはラベルを描画しない", () => {
      renderCanvas();
      resizeTo(640, 480);
      const ctx = mockContext();

      state.props?.nodeCanvasObject(
        { id: "n1", label: "メモ", type: "memo", degree: 2, x: 10, y: 20 },
        ctx,
        0.1,
      );

      expect(ctx.fillText).not.toHaveBeenCalled();
    });

    it("globalScale がしきい値以上のときはラベルを描画する", () => {
      renderCanvas();
      resizeTo(640, 480);
      const ctx = mockContext();

      state.props?.nodeCanvasObject(
        { id: "n1", label: "メモ1", type: "memo", degree: 2, x: 10, y: 20 },
        ctx,
        5,
      );

      expect(ctx.fillText).toHaveBeenCalledWith("メモ1", 10, expect.any(Number));
      expect(ctx.fillStyle).toBe(NODE_LABEL_COLOR);
    });

    describe("しきい値(LABEL_MIN_GLOBAL_SCALE)の境界", () => {
      it("しきい値ちょうどのときは描画する(境界は含む側)", () => {
        renderCanvas();
        resizeTo(640, 480);
        const ctx = mockContext();

        state.props?.nodeCanvasObject(
          { id: "n1", label: "メモ1", type: "memo", degree: 2, x: 10, y: 20 },
          ctx,
          LABEL_MIN_GLOBAL_SCALE,
        );

        expect(ctx.fillText).toHaveBeenCalledWith("メモ1", 10, expect.any(Number));
      });

      it("しきい値をわずかに下回るときは描画しない", () => {
        renderCanvas();
        resizeTo(640, 480);
        const ctx = mockContext();

        state.props?.nodeCanvasObject(
          { id: "n1", label: "メモ1", type: "memo", degree: 2, x: 10, y: 20 },
          ctx,
          LABEL_MIN_GLOBAL_SCALE - 0.01,
        );

        expect(ctx.fillText).not.toHaveBeenCalled();
      });
    });

    describe("フォントサイズの globalScale への追従(§設計決定4。退行検知)", () => {
      // `LABEL_BASE_FONT_SIZE / globalScale` で割ることで、ズームしても画面上の文字サイズが
      // 一定に保たれ、結果としてノード間距離だけが画面上で広がりラベルの重なりが解消する
      // (固定フォントサイズへ退行すると、ズームしても文字が巨大化したまま重なり続ける)。
      it.each([
        [LABEL_MIN_GLOBAL_SCALE, LABEL_BASE_FONT_SIZE / LABEL_MIN_GLOBAL_SCALE],
        [1, LABEL_BASE_FONT_SIZE / 1],
        [2, LABEL_BASE_FONT_SIZE / 2],
        [5, LABEL_BASE_FONT_SIZE / 5],
      ])(
        "globalScale = %f のとき ctx.font が %fpx sans-serif になる",
        (globalScale, expectedFontSize) => {
          renderCanvas();
          resizeTo(640, 480);
          const ctx = mockContext();

          state.props?.nodeCanvasObject(
            { id: "n1", label: "メモ1", type: "memo", degree: 2, x: 10, y: 20 },
            ctx,
            globalScale,
          );

          expect(ctx.font).toBe(`${expectedFontSize}px sans-serif`);
        },
      );

      it("固定フォントサイズへの退行を検知する(異なる globalScale では異なるフォントサイズになる)", () => {
        renderCanvas();
        resizeTo(640, 480);
        const smallScaleCtx = mockContext();
        const largeScaleCtx = mockContext();

        state.props?.nodeCanvasObject(
          { id: "n1", label: "メモ1", type: "memo", degree: 2, x: 10, y: 20 },
          smallScaleCtx,
          1,
        );
        state.props?.nodeCanvasObject(
          { id: "n1", label: "メモ1", type: "memo", degree: 2, x: 10, y: 20 },
          largeScaleCtx,
          4,
        );

        expect(smallScaleCtx.font).not.toBe(largeScaleCtx.font);
      });
    });

    it("選択中のノードはラベルも強調色になる", () => {
      renderCanvas({ selectedNodeId: "n1" });
      resizeTo(640, 480);
      const ctx = mockContext();

      state.props?.nodeCanvasObject(
        { id: "n1", label: "メモ1", type: "memo", degree: 2, x: 10, y: 20 },
        ctx,
        5,
      );

      expect(ctx.fillStyle).toBe(SELECTED_NODE_COLOR);
    });

    it("背景板は文字を覆う位置・寸法・色で描かれる", () => {
      renderCanvas();
      resizeTo(640, 480);
      const ctx = mockContext();
      let fillStyleAtFillRect: string | undefined;
      ctx.fillRect = vi.fn(() => {
        fillStyleAtFillRect = ctx.fillStyle;
      });

      state.props?.nodeCanvasObject(
        { id: "n1", label: "メモ1", type: "memo", degree: 2, x: 10, y: 20 },
        ctx,
        2,
      );

      // globalScale = 2 のとき fontSize = 12/2 = 6, labelY = 20 + 8/2 = 24,
      // textWidth = 40(mockContext のスタブ幅)による手計算。
      expect(ctx.measureText).toHaveBeenCalledWith("メモ1");
      expect(ctx.fillRect).toHaveBeenCalledWith(-11, 23.5, 42, 6 * 1.15);
      expect(fillStyleAtFillRect).toBe("rgba(255, 255, 255, 0.82)");
    });

    it("背景板はラベルより先に描く(ラベルを塗り潰さない)", () => {
      renderCanvas();
      resizeTo(640, 480);
      const ctx = mockContext();

      state.props?.nodeCanvasObject(
        { id: "n1", label: "メモ1", type: "memo", degree: 2, x: 10, y: 20 },
        ctx,
        2,
      );

      expect(ctx.fillRect.mock.invocationCallOrder[0]).toBeLessThan(
        ctx.fillText.mock.invocationCallOrder[0],
      );
      expect(ctx.fillStyle).toBe(NODE_LABEL_COLOR);
    });

    it("measureText は ctx.font を設定した後に呼ぶ", () => {
      renderCanvas();
      resizeTo(640, 480);
      const ctx = mockContext();
      let fontAtMeasureText: string | undefined;
      ctx.measureText = vi.fn(() => {
        fontAtMeasureText = ctx.font;
        return { width: 40 };
      });

      state.props?.nodeCanvasObject(
        { id: "n1", label: "メモ1", type: "memo", degree: 2, x: 10, y: 20 },
        ctx,
        2,
      );

      expect(fontAtMeasureText).toBe(`${LABEL_BASE_FONT_SIZE / 2}px sans-serif`);
    });

    it("globalScale がしきい値未満のときは背景板も描かない", () => {
      renderCanvas();
      resizeTo(640, 480);
      const ctx = mockContext();

      state.props?.nodeCanvasObject(
        { id: "n1", label: "メモ", type: "memo", degree: 2, x: 10, y: 20 },
        ctx,
        0.1,
      );

      expect(ctx.measureText).not.toHaveBeenCalled();
      expect(ctx.fillRect).not.toHaveBeenCalled();
      expect(ctx.fillText).not.toHaveBeenCalled();
    });
  });

  describe("nodePointerAreaPaint(判定キャンバスの当たり判定)", () => {
    it("小さいノードは画面px下限の円を描く(globalScale = 1, degree = 0 → 半径 10)", () => {
      renderCanvas();
      resizeTo(640, 480);
      const ctx = mockContext();

      state.props?.nodePointerAreaPaint(
        { id: "n1", label: "メモ", type: "memo", degree: 0, x: 10, y: 20 },
        "#123456",
        ctx,
        1,
      );

      expect(ctx.arc).toHaveBeenCalledWith(10, 20, 10, 0, 2 * Math.PI, false);
      expect(ctx.fill).toHaveBeenCalled();
      expect(ctx.fillStyle).toBe("#123456");
    });

    it("大きいノードは実半径のまま(globalScale = 5, degree = 8 → √9 × 3 = 9)", () => {
      renderCanvas();
      resizeTo(640, 480);
      const ctx = mockContext();

      state.props?.nodePointerAreaPaint(
        { id: "n1", label: "メモ", type: "memo", degree: 8, x: 10, y: 20 },
        "#123456",
        ctx,
        5,
      );

      expect(ctx.arc).toHaveBeenCalledWith(10, 20, 9, 0, 2 * Math.PI, false);
    });

    it("ズームアウト時(globalScale = 0.5, degree = 6)は下限が効く → 半径 20", () => {
      renderCanvas();
      resizeTo(640, 480);
      const ctx = mockContext();

      state.props?.nodePointerAreaPaint(
        { id: "n1", label: "メモ", type: "memo", degree: 6, x: 10, y: 20 },
        "#123456",
        ctx,
        0.5,
      );

      expect(ctx.arc).toHaveBeenCalledWith(10, 20, 20, 0, 2 * Math.PI, false);
    });

    it("ラベルが表示される倍率ではラベル背景板と同じ矩形も塗る", () => {
      renderCanvas();
      resizeTo(640, 480);
      const ctx = mockContext();
      let fontAtMeasureText: string | undefined;
      ctx.measureText = vi.fn(() => {
        fontAtMeasureText = ctx.font;
        return { width: 40 };
      });

      state.props?.nodePointerAreaPaint(
        { id: "n1", label: "メモ1", type: "memo", degree: 2, x: 10, y: 20 },
        "#123456",
        ctx,
        2,
      );

      // globalScale = 2 のとき fontSize = 12/2 = 6, labelY = 20 + 8/2 = 24,
      // textWidth = 40(mockContext のスタブ幅)による手計算(表側のテストと同じ期待値)。
      expect(ctx.fillRect).toHaveBeenCalledWith(-11, 23.5, 42, 6 * 1.15);
      expect(fontAtMeasureText).toBe("6px sans-serif");
    });

    it("しきい値未満(globalScale = 0.1)では円だけ描き矩形は塗らない", () => {
      renderCanvas();
      resizeTo(640, 480);
      const ctx = mockContext();

      state.props?.nodePointerAreaPaint(
        { id: "n1", label: "メモ", type: "memo", degree: 2, x: 10, y: 20 },
        "#123456",
        ctx,
        0.1,
      );

      expect(ctx.arc).toHaveBeenCalled();
      expect(ctx.fillRect).not.toHaveBeenCalled();
      expect(ctx.measureText).not.toHaveBeenCalled();
    });

    it("同一性がレンダー間で保たれる(useCallback)", () => {
      const { rerender, graphData, onNodeClick, onLinkClick, onBackgroundClick } = renderCanvas();
      resizeTo(640, 480);
      const firstPaint = state.props?.nodePointerAreaPaint;

      rerender(
        <NetworkCanvas
          graphData={graphData}
          selectedNodeId="n1"
          onNodeClick={onNodeClick}
          onLinkClick={onLinkClick}
          onBackgroundClick={onBackgroundClick}
        />,
      );

      expect(state.props?.nodePointerAreaPaint).toBe(firstPaint);
    });
  });

  describe("onEngineStop(自動フィット。Codex レビュー指摘・追加2)", () => {
    it("ノードがあるとき、収束時に zoomToFit(400, 40) を呼ぶ", () => {
      renderCanvas();
      resizeTo(640, 480);

      state.props?.onEngineStop();

      expect(state.zoomToFit).toHaveBeenCalledWith(400, 40);
    });

    it("ノード0件のときは zoomToFit を呼ばない", () => {
      renderCanvas({ graphData: { nodes: [], links: [] } });
      resizeTo(640, 480);

      state.props?.onEngineStop();

      expect(state.zoomToFit).not.toHaveBeenCalled();
    });

    it("2回目以降の onEngineStop では呼ばない(初回のみフィットする)", () => {
      renderCanvas();
      resizeTo(640, 480);

      state.props?.onEngineStop();
      state.props?.onEngineStop();
      state.props?.onEngineStop();

      expect(state.zoomToFit).toHaveBeenCalledTimes(1);
    });
  });

  describe("背景クリック(選択解除)は force-graph に任せず自前で判定する", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["requestAnimationFrame"] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("force-graph へ onBackgroundClick を渡さない(押下中の pointermove でクリックが破棄される経路を無効化する)", () => {
      renderCanvas();
      resizeTo(640, 480);

      expect(state.props?.onBackgroundClick).toBeUndefined();
    });

    it("押下→解放の移動が閾値以内でノード/線のクリックが無ければ 2 フレーム後に onBackgroundClick を呼ぶ", () => {
      const { container, onBackgroundClick } = renderCanvas();
      resizeTo(640, 480);
      const wrapper = container.firstElementChild as HTMLElement;

      fireEvent.pointerDown(wrapper, { button: 0, clientX: 10, clientY: 10 });
      fireEvent.pointerUp(wrapper, { button: 0, clientX: 12, clientY: 11 });

      expect(onBackgroundClick).not.toHaveBeenCalled();

      vi.advanceTimersToNextFrame();
      expect(onBackgroundClick).not.toHaveBeenCalled();

      vi.advanceTimersToNextFrame();
      expect(onBackgroundClick).toHaveBeenCalledTimes(1);
      expect(onBackgroundClick).toHaveBeenCalledWith(expect.any(Event));
    });

    // force-graph 側(画素判定)の onNodeClick/onLinkClick が発火した場合、2 フレーム後の
    // コールバックは `objectClickedRef.current` を見て即 return する(幾何判定は行わない・
    // Brave 対策フォールバックは force-graph 側が何も発火しなかった場合のみ働く)。
    it("その間にノードのクリックが発火していれば onBackgroundClick を呼ばず、onNodeClick は転送される", () => {
      const { container, onBackgroundClick, onNodeClick } = renderCanvas();
      resizeTo(640, 480);
      const wrapper = container.firstElementChild as HTMLElement;
      const node: GraphViewNode = { id: "n1", label: "メモ1", type: "memo", degree: 2 };
      const clickEvent = new MouseEvent("click");

      fireEvent.pointerDown(wrapper, { button: 0, clientX: 10, clientY: 10 });
      fireEvent.pointerUp(wrapper, { button: 0, clientX: 12, clientY: 11 });
      state.props?.onNodeClick(node, clickEvent);

      vi.advanceTimersToNextFrame();
      vi.advanceTimersToNextFrame();

      expect(onBackgroundClick).not.toHaveBeenCalled();
      expect(onNodeClick).toHaveBeenCalledWith(node, clickEvent);
    });

    it("その間に線のクリックが発火していれば onBackgroundClick を呼ばず、onLinkClick は転送される", () => {
      const { container, onBackgroundClick, onLinkClick } = renderCanvas();
      resizeTo(640, 480);
      const wrapper = container.firstElementChild as HTMLElement;
      const link: GraphViewLink = {
        id: "e1",
        source: "n1",
        target: "n2",
        directed: true,
        relationType: "cause-solution",
        description: "説明",
        relatedness: 0.5,
      };
      const clickEvent = new MouseEvent("click");

      fireEvent.pointerDown(wrapper, { button: 0, clientX: 10, clientY: 10 });
      fireEvent.pointerUp(wrapper, { button: 0, clientX: 12, clientY: 11 });
      state.props?.onLinkClick(link, clickEvent);

      vi.advanceTimersToNextFrame();
      vi.advanceTimersToNextFrame();

      expect(onBackgroundClick).not.toHaveBeenCalled();
      expect(onLinkClick).toHaveBeenCalledWith(link, clickEvent);
    });

    describe("force-graph が何も発火しなかった場合の幾何フォールバック(Brave 対策)", () => {
      it("ノードに当たれば onNodeClick を呼ぶ", () => {
        const { container, graphData, onBackgroundClick, onNodeClick } = renderCanvas();
        resizeTo(640, 480);
        const wrapper = container.firstElementChild as HTMLElement;
        // degree 2, globalScale 1(mock zoom())→ 判定半径 max(√3 × 3 ≈ 5.2, 10) = 10。
        Object.assign(graphData.nodes[0], { x: 100, y: 100 });

        fireEvent.pointerDown(wrapper, { button: 0, clientX: 100, clientY: 100 });
        fireEvent.pointerUp(wrapper, { button: 0, clientX: 100, clientY: 100 });

        vi.advanceTimersToNextFrame();
        vi.advanceTimersToNextFrame();

        expect(onNodeClick).toHaveBeenCalledWith(graphData.nodes[0], expect.any(Event));
        expect(onBackgroundClick).not.toHaveBeenCalled();
      });

      it("線に当たれば onLinkClick を呼ぶ", () => {
        const { graphData, link } = twoNodeLinkFixture();
        const { container, onBackgroundClick, onLinkClick } = renderCanvas({ graphData });
        resizeTo(640, 480);
        const wrapper = container.firstElementChild as HTMLElement;
        // relatedness 0.5, globalScale 1 → 半幅 (1 + 0.5×4 + 10) / 2 + 1 = 7.5。
        // (50, 3) は線分 (0,0)-(100,0) から距離 3 で半幅以内、両ノードの判定円(半径10)の外側。

        fireEvent.pointerDown(wrapper, { button: 0, clientX: 50, clientY: 3 });
        fireEvent.pointerUp(wrapper, { button: 0, clientX: 50, clientY: 3 });

        vi.advanceTimersToNextFrame();
        vi.advanceTimersToNextFrame();

        expect(onLinkClick).toHaveBeenCalledWith(link, expect.any(Event));
        expect(onBackgroundClick).not.toHaveBeenCalled();
      });

      it("何にも当たらなければ onBackgroundClick を呼ぶ", () => {
        const { graphData } = twoNodeLinkFixture();
        const { container, onBackgroundClick, onNodeClick, onLinkClick } = renderCanvas({
          graphData,
        });
        resizeTo(640, 480);
        const wrapper = container.firstElementChild as HTMLElement;
        // (50, 30) は線分からの距離30(半幅7.5超)・両ノードの判定円(半径10)の外側。

        fireEvent.pointerDown(wrapper, { button: 0, clientX: 50, clientY: 30 });
        fireEvent.pointerUp(wrapper, { button: 0, clientX: 50, clientY: 30 });

        vi.advanceTimersToNextFrame();
        vi.advanceTimersToNextFrame();

        expect(onBackgroundClick).toHaveBeenCalledTimes(1);
        expect(onNodeClick).not.toHaveBeenCalled();
        expect(onLinkClick).not.toHaveBeenCalled();
      });

      it("ForceGraph2D の ref が未設定なら幾何判定を行わず背景クリックとして扱う", () => {
        const { container, graphData, onBackgroundClick, onNodeClick } = renderCanvas();
        resizeTo(640, 480);
        const wrapper = container.firstElementChild as HTMLElement;
        // degree 2, globalScale 1(mock zoom())→ 判定半径 10。ref が無ければ zoom() も
        // screen2GraphCoords() も呼べないため、幾何判定自体を行わず背景クリック扱いになる。
        Object.assign(graphData.nodes[0], { x: 100, y: 100 });
        if (state.props?.ref) {
          state.props.ref.current = undefined;
        }

        fireEvent.pointerDown(wrapper, { button: 0, clientX: 100, clientY: 100 });
        fireEvent.pointerUp(wrapper, { button: 0, clientX: 100, clientY: 100 });

        vi.advanceTimersToNextFrame();
        vi.advanceTimersToNextFrame();

        expect(onNodeClick).not.toHaveBeenCalled();
        expect(onBackgroundClick).toHaveBeenCalledTimes(1);
      });

      it("ノードと線が重なる点ではノードを優先する", () => {
        const { graphData, nodeB } = twoNodeLinkFixture();
        const { container, onBackgroundClick, onNodeClick, onLinkClick } = renderCanvas({
          graphData,
        });
        resizeTo(640, 480);
        const wrapper = container.firstElementChild as HTMLElement;
        // (100, 0) は nodeB の中心そのもの(線分上でもあるが、ノードが線より優先される)。

        fireEvent.pointerDown(wrapper, { button: 0, clientX: 100, clientY: 0 });
        fireEvent.pointerUp(wrapper, { button: 0, clientX: 100, clientY: 0 });

        vi.advanceTimersToNextFrame();
        vi.advanceTimersToNextFrame();

        expect(onNodeClick).toHaveBeenCalledWith(nodeB, expect.any(Event));
        expect(onLinkClick).not.toHaveBeenCalled();
        expect(onBackgroundClick).not.toHaveBeenCalled();
      });

      it("キャンバスが原点以外に配置されていても、クリック位置をラッパー相対に変換して判定する", () => {
        const { container, graphData, onBackgroundClick, onNodeClick } = renderCanvas();
        resizeTo(640, 480);
        const wrapper = container.firstElementChild as HTMLElement;
        vi.spyOn(wrapper, "getBoundingClientRect").mockReturnValue({
          left: 200,
          top: 100,
          right: 840,
          bottom: 580,
          width: 640,
          height: 480,
          x: 200,
          y: 100,
          toJSON: () => ({}),
        });
        const screen2GraphCoords = vi.fn((x: number, y: number) => ({ x, y }));
        if (state.props?.ref?.current) {
          state.props.ref.current.screen2GraphCoords = screen2GraphCoords;
        }
        Object.assign(graphData.nodes[0], { x: 100, y: 100 });

        // clientX/clientY はラッパー原点(200, 100)からのオフセットで 100, 100 になる座標。
        fireEvent.pointerDown(wrapper, { button: 0, clientX: 300, clientY: 200 });
        fireEvent.pointerUp(wrapper, { button: 0, clientX: 300, clientY: 200 });

        vi.advanceTimersToNextFrame();
        vi.advanceTimersToNextFrame();

        expect(screen2GraphCoords).toHaveBeenCalledWith(100, 100);
        expect(onNodeClick).toHaveBeenCalledWith(graphData.nodes[0], expect.any(Event));
        expect(onBackgroundClick).not.toHaveBeenCalled();
      });
    });

    it("閾値を超えて動いたとき(パン/ドラッグ)は呼ばない", () => {
      const { container, onBackgroundClick } = renderCanvas();
      resizeTo(640, 480);
      const wrapper = container.firstElementChild as HTMLElement;

      fireEvent.pointerDown(wrapper, { button: 0, clientX: 10, clientY: 10 });
      fireEvent.pointerUp(wrapper, { button: 0, clientX: 20, clientY: 10 });

      vi.advanceTimersToNextFrame();
      vi.advanceTimersToNextFrame();

      expect(onBackgroundClick).not.toHaveBeenCalled();
    });

    it("ちょうど閾値(5px)は呼ぶ(境界は含む)", () => {
      const { container, onBackgroundClick } = renderCanvas();
      resizeTo(640, 480);
      const wrapper = container.firstElementChild as HTMLElement;

      fireEvent.pointerDown(wrapper, { button: 0, clientX: 10, clientY: 10 });
      fireEvent.pointerUp(wrapper, { button: 0, clientX: 15, clientY: 10 });

      vi.advanceTimersToNextFrame();
      vi.advanceTimersToNextFrame();

      expect(onBackgroundClick).toHaveBeenCalledTimes(1);
    });

    it("左ボタン以外では呼ばない", () => {
      const { container, onBackgroundClick } = renderCanvas();
      resizeTo(640, 480);
      const wrapper = container.firstElementChild as HTMLElement;

      fireEvent.pointerDown(wrapper, { button: 2, clientX: 10, clientY: 10 });
      fireEvent.pointerUp(wrapper, { button: 2, clientX: 10, clientY: 10 });

      vi.advanceTimersToNextFrame();
      vi.advanceTimersToNextFrame();

      expect(onBackgroundClick).not.toHaveBeenCalled();
    });
  });
});
