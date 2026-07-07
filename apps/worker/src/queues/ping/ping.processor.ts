import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { Job } from "bullmq";

@Processor("ping")
export class PingProcessor extends WorkerHost {
  private readonly logger = new Logger(PingProcessor.name);

  process(job: Job<{ message: string }>): Promise<{ pong: string }> {
    this.logger.log(`received ping job ${job.id}: ${job.data.message}`);
    return Promise.resolve({ pong: job.data.message });
  }
}
