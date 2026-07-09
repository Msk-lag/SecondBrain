import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { toast } from "sonner";
import { NoteEditPage } from "./NoteEditPage";
import { apiClient } from "@/lib/api-client";

vi.mock("@/lib/api-client", () => ({
  apiClient: {
    notes: {
      get: vi.fn(),
      update: vi.fn(),
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
});
