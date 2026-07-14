import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { toast } from "sonner";
import { NoteDetailPage } from "./NoteDetailPage";
import { apiClient } from "@/lib/api-client";

vi.mock("@/lib/api-client", () => ({
  apiClient: {
    notes: {
      get: vi.fn(),
      delete: vi.fn(),
      retry: vi.fn(),
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
});
