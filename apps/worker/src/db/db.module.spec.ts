import { EventEmitter } from "node:events";
import { createWorkerPool } from "./db.module";

const { createPoolMock } = vi.hoisted(() => ({
  createPoolMock: vi.fn(),
}));

vi.mock("mysql2/promise", () => ({
  default: { createPool: createPoolMock },
}));

describe("createWorkerPool", () => {
  beforeEach(() => {
    createPoolMock.mockReset();
    process.env.MARIADB_PASSWORD = "password";
  });

  // `SET SESSION max_statement_time` の設定に失敗した接続を保護なしのままプールへ戻すと、
  // ハングしたクエリを引いた際にプール全体が徐々に枯渇しうる(Codex コードレビュー
  // 2026-07-13 r7 指摘 [A-2] への対応。apps/api 側の同種テストと同一パターン)。
  it("SET SESSION の設定に失敗した接続を destroy() してプールから除外する", async () => {
    const fakePool = new EventEmitter();
    createPoolMock.mockReturnValue(fakePool);

    createWorkerPool();

    const destroyMock = vi.fn();
    const queryMock = vi.fn().mockRejectedValue(new Error("permission denied"));
    const fakeConnection = {
      promise: () => ({ query: queryMock }),
      destroy: destroyMock,
    };
    fakePool.emit("connection", fakeConnection);

    await vi.waitFor(() => {
      expect(destroyMock).toHaveBeenCalledTimes(1);
    });
  });

  it("SET SESSION の設定に成功した接続は destroy() しない", async () => {
    const fakePool = new EventEmitter();
    createPoolMock.mockReturnValue(fakePool);

    createWorkerPool();

    const destroyMock = vi.fn();
    const queryMock = vi.fn().mockResolvedValue(undefined);
    const fakeConnection = {
      promise: () => ({ query: queryMock }),
      destroy: destroyMock,
    };
    fakePool.emit("connection", fakeConnection);

    await vi.waitFor(() => {
      expect(queryMock).toHaveBeenCalledTimes(1);
    });
    expect(destroyMock).not.toHaveBeenCalled();
  });
});
