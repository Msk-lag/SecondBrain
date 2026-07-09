import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { NoteListPage } from "./NoteListPage";
import { apiClient } from "@/lib/api-client";

vi.mock("@/lib/api-client", () => ({
  apiClient: {
    notes: {
      list: vi.fn(),
      delete: vi.fn(),
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
});
