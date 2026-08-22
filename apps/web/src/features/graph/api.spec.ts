import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { graphKeys, useGraphQuery } from "./api";
import { apiClient } from "@/lib/api-client";

vi.mock("@/lib/api-client", () => ({
  apiClient: {
    graph: {
      get: vi.fn(),
    },
  },
}));

const emptyGraph = {
  nodes: [],
  edges: [],
  truncated: { nodes: false, edges: false },
  processingNoteCount: 0,
};

const processingGraph = {
  ...emptyGraph,
  processingNoteCount: 2,
};

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

describe("graphKeys", () => {
  it("all は ['graph']", () => {
    expect(graphKeys.all).toEqual(["graph"]);
  });
});

describe("useGraphQuery", () => {
  it("200 応答のとき body を返す", async () => {
    vi.mocked(apiClient.graph.get).mockResolvedValue({
      status: 200,
      body: emptyGraph,
      headers: new Headers(),
    });

    const { result } = renderHook(() => useGraphQuery(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(emptyGraph);
  });

  it("200以外の応答はエラーを投げる", async () => {
    vi.mocked(apiClient.graph.get).mockResolvedValue({
      status: 500,
      body: { message: "internal error" },
      headers: new Headers(),
    });

    const { result } = renderHook(() => useGraphQuery(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  // ポーリング間隔の緩急(M2-2 §設計決定6・受入条件8)。processingNoteCount を
  // 停止条件に使わない(停止制御を一切実装しない)ことの退行検知を兼ねる
  // — 30秒経過後も processingNoteCount === 0 のまま再取得され続けることを確認する。
  describe("refetchInterval", () => {
    // `@testing-library/react` の `waitFor` はフェイクタイマーを検知すると、条件が
    // 満たされるまで**内部で自らタイマーを進めてしまう**。そのため「初回取得の落ち着き
    // 待ち」に `waitFor` を使うと、基準値を記録した時点でインターバルの位相が
    // ずれてしまい(次の発火までの残り時間が満額でない)、以降の境界値アサーション
    // (interval-1ms で未発火 / interval で発火)が成立しなくなる。
    //
    // `apiClient.graph.get` は `mockResolvedValue` で即座に解決するため、初回取得の
    // 確定に**タイマーを進める必要は無い**。`waitFor` を使わず、`act` の中で
    // `advanceTimersByTimeAsync(0)`(0ms なのでフェイクタイマーの時刻自体は進めない)
    // によって保留中のマイクロタスク・0ms タイマー(TanStack Query の通知バッチング分含む)
    // だけを1周させ、タイマーが1msも進んでいない状態から検証を始める。
    //
    // `vi.useFakeTimers()` に `shouldAdvanceTime: true` は付けない(Codex 指摘 MEDIUM)。
    // `shouldAdvanceTime` は実時間の経過に合わせてフェイク時刻を自動的にも進めてしまう
    // オプションで、負荷の高い実行環境では 2,999ms の手動進行に自動進行分が上乗せされ、
    // 3,000ms の境界を越えて意図せず再取得が発火し得る(境界値アサーションの不安定化)。
    // このテストが検証する時刻進行はすべて `advanceTimersByTimeAsync` による明示的な
    // 呼び出しのみで完結しており(初回取得の確定も上記の 0ms 進めで足りる)、実時間に
    // 連動した自動進行は不要。
    async function flushMicrotasks() {
      await act(async () => {
        // 1回で確定しない場合に備え、0ms 進めを複数回繰り返す(0ms なのでフェイク
        // タイマーの時刻自体は一切進まない。安全に繰り返せる)。
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(0);
      });
    }

    it("processingNoteCount > 0 の間は3秒間隔で再取得する", async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(apiClient.graph.get).mockResolvedValue({
          status: 200,
          body: processingGraph,
          headers: new Headers(),
        });

        const { result } = renderHook(() => useGraphQuery(), { wrapper: createWrapper() });
        await flushMicrotasks();
        expect(result.current.isSuccess).toBe(true);

        const baseline = vi.mocked(apiClient.graph.get).mock.calls.length;

        // 2,999ms ではまだ発火しない。
        await vi.advanceTimersByTimeAsync(2_999);
        expect(apiClient.graph.get).toHaveBeenCalledTimes(baseline);

        // さらに 1ms(計3,000ms)で1回発火する。
        await vi.advanceTimersByTimeAsync(1);
        expect(apiClient.graph.get).toHaveBeenCalledTimes(baseline + 1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("processingNoteCount === 0 の間は30秒経過するまで再取得しない(停止はしない)", async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(apiClient.graph.get).mockResolvedValue({
          status: 200,
          body: emptyGraph,
          headers: new Headers(),
        });

        const { result } = renderHook(() => useGraphQuery(), { wrapper: createWrapper() });
        await flushMicrotasks();
        expect(result.current.isSuccess).toBe(true);

        const baseline = vi.mocked(apiClient.graph.get).mock.calls.length;

        // 3,000ms(短い方の間隔)ではまだ発火しない。
        await vi.advanceTimersByTimeAsync(3_000);
        expect(apiClient.graph.get).toHaveBeenCalledTimes(baseline);

        // 29,999ms 時点でもまだ発火しない。
        await vi.advanceTimersByTimeAsync(26_999);
        expect(apiClient.graph.get).toHaveBeenCalledTimes(baseline);

        // 30,000ms で1回発火する。
        await vi.advanceTimersByTimeAsync(1);
        expect(apiClient.graph.get).toHaveBeenCalledTimes(baseline + 1);

        // 停止せず、さらに30,000ms後にもう1回発火する
        // (`processingNoteCount` を停止条件に使わないことの確認 — 受入条件8 の退行検知)。
        await vi.advanceTimersByTimeAsync(30_000);
        expect(apiClient.graph.get).toHaveBeenCalledTimes(baseline + 2);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
