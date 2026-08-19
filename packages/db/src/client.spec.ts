const { createPoolMock } = vi.hoisted(() => ({
  createPoolMock: vi.fn(),
}));

vi.mock("mysql2/promise", () => ({
  default: { createPool: createPoolMock },
}));

import { createPool } from "./client.js";
import type { MariadbTlsOptions } from "./env.js";

interface CapturedPoolOptions {
  ssl?: MariadbTlsOptions;
}

/**
 * M1-4b 計画 §設計決定12・受入条件13 の単体テスト。
 * `DbConnectionOptions.ssl`(env.ts の sslOptionsFromEnv の戻り値)が
 * そのまま mysql2.createPool の `ssl` オプションへ渡ることを検証する
 * (env.spec.ts が検証する env → ssl オプションのマッピングと合わせて、
 * env → createPool 呼び出しの配線まで通しで確認する)。
 */
describe("createPool (ssl の配線)", () => {
  beforeEach(() => {
    createPoolMock.mockReset();
  });

  const baseOptions = {
    host: "localhost",
    port: 3306,
    user: "secondbrain",
    password: "secret",
    database: "secondbrain",
  };

  it("ssl 未指定(MARIADB_SSL 未設定相当)の場合、mysql2.createPool の ssl は undefined のまま", () => {
    createPool(baseOptions);

    expect(createPoolMock).toHaveBeenCalledTimes(1);
    const passedOptions = createPoolMock.mock.calls[0][0] as CapturedPoolOptions;
    expect(passedOptions.ssl).toBeUndefined();
  });

  it("ssl 指定時、mysql2.createPool へそのまま渡り、証明書検証は無効化されない", () => {
    createPool({ ...baseOptions, ssl: { rejectUnauthorized: true, ca: "dummy-ca" } });

    expect(createPoolMock).toHaveBeenCalledTimes(1);
    const passedOptions = createPoolMock.mock.calls[0][0] as CapturedPoolOptions;
    expect(passedOptions.ssl).toEqual({
      rejectUnauthorized: true,
      ca: "dummy-ca",
    });
  });
});
