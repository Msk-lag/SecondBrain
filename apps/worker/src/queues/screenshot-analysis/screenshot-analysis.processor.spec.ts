import { Readable } from "node:stream";
import type { Job, Queue } from "bullmq";
import type { Database } from "@secondbrain/db";
import {
  noteEnrichmentJobId,
  NOTE_ENRICHMENT_JOB_OPTIONS,
  NOTE_ENRICHMENT_QUEUE_NAME,
  type ScreenshotAnalysisJobPayload,
  type ScreenshotAnalysisResult,
} from "@secondbrain/shared";
import type { MinioClient } from "@secondbrain/storage";
import type { ClaudeVisionClient } from "./claude-vision.client";
import * as resizeForClaudeModule from "./resize-for-claude";
import { ScreenshotAnalysisProcessor } from "./screenshot-analysis.processor";

vi.mock("./resize-for-claude", () => ({
  resizeForClaude: vi.fn(),
}));

const VALID_RESULT: ScreenshotAnalysisResult = {
  title: "テストタイトル",
  summary: "テスト要約",
  tags: ["tag1"],
  concepts: ["concept1"],
  extractedText: "抽出テキスト",
};

type UpdateResult = { affectedRows: number };

function fakeSelectLimit(selectQueue: Array<unknown[] | Error>): () => Promise<unknown[]> {
  return () => {
    const next = selectQueue.shift();
    if (next instanceof Error) {
      return Promise.reject(next);
    }
    return Promise.resolve(next ?? []);
  };
}

function fakeUpdateSet(
  updateQueue: Array<UpdateResult | Error>,
  updateSetSpy: (setArg: unknown) => void,
): (setArg: unknown) => { where: () => Promise<[UpdateResult]> } {
  return (setArg: unknown) => {
    updateSetSpy(setArg);
    return {
      where: () => {
        const next = updateQueue.shift();
        if (next instanceof Error) {
          return Promise.reject(next);
        }
        return Promise.resolve([next ?? { affectedRows: 1 }]);
      },
    };
  };
}

/**
 * `db.select()...limit()`(loadProcessingInput・削除再確認)・`db.update().set().where()`
 * (claimForProcessing・completeAnalysis・failAnalysis)それぞれの呼び出し順に、キューから
 * 1件ずつ結果(または reject させる Error)を払い出すフェイク(apps/api の
 * NotesService.spec.ts の createMockDb と同じパターン)。
 */
function createFakeDb(config: {
  selectQueue?: Array<unknown[] | Error>;
  updateQueue?: Array<UpdateResult | Error>;
  updateSetSpy?: (setArg: unknown) => void;
}): Database {
  const selectQueue = [...(config.selectQueue ?? [])];
  const updateQueue = [...(config.updateQueue ?? [])];
  const updateSetSpy = config.updateSetSpy ?? vi.fn();

  return {
    select: () => ({ from: () => ({ where: () => ({ limit: fakeSelectLimit(selectQueue) }) }) }),
    update: () => ({ set: fakeUpdateSet(updateQueue, updateSetSpy) }),
  } as unknown as Database;
}

function createFakeJob(overrides: {
  noteId?: string;
  generation?: number;
  attemptsMade?: number;
  attempts?: number;
}): Job<ScreenshotAnalysisJobPayload> {
  return {
    data: { noteId: overrides.noteId ?? "note-1", generation: overrides.generation ?? 0 },
    attemptsMade: overrides.attemptsMade ?? 0,
    opts: { attempts: overrides.attempts ?? 3 },
  } as unknown as Job<ScreenshotAnalysisJobPayload>;
}

interface FakeStorage {
  storage: MinioClient;
  getObjectStream: ReturnType<typeof vi.fn>;
}

function createFakeStorage(streamBuffer: Buffer = Buffer.from("image-bytes")): FakeStorage {
  const getObjectStream = vi.fn().mockResolvedValue(Readable.from([streamBuffer]));
  return { storage: { getObjectStream } as unknown as MinioClient, getObjectStream };
}

interface FakeClaudeClient {
  claudeClient: ClaudeVisionClient;
  analyze: ReturnType<typeof vi.fn>;
}

function createFakeClaudeClient(
  result: ScreenshotAnalysisResult | Error = VALID_RESULT,
): FakeClaudeClient {
  const analyze =
    result instanceof Error ? vi.fn().mockRejectedValue(result) : vi.fn().mockResolvedValue(result);
  return { claudeClient: { analyze } as unknown as ClaudeVisionClient, analyze };
}

const validInputRow = [{ imageKey: "screenshots/user-1/note-1.png", imageMimeType: "image/png" }];
const notDeletedRow = [{ deletedAt: null }];

interface FakeEnrichmentQueue {
  enrichmentQueue: Queue;
  add: ReturnType<typeof vi.fn>;
}

/**
 * note-enrichment キューへの enqueue(§ 実装手順4 参照。ScreenshotAnalysisProcessor が
 * completeAnalysis 成功直後に enqueueNoteEnrichment 経由で呼ぶ)を検証するためのフェイク。
 */
function createFakeEnrichmentQueue(addImpl?: ReturnType<typeof vi.fn>): FakeEnrichmentQueue {
  const add = addImpl ?? vi.fn().mockResolvedValue(undefined);
  return { enrichmentQueue: { add } as unknown as Queue, add };
}

let enrichmentQueue: Queue;
let enrichmentAdd: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.mocked(resizeForClaudeModule.resizeForClaude).mockReset();
  vi.mocked(resizeForClaudeModule.resizeForClaude).mockResolvedValue({
    buffer: Buffer.from("resized"),
    mediaType: "image/jpeg",
  });
  ({ enrichmentQueue, add: enrichmentAdd } = createFakeEnrichmentQueue());
});

describe("ScreenshotAnalysisProcessor.process", () => {
  it("claimForProcessing が0件(affectedRows 0)のときは早期リターンし、以降の処理を行わない", async () => {
    const updateSetSpy = vi.fn();
    const db = createFakeDb({ updateQueue: [{ affectedRows: 0 }], updateSetSpy });
    const { storage, getObjectStream } = createFakeStorage();
    const { claudeClient, analyze } = createFakeClaudeClient();
    const processor = new ScreenshotAnalysisProcessor(db, storage, claudeClient, enrichmentQueue);

    await processor.process(createFakeJob({}));

    expect(updateSetSpy).toHaveBeenCalledTimes(1);
    expect(getObjectStream).not.toHaveBeenCalled();
    expect(analyze).not.toHaveBeenCalled();
    expect(enrichmentAdd).not.toHaveBeenCalled();
  });

  it("正常系: claim→取得→リサイズ→解析→completeAnalysis まで到達し status=completed・enrichment_status=pending で保存し、note-enrichment を enqueue する", async () => {
    const updateSetSpy = vi.fn();
    const db = createFakeDb({
      selectQueue: [validInputRow, notDeletedRow],
      updateQueue: [{ affectedRows: 1 }, { affectedRows: 1 }],
      updateSetSpy,
    });
    const { storage } = createFakeStorage();
    const { claudeClient } = createFakeClaudeClient(VALID_RESULT);
    const processor = new ScreenshotAnalysisProcessor(db, storage, claudeClient, enrichmentQueue);
    const noteId = "note-1";

    await processor.process(createFakeJob({ noteId }));

    expect(updateSetSpy).toHaveBeenCalledTimes(2);
    expect(updateSetSpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        status: "completed",
        title: VALID_RESULT.title,
        enrichmentStatus: "pending",
      }),
    );
    expect(enrichmentAdd).toHaveBeenCalledTimes(1);
    expect(enrichmentAdd).toHaveBeenCalledWith(
      NOTE_ENRICHMENT_QUEUE_NAME,
      { noteId },
      { ...NOTE_ENRICHMENT_JOB_OPTIONS, jobId: noteEnrichmentJobId(noteId) },
    );
  });

  it("completeAnalysis の CAS が不成立(affected rows 0。Claude 呼び出し中の論理削除や別試行による claim 更新等)の場合、note-enrichment を enqueue しない(Codex D0 レビュー HIGH 指摘への対応)", async () => {
    const updateSetSpy = vi.fn();
    const db = createFakeDb({
      selectQueue: [validInputRow, notDeletedRow],
      updateQueue: [{ affectedRows: 1 }, { affectedRows: 0 }],
      updateSetSpy,
    });
    const { storage } = createFakeStorage();
    const { claudeClient } = createFakeClaudeClient(VALID_RESULT);
    const processor = new ScreenshotAnalysisProcessor(db, storage, claudeClient, enrichmentQueue);

    await expect(processor.process(createFakeJob({}))).resolves.toBeUndefined();

    expect(updateSetSpy).toHaveBeenCalledTimes(2);
    expect(enrichmentAdd).not.toHaveBeenCalled();
  });

  it("enqueueNoteEnrichment(queue.add)が失敗しても completeAnalysis 自体は正常終了する(fail-closed。ログのみで握りつぶす)", async () => {
    const updateSetSpy = vi.fn();
    const db = createFakeDb({
      selectQueue: [validInputRow, notDeletedRow],
      updateQueue: [{ affectedRows: 1 }, { affectedRows: 1 }],
      updateSetSpy,
    });
    const { storage } = createFakeStorage();
    const { claudeClient } = createFakeClaudeClient(VALID_RESULT);
    const failingAdd = vi.fn().mockRejectedValue(new Error("redis unreachable: secret"));
    const { enrichmentQueue: failingQueue } = createFakeEnrichmentQueue(failingAdd);
    const processor = new ScreenshotAnalysisProcessor(db, storage, claudeClient, failingQueue);

    await expect(processor.process(createFakeJob({}))).resolves.toBeUndefined();

    expect(failingAdd).toHaveBeenCalledTimes(1);
  });

  it("最終試行での失敗のみ failAnalysis を呼び status=failed にする(re-throw しない)", async () => {
    const updateSetSpy = vi.fn();
    const db = createFakeDb({
      selectQueue: [validInputRow, notDeletedRow],
      updateQueue: [{ affectedRows: 1 }, { affectedRows: 1 }],
      updateSetSpy,
    });
    const { storage } = createFakeStorage();
    const { claudeClient } = createFakeClaudeClient(new Error("claude api secret failure"));
    const processor = new ScreenshotAnalysisProcessor(db, storage, claudeClient, enrichmentQueue);

    await expect(
      processor.process(createFakeJob({ attemptsMade: 2, attempts: 3 })),
    ).resolves.toBeUndefined();

    expect(updateSetSpy).toHaveBeenCalledTimes(2);
    expect(updateSetSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({ status: "failed" }));
    const [failCallArg] = updateSetSpy.mock.calls[1] as [{ failureReason: string }];
    expect(typeof failCallArg.failureReason).toBe("string");
    expect(failCallArg.failureReason).not.toContain("claude api secret failure");
    // failAnalysis 経路(completeAnalysis に到達していない)では note-enrichment を enqueue しない。
    expect(enrichmentAdd).not.toHaveBeenCalled();
  });

  it("途中の(最終試行ではない)失敗は failAnalysis を呼ばず re-throw する", async () => {
    const updateSetSpy = vi.fn();
    const db = createFakeDb({
      selectQueue: [validInputRow, notDeletedRow],
      updateQueue: [{ affectedRows: 1 }],
      updateSetSpy,
    });
    const { storage } = createFakeStorage();
    const { claudeClient } = createFakeClaudeClient(new Error("transient failure"));
    const processor = new ScreenshotAnalysisProcessor(db, storage, claudeClient, enrichmentQueue);

    await expect(
      processor.process(createFakeJob({ attemptsMade: 0, attempts: 3 })),
    ).rejects.toThrow();

    expect(updateSetSpy).toHaveBeenCalledTimes(1);
    expect(enrichmentAdd).not.toHaveBeenCalled();
  });

  it("re-throw される例外は固定分類名のみを持ち、元例外のメッセージ/スタックを含まない", async () => {
    const secret = "connection string user=root password=hunter2";
    const db = createFakeDb({
      selectQueue: [validInputRow, notDeletedRow],
      updateQueue: [{ affectedRows: 1 }],
    });
    const { storage } = createFakeStorage();
    const { claudeClient } = createFakeClaudeClient(new Error(secret));
    const processor = new ScreenshotAnalysisProcessor(db, storage, claudeClient, enrichmentQueue);

    let caught: unknown;
    try {
      await processor.process(createFakeJob({ attemptsMade: 0, attempts: 3 }));
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).not.toContain(secret);
    const stack = (caught as Error).stack ?? "";
    expect(stack).not.toContain(secret);
  });

  it("claimForProcessing 自体が例外を投げた場合、最終試行でも failAnalysis を呼ばずサニタイズ済みエラーを re-throw する", async () => {
    const updateSetSpy = vi.fn();
    const db = createFakeDb({
      updateQueue: [new Error("db connection refused: secret-detail")],
      updateSetSpy,
    });
    const { storage } = createFakeStorage();
    const { claudeClient } = createFakeClaudeClient();
    const processor = new ScreenshotAnalysisProcessor(db, storage, claudeClient, enrichmentQueue);

    let caught: unknown;
    try {
      // 最終試行(attemptsMade+1 >= attempts)であっても claim 例外経路は failAnalysis を呼ばない。
      await processor.process(createFakeJob({ attemptsMade: 2, attempts: 3 }));
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain("secret-detail");
    // claim の1回のみ。failAnalysis 用の2回目の update は発生しない。
    expect(updateSetSpy).toHaveBeenCalledTimes(1);
    expect(enrichmentAdd).not.toHaveBeenCalled();
  });

  it("画像処理完了後・Claude呼び出し直前に削除を検知した場合は正常終了し、messages.create 相当(analyze)は呼ばれない", async () => {
    const updateSetSpy = vi.fn();
    const db = createFakeDb({
      // 2回目の select(claim有効性の再確認)が空配列を返す = 論理削除等でCAS条件に
      // 一致しなくなった(isStillClaimedがfalseを返す)。
      selectQueue: [validInputRow, []],
      updateQueue: [{ affectedRows: 1 }],
      updateSetSpy,
    });
    const { storage } = createFakeStorage();
    const { claudeClient, analyze } = createFakeClaudeClient();
    const processor = new ScreenshotAnalysisProcessor(db, storage, claudeClient, enrichmentQueue);

    await expect(processor.process(createFakeJob({}))).resolves.toBeUndefined();

    // resize(画像処理)自体は完了している(削除検知はその後に行われる)。
    expect(resizeForClaudeModule.resizeForClaude).toHaveBeenCalledTimes(1);
    expect(analyze).not.toHaveBeenCalled();
    // claim の1回のみ。completeAnalysis/failAnalysis いずれの追加書き込みも発生しない。
    expect(updateSetSpy).toHaveBeenCalledTimes(1);
    expect(enrichmentAdd).not.toHaveBeenCalled();
  });

  it("画像処理完了後・Claude呼び出し直前の再確認で別の試行が既にgeneration/tokenを更新していた(claim失効)場合も正常終了し、Claudeへ送信しない(Codex コードレビュー r8 指摘 [A-1])", async () => {
    const updateSetSpy = vi.fn();
    const db = createFakeDb({
      // 2回目の select(claim有効性の再確認)が空配列を返す = 別の試行(重複実行・ロック
      // 喪失後の再試行等)が既にgeneration/attempt tokenを更新済みで、CAS条件に一致しない。
      selectQueue: [validInputRow, []],
      updateQueue: [{ affectedRows: 1 }],
      updateSetSpy,
    });
    const { storage } = createFakeStorage();
    const { claudeClient, analyze } = createFakeClaudeClient();
    const processor = new ScreenshotAnalysisProcessor(db, storage, claudeClient, enrichmentQueue);

    await expect(processor.process(createFakeJob({}))).resolves.toBeUndefined();

    expect(analyze).not.toHaveBeenCalled();
    expect(updateSetSpy).toHaveBeenCalledTimes(1);
    expect(enrichmentAdd).not.toHaveBeenCalled();
  });

  it("画像処理完了後・Claude呼び出し直前の再確認で行自体が既に物理削除(purge)されていた場合も正常終了し、Claudeへ送信しない(Codex コードレビュー r6 指摘 [A-2])", async () => {
    const updateSetSpy = vi.fn();
    const db = createFakeDb({
      // 2回目の select(削除再確認)が空配列を返す = 行自体が既に purge 済み。
      selectQueue: [validInputRow, []],
      updateQueue: [{ affectedRows: 1 }],
      updateSetSpy,
    });
    const { storage } = createFakeStorage();
    const { claudeClient, analyze } = createFakeClaudeClient();
    const processor = new ScreenshotAnalysisProcessor(db, storage, claudeClient, enrichmentQueue);

    await expect(processor.process(createFakeJob({}))).resolves.toBeUndefined();

    expect(analyze).not.toHaveBeenCalled();
    // claim の1回のみ。completeAnalysis/failAnalysis いずれの追加書き込みも発生しない。
    expect(updateSetSpy).toHaveBeenCalledTimes(1);
    expect(enrichmentAdd).not.toHaveBeenCalled();
  });

  it("loadProcessingInput の失敗は image_fetch_failed として分類され failureReason に反映される", async () => {
    const updateSetSpy = vi.fn();
    const db = createFakeDb({
      selectQueue: [new Error("select timed out: secret")],
      updateQueue: [{ affectedRows: 1 }, { affectedRows: 1 }],
      updateSetSpy,
    });
    const { storage } = createFakeStorage();
    const { claudeClient } = createFakeClaudeClient();
    const processor = new ScreenshotAnalysisProcessor(db, storage, claudeClient, enrichmentQueue);

    await expect(
      processor.process(createFakeJob({ attemptsMade: 2, attempts: 3 })),
    ).resolves.toBeUndefined();

    const [failCallArg] = updateSetSpy.mock.calls[1] as [{ failureReason: string }];
    expect(failCallArg.failureReason).toBe("画像の取得に失敗しました。もう一度お試しください。");
    expect(enrichmentAdd).not.toHaveBeenCalled();
  });

  it("MinIOから取得した画像ストリームが上限(20MB)を超える場合、image_fetch_failed として分類される(Codex コードレビュー r9 指摘 [A-3])", async () => {
    const updateSetSpy = vi.fn();
    const db = createFakeDb({
      selectQueue: [validInputRow],
      updateQueue: [{ affectedRows: 1 }, { affectedRows: 1 }],
      updateSetSpy,
    });
    const oversizedBuffer = Buffer.alloc(21 * 1024 * 1024, 1);
    const { storage } = createFakeStorage(oversizedBuffer);
    const { claudeClient, analyze } = createFakeClaudeClient();
    const processor = new ScreenshotAnalysisProcessor(db, storage, claudeClient, enrichmentQueue);

    await expect(
      processor.process(createFakeJob({ attemptsMade: 2, attempts: 3 })),
    ).resolves.toBeUndefined();

    expect(analyze).not.toHaveBeenCalled();
    const [failCallArg] = updateSetSpy.mock.calls[1] as [{ failureReason: string }];
    expect(failCallArg.failureReason).toBe("画像の取得に失敗しました。もう一度お試しください。");
    expect(enrichmentAdd).not.toHaveBeenCalled();
  });

  it("failAnalysis 自身が例外を投げた場合も、元例外を含まないサニタイズ済みエラーを re-throw する(二重防御)", async () => {
    const db = createFakeDb({
      selectQueue: [validInputRow, notDeletedRow],
      updateQueue: [{ affectedRows: 1 }, new Error("fail-analysis db secret")],
    });
    const { storage } = createFakeStorage();
    const { claudeClient } = createFakeClaudeClient(new Error("claude failure"));
    const processor = new ScreenshotAnalysisProcessor(db, storage, claudeClient, enrichmentQueue);

    let caught: unknown;
    try {
      await processor.process(createFakeJob({ attemptsMade: 2, attempts: 3 }));
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain("fail-analysis db secret");
    expect(enrichmentAdd).not.toHaveBeenCalled();
  });
});
