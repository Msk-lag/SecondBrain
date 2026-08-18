import { Logger } from "@nestjs/common";
import type { Queue } from "bullmq";
import { NOTE_ENRICHMENT_JOB_OPTIONS, NOTE_ENRICHMENT_QUEUE_NAME } from "@secondbrain/shared";
import { enqueueNoteEnrichment } from "./note-enrichment.producer";

describe("enqueueNoteEnrichment", () => {
  it("正しいキュー名・payload・決定的な jobId で queue.add() を呼ぶ", async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const queue = { add } as unknown as Queue;

    await enqueueNoteEnrichment(queue, "note-1");

    expect(add).toHaveBeenCalledWith(
      NOTE_ENRICHMENT_QUEUE_NAME,
      { noteId: "note-1" },
      { ...NOTE_ENRICHMENT_JOB_OPTIONS, jobId: "note-enrichment-note-1" },
    );
  });

  it("queue.add() が Error で失敗しても re-throw せずログのみで握りつぶす", async () => {
    const add = vi.fn().mockRejectedValue(new Error("redis unreachable: secret"));
    const queue = { add } as unknown as Queue;

    await expect(enqueueNoteEnrichment(queue, "note-2")).resolves.toBeUndefined();
  });

  it("queue.add() が Error 以外の値で reject しても re-throw せずログのみで握りつぶす", async () => {
    const add = vi.fn().mockRejectedValue("plain string rejection");
    const queue = { add } as unknown as Queue;

    await expect(enqueueNoteEnrichment(queue, "note-3")).resolves.toBeUndefined();
  });

  it("queue.add() がタイムアウト(3秒)した場合も re-throw せずログのみで握りつぶす", async () => {
    vi.useFakeTimers();
    try {
      const add = vi.fn().mockImplementation(() => new Promise(() => undefined));
      const queue = { add } as unknown as Queue;

      const resultPromise = enqueueNoteEnrichment(queue, "note-4");
      await vi.advanceTimersByTimeAsync(3_000);

      await expect(resultPromise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("queue.add() の失敗例外に含まれる秘密情報(接続文字列・認証情報等)がログへ出力されない(回帰テスト。Codex 再レビュー HIGH 指摘対応)", async () => {
    const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const secret = "redis unreachable: super-secret-password";
      const add = vi.fn().mockRejectedValue(new Error(secret));
      const queue = { add } as unknown as Queue;

      await enqueueNoteEnrichment(queue, "note-5");

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const loggedMessages = warnSpy.mock.calls.map((call) => String(call[0]));
      for (const message of loggedMessages) {
        expect(message).not.toContain(secret);
        expect(message).not.toContain("super-secret-password");
      }
      // 固定メッセージ + 安全な分類(category)のみで構成されていることも確認する。
      expect(loggedMessages[0]).toContain("note-enrichment job enqueue failed noteId=note-5");
      expect(loggedMessages[0]).toContain("category=unknown_error");
    } finally {
      warnSpy.mockRestore();
    }
  });
});
