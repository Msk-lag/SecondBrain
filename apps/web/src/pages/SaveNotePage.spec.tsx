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
      get: vi.fn(),
      retry: vi.fn(),
    },
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
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
    vi.mocked(apiClient.notes.get).mockReset();
    vi.mocked(toast.success).mockReset();
  });

  it("スクショタブがデフォルトで選択されている", () => {
    renderPage();

    expect(screen.getByRole("tab", { name: "スクショ" })).toHaveAttribute("data-state", "active");
    expect(screen.getByRole("tab", { name: "URL(将来対応)" })).toBeDisabled();
  });

  it("本文が空のまま送信するとバリデーションエラーを表示し送信しない", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("tab", { name: "メモ" }));
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
        status: "completed",
        failureReason: null,
        concepts: [],
        extractedText: null,
        createdAt: "2026-07-09T00:00:00.000Z",
        updatedAt: "2026-07-09T00:00:00.000Z",
      },
      headers: new Headers(),
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("tab", { name: "メモ" }));
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

    await user.click(screen.getByRole("tab", { name: "メモ" }));
    await user.type(screen.getByLabelText("メモ本文"), "本文");
    await user.click(screen.getByRole("button", { name: "保存する" }));

    expect(
      await screen.findByText("受け付けに失敗しました。しばらくしてから再度お試しください。"),
    ).toBeInTheDocument();
  });

  describe("スクショタブ", () => {
    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn());
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("画像未選択で送信するとバリデーションエラーを表示する", async () => {
      const user = userEvent.setup();
      renderPage();

      await user.click(screen.getByRole("button", { name: "保存する" }));

      expect(
        await screen.findByText(
          "対応していない形式です。PNG・JPG・WebP、最大10MBまでの画像を選択してください",
        ),
      ).toBeInTheDocument();
      expect(fetch).not.toHaveBeenCalled();
    });

    it("画像を選択して送信すると受付トーストと処理状況パネルを表示する", async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            id: "note-2",
            userId: "user-1",
            type: "screenshot",
            title: null,
            body: null,
            summary: null,
            tags: [],
            status: "pending",
            failureReason: null,
            concepts: [],
            extractedText: null,
            createdAt: "2026-07-09T00:00:00.000Z",
            updatedAt: "2026-07-09T00:00:00.000Z",
          }),
          { status: 201 },
        ),
      );
      vi.mocked(apiClient.notes.get).mockResolvedValue({
        status: 200,
        body: {
          id: "note-2",
          userId: "user-1",
          type: "screenshot",
          title: null,
          body: null,
          summary: null,
          tags: [],
          status: "pending",
          failureReason: null,
          concepts: [],
          extractedText: null,
          createdAt: "2026-07-09T00:00:00.000Z",
          updatedAt: "2026-07-09T00:00:00.000Z",
        },
        headers: new Headers(),
      });
      const user = userEvent.setup();
      renderPage();

      const file = new File(["x"], "screenshot.png", { type: "image/png" });
      const input = screen.getByLabelText("スクリーンショット画像ファイルを選択");
      await user.upload(input, file);
      await user.click(screen.getByRole("button", { name: "保存する" }));

      await waitFor(() =>
        expect(toast.success).toHaveBeenCalledWith("受け付けました。続けて貼り付けできます"),
      );
      expect(await screen.findByText("処理中です。しばらくお待ちください。")).toBeInTheDocument();
    });

    it("受付エラー時はバナーを表示する", async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ message: "アップロードに失敗しました。" }), {
          status: 502,
        }),
      );
      const user = userEvent.setup();
      renderPage();

      const file = new File(["x"], "screenshot.png", { type: "image/png" });
      const input = screen.getByLabelText("スクリーンショット画像ファイルを選択");
      await user.upload(input, file);
      await user.click(screen.getByRole("button", { name: "保存する" }));

      expect(
        await screen.findByText("受け付けに失敗しました。しばらくしてから再度お試しください。"),
      ).toBeInTheDocument();
    });

    it("有効な画像を選択した後に無効なファイルを選び直すと、以前の画像はアップロードされない(Codex コードレビュー r10 指摘 [A-2])", async () => {
      const user = userEvent.setup();
      renderPage();

      const validFile = new File(["x"], "screenshot.png", { type: "image/png" });
      const input = screen.getByLabelText("スクリーンショット画像ファイルを選択");
      await user.upload(input, validFile);

      // input の `accept` 属性がファイル選択ダイアログ相当のフィルタとして働くため、
      // userEvent.upload では MIME 型違反のファイルを選ばせられない。サイズ超過
      // (10MB超)は accept 属性では弾かれず、コンポーネント自身のバリデーションでのみ
      // 拒否されるため、こちらで無効なファイル選択を再現する。
      const invalidFile = new File([new Uint8Array(11 * 1024 * 1024)], "too-large.png", {
        type: "image/png",
      });
      await user.upload(input, invalidFile);

      expect(
        await screen.findByText(
          "対応していない形式です。PNG・JPG・WebP、最大10MBまでの画像を選択してください",
        ),
      ).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "保存する" }));

      // 無効なファイル選択後は screenshotFile がクリアされているため、送信自体が
      // 発生しない(以前の有効なファイルがアップロードされない)。
      expect(fetch).not.toHaveBeenCalled();
    });
  });
});
