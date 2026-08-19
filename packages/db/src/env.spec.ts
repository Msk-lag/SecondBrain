import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dbConnectionOptionsFromEnv, sslOptionsFromEnv } from "./env.js";

/**
 * M1-4b 計画 §設計決定12(DB 接続の TLS 対応)・受入条件13 の単体テスト。
 * 環境変数 → mysql2/drizzle-kit の `ssl` オプションへのマッピングを検証する。
 */
describe("sslOptionsFromEnv", () => {
  const originalMariadbSsl = process.env.MARIADB_SSL;
  const originalMariadbSslCa = process.env.MARIADB_SSL_CA;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "secondbrain-db-env-spec-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    if (originalMariadbSsl === undefined) {
      delete process.env.MARIADB_SSL;
    } else {
      process.env.MARIADB_SSL = originalMariadbSsl;
    }
    if (originalMariadbSslCa === undefined) {
      delete process.env.MARIADB_SSL_CA;
    } else {
      process.env.MARIADB_SSL_CA = originalMariadbSslCa;
    }
  });

  it("MARIADB_SSL が未設定の場合 ssl オプションを返さない(ローカル docker の挙動を変えない回帰防止)", () => {
    delete process.env.MARIADB_SSL;
    delete process.env.MARIADB_SSL_CA;

    expect(sslOptionsFromEnv()).toBeUndefined();
  });

  it('MARIADB_SSL="false" の場合も ssl オプションを返さない', () => {
    process.env.MARIADB_SSL = "false";
    delete process.env.MARIADB_SSL_CA;

    expect(sslOptionsFromEnv()).toBeUndefined();
  });

  it('MARIADB_SSL="true" の場合 ssl オプションを返し、証明書検証を無効化しない', () => {
    process.env.MARIADB_SSL = "true";
    delete process.env.MARIADB_SSL_CA;

    const ssl = sslOptionsFromEnv();

    expect(ssl).toBeDefined();
    // 検証を無効化する経路が無いこと(rejectUnauthorized は常に true)を確認する。
    expect(ssl?.rejectUnauthorized).toBe(true);
    // CA 未指定時は ca を設定しない(Node.js の既定の信頼ストアで検証させる)。
    expect(ssl?.ca).toBeUndefined();
  });

  it("MARIADB_SSL_CA を指定すると CA バンドルの内容が ca に渡り、検証は無効化されない", () => {
    process.env.MARIADB_SSL = "true";
    const caPath = join(tempDir, "ca.pem");
    const caContent = "-----BEGIN CERTIFICATE-----\ndummy\n-----END CERTIFICATE-----\n";
    writeFileSync(caPath, caContent, "utf8");
    process.env.MARIADB_SSL_CA = caPath;

    const ssl = sslOptionsFromEnv();

    expect(ssl?.ca).toBe(caContent);
    expect(ssl?.rejectUnauthorized).toBe(true);
  });

  it("MARIADB_SSL_CA のファイルが存在しない場合、TLS 無しへ黙ってフォールバックせず例外を送出する", () => {
    process.env.MARIADB_SSL = "true";
    process.env.MARIADB_SSL_CA = join(tempDir, "does-not-exist.pem");

    expect(() => sslOptionsFromEnv()).toThrow();
  });

  it.each(["1", "yes", "TRUE", "0", "on"])(
    "MARIADB_SSL が不正な値(%s)の場合、黙って false 扱いにせず例外を送出する",
    (invalidValue) => {
      process.env.MARIADB_SSL = invalidValue;

      expect(() => sslOptionsFromEnv()).toThrow(/MARIADB_SSL/);
    },
  );
});

describe("dbConnectionOptionsFromEnv (ssl マッピング)", () => {
  const originalMariadbPassword = process.env.MARIADB_PASSWORD;
  const originalMariadbSsl = process.env.MARIADB_SSL;

  beforeEach(() => {
    process.env.MARIADB_PASSWORD = "test-password";
  });

  afterEach(() => {
    if (originalMariadbPassword === undefined) {
      delete process.env.MARIADB_PASSWORD;
    } else {
      process.env.MARIADB_PASSWORD = originalMariadbPassword;
    }
    if (originalMariadbSsl === undefined) {
      delete process.env.MARIADB_SSL;
    } else {
      process.env.MARIADB_SSL = originalMariadbSsl;
    }
  });

  it("MARIADB_SSL 未設定の場合、接続オプションの ssl は undefined のまま(既存の非 TLS 接続を壊さない)", () => {
    delete process.env.MARIADB_SSL;

    expect(dbConnectionOptionsFromEnv().ssl).toBeUndefined();
  });

  it("MARIADB_SSL=true の場合、接続オプションに ssl が含まれる", () => {
    process.env.MARIADB_SSL = "true";

    expect(dbConnectionOptionsFromEnv().ssl).toEqual({ rejectUnauthorized: true });
  });
});
