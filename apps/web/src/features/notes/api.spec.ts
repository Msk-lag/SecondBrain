import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import {
  useCreateNoteMutation,
  useDeleteNoteMutation,
  useNoteQuery,
  useNotesQuery,
  useUpdateNoteMutation,
} from "./api";
import { apiClient } from "@/lib/api-client";

vi.mock("@/lib/api-client", () => ({
  apiClient: {
    notes: {
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
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
  createdAt: "2026-07-09T00:00:00.000Z",
  updatedAt: "2026-07-09T00:00:00.000Z",
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
