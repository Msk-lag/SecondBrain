import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { PingProcessor } from "./ping.processor";
import { PingProducer } from "./ping.producer";

@Module({
  imports: [BullModule.registerQueue({ name: "ping" })],
  providers: [PingProcessor, PingProducer],
  exports: [PingProducer],
})
export class PingModule {}
