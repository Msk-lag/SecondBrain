import { Injectable } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";

@Injectable()
export class PingProducer {
  constructor(@InjectQueue("ping") private readonly pingQueue: Queue) {}

  async enqueue(message: string) {
    return this.pingQueue.add("ping", { message });
  }
}
