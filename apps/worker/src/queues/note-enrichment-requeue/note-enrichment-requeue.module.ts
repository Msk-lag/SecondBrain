import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import {
  NOTE_ENRICHMENT_REQUEUE_QUEUE_NAME,
  NoteEnrichmentRequeueTargetQueue,
} from "./note-enrichment-requeue-queue";
import { NoteEnrichmentRequeueProcessor } from "./note-enrichment-requeue.processor";
import { NoteEnrichmentRequeueProducer } from "./note-enrichment-requeue.producer";

/**
 * note-enrichment 回収バッチ(M1-4a 計画 §設計決定4「回収バッチ note-enrichment-requeue」
 * 参照)。note-stuck-requeue.module.ts と同じパターン(`DbModule` は `@Global()` のため
 * import 不要)。
 */
@Module({
  imports: [BullModule.registerQueue({ name: NOTE_ENRICHMENT_REQUEUE_QUEUE_NAME })],
  providers: [
    NoteEnrichmentRequeueProcessor,
    NoteEnrichmentRequeueProducer,
    NoteEnrichmentRequeueTargetQueue,
  ],
})
export class NoteEnrichmentRequeueModule {}
