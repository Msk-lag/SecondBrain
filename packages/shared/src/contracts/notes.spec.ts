import {
  createMemoNoteRequestSchema,
  listNotesQuerySchema,
  noteSchema,
  updateNoteRequestSchema,
} from "./notes.js";

describe("createMemoNoteRequestSchema", () => {
  it("本文のみを受理する(title は任意)", () => {
    const result = createMemoNoteRequestSchema.safeParse({ body: "メモ本文" });
    expect(result.success).toBe(true);
  });

  it("title を添えた場合も受理する", () => {
    const result = createMemoNoteRequestSchema.safeParse({ title: "一言", body: "メモ本文" });
    expect(result.success).toBe(true);
  });

  it("空の body を拒否する", () => {
    const result = createMemoNoteRequestSchema.safeParse({ body: "" });
    expect(result.success).toBe(false);
  });

  it("body が無い場合を拒否する", () => {
    const result = createMemoNoteRequestSchema.safeParse({ title: "一言" });
    expect(result.success).toBe(false);
  });
});

describe("updateNoteRequestSchema", () => {
  it("全フィールド省略(空オブジェクト)を受理する", () => {
    const result = updateNoteRequestSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("title に null を渡せる(未入力へ戻す)", () => {
    const result = updateNoteRequestSchema.safeParse({ title: null });
    expect(result.success).toBe(true);
  });

  it("空文字の title を拒否する(未入力へ戻す場合は null を使う)", () => {
    const result = updateNoteRequestSchema.safeParse({ title: "" });
    expect(result.success).toBe(false);
  });

  it("空文字の body を拒否する", () => {
    const result = updateNoteRequestSchema.safeParse({ body: "" });
    expect(result.success).toBe(false);
  });

  it("tags に空文字を含む配列を拒否する", () => {
    const result = updateNoteRequestSchema.safeParse({ tags: ["ok", ""] });
    expect(result.success).toBe(false);
  });
});

describe("listNotesQuerySchema", () => {
  it("何も指定しない場合 limit のデフォルト値(20)を適用する", () => {
    const result = listNotesQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(20);
      expect(result.data.cursor).toBeUndefined();
    }
  });

  it("limit の文字列を数値へ強制変換する(クエリパラメータ由来)", () => {
    const result = listNotesQuerySchema.safeParse({ limit: "5" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(5);
    }
  });

  it("limit の上限(100)を超える値を拒否する", () => {
    const result = listNotesQuerySchema.safeParse({ limit: "101" });
    expect(result.success).toBe(false);
  });

  it("limit に 0 以下の値を拒否する", () => {
    const result = listNotesQuerySchema.safeParse({ limit: "0" });
    expect(result.success).toBe(false);
  });
});

describe("noteSchema", () => {
  it("title/summary が null のノートを受理する", () => {
    const result = noteSchema.safeParse({
      id: "note-1",
      userId: "user-1",
      type: "memo",
      title: null,
      body: "本文",
      summary: null,
      tags: [],
      createdAt: "2026-07-09T00:00:00.000Z",
      updatedAt: "2026-07-09T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("不正な type を拒否する", () => {
    const result = noteSchema.safeParse({
      id: "note-1",
      userId: "user-1",
      type: "invalid",
      title: null,
      body: "本文",
      summary: null,
      tags: [],
      createdAt: "2026-07-09T00:00:00.000Z",
      updatedAt: "2026-07-09T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });
});
