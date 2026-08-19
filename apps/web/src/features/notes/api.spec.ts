import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import {
  useCreateNoteMutation,
  useCreateScreenshotNoteMutation,
  useDeleteNoteMutation,
  useNoteImage,
  useNoteQuery,
  useNotesQuery,
  useRelatedNotesQuery,
  useRetryNoteMutation,
  useUpdateNoteMutation,
} from "./api";
import { apiClient } from "@/lib/api-client";
import { useAuthStore } from "@/store/useAuthStore";

vi.mock("@/lib/api-client", () => ({
  apiClient: {
    notes: {
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      retry: vi.fn(),
      related: vi.fn(),
    },
  },
}));

const note = {
  id: "note-1",
  userId: "user-1",
  type: "memo" as const,
  title: "一言",
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

const pendingScreenshotNote = {
  ...note,
  id: "note-2",
  type: "screenshot" as const,
  title: null,
  body: null,
  status: "pending" as const,
};

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

describe("useNotesQuery", () => {
  it("一覧を取得して items と nextCursor を返す", async () => {
    vi.mocked(apiClient.notes.list).mockResolvedValue({
      status: 200,
      body: { items: [note], nextCursor: null },
      headers: new Headers(),
    });

    const { result } = renderHook(() => useNotesQuery(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.pages[0]?.items).toEqual([note]);
  });
});

describe("useNoteQuery", () => {
  it("404 のとき null を返す", async () => {
    vi.mocked(apiClient.notes.get).mockResolvedValue({
      status: 404,
      body: { message: "not found" },
      headers: new Headers(),
    });

    const { result } = renderHook(() => useNoteQuery("missing"), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });
});

describe("useRelatedNotesQuery", () => {
  // 「取得しない」ことの検証は呼び出し履歴に依存するため、前のテストの履歴を持ち越さない
  beforeEach(() => {
    vi.mocked(apiClient.notes.related).mockClear();
  });

  it("類似ノートの一覧を返す", async () => {
    const similar = [
      { id: "note-2", title: "関連メモ", type: "memo" as const, excerpt: "抜粋", distance: 0.1 },
    ];
    vi.mocked(apiClient.notes.related).mockResolvedValue({
      status: 200,
      body: {
        status: "ready",
        relationStatus: "not_started",
        relations: [],
        similar,
      },
      headers: new Headers(),
    });

    const { result } = renderHook(() => useRelatedNotesQuery("note-1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.similar).toEqual(similar);
    expect(result.current.data?.status).toBe("ready");
  });

  it("200以外の応答はエラーを投げる", async () => {
    vi.mocked(apiClient.notes.related).mockResolvedValue({
      status: 404,
      body: { message: "not found" },
      headers: new Headers(),
    });

    const { result } = renderHook(() => useRelatedNotesQuery("note-1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it("noteId が空のときは取得しない", () => {
    const { result } = renderHook(() => useRelatedNotesQuery(""), {
      wrapper: createWrapper(),
    });

    expect(result.current.fetchStatus).toBe("idle");
    expect(apiClient.notes.related).not.toHaveBeenCalled();
  });

  // レスポンス自身の status を停止条件にした条件付きポーリング(Fable 5 + Codex 独立議論
  // 論点2 で確定)。generating の間だけポーリングし、ready に遷移した時点で必ず停止する
  // (§ 実装手順・NoteEditPage.spec.tsx の processing→completed ポーリングテストと同じ方式)。
  it("generating の間はポーリングし、ready に遷移すると停止する", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const similar = [
        { id: "note-2", title: "関連メモ", type: "memo" as const, excerpt: "抜粋", distance: 0.1 },
      ];
      vi.mocked(apiClient.notes.related)
        .mockResolvedValueOnce({
          status: 200,
          body: {
            status: "generating",
            relationStatus: "not_started",
            relations: [],
            similar: [],
          },
          headers: new Headers(),
        })
        .mockResolvedValue({
          status: 200,
          body: { status: "ready", relationStatus: "ready", relations: [], similar },
          headers: new Headers(),
        });

      const { result } = renderHook(() => useRelatedNotesQuery("note-1"), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.data?.status).toBe("generating"));
      expect(apiClient.notes.related).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(3000);
      await waitFor(() => expect(result.current.data?.status).toBe("ready"));
      expect(apiClient.notes.related).toHaveBeenCalledTimes(2);

      // ready に遷移した後は、間隔を経過させても再取得されない(ポーリング停止)。
      await vi.advanceTimersByTimeAsync(3000);
      expect(apiClient.notes.related).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("failed に遷移した場合もポーリングを停止する", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.mocked(apiClient.notes.related)
        .mockResolvedValueOnce({
          status: 200,
          body: {
            status: "generating",
            relationStatus: "not_started",
            relations: [],
            similar: [],
          },
          headers: new Headers(),
        })
        .mockResolvedValue({
          status: 200,
          body: { status: "failed", relationStatus: "failed", relations: [], similar: [] },
          headers: new Headers(),
        });

      const { result } = renderHook(() => useRelatedNotesQuery("note-1"), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.data?.status).toBe("generating"));

      await vi.advanceTimersByTimeAsync(3000);
      await waitFor(() => expect(result.current.data?.status).toBe("failed"));
      expect(apiClient.notes.related).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(3000);
      expect(apiClient.notes.related).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // M1-4b §設計決定10・11: 埋め込みが完了(status !== "generating")していても、関係判定が
  // 未完了(relationStatus === "generating")の間はポーリングを継続しなければならない。
  // これが無いと、埋め込み完了と同時にポーリングが止まり、初回の関係判定結果が
  // 画面に反映される前にポーリングが終わってしまう(§設計決定10「必須要件」参照)。
  it("status が ready でも relationStatus が generating の間はポーリングを継続する", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.mocked(apiClient.notes.related)
        .mockResolvedValueOnce({
          status: 200,
          body: { status: "ready", relationStatus: "generating", relations: [], similar: [] },
          headers: new Headers(),
        })
        .mockResolvedValue({
          status: 200,
          body: { status: "ready", relationStatus: "ready", relations: [], similar: [] },
          headers: new Headers(),
        });

      const { result } = renderHook(() => useRelatedNotesQuery("note-1"), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.data?.relationStatus).toBe("generating"));
      expect(apiClient.notes.related).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(3000);
      await waitFor(() => expect(result.current.data?.relationStatus).toBe("ready"));
      expect(apiClient.notes.related).toHaveBeenCalledTimes(2);

      // relationStatus も ready に確定した後は、間隔を経過させても再取得されない。
      await vi.advanceTimersByTimeAsync(3000);
      expect(apiClient.notes.related).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("useCreateNoteMutation", () => {
  it("作成に成功したノートを返す", async () => {
    vi.mocked(apiClient.notes.create).mockResolvedValue({
      status: 201,
      body: note,
      headers: new Headers(),
    });

    const { result } = renderHook(() => useCreateNoteMutation(), { wrapper: createWrapper() });
    result.current.mutate({ body: "本文" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(note);
  });
});

describe("useCreateScreenshotNoteMutation", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    useAuthStore.getState().setToken("token-123");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useAuthStore.getState().clear();
  });

  it("アップロードに成功した pending note を返す", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(pendingScreenshotNote), { status: 201 }),
    );

    const { result } = renderHook(() => useCreateScreenshotNoteMutation(), {
      wrapper: createWrapper(),
    });
    const file = new File(["x"], "screenshot.png", { type: "image/png" });
    result.current.mutate(file);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(pendingScreenshotNote);

    const [, requestInit] = vi.mocked(fetch).mock.calls[0];
    expect(requestInit?.headers).toMatchObject({ Authorization: "Bearer token-123" });
  });

  it("失敗レスポンスのメッセージでエラーを投げる", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ message: "対応していない形式です。" }), { status: 415 }),
    );

    const { result } = renderHook(() => useCreateScreenshotNoteMutation(), {
      wrapper: createWrapper(),
    });
    const file = new File(["x"], "document.pdf", { type: "application/pdf" });
    result.current.mutate(file);

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe("対応していない形式です。");
  });
});

describe("useUpdateNoteMutation", () => {
  it("404 のときエラーを投げる", async () => {
    vi.mocked(apiClient.notes.update).mockResolvedValue({
      status: 404,
      body: { message: "not found" },
      headers: new Headers(),
    });

    const { result } = renderHook(() => useUpdateNoteMutation("missing"), {
      wrapper: createWrapper(),
    });
    result.current.mutate({ title: "新タイトル" });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it("400 のときサーバーのメッセージでエラーを投げる", async () => {
    vi.mocked(apiClient.notes.update).mockResolvedValue({
      status: 400,
      body: { message: "screenshot ノートの本文は編集できません。" },
      headers: new Headers(),
    });

    const { result } = renderHook(() => useUpdateNoteMutation("note-2"), {
      wrapper: createWrapper(),
    });
    result.current.mutate({ title: "新タイトル" });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe("screenshot ノートの本文は編集できません。");
  });
});

describe("useRetryNoteMutation", () => {
  it("成功時、詳細キャッシュへ pending note を反映し一覧を invalidate する", async () => {
    vi.mocked(apiClient.notes.retry).mockResolvedValue({
      status: 200,
      body: pendingScreenshotNote,
      headers: new Headers(),
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);

    const { result } = renderHook(() => useRetryNoteMutation("note-2"), { wrapper });
    result.current.mutate();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryData(["notes", "detail", "note-2"])).toEqual(pendingScreenshotNote);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["notes", "list"] });
  });

  it("409 のとき再実行できない旨のエラーを投げる", async () => {
    vi.mocked(apiClient.notes.retry).mockResolvedValue({
      status: 409,
      body: { message: "conflict" },
      headers: new Headers(),
    });

    const { result } = renderHook(() => useRetryNoteMutation("note-2"), {
      wrapper: createWrapper(),
    });
    result.current.mutate();

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe("useDeleteNoteMutation", () => {
  it("204 のとき成功する", async () => {
    vi.mocked(apiClient.notes.delete).mockResolvedValue({
      status: 204,
      body: undefined,
      headers: new Headers(),
    });

    const { result } = renderHook(() => useDeleteNoteMutation(), { wrapper: createWrapper() });
    result.current.mutate("note-1");

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });
});

describe("useNoteImage", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    URL.createObjectURL = vi.fn(() => "blob:mock-url");
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("画像を取得して object URL を返す", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(new Blob(["binary"]), { status: 200 }));

    const { result } = renderHook(() => useNoteImage("note-2"));

    await waitFor(() => expect(result.current.imageUrl).toBe("blob:mock-url"));
    expect(result.current.isError).toBe(false);
  });

  it("取得に失敗した場合は isError を true にする", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 502 }));

    const { result } = renderHook(() => useNoteImage("note-2"));

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.imageUrl).toBeNull();
  });

  it("noteId が空のときは何もしない", () => {
    const { result } = renderHook(() => useNoteImage(""));

    expect(result.current.imageUrl).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  // 以前は noteId が変化した時にしか再取得せず、502等の一時的な障害後は画面を開き直すまで
  // isError=true のまま固定されていた(Codex コードレビュー 2026-07-13 r6 指摘 [A-3])。
  it("retry() を呼ぶと、noteId を変えずに再取得して成功しうる", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(null, { status: 502 }))
      .mockResolvedValueOnce(new Response(new Blob(["binary"]), { status: 200 }));

    const { result } = renderHook(() => useNoteImage("note-2"));

    await waitFor(() => expect(result.current.isError).toBe(true));

    result.current.retry();

    await waitFor(() => expect(result.current.imageUrl).toBe("blob:mock-url"));
    expect(result.current.isError).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
