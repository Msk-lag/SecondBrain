import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { toast } from "sonner";
import { NoteEditPage } from "./NoteEditPage";
import { apiClient } from "@/lib/api-client";

vi.mock("@/lib/api-client", () => ({
  apiClient: {
    notes: {
      get: vi.fn(),
      update: vi.fn(),
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
  title: "旧タイトル",
  body: "旧本文",
  summary: null,
  tags: ["読書"],
  status: "completed" as const,
  failureReason: null,
  concepts: [],
  extractedText: null,
  createdAt: "2026-07-09T00:00:00.000Z",
  updatedAt: "2026-07-09T00:00:00.000Z",
};

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/notes/note-1/edit"]}>
        <Routes>
          <Route path="/notes/:id/edit" element={<NoteEditPage />} />
          <Route path="/notes/:id" element={<div>詳細画面</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("NoteEditPage", () => {
  beforeEach(() => {
    vi.mocked(apiClient.notes.get).mockReset();
    vi.mocked(apiClient.notes.update).mockReset();
    vi.mocked(apiClient.notes.retry).mockReset();
    vi.mocked(toast.success).mockReset();
  });

  it("既存の値をフォームに反映する", async () => {
    vi.mocked(apiClient.notes.get).mockResolvedValue({
      status: 200,
      body: note,
      headers: new Headers(),
    });

    renderPage();

    expect(await screen.findByDisplayValue("旧タイトル")).toBeInTheDocument();
    expect(screen.getByDisplayValue("旧本文")).toBeInTheDocument();
    expect(screen.getByText("読書")).toBeInTheDocument();
  });

  it("ルートのノートIDが変わるとフォームを新しいノートの内容で再初期化する(Codex コードレビュー r1 指摘 [A-2])", async () => {
    const noteB = {
      ...note,
      id: "note-2",
      title: "別ノートのタイトル",
      body: "別ノートの本文",
      tags: ["仕事"],
    };
    vi.mocked(apiClient.notes.get).mockImplementation(({ params }: { params: { id: string } }) =>
      Promise.resolve({
        status: 200,
        body: params.id === "note-2" ? noteB : note,
        headers: new Headers(),
      }),
    );

    function Harness() {
      const navigate = useNavigate();
      return (
        <>
          <button
            onClick={() => {
              void navigate("/notes/note-2/edit");
            }}
          >
            別ノートへ移動
          </button>
          <NoteEditPage />
        </>
      );
    }

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/notes/note-1/edit"]}>
          <Routes>
            <Route path="/notes/:id/edit" element={<Harness />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByDisplayValue("旧タイトル")).toBeInTheDocument();

    await userEvent.click(screen.getByText("別ノートへ移動"));

    expect(await screen.findByDisplayValue("別ノートのタイトル")).toBeInTheDocument();
    expect(screen.getByDisplayValue("別ノートの本文")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("旧タイトル")).not.toBeInTheDocument();
  });

  it("本文を空にして保存するとバリデーションエラーを表示する", async () => {
    vi.mocked(apiClient.notes.get).mockResolvedValue({
      status: 200,
      body: note,
      headers: new Headers(),
    });
    const user = userEvent.setup();
    renderPage();

    const bodyField = await screen.findByLabelText("本文");
    await user.clear(bodyField);
    await user.click(screen.getByRole("button", { name: "保存する" }));

    expect(await screen.findByText("本文を入力してください")).toBeInTheDocument();
    expect(apiClient.notes.update).not.toHaveBeenCalled();
  });

  it("保存に成功すると詳細画面へ戻る", async () => {
    vi.mocked(apiClient.notes.get).mockResolvedValue({
      status: 200,
      body: note,
      headers: new Headers(),
    });
    vi.mocked(apiClient.notes.update).mockResolvedValue({
      status: 200,
      body: { ...note, title: "新タイトル" },
      headers: new Headers(),
    });
    const user = userEvent.setup();
    renderPage();

    await screen.findByDisplayValue("旧タイトル");
    await user.click(screen.getByRole("button", { name: "保存する" }));

    await waitFor(() => expect(screen.getByText("詳細画面")).toBeInTheDocument());
    expect(toast.success).toHaveBeenCalledWith("保存しました");
  });

  it("保存エラー時はバナーを表示する", async () => {
    vi.mocked(apiClient.notes.get).mockResolvedValue({
      status: 200,
      body: note,
      headers: new Headers(),
    });
    vi.mocked(apiClient.notes.update).mockRejectedValue(new Error("network error"));
    const user = userEvent.setup();
    renderPage();

    await screen.findByDisplayValue("旧タイトル");
    await user.click(screen.getByRole("button", { name: "保存する" }));

    expect(
      await screen.findByText("保存に失敗しました。しばらくしてから再度お試しください。"),
    ).toBeInTheDocument();
  });

  it("非404の取得失敗時は「見つかりません」ではなくエラー表示にする", async () => {
    vi.mocked(apiClient.notes.get).mockRejectedValue(new Error("network error"));

    renderPage();

    expect(
      await screen.findByText("ノートの取得に失敗しました。しばらくしてから再度お試しください。"),
    ).toBeInTheDocument();
    expect(screen.queryByText("ノートが見つかりません")).not.toBeInTheDocument();
  });

  describe("screenshot ノート", () => {
    const screenshotNote = {
      ...note,
      type: "screenshot" as const,
      title: "スクリーンショットの要点",
      body: null,
    };

    it("completed の場合は本文欄が無く、他の欄は編集できる", async () => {
      vi.mocked(apiClient.notes.get).mockResolvedValue({
        status: 200,
        body: screenshotNote,
        headers: new Headers(),
      });

      renderPage();

      await screen.findByDisplayValue("スクリーンショットの要点");
      expect(screen.queryByLabelText("本文")).not.toBeInTheDocument();
      expect(screen.getByLabelText("タイトル")).toBeEnabled();
      expect(screen.getByRole("button", { name: "保存する" })).toBeEnabled();
    });

    it("processing の場合は入力欄を無効化し保存できない", async () => {
      vi.mocked(apiClient.notes.get).mockResolvedValue({
        status: 200,
        body: { ...screenshotNote, status: "processing", title: null },
        headers: new Headers(),
      });

      renderPage();

      expect(await screen.findByText("処理が完了するまで編集できません。")).toBeInTheDocument();
      expect(screen.getByLabelText("タイトル")).toBeDisabled();
      expect(screen.getByLabelText("要約")).toBeDisabled();
      expect(screen.getByLabelText("タグ")).toBeDisabled();
      expect(screen.getByRole("button", { name: "保存する" })).toBeDisabled();
    });

    it("processing から completed へポーリングで遷移すると、AI生成内容でフォームを再初期化する(Codex コードレビュー r4 指摘 [A-1])", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        vi.mocked(apiClient.notes.get)
          .mockResolvedValueOnce({
            status: 200,
            body: { ...screenshotNote, status: "processing", title: null, summary: null },
            headers: new Headers(),
          })
          .mockResolvedValue({
            status: 200,
            body: {
              ...screenshotNote,
              status: "completed",
              title: "AIが生成したタイトル",
              summary: "AIが生成した要約",
            },
            headers: new Headers(),
          });

        renderPage();

        expect(await screen.findByText("処理が完了するまで編集できません。")).toBeInTheDocument();

        await vi.advanceTimersByTimeAsync(3000);

        expect(await screen.findByDisplayValue("AIが生成したタイトル")).toBeInTheDocument();
        expect(screen.getByDisplayValue("AIが生成した要約")).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it("failed の場合は入力欄を無効化したまま再実行ボタンのみ操作できる", async () => {
      vi.mocked(apiClient.notes.get).mockResolvedValue({
        status: 200,
        body: {
          ...screenshotNote,
          status: "failed",
          title: null,
          failureReason: "解析に失敗しました",
        },
        headers: new Headers(),
      });
      vi.mocked(apiClient.notes.retry).mockResolvedValue({
        status: 200,
        body: { ...screenshotNote, status: "pending", title: null },
        headers: new Headers(),
      });
      const user = userEvent.setup();

      renderPage();

      expect(
        await screen.findByText("処理に失敗しました。再実行してから編集してください。"),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("タイトル")).toBeDisabled();

      await user.click(screen.getByRole("button", { name: "再実行する" }));
      expect(apiClient.notes.retry).toHaveBeenCalledWith({ params: { id: "note-1" } });
    });
  });
});
