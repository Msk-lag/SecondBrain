import {
  SCREENSHOT_ANALYSIS_JOB_OPTIONS,
  SCREENSHOT_ANALYSIS_QUEUE_NAME,
} from "@secondbrain/shared";
import type { Queue } from "bullmq";
import { enqueueScreenshotAnalysis } from "./screenshots.producer";

describe("enqueueScreenshotAnalysis", () => {
  it("共有定義のキュー名・payload・オプション・世代付き jobId で queue.add を呼ぶ", async () => {
    const addMock = vi.fn().mockResolvedValue(undefined);
    const queue = { add: addMock } as unknown as Queue;

    await enqueueScreenshotAnalysis(queue, "note-1", 2);

    expect(addMock).toHaveBeenCalledWith(
      SCREENSHOT_ANALYSIS_QUEUE_NAME,
      { noteId: "note-1", generation: 2 },
      { ...SCREENSHOT_ANALYSIS_JOB_OPTIONS, jobId: "note-1-gen-2" },
    );
  });

  it("queue.add が失敗しても例外を投げない(サニタイズしてログに記録するのみ)", async () => {
    const queue = { add: vi.fn().mockRejectedValue(new Error("redis down")) } as unknown as Queue;

    await expect(enqueueScreenshotAnalysis(queue, "note-1", 0)).resolves.toBeUndefined();
  });

  it("queue.add がタイムアウトしても例外を投げない", async () => {
    vi.useFakeTimers();
    try {
      const queue = {
        add: vi.fn(() => new Promise(() => undefined)),
      } as unknown as Queue;

      const resultPromise = enqueueScreenshotAnalysis(queue, "note-1", 0);
      await vi.advanceTimersByTimeAsync(3_100);

      await expect(resultPromise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
