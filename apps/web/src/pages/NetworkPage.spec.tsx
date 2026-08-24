import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { GraphResponse } from "@secondbrain/shared";
import type { GraphViewData, GraphViewLink, GraphViewNode } from "@/features/graph/to-graph-data";

/**
 * `NetworkCanvas` はモックする(M2-2 §設計決定8 と同じ方針。`ForceGraph2D` を内包しており
 * jsdom では描画できないため)。渡された props を module スコープへ捕捉し、spec から
 * アクセサ・コールバックを直接呼んで検証する。
 */
interface CapturedNetworkCanvasProps {
  graphData: GraphViewData;
  selectedNodeId: string | null;
  onNodeClick: (node: GraphViewNode, event: MouseEvent) => void;
  onLinkClick: (link: GraphViewLink, event: MouseEvent) => void;
  onBackgroundClick: (event: MouseEvent) => void;
}

const state = vi.hoisted(() => ({
  props: undefined as CapturedNetworkCanvasProps | undefined,
}));

vi.mock("./network/NetworkCanvas", () => ({
  NetworkCanvas: (props: CapturedNetworkCanvasProps) => {
    state.props = props;
    return <div data-testid="network-canvas-stub" />;
  },
}));

vi.mock("@/lib/api-client", () => ({
  apiClient: {
    graph: { get: vi.fn() },
    notes: { get: vi.fn() },
  },
}));

import { NetworkPage } from "./NetworkPage";
import { apiClient } from "@/lib/api-client";

function makeGraphResponse(overrides: Partial<GraphResponse> = {}): GraphResponse {
  return {
    nodes: [],
    edges: [],
    truncated: { nodes: false, edges: false },
    processingNoteCount: 0,
    ...overrides,
  };
}

function graphWithNodesAndEdge(): GraphResponse {
  return makeGraphResponse({
    nodes: [
      { id: "n1", title: "メモ1", type: "memo", bodyPreview: null },
      { id: "n2", title: "メモ2", type: "memo", bodyPreview: null },
    ],
    edges: [
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
  });
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <NetworkPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("NetworkPage", () => {
  beforeEach(() => {
    state.props = undefined;
    vi.mocked(apiClient.graph.get).mockReset();
    vi.mocked(apiClient.notes.get).mockReset();
    // 選択パネル(NetworkSelectionPanel)は実物を使うため、ノード選択系テストで
    // useNoteQuery が呼ばれても壊れないよう既定で 404 を返しておく
    // (パネル自体の表示分岐は NetworkSelectionPanel.spec.tsx で網羅済み)。
    vi.mocked(apiClient.notes.get).mockResolvedValue({
      status: 404,
      body: { message: "not found" },
      headers: new Headers(),
    });
  });

  it("初回取得中は Skeleton を表示し、空状態にならない", () => {
    // render() 直後(まだ await していない時点)では、queryFn の Promise 解決を待つ
    // microtask が処理される前のため isPending のままである(応答内容は問わない。
    // NetworkSelectionPanel.spec.tsx と同じ手法)。
    vi.mocked(apiClient.graph.get).mockResolvedValue({
      status: 200,
      body: makeGraphResponse(),
      headers: new Headers(),
    });

    renderPage();

    expect(screen.getByRole("heading", { name: "ネットワーク" })).toBeInTheDocument();
    expect(screen.queryByText("まだノートがありません。")).not.toBeInTheDocument();
    expect(screen.queryByTestId("network-canvas-stub")).not.toBeInTheDocument();
    expect(document.querySelector('[aria-busy="true"]')).toBeInTheDocument();
  });

  it("取得成功・ノート0件のとき空状態を表示する", async () => {
    vi.mocked(apiClient.graph.get).mockResolvedValue({
      status: 200,
      body: makeGraphResponse(),
      headers: new Headers(),
    });

    renderPage();

    expect(await screen.findByText("まだノートがありません。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "最初のノートを保存する" })).toHaveAttribute(
      "href",
      "/save",
    );
    expect(screen.queryByTestId("network-canvas-stub")).not.toBeInTheDocument();
  });

  it("取得成功・ノートありのときグラフを描画し件数を表示する", async () => {
    vi.mocked(apiClient.graph.get).mockResolvedValue({
      status: 200,
      body: graphWithNodesAndEdge(),
      headers: new Headers(),
    });

    renderPage();

    expect(await screen.findByTestId("network-canvas-stub")).toBeInTheDocument();
    expect(screen.getByText("表示 2 / 全 2 ノート")).toBeInTheDocument();
    expect(state.props?.graphData.nodes).toHaveLength(2);
    expect(state.props?.graphData.links).toHaveLength(1);
  });

  it("取得失敗・キャッシュ無しのときエラー Alert と再試行を表示し、クリックで再取得する", async () => {
    vi.mocked(apiClient.graph.get).mockRejectedValueOnce(new Error("network error"));

    renderPage();

    expect(await screen.findByText("ネットワークの取得に失敗しました。")).toBeInTheDocument();
    const retryButton = screen.getByRole("button", { name: "再試行" });
    expect(screen.queryByTestId("network-canvas-stub")).not.toBeInTheDocument();
    const callsBeforeRetry = vi.mocked(apiClient.graph.get).mock.calls.length;

    vi.mocked(apiClient.graph.get).mockResolvedValueOnce({
      status: 200,
      body: graphWithNodesAndEdge(),
      headers: new Headers(),
    });
    const user = userEvent.setup();
    await user.click(retryButton);

    // クリックで `graphQuery.refetch()` が呼ばれ、再取得が実行されたことをキャンバス描画と
    // 呼び出し回数の両方で確認する(退行検知)。
    expect(await screen.findByTestId("network-canvas-stub")).toBeInTheDocument();
    expect(vi.mocked(apiClient.graph.get).mock.calls.length).toBe(callsBeforeRetry + 1);
  });

  it("取得失敗でもキャッシュ済みのネットワークがあれば描画を維持し警告のみ表示する(受入条件9)", async () => {
    vi.mocked(apiClient.graph.get).mockResolvedValueOnce({
      status: 200,
      body: graphWithNodesAndEdge(),
      headers: new Headers(),
    });

    renderPage();
    expect(await screen.findByTestId("network-canvas-stub")).toBeInTheDocument();

    vi.mocked(apiClient.graph.get).mockRejectedValueOnce(new Error("network error"));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "更新" }));

    expect(
      await screen.findByText("最新の取得に失敗しました。表示中の内容は前回取得できたものです。"),
    ).toBeInTheDocument();
    // 描画は維持されたまま(キャッシュ済み data を消さない)。
    expect(screen.getByTestId("network-canvas-stub")).toBeInTheDocument();
    expect(screen.getByText("表示 2 / 全 2 ノート")).toBeInTheDocument();
  });

  describe("トグル(§設計決定3。クライアント側の絞り込み)", () => {
    it("「関係のあるノートのみ表示」で次数0のノードと、その端点を持つエッジを除外する", async () => {
      vi.mocked(apiClient.graph.get).mockResolvedValue({
        status: 200,
        body: makeGraphResponse({
          nodes: [
            { id: "n0", title: "孤立", type: "memo", bodyPreview: null },
            { id: "n1", title: "メモ1", type: "memo", bodyPreview: null },
            { id: "n2", title: "メモ2", type: "memo", bodyPreview: null },
          ],
          edges: [
            {
              id: "e1",
              source: "n1",
              target: "n2",
              directed: false,
              relationType: "same-theme",
              description: "説明",
              relatedness: 0.5,
            },
          ],
        }),
        headers: new Headers(),
      });

      renderPage();
      await screen.findByTestId("network-canvas-stub");
      const callsBeforeToggle = vi.mocked(apiClient.graph.get).mock.calls.length;

      expect(screen.getByText("表示 3 / 全 3 ノート")).toBeInTheDocument();
      expect(state.props?.graphData.nodes).toHaveLength(3);

      const user = userEvent.setup();
      await user.click(screen.getByRole("checkbox", { name: "関係のあるノートのみ表示" }));

      expect(screen.getByText("表示 2 / 全 3 ノート")).toBeInTheDocument();
      expect(state.props?.graphData.nodes.map((node) => node.id).sort()).toEqual(["n1", "n2"]);
      expect(state.props?.graphData.links).toHaveLength(1);
      // 絞り込みはクライアント側で行われ、トグル時に再取得しない。
      expect(vi.mocked(apiClient.graph.get).mock.calls.length).toBe(callsBeforeToggle);

      await user.click(screen.getByRole("checkbox", { name: "関係のあるノートのみ表示" }));
      expect(screen.getByText("表示 3 / 全 3 ノート")).toBeInTheDocument();
      expect(state.props?.graphData.nodes).toHaveLength(3);
    });
  });

  describe("打ち切り Alert(truncated)", () => {
    const truncatedMessage =
      "表示件数が上限に達したため、一部のノートまたは関係が表示されていません。";

    it("truncated.nodes のみ true のとき Alert を表示する", async () => {
      vi.mocked(apiClient.graph.get).mockResolvedValue({
        status: 200,
        body: makeGraphResponse({ truncated: { nodes: true, edges: false } }),
        headers: new Headers(),
      });

      renderPage();

      expect(await screen.findByText(truncatedMessage)).toBeInTheDocument();
    });

    it("truncated.edges のみ true のとき Alert を表示する", async () => {
      vi.mocked(apiClient.graph.get).mockResolvedValue({
        status: 200,
        body: makeGraphResponse({ truncated: { nodes: false, edges: true } }),
        headers: new Headers(),
      });

      renderPage();

      expect(await screen.findByText(truncatedMessage)).toBeInTheDocument();
    });

    it("両方 false のとき Alert を表示しない", async () => {
      vi.mocked(apiClient.graph.get).mockResolvedValue({
        status: 200,
        body: makeGraphResponse(),
        headers: new Headers(),
      });

      renderPage();

      await screen.findByText("まだノートがありません。");
      expect(screen.queryByText(truncatedMessage)).not.toBeInTheDocument();
    });
  });

  describe("判定中の表示", () => {
    it("processingNoteCount > 0 のとき判定中メッセージを表示する", async () => {
      vi.mocked(apiClient.graph.get).mockResolvedValue({
        status: 200,
        body: makeGraphResponse({ processingNoteCount: 3 }),
        headers: new Headers(),
      });

      renderPage();

      expect(await screen.findByText("AI が新しい関係を判定中です(3件)")).toBeInTheDocument();
    });

    it("processingNoteCount === 0 のとき判定中メッセージを表示しない", async () => {
      vi.mocked(apiClient.graph.get).mockResolvedValue({
        status: 200,
        body: makeGraphResponse({ processingNoteCount: 0 }),
        headers: new Headers(),
      });

      renderPage();

      await screen.findByText("まだノートがありません。");
      expect(screen.queryByText(/AI が新しい関係を判定中です/)).not.toBeInTheDocument();
    });
  });

  describe("選択状態", () => {
    it("ノード選択でパネルにノード詳細を表示し、背景クリックで解除する", async () => {
      vi.mocked(apiClient.graph.get).mockResolvedValue({
        status: 200,
        body: graphWithNodesAndEdge(),
        headers: new Headers(),
      });

      renderPage();
      await screen.findByTestId("network-canvas-stub");

      act(() => {
        state.props?.onNodeClick(
          { id: "n1", label: "メモ1", type: "memo", degree: 1 },
          new MouseEvent("click"),
        );
      });

      expect(state.props?.selectedNodeId).toBe("n1");
      expect(screen.getByText("ノートの詳細")).toBeInTheDocument();

      act(() => {
        state.props?.onBackgroundClick(new MouseEvent("click"));
      });

      expect(state.props?.selectedNodeId).toBeNull();
      expect(screen.getByText("詳細")).toBeInTheDocument();
      expect(
        screen.getByText("ノードまたは関係線を選択すると詳細が表示されます。"),
      ).toBeInTheDocument();
    });

    it("エッジ選択でパネルに関係詳細を表示する", async () => {
      vi.mocked(apiClient.graph.get).mockResolvedValue({
        status: 200,
        body: graphWithNodesAndEdge(),
        headers: new Headers(),
      });

      renderPage();
      await screen.findByTestId("network-canvas-stub");

      const link: GraphViewLink = {
        id: "e1",
        source: "n1",
        target: "n2",
        directed: true,
        relationType: "cause-solution",
        description: "説明",
        relatedness: 0.5,
      };

      act(() => {
        state.props?.onLinkClick(link, new MouseEvent("click"));
      });

      expect(screen.getByText("関係の詳細")).toBeInTheDocument();
    });

    // 実行時経路そのものの回帰テスト(受入条件4)。`NetworkSelectionPanel.spec.tsx` の
    // ケースS/ケースOは link オブジェクトを spec 側で直接組み立てているが、実行時に
    // 実際に成立するのは「`NetworkCanvas`(実体は `ForceGraph2D`)へ渡した後、
    // `react-force-graph`/`d3-force` が `graphData.links` の要素を in-place で書き換える」
    // という経路そのものである。spec がケースS(文字列)しか検証していなかったために
    // 本バグ(両端ノート名が常に「(不明なノート)」になる)が CI をすり抜けたため、
    // この実行時経路そのものを再現する専用テストを持つ。
    it("エッジ選択: links の端点が d3-force によりノードオブジェクトへ書き換え済みでも両端ノート名を表示する(受入条件4・実行時経路の回帰検知)", async () => {
      vi.mocked(apiClient.graph.get).mockResolvedValue({
        status: 200,
        body: graphWithNodesAndEdge(),
        headers: new Headers(),
      });

      renderPage();
      await screen.findByTestId("network-canvas-stub");

      const link = state.props?.graphData.links[0];
      const nodes = state.props?.graphData.nodes ?? [];
      if (!link) {
        throw new Error("テストの前提: links[0] が存在しません");
      }
      const sourceNode = nodes.find((node) => node.id === "n1");
      const targetNode = nodes.find((node) => node.id === "n2");
      // `react-force-graph` が実行時に行うのと同じ、link オブジェクトの source/target を
      // 文字列 ID からノードオブジェクト参照へ書き換える in-place な破壊的変更を再現する。
      (link as unknown as { source: unknown }).source = sourceNode;
      (link as unknown as { target: unknown }).target = targetNode;

      act(() => {
        state.props?.onLinkClick(link, new MouseEvent("click"));
      });

      // 「関係するノート」一覧にも同じラベルが出るため getAllByText で存在のみ確認する。
      expect(screen.getAllByText("メモ1").length).toBeGreaterThan(0);
      expect(screen.getAllByText("メモ2").length).toBeGreaterThan(0);
      expect(screen.queryAllByText("(不明なノート)")).toHaveLength(0);
    });

    // 受入条件7(後半): エッジ選択 → 一覧項目クリック → パネルのタイトルが
    // 「ノートの詳細」へ切り替わる。単体テスト(NetworkSelectionPanel.spec.tsx)側は
    // source 側をクリックしているため、ここでは反対側(target 側)をクリックする
    // (Codex 指摘1。両項目が誤って同じ端点 ID を使う実装だと、単体テスト・この実行時
    // テストのどちらか一方だけでは素通りしてしまうため、両方で反対側を検証する)。
    it("エッジ選択 → 関係するノート一覧の target 側項目クリック → パネルが『ノートの詳細』へ切り替わる(受入条件7後半)", async () => {
      vi.mocked(apiClient.graph.get).mockResolvedValue({
        status: 200,
        body: graphWithNodesAndEdge(),
        headers: new Headers(),
      });
      vi.mocked(apiClient.notes.get).mockResolvedValue({
        status: 200,
        body: {
          id: "n2",
          userId: "user-1",
          type: "memo" as const,
          title: "メモ2",
          body: "メモ2の本文です。",
          summary: null,
          tags: [] as string[],
          status: "completed" as const,
          failureReason: null,
          concepts: [] as string[],
          extractedText: null,
          createdAt: "2026-07-09T00:00:00.000Z",
          updatedAt: "2026-07-09T00:00:00.000Z",
        },
        headers: new Headers(),
      });
      const user = userEvent.setup();

      renderPage();
      await screen.findByTestId("network-canvas-stub");

      act(() => {
        state.props?.onLinkClick(
          {
            id: "e1",
            source: "n1",
            target: "n2",
            directed: true,
            relationType: "cause-solution",
            description: "説明",
            relatedness: 0.5,
          },
          new MouseEvent("click"),
        );
      });
      expect(screen.getByText("関係の詳細")).toBeInTheDocument();

      const relatedNotesSection = within(screen.getByRole("region", { name: "関係するノート" }));
      await user.click(relatedNotesSection.getByText("メモ2"));

      expect(await screen.findByText("ノートの詳細")).toBeInTheDocument();
      expect(await screen.findByRole("heading", { name: "メモ2" })).toBeInTheDocument();
    });

    // Codex レビュー指摘・修正1: 選択状態はエッジ ID/ノード ID のみを保持し、最新の
    // `graphData` から都度解決する。以下2件は、その解決が実際に効くことを検証する。
    it("再取得で関係が更新されると、選択中のパネルにも新しい内容が反映される", async () => {
      vi.mocked(apiClient.graph.get).mockResolvedValueOnce({
        status: 200,
        body: graphWithNodesAndEdge(),
        headers: new Headers(),
      });

      renderPage();
      await screen.findByTestId("network-canvas-stub");

      act(() => {
        state.props?.onLinkClick(
          {
            id: "e1",
            source: "n1",
            target: "n2",
            directed: true,
            relationType: "cause-solution",
            description: "説明",
            relatedness: 0.5,
          },
          new MouseEvent("click"),
        );
      });

      expect(screen.getByText("説明")).toBeInTheDocument();
      expect(screen.getByText("関連度 50%")).toBeInTheDocument();

      vi.mocked(apiClient.graph.get).mockResolvedValueOnce({
        status: 200,
        body: makeGraphResponse({
          nodes: [
            { id: "n1", title: "メモ1", type: "memo", bodyPreview: null },
            { id: "n2", title: "メモ2", type: "memo", bodyPreview: null },
          ],
          edges: [
            {
              id: "e1",
              source: "n1",
              target: "n2",
              directed: true,
              relationType: "cause-solution",
              description: "更新後の説明",
              relatedness: 0.9,
            },
          ],
        }),
        headers: new Headers(),
      });
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "更新" }));

      expect(await screen.findByText("更新後の説明")).toBeInTheDocument();
      expect(screen.getByText("関連度 90%")).toBeInTheDocument();
      expect(screen.queryByText("説明")).not.toBeInTheDocument();
    });

    it("再取得で選択中の関係が削除されると選択を解除する", async () => {
      vi.mocked(apiClient.graph.get).mockResolvedValueOnce({
        status: 200,
        body: graphWithNodesAndEdge(),
        headers: new Headers(),
      });

      renderPage();
      await screen.findByTestId("network-canvas-stub");

      act(() => {
        state.props?.onLinkClick(
          {
            id: "e1",
            source: "n1",
            target: "n2",
            directed: true,
            relationType: "cause-solution",
            description: "説明",
            relatedness: 0.5,
          },
          new MouseEvent("click"),
        );
      });
      expect(screen.getByText("関係の詳細")).toBeInTheDocument();

      vi.mocked(apiClient.graph.get).mockResolvedValueOnce({
        status: 200,
        body: makeGraphResponse({
          nodes: [
            { id: "n1", title: "メモ1", type: "memo", bodyPreview: null },
            { id: "n2", title: "メモ2", type: "memo", bodyPreview: null },
          ],
          edges: [],
        }),
        headers: new Headers(),
      });
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "更新" }));

      await screen.findByText("詳細");
      expect(
        screen.getByText("ノードまたは関係線を選択すると詳細が表示されます。"),
      ).toBeInTheDocument();
    });

    it("再取得で選択中のノードが削除されると選択を解除する", async () => {
      vi.mocked(apiClient.graph.get).mockResolvedValueOnce({
        status: 200,
        body: graphWithNodesAndEdge(),
        headers: new Headers(),
      });

      renderPage();
      await screen.findByTestId("network-canvas-stub");

      act(() => {
        state.props?.onNodeClick(
          { id: "n1", label: "メモ1", type: "memo", degree: 1 },
          new MouseEvent("click"),
        );
      });
      expect(state.props?.selectedNodeId).toBe("n1");

      vi.mocked(apiClient.graph.get).mockResolvedValueOnce({
        status: 200,
        body: makeGraphResponse({
          nodes: [{ id: "n2", title: "メモ2", type: "memo", bodyPreview: null }],
          edges: [],
        }),
        headers: new Headers(),
      });
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "更新" }));

      await screen.findByText("詳細");
      expect(state.props?.selectedNodeId).toBeNull();
      expect(
        screen.getByText("ノードまたは関係線を選択すると詳細が表示されます。"),
      ).toBeInTheDocument();
    });

    it("接続ノード項目クリックでそのノードを選択できる", async () => {
      vi.mocked(apiClient.graph.get).mockResolvedValue({
        status: 200,
        body: graphWithNodesAndEdge(),
        headers: new Headers(),
      });
      const user = userEvent.setup();

      renderPage();
      await screen.findByTestId("network-canvas-stub");

      act(() => {
        state.props?.onNodeClick(
          { id: "n1", label: "メモ1", type: "memo", degree: 1 },
          new MouseEvent("click"),
        );
      });

      const connectedNodeButton = await screen.findByText("メモ2");
      await user.click(connectedNodeButton);

      expect(state.props?.selectedNodeId).toBe("n2");
    });
  });
});
