import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { NOTE_PURGE_QUEUE_NAME, NotePurgeProcessor } from "./note-purge.processor";
import { NotePurgeProducer } from "./note-purge.producer";

/** § NotePurgeModule・§ 実装手順15 参照。 */
@Module({
  imports: [BullModule.registerQueue({ name: NOTE_PURGE_QUEUE_NAME })],
  providers: [NotePurgeProcessor, NotePurgeProducer],
})
export class NotePurgeModule {}
