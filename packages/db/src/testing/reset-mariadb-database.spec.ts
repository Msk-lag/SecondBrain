import { dropMariadbTestDatabase, resetMariadbTestDatabase } from "./reset-mariadb-database.js";

const { createConnectionMock, queryMock, endMock } = vi.hoisted(() => {
  return {
    createConnectionMock: vi.fn(),
    queryMock: vi.fn(),
    endMock: vi.fn(),
  };
});

vi.mock("mysql2/promise", () => ({
  default: { createConnection: createConnectionMock },
}));

describe("reset-mariadb-database", () => {
  beforeEach(() => {
    createConnectionMock.mockReset();
    queryMock.mockReset();
    endMock.mockReset();
    queryMock.mockResolvedValue(undefined);
    endMock.mockResolvedValue(undefined);
    createConnectionMock.mockResolvedValue({ query: queryMock, end: endMock });
    process.env.MARIADB_ROOT_PASSWORD = "root-password";
  });

  // 文字種の検証だけでは `secondbrain`・`mysql` 等のテスト用ではない有効な DB 名も通ってしまい、
  // root 権限接続で本番・開発 DB を誤って DROP しかねない(Codex コードレビュー 2026-07-13 r4
  // 指摘 [D-2] への対応)。`secondbrain_testprod` は当初 `startsWith("secondbrain_test")` のみで
  // 判定しており誤って受理してしまっていた(区切り文字が無いテスト用ではない紛らわしい名前。
  // Codex コードレビュー 2026-07-13 r6 指摘 [D-3] への対応)。
  it.each([
    "secondbrain",
    "mysql",
    "information_schema",
    "secondbrain_prod",
    "secondbrain_testprod",
  ])(
    "resetMariadbTestDatabase は 'secondbrain_test' に一致しない、または'_'区切りでないDB名('%s')を拒否する",
    async (databaseName) => {
      await expect(resetMariadbTestDatabase({ databaseName })).rejects.toThrow(
        /must be 'secondbrain_test' or start with 'secondbrain_test_'/,
      );
      expect(createConnectionMock).not.toHaveBeenCalled();
    },
  );

  it.each(["secondbrain", "mysql", "secondbrain_testprod"])(
    "dropMariadbTestDatabase は 'secondbrain_test' に一致しない、または'_'区切りでないDB名('%s')を拒否する",
    async (databaseName) => {
      await expect(dropMariadbTestDatabase(databaseName)).rejects.toThrow(
        /must be 'secondbrain_test' or start with 'secondbrain_test_'/,
      );
      expect(createConnectionMock).not.toHaveBeenCalled();
    },
  );

  it.each(["secondbrain_test", "secondbrain_test_api", "secondbrain_test_worker"])(
    "'secondbrain_test' 接頭辞を持つDB名('%s')は受理される",
    async (databaseName) => {
      await expect(resetMariadbTestDatabase({ databaseName })).resolves.not.toThrow();
      await expect(dropMariadbTestDatabase(databaseName)).resolves.not.toThrow();
    },
  );
});
