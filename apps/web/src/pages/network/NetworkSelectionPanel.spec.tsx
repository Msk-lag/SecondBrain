import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import type { GraphAdjacency, GraphViewNode } from "@/features/graph/to-graph-data";
import { apiClient } from "@/lib/api-client";
import { NetworkSelectionPanel, type NetworkSelectionPanelProps } from "./NetworkSelectionPanel";

vi.mock("@/lib/api-client", () => ({
  apiClient: {
    notes: {
      get: vi.fn(),
    },
  },
}));

const nodesById: ReadonlyMap<string, GraphViewNode> = new Map([
  ["n1", { id: "n1", label: "メモ1", type: "memo", degree: 1 }],
  ["n2", { id: "n2", label: "スクショ1", type: "screenshot", degree: 1 }],
  ["n3", { id: "n3", label: "孤立メモ", type: "memo", degree: 0 }],
]);

const adjacency: GraphAdjacency = new Map([
  [
    "n1",
    [
      {
        edge: {
          id: "e1",
          directed: true,
          relationType: "cause-solution",
          description: "原因から解決策への説明",
          relatedness: 0.8,
        },
        otherNodeId: "n2",
        direction: "outgoing",
      },
    ],
  ],
]);

const memoNote = {
  id: "n1",
  userId: "user-1",
  type: "memo" as const,
  title: "一言メモ",
  body: "本文の内容です。",
  summary: "要約テキスト",
  tags: [] as string[],
  status: "completed" as const,
  failureReason: null,
  concepts: [] as string[],
  extractedText: null,
  createdAt: "2026-07-09T00:00:00.000Z",
  updatedAt: "2026-07-09T00:00:00.000Z",
};

const screenshotNote = {
  ...memoNote,
  id: "n2",
  type: "screenshot" as const,
  title: null,
  body: null,
  summary: null,
};

function renderPanel(props: Partial<NetworkSelectionPanelProps> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onSelectNode = vi.fn();
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <NetworkSelectionPanel
          selection={null}
          nodesById={nodesById}
          adjacency={adjacency}
          onSelectNode={onSelectNode}
          {...props}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...utils, onSelectNode };
}

describe("NetworkSelectionPanel", () => {
  beforeEach(() => {
    vi.mocked(apiClient.notes.get).mockReset();
  });

  it("選択が無いときは案内文を表示する", () => {
    renderPanel();

    expect(
      screen.getByText("ノードまたは関係線を選択すると詳細が表示されます。"),
    ).toBeInTheDocument();
  });

  describe("ノード選択", () => {
    it("取得中は読み込み中の文言を表示する", () => {
      // render() 直後(まだ await していない時点)では、queryFn の Promise 解決を待つ
      // microtask が処理される前のため isLoading のままである(応答内容は問わない)。
      vi.mocked(apiClient.notes.get).mockResolvedValue({
        status: 200,
        body: memoNote,
        headers: new Headers(),
      });

      renderPanel({ selection: { type: "node", nodeId: "n1" } });

      expect(screen.getByText("ノートを読み込み中…")).toBeInTheDocument();
    });

    it("取得失敗時はエラー表示にする", async () => {
      vi.mocked(apiClient.notes.get).mockRejectedValue(new Error("network error"));

      renderPanel({ selection: { type: "node", nodeId: "n1" } });

      expect(await screen.findByText("ノートの取得に失敗しました。")).toBeInTheDocument();
    });

    it("404(削除済み)のときは削除済み文言を表示しつつ接続ノード一覧は表示する", async () => {
      vi.mocked(apiClient.notes.get).mockResolvedValue({
        status: 404,
        body: { message: "not found" },
        headers: new Headers(),
      });

      renderPanel({ selection: { type: "node", nodeId: "n1" } });

      expect(await screen.findByText("このノートは削除されています。")).toBeInTheDocument();
      expect(screen.getByText("スクショ1")).toBeInTheDocument();
    });

    it("メモは要約・本文・接続ノード一覧・詳細への導線を表示する", async () => {
      vi.mocked(apiClient.notes.get).mockResolvedValue({
        status: 200,
        body: memoNote,
        headers: new Headers(),
      });
      const user = userEvent.setup();

      const { onSelectNode } = renderPanel({ selection: { type: "node", nodeId: "n1" } });

      expect(await screen.findByRole("heading", { name: "一言メモ" })).toBeInTheDocument();
      expect(screen.getByText("要約テキスト")).toBeInTheDocument();
      expect(screen.getByText("本文の内容です。")).toBeInTheDocument();
      expect(screen.getByText("原因と解決策")).toBeInTheDocument();
      expect(screen.getByText("スクショ1")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "詳細を開く" })).toHaveAttribute("href", "/notes/n1");

      await user.click(screen.getByText("スクショ1"));
      expect(onSelectNode).toHaveBeenCalledWith("n2");
    });

    it("接続ノード一覧は選択ノードから見た方向に応じた役割ラベルを表示する", async () => {
      const directionalAdjacency: GraphAdjacency = new Map([
        [
          "n1",
          [
            {
              edge: {
                id: "e-out",
                directed: true,
                relationType: "cause-solution",
                description: "原因から解決策への説明",
                relatedness: 0.8,
              },
              otherNodeId: "n2",
              direction: "outgoing",
            },
            {
              edge: {
                id: "e-in",
                directed: true,
                relationType: "problem-remedy",
                description: "問題から対処法への説明",
                relatedness: 0.6,
              },
              otherNodeId: "n3",
              direction: "incoming",
            },
            {
              edge: {
                id: "e-none",
                directed: false,
                relationType: "same-theme",
                description: "同じテーマの説明",
                relatedness: 0.3,
              },
              otherNodeId: "n3",
              direction: "none",
            },
          ],
        ],
      ]);
      vi.mocked(apiClient.notes.get).mockResolvedValue({
        status: 200,
        body: memoNote,
        headers: new Headers(),
      });

      renderPanel({
        selection: { type: "node", nodeId: "n1" },
        adjacency: directionalAdjacency,
      });

      expect(await screen.findByText("接続ノード(3)")).toBeInTheDocument();
      // outgoing: 選択ノード(n1)が「原因」、隣接(n2)は「解決策」側の役割。
      expect(screen.getByText("(解決策)")).toBeInTheDocument();
      // incoming: 隣接(n3)が「問題」側の役割、選択ノード(n1)は「対処法」。
      expect(screen.getByText("(問題)")).toBeInTheDocument();
      // direction: "none" は role が無いため種別バッジのみ(役割ラベルを出さない)。
      expect(screen.getByText("同じテーマ")).toBeInTheDocument();
    });

    it("接続ノードが無い場合は案内文を表示する", async () => {
      vi.mocked(apiClient.notes.get).mockResolvedValue({
        status: 200,
        body: { ...memoNote, id: "n3", title: "孤立メモ" },
        headers: new Headers(),
      });

      renderPanel({ selection: { type: "node", nodeId: "n3" } });

      expect(await screen.findByText("接続しているノートはありません。")).toBeInTheDocument();
    });

    it("本文が無い(null)ノートは本文欄を描画しない", async () => {
      vi.mocked(apiClient.notes.get).mockResolvedValue({
        status: 200,
        body: { ...memoNote, body: null },
        headers: new Headers(),
      });

      const { container } = renderPanel({ selection: { type: "node", nodeId: "n1" } });

      expect(await screen.findByText("要約テキスト")).toBeInTheDocument();
      expect(container.querySelector(".font-reading")).toBeNull();
    });

    describe("スクリーンショット", () => {
      beforeEach(() => {
        vi.mocked(apiClient.notes.get).mockResolvedValue({
          status: 200,
          body: screenshotNote,
          headers: new Headers(),
        });
      });

      afterEach(() => {
        vi.unstubAllGlobals();
      });

      it("元スクショを表示する", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Blob(["binary"]))));
        URL.createObjectURL = vi.fn(() => "blob:mock-url");
        URL.revokeObjectURL = vi.fn();

        renderPanel({ selection: { type: "node", nodeId: "n2" } });

        const image = await screen.findByAltText("保存したスクリーンショット");
        expect(image).toHaveAttribute("src", "blob:mock-url");
      });

      it("画像の取得に失敗した場合は再試行ボタンを表示し、クリックで再取得する", async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 502 }));
        vi.stubGlobal("fetch", fetchMock);
        const user = userEvent.setup();

        renderPanel({ selection: { type: "node", nodeId: "n2" } });

        expect(await screen.findByText("画像の取得に失敗しました。")).toBeInTheDocument();
        const callsBeforeRetry = fetchMock.mock.calls.length;

        await user.click(screen.getByRole("button", { name: "再試行" }));

        expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBeforeRetry);
      });
    });
  });

  describe("エッジ選択", () => {
    it("有向エッジは種類バッジ・説明・関連度・役割ラベル付きの向きを表示する", () => {
      renderPanel({
        selection: {
          type: "edge",
          link: {
            id: "e1",
            source: "n1",
            target: "n2",
            directed: true,
            relationType: "cause-solution",
            description: "原因から解決策への説明",
            relatedness: 0.8,
          },
        },
      });

      expect(screen.getByText("原因と解決策")).toBeInTheDocument();
      expect(screen.getByText("原因から解決策への説明")).toBeInTheDocument();
      expect(screen.getByText("関連度 80%")).toBeInTheDocument();
      expect(screen.getByText("メモ1")).toBeInTheDocument();
      expect(screen.getByText("(原因)")).toBeInTheDocument();
      expect(screen.getByText("スクショ1")).toBeInTheDocument();
      expect(screen.getByText("(解決策)")).toBeInTheDocument();
    });

    it("無向エッジ(same-theme)は役割ラベルなしで両端名のみ表示する", () => {
      renderPanel({
        selection: {
          type: "edge",
          link: {
            id: "e2",
            source: "n1",
            target: "n2",
            directed: false,
            relationType: "same-theme",
            description: "同じテーマについての説明",
            relatedness: 0.42,
          },
        },
      });

      expect(screen.getByText("同じテーマ")).toBeInTheDocument();
      expect(screen.getByText("関連度 42%")).toBeInTheDocument();
      expect(screen.getByText("メモ1 ・ スクショ1")).toBeInTheDocument();
      expect(screen.queryByText("(原因)")).not.toBeInTheDocument();
    });

    it("役割ラベルを持つ relationType でも directed: false のときは役割ラベル・矢印を出さず両端名のみ表示する(退行検知)", () => {
      // `link.directed` を無視して `roleLabels` の有無だけで分岐すると、`cause-solution` の
      // ような役割ラベル持ちの種類は `directed: false` でも「原因 → 解決策」と誤表示される
      // (Codex レビュー指摘・修正1)。この退行を検知するテスト。
      renderPanel({
        selection: {
          type: "edge",
          link: {
            id: "e4",
            source: "n1",
            target: "n2",
            directed: false,
            relationType: "cause-solution",
            description: "向きが確定していない関係の説明",
            relatedness: 0.5,
          },
        },
      });

      expect(screen.getByText("原因と解決策")).toBeInTheDocument();
      expect(screen.getByText("メモ1 ・ スクショ1")).toBeInTheDocument();
      expect(screen.queryByText("(原因)")).not.toBeInTheDocument();
      expect(screen.queryByText("(解決策)")).not.toBeInTheDocument();
      expect(screen.queryByText("→")).not.toBeInTheDocument();
    });

    it("両端ノートが nodesById に無い場合はフォールバック表示にする", () => {
      renderPanel({
        selection: {
          type: "edge",
          link: {
            id: "e3",
            source: "missing-source",
            target: "missing-target",
            directed: false,
            relationType: "other",
            description: "不明なノート間の関係",
            relatedness: 0.1,
          },
        },
      });

      expect(screen.getByText("(不明なノート) ・ (不明なノート)")).toBeInTheDocument();
    });
  });
});
