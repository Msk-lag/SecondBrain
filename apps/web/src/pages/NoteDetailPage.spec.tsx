import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { toast } from "sonner";
import { NoteDetailPage } from "./NoteDetailPage";
import { apiClient } from "@/lib/api-client";
import { notesKeys } from "@/features/notes/api";

vi.mock("@/lib/api-client", () => ({
  apiClient: {
    notes: {
      get: vi.fn(),
      delete: vi.fn(),
      retry: vi.fn(),
      related: vi.fn(),
    },
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const note = {
  id: "note-1",
  userId: "user-1",
  type: "memo" as const,
  title: "一言メモ",
  body: "本文の内容です。",
  summary: "要約テキスト",
  tags: ["読書", "アイデア"],
  status: "completed" as const,
  failureReason: null,
  concepts: [],
  extractedText: null,
  createdAt: "2026-07-09T00:00:00.000Z",
  updatedAt: "2026-07-09T00:00:00.000Z",
};

function renderPage(id: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/notes/${id}`]}>
        <Routes>
          <Route path="/notes/:id" element={<NoteDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("NoteDetailPage", () => {
  beforeEach(() => {
    vi.mocked(apiClient.notes.get).mockReset();
    vi.mocked(apiClient.notes.retry).mockReset();
    vi.mocked(toast.error).mockReset();
    vi.mocked(apiClient.notes.related).mockReset();
    // 個々のテストの主眼は関連ノート以外のため、既定では両方とも確定済み・空で返しておく
    // (関連ノート自体の表示・状態は専用の describe ブロックで検証する)。
    vi.mocked(apiClient.notes.related).mockResolvedValue({
      status: 200,
      body: { status: "ready", relationStatus: "not_started", relations: [], similar: [] },
      headers: new Headers(),
    });
  });

  it("通常時はタイトル・本文・要約・タグを表示する", async () => {
    vi.mocked(apiClient.notes.get).mockResolvedValue({
      status: 200,
      body: note,
      headers: new Headers(),
    });

    renderPage("note-1");

    expect(await screen.findByRole("heading", { name: "一言メモ" })).toBeInTheDocument();
    expect(screen.getByText("本文の内容です。")).toBeInTheDocument();
    expect(screen.getByText("要約テキスト")).toBeInTheDocument();
    expect(screen.getByText("読書")).toBeInTheDocument();
  });

  it("404 のときは見つからない旨を表示する", async () => {
    vi.mocked(apiClient.notes.get).mockResolvedValue({
      status: 404,
      body: { message: "not found" },
      headers: new Headers(),
    });

    renderPage("missing");

    expect(await screen.findByText("ノートが見つかりません")).toBeInTheDocument();
  });

  it("非404の取得失敗時は「見つかりません」ではなくエラー表示にする", async () => {
    vi.mocked(apiClient.notes.get).mockRejectedValue(new Error("network error"));

    renderPage("note-1");

    expect(
      await screen.findByText("ノートの取得に失敗しました。しばらくしてから再度お試しください。"),
    ).toBeInTheDocument();
    expect(screen.queryByText("ノートが見つかりません")).not.toBeInTheDocument();
  });

  describe("screenshot ノート", () => {
    const screenshotNote = {
      ...note,
      type: "screenshot" as const,
      title: null,
      body: null,
      summary: null,
      tags: [] as string[],
    };

    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Blob(["binary"]))));
      URL.createObjectURL = vi.fn(() => "blob:mock-url");
      URL.revokeObjectURL = vi.fn();
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("処理中は画像+不定プログレスを表示し本文見出しは「処理中…」にする", async () => {
      vi.mocked(apiClient.notes.get).mockResolvedValue({
        status: 200,
        body: { ...screenshotNote, status: "processing" },
        headers: new Headers(),
      });

      renderPage("note-1");

      expect(await screen.findByRole("heading", { name: "処理中…" })).toBeInTheDocument();
      expect(screen.getByText("処理中です。要約はまもなく生成されます。")).toBeInTheDocument();
    });

    it("失敗時はエラー表示+再実行ボタンを表示する", async () => {
      vi.mocked(apiClient.notes.get).mockResolvedValue({
        status: 200,
        body: { ...screenshotNote, status: "failed", failureReason: "解析に失敗しました" },
        headers: new Headers(),
      });
      vi.mocked(apiClient.notes.retry).mockResolvedValue({
        status: 200,
        body: { ...screenshotNote, status: "pending" },
        headers: new Headers(),
      });
      const user = userEvent.setup();

      renderPage("note-1");

      expect(
        await screen.findByText("処理に失敗しました。アーカイブ自体は保存済みです。"),
      ).toBeInTheDocument();
      expect(screen.getByText("解析に失敗しました")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "再実行する" }));
      expect(apiClient.notes.retry).toHaveBeenCalledWith({ params: { id: "note-1" } });
    });

    it("再実行が失敗した場合はエラー内容を toast で表示する(Codex コードレビュー r3 指摘 [A-4])", async () => {
      vi.mocked(apiClient.notes.get).mockResolvedValue({
        status: 200,
        body: { ...screenshotNote, status: "failed", failureReason: "解析に失敗しました" },
        headers: new Headers(),
      });
      vi.mocked(apiClient.notes.retry).mockResolvedValue({
        status: 409,
        body: { message: "conflict" },
        headers: new Headers(),
      });
      const user = userEvent.setup();

      renderPage("note-1");

      await user.click(await screen.findByRole("button", { name: "再実行する" }));

      await vi.waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith("このノートは現在再実行できません。");
      });
    });

    it("画像取得が失敗した場合はスケルトンのままにせずエラー表示にする(Codex コードレビュー r3 指摘 [A-5])", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 502 })));
      vi.mocked(apiClient.notes.get).mockResolvedValue({
        status: 200,
        body: { ...screenshotNote, status: "completed" },
        headers: new Headers(),
      });

      renderPage("note-1");

      expect(await screen.findByText("画像の取得に失敗しました。")).toBeInTheDocument();
    });

    it("画像取得の失敗後、再試行ボタンで画面遷移せずに画像を再取得できる(Codex コードレビュー 2026-07-13 r6 指摘 [A-3])", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 502 }))
        .mockResolvedValueOnce(new Response(new Blob(["binary"]), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      URL.createObjectURL = vi.fn(() => "blob:mock-url");
      URL.revokeObjectURL = vi.fn();
      vi.mocked(apiClient.notes.get).mockResolvedValue({
        status: 200,
        body: { ...screenshotNote, status: "completed" },
        headers: new Headers(),
      });
      const user = userEvent.setup();

      renderPage("note-1");

      await user.click(await screen.findByRole("button", { name: "再試行" }));

      expect(await screen.findByAltText("保存したスクリーンショット")).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("完了時は抽出テキストを折りたたみで表示できる", async () => {
      vi.mocked(apiClient.notes.get).mockResolvedValue({
        status: 200,
        body: {
          ...screenshotNote,
          status: "completed",
          title: "スクリーンショットの要点",
          extractedText: "抽出された原文テキスト",
        },
        headers: new Headers(),
      });
      const user = userEvent.setup();

      renderPage("note-1");

      expect(
        await screen.findByRole("heading", { name: "スクリーンショットの要点" }),
      ).toBeInTheDocument();
      expect(screen.queryByText("抽出された原文テキスト")).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "抽出したテキストを表示" }));

      expect(screen.getByText("抽出された原文テキスト")).toBeInTheDocument();
    });
  });

  describe("関連ノートセクション", () => {
    beforeEach(() => {
      vi.mocked(apiClient.notes.get).mockResolvedValue({
        status: 200,
        body: note,
        headers: new Headers(),
      });
    });

    describe("類似ノート群", () => {
      it("類似ノートを表示し、項目が該当ノート詳細へのリンクになる", async () => {
        vi.mocked(apiClient.notes.related).mockResolvedValue({
          status: 200,
          body: {
            status: "ready",
            relationStatus: "not_started",
            relations: [],
            similar: [
              {
                id: "note-2",
                title: "関連メモ",
                type: "memo" as const,
                excerpt: "関連する抜粋テキスト",
                distance: 0.12,
              },
            ],
          },
          headers: new Headers(),
        });

        renderPage("note-1");

        expect(await screen.findByText("関連メモ")).toBeInTheDocument();
        expect(screen.getByText("関連する抜粋テキスト")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: /関連メモ/ })).toHaveAttribute(
          "href",
          "/notes/note-2",
        );
      });

      it("タイトル未入力の類似ノートは仮タイトル表示ロジックを再利用する", async () => {
        vi.mocked(apiClient.notes.related).mockResolvedValue({
          status: 200,
          body: {
            status: "ready",
            relationStatus: "not_started",
            relations: [],
            similar: [
              {
                id: "note-3",
                title: null,
                type: "memo" as const,
                excerpt: "タイトル未入力ノートの抜粋",
                distance: 0.2,
              },
            ],
          },
          headers: new Headers(),
        });

        renderPage("note-1");

        // title が無い場合は excerpt から仮タイトルを補い、抜粋行は二重表示しない
        // (§ apps/web/src/features/notes/utils.ts の getDisplayTitle 参照)。
        expect(await screen.findByText("タイトル未入力ノートの抜粋")).toBeInTheDocument();
        expect(screen.getAllByText("タイトル未入力ノートの抜粋")).toHaveLength(1);
      });

      it("ready かつ類似ノートが無い場合は空状態メッセージを表示する", async () => {
        vi.mocked(apiClient.notes.related).mockResolvedValue({
          status: 200,
          body: {
            status: "ready",
            relationStatus: "not_started",
            relations: [],
            similar: [],
          },
          headers: new Headers(),
        });

        renderPage("note-1");

        expect(await screen.findByText("類似するノートはまだありません。")).toBeInTheDocument();
      });

      // 生成中(generating)は「類似候補が無い」という確定結果とは区別し、生成中表示に留めて
      // 空状態メッセージは出さない(Fable 5 + Codex 独立議論 論点2 で確定)。
      it("generating の場合は生成中表示を出し、空状態メッセージは表示しない", async () => {
        vi.mocked(apiClient.notes.related).mockResolvedValue({
          status: 200,
          body: {
            status: "generating",
            relationStatus: "not_started",
            relations: [],
            similar: [],
          },
          headers: new Headers(),
        });

        renderPage("note-1");

        expect(await screen.findByText("類似ノートを生成中…")).toBeInTheDocument();
        expect(screen.queryByText("類似するノートはまだありません。")).not.toBeInTheDocument();
      });

      it("failed の場合は控えめな失敗表示を出し、専用のリトライボタンは設けない", async () => {
        vi.mocked(apiClient.notes.related).mockResolvedValue({
          status: 200,
          body: {
            status: "failed",
            relationStatus: "not_started",
            relations: [],
            similar: [],
          },
          headers: new Headers(),
        });

        renderPage("note-1");

        expect(await screen.findByText("類似ノートを生成できませんでした。")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /再試行|リトライ/ })).not.toBeInTheDocument();
        // ノート本体の表示が壊れていないこと。
        expect(screen.getByRole("heading", { name: "一言メモ" })).toBeInTheDocument();
      });

      // API は status === "failed" のとき similar を常に空配列で返す契約だが(§設計決定10)、
      // 万一 items が渡ってきても表示条件を "ready" のみにしているため描画されないことを
      // 表示側の防御として確認する(指示 (d) のデッドコード是正に対応するテスト)。
      it("failed の場合は similar に項目があっても一覧を表示しない", async () => {
        vi.mocked(apiClient.notes.related).mockResolvedValue({
          status: 200,
          body: {
            status: "failed",
            relationStatus: "not_started",
            relations: [],
            similar: [
              {
                id: "note-4",
                title: "古い候補",
                type: "memo" as const,
                excerpt: "生成成功時点の候補",
                distance: 0.3,
              },
            ],
          },
          headers: new Headers(),
        });

        renderPage("note-1");

        expect(await screen.findByText("類似ノートを生成できませんでした。")).toBeInTheDocument();
        expect(screen.queryByText("古い候補")).not.toBeInTheDocument();
      });

      it("取得に失敗してもノート本体の表示は壊れず、セクション内にエラーを表示する", async () => {
        vi.mocked(apiClient.notes.related).mockRejectedValue(new Error("network error"));

        renderPage("note-1");

        expect(await screen.findByRole("heading", { name: "一言メモ" })).toBeInTheDocument();
        expect(await screen.findByText("類似ノートの取得に失敗しました。")).toBeInTheDocument();
      });

      // Codex D0 レビュー MEDIUM 指摘への回帰テスト。TanStack Query はバックグラウンド
      // 再取得が失敗しても直前の `data` を保持したまま `isError` を立てるため、表示条件を
      // `!isError` で組むと一時的な通信障害だけで永続化済みの関係まで画面から消える。
      // relationStatus === "generating" の間は3秒間隔でポーリングしており、これはまさに
      // relations を「前回の結果」として見せている状態なので実際に踏みうる経路。
      //
      // ポーリング周期を待つ代わりに、キャッシュへ成功結果を事前投入したうえで API を失敗
      // させる(マウント時の再取得が失敗し、`data` あり + `isError` の状態が決定的に作れる)。
      it("再取得に失敗しても、直前に取得済みの関係・類似は表示され続ける(エラー文言は併記する)", async () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        queryClient.setQueryData(notesKeys.related("note-1"), {
          status: "ready",
          relationStatus: "generating",
          relations: [
            {
              id: "note-10",
              title: "原因ノート",
              type: "memo" as const,
              excerpt: null,
              relationType: "cause-solution" as const,
              typeDirection: "outgoing" as const,
              description: "原因と解決策の関係です。",
              relatedness: 0.84,
            },
          ],
          similar: [{ id: "note-20", title: "類似ノート", type: "memo" as const, excerpt: null }],
        });
        vi.mocked(apiClient.notes.related).mockRejectedValue(new Error("network error"));

        render(
          <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={["/notes/note-1"]}>
              <Routes>
                <Route path="/notes/:id" element={<NoteDetailPage />} />
              </Routes>
            </MemoryRouter>
          </QueryClientProvider>,
        );

        expect(await screen.findByText("類似ノートの取得に失敗しました。")).toBeInTheDocument();
        // キャッシュ済みの関係・類似は消えない。
        expect(screen.getByRole("link", { name: /原因ノート/ })).toBeInTheDocument();
        expect(screen.getByRole("link", { name: /類似ノート/ })).toBeInTheDocument();
      });
    });

    describe("関係あり群", () => {
      const outgoingRelation = {
        id: "note-10",
        title: "原因ノート",
        type: "memo" as const,
        excerpt: "原因側の抜粋",
        relationType: "cause-solution" as const,
        typeDirection: "outgoing" as const,
        description: "このノートで説明した問題が、原因ノートの内容で解決される。",
        relatedness: 0.842,
      };

      it("関係あり群と類似群が区別して表示される(見出しが分かれる)", async () => {
        vi.mocked(apiClient.notes.related).mockResolvedValue({
          status: 200,
          body: {
            status: "ready",
            relationStatus: "ready",
            relations: [outgoingRelation],
            similar: [
              {
                id: "note-11",
                title: "類似ノート",
                type: "memo" as const,
                excerpt: "類似側の抜粋",
                distance: 0.4,
              },
            ],
          },
          headers: new Headers(),
        });

        renderPage("note-1");

        expect(
          await screen.findByRole("heading", { name: "関係のあるノート" }),
        ).toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "類似ノート" })).toBeInTheDocument();
        expect(screen.getByText("原因ノート")).toBeInTheDocument();
        expect(screen.getByText("類似ノート", { selector: "p" })).toBeInTheDocument();
      });

      it("種類バッジ・説明文・関連度を表示する", async () => {
        vi.mocked(apiClient.notes.related).mockResolvedValue({
          status: 200,
          body: {
            status: "ready",
            relationStatus: "ready",
            relations: [outgoingRelation],
            similar: [],
          },
          headers: new Headers(),
        });

        renderPage("note-1");

        expect(await screen.findByText("原因と解決策")).toBeInTheDocument();
        expect(
          screen.getByText("このノートで説明した問題が、原因ノートの内容で解決される。"),
        ).toBeInTheDocument();
        expect(screen.getByText("関連度 84%")).toBeInTheDocument();
      });

      it("typeDirection が outgoing のときは左項の役割ラベルを表示する", async () => {
        vi.mocked(apiClient.notes.related).mockResolvedValue({
          status: 200,
          body: {
            status: "ready",
            relationStatus: "ready",
            relations: [{ ...outgoingRelation, typeDirection: "outgoing" as const }],
            similar: [],
          },
          headers: new Headers(),
        });

        renderPage("note-1");

        expect(await screen.findByText("(原因)")).toBeInTheDocument();
      });

      it("typeDirection が incoming のときは右項の役割ラベルを表示する", async () => {
        vi.mocked(apiClient.notes.related).mockResolvedValue({
          status: 200,
          body: {
            status: "ready",
            relationStatus: "ready",
            relations: [{ ...outgoingRelation, typeDirection: "incoming" as const }],
            similar: [],
          },
          headers: new Headers(),
        });

        renderPage("note-1");

        expect(await screen.findByText("(解決策)")).toBeInTheDocument();
      });

      it("typeDirection が none のときは向きラベルを表示しない", async () => {
        vi.mocked(apiClient.notes.related).mockResolvedValue({
          status: 200,
          body: {
            status: "ready",
            relationStatus: "ready",
            relations: [
              {
                ...outgoingRelation,
                relationType: "same-theme" as const,
                typeDirection: "none" as const,
              },
            ],
            similar: [],
          },
          headers: new Headers(),
        });

        renderPage("note-1");

        expect(await screen.findByText("同じテーマ")).toBeInTheDocument();
        expect(screen.queryByText("(原因)")).not.toBeInTheDocument();
        expect(screen.queryByText("(解決策)")).not.toBeInTheDocument();
      });

      // 契約上 same-theme/other の typeDirection は常に "none" になるため通常は起きないが、
      // RelationDirectionLabel には防御的な分岐(RELATION_DIRECTION_ROLE_LABELS に該当
      // エントリが無い場合は null を返す)がある。万一 API が不整合な組み合わせ
      // (same-theme なのに typeDirection が outgoing 等)を返しても、役割ラベルの
      // 括弧書きを出さずに表示が壊れないことを確認する。
      it("relationType が same-theme(役割ラベル定義なし)で typeDirection が none 以外の場合でも、役割ラベルの括弧書きは表示されない(防御的分岐。契約上は起きない組み合わせ)", async () => {
        vi.mocked(apiClient.notes.related).mockResolvedValue({
          status: 200,
          body: {
            status: "ready",
            relationStatus: "ready",
            relations: [
              {
                ...outgoingRelation,
                relationType: "same-theme" as const,
                typeDirection: "outgoing" as const,
              },
            ],
            similar: [],
          },
          headers: new Headers(),
        });

        renderPage("note-1");

        expect(await screen.findByText("同じテーマ")).toBeInTheDocument();
        // 役割ラベルはどの語彙にも定義が無いため、括弧書きのテキストが一切出ないこと。
        expect(screen.queryByText(/^\(.+\)$/)).not.toBeInTheDocument();
      });

      it("not_started かつ関係が無い場合は関係あり群自体を表示しない", async () => {
        vi.mocked(apiClient.notes.related).mockResolvedValue({
          status: 200,
          body: {
            status: "ready",
            relationStatus: "not_started",
            relations: [],
            similar: [],
          },
          headers: new Headers(),
        });

        renderPage("note-1");

        await screen.findByText("類似するノートはまだありません。");
        expect(screen.queryByRole("heading", { name: "関係のあるノート" })).not.toBeInTheDocument();
      });

      it("ready かつ関係が無い場合は「見つかりませんでした」を表示する", async () => {
        vi.mocked(apiClient.notes.related).mockResolvedValue({
          status: 200,
          body: {
            status: "ready",
            relationStatus: "ready",
            relations: [],
            similar: [],
          },
          headers: new Headers(),
        });

        renderPage("note-1");

        expect(
          await screen.findByText("関係のあるノートは見つかりませんでした"),
        ).toBeInTheDocument();
      });

      it("generating かつ関係が無い場合は判定中である旨を表示する", async () => {
        vi.mocked(apiClient.notes.related).mockResolvedValue({
          status: 200,
          body: {
            status: "ready",
            relationStatus: "generating",
            relations: [],
            similar: [],
          },
          headers: new Headers(),
        });

        renderPage("note-1");

        expect(await screen.findByText("関係を判定中です")).toBeInTheDocument();
      });

      // generating 中でも relations は前回の確定結果を返す(§設計決定10)ため、それが
      // 「前回の結果」であることを UI で必ず表現する(§設計決定11 の必須要件)。
      it("generating かつ関係が既にある場合は前回の結果である旨を表示しつつ一覧も表示する", async () => {
        vi.mocked(apiClient.notes.related).mockResolvedValue({
          status: 200,
          body: {
            status: "ready",
            relationStatus: "generating",
            relations: [outgoingRelation],
            similar: [],
          },
          headers: new Headers(),
        });

        renderPage("note-1");

        expect(
          await screen.findByText("関係を更新中です(表示は前回の結果です)"),
        ).toBeInTheDocument();
        expect(screen.getByText("原因ノート")).toBeInTheDocument();
      });

      it("failed の場合は判定失敗の旨を表示する", async () => {
        vi.mocked(apiClient.notes.related).mockResolvedValue({
          status: 200,
          body: {
            status: "ready",
            relationStatus: "failed",
            relations: [],
            similar: [],
          },
          headers: new Headers(),
        });

        renderPage("note-1");

        expect(await screen.findByText("関係の判定に失敗しました")).toBeInTheDocument();
      });

      // エッジ済みの相手は API 側(§設計決定10 の NOT EXISTS 除外)で similar から
      // 除かれる契約になっている。表示側では、relations と similar に別々のノートが
      // 来た場合に双方が正しくそれぞれの群に描画され、取り違え・重複が起きないことを
      // 確認する(表示上の確認。除外自体は API 側の責務)。
      it("エッジ済みの相手が類似群に重複せず、双方が別々の群に表示される", async () => {
        vi.mocked(apiClient.notes.related).mockResolvedValue({
          status: 200,
          body: {
            status: "ready",
            relationStatus: "ready",
            relations: [outgoingRelation],
            similar: [
              {
                id: "note-12",
                title: "別の類似ノート",
                type: "memo" as const,
                excerpt: "類似側のみに存在する抜粋",
                distance: 0.5,
              },
            ],
          },
          headers: new Headers(),
        });

        renderPage("note-1");

        expect(await screen.findByText("原因ノート")).toBeInTheDocument();
        expect(screen.getByText("別の類似ノート")).toBeInTheDocument();
        // 関係あり群の相手(note-10)が類似群にも重複して現れていないこと。
        expect(screen.queryByRole("link", { name: /原因ノート/ })).toHaveAttribute(
          "href",
          "/notes/note-10",
        );
        expect(screen.getAllByText("原因ノート")).toHaveLength(1);
      });
    });
  });
});
