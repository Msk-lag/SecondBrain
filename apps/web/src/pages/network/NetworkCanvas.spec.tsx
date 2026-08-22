import { act, render, screen } from "@testing-library/react";
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
  onNodeClick: (node: GraphViewNode, event: MouseEvent) => void;
  onLinkClick: (link: GraphViewLink, event: MouseEvent) => void;
  onBackgroundClick: (event: MouseEvent) => void;
  onEngineStop: () => void;
  // React 19 では関数コンポーネントが `ref` を通常の prop として受け取れる
  // (`forwardRef` 不要)。実物の `ForceGraphMethods` の代わりに `zoomToFit` だけを
  // 持つスタブをこの ref へ差し込む。
  ref?: { current: { zoomToFit: ReturnType<typeof vi.fn> } | undefined };
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
      props.ref.current = { zoomToFit: state.zoomToFit };
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

describe("NetworkCanvas", () => {
  let originalResizeObserver: typeof ResizeObserver;

  beforeEach(() => {
    state.props = undefined;
    state.zoomToFit = undefined;
    originalResizeObserver = globalThis.ResizeObserver;
    MockResizeObserver.instances.length = 0;
    globalThis.ResizeObserver = MockResizeObserver;
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

  it("onNodeClick / onLinkClick / onBackgroundClick をそのまま転送する", () => {
    const { onNodeClick, onLinkClick, onBackgroundClick } = renderCanvas();
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
    state.props?.onBackgroundClick(clickEvent);

    expect(onNodeClick).toHaveBeenCalledWith(node, clickEvent);
    expect(onLinkClick).toHaveBeenCalledWith(link, clickEvent);
    expect(onBackgroundClick).toHaveBeenCalledWith(clickEvent);
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
    const link = (relatedness: number): GraphViewLink => ({
      id: "e1",
      source: "n1",
      target: "n2",
      directed: false,
      relationType: "same-theme",
      description: "説明",
      relatedness,
    });

    it("relatedness = 0 のとき 1.0px(受入条件3の下限)", () => {
      renderCanvas();
      resizeTo(640, 480);

      expect(state.props?.linkWidth(link(0))).toBe(1);
    });

    it("relatedness = 1 のとき 5.0px(受入条件3の上限)", () => {
      renderCanvas();
      resizeTo(640, 480);

      expect(state.props?.linkWidth(link(1))).toBe(5);
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
    function mockContext(): MockCanvasContext {
      return {
        font: "",
        textAlign: "",
        textBaseline: "",
        fillStyle: "",
        fillText: vi.fn(),
      };
    }

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
});
