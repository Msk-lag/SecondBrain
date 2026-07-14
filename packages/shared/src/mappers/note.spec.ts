import { toPublicNote, type NoteRow } from "./note.js";

function buildDbRow(overrides: Partial<NoteRow> = {}): NoteRow {
  return {
    id: "note-1",
    userId: "user-1",
    type: "screenshot",
    title: "タイトル",
    body: null,
    summary: null,
    tags: [],
    status: "completed",
    failureReason: null,
    concepts: [],
    extractedText: "抽出原文",
    createdAt: new Date("2026-07-10T00:00:00.000Z"),
    updatedAt: new Date("2026-07-10T00:01:00.000Z"),
    // 内部列(公開レスポンスへ漏れてはならない)
    imageKey: "screenshots/user-1/note-1.png",
    imageMimeType: "image/png",
    deletedAt: null,
    processingGeneration: 2,
    processingAttemptToken: "11111111-1111-1111-1111-111111111111",
    ...overrides,
  };
}

describe("toPublicNote", () => {
  it("内部列(imageKey・imageMimeType・deletedAt・processingGeneration・processingAttemptToken)を戻り値に含めない", () => {
    const row = buildDbRow();
    const publicNote = toPublicNote(row);

    expect(publicNote).not.toHaveProperty("imageKey");
    expect(publicNote).not.toHaveProperty("imageMimeType");
    expect(publicNote).not.toHaveProperty("deletedAt");
    expect(publicNote).not.toHaveProperty("processingGeneration");
    expect(publicNote).not.toHaveProperty("processingAttemptToken");
  });

  it("公開フィールドのみを含む Note を返す", () => {
    const row = buildDbRow();
    const publicNote = toPublicNote(row);

    expect(Object.keys(publicNote).sort((a, b) => a.localeCompare(b))).toEqual(
      [
        "id",
        "userId",
        "type",
        "title",
        "body",
        "summary",
        "tags",
        "status",
        "failureReason",
        "concepts",
        "extractedText",
        "createdAt",
        "updatedAt",
      ].sort((a, b) => a.localeCompare(b)),
    );
  });

  it("createdAt/updatedAt(Date インスタンス)を ISO 文字列へ正規化する", () => {
    const row = buildDbRow();
    const publicNote = toPublicNote(row);

    expect(publicNote.createdAt).toBe("2026-07-10T00:00:00.000Z");
    expect(publicNote.updatedAt).toBe("2026-07-10T00:01:00.000Z");
  });

  it("createdAt/updatedAt が既に文字列の場合もそのまま扱う", () => {
    const row = buildDbRow({
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:01:00.000Z",
    });
    const publicNote = toPublicNote(row);

    expect(publicNote.createdAt).toBe("2026-07-11T00:00:00.000Z");
    expect(publicNote.updatedAt).toBe("2026-07-11T00:01:00.000Z");
  });

  it("必須フィールドが不正な場合は例外を投げる(既存の型検証も再確認される)", () => {
    const row = buildDbRow({ status: "invalid" as never });
    expect(() => toPublicNote(row)).toThrow();
  });
});
