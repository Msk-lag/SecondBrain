import {
  SCREENSHOT_ANALYSIS_JOB_OPTIONS,
  SCREENSHOT_ANALYSIS_QUEUE_NAME,
} from "@secondbrain/shared";
import type { Database } from "@secondbrain/db";
import { SanitizedMaintenanceException } from "../../common/classify-maintenance-error";
import type { NoteStuckRequeueScreenshotQueue } from "./note-stuck-requeue-queue";
import { NoteStuckRequeueProcessor } from "./note-stuck-requeue.processor";

type UpdateResult = { affectedRows: number };

function fakeSelectWhere(selectQueue: Array<unknown[] | Error>): () => unknown {
  return () => {
    const next = selectQueue.shift();
    const promise = next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? []);
    // `.where().limit(n)` でチェーンされるケース(再取得 SELECT)・
    // `.where().orderBy().limit(n)` でチェーンされるケース(対象抽出 SELECT。
    // keyset pagination 化により orderBy が追加された。Codex コードレビュー r4 指摘 [A-4]
    // への対応)の両方に対応する。いずれも同じ Promise を返すだけで、キューの2重消費は
    // 起こらない。
    return Object.assign(promise, {
      limit: () => promise,
      orderBy: () => Object.assign(promise, { limit: () => promise }),
    });
  };
}

function fakeUpdateSet(
  updateQueue: Array<UpdateResult | Error>,
  updateSetSpy: (setArg: unknown) => void,
): (setArg: unknown) => { where: () => Promise<[UpdateResult]> } {
  return (setArg: unknown) => {
    updateSetSpy(setArg);
    return {
      where: () => {
        const next = updateQueue.shift();
        if (next instanceof Error) {
          return Promise.reject(next);
        }
        return Promise.resolve([next ?? { affectedRows: 1 }]);
      },
    };
  };
}

function createFakeDb(config: {
  selectQueue?: Array<unknown[] | Error>;
  updateQueue?: Array<UpdateResult | Error>;
  updateSetSpy?: (setArg: unknown) => void;
}): Database {
  const selectQueue = [...(config.selectQueue ?? [])];
  const updateQueue = [...(config.updateQueue ?? [])];
  const updateSetSpy = config.updateSetSpy ?? vi.fn();

  return {
    select: () => ({ from: () => ({ where: fakeSelectWhere(selectQueue) }) }),
    update: () => ({ set: fakeUpdateSet(updateQueue, updateSetSpy) }),
  } as unknown as Database;
}

interface FakeScreenshotQueue {
  screenshotQueue: NoteStuckRequeueScreenshotQueue;
  getJob: ReturnType<typeof vi.fn>;
  add: ReturnType<typeof vi.fn>;
}

function createFakeScreenshotQueue(config: {
  getJobResults?: Array<{ getState: () => Promise<unknown> } | undefined | Error>;
  addImpl?: ReturnType<typeof vi.fn>;
}): FakeScreenshotQueue {
  const getJobResults = [...(config.getJobResults ?? [])];
  const getJob = vi.fn().mockImplementation(() => {
    const next = getJobResults.shift();
    if (next instanceof Error) {
      return Promise.reject(next);
    }
    return Promise.resolve(next);
  });
  const add = config.addImpl ?? vi.fn().mockResolvedValue(undefined);
  const screenshotQueue = { queue: { getJob, add } } as unknown as NoteStuckRequeueScreenshotQueue;
  return { screenshotQueue, getJob, add };
}

function fakeJobWithState(state: unknown): { getState: () => Promise<unknown> } {
  return {
    getState: vi
      .fn()
      .mockImplementation(() =>
        state instanceof Error ? Promise.reject(state) : Promise.resolve(state),
      ),
  };
}

describe("NoteStuckRequeueProcessor.process", () => {
  it("最初の対象抽出 SELECT が失敗した場合、サニタイズ済みエラーを re-throw して実行回全体を異常終了させる", async () => {
    const secret = "connection refused to db-host:3306 secret-detail";
    const db = createFakeDb({ selectQueue: [new Error(secret)] });
    const { screenshotQueue } = createFakeScreenshotQueue({});
    const processor = new NoteStuckRequeueProcessor(db, screenshotQueue);

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
      const updateSetSpy = vi.fn();
      const db = createFakeDb({
        selectQueue: [[{ id: "note-1", processingGeneration: 0 }]],
        updateSetSpy,
      });
      const { screenshotQueue, add } = createFakeScreenshotQueue({
        getJobResults: [fakeJobWithState(state)],
      });
      const processor = new NoteStuckRequeueProcessor(db, screenshotQueue);

      await processor.process();

      expect(updateSetSpy).not.toHaveBeenCalled();
      expect(add).not.toHaveBeenCalled();
    }
  });

  it("ジョブが存在しない(getJob が undefined を返す)場合は再投入し、世代を進めた新しい jobId で enqueue する", async () => {
    const updateSetSpy = vi.fn();
    const db = createFakeDb({
      selectQueue: [[{ id: "note-1", processingGeneration: 2 }], [{ processingGeneration: 3 }]],
      updateQueue: [{ affectedRows: 1 }],
      updateSetSpy,
    });
    const { screenshotQueue, add } = createFakeScreenshotQueue({ getJobResults: [undefined] });
    const processor = new NoteStuckRequeueProcessor(db, screenshotQueue);

    await processor.process();

    expect(add).toHaveBeenCalledWith(
      SCREENSHOT_ANALYSIS_QUEUE_NAME,
      { noteId: "note-1", generation: 3 },
      { ...SCREENSHOT_ANALYSIS_JOB_OPTIONS, jobId: "note-1-gen-3" },
    );
  });

  it("BullMQ 上のジョブが completed/failed の終端状態で残存している場合も再投入する", async () => {
    for (const state of ["completed", "failed"]) {
      const db = createFakeDb({
        selectQueue: [[{ id: "note-2", processingGeneration: 0 }], [{ processingGeneration: 1 }]],
        updateQueue: [{ affectedRows: 1 }],
      });
      const { screenshotQueue, add } = createFakeScreenshotQueue({
        getJobResults: [fakeJobWithState(state)],
      });
      const processor = new NoteStuckRequeueProcessor(db, screenshotQueue);

      await processor.process();

      expect(add).toHaveBeenCalledWith(
        SCREENSHOT_ANALYSIS_QUEUE_NAME,
        { noteId: "note-2", generation: 1 },
        { ...SCREENSHOT_ANALYSIS_JOB_OPTIONS, jobId: "note-2-gen-1" },
      );
    }
  });

  it("世代を進める UPDATE の affectedRows が0件なら再投入しない(SELECT後に状態が変わっていた)", async () => {
    const db = createFakeDb({
      selectQueue: [[{ id: "note-3", processingGeneration: 0 }]],
      updateQueue: [{ affectedRows: 0 }],
    });
    const { screenshotQueue, add } = createFakeScreenshotQueue({ getJobResults: [undefined] });
    const processor = new NoteStuckRequeueProcessor(db, screenshotQueue);

    await processor.process();

    expect(add).not.toHaveBeenCalled();
  });

  it("id ごとの getJob/getState/UPDATE/add いずれかの失敗はその id のみスキップし、他の id の処理を継続する", async () => {
    // note-a: getJob が失敗する。note-b: 正常に再投入される。
    const db = createFakeDb({
      selectQueue: [
        [
          { id: "note-a", processingGeneration: 0 },
          { id: "note-b", processingGeneration: 0 },
        ],
        [{ processingGeneration: 1 }],
      ],
      updateQueue: [{ affectedRows: 1 }],
    });
    const getJob = vi
      .fn()
      .mockRejectedValueOnce(new Error("redis unreachable: secret"))
      .mockResolvedValueOnce(undefined);
    const add = vi.fn().mockResolvedValue(undefined);
    const screenshotQueue = {
      queue: { getJob, add },
    } as unknown as NoteStuckRequeueScreenshotQueue;
    const processor = new NoteStuckRequeueProcessor(db, screenshotQueue);

    await expect(processor.process()).resolves.toBeUndefined();

    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith(
      SCREENSHOT_ANALYSIS_QUEUE_NAME,
      { noteId: "note-b", generation: 1 },
      { ...SCREENSHOT_ANALYSIS_JOB_OPTIONS, jobId: "note-b-gen-1" },
    );
  });

  it("queue.add() が失敗しても実行回全体は異常終了せず、そのidのみスキップされる", async () => {
    const db = createFakeDb({
      selectQueue: [[{ id: "note-4", processingGeneration: 0 }], [{ processingGeneration: 1 }]],
      updateQueue: [{ affectedRows: 1 }],
    });
    const add = vi.fn().mockRejectedValue(new Error("enqueue failed: secret"));
    const screenshotQueue = {
      queue: { getJob: vi.fn().mockResolvedValue(undefined), add },
    } as unknown as NoteStuckRequeueScreenshotQueue;
    const processor = new NoteStuckRequeueProcessor(db, screenshotQueue);

    await expect(processor.process()).resolves.toBeUndefined();
  });

  it("複数件の対象(pending・processing 双方に由来しうる行)をすべて処理する", async () => {
    const db = createFakeDb({
      selectQueue: [
        [
          { id: "note-p1", processingGeneration: 0 },
          { id: "note-p2", processingGeneration: 0 },
        ],
        [{ processingGeneration: 1 }],
        [{ processingGeneration: 1 }],
      ],
      updateQueue: [{ affectedRows: 1 }, { affectedRows: 1 }],
    });
    const add = vi.fn().mockResolvedValue(undefined);
    const screenshotQueue = {
      queue: { getJob: vi.fn().mockResolvedValue(undefined), add },
    } as unknown as NoteStuckRequeueScreenshotQueue;
    const processor = new NoteStuckRequeueProcessor(db, screenshotQueue);

    await processor.process();

    expect(add).toHaveBeenCalledTimes(2);
  });

  it("1バッチ分(100件)ちょうど取得できた場合、次のバッチも取得して処理を続ける(Codex コードレビュー r4 指摘 [A-4])", async () => {
    // getJob が「処理継続中」を返す経路(早期return)を使い、UPDATE/再取得 SELECT を
    // 発生させずに、対象抽出 SELECT 自体のバッチ継続だけを検証する。
    const firstBatch = Array.from({ length: 100 }, (_, i) => ({
      id: `note-${String(i).padStart(3, "0")}`,
      processingGeneration: 0,
    }));
    const secondBatch = [{ id: "note-100", processingGeneration: 0 }];
    const db = createFakeDb({ selectQueue: [firstBatch, secondBatch] });
    const getJob = vi.fn().mockResolvedValue({ getState: () => Promise.resolve("waiting") });
    const screenshotQueue = {
      queue: { getJob, add: vi.fn() },
    } as unknown as NoteStuckRequeueScreenshotQueue;
    const processor = new NoteStuckRequeueProcessor(db, screenshotQueue);

    await processor.process();

    expect(getJob).toHaveBeenCalledTimes(101);
  });
});
