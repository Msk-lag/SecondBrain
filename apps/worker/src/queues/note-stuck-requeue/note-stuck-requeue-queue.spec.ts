import { Queue } from "bullmq";
import {
  NoteStuckRequeueScreenshotQueue,
  getFailFastRedisConnectionOptions,
} from "./note-stuck-requeue-queue";

const { closeMock } = vi.hoisted(() => ({
  closeMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("bullmq", async (importOriginal) => {
  const actual = await importOriginal<typeof import("bullmq")>();
  return {
    ...actual,
    // `new.target` 経由で `Reflect.construct` されるため、実装はアロー関数ではなく
    // 通常の function 式にする(アロー関数は [[Construct]] を持たず「is not a constructor」になる)。
    Queue: vi.fn().mockImplementation(function MockQueue() {
      return { close: closeMock };
    }),
  };
});

beforeEach(() => {
  closeMock.mockClear();
  vi.mocked(Queue).mockClear();
});

describe("getFailFastRedisConnectionOptions", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns fail-fast options (enableOfflineQueue:false・maxRetriesPerRequest:1 等)", () => {
    process.env.REDIS_HOST = "redis-host";
    process.env.REDIS_PORT = "6380";

    expect(getFailFastRedisConnectionOptions()).toEqual({
      host: "redis-host",
      port: 6380,
      db: 0,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      commandTimeout: 3000,
    });
  });

  it("uses REDIS_DB when set (統合テスト等での専用 DB index 分離のため)", () => {
    process.env.REDIS_DB = "3";

    expect(getFailFastRedisConnectionOptions().db).toBe(3);
  });

  it("defaults host to localhost and port to 6379 when unset", () => {
    delete process.env.REDIS_HOST;
    delete process.env.REDIS_PORT;

    const options = getFailFastRedisConnectionOptions();
    expect(options.host).toBe("localhost");
    expect(options.port).toBe(6379);
  });

  it("throws when REDIS_PORT is not a positive integer", () => {
    process.env.REDIS_PORT = "not-a-number";
    expect(() => getFailFastRedisConnectionOptions()).toThrow();
  });

  it.each(["-1", "abc", "1.5"])(
    "REDIS_DB が不正な値 '%s' の場合は起動時に例外を投げる(Codex コードレビュー 2026-07-13 指摘 [A-3])",
    (invalid) => {
      process.env.REDIS_DB = invalid;
      expect(() => getFailFastRedisConnectionOptions()).toThrow(
        /REDIS_DB must be a non-negative integer/,
      );
    },
  );
});

describe("NoteStuckRequeueScreenshotQueue", () => {
  it("SCREENSHOT_ANALYSIS_QUEUE_NAME・fail-fast 接続オプションでキューを構築する", () => {
    const instance = new NoteStuckRequeueScreenshotQueue();

    expect(instance).toBeInstanceOf(NoteStuckRequeueScreenshotQueue);
    const [, options] = vi.mocked(Queue).mock.calls[0] as [string, { connection: unknown }];
    expect(vi.mocked(Queue)).toHaveBeenCalledWith("screenshot-analysis", expect.anything());
    expect(typeof options.connection).toBe("object");
  });

  it("close() は内部 Queue.close() を呼ぶ", async () => {
    const instance = new NoteStuckRequeueScreenshotQueue();

    await instance.close();

    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("close() を複数回呼んでも内部 Queue.close() は1回しか呼ばれない(冪等)", async () => {
    const instance = new NoteStuckRequeueScreenshotQueue();

    await instance.close();
    await instance.close();
    await instance.close();

    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("onModuleDestroy は close() と同じ効果を持つ(複数回呼んでも安全)", async () => {
    const instance = new NoteStuckRequeueScreenshotQueue();

    await instance.onModuleDestroy();
    await instance.close();

    expect(closeMock).toHaveBeenCalledTimes(1);
  });
});
