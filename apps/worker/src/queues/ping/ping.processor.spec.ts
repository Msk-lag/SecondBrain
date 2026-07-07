import { Job } from "bullmq";
import { PingProcessor } from "./ping.processor";

describe("PingProcessor", () => {
  it("echoes the received message back as pong", async () => {
    const processor = new PingProcessor();
    const job = { id: "1", data: { message: "hello" } } as Job<{
      message: string;
    }>;

    await expect(processor.process(job)).resolves.toEqual({ pong: "hello" });
  });
});
