import { useEffect, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  SCREENSHOT_UPLOAD_FILE_FIELD_NAME,
  type CreateMemoNoteRequest,
  type CreateScreenshotNoteResponse,
  type Note,
  type ScreenshotUploadErrorResponse,
  type UpdateNoteRequest,
} from "@secondbrain/shared";
import { apiClient } from "@/lib/api-client";
import { useAuthStore } from "@/store/useAuthStore";

export const notesKeys = {
  all: ["notes"] as const,
  list: () => [...notesKeys.all, "list"] as const,
  detail: (id: string) => [...notesKeys.all, "detail", id] as const,
};

const NOTES_PAGE_SIZE = 20;
// 処理中(pending/processing)のノートが存在する間だけ有効にするポーリング間隔
// (design/handoffs/20260708-m1-mvp-screens.md 画面3b・4・5。§ 実装手順20・21・22 参照)。
const PROCESSING_POLL_INTERVAL_MS = 3000;

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000";

function isProcessingStatus(status: Note["status"]): boolean {
  return status === "pending" || status === "processing";
}

function authHeader(): Record<string, string> {
  const token = useAuthStore.getState().accessToken;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

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
    // 取得済みページ内に pending/processing のノートが1件でも含まれる間だけポーリングし、
    // 全ノートが終端状態(completed/failed)になった時点で自動停止する
    // (§ 実装手順21・Codex レビュー r29 指摘 [3] への対応)。
    refetchInterval: (query) => {
      const data = query.state.data;
      const hasProcessingNote = data?.pages.some((page) =>
        page.items.some((item) => isProcessingStatus(item.status)),
      );
      return hasProcessingNote ? PROCESSING_POLL_INTERVAL_MS : false;
    },
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
    // 対象ノートが pending/processing の間だけ有効にし、completed/failed に遷移した時点で
    // 自動停止する(§ 実装手順20・22・Codex レビュー r29 指摘 [3] への対応)。
    refetchInterval: (query) => {
      const data = query.state.data;
      return data && isProcessingStatus(data.status) ? PROCESSING_POLL_INTERVAL_MS : false;
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

/**
 * スクリーンショットのアップロード(FormData + fetch。ts-rest クライアント外)。
 * § 契約外エンドポイントの外部インターフェース定義(POST /notes/screenshots)参照。
 * Authorization ヘッダーは authStore から手動付与する。
 */
export function useCreateScreenshotNoteMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (file: File): Promise<CreateScreenshotNoteResponse> => {
      const formData = new FormData();
      formData.append(SCREENSHOT_UPLOAD_FILE_FIELD_NAME, file);

      const response = await fetch(`${API_BASE_URL}/notes/screenshots`, {
        method: "POST",
        headers: authHeader(),
        body: formData,
      });

      if (response.status !== 201) {
        const errorBody = (await response
          .json()
          .catch(() => null)) as ScreenshotUploadErrorResponse | null;
        throw new Error(
          errorBody?.message ??
            `スクリーンショットの保存に失敗しました(status: ${response.status})`,
        );
      }

      return (await response.json()) as CreateScreenshotNoteResponse;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: notesKeys.list() });
    },
  });
}

/**
 * PATCH /notes/:id の 400 応答(screenshot ノートへの body 更新拒否・completed 以外での
 * title/summary/tags 編集拒否)を汎用エラーと区別するためのマーカー型。
 */
export class NoteUpdateBadRequestError extends Error {}

export function useUpdateNoteMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateNoteRequest) => {
      const response = await apiClient.notes.update({ params: { id }, body: input });
      if (response.status === 404) {
        throw new Error("ノートが見つかりません。");
      }
      if (response.status === 400) {
        // screenshot ノートへの body 更新拒否・status !== "completed" 中の title/summary/tags
        // 編集拒否(§ notes テーブル拡張・削除の論理削除化 参照)。NoteEditPage はこの型で
        // 汎用エラーと区別し、サーバーのメッセージをそのまま表示する。
        throw new NoteUpdateBadRequestError(response.body.message);
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

/**
 * ユーザー起点の再実行(§ retry(ユーザー起点の再実行)の冪等性 参照)。
 * 成功時、レスポンスで返る pending note を詳細画面の query cache へ setQueryData で反映し、
 * 一覧の infinite query も invalidate して再取得する(Codex レビュー r32 指摘 [2] への対応。
 * これにより conditional refetchInterval が正しく再開する)。
 */
export function useRetryNoteMutation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const response = await apiClient.notes.retry({ params: { id } });
      if (response.status === 404) {
        throw new Error("ノートが見つかりません。");
      }
      if (response.status === 409) {
        throw new Error("このノートは現在再実行できません。");
      }
      if (response.status !== 200) {
        throw new Error(`再実行に失敗しました(status: ${response.status})`);
      }
      return response.body;
    },
    onSuccess: (pendingNote) => {
      queryClient.setQueryData(notesKeys.detail(id), pendingNote);
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

interface UseNoteImageResult {
  imageUrl: string | null;
  isLoading: boolean;
  isError: boolean;
  /** 502/504・ネットワーク断等の一時的な失敗から、画面遷移せずに再取得するための手動リトライ。 */
  retry: () => void;
}

/**
 * 認可済み API 経由での画像取得(GET /notes/:id/image)。
 * <img src> は Authorization ヘッダーを送れないため、認可済み fetch で取得した blob を
 * URL.createObjectURL で表示し、unmount 時に revoke する
 * (§ デザインとの対応「ハンドオフからの実装上の逸脱」参照)。
 *
 * 以前は `noteId` が変化した時にしか再取得せず、502/504 等の一時的な障害で `isError` に
 * なった後は画面を開き直すまで固定表示のままだった(Codex コードレビュー 2026-07-13 r6
 * 指摘 [A-3] への対応)。`retryToken` を再取得のトリガーに加え、利用者が実行できる
 * `retry()` を公開する。自動リトライは行わず(タイマー・バックオフの複雑さを避けるため)、
 * 呼び出し元 UI が失敗表示に「再試行」操作を用意する形にとどめる。
 */
export function useNoteImage(noteId: string): UseNoteImageResult {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    const abortController = new AbortController();

    // setState 呼び出しをすべて非同期関数側にまとめる(useEffect 本体で直接同期的に
    // setState を呼ぶと、react-hooks/set-state-in-effect が指摘するカスケードレンダーの
    // 懸念があるため。early-return 分岐(noteId が無い場合)も含め、この load() 関数に集約する)。
    const load = async () => {
      if (!noteId) {
        setImageUrl(null);
        setStatus("idle");
        return;
      }

      setStatus("loading");
      setImageUrl(null);

      try {
        const response = await fetch(`${API_BASE_URL}/notes/${noteId}/image`, {
          headers: authHeader(),
          signal: abortController.signal,
        });
        if (!response.ok) {
          throw new Error(`画像の取得に失敗しました(status: ${response.status})`);
        }
        const blob = await response.blob();
        if (cancelled) {
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setImageUrl(objectUrl);
        setStatus("success");
      } catch {
        if (!cancelled) {
          setStatus("error");
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
      abortController.abort();
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [noteId, retryToken]);

  const retry = () => {
    setRetryToken((token) => token + 1);
  };

  return { imageUrl, isLoading: status === "loading", isError: status === "error", retry };
}
