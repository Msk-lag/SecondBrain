import {
  CONCURRENCY_LIMIT,
  PerUserUploadLimiter,
  RATE_LIMIT,
  RATE_LIMIT_WINDOW_MS,
  UploadRateLimitError,
} from "./upload-rate-limit";

describe("PerUserUploadLimiter", () => {
  it("同時実行数の上限に達すると acquire() が UploadRateLimitError を投げる", () => {
    const limiter = new PerUserUploadLimiter();

    for (let i = 0; i < CONCURRENCY_LIMIT; i++) {
      limiter.acquire("user-1");
    }

    expect(() => limiter.acquire("user-1")).toThrow(UploadRateLimitError);
  });

  it("release() すると同時実行数の枠が解放され、再度 acquire() できる", () => {
    const limiter = new PerUserUploadLimiter();

    for (let i = 0; i < CONCURRENCY_LIMIT; i++) {
      limiter.acquire("user-1");
    }
    expect(() => limiter.acquire("user-1")).toThrow(UploadRateLimitError);

    limiter.release("user-1");
    expect(() => limiter.acquire("user-1")).not.toThrow();
  });

  it("ユーザーごとに独立してカウントする(他ユーザーの上限には影響しない)", () => {
    const limiter = new PerUserUploadLimiter();

    for (let i = 0; i < CONCURRENCY_LIMIT; i++) {
      limiter.acquire("user-1");
    }

    expect(() => limiter.acquire("user-2")).not.toThrow();
  });

  it("時間窓内の件数上限に達すると、同時実行数に余裕があっても acquire() が拒否する", () => {
    const limiter = new PerUserUploadLimiter();

    for (let i = 0; i < RATE_LIMIT; i++) {
      limiter.acquire("user-1");
      limiter.release("user-1");
    }

    expect(() => limiter.acquire("user-1")).toThrow(UploadRateLimitError);
  });

  it("時間窓外の試行はレート制限のカウントから除外される", () => {
    vi.useFakeTimers();
    try {
      const limiter = new PerUserUploadLimiter();

      for (let i = 0; i < RATE_LIMIT; i++) {
        limiter.acquire("user-1");
        limiter.release("user-1");
      }
      expect(() => limiter.acquire("user-1")).toThrow(UploadRateLimitError);

      vi.advanceTimersByTime(RATE_LIMIT_WINDOW_MS + 1);

      expect(() => limiter.acquire("user-1")).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});
