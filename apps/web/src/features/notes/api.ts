import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreateMemoNoteRequest, UpdateNoteRequest } from "@secondbrain/shared";
import { apiClient } from "@/lib/api-client";

export const notesKeys = {
  all: ["notes"] as const,
  list: () => [...notesKeys.all, "list"] as const,
  detail: (id: string) => [...notesKeys.all, "detail", id] as const,
};

const NOTES_PAGE_SIZE = 20;

export function useNotesQuery() {
  return useInfiniteQuery({
    queryKey: notesKeys.list(),
    queryFn: async ({ pageParam }: { pageParam: string | undefined }) => {
      const response = await apiClient.notes.list({
        query: { cursor: pageParam, limit: NOTES_PAGE_SIZE },
      });
      if (response.status !== 200) {
        throw new Error(`一覧の取得に失敗しました(status: ${response.status})`);
      }
      return response.body;
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

export function useNoteQuery(id: string) {
  return useQuery({
    queryKey: notesKeys.detail(id),
    queryFn: async () => {
      const response = await apiClient.notes.get({ params: { id } });
      if (response.status === 404) {
        return null;
      }
      if (response.status !== 200) {
        throw new Error(`ノートの取得に失敗しました(status: ${response.status})`);
      }
      return response.body;
    },
  });
}

export function useCreateNoteMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateMemoNoteRequest) => {
      const response = await apiClient.notes.create({ body: input });
      if (response.status !== 201) {
        throw new Error(`ノートの作成に失敗しました(status: ${response.status})`);
      }
      return response.body;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: notesKeys.list() });
    },
  });
}

export function useUpdateNoteMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateNoteRequest) => {
      const response = await apiClient.notes.update({ params: { id }, body: input });
      if (response.status === 404) {
        throw new Error("ノートが見つかりません。");
      }
      if (response.status !== 200) {
        throw new Error(`ノートの更新に失敗しました(status: ${response.status})`);
      }
      return response.body;
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(notesKeys.detail(id), updated);
      void queryClient.invalidateQueries({ queryKey: notesKeys.list() });
    },
  });
}

export function useDeleteNoteMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const response = await apiClient.notes.delete({ params: { id } });
      if (response.status === 404) {
        throw new Error("ノートが見つかりません。");
      }
      if (response.status !== 204) {
        throw new Error(`ノートの削除に失敗しました(status: ${response.status})`);
      }
    },
    onSuccess: (_data, id) => {
      queryClient.removeQueries({ queryKey: notesKeys.detail(id) });
      void queryClient.invalidateQueries({ queryKey: notesKeys.list() });
    },
  });
}
