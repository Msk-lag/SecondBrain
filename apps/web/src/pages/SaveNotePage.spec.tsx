import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { SaveNotePage } from "./SaveNotePage";
import { apiClient } from "@/lib/api-client";

vi.mock("@/lib/api-client", () => ({
  apiClient: {
    notes: {
      create: vi.fn(),
    },
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SaveNotePage />
    </QueryClientProvider>,
  );
}

describe("SaveNotePage", () => {
  beforeEach(() => {
    vi.mocked(apiClient.notes.create).mockReset();
    vi.mocked(toast.success).mockReset();
  });

  it("本文が空のまま送信するとバリデーションエラーを表示し送信しない", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "保存する" }));

    expect(await screen.findByText("本文を入力してください")).toBeInTheDocument();
    expect(apiClient.notes.create).not.toHaveBeenCalled();
  });

  it("送信成功で入力をクリアしトーストを表示する(画面遷移しない)", async () => {
    vi.mocked(apiClient.notes.create).mockResolvedValue({
      status: 201,
      body: {
        id: "note-1",
        userId: "user-1",
        type: "memo",
        title: "一言",
        body: "本文",
        summary: null,
        tags: [],
        createdAt: "2026-07-09T00:00:00.000Z",
        updatedAt: "2026-07-09T00:00:00.000Z",
      },
      headers: new Headers(),
    });
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText("一言(任意)"), "一言");
    await user.type(screen.getByLabelText("メモ本文"), "本文");
    await user.click(screen.getByRole("button", { name: "保存する" }));

    await waitFor(() =>
      expect(apiClient.notes.create).toHaveBeenCalledWith({
        body: { title: "一言", body: "本文" },
      }),
    );
    await waitFor(() => expect(screen.getByLabelText("メモ本文")).toHaveValue(""));
    expect(screen.getByLabelText("一言(任意)")).toHaveValue("");
    expect(toast.success).toHaveBeenCalledWith("受け付けました。続けて貼り付けできます");
  });

  it("受付エラー時はバナーを表示する", async () => {
    vi.mocked(apiClient.notes.create).mockRejectedValue(new Error("network error"));
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText("メモ本文"), "本文");
    await user.click(screen.getByRole("button", { name: "保存する" }));

    expect(
      await screen.findByText("受け付けに失敗しました。しばらくしてから再度お試しください。"),
    ).toBeInTheDocument();
  });
});
