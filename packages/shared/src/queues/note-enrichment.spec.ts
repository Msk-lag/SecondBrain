import {
  NOTE_ENRICHMENT_JOB_OPTIONS,
  NOTE_ENRICHMENT_QUEUE_NAME,
  noteEnrichmentJobId,
  noteEnrichmentJobPayloadSchema,
} from "./note-enrichment.js";

describe("NOTE_ENRICHMENT_QUEUE_NAME", () => {
  it("固定のキュー名を持つ", () => {
    expect(NOTE_ENRICHMENT_QUEUE_NAME).toBe("note-enrichment");
  });
});

describe("noteEnrichmentJobPayloadSchema", () => {
  it("noteId を受理する", () => {
    const result = noteEnrichmentJobPayloadSchema.safeParse({ noteId: "note-1" });
    expect(result.success).toBe(true);
  });

  it("noteId が無い場合を拒否する", () => {
    const result = noteEnrichmentJobPayloadSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("noteId が文字列以外の場合を拒否する", () => {
    const result = noteEnrichmentJobPayloadSchema.safeParse({ noteId: 123 });
    expect(result.success).toBe(false);
  });
});

describe("NOTE_ENRICHMENT_JOB_OPTIONS", () => {
  it("attempts:3・指数バックオフ・完了/失敗時の自動削除を既定値として持つ", () => {
    expect(NOTE_ENRICHMENT_JOB_OPTIONS).toEqual({
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: true,
      removeOnFail: true,
    });
  });
});

describe("noteEnrichmentJobId", () => {
  it("`note-enrichment-${noteId}` の形式を生成する", () => {
    expect(noteEnrichmentJobId("note-1")).toBe("note-enrichment-note-1");
  });

  it("`:` を区切り文字に使わない(BullMQ の内部予約文字を避ける)", () => {
    expect(noteEnrichmentJobId("note-1")).not.toContain(":");
  });

  it("noteId が異なれば異なる jobId になる", () => {
    const a = noteEnrichmentJobId("note-1");
    const b = noteEnrichmentJobId("note-2");
    expect(a).not.toBe(b);
  });
});
