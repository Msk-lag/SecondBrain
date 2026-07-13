import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProcessingStatusPanel } from "./ProcessingStatusPanel";
import { apiClient } from "@/lib/api-client";

vi.mock("@/lib/api-client", () => ({
  apiClient: {
    notes: {
      get: vi.fn(),
      retry: vi.fn(),
    },
  },
}));

const baseNote = {
  id: "note-1",
  userId: "user-1",
  type: "screenshot" as const,
  title: null,
  body: null,
  summary: null,
  tags: [] as string[],
  failureReason: null as string | null,
  concepts: [] as string[],
  extractedText: null,
  createdAt: "2026-07-09T00:00:00.000Z",
  updatedAt: "2026-07-09T00:00:00.000Z",
};

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ProcessingStatusPanel noteId="note-1" />
    </QueryClientProvider>,
  );
}

describe("ProcessingStatusPanel", () => {
  beforeEach(() => {
    vi.mocked(apiClient.notes.get).mockReset();
    vi.mocked(apiClient.notes.retry).mockReset();
  });

  it("処理状況の取得に失敗した場合は「処理を開始しています」のまま固定せずエラー表示にする(Codex コードレビュー r4 指摘 [A-3])", async () => {
    vi.mocked(apiClient.notes.get).mockRejectedValue(new Error("network error"));

    renderPanel();

    expect(
      await screen.findByText("処理状況の取得に失敗しました。しばらくしてから再度お試しください。"),
    ).toBeInTheDocument();
    expect(screen.queryByText("受け付けました。処理を開始しています…")).not.toBeInTheDocument();
  });

  it("処理中は不定プログレスを表示する", async () => {
    vi.mocked(apiClient.notes.get).mockResolvedValue({
      status: 200,
      body: { ...baseNote, status: "processing" },
      headers: new Headers(),
    });

    renderPanel();

    expect(await screen.findByText("処理中です。しばらくお待ちください。")).toBeInTheDocument();
  });

  it("完了時はタイトル・要約・タグを表示する", async () => {
    vi.mocked(apiClient.notes.get).mockResolvedValue({
      status: 200,
      body: {
        ...baseNote,
        status: "completed",
        title: "スクリーンショットの要点",
        summary: "要約文",
        tags: ["読書"],
      },
      headers: new Headers(),
    });

    renderPanel();

    expect(await screen.findByText("スクリーンショットの要点")).toBeInTheDocument();
    expect(screen.getByText("要約文")).toBeInTheDocument();
    expect(screen.getByText("読書")).toBeInTheDocument();
  });

  it("失敗時はエラー表示+再実行ボタンを表示し、再実行を呼び出せる", async () => {
    vi.mocked(apiClient.notes.get).mockResolvedValue({
      status: 200,
      body: { ...baseNote, status: "failed", failureReason: "解析に失敗しました" },
      headers: new Headers(),
    });
    vi.mocked(apiClient.notes.retry).mockResolvedValue({
      status: 200,
      body: { ...baseNote, status: "pending" },
      headers: new Headers(),
    });
    const user = userEvent.setup();

    renderPanel();

    expect(
      await screen.findByText("処理に失敗しました。アーカイブ自体は保存済みです。"),
    ).toBeInTheDocument();
    expect(screen.getByText("解析に失敗しました")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "再実行する" }));

    await waitFor(() =>
      expect(apiClient.notes.retry).toHaveBeenCalledWith({ params: { id: "note-1" } }),
    );
  });
});
