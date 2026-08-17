import type { Queue } from "bullmq";
import {
  NOTE_ENRICHMENT_REQUEUE_CRON_PATTERN,
  NoteEnrichmentRequeueProducer,
} from "./note-enrichment-requeue.producer";
import {
  NOTE_ENRICHMENT_REQUEUE_JOB_NAME,
  NOTE_ENRICHMENT_REQUEUE_SCHEDULER_ID,
} from "./note-enrichment-requeue-queue";

describe("NoteEnrichmentRequeueProducer.onModuleInit", () => {
  it("固定 jobSchedulerId・1分ごとの cron パターン・履歴保持上限20件で repeatable job を登録する", async () => {
    const upsertJobScheduler = vi.fn().mockResolvedValue(undefined);
    const queue = { upsertJobScheduler } as unknown as Queue;
    const producer = new NoteEnrichmentRequeueProducer(queue);

    await producer.onModuleInit();

    expect(upsertJobScheduler).toHaveBeenCalledWith(
      NOTE_ENRICHMENT_REQUEUE_SCHEDULER_ID,
      { pattern: NOTE_ENRICHMENT_REQUEUE_CRON_PATTERN },
      {
        name: NOTE_ENRICHMENT_REQUEUE_JOB_NAME,
        opts: {
          removeOnComplete: { count: 20 },
          removeOnFail: { count: 20 },
        },
      },
    );
  });

  it("cron パターンは1分間隔である(Fable 5 + Codex 独立議論 論点1: 回収バッチの周期を10分→1分に短縮)", () => {
    expect(NOTE_ENRICHMENT_REQUEUE_CRON_PATTERN).toBe("* * * * *");
  });
});
