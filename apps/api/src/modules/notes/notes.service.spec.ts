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
    status: "completed",
    failureReason: null,
    imageKey: null,
    imageMimeType: null,
    concepts: [],
    extractedText: null,
    deletedAt: null,
    processingGeneration: 0,
    processingAttemptToken: null,
    createdAt: new Date("2026-07-09T00:00:00.000Z"),
    updatedAt: new Date("2026-07-09T00:00:00.000Z"),
    ...overrides,
  };
}

type UpdateResultRow = { affectedRows: number };

/**
 * select().from().where()...limit() の呼び出しごとに selectQueue から順に1件ずつ結果を払い出す
 * モック。findOwned が create/update/remove/retry の中で複数回呼ばれる(事前確認→再取得)ことを
 * テストで表現するため。update/insert は呼び出し引数を検証できるよう、テストごとに
 * vi.fn() を差し込めるようにする。
 */
function createMockDb(config: {
  selectQueue?: Note[][];
  insertValues?: ReturnType<typeof vi.fn>;
  updateSet?: ReturnType<typeof vi.fn>;
  updateWhereResult?: UpdateResultRow;
  deleteWhere?: ReturnType<typeof vi.fn>;
}): Database {
  const queue = [...(config.selectQueue ?? [])];
  const nextSelectResult = () => Promise.resolve(queue.length > 0 ? (queue.shift() ?? []) : []);

  const insertValues = config.insertValues ?? vi.fn().mockResolvedValue(undefined);
  const updateSet =
    config.updateSet ??
    vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([config.updateWhereResult ?? { affectedRows: 1 }]),
    });
  const deleteWhere = config.deleteWhere ?? vi.fn().mockResolvedValue(undefined);

  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({ limit: () => nextSelectResult() }),
          limit: () => nextSelectResult(),
        }),
      }),
    }),
    insert: () => ({ values: insertValues }),
    update: () => ({ set: updateSet }),
    delete: () => ({ where: deleteWhere }),
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

  it("返される note に内部列(imageKey・processingGeneration 等)を含まない", async () => {
    const rows = [makeNote({ id: "note-1", imageKey: "screenshots/user-1/note-1.png" })];
    const db = createMockDb({ selectQueue: [rows] });
    const service = new NotesService(db);

    const result = await service.list("user-1", { limit: 20 });

    expect(result.items[0]).not.toHaveProperty("imageKey");
    expect(result.items[0]).not.toHaveProperty("processingGeneration");
  });
});

describe("NotesService.findOwned", () => {
  it("存在しない場合は null を返す", async () => {
    const db = createMockDb({ selectQueue: [[]] });
    const service = new NotesService(db);

    const result = await service.findOwned("user-1", "missing");

    expect(result).toBeNull();
  });

  it("所有者のノートが見つかればそれを返す(内部列を含む生の DB 行)", async () => {
    const note = makeNote();
    const db = createMockDb({ selectQueue: [[note]] });
    const service = new NotesService(db);

    const result = await service.findOwned("user-1", "note-1");

    expect(result).toEqual(note);
  });
});

describe("NotesService.create", () => {
  it("insert 後に作成した行を toPublicNote() 済みで返す", async () => {
    const created = makeNote({ title: "一言", body: "本文" });
    const db = createMockDb({ selectQueue: [[created]] });
    const service = new NotesService(db);

    const result = await service.create("user-1", { title: "一言", body: "本文" });

    expect(result).toEqual(expect.objectContaining({ id: "note-1", title: "一言", body: "本文" }));
    expect(result).not.toHaveProperty("imageKey");
  });

  it("concepts:[] を明示的に insert 値へ含める(NOT NULL 列のため)", async () => {
    const created = makeNote();
    const insertValues = vi.fn().mockResolvedValue(undefined);
    const db = createMockDb({ selectQueue: [[created]], insertValues });
    const service = new NotesService(db);

    await service.create("user-1", { title: "一言", body: "本文" });

    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ concepts: [] }));
  });
});

describe("NotesService.update", () => {
  it("存在しないノートは null(404 相当)を返す", async () => {
    const db = createMockDb({ selectQueue: [[]] });
    const service = new NotesService(db);

    const result = await service.update("user-1", "missing", { title: "新タイトル" });

    expect(result).toBeNull();
  });

  it("存在するノートは更新後に再取得した値を toPublicNote() 済みで返す", async () => {
    const existing = makeNote({ title: "旧タイトル" });
    const updated = makeNote({ title: "新タイトル" });
    const db = createMockDb({ selectQueue: [[existing], [updated]] });
    const service = new NotesService(db);

    const result = await service.update("user-1", "note-1", { title: "新タイトル" });

    expect(result).toEqual(expect.objectContaining({ title: "新タイトル" }));
  });

  it("送信値が既存値と同一の更新(affectedRows 0)でも 404 にならず現在値を返す", async () => {
    const existing = makeNote({ title: "同じタイトル" });
    const db = createMockDb({
      selectQueue: [[existing], [existing]],
      updateWhereResult: { affectedRows: 0 },
    });
    const service = new NotesService(db);

    const result = await service.update("user-1", "note-1", { title: "同じタイトル" });

    expect(result).toEqual(expect.objectContaining({ title: "同じタイトル" }));
  });

  it("空の PATCH は DB へ UPDATE を発行せず現在値をそのまま返す(Codex コードレビュー r1 指摘 [A-1])", async () => {
    const existing = makeNote({ title: "既存タイトル" });
    const updateSet = vi.fn();
    const db = createMockDb({ selectQueue: [[existing]], updateSet });
    const service = new NotesService(db);

    const result = await service.update("user-1", "note-1", {});

    expect(result).toEqual(expect.objectContaining({ title: "既存タイトル" }));
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("affectedRows 0 の再確認で行が消えていれば(論理削除競合)null(404)を返す", async () => {
    const existing = makeNote({ title: "旧タイトル" });
    const db = createMockDb({
      selectQueue: [[existing], []],
      updateWhereResult: { affectedRows: 0 },
    });
    const service = new NotesService(db);

    const result = await service.update("user-1", "note-1", { title: "新タイトル" });

    expect(result).toBeNull();
  });

  it("screenshot ノートへの body 更新は 400(BadRequestException)で拒否する", async () => {
    const existing = makeNote({ type: "screenshot", status: "completed", body: null });
    const db = createMockDb({ selectQueue: [[existing]] });
    const service = new NotesService(db);

    await expect(service.update("user-1", "note-1", { body: "勝手に本文" })).rejects.toThrow(
      BadRequestException,
    );
  });

  it("screenshot ノートが completed 以外の間は title/summary/tags 編集を 400 で拒否する", async () => {
    const existing = makeNote({ type: "screenshot", status: "pending", body: null });
    const db = createMockDb({ selectQueue: [[existing]] });
    const service = new NotesService(db);

    await expect(service.update("user-1", "note-1", { title: "新タイトル" })).rejects.toThrow(
      BadRequestException,
    );
  });

  it("screenshot ノートが completed であれば title/summary/tags を編集できる", async () => {
    const existing = makeNote({ type: "screenshot", status: "completed", body: null });
    const updated = makeNote({ type: "screenshot", status: "completed", title: "新タイトル" });
    const db = createMockDb({ selectQueue: [[existing], [updated]] });
    const service = new NotesService(db);

    const result = await service.update("user-1", "note-1", { title: "新タイトル" });

    expect(result).toEqual(expect.objectContaining({ title: "新タイトル" }));
  });
});

describe("NotesService.remove", () => {
  it("存在しないノートは false(404 相当)を返す", async () => {
    const db = createMockDb({ selectQueue: [[]] });
    const service = new NotesService(db);

    const result = await service.remove("user-1", "missing");

    expect(result).toBe(false);
  });

  it("存在するノートは論理削除(deletedAt 更新)して true を返す", async () => {
    const existing = makeNote();
    const updateSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{}]) });
    const db = createMockDb({ selectQueue: [[existing]], updateSet });
    const service = new NotesService(db);

    const result = await service.remove("user-1", "note-1");

    expect(result).toBe(true);
    expect(updateSet).toHaveBeenCalledTimes(1);
    const [updateArg] = updateSet.mock.calls[0] as [{ deletedAt: unknown }];
    expect(updateArg.deletedAt).toBeInstanceOf(Date);
  });
});

describe("NotesService.markPendingForRetry", () => {
  it("存在しないノートは not_found を返す", async () => {
    const db = createMockDb({ selectQueue: [[]] });
    const service = new NotesService(db);

    const result = await service.markPendingForRetry("user-1", "missing");

    expect(result).toBe("not_found");
  });

  it("status が failed 以外なら not_retryable を返す(UPDATE を発行しない)", async () => {
    const existing = makeNote({ type: "screenshot", status: "completed" });
    const updateSet = vi.fn();
    const db = createMockDb({ selectQueue: [[existing]], updateSet });
    const service = new NotesService(db);

    const result = await service.markPendingForRetry("user-1", "note-1");

    expect(result).toBe("not_retryable");
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("UPDATE の affectedRows が 0(並行 retry・論理削除競合)なら not_retryable を返す", async () => {
    const existing = makeNote({ type: "screenshot", status: "failed" });
    const db = createMockDb({
      selectQueue: [[existing]],
      updateWhereResult: { affectedRows: 0 },
    });
    const service = new NotesService(db);

    const result = await service.markPendingForRetry("user-1", "note-1");

    expect(result).toBe("not_retryable");
  });

  it("成功時は世代インクリメント後の note と generation を返す", async () => {
    const existing = makeNote({ type: "screenshot", status: "failed", processingGeneration: 1 });
    const updated = makeNote({ type: "screenshot", status: "pending", processingGeneration: 2 });
    const updateSet = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([{ affectedRows: 1 }]),
    });
    const db = createMockDb({ selectQueue: [[existing], [updated]], updateSet });
    const service = new NotesService(db);

    const result = await service.markPendingForRetry("user-1", "note-1");

    if (typeof result !== "object") {
      throw new Error("expected an object result");
    }
    expect(result.generation).toBe(2);
    expect(result.note).toEqual(expect.objectContaining({ status: "pending" }));
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "pending", failureReason: null }),
    );
    expect(result.note).not.toHaveProperty("processingGeneration");
  });
});
