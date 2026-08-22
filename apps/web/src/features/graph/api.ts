import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";

export const graphKeys = {
  all: ["graph"] as const,
};

// processingNoteCount > 0(AI が関係判定中のノートがある)の間だけ短い間隔でポーリングし、
// それ以外は緩める(M2-2 §設計決定6)。
const GRAPH_POLL_INTERVAL_ACTIVE_MS = 3_000;
const GRAPH_POLL_INTERVAL_IDLE_MS = 30_000;

/**
 * `GET /graph`(M2-1)。知識ネットワーク全体(ノード=ノート、エッジ=F-19 の確定関係)を
 * 1リクエストで取得する。
 *
 * **ポーリングは緩急のある固定間隔のみ**(2026-08-19 の Fable 5 + Codex 独立議論で
 * 「停止制御」を丸ごと廃止し簡素化した。M2-2 §設計決定6)。
 * `processingNoteCount > 0` の間は 3 秒、0 の間は 30 秒で固定し、**`processingNoteCount` を
 * ポーリングの停止条件には使わない**(ヒントに過ぎず「0 = 全処理完了」を保証しない
 * — M2-1 §設計決定6 / graph.ts の `graphResponseSchema` コメント参照)。
 * ヒステリシス・`useRef` による停滞デッドライン・`dataUpdateCount` による停止上限は
 * いずれも実装しない(退行検知。§設計決定6・受入条件8)。
 * タブが非表示の間は TanStack Query の `refetchIntervalInBackground` 既定(`false`)により
 * 自動的に止まる。これが唯一かつ十分な停止機構である。
 */
export function useGraphQuery() {
  return useQuery({
    queryKey: graphKeys.all,
    queryFn: async () => {
      const response = await apiClient.graph.get();
      if (response.status !== 200) {
        throw new Error(`ネットワークの取得に失敗しました(status: ${response.status})`);
      }
      return response.body;
    },
    refetchInterval: (query) => {
      const processingNoteCount = query.state.data?.processingNoteCount ?? 0;
      return processingNoteCount > 0 ? GRAPH_POLL_INTERVAL_ACTIVE_MS : GRAPH_POLL_INTERVAL_IDLE_MS;
    },
  });
}
