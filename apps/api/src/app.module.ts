import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { HealthModule } from "./modules/health/health.module";
import { AuthModule } from "./modules/auth/auth.module";
import { NotesModule } from "./modules/notes/notes.module";
import { GraphModule } from "./modules/graph/graph.module";
import { ScreenshotsModule } from "./modules/screenshots/screenshots.module";
import { DbModule } from "./db/db.module";
import { StorageModule } from "./storage/storage.module";
import { ScreenshotAnalysisQueueModule } from "./queues/screenshot-analysis-queue.module";
import { getApiRedisConnectionOptions } from "./config/redis.config";

@Module({
  imports: [
    DbModule,
    StorageModule,
    BullModule.forRoot({ connection: getApiRedisConnectionOptions() }),
    ScreenshotAnalysisQueueModule,
    HealthModule,
    AuthModule,
    NotesModule,
    GraphModule,
    ScreenshotsModule,
  ],
})
export class AppModule {}
