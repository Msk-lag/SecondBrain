import type { Queue } from "bullmq";
import {
  NOTE_STUCK_REQUEUE_CRON_PATTERN,
  NoteStuckRequeueProducer,
} from "./note-stuck-requeue.producer";
import {
  NOTE_STUCK_REQUEUE_JOB_NAME,
  NOTE_STUCK_REQUEUE_SCHEDULER_ID,
} from "./note-stuck-requeue-queue";

describe("NoteStuckRequeueProducer.onModuleInit", () => {
  it("固定 jobSchedulerId・10分ごとの cron パターン・履歴保持上限20件で repeatable job を登録する", async () => {
    const upsertJobScheduler = vi.fn().mockResolvedValue(undefined);
    const queue = { upsertJobScheduler } as unknown as Queue;
    const producer = new NoteStuckRequeueProducer(queue);

    await producer.onModuleInit();

    expect(upsertJobScheduler).toHaveBeenCalledWith(
      NOTE_STUCK_REQUEUE_SCHEDULER_ID,
      { pattern: NOTE_STUCK_REQUEUE_CRON_PATTERN },
      {
        name: NOTE_STUCK_REQUEUE_JOB_NAME,
        opts: {
          removeOnComplete: { count: 20 },
          removeOnFail: { count: 20 },
        },
      },
    );
  });

  it("cron パターンは10分間隔である", () => {
    expect(NOTE_STUCK_REQUEUE_CRON_PATTERN).toBe("*/10 * * * *");
  });
});
