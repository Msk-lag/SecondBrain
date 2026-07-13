import {
  SCREENSHOT_ANALYSIS_JOB_OPTIONS,
  SCREENSHOT_ANALYSIS_QUEUE_NAME,
  screenshotAnalysisJobId,
  screenshotAnalysisJobPayloadSchema,
} from "./screenshot-analysis.js";

describe("SCREENSHOT_ANALYSIS_QUEUE_NAME", () => {
  it("固定のキュー名を持つ", () => {
    expect(SCREENSHOT_ANALYSIS_QUEUE_NAME).toBe("screenshot-analysis");
  });
});

describe("screenshotAnalysisJobPayloadSchema", () => {
  it("noteId・generation(0以上の整数)を受理する", () => {
    const result = screenshotAnalysisJobPayloadSchema.safeParse({
      noteId: "note-1",
      generation: 0,
    });
    expect(result.success).toBe(true);
  });

  it("負の generation を拒否する", () => {
    const result = screenshotAnalysisJobPayloadSchema.safeParse({
      noteId: "note-1",
      generation: -1,
    });
    expect(result.success).toBe(false);
  });

  it("小数の generation を拒否する", () => {
    const result = screenshotAnalysisJobPayloadSchema.safeParse({
      noteId: "note-1",
      generation: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it("noteId が無い場合を拒否する", () => {
    const result = screenshotAnalysisJobPayloadSchema.safeParse({ generation: 0 });
    expect(result.success).toBe(false);
  });
});

describe("SCREENSHOT_ANALYSIS_JOB_OPTIONS", () => {
  it("attempts:3・指数バックオフ・完了/失敗時の自動削除を既定値として持つ", () => {
    expect(SCREENSHOT_ANALYSIS_JOB_OPTIONS).toEqual({
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: true,
      removeOnFail: true,
    });
  });
});

describe("screenshotAnalysisJobId", () => {
  it("`${noteId}-gen-${generation}` の形式を生成する", () => {
    expect(screenshotAnalysisJobId("note-1", 0)).toBe("note-1-gen-0");
    expect(screenshotAnalysisJobId("note-1", 3)).toBe("note-1-gen-3");
  });

  it("世代が異なれば異なる jobId になる(旧世代のジョブと衝突しない)", () => {
    const gen0 = screenshotAnalysisJobId("note-1", 0);
    const gen1 = screenshotAnalysisJobId("note-1", 1);
    expect(gen0).not.toBe(gen1);
  });

  it("`:` を区切り文字に使わない(BullMQ の内部予約文字を避ける)", () => {
    expect(screenshotAnalysisJobId("note-1", 0)).not.toContain(":");
  });
});
