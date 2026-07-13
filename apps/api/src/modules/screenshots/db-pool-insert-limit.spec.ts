import { DbPoolInsertLimitError, DbPoolInsertSemaphore } from "./db-pool-insert-limit";

describe("DbPoolInsertSemaphore", () => {
  it("上限未満なら acquire は inFlightCount をインクリメントする", () => {
    const semaphore = new DbPoolInsertSemaphore(2);

    semaphore.acquire();

    expect(semaphore.inFlightCount).toBe(1);
  });

  it("上限に達すると acquire は insert を呼ばずに DbPoolInsertLimitError を投げる", () => {
    const semaphore = new DbPoolInsertSemaphore(1);
    semaphore.acquire();

    expect(() => semaphore.acquire()).toThrow(DbPoolInsertLimitError);
    // 上限超過の acquire 自体はカウンタを変化させない
    expect(semaphore.inFlightCount).toBe(1);
  });

  it("release は inFlightCount をデクリメントする", () => {
    const semaphore = new DbPoolInsertSemaphore(2);
    semaphore.acquire();
    semaphore.acquire();

    semaphore.release();

    expect(semaphore.inFlightCount).toBe(1);
  });

  it("release は 0 未満にならない(過剰呼び出しに対して安全)", () => {
    const semaphore = new DbPoolInsertSemaphore(2);

    semaphore.release();

    expect(semaphore.inFlightCount).toBe(0);
  });

  it("release 後は再び acquire できる(枠が解放される)", () => {
    const semaphore = new DbPoolInsertSemaphore(1);
    semaphore.acquire();

    semaphore.release();

    expect(() => semaphore.acquire()).not.toThrow();
    expect(semaphore.inFlightCount).toBe(1);
  });
});

describe("DbPoolInsertLimitError", () => {
  it("Error のサブクラスであり instanceof で判定できる", () => {
    const error = new DbPoolInsertLimitError();

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(DbPoolInsertLimitError);
    expect(error.name).toBe("DbPoolInsertLimitError");
  });
});
