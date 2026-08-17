import { Queue } from "bullmq";
import { NoteEnrichmentRequeueTargetQueue } from "./note-enrichment-requeue-queue";

const { closeMock } = vi.hoisted(() => ({
  closeMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("bullmq", async (importOriginal) => {
  const actual = await importOriginal<typeof import("bullmq")>();
  return {
    ...actual,
    // note-stuck-requeue-queue.spec.ts と同じ理由(`new.target` 経由で `Reflect.construct`
    // されるため、実装は通常の function 式にする)。
    Queue: vi.fn().mockImplementation(function MockQueue() {
      return { close: closeMock };
    }),
  };
});

beforeEach(() => {
  closeMock.mockClear();
  vi.mocked(Queue).mockClear();
});

describe("NoteEnrichmentRequeueTargetQueue", () => {
  it("NOTE_ENRICHMENT_QUEUE_NAME・fail-fast 接続オプションでキューを構築する", () => {
    const instance = new NoteEnrichmentRequeueTargetQueue();

    expect(instance).toBeInstanceOf(NoteEnrichmentRequeueTargetQueue);
    const [name, options] = vi.mocked(Queue).mock.calls[0] as [string, { connection: unknown }];
    expect(name).toBe("note-enrichment");
    expect(typeof options.connection).toBe("object");
  });

  it("close() は内部 Queue.close() を呼ぶ", async () => {
    const instance = new NoteEnrichmentRequeueTargetQueue();

    await instance.close();

    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("close() を複数回呼んでも内部 Queue.close() は1回しか呼ばれない(冪等)", async () => {
    const instance = new NoteEnrichmentRequeueTargetQueue();

    await instance.close();
    await instance.close();
    await instance.close();

    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("onModuleDestroy は close() と同じ効果を持つ(複数回呼んでも安全)", async () => {
    const instance = new NoteEnrichmentRequeueTargetQueue();

    await instance.onModuleDestroy();
    await instance.close();

    expect(closeMock).toHaveBeenCalledTimes(1);
  });
});
