import type { Database } from "@secondbrain/db";
import type { MinioClient } from "@secondbrain/storage";
import { SanitizedMaintenanceException } from "../../common/classify-maintenance-error";
import { NotePurgeProcessor } from "./note-purge.processor";

/**
 * `select().from().where().orderBy().limit()` の5段チェーンをそのままオブジェクトリテラルの
 * 入れ子で表現すると `sonarjs/no-nested-functions`(最大4段)に抵触するため、各段を個別の
 * 名前付き関数に分割する(`screenshot-analysis.processor.spec.ts` の fakeSelectWhere 等と
 * 同じパターン)。
 */
function fakeOrderByLimit(limitImpl: () => Promise<unknown[]>) {
  return { orderBy: () => ({ limit: limitImpl }) };
}

function fakeSelectWhere(
  limitImpl: () => Promise<unknown[]>,
  whereSpy?: (whereArg: unknown) => void,
) {
  return (whereArg: unknown) => {
    whereSpy?.(whereArg);
    return fakeOrderByLimit(limitImpl);
  };
}

function fakeSelectLimit(selectResult: unknown[] | Error | undefined): Promise<unknown[]> {
  if (selectResult instanceof Error) {
    return Promise.reject(selectResult);
  }
  return Promise.resolve(selectResult ?? []);
}

function fakeDeleteWhere(
  deleteResults: Array<undefined | Error>,
  deleteWhereSpy: (whereArg: unknown) => void,
  whereArg: unknown,
): Promise<undefined> {
  deleteWhereSpy(whereArg);
  const next = deleteResults.shift();
  if (next instanceof Error) {
    return Promise.reject(next);
  }
  return Promise.resolve(undefined);
}

function createFakeDb(config: {
  selectResult?: unknown[] | Error;
  deleteResults?: Array<undefined | Error>;
  deleteWhereSpy?: (whereArg: unknown) => void;
}): Database {
  const deleteResults = [...(config.deleteResults ?? [])];
  const deleteWhereSpy = config.deleteWhereSpy ?? vi.fn();

  return {
    select: () => ({
      from: () => ({
        where: fakeSelectWhere(() => fakeSelectLimit(config.selectResult)),
      }),
    }),
    delete: () => ({
      where: (whereArg: unknown) => fakeDeleteWhere(deleteResults, deleteWhereSpy, whereArg),
    }),
  } as unknown as Database;
}

function createFakeStorage(config: { deleteObjectImpl?: ReturnType<typeof vi.fn> }): MinioClient {
  return {
    deleteObject: config.deleteObjectImpl ?? vi.fn().mockResolvedValue(undefined),
  } as unknown as MinioClient;
}

describe("NotePurgeProcessor.process", () => {
  it("保持期間(30日)を過ぎたノートを対象として MinIO 削除+行削除を行う", async () => {
    const deleteWhereSpy = vi.fn();
    const db = createFakeDb({
      selectResult: [{ id: "note-1", imageKey: "screenshots/user-1/note-1.png" }],
      deleteResults: [undefined],
      deleteWhereSpy,
    });
    const deleteObjectImpl = vi.fn().mockResolvedValue(undefined);
    const storage = createFakeStorage({ deleteObjectImpl });
    const processor = new NotePurgeProcessor(db, storage);

    await processor.process();

    expect(deleteObjectImpl).toHaveBeenCalledWith("screenshots/user-1/note-1.png");
    expect(deleteWhereSpy).toHaveBeenCalledTimes(1);
  });

  it("imageKey が無いノートは MinIO 削除をスキップして行削除のみ行う", async () => {
    const deleteWhereSpy = vi.fn();
    const db = createFakeDb({
      selectResult: [{ id: "note-2", imageKey: null }],
      deleteResults: [undefined],
      deleteWhereSpy,
    });
    const deleteObjectImpl = vi.fn().mockResolvedValue(undefined);
    const storage = createFakeStorage({ deleteObjectImpl });
    const processor = new NotePurgeProcessor(db, storage);

    await processor.process();

    expect(deleteObjectImpl).not.toHaveBeenCalled();
    expect(deleteWhereSpy).toHaveBeenCalledTimes(1);
  });

  it("対象検索 SELECT が失敗(タイムアウト含む)した場合、サニタイズ済みエラーを re-throw して実行回全体を異常終了させる", async () => {
    const secret = "db connection string secret-value";
    const db = createFakeDb({ selectResult: new Error(secret) });
    const storage = createFakeStorage({});
    const processor = new NotePurgeProcessor(db, storage);

    let caught: unknown;
    try {
      await processor.process();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SanitizedMaintenanceException);
    expect((caught as Error).message).not.toContain(secret);
  });

  it("MinIO 削除の失敗は当該ノートのみスキップし、後続ノートの処理を継続する", async () => {
    const deleteWhereSpy = vi.fn();
    const db = createFakeDb({
      selectResult: [
        { id: "note-a", imageKey: "screenshots/user-1/note-a.png" },
        { id: "note-b", imageKey: "screenshots/user-1/note-b.png" },
      ],
      deleteResults: [undefined],
      deleteWhereSpy,
    });
    const deleteObjectImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("minio delete failed: secret"))
      .mockResolvedValueOnce(undefined);
    const storage = createFakeStorage({ deleteObjectImpl });
    const processor = new NotePurgeProcessor(db, storage);

    await expect(processor.process()).resolves.toBeUndefined();

    expect(deleteObjectImpl).toHaveBeenCalledTimes(2);
    // note-a の MinIO 削除が失敗したため、行削除(delete().where())は note-b の1件のみ発生する。
    expect(deleteWhereSpy).toHaveBeenCalledTimes(1);
  });

  it("対象検索 SELECT が10秒応答しない場合、withTimeout が10秒でタイムアウトさせ実行回全体を異常終了させる", async () => {
    vi.useFakeTimers();
    try {
      const db = {
        select: () => ({
          from: () => ({
            // 意図的に永遠に解決しない
            where: fakeSelectWhere(() => new Promise<unknown[]>(() => undefined)),
          }),
        }),
      } as unknown as Database;
      const storage = createFakeStorage({});
      const processor = new NotePurgeProcessor(db, storage);

      const resultPromise = processor.process();
      const assertion = expect(resultPromise).rejects.toBeInstanceOf(SanitizedMaintenanceException);
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("1バッチ分(100件)ちょうど取得できた場合、次のバッチも取得して処理を続ける(Codex コードレビュー r3 指摘 [A-3])", async () => {
    const firstBatch = Array.from({ length: 100 }, (_, i) => ({
      id: `note-${String(i).padStart(3, "0")}`,
      imageKey: null,
    }));
    const secondBatch = [{ id: "note-100", imageKey: null }];
    const selectQueue: unknown[][] = [firstBatch, secondBatch];
    const selectSpy = vi.fn();
    const deleteWhereSpy = vi.fn();

    const db = {
      select: () => ({
        from: () => ({
          where: fakeSelectWhere(() => Promise.resolve(selectQueue.shift() ?? []), selectSpy),
        }),
      }),
      delete: () => ({
        where: (whereArg: unknown) => {
          deleteWhereSpy(whereArg);
          return Promise.resolve(undefined);
        },
      }),
    } as unknown as Database;
    const storage = createFakeStorage({});
    const processor = new NotePurgeProcessor(db, storage);

    await processor.process();

    // 1回目(cutoffのみ、ちょうど100件=バッチサイズ)→2回目(cutoff+cursor、1件のみで
    // バッチサイズ未満のためここで終了)の2回 select している。
    expect(selectSpy).toHaveBeenCalledTimes(2);
    // 100件+1件、合計101件すべてに対して行削除が発生している(1バッチ目で処理が止まっていない)。
    expect(deleteWhereSpy).toHaveBeenCalledTimes(101);
  });

  it("個々の行削除(DELETE)がタイムアウトしても後続ノートの処理を継続する", async () => {
    const deleteWhereSpy = vi.fn();
    const db = createFakeDb({
      selectResult: [
        { id: "note-a", imageKey: null },
        { id: "note-b", imageKey: null },
      ],
      deleteResults: [new Error("delete timed out: secret"), undefined],
      deleteWhereSpy,
    });
    const storage = createFakeStorage({});
    const processor = new NotePurgeProcessor(db, storage);

    await expect(processor.process()).resolves.toBeUndefined();

    expect(deleteWhereSpy).toHaveBeenCalledTimes(2);
  });
});
