import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import type { GraphAdjacency, GraphViewLink, GraphViewNode } from "@/features/graph/to-graph-data";
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

    it("向きがあっても役割ラベルを持たない関係種別(same-theme/other)は種別バッジのみ表示する(契約上は起こらない防御的な分岐)", async () => {
      // `same-theme`/`other` は契約上つねに `directed === false`(=direction は "none")のため、
      // 実データでは `direction === "outgoing"/"incoming"` と組み合わさることは無い。
      // それでも `connectionRoleLabel` はその組み合わせに対して防御的に null を返す作りに
      // なっているため、あえてその組み合わせを adjacency へ渡して検証する。
      const noRoleLabelAdjacency: GraphAdjacency = new Map([
        [
          "n1",
          [
            {
              edge: {
                id: "e-same-theme-outgoing",
                directed: true,
                relationType: "same-theme",
                description: "同じテーマの説明",
                relatedness: 0.4,
              },
              otherNodeId: "n2",
              direction: "outgoing",
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
        adjacency: noRoleLabelAdjacency,
      });

      expect(await screen.findByText("接続ノード(1)")).toBeInTheDocument();
      expect(screen.getByText("同じテーマ")).toBeInTheDocument();
      // 役割ラベル(括弧付きテキスト)は一切出ない。
      expect(screen.queryByText(/^\(.+\)$/)).not.toBeInTheDocument();
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
      // 「関係するノート」一覧にも同じラベルが出るため(受入条件6・8)、向き表示欄
      // (`edge-endpoint-summary`)へ範囲を絞って検証する(複数マッチでの失敗を避ける)。
      const summary = within(screen.getByTestId("edge-endpoint-summary"));
      expect(summary.getByText("メモ1")).toBeInTheDocument();
      expect(summary.getByText("(原因)")).toBeInTheDocument();
      expect(summary.getByText("スクショ1")).toBeInTheDocument();
      expect(summary.getByText("(解決策)")).toBeInTheDocument();
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

      // 受入条件14: このテストは一覧追加後も落ちない(向き表示欄の結合テキストと、
      // 一覧の個別項目テキストが異なる文字列のため衝突しない)。ただし一覧側にも
      // 「(不明なノート)」項目が2件(source・target)出ることを追加で検証する
      // (受入条件10。計画の指示どおり、既存アサーションは書き換えずに追加する)。
      expect(screen.getByText("(不明なノート) ・ (不明なノート)")).toBeInTheDocument();

      const relatedNotesSection = within(screen.getByRole("region", { name: "関係するノート" }));
      const unknownItems = relatedNotesSection.getAllByText("(不明なノート)");
      expect(unknownItems).toHaveLength(2);
      for (const item of unknownItems) {
        // クリック不可(決定4)。button/link のどちらの役割も持たない。
        expect(item.closest('[role="button"]')).toBeNull();
        expect(item.closest('[role="link"]')).toBeNull();
        expect(item.closest("button")).toBeNull();
      }
    });

    // 以下の2ケース(ケースS・ケースO)は両方必須である。`d3-force` は link の
    // `source`/`target` を文字列からノードオブジェクト参照へ in-place で書き換えるため、
    // 実行時に実際に成立するのはケースO の形である。ケースS だけを検証していたために
    // 本バグ(両端ノート名が常に「(不明なノート)」になる)が CI をすり抜けた。
    // 逆にケースO だけにすると、文字列のまま渡ってくるケース(初回描画前など)の
    // 退行を検知できなくなるため、両方を持つ。
    it("source/target が文字列のとき両端ノート名を表示する(ケースS)", () => {
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

      // 「関係するノート」一覧にも同じラベルが出るため、向き表示欄へ範囲を絞って検証する。
      const summary = within(screen.getByTestId("edge-endpoint-summary"));
      expect(summary.getByText("メモ1")).toBeInTheDocument();
      expect(summary.getByText("スクショ1")).toBeInTheDocument();
      expect(screen.queryAllByText("(不明なノート)")).toHaveLength(0);
    });

    it("source/target が d3-force 書き換え後のノードオブジェクトのときも両端ノート名を表示する(ケースO・退行検知)", () => {
      // `react-force-graph`/`d3-force` はレンダリング後、link オブジェクトの
      // `source`/`target` を文字列 ID からノードオブジェクト参照へ in-place で
      // 書き換える。`GraphViewLink.source`/`target` の型は `string | GraphViewNode`
      // なので、素の `GraphViewNode` を渡すだけでこのケースを表現できる
      // (型が実態に合ったため、以前は必要だった `as unknown as` キャストは不要になった)。
      const link: GraphViewLink = {
        id: "e1",
        source: { id: "n1", label: "メモ1", type: "memo", degree: 1 },
        target: { id: "n2", label: "スクショ1", type: "screenshot", degree: 1 },
        directed: true,
        relationType: "cause-solution",
        description: "原因から解決策への説明",
        relatedness: 0.8,
      };

      renderPanel({
        selection: {
          type: "edge",
          link,
        },
      });

      // 「関係するノート」一覧にも同じラベルが出るため、向き表示欄へ範囲を絞って検証する。
      const summary = within(screen.getByTestId("edge-endpoint-summary"));
      expect(summary.getByText("メモ1")).toBeInTheDocument();
      expect(summary.getByText("スクショ1")).toBeInTheDocument();
      expect(screen.queryAllByText("(不明なノート)")).toHaveLength(0);
    });

    describe("関係するノート一覧(動線追加。§設計決定3〜5)", () => {
      const directedLink: GraphViewLink = {
        id: "e1",
        source: "n1",
        target: "n2",
        directed: true,
        relationType: "cause-solution",
        description: "原因から解決策への説明",
        relatedness: 0.8,
      };

      it("受入条件6: 「関係するノート(2)」セクションが表示され、両端ノート名が一覧される", () => {
        renderPanel({ selection: { type: "edge", link: directedLink } });

        const list = within(screen.getByRole("region", { name: "関係するノート" }));
        expect(list.getByText("関係するノート(2)")).toBeInTheDocument();
        expect(list.getByText("メモ1")).toBeInTheDocument();
        expect(list.getByText("スクショ1")).toBeInTheDocument();
      });

      // 受入条件7: source 側・target 側を独立にクリックして、それぞれ異なる ID で
      // onSelectNode が呼ばれることを検証する(両方必須)。片側だけの検証では、
      // 両項目が誤って同じ端点 ID を使う実装(例: 両方に sourceId を渡すコピペ誤り)を
      // 表示テストもクリックテストも素通りさせてしまうため(Codex 指摘1)。
      it("受入条件7: 関係するノート一覧の source 側項目をクリックすると onSelectNode が source のノート ID で呼ばれる", async () => {
        const user = userEvent.setup();
        const { onSelectNode } = renderPanel({ selection: { type: "edge", link: directedLink } });

        const list = within(screen.getByRole("region", { name: "関係するノート" }));
        await user.click(list.getByText("メモ1"));

        expect(onSelectNode).toHaveBeenCalledWith("n1");
      });

      it("受入条件7: 関係するノート一覧の target 側項目をクリックすると onSelectNode が target のノート ID で呼ばれる", async () => {
        const user = userEvent.setup();
        const { onSelectNode } = renderPanel({ selection: { type: "edge", link: directedLink } });

        const list = within(screen.getByRole("region", { name: "関係するノート" }));
        await user.click(list.getByText("スクショ1"));

        expect(onSelectNode).toHaveBeenCalledWith("n2");
      });

      it("受入条件8: 有向 + 役割ラベル持ちのとき、一覧項目に (原因)(解決策) が出る", () => {
        renderPanel({ selection: { type: "edge", link: directedLink } });

        const list = within(screen.getByRole("region", { name: "関係するノート" }));
        expect(list.getByText("(原因)")).toBeInTheDocument();
        expect(list.getByText("(解決策)")).toBeInTheDocument();
      });

      it("受入条件9: directed: false + cause-solution のとき、一覧に役割ラベルが出ない(退行検知)", () => {
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

        const list = within(screen.getByRole("region", { name: "関係するノート" }));
        expect(list.getByText("メモ1")).toBeInTheDocument();
        expect(list.getByText("スクショ1")).toBeInTheDocument();
        expect(list.queryByText("(原因)")).not.toBeInTheDocument();
        expect(list.queryByText("(解決策)")).not.toBeInTheDocument();
      });

      it("受入条件10: nodesById に無い端点は (不明なノート) のクリック不可項目になる", () => {
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

        const list = within(screen.getByRole("region", { name: "関係するノート" }));
        const unknownItems = list.getAllByText("(不明なノート)");
        expect(unknownItems).toHaveLength(2);
        for (const item of unknownItems) {
          expect(item.closest('[role="button"]')).toBeNull();
          expect(item.closest('[role="link"]')).toBeNull();
          expect(item.closest("button")).toBeNull();
          expect(item.closest("a")).toBeNull();
        }
      });
    });
  });
});
