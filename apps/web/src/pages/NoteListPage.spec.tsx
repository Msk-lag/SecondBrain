import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { NoteListPage } from "./NoteListPage";
import { apiClient } from "@/lib/api-client";

vi.mock("@/lib/api-client", () => ({
  apiClient: {
    notes: {
      list: vi.fn(),
      delete: vi.fn(),
      retry: vi.fn(),
    },
  },
}));

const note = {
  id: "note-1",
  userId: "user-1",
  type: "memo" as const,
  title: "一言メモ",
  body: "本文",
  summary: null,
  tags: [],
  status: "completed" as const,
  failureReason: null,
  concepts: [],
  extractedText: null,
  createdAt: "2026-07-09T00:00:00.000Z",
  updatedAt: "2026-07-09T00:00:00.000Z",
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <NoteListPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("NoteListPage", () => {
  beforeEach(() => {
    vi.mocked(apiClient.notes.list).mockReset();
    vi.mocked(apiClient.notes.retry).mockReset();
  });

  it("空のときは保存への誘導を表示する", async () => {
    vi.mocked(apiClient.notes.list).mockResolvedValue({
      status: 200,
      body: { items: [], nextCursor: null },
      headers: new Headers(),
    });

    renderPage();

    expect(await screen.findByText("まだノートがありません。")).toBeInTheDocument();
  });

  it("エラー時はエラーメッセージを表示する", async () => {
    vi.mocked(apiClient.notes.list).mockRejectedValue(new Error("network error"));

    renderPage();

    expect(
      await screen.findByText("一覧の取得に失敗しました。しばらくしてから再度お試しください。"),
    ).toBeInTheDocument();
  });

  it("ノートがある場合は一覧表示し、nextCursor が無ければ「さらに読み込む」を表示しない", async () => {
    vi.mocked(apiClient.notes.list).mockResolvedValue({
      status: 200,
      body: { items: [note], nextCursor: null },
      headers: new Headers(),
    });

    renderPage();

    expect(await screen.findByText("一言メモ")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "さらに読み込む" })).not.toBeInTheDocument(),
    );
  });

  it("nextCursor があれば「さらに読み込む」ボタンを表示する", async () => {
    vi.mocked(apiClient.notes.list).mockResolvedValue({
      status: 200,
      body: { items: [note], nextCursor: "cursor-1" },
      headers: new Headers(),
    });

    renderPage();

    expect(await screen.findByRole("button", { name: "さらに読み込む" })).toBeInTheDocument();
  });

  it("処理中の行はスケルトン+スピナーを表示しリンク化しない", async () => {
    const processingNote = {
      ...note,
      id: "note-2",
      type: "screenshot" as const,
      title: null,
      body: null,
      status: "processing" as const,
    };
    vi.mocked(apiClient.notes.list).mockResolvedValue({
      status: 200,
      body: { items: [processingNote], nextCursor: null },
      headers: new Headers(),
    });

    renderPage();

    await screen.findByText("処理中");
    // 「保存する」リンクのみが存在し、行自体はリンク化されない
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("失敗した行はエラー表示+再実行ボタンを表示し、再実行を呼び出せる", async () => {
    const failedNote = {
      ...note,
      id: "note-3",
      type: "screenshot" as const,
      title: null,
      body: null,
      status: "failed" as const,
      failureReason: "解析に失敗しました",
    };
    vi.mocked(apiClient.notes.list).mockResolvedValue({
      status: 200,
      body: { items: [failedNote], nextCursor: null },
      headers: new Headers(),
    });
    vi.mocked(apiClient.notes.retry).mockResolvedValue({
      status: 200,
      body: { ...failedNote, status: "pending" },
      headers: new Headers(),
    });
    const user = userEvent.setup();

    renderPage();

    expect(
      await screen.findByText("処理に失敗しました。アーカイブ自体は保存済みです。"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "再実行する" }));

    await waitFor(() =>
      expect(apiClient.notes.retry).toHaveBeenCalledWith({ params: { id: "note-3" } }),
    );
  });
});
