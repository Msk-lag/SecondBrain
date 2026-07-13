import { randomUUID } from "node:crypto";
import { Test, type TestingModule } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { getQueueToken } from "@nestjs/bullmq";
import type { Job, Queue } from "bullmq";
import { and, eq, isNull, notes, users, type Database } from "@secondbrain/db";
import {
  SCREENSHOT_ANALYSIS_QUEUE_NAME,
  screenshotAnalysisJobId,
  type ScreenshotAnalysisJobPayload,
  type ScreenshotAnalysisResult,
} from "@secondbrain/shared";
import { MinioClient } from "@secondbrain/storage";
import { AppModule } from "../src/app.module";
import { DRIZZLE } from "../src/db/db.module";
import { MINIO_CLIENT } from "../src/storage/storage.module";
import {
  CLAUDE_VISION_CLIENT,
  type ClaudeVisionClient,
} from "../src/queues/screenshot-analysis/claude-vision.client";
import { ScreenshotAnalysisProcessor } from "../src/queues/screenshot-analysis/screenshot-analysis.processor";
import { NoteStuckRequeueProcessor } from "../src/queues/note-stuck-requeue/note-stuck-requeue.processor";
import { NotePurgeProcessor } from "../src/queues/note-purge/note-purge.processor";

// 1x1 の最小有効 PNG(resize-for-claude が実際に sharp で読み込めるバイト列である必要がある。
// 任意のテキストバイト列だと sharp のデコードに失敗し image_processing_failed
// 〔classifyError 上は image_fetch_failed 扱い〕になってしまう)。
const MINIMAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

/**
 * HTTP を介さず、`@nestjs/testing` で apps/worker の実際の DI 構成(DbModule・StorageModule・
 * BullModule・ScreenshotAnalysisModule・NoteStuckRequeueModule・NotePurgeModule。`AppModule` を
 * そのまま起動する)を組み立て、`ClaudeVisionClient` のみスタブに差し替えるジョブ処理ロジックの
 * 統合テスト(§ テスト方針・実装手順25 参照)。HTTP 認可の検証は apps/api の e2e テストで
 * 完了しているため、ここでは notes 行を直接 insert してテスト起点にする。
 *
 * `ScreenshotAnalysisProcessor`/`NoteStuckRequeueProcessor`/`NotePurgeProcessor` はいずれも
 * `@Processor` により実際の BullMQ Worker として稼働するため、`app.init()` 直後に
 * 各 Worker を一時停止し(`worker.pause(true)`)、本テストの直接呼び出し(`processor.process(...)`)
 * とバックグラウンド消費が競合しないようにする(stuck 再投入バッチのテストで意図的に
 * waiting/delayed のジョブを作るため、対象キューのバックグラウンド消費を止める必要がある)。
 */

function makeJob(
  data: ScreenshotAnalysisJobPayload,
  attemptsMade: number,
  attempts = 3,
): Job<ScreenshotAnalysisJobPayload> {
  return { data, opts: { attempts }, attemptsMade } as unknown as Job<ScreenshotAnalysisJobPayload>;
}

function sampleClaudeResult(overrides: Partial<ScreenshotAnalysisResult> = {}): ScreenshotAnalysisResult {
  return {
    title: "テストタイトル",
    summary: "テスト要約です。",
    tags: ["tag1"],
    concepts: ["concept1"],
    extractedText: "extracted text",
    ...overrides,
  };
}

describe("screenshot-analysis 統合テスト(ジョブ処理ロジック)", () => {
  let app: INestApplication;
  let db: Database;
  let storage: MinioClient;
  let claudeStub: { analyze: ReturnType<typeof vi.fn> };
  let ownerId: string;
  let screenshotAnalysisProcessor: ScreenshotAnalysisProcessor;
  let noteStuckRequeueProcessor: NoteStuckRequeueProcessor;
  let notePurgeProcessor: NotePurgeProcessor;
  let screenshotQueue: Queue;

  beforeAll(async () => {
    claudeStub = { analyze: vi.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(CLAUDE_VISION_CLIENT)
      .useValue(claudeStub as unknown as ClaudeVisionClient)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    db = app.get(DRIZZLE);
    storage = app.get(MINIO_CLIENT);
    screenshotAnalysisProcessor = app.get(ScreenshotAnalysisProcessor);
    noteStuckRequeueProcessor = app.get(NoteStuckRequeueProcessor);
    notePurgeProcessor = app.get(NotePurgeProcessor);
    screenshotQueue = app.get<Queue>(getQueueToken(SCREENSHOT_ANALYSIS_QUEUE_NAME));

    // 各 Worker のバックグラウンド消費を止める(本テストは processor.process() の直接呼び出しで
    // 制御する。stuck 再投入バッチのテストで意図的に waiting/delayed のジョブを作るため必須)。
    await screenshotAnalysisProcessor.worker.pause(true);
    await noteStuckRequeueProcessor.worker.pause(true);
    await notePurgeProcessor.worker.pause(true);
    // Worker.pause() は「このワーカーインスタンスが次に fetch するのを止める」ローカルな一時停止
    // であり、pause 呼び出し時点で既に redis への blocking pop 待機に入っている場合、その待機が
    // 解決して1件だけジョブを拾ってしまうことがある(統合テストで発見: stuck 再投入バッチが
    // queue.add() した直後のジョブを、一時停止済みのはずの screenshotAnalysisProcessor の
    // worker が処理してしまい、アサーション対象のノートが意図せず processing に遷移する)。
    // Queue.pause() はキュー自体を待機列から外す(より強い)停止であり、この競合を構造的に防ぐ。
    await screenshotQueue.pause();

    ownerId = randomUUID();
    await db.insert(users).values({
      id: ownerId,
      email: `${ownerId}@example.com`,
      passwordHash: "unused-in-this-test",
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    // claudeStub は describe 全体で使い回すため、前のテストの呼び出し履歴が残らないよう
    // 各テスト開始前にクリアする(`.not.toHaveBeenCalled()` 系のアサーションが前のテストの
    // 呼び出しを誤って拾わないようにするため)。
    claudeStub.analyze.mockClear();
  });

  async function insertScreenshotNote(overrides: {
    status: "pending" | "processing" | "completed" | "failed";
    processingGeneration?: number;
    processingAttemptToken?: string | null;
    deletedAt?: Date | null;
    imageKey?: string | null;
    imageMimeType?: string | null;
  }): Promise<string> {
    const id = randomUUID();
    const imageKey = overrides.imageKey ?? `screenshots/${ownerId}/${id}.png`;
    const imageMimeType = overrides.imageMimeType ?? "image/png";
    if (imageKey) {
      // claimForProcessing 後に実際に MinIO から画像取得するため、対応するオブジェクトを
      // 事前にアップロードしておく(存在しないと NoSuchKey で image_fetch_failed になり、
      // Claude スタブ呼び出しまで到達できない)。
      await storage.uploadObject(imageKey, MINIMAL_PNG, imageMimeType);
    }
    await db.insert(notes).values({
      id,
      userId: ownerId,
      type: "screenshot",
      title: null,
      body: null,
      summary: null,
      tags: [],
      status: overrides.status,
      failureReason: null,
      imageKey,
      imageMimeType,
      concepts: [],
      extractedText: null,
      deletedAt: overrides.deletedAt ?? null,
      processingGeneration: overrides.processingGeneration ?? 0,
      processingAttemptToken: overrides.processingAttemptToken ?? null,
    });
    return id;
  }

  async function fetchNote(id: string) {
    const rows = await db.select().from(notes).where(eq(notes.id, id)).limit(1);
    return rows[0] ?? null;
  }

  describe("claim/complete/fail の状態遷移", () => {
    it("pending ノートは claim され、Claude 成功で completed になる", async () => {
      const noteId = await insertScreenshotNote({ status: "pending", processingGeneration: 0 });
      claudeStub.analyze.mockResolvedValueOnce(sampleClaudeResult({ title: "成功タイトル" }));

      await screenshotAnalysisProcessor.process(
        makeJob({ noteId, generation: 0 }, 0, 3),
      );

      const note = await fetchNote(noteId);
      expect(note?.status).toBe("completed");
      expect(note?.title).toBe("成功タイトル");
      expect(note?.processingAttemptToken).not.toBeNull();
    });

    it("世代不一致の場合は早期リターンし DB を変更しない", async () => {
      const noteId = await insertScreenshotNote({ status: "pending", processingGeneration: 5 });

      await screenshotAnalysisProcessor.process(makeJob({ noteId, generation: 0 }, 0, 3));

      const note = await fetchNote(noteId);
      expect(note?.status).toBe("pending");
      expect(claudeStub.analyze).not.toHaveBeenCalled();
    });

    it("削除済みノートへは早期リターンし claim しない", async () => {
      const noteId = await insertScreenshotNote({
        status: "pending",
        processingGeneration: 0,
        deletedAt: new Date(),
      });

      await screenshotAnalysisProcessor.process(makeJob({ noteId, generation: 0 }, 0, 3));

      const note = await fetchNote(noteId);
      expect(note?.status).toBe("pending");
    });

    it("既に completed のノートへは早期リターンする", async () => {
      const noteId = await insertScreenshotNote({ status: "completed", processingGeneration: 0 });

      await screenshotAnalysisProcessor.process(makeJob({ noteId, generation: 0 }, 0, 3));

      expect(claudeStub.analyze).not.toHaveBeenCalled();
    });

    it("最終試行でない失敗は re-throw され、DB は processing のまま status=failed にならない", async () => {
      const noteId = await insertScreenshotNote({ status: "pending", processingGeneration: 0 });
      claudeStub.analyze.mockRejectedValueOnce(new Error("boom"));

      await expect(
        screenshotAnalysisProcessor.process(makeJob({ noteId, generation: 0 }, 0, 3)),
      ).rejects.toThrow();

      const note = await fetchNote(noteId);
      expect(note?.status).toBe("processing");
    });

    it("最終試行の失敗は process() 自体を throw させず、DB が failed になる", async () => {
      const noteId = await insertScreenshotNote({ status: "pending", processingGeneration: 0 });
      claudeStub.analyze.mockRejectedValueOnce(new Error("boom"));

      await expect(
        screenshotAnalysisProcessor.process(makeJob({ noteId, generation: 0 }, 2, 3)),
      ).resolves.toBeUndefined();

      const note = await fetchNote(noteId);
      expect(note?.status).toBe("failed");
      expect(note?.failureReason).toBe("予期しないエラーが発生しました。");
    });

    it("同一世代内の旧 attempt token による書き込みは無害化される(CAS 条件のシミュレーション)", async () => {
      // 試行1が claim した token を保持したまま、試行2が新しい token で claim し直した状況を再現する。
      const noteId = await insertScreenshotNote({ status: "pending", processingGeneration: 0 });
      claudeStub.analyze.mockRejectedValueOnce(new Error("first attempt failure"));

      // 試行1: 非最終試行の失敗(processing のまま、token1 が processing_attempt_token に残る)。
      await expect(
        screenshotAnalysisProcessor.process(makeJob({ noteId, generation: 0 }, 0, 3)),
      ).rejects.toThrow();
      const afterAttempt1 = await fetchNote(noteId);
      const staleToken = afterAttempt1?.processingAttemptToken;
      expect(staleToken).toBeTruthy();

      // 試行2: 成功(新しい token で claim され直し completed になる)。
      claudeStub.analyze.mockResolvedValueOnce(sampleClaudeResult({ title: "試行2成功" }));
      await screenshotAnalysisProcessor.process(makeJob({ noteId, generation: 0 }, 1, 3));
      const afterAttempt2 = await fetchNote(noteId);
      expect(afterAttempt2?.status).toBe("completed");
      expect(afterAttempt2?.processingAttemptToken).not.toBe(staleToken);

      // 試行1の(既に上書きされた)古い token での書き込みは無害化される
      // (completeAnalysis と同一の WHERE 条件を模擬。affectedRows が 0 件になることを確認する)。
      const [staleUpdateResult] = await db
        .update(notes)
        .set({ status: "completed", title: "旧試行による上書き" })
        .where(
          and(
            eq(notes.id, noteId),
            eq(notes.processingGeneration, 0),
            eq(notes.processingAttemptToken, staleToken as string),
            eq(notes.status, "processing"),
            isNull(notes.deletedAt),
          ),
        );
      expect(staleUpdateResult.affectedRows).toBe(0);
      const afterStaleWrite = await fetchNote(noteId);
      expect(afterStaleWrite?.title).toBe("試行2成功");
    });
  });

  describe("境界横断シナリオ: 失敗→retry→再解析成功(r8 指摘 [4]・r18 指摘 [4])", () => {
    it("3回失敗後に failed になり、retry 相当の UPDATE で世代を進めると再解析が成功する", async () => {
      const noteId = await insertScreenshotNote({ status: "pending", processingGeneration: 0 });

      claudeStub.analyze.mockRejectedValueOnce(new Error("attempt 1"));
      await expect(
        screenshotAnalysisProcessor.process(makeJob({ noteId, generation: 0 }, 0, 3)),
      ).rejects.toThrow();

      claudeStub.analyze.mockRejectedValueOnce(new Error("attempt 2"));
      await expect(
        screenshotAnalysisProcessor.process(makeJob({ noteId, generation: 0 }, 1, 3)),
      ).rejects.toThrow();

      claudeStub.analyze.mockRejectedValueOnce(new Error("attempt 3 (final)"));
      await expect(
        screenshotAnalysisProcessor.process(makeJob({ noteId, generation: 0 }, 2, 3)),
      ).resolves.toBeUndefined();

      const afterExhausted = await fetchNote(noteId);
      expect(afterExhausted?.status).toBe("failed");
      const oldGeneration = afterExhausted?.processingGeneration ?? 0;
      const oldToken = afterExhausted?.processingAttemptToken as string;

      // NotesService.markPendingForRetry が実際に発行するのと同一の UPDATE を模擬する
      // (worker から apps/api のクラスを import しないため。§ 境界横断シナリオ 参照)。
      await db
        .update(notes)
        .set({
          status: "pending",
          failureReason: null,
          processingGeneration: oldGeneration + 1,
        })
        .where(and(eq(notes.id, noteId), eq(notes.status, "failed")));

      claudeStub.analyze.mockResolvedValueOnce(sampleClaudeResult({ title: "再解析成功" }));
      await screenshotAnalysisProcessor.process(
        makeJob({ noteId, generation: oldGeneration + 1 }, 0, 3),
      );

      const afterRetry = await fetchNote(noteId);
      expect(afterRetry?.status).toBe("completed");
      expect(afterRetry?.title).toBe("再解析成功");

      // 旧世代・旧 token での書き込みは新しい状態を上書きしない。
      const [oldGenerationUpdateResult] = await db
        .update(notes)
        .set({ status: "failed", failureReason: "旧世代からの誤った上書き" })
        .where(
          and(
            eq(notes.id, noteId),
            eq(notes.processingGeneration, oldGeneration),
            eq(notes.processingAttemptToken, oldToken),
            eq(notes.status, "processing"),
            isNull(notes.deletedAt),
          ),
        );
      expect(oldGenerationUpdateResult.affectedRows).toBe(0);
      const afterOldGenerationWrite = await fetchNote(noteId);
      expect(afterOldGenerationWrite?.status).toBe("completed");
    });
  });

  describe("stuck ノート再投入バッチ", () => {
    async function setStaleUpdatedAt(noteId: string, minutesAgo: number): Promise<void> {
      const staleDate = new Date(Date.now() - minutesAgo * 60 * 1000);
      await db.update(notes).set({ updatedAt: staleDate }).where(eq(notes.id, noteId));
    }

    it("10分以上更新されていない pending/processing ノートが対象になり、世代が進む", async () => {
      const pendingNoteId = await insertScreenshotNote({ status: "pending", processingGeneration: 0 });
      const processingNoteId = await insertScreenshotNote({
        status: "processing",
        processingGeneration: 0,
      });
      await setStaleUpdatedAt(pendingNoteId, 11);
      await setStaleUpdatedAt(processingNoteId, 11);

      await noteStuckRequeueProcessor.process();

      const pendingAfter = await fetchNote(pendingNoteId);
      const processingAfter = await fetchNote(processingNoteId);
      expect(pendingAfter?.status).toBe("pending");
      expect(pendingAfter?.processingGeneration).toBe(1);
      expect(processingAfter?.status).toBe("pending");
      expect(processingAfter?.processingGeneration).toBe(1);
    });

    it("10分未満のノートは対象外", async () => {
      const noteId = await insertScreenshotNote({ status: "pending", processingGeneration: 0 });
      // updated_at は insert 直後の現在時刻のまま(10分未満)。

      await noteStuckRequeueProcessor.process();

      const note = await fetchNote(noteId);
      expect(note?.processingGeneration).toBe(0);
    });

    it("BullMQ 上に waiting のジョブが現存する場合は再投入しない", async () => {
      const noteId = await insertScreenshotNote({ status: "pending", processingGeneration: 0 });
      await setStaleUpdatedAt(noteId, 11);
      await screenshotQueue.add(
        SCREENSHOT_ANALYSIS_QUEUE_NAME,
        { noteId, generation: 0 },
        { jobId: screenshotAnalysisJobId(noteId, 0) },
      );

      await noteStuckRequeueProcessor.process();

      const note = await fetchNote(noteId);
      expect(note?.processingGeneration).toBe(0);
    });

    it("BullMQ 上に delayed のジョブが現存する場合は再投入しない", async () => {
      const noteId = await insertScreenshotNote({ status: "processing", processingGeneration: 0 });
      await setStaleUpdatedAt(noteId, 11);
      await screenshotQueue.add(
        SCREENSHOT_ANALYSIS_QUEUE_NAME,
        { noteId, generation: 0 },
        { jobId: screenshotAnalysisJobId(noteId, 0), delay: 60_000 },
      );

      await noteStuckRequeueProcessor.process();

      const note = await fetchNote(noteId);
      expect(note?.processingGeneration).toBe(0);
    });

    it("対応する BullMQ ジョブが存在しない場合は再投入される(終端状態残存・未存在の代表ケース)", async () => {
      const noteId = await insertScreenshotNote({ status: "pending", processingGeneration: 3 });
      await setStaleUpdatedAt(noteId, 11);
      // このノート用のジョブは一切 add していない(存在しない状態を再現する)。

      await noteStuckRequeueProcessor.process();

      const note = await fetchNote(noteId);
      expect(note?.status).toBe("pending");
      expect(note?.processingGeneration).toBe(4);
    });
  });

  describe("NotePurgeProcessor: 物理削除", () => {
    it("30日超の論理削除ノートは MinIO オブジェクト・DB 行ともに物理削除される", async () => {
      const imageKey = `screenshots/${ownerId}/${randomUUID()}.png`;
      const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
      // insertScreenshotNote() が imageKey に対応するダミー画像を自動アップロードする。
      const noteId = await insertScreenshotNote({
        status: "completed",
        imageKey,
        deletedAt: thirtyOneDaysAgo,
      });

      await notePurgeProcessor.process();

      const note = await fetchNote(noteId);
      expect(note).toBeNull();
      await expect(storage.getObjectStream(imageKey)).rejects.toBeTruthy();
    });

    it("到達不能なストレージでは MinIO 削除が失敗し DB 行が残る。通常のストレージに戻すと再試行で成功する", async () => {
      const imageKey = `screenshots/${ownerId}/${randomUUID()}.png`;
      const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
      const noteId = await insertScreenshotNote({
        status: "completed",
        imageKey,
        deletedAt: thirtyOneDaysAgo,
      });

      // この1テストケースに限り、到達不能な接続先で構築した MinioClient を注入する
      // (§ 物理削除経路の実 MinIO 検証・r13 指摘 [3]・r14 指摘 [4] 参照)。
      const unreachableStorage = new MinioClient({
        host: "127.0.0.1",
        port: 1,
        useSSL: false,
        accessKey: "unreachable",
        secretKey: "unreachable-secret",
        bucket: storage.getBucketName(),
      });
      const purgeProcessorWithUnreachableStorage = new NotePurgeProcessor(db, unreachableStorage);

      await purgeProcessorWithUnreachableStorage.process();

      const noteAfterFailedPurge = await fetchNote(noteId);
      expect(noteAfterFailedPurge).not.toBeNull();
      expect(noteAfterFailedPurge?.id).toBe(noteId);

      // 通常のストレージに戻して再実行すると、次回実行として成功する。
      await notePurgeProcessor.process();
      const noteAfterRetry = await fetchNote(noteId);
      expect(noteAfterRetry).toBeNull();
    }, 30_000);
  });
});
