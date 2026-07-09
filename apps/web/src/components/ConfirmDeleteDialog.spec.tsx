import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { ConfirmDeleteDialog } from "./ConfirmDeleteDialog";
import { apiClient } from "@/lib/api-client";

vi.mock("@/lib/api-client", () => ({
  apiClient: {
    notes: {
      delete: vi.fn(),
    },
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function renderDialog(onDeleted?: () => void) {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ConfirmDeleteDialog
        noteId="note-1"
        trigger={<button type="button">削除</button>}
        onDeleted={onDeleted}
      />
    </QueryClientProvider>,
  );
}

describe("ConfirmDeleteDialog", () => {
  beforeEach(() => {
    vi.mocked(apiClient.notes.delete).mockReset();
    vi.mocked(toast.success).mockReset();
  });

  it("削除成功でトーストを表示しダイアログを閉じて onDeleted を呼ぶ", async () => {
    vi.mocked(apiClient.notes.delete).mockResolvedValue({
      status: 204,
      body: undefined,
      headers: new Headers(),
    });
    const onDeleted = vi.fn();
    const user = userEvent.setup();
    renderDialog(onDeleted);

    await user.click(screen.getByRole("button", { name: "削除" }));
    await user.click(await screen.findByRole("button", { name: "削除する" }));

    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith("削除しました");
  });

  it("削除失敗時はエラーを表示しダイアログを閉じない", async () => {
    vi.mocked(apiClient.notes.delete).mockRejectedValue(new Error("network error"));
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "削除" }));
    await user.click(await screen.findByRole("button", { name: "削除する" }));

    expect(
      await screen.findByText("削除に失敗しました。しばらくしてから再度お試しください。"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "キャンセル" })).toBeInTheDocument();
  });
});
