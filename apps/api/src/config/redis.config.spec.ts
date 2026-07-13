import { getApiRedisConnectionOptions } from "./redis.config";

describe("getApiRedisConnectionOptions", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("REDIS_DB 未設定時は既定値 0 を使う", () => {
    delete process.env.REDIS_DB;
    expect(getApiRedisConnectionOptions().db).toBe(0);
  });

  it("REDIS_DB が非負整数の場合はその値を使う", () => {
    process.env.REDIS_DB = "3";
    expect(getApiRedisConnectionOptions().db).toBe(3);
  });

  it.each(["-1", "abc", "1.5"])(
    "REDIS_DB が不正な値 '%s' の場合は起動時に例外を投げる(Codex コードレビュー 2026-07-13 指摘 [A-3])",
    (invalid) => {
      process.env.REDIS_DB = invalid;
      expect(() => getApiRedisConnectionOptions()).toThrow(
        /REDIS_DB must be a non-negative integer/,
      );
    },
  );
});
