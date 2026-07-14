import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { ScreenshotAnalysisQueueModule } from "../screenshot-analysis-queue.module";
import {
  NOTE_STUCK_REQUEUE_QUEUE_NAME,
  NoteStuckRequeueScreenshotQueue,
} from "./note-stuck-requeue-queue";
import { NoteStuckRequeueProcessor } from "./note-stuck-requeue.processor";
import { NoteStuckRequeueProducer } from "./note-stuck-requeue.producer";

/**
 * stuck ノート再投入バッチ(§ stuck ノート再投入バッチ・§ 実装手順14 参照)。
 * `ScreenshotAnalysisQueueModule` を import する(§ 実装手順13 の記述のとおり
 * `ScreenshotAnalysisModule`・`NoteStuckRequeueModule` の両方が import する)。
 */
@Module({
  imports: [
    BullModule.registerQueue({ name: NOTE_STUCK_REQUEUE_QUEUE_NAME }),
    ScreenshotAnalysisQueueModule,
  ],
  providers: [NoteStuckRequeueProcessor, NoteStuckRequeueProducer, NoteStuckRequeueScreenshotQueue],
})
export class NoteStuckRequeueModule {}
