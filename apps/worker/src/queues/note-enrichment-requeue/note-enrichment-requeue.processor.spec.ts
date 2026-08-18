import { NOTE_ENRICHMENT_JOB_OPTIONS, NOTE_ENRICHMENT_QUEUE_NAME } from "@secondbrain/shared";
import type { Database } from "@secondbrain/db";
import { SanitizedMaintenanceException } from "../../common/classify-maintenance-error";
import type { NoteEnrichmentRequeueTargetQueue } from "./note-enrichment-requeue-queue";
import { NoteEnrichmentRequeueProcessor } from "./note-enrichment-requeue.processor";

function fakeSelectWhere(
  selectQueue: Array<unknown[] | Error>,
  whereSpy?: (where: unknown) => void,
): (where: unknown) => unknown {
  return (where: unknown) => {
    whereSpy?.(where);
    const next = selectQueue.shift();
    const promise = next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? []);
    return Object.assign(promise, {
      orderBy: () => Object.assign(promise, { limit: () => promise }),
    });
  };
}

function createFakeDb(
  selectQueue: Array<unknown[] | Error>,
  whereSpy?: (where: unknown) => void,
): Database {
  const queue = [...selectQueue];
  return {
    select: () => ({ from: () => ({ where: fakeSelectWhere(queue, whereSpy) }) }),
  } as unknown as Database;
}

/**
 * drizzle-orm の `sql` タグが生成する `SQL` インスタンス(`queryChunks`)を、実際の依存追加無しに
 * 実行時のダックタイピングで概ねのクエリ文字列へ復元するテスト専用ヘルパー
 * (note-enrichment.processor.spec.ts の同名ヘルパーと同じ実装)。
 */
function extractSqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks;
  if (!Array.isArray(chunks)) {
    return "";
  }
  return chunks
    .map((chunk) => {
      if (typeof chunk !== "object" || chunk === null) {
        return String(chunk);
      }
      const c = chunk as { queryChunks?: unknown[]; value?: unknown };
      if (Array.isArray(c.queryChunks)) {
        return extractSqlText(c);
      }
      if (Array.isArray(c.value)) {
        return (c.value as unknown[]).map(String).join("");
      }
      if ("value" in c) {
        return String(c.value);
      }
      return "";
    })
    .join("");
}

interface FakeTargetQueue {
  targetQueue: NoteEnrichmentRequeueTargetQueue;
  getJob: ReturnType<typeof vi.fn>;
  add: ReturnType<typeof vi.fn>;
}

function createFakeTargetQueue(config: {
  getJobResults?: Array<{ getState: () => Promise<unknown> } | undefined | Error>;
  addImpl?: ReturnType<typeof vi.fn>;
}): FakeTargetQueue {
  const getJobResults = [...(config.getJobResults ?? [])];
  const getJob = vi.fn().mockImplementation(() => {
    const next = getJobResults.shift();
    if (next instanceof Error) {
      return Promise.reject(next);
    }
    return Promise.resolve(next);
  });
  const add = config.addImpl ?? vi.fn().mockResolvedValue(undefined);
  const targetQueue = { queue: { getJob, add } } as unknown as NoteEnrichmentRequeueTargetQueue;
  return { targetQueue, getJob, add };
}

function fakeJobWithState(
  state: unknown,
  removeImpl?: ReturnType<typeof vi.fn>,
): { getState: () => Promise<unknown>; remove: ReturnType<typeof vi.fn> } {
  return {
    getState: vi
      .fn()
      .mockImplementation(() =>
        state instanceof Error ? Promise.reject(state) : Promise.resolve(state),
      ),
    remove: removeImpl ?? vi.fn().mockResolvedValue(undefined),
  };
}

describe("NoteEnrichmentRequeueProcessor.process", () => {
  it("対象抽出 SELECT が10秒応答しない場合、withTimeout が MaintenanceTimeoutError で10秒タイムアウトさせ、サニタイズ済みエラーとして実行回全体を異常終了させる(withTimeout のタイムアウト分岐の回帰テスト)", async () => {
    vi.useFakeTimers();
    try {
      // 意図的に永遠に解決しない promise(note-purge.processor.spec.ts の同種テストと同じパターン)。
      // ネストしたクロージャを深くしないよう、チェーンの各段を外側で組み立てる。
      const pending = new Promise<unknown[]>(() => undefined);
      const limitStub = { limit: () => pending };
      const whereStub = { orderBy: () => limitStub };
      const db = {
        select: () => ({ from: () => ({ where: () => whereStub }) }),
      } as unknown as Database;
      const { targetQueue } = createFakeTargetQueue({});
      const processor = new NoteEnrichmentRequeueProcessor(db, targetQueue);

      const resultPromise = processor.process();
      const assertion = expect(resultPromise).rejects.toBeInstanceOf(SanitizedMaintenanceException);
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("最初の対象抽出 SELECT が失敗した場合、サニタイズ済みエラーを re-throw して実行回全体を異常終了させる", async () => {
    const secret = "connection refused to db-host:3306 secret-detail";
    const db = createFakeDb([new Error(secret)]);
    const { targetQueue } = createFakeTargetQueue({});
    const processor = new NoteEnrichmentRequeueProcessor(db, targetQueue);

    let caught: unknown;
    try {
      await processor.process();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SanitizedMaintenanceException);
    expect((caught as Error).message).not.toContain(secret);
  });

  it("BullMQ 上のジョブが waiting/active/delayed(処理継続中)なら再投入しない", async () => {
    for (const state of ["waiting", "active", "delayed"]) {
      const db = createFakeDb([[{ id: "note-1" }]]);
      const { targetQueue, add } = createFakeTargetQueue({
        getJobResults: [fakeJobWithState(state)],
      });
      const processor = new NoteEnrichmentRequeueProcessor(db, targetQueue);

      await processor.process();

      expect(add).not.toHaveBeenCalled();
    }
  });

  it("BullMQ 上のジョブが prioritized/waiting-children(非終端の他の状態)なら削除も再投入もしない(Codex 再レビュー HIGH 指摘への回帰テスト: 否定形判定だとこれらの状態が誤って削除対象になっていた)", async () => {
    for (const state of ["prioritized", "waiting-children"]) {
      const db = createFakeDb([[{ id: "note-1" }]]);
      const remove = vi.fn().mockResolvedValue(undefined);
      const { targetQueue, add } = createFakeTargetQueue({
        getJobResults: [fakeJobWithState(state, remove)],
      });
      const processor = new NoteEnrichmentRequeueProcessor(db, targetQueue);

      await processor.process();

      expect(remove).not.toHaveBeenCalled();
      expect(add).not.toHaveBeenCalled();
    }
  });

  it("BullMQ の getState() が未知の状態文字列を返した場合も削除・再投入せず、安全側(何もしない)に倒す", async () => {
    const db = createFakeDb([[{ id: "note-1" }]]);
    const remove = vi.fn().mockResolvedValue(undefined);
    const { targetQueue, add } = createFakeTargetQueue({
      getJobResults: [fakeJobWithState("some-future-state", remove)],
    });
    const processor = new NoteEnrichmentRequeueProcessor(db, targetQueue);

    await processor.process();

    expect(remove).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it("ジョブが存在しない(getJob が undefined を返す)場合は同一 jobId で再投入する", async () => {
    const db = createFakeDb([[{ id: "note-1" }]]);
    const { targetQueue, add } = createFakeTargetQueue({ getJobResults: [undefined] });
    const processor = new NoteEnrichmentRequeueProcessor(db, targetQueue);

    await processor.process();

    expect(add).toHaveBeenCalledWith(
      NOTE_ENRICHMENT_QUEUE_NAME,
      { noteId: "note-1" },
      { ...NOTE_ENRICHMENT_JOB_OPTIONS, jobId: "note-enrichment-note-1" },
    );
  });

  it("BullMQ 上のジョブが completed/failed の終端状態で残存している場合、再投入前にそのジョブを削除してから再投入する(削除しないと BullMQ が同一 jobId の add() を重複として無視し、対象ノートが pending のまま滞留し続けるため。Codex D0 レビュー HIGH 指摘への対応)", async () => {
    for (const state of ["completed", "failed"]) {
      const db = createFakeDb([[{ id: "note-2" }]]);
      const remove = vi.fn().mockResolvedValue(undefined);
      const job = fakeJobWithState(state, remove);
      const { targetQueue, add } = createFakeTargetQueue({
        getJobResults: [job],
      });
      const processor = new NoteEnrichmentRequeueProcessor(db, targetQueue);

      await processor.process();

      expect(remove).toHaveBeenCalledTimes(1);
      expect(add).toHaveBeenCalledWith(
        NOTE_ENRICHMENT_QUEUE_NAME,
        { noteId: "note-2" },
        { ...NOTE_ENRICHMENT_JOB_OPTIONS, jobId: "note-enrichment-note-2" },
      );
      // remove() が add() より先に呼ばれている(削除してから再投入する順序であることの確認)。
      const removeOrder = remove.mock.invocationCallOrder[0];
      const addOrder = add.mock.invocationCallOrder[add.mock.invocationCallOrder.length - 1];
      expect(removeOrder).toBeLessThan(addOrder);
    }
  });

  it("終端状態で残存しているジョブの remove() が失敗しても、その id の処理全体は落とさず add() で再投入する(削除の競合〔他プロセスが同時に削除した等〕を許容する)", async () => {
    const db = createFakeDb([[{ id: "note-3" }]]);
    const remove = vi.fn().mockRejectedValue(new Error("job already removed: secret"));
    const job = fakeJobWithState("completed", remove);
    const { targetQueue, add } = createFakeTargetQueue({ getJobResults: [job] });
    const processor = new NoteEnrichmentRequeueProcessor(db, targetQueue);

    await expect(processor.process()).resolves.toBeUndefined();

    expect(remove).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith(
      NOTE_ENRICHMENT_QUEUE_NAME,
      { noteId: "note-3" },
      { ...NOTE_ENRICHMENT_JOB_OPTIONS, jobId: "note-enrichment-note-3" },
    );
  });

  it("id ごとの getJob/add いずれかの失敗はその id のみスキップし、他の id の処理を継続する", async () => {
    const db = createFakeDb([[{ id: "note-a" }, { id: "note-b" }]]);
    const getJob = vi
      .fn()
      .mockRejectedValueOnce(new Error("redis unreachable: secret"))
      .mockResolvedValueOnce(undefined);
    const add = vi.fn().mockResolvedValue(undefined);
    const targetQueue = { queue: { getJob, add } } as unknown as NoteEnrichmentRequeueTargetQueue;
    const processor = new NoteEnrichmentRequeueProcessor(db, targetQueue);

    await expect(processor.process()).resolves.toBeUndefined();

    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith(
      NOTE_ENRICHMENT_QUEUE_NAME,
      { noteId: "note-b" },
      { ...NOTE_ENRICHMENT_JOB_OPTIONS, jobId: "note-enrichment-note-b" },
    );
  });

  it("queue.add() が失敗しても実行回全体は異常終了せず、その id のみスキップされる", async () => {
    const db = createFakeDb([[{ id: "note-4" }]]);
    const add = vi.fn().mockRejectedValue(new Error("enqueue failed: secret"));
    const targetQueue = {
      queue: { getJob: vi.fn().mockResolvedValue(undefined), add },
    } as unknown as NoteEnrichmentRequeueTargetQueue;
    const processor = new NoteEnrichmentRequeueProcessor(db, targetQueue);

    await expect(processor.process()).resolves.toBeUndefined();
  });

  it("複数件の対象をすべて処理する", async () => {
    const db = createFakeDb([[{ id: "note-p1" }, { id: "note-p2" }]]);
    const add = vi.fn().mockResolvedValue(undefined);
    const targetQueue = {
      queue: { getJob: vi.fn().mockResolvedValue(undefined), add },
    } as unknown as NoteEnrichmentRequeueTargetQueue;
    const processor = new NoteEnrichmentRequeueProcessor(db, targetQueue);

    await processor.process();

    expect(add).toHaveBeenCalledTimes(2);
  });

  it("1バッチ分(100件)ちょうど取得できた場合、次のバッチも取得して処理を続ける", async () => {
    const firstBatch = Array.from({ length: 100 }, (_, i) => ({
      id: `note-${String(i).padStart(3, "0")}`,
    }));
    const secondBatch = [{ id: "note-100" }];
    const db = createFakeDb([firstBatch, secondBatch]);
    const getJob = vi.fn().mockResolvedValue({ getState: () => Promise.resolve("waiting") });
    const targetQueue = {
      queue: { getJob, add: vi.fn() },
    } as unknown as NoteEnrichmentRequeueTargetQueue;
    const processor = new NoteEnrichmentRequeueProcessor(db, targetQueue);

    await processor.process();

    expect(getJob).toHaveBeenCalledTimes(101);
  });

  it("対象抽出 SELECT が0件を返した場合は何もせず正常終了する", async () => {
    const db = createFakeDb([[]]);
    const { targetQueue, add } = createFakeTargetQueue({});
    const processor = new NoteEnrichmentRequeueProcessor(db, targetQueue);

    await expect(processor.process()).resolves.toBeUndefined();

    expect(add).not.toHaveBeenCalled();
  });

  it("stale 判定の閾値は1分である(Fable 5 + Codex 独立議論 論点1: 10分→1分に短縮)", async () => {
    const whereSpy = vi.fn();
    const db = createFakeDb([[]], whereSpy);
    const { targetQueue } = createFakeTargetQueue({});
    const processor = new NoteEnrichmentRequeueProcessor(db, targetQueue);

    await processor.process();

    expect(whereSpy).toHaveBeenCalledTimes(1);
    const sqlText = extractSqlText(whereSpy.mock.calls[0][0]);
    expect(sqlText).toContain("1 MINUTE");
    expect(sqlText).not.toContain("10 MINUTE");
  });
});
