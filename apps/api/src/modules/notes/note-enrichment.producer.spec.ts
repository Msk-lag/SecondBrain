import { NOTE_ENRICHMENT_JOB_OPTIONS, NOTE_ENRICHMENT_QUEUE_NAME } from "@secondbrain/shared";
import type { Queue } from "bullmq";
import { enqueueNoteEnrichment } from "./note-enrichment.producer";

describe("enqueueNoteEnrichment", () => {
  it("共有定義のキュー名・payload・オプション・jobId で queue.add を呼ぶ", async () => {
    const addMock = vi.fn().mockResolvedValue(undefined);
    const queue = { add: addMock } as unknown as Queue;

    await enqueueNoteEnrichment(queue, "note-1");

    expect(addMock).toHaveBeenCalledWith(
      NOTE_ENRICHMENT_QUEUE_NAME,
      { noteId: "note-1" },
      { ...NOTE_ENRICHMENT_JOB_OPTIONS, jobId: "note-enrichment-note-1" },
    );
  });

  it("queue.add が失敗しても例外を投げない(サニタイズしてログに記録するのみ)", async () => {
    const queue = { add: vi.fn().mockRejectedValue(new Error("redis down")) } as unknown as Queue;

    await expect(enqueueNoteEnrichment(queue, "note-1")).resolves.toBeUndefined();
  });

  it("queue.add がタイムアウトしても例外を投げない", async () => {
    vi.useFakeTimers();
    try {
      const queue = {
        add: vi.fn(() => new Promise(() => undefined)),
      } as unknown as Queue;

      const resultPromise = enqueueNoteEnrichment(queue, "note-1");
      await vi.advanceTimersByTimeAsync(3_100);

      await expect(resultPromise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
