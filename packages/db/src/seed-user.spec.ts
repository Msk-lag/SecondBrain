import type { Database } from "./client.js";
import { isDuplicateEntryError, seedUser } from "./seed-user.js";

interface MockDbOptions {
  existing: unknown[];
  insertError?: Error;
}

function createMockDb(options: MockDbOptions): { db: Database; inserted: boolean } {
  const state = { inserted: false };
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(options.existing),
        }),
      }),
    }),
    insert: () => ({
      values: () => {
        state.inserted = true;
        return options.insertError ? Promise.reject(options.insertError) : Promise.resolve();
      },
    }),
  } as unknown as Database;
  return {
    db,
    get inserted() {
      return state.inserted;
    },
  };
}

describe("seedUser", () => {
  const input = { email: "user@example.com", password: "secret" };

  it("ユーザーが存在しない場合は作成して created を返す", async () => {
    const mock = createMockDb({ existing: [] });
    await expect(seedUser(mock.db, input)).resolves.toBe("created");
    expect(mock.inserted).toBe(true);
  });

  it("同じ email が既に存在する場合は挿入せず skipped を返す", async () => {
    const mock = createMockDb({ existing: [{ id: "existing" }] });
    await expect(seedUser(mock.db, input)).resolves.toBe("skipped");
    expect(mock.inserted).toBe(false);
  });

  it("挿入時の一意制約違反(ER_DUP_ENTRY)は skipped を返す", async () => {
    const duplicateError = Object.assign(new Error("Duplicate entry"), {
      code: "ER_DUP_ENTRY",
    });
    const mock = createMockDb({ existing: [], insertError: duplicateError });
    await expect(seedUser(mock.db, input)).resolves.toBe("skipped");
  });

  it("一意制約違反以外の挿入エラーはそのまま送出する", async () => {
    const mock = createMockDb({ existing: [], insertError: new Error("connection lost") });
    await expect(seedUser(mock.db, input)).rejects.toThrow("connection lost");
  });
});

describe("isDuplicateEntryError", () => {
  it("code が ER_DUP_ENTRY のオブジェクトを重複エラーと判定する", () => {
    expect(isDuplicateEntryError({ code: "ER_DUP_ENTRY" })).toBe(true);
  });

  it("その他の値は重複エラーと判定しない", () => {
    expect(isDuplicateEntryError(new Error("x"))).toBe(false);
    expect(isDuplicateEntryError(null)).toBe(false);
    expect(isDuplicateEntryError("ER_DUP_ENTRY")).toBe(false);
  });
});
