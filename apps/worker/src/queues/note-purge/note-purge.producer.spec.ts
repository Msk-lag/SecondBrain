import type { Queue } from "bullmq";
import {
  NOTE_PURGE_CRON_PATTERN,
  NOTE_PURGE_CRON_TZ,
  NOTE_PURGE_JOB_NAME,
  NOTE_PURGE_SCHEDULER_ID,
  NotePurgeProducer,
} from "./note-purge.producer";

describe("NotePurgeProducer.onModuleInit", () => {
  it("固定 jobSchedulerId・毎日3時(UTC)の cron パターン・履歴保持上限20件で repeatable job を登録する(Codex コードレビュー r6 指摘 [C-2]: タイムゾーンをUTCに明示固定)", async () => {
    const upsertJobScheduler = vi.fn().mockResolvedValue(undefined);
    const queue = { upsertJobScheduler } as unknown as Queue;
    const producer = new NotePurgeProducer(queue);

    await producer.onModuleInit();

    expect(upsertJobScheduler).toHaveBeenCalledWith(
      NOTE_PURGE_SCHEDULER_ID,
      { pattern: NOTE_PURGE_CRON_PATTERN, tz: NOTE_PURGE_CRON_TZ },
      {
        name: NOTE_PURGE_JOB_NAME,
        opts: {
          removeOnComplete: { count: 20 },
          removeOnFail: { count: 20 },
        },
      },
    );
  });

  it("cron パターンは毎日3時である", () => {
    expect(NOTE_PURGE_CRON_PATTERN).toBe("0 3 * * *");
  });

  it("cron のタイムゾーンは UTC で固定されている", () => {
    expect(NOTE_PURGE_CRON_TZ).toBe("UTC");
  });
});
