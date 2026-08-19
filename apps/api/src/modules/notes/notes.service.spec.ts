import { BadRequestException } from "@nestjs/common";
import type { Database, Note } from "@secondbrain/db";
import { NotesService, toApiTypeDirection, toRelationStatus } from "./notes.service";

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
    // 埋め込み関連列(M1-4a §設計決定1 参照)。この spec の大半のケースでは未生成(null)固定。
    embedding: null,
    embeddingModel: null,
    embeddingFingerprint: null,
    enrichmentStatus: null,
    // 関係判定ステージの状態2列(M1-4b §設計決定2 参照)。この spec の大半のケースでは
    // 「一度も判定していない」(NULL/NULL)を既定にする。
    relationStatus: null,
    relationFingerprint: null,
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
  // findRelated(GET /notes/:id/related)の raw SQL(db.execute)呼び出しをモックする
  // (M1-4a 計画 §担当スコープ3 参照)。mysql2/drizzle の db.execute() は [rows, fields] の
  // タプルを返すため、既定値も同じ形で解決する。
  execute?: ReturnType<typeof vi.fn>;
  // M1-4b: findRelated は relations SQL → (ready のときのみ) similar SQL の順で
  // db.execute を最大2回呼ぶ(§設計決定10「読み取り順序の不変条件」)。呼び出し順に別々の
  // 結果を返したいテスト用に、[rows, fields] タプルの配列をキューとして渡せるようにする
  // (`execute` を明示指定した場合はそちらを優先する)。
  executeQueue?: [unknown[], unknown[]][];
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
  let execute: ReturnType<typeof vi.fn>;
  if (config.execute) {
    execute = config.execute;
  } else if (config.executeQueue) {
    const executeResults = [...config.executeQueue];
    execute = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(executeResults.length > 0 ? executeResults.shift() : [[], []]),
      );
  } else {
    execute = vi.fn().mockResolvedValue([[], []]);
  }

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
    execute,
  } as unknown as Database;
}

/**
 * drizzle-orm の `sql` タグが生成する `SQL` インスタンス(`queryChunks`)を、実際の依存追加
 * 無しに実行時のダックタイピングで概ねのクエリ文字列へ復元するテスト専用ヘルパー
 * (apps/worker の note-enrichment.processor.spec.ts の同名ヘルパーと同じ実装)。
 */
function extractSqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks;
  if (!Array.isArray(chunks)) {
    return "";
  }
  return chunks
    .map((chunk) => {
      if (typeof chunk !== "object" || chunk === null) {
        return String(chunk);
      }
      const c = chunk as { queryChunks?: unknown[]; value?: unknown };
      if (Array.isArray(c.queryChunks)) {
        return extractSqlText(c);
      }
      if (Array.isArray(c.value)) {
        return (c.value as unknown[]).map(String).join("");
      }
      if ("value" in c) {
        return String(c.value);
      }
      return "";
    })
    .join("");
}

/**
 * findRelated の relations SQL(fetchRelations)が返す生行のテスト用ファクトリ
 * (M1-4b §設計決定10 参照)。既定では閲覧ノートが note_a 側(noteAId === viewedNoteId)の
 * ケースを表す。
 */
function makeRelationRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    noteAId: "note-1",
    noteBId: "note-2",
    otherId: "note-2",
    title: "関係ノート",
    type: "memo",
    summary: "関係の要約",
    body: null,
    extractedText: null,
    relationType: "cause-solution",
    typeDirection: "a-to-b",
    description: "説明文",
    relatedness: "0.87",
    ...overrides,
  };
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

  it("enrichment_status='pending' を insert 時に書き込む(fail-closed の投入順序。M1-4a 計画 §担当スコープ2)", async () => {
    const created = makeNote();
    const insertValues = vi.fn().mockResolvedValue(undefined);
    const db = createMockDb({ selectQueue: [[created]], insertValues });
    const service = new NotesService(db);

    await service.create("user-1", { title: "一言", body: "本文" });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ enrichmentStatus: "pending" }),
    );
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

  it("enrichment_status='pending' を patch と同一 UPDATE 文で書き込む(fail-closed の投入順序。M1-4a 計画 §担当スコープ2)", async () => {
    const existing = makeNote({ title: "旧タイトル" });
    const updated = makeNote({ title: "新タイトル" });
    const updateSet = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([{ affectedRows: 1 }]),
    });
    const db = createMockDb({ selectQueue: [[existing], [updated]], updateSet });
    const service = new NotesService(db);

    await service.update("user-1", "note-1", { title: "新タイトル" });

    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ title: "新タイトル", enrichmentStatus: "pending" }),
    );
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

/**
 * NotesService.findRelated(GET /notes/:id/related。M1-4a §設計決定3・論点2(status 導入)・
 * M1-4b §設計決定10(relations/relationStatus 追加)参照)。自ノート除外・論理削除除外・
 * user_id 分離・NOT EXISTS によるエッジ済み相手の除外は SQL の WHERE 句自体が担保する制約で
 * あり、DB をモックする単体テストでは実データによる検証はできない(モックした db.execute は
 * SQL 文字列の中身を評価しない)。それらは実 DB に接続する統合テストで確認する対象とし、
 * ここでは 404 判定・raw row → RelatedNoteItem/RelationItem のマッピング(excerpt の優先順位・
 * 切り詰め・embedding 非混入・typeDirection 変換)・発行 SQL の文言(SQL テキストの静的検証)を
 * 検証する(このブロックの target は明示的に enrichmentStatus: "completed" を指定し、
 * status マッピング自体は次の describe ブロック「NotesService.findRelated の status
 * マッピング」で全パターンを検証する)。
 *
 * db.execute は relations SQL → (status==='ready' のときのみ) similar SQL の順に呼ばれる
 * (§設計決定10「読み取り順序の不変条件」)。`executeQueue` で呼び出し順に個別の結果を渡す
 * (createMockDb のコメント参照)。
 */
describe("NotesService.findRelated", () => {
  it("存在しない/他ユーザー所有/論理削除済みノートは null を返し、db.execute を呼ばない(404 判定)", async () => {
    const execute = vi.fn();
    const db = createMockDb({ selectQueue: [[]], execute });
    const service = new NotesService(db);

    const result = await service.findRelated("user-1", "missing");

    expect(result).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it("対象ノートの embedding が未生成でも enrichment_status='completed' なら status: ready・SQL 側で全候補が除外され relations/similar とも空配列を返す", async () => {
    const target = makeNote({ id: "note-1", enrichmentStatus: "completed" });
    const execute = vi.fn().mockResolvedValue([[], []]);
    const db = createMockDb({ selectQueue: [[target]], execute });
    const service = new NotesService(db);

    const result = await service.findRelated("user-1", "note-1");

    // relationStatus は「一度も判定されておらず投入予定も無い」(規則3)= not_started。
    expect(result).toEqual({
      status: "ready",
      relationStatus: "not_started",
      relations: [],
      similar: [],
    });
    // relations SQL(1回目)+ similar SQL(2回目)の計2回。
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("summary があれば summary を excerpt として採用し、distance をそのまま返す", async () => {
    const target = makeNote({ id: "note-1", enrichmentStatus: "completed" });
    const rawRow = {
      id: "note-2",
      title: "類似ノート",
      type: "memo",
      summary: "要約テキスト",
      body: "本文テキスト",
      extractedText: "抽出テキスト",
      distance: 0.12,
    };
    const executeQueue: [unknown[], unknown[]][] = [
      [[], []],
      [[rawRow], []],
    ];
    const db = createMockDb({ selectQueue: [[target]], executeQueue });
    const service = new NotesService(db);

    const result = await service.findRelated("user-1", "note-1");

    expect(result).toEqual({
      status: "ready",
      relationStatus: "not_started",
      relations: [],
      similar: [
        {
          id: "note-2",
          title: "類似ノート",
          type: "memo",
          excerpt: "要約テキスト",
          distance: 0.12,
        },
      ],
    });
  });

  it("summary が無ければ body、body も無ければ extractedText の順で excerpt を採用する", async () => {
    const target = makeNote({ id: "note-1", enrichmentStatus: "completed" });
    const rawRow = {
      id: "note-2",
      title: null,
      type: "screenshot",
      summary: null,
      body: null,
      extractedText: "抽出テキスト",
      distance: 0.5,
    };
    const executeQueue: [unknown[], unknown[]][] = [
      [[], []],
      [[rawRow], []],
    ];
    const db = createMockDb({ selectQueue: [[target]], executeQueue });
    const service = new NotesService(db);

    const result = await service.findRelated("user-1", "note-1");

    expect(result).not.toBeNull();
    expect(result?.similar[0]?.excerpt).toBe("抽出テキスト");
  });

  it("summary/body/extractedText がすべて空文字・空白のみの場合は excerpt を null にする", async () => {
    const target = makeNote({ id: "note-1", enrichmentStatus: "completed" });
    const rawRow = {
      id: "note-2",
      title: null,
      type: "memo",
      summary: "  ",
      body: "",
      extractedText: null,
      distance: 0.8,
    };
    const executeQueue: [unknown[], unknown[]][] = [
      [[], []],
      [[rawRow], []],
    ];
    const db = createMockDb({ selectQueue: [[target]], executeQueue });
    const service = new NotesService(db);

    const result = await service.findRelated("user-1", "note-1");

    expect(result).not.toBeNull();
    expect(result?.similar[0]?.excerpt).toBeNull();
  });

  it("excerpt が最大長を超える場合は末尾を省略記号で切り詰める", async () => {
    const target = makeNote({ id: "note-1", enrichmentStatus: "completed" });
    const longSummary = "あ".repeat(150);
    const rawRow = {
      id: "note-2",
      title: null,
      type: "memo",
      summary: longSummary,
      body: null,
      extractedText: null,
      distance: 0.3,
    };
    const executeQueue: [unknown[], unknown[]][] = [
      [[], []],
      [[rawRow], []],
    ];
    const db = createMockDb({ selectQueue: [[target]], executeQueue });
    const service = new NotesService(db);

    const result = await service.findRelated("user-1", "note-1");

    expect(result).not.toBeNull();
    expect(result?.similar[0]?.excerpt).toBe(`${"あ".repeat(120)}…`);
  });

  it("発行される SQL(1回目=relations)が論理削除済みエッジ・論理削除済み相手ノートを除外する条件を含む(M1-4b §設計決定10)", async () => {
    const target = makeNote({ id: "note-1", enrichmentStatus: "completed" });
    const execute = vi.fn().mockResolvedValue([[], []]);
    const db = createMockDb({ selectQueue: [[target]], execute });
    const service = new NotesService(db);

    await service.findRelated("user-1", "note-1");

    const query: unknown = execute.mock.calls[0]?.[0];
    const sqlText = extractSqlText(query).replace(/\s+/g, " ");
    expect(sqlText).toContain("FROM note_relations AS nr");
    expect(sqlText).toContain("nr.deleted_at IS NULL");
    expect(sqlText).toContain("other.user_id = user-1");
    expect(sqlText).toContain("other.deleted_at IS NULL");
  });

  it("発行される SQL(2回目=similar)が embedding_model の一致(null-safe)を候補の絞り込み条件に含む(Codex D0 MEDIUM 指摘の回帰観点。異なるモデルの埋め込み同士は距離比較に意味が無いため)", async () => {
    const target = makeNote({ id: "note-1", enrichmentStatus: "completed" });
    const execute = vi.fn().mockResolvedValue([[], []]);
    const db = createMockDb({ selectQueue: [[target]], execute });
    const service = new NotesService(db);

    await service.findRelated("user-1", "note-1");

    expect(execute).toHaveBeenCalledTimes(2);
    const query: unknown = execute.mock.calls[1]?.[0];
    const sqlText = extractSqlText(query);
    expect(sqlText).toContain("n.embedding_model <=> target.embedding_model");
    // target サブクエリが embedding と embedding_model を同時に取得していることの確認。
    // SQL の整形(改行位置)に依存しないよう、空白を畳んでから検証する。
    expect(sqlText.replace(/\s+/g, " ")).toContain("SELECT embedding, embedding_model FROM notes");
  });

  it("発行される SQL(2回目=similar)が候補ノート側の enrichment_status='completed' を絞り込み条件に含む(Codex 再レビュー MEDIUM 指摘対応。pending の候補は古い embedding のため除外する)", async () => {
    const target = makeNote({ id: "note-1", enrichmentStatus: "completed" });
    const execute = vi.fn().mockResolvedValue([[], []]);
    const db = createMockDb({ selectQueue: [[target]], execute });
    const service = new NotesService(db);

    await service.findRelated("user-1", "note-1");

    const query: unknown = execute.mock.calls[1]?.[0];
    const sqlText = extractSqlText(query);
    expect(sqlText).toContain("n.enrichment_status = 'completed'");
  });

  it("発行される SQL(2回目=similar)が target サブクエリ(対象ノート自身)側にも enrichment_status='completed' を絞り込み条件に含む(Codex 最終セキュリティ監査 MEDIUM 指摘対応。ABA 問題対策の一環で、対象ノートの embedding が確定済みの場合のみ検索対象にする)", async () => {
    const target = makeNote({ id: "note-1", enrichmentStatus: "completed" });
    const execute = vi.fn().mockResolvedValue([[], []]);
    const db = createMockDb({ selectQueue: [[target]], execute });
    const service = new NotesService(db);

    await service.findRelated("user-1", "note-1");

    const query: unknown = execute.mock.calls[1]?.[0];
    const sqlText = extractSqlText(query);
    // target サブクエリ側の条件("WHERE id = <id> AND enrichment_status = 'completed'")。
    // 候補ノート側の条件("n.enrichment_status = 'completed'")とは "n." プレフィックスの
    // 有無で区別できる(こちらは n. が付かない)。
    expect(sqlText).toContain("WHERE id = note-1 AND enrichment_status = 'completed'");
  });

  it("発行される SQL(2回目=similar)が正規化ペア条件の NOT EXISTS で既存エッジの相手を除外する(M1-4b §設計決定10。エッジ済みの相手を similar に重複させない)", async () => {
    const target = makeNote({ id: "note-1", enrichmentStatus: "completed" });
    const execute = vi.fn().mockResolvedValue([[], []]);
    const db = createMockDb({ selectQueue: [[target]], execute });
    const service = new NotesService(db);

    await service.findRelated("user-1", "note-1");

    const query: unknown = execute.mock.calls[1]?.[0];
    const sqlText = extractSqlText(query).replace(/\s+/g, " ");
    expect(sqlText).toContain("NOT EXISTS");
    expect(sqlText).toContain("FROM note_relations AS r");
    expect(sqlText).toContain("r.note_a_id = LEAST(n.id, note-1)");
    expect(sqlText).toContain("r.note_b_id = GREATEST(n.id, note-1)");
  });

  it("類似検索の実行中に対象ノートの status が変化していた場合、結果を確定させず status: generating を返し relations は保持する(Codex 再レビュー HIGH 指摘対応。楽観的検証)", async () => {
    const initialTarget = makeNote({ id: "note-1", enrichmentStatus: "completed" });
    // 検索実行後の再読み取りでは pending に変化している(PUT による更新を模す)。
    const recheckedTarget = makeNote({ id: "note-1", enrichmentStatus: "pending" });
    const relationRow = makeRelationRow();
    const similarRow = {
      id: "note-3",
      title: "古いembeddingに基づく候補",
      type: "memo",
      summary: "要約",
      body: null,
      extractedText: null,
      distance: 0.1,
    };
    const executeQueue: [unknown[], unknown[]][] = [
      [[relationRow], []],
      [[similarRow], []],
    ];
    const db = createMockDb({ selectQueue: [[initialTarget], [recheckedTarget]], executeQueue });
    const service = new NotesService(db);

    const result = await service.findRelated("user-1", "note-1");

    expect(result?.status).toBe("generating");
    expect(result?.similar).toEqual([]);
    // relations は embedding 非依存の確定事実のため、search 実行前に取得した1件を保持する。
    expect(result?.relations).toHaveLength(1);
    expect(result?.relations[0]?.id).toBe("note-2");
  });

  it("類似検索の実行中に対象ノートの embedding_fingerprint が変化していた場合(status は変化なし)、結果を確定させず status: generating を返し relations は保持する(M1-4b §設計決定10。ABA 問題対策)", async () => {
    const initialTarget = makeNote({
      id: "note-1",
      enrichmentStatus: "completed",
      embeddingFingerprint: "fp-old",
    });
    const recheckedTarget = makeNote({
      id: "note-1",
      enrichmentStatus: "completed",
      embeddingFingerprint: "fp-new",
    });
    const relationRow = makeRelationRow();
    const executeQueue: [unknown[], unknown[]][] = [
      [[relationRow], []],
      [[], []],
    ];
    const db = createMockDb({ selectQueue: [[initialTarget], [recheckedTarget]], executeQueue });
    const service = new NotesService(db);

    const result = await service.findRelated("user-1", "note-1");

    expect(result?.status).toBe("generating");
    expect(result?.similar).toEqual([]);
    expect(result?.relations).toHaveLength(1);
    // relationStatus も generating へ倒す(Codex D0 レビュー HIGH 指摘対応)。初回読み取りの
    // 派生値(このケースでは ready)をそのまま返すと、status=generating なのに
    // relationStatus=ready という状態遷移表の規則1に反する組み合わせになり、web が
    // 「前回の結果です」の注記を出さずに陳腐化した関係を確定情報として表示してしまう。
    expect(result?.relationStatus).toBe("generating");
  });

  it("類似検索の実行中に対象ノートの status/embedding_fingerprint が変化していなければ、通常どおり検索結果を返す", async () => {
    const initialTarget = makeNote({ id: "note-1", enrichmentStatus: "completed" });
    const recheckedTarget = makeNote({ id: "note-1", enrichmentStatus: "completed" });
    const rawRow = {
      id: "note-2",
      title: "候補",
      type: "memo",
      summary: "要約",
      body: null,
      extractedText: null,
      distance: 0.1,
    };
    const executeQueue: [unknown[], unknown[]][] = [
      [[], []],
      [[rawRow], []],
    ];
    const db = createMockDb({ selectQueue: [[initialTarget], [recheckedTarget]], executeQueue });
    const service = new NotesService(db);

    const result = await service.findRelated("user-1", "note-1");

    expect(result?.status).toBe("ready");
    expect(result?.similar).toHaveLength(1);
  });

  it("再読み取りで対象ノートが見つからない(削除等の極めて稀な競合)場合は、検証をスキップして最初に観測した status/結果をそのまま返す", async () => {
    const initialTarget = makeNote({ id: "note-1", enrichmentStatus: "completed" });
    const rawRow = {
      id: "note-2",
      title: "候補",
      type: "memo",
      summary: "要約",
      body: null,
      extractedText: null,
      distance: 0.1,
    };
    const executeQueue: [unknown[], unknown[]][] = [
      [[], []],
      [[rawRow], []],
    ];
    // 2回目の findOwned(再読み取り)は空配列 = 見つからない を返す。
    const db = createMockDb({ selectQueue: [[initialTarget], []], executeQueue });
    const service = new NotesService(db);

    const result = await service.findRelated("user-1", "note-1");

    expect(result?.status).toBe("ready");
    expect(result?.similar).toHaveLength(1);
  });

  it("embedding 本体(VECTOR)はレスポンスに含まれない(D0 指摘[4]の回帰観点)", async () => {
    const target = makeNote({ id: "note-1", enrichmentStatus: "completed" });
    const rawRow = {
      id: "note-2",
      title: "類似ノート",
      type: "memo",
      summary: "要約",
      body: null,
      extractedText: null,
      distance: 0.2,
    };
    const executeQueue: [unknown[], unknown[]][] = [
      [[], []],
      [[rawRow], []],
    ];
    const db = createMockDb({ selectQueue: [[target]], executeQueue });
    const service = new NotesService(db);

    const result = await service.findRelated("user-1", "note-1");

    expect(result).not.toBeNull();
    expect(result?.similar[0]).not.toHaveProperty("embedding");
  });

  it("relations の各要素が typeDirection を含めて RelationItem 形式へマッピングされる(閲覧ノートが note_a 側。M1-4b 計画 §(c)(d))", async () => {
    const target = makeNote({ id: "note-1", enrichmentStatus: "completed" });
    const relationRow = makeRelationRow({
      noteAId: "note-1",
      noteBId: "note-2",
      otherId: "note-2",
      typeDirection: "a-to-b",
      relatedness: "0.75",
    });
    const executeQueue: [unknown[], unknown[]][] = [
      [[relationRow], []],
      [[], []],
    ];
    const db = createMockDb({ selectQueue: [[target]], executeQueue });
    const service = new NotesService(db);

    const result = await service.findRelated("user-1", "note-1");

    expect(result?.relations).toEqual([
      {
        id: "note-2",
        title: "関係ノート",
        type: "memo",
        excerpt: "関係の要約",
        relationType: "cause-solution",
        typeDirection: "outgoing",
        description: "説明文",
        relatedness: 0.75,
      },
    ]);
  });

  it("relations の各要素が閲覧ノートが note_b 側の場合に typeDirection を反転する(M1-4b 計画 §(c))", async () => {
    const target = makeNote({ id: "note-2", enrichmentStatus: "completed" });
    const relationRow = makeRelationRow({
      noteAId: "note-1",
      noteBId: "note-2",
      otherId: "note-1",
      title: "相手ノート",
      typeDirection: "a-to-b",
    });
    const executeQueue: [unknown[], unknown[]][] = [
      [[relationRow], []],
      [[], []],
    ];
    const db = createMockDb({ selectQueue: [[target]], executeQueue });
    const service = new NotesService(db);

    const result = await service.findRelated("user-1", "note-2");

    // 閲覧ノート(note-2)は DB 上 note_b 側であり、type_direction='a-to-b' は「note_a → note_b」
    // なので閲覧ノート視点では incoming になる(toApiTypeDirection の変換表参照)。
    expect(result?.relations[0]?.typeDirection).toBe("incoming");
    expect(result?.relations[0]?.id).toBe("note-1");
  });

  it("relatedness(decimal 列)は数値型へ変換される(mysql2 既定設定では文字列で返るため)", async () => {
    const target = makeNote({ id: "note-1", enrichmentStatus: "completed" });
    const relationRow = makeRelationRow({ relatedness: "0.42" });
    const executeQueue: [unknown[], unknown[]][] = [
      [[relationRow], []],
      [[], []],
    ];
    const db = createMockDb({ selectQueue: [[target]], executeQueue });
    const service = new NotesService(db);

    const result = await service.findRelated("user-1", "note-1");

    expect(result?.relations[0]?.relatedness).toBe(0.42);
    expect(typeof result?.relations[0]?.relatedness).toBe("number");
  });
});

/**
 * status マッピング(GET /notes/:id/related の `status` フィールド。Fable 5 + Codex 独立議論
 * 論点2 で確定。M1-4a 論点2 実装スコープ 参照)。enrichment_status(DB)と screenshot ノートの
 * 解析状態 notes.status の組み合わせパターンを全6行網羅する。relations は generating/failed
 * でも返る(M1-4b §設計決定10)ため、各テストで execute の呼び出し有無・relations の内容も
 * 併せて検証する。
 */
describe("NotesService.findRelated の status マッピング", () => {
  it("enrichment_status='pending' なら status: generating を返し、relations SQL のみ実行して similar SQL(2回目)は呼ばない", async () => {
    const target = makeNote({ id: "note-1", enrichmentStatus: "pending" });
    const relationRow = makeRelationRow();
    const execute = vi.fn().mockResolvedValue([[relationRow], []]);
    const db = createMockDb({ selectQueue: [[target]], execute });
    const service = new NotesService(db);

    const result = await service.findRelated("user-1", "note-1");

    expect(result?.status).toBe("generating");
    expect(result?.similar).toEqual([]);
    // 埋め込みが generating の間は toRelationStatus の規則1が最優先され、relation_status/
    // relation_fingerprint の値によらず relationStatus も generating になる(規則3-7には
    // 到達しない)。
    expect(result?.relationStatus).toBe("generating");
    // relations SQL(1回目)のみが実行され、similar SQL(status !== 'ready' のため2回目は無い)。
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result?.relations).toHaveLength(1);
  });

  it("enrichment_status='completed' なら status: ready を返す", async () => {
    const target = makeNote({ id: "note-1", enrichmentStatus: "completed" });
    const execute = vi.fn().mockResolvedValue([[], []]);
    const db = createMockDb({ selectQueue: [[target]], execute });
    const service = new NotesService(db);

    const result = await service.findRelated("user-1", "note-1");

    expect(result?.status).toBe("ready");
  });

  it("enrichment_status='failed' なら status: failed・similar: [] を返しつつ relations は返し、similar SQL(2回目)は呼ばない(Codex 最終セキュリティ監査 MEDIUM 指摘対応。ABA 問題対策として failed 時は既存 embedding があっても検索しない方針へ変更。relations は embedding 非依存のため返す — M1-4b §設計決定10)", async () => {
    const target = makeNote({ id: "note-1", enrichmentStatus: "failed" });
    const relationRow = makeRelationRow();
    const execute = vi.fn().mockResolvedValue([[relationRow], []]);
    const db = createMockDb({ selectQueue: [[target]], execute });
    const service = new NotesService(db);

    const result = await service.findRelated("user-1", "note-1");

    expect(result?.status).toBe("failed");
    expect(result?.similar).toEqual([]);
    // 埋め込みが failed の場合、関係判定は永久に走らないため relationStatus も終端の failed
    // (規則2)。
    expect(result?.relationStatus).toBe("failed");
    expect(result?.relations).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("enrichment_status=NULL かつ解析 status='pending' なら status: generating を返す(enrichment は解析完了後に始まるため)", async () => {
    const target = makeNote({
      id: "note-1",
      type: "screenshot",
      enrichmentStatus: null,
      status: "pending",
    });
    const execute = vi.fn().mockResolvedValue([[], []]);
    const db = createMockDb({ selectQueue: [[target]], execute });
    const service = new NotesService(db);

    const result = await service.findRelated("user-1", "note-1");

    expect(result?.status).toBe("generating");
    expect(result?.similar).toEqual([]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("enrichment_status=NULL かつ解析 status='processing' なら status: generating を返す", async () => {
    const target = makeNote({
      id: "note-1",
      type: "screenshot",
      enrichmentStatus: null,
      status: "processing",
    });
    const execute = vi.fn().mockResolvedValue([[], []]);
    const db = createMockDb({ selectQueue: [[target]], execute });
    const service = new NotesService(db);

    const result = await service.findRelated("user-1", "note-1");

    expect(result?.status).toBe("generating");
    expect(result?.similar).toEqual([]);
  });

  it("enrichment_status=NULL かつ解析 status='failed' なら status: failed を返す(解析失敗ノートは enrichment が永遠に始まらないため generating へ倒してはならない。failed は検索しない方針 — Codex 最終セキュリティ監査 MEDIUM 指摘対応)", async () => {
    const target = makeNote({
      id: "note-1",
      type: "screenshot",
      enrichmentStatus: null,
      status: "failed",
    });
    const execute = vi.fn().mockResolvedValue([[], []]);
    const db = createMockDb({ selectQueue: [[target]], execute });
    const service = new NotesService(db);

    const result = await service.findRelated("user-1", "note-1");

    expect(result?.status).toBe("failed");
    expect(result?.similar).toEqual([]);
  });

  it("enrichment_status=NULL かつ解析 status='completed' なら status: ready を返す(原則発生しないが防御的に終端へ倒す)", async () => {
    const target = makeNote({
      id: "note-1",
      type: "screenshot",
      enrichmentStatus: null,
      status: "completed",
    });
    const execute = vi.fn().mockResolvedValue([[], []]);
    const db = createMockDb({ selectQueue: [[target]], execute });
    const service = new NotesService(db);

    const result = await service.findRelated("user-1", "note-1");

    expect(result?.status).toBe("ready");
  });
});

/**
 * relationStatus の7規則(toRelationStatus。M1-4b §設計決定10・
 * `packages/shared/src/contracts/notes.ts` の relationStatusSchema コメント参照)。
 * 純関数として直接テストする(findRelated 経由の DB モックより分岐を厳密に指定できるため)。
 */
describe("toRelationStatus(relationStatus 派生の7規則)", () => {
  it("規則1: status が generating なら relation_status/fingerprint の値によらず generating", () => {
    const result = toRelationStatus(
      { relationStatus: "completed", relationFingerprint: "fp-1", embeddingFingerprint: "fp-1" },
      "generating",
    );
    expect(result).toBe("generating");
  });

  it("規則2: status が failed なら relation_status/fingerprint の値によらず failed", () => {
    const result = toRelationStatus(
      { relationStatus: "pending", relationFingerprint: "fp-1", embeddingFingerprint: "fp-1" },
      "failed",
    );
    expect(result).toBe("failed");
  });

  it("規則3: relation_status/relation_fingerprint とも NULL なら not_started(M1-4a 期の既存ノート)", () => {
    const result = toRelationStatus(
      { relationStatus: null, relationFingerprint: null, embeddingFingerprint: "fp-1" },
      "ready",
    );
    expect(result).toBe("not_started");
  });

  it("規則4: relation_status='completed' かつ fingerprint 一致なら ready(終端)", () => {
    const result = toRelationStatus(
      { relationStatus: "completed", relationFingerprint: "fp-1", embeddingFingerprint: "fp-1" },
      "ready",
    );
    expect(result).toBe("ready");
  });

  it("規則5: relation_status='failed' かつ fingerprint 一致なら failed(終端。現在の内容に対する判定が失敗)", () => {
    const result = toRelationStatus(
      { relationStatus: "failed", relationFingerprint: "fp-1", embeddingFingerprint: "fp-1" },
      "ready",
    );
    expect(result).toBe("failed");
  });

  it("規則6: relation_status='pending' かつ fingerprint 一致なら generating(判定中)", () => {
    const result = toRelationStatus(
      { relationStatus: "pending", relationFingerprint: "fp-1", embeddingFingerprint: "fp-1" },
      "ready",
    );
    expect(result).toBe("generating");
  });

  it("規則7: fingerprint 不一致(relation_status='completed' でも)なら generating(現在の内容に対する判定がこれから走る)", () => {
    const result = toRelationStatus(
      {
        relationStatus: "completed",
        relationFingerprint: "fp-old",
        embeddingFingerprint: "fp-new",
      },
      "ready",
    );
    expect(result).toBe("generating");
  });

  it("規則7: relation_status='failed' でも fingerprint が不一致なら generating(古い内容での失敗。現在の内容では再判定待ち)", () => {
    const result = toRelationStatus(
      { relationStatus: "failed", relationFingerprint: "fp-old", embeddingFingerprint: "fp-new" },
      "ready",
    );
    expect(result).toBe("generating");
  });
});

/**
 * typeDirection の a/b → 詳細画面のノート視点変換(toApiTypeDirection。M1-4b §設計決定1 の
 * a/b エンコード表の逆変換、`packages/shared/src/contracts/notes.ts` の
 * relationTypeDirectionSchema コメントの変換表と同一)。全4分岐 + none を検証する
 * (M1-4b 計画 §(c) 参照)。
 */
describe("toApiTypeDirection(詳細画面のノート視点への変換)", () => {
  it("閲覧ノートが note_a・DB が a-to-b なら outgoing", () => {
    expect(toApiTypeDirection("a-to-b", true)).toBe("outgoing");
  });

  it("閲覧ノートが note_a・DB が b-to-a なら incoming", () => {
    expect(toApiTypeDirection("b-to-a", true)).toBe("incoming");
  });

  it("閲覧ノートが note_b・DB が a-to-b なら incoming", () => {
    expect(toApiTypeDirection("a-to-b", false)).toBe("incoming");
  });

  it("閲覧ノートが note_b・DB が b-to-a なら outgoing", () => {
    expect(toApiTypeDirection("b-to-a", false)).toBe("outgoing");
  });

  it("DB が none なら閲覧ノートが note_a/note_b いずれでも none", () => {
    expect(toApiTypeDirection("none", true)).toBe("none");
    expect(toApiTypeDirection("none", false)).toBe("none");
  });
});
