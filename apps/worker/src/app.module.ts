import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { getRedisConnectionOptions } from "./config/redis.config";
import { PingModule } from "./queues/ping/ping.module";

@Module({
  imports: [BullModule.forRoot({ connection: getRedisConnectionOptions() }), PingModule],
})
export class AppModule {}
