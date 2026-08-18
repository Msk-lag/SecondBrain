import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { getRedisConnectionOptions } from "./config/redis.config";
import { DbModule } from "./db/db.module";
import { StorageModule } from "./storage/storage.module";
import { PingModule } from "./queues/ping/ping.module";
import { ScreenshotAnalysisQueueModule } from "./queues/screenshot-analysis-queue.module";
import { ScreenshotAnalysisModule } from "./queues/screenshot-analysis/screenshot-analysis.module";
import { NoteStuckRequeueModule } from "./queues/note-stuck-requeue/note-stuck-requeue.module";
import { NotePurgeModule } from "./queues/note-purge/note-purge.module";
import { NoteEnrichmentModule } from "./queues/note-enrichment/note-enrichment.module";
import { NoteEnrichmentRequeueModule } from "./queues/note-enrichment-requeue/note-enrichment-requeue.module";

@Module({
  imports: [
    BullModule.forRoot({ connection: getRedisConnectionOptions() }),
    DbModule,
    StorageModule,
    PingModule,
    ScreenshotAnalysisQueueModule,
    ScreenshotAnalysisModule,
    NoteStuckRequeueModule,
    NotePurgeModule,
    NoteEnrichmentModule,
    NoteEnrichmentRequeueModule,
  ],
})
export class AppModule {}
