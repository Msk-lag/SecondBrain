import { BadRequestException } from "@nestjs/common";
import type { Database, Note } from "@secondbrain/db";
import { NotesService } from "./notes.service";

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: "note-1",
    userId: "user-1",
    type: "memo",
    title: "一言",
    body: "本文",
    summary: null,
    tags: [],
    createdAt: new Date("2026-07-09T00:00:00.000Z"),
    updatedAt: new Date("2026-07-09T00:00:00.000Z"),
    ...overrides,
  };
}

/**
 * select().from().where()...limit() の呼び出しごとに selectQueue から順に1件ずつ結果を払い出すモック。
 * findOwned が create/update/remove の中で複数回呼ばれる(事前確認→再取得)ことをテストで表現するため。
 */
function createMockDb(config: {
  selectQueue?: Note[][];
  insertImpl?: () => Promise<unknown>;
  updateImpl?: () => Promise<unknown>;
  deleteImpl?: () => Promise<unknown>;
}): Database {
  const queue = [...(config.selectQueue ?? [])];
  const nextSelectResult = () => Promise.resolve(queue.length > 0 ? (queue.shift() ?? []) : []);

  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({ limit: () => nextSelectResult() }),
          limit: () => nextSelectResult(),
        }),
      }),
    }),
    insert: () => ({
      values: config.insertImpl ?? (() => Promise.resolve(undefined)),
    }),
    update: () => ({
      set: () => ({
        where: config.updateImpl ?? (() => Promise.resolve(undefined)),
      }),
    }),
    delete: () => ({
      where: config.deleteImpl ?? (() => Promise.resolve(undefined)),
    }),
  } as unknown as Database;
}

describe("NotesService.list", () => {
  it("取得件数が limit 以下なら nextCursor は null になる", async () => {
    const rows = [makeNote({ id: "note-1" }), makeNote({ id: "note-2" })];
    const db = createMockDb({ selectQueue: [rows] });
    const service = new NotesService(db);

    const result = await service.list("user-1", { limit: 20 });

    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).toBeNull();
  });

  it("取得件数が limit+1 件のときは超過分を切り捨てて nextCursor を返す", async () => {
    const rows = [
      makeNote({ id: "note-1", createdAt: new Date("2026-07-09T03:00:00.000Z") }),
      makeNote({ id: "note-2", createdAt: new Date("2026-07-09T02:00:00.000Z") }),
    ];
    const db = createMockDb({ selectQueue: [rows] });
    const service = new NotesService(db);

    const result = await service.list("user-1", { limit: 1 });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.id).toBe("note-1");
    expect(result.nextCursor).not.toBeNull();
  });

  it("cursor が base64url でも JSON でもない場合は BadRequestException を投げる", async () => {
    const db = createMockDb({ selectQueue: [[]] });
    const service = new NotesService(db);

    await expect(service.list("user-1", { limit: 20, cursor: "not-valid-cursor" })).rejects.toThrow(
      BadRequestException,
    );
  });

  it("cursor が JSON として妥当でも id/createdAt が欠けていれば BadRequestException を投げる", async () => {
    const db = createMockDb({ selectQueue: [[]] });
    const service = new NotesService(db);
    const malformedCursor = Buffer.from(JSON.stringify({ foo: "bar" }), "utf8").toString(
      "base64url",
    );

    await expect(service.list("user-1", { limit: 20, cursor: malformedCursor })).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe("NotesService.findOwned", () => {
  it("存在しない場合は null を返す", async () => {
    const db = createMockDb({ selectQueue: [[]] });
    const service = new NotesService(db);

    const result = await service.findOwned("user-1", "missing");

    expect(result).toBeNull();
  });

  it("所有者のノートが見つかればそれを返す", async () => {
    const note = makeNote();
    const db = createMockDb({ selectQueue: [[note]] });
    const service = new NotesService(db);

    const result = await service.findOwned("user-1", "note-1");

    expect(result).toEqual(note);
  });
});

describe("NotesService.create", () => {
  it("insert 後に作成した行を再取得して返す", async () => {
    const created = makeNote({ title: "一言", body: "本文" });
    const db = createMockDb({ selectQueue: [[created]] });
    const service = new NotesService(db);

    const result = await service.create("user-1", { title: "一言", body: "本文" });

    expect(result).toEqual(created);
  });
});

describe("NotesService.update", () => {
  it("存在しないノートは null(404 相当)を返す", async () => {
    const db = createMockDb({ selectQueue: [[]] });
    const service = new NotesService(db);

    const result = await service.update("user-1", "missing", { title: "新タイトル" });

    expect(result).toBeNull();
  });

  it("存在するノートは更新後に再取得した値を返す", async () => {
    const existing = makeNote({ title: "旧タイトル" });
    const updated = makeNote({ title: "新タイトル" });
    const db = createMockDb({ selectQueue: [[existing], [updated]] });
    const service = new NotesService(db);

    const result = await service.update("user-1", "note-1", { title: "新タイトル" });

    expect(result).toEqual(updated);
  });

  it("送信値が既存値と同一の更新でも 404 にならない(no-op 更新)", async () => {
    const existing = makeNote({ title: "同じタイトル" });
    const db = createMockDb({ selectQueue: [[existing], [existing]] });
    const service = new NotesService(db);

    const result = await service.update("user-1", "note-1", { title: "同じタイトル" });

    expect(result).toEqual(existing);
  });
});

describe("NotesService.remove", () => {
  it("存在しないノートは false(404 相当)を返す", async () => {
    const db = createMockDb({ selectQueue: [[]] });
    const service = new NotesService(db);

    const result = await service.remove("user-1", "missing");

    expect(result).toBe(false);
  });

  it("存在するノートは削除して true を返す", async () => {
    const existing = makeNote();
    const db = createMockDb({ selectQueue: [[existing]] });
    const service = new NotesService(db);

    const result = await service.remove("user-1", "note-1");

    expect(result).toBe(true);
  });
});
