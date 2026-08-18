// 固定のテスト用シークレットはリポジトリに残さない(Codex HIGH 指摘対応)。実行時に
// ランダム生成する — 公開されたコミット履歴からの推測・本番環境への混入を構造的に防ぐ。
import { randomBytes } from "node:crypto";
process.env.JWT_SECRET ??= randomBytes(32).toString("hex");

import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ExecutionContext } from "@nestjs/common";
import { getQueueToken } from "@nestjs/bullmq";
import request from "supertest";
import type { Note } from "@secondbrain/db";
import {
  NOTE_ENRICHMENT_QUEUE_NAME,
  SCREENSHOT_ANALYSIS_QUEUE_NAME,
  type Note as PublicNote,
  type RelatedNoteItem,
} from "@secondbrain/shared";
import { NotesController } from "./notes.controller";
import { NotesService } from "./notes.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PerUserUploadLimiter } from "../screenshots/upload-rate-limit";
import { UploadRateLimitGuard } from "../screenshots/upload-rate-limit.guard";

function makeDbNote(overrides: Partial<Note> = {}): Note {
  return {
    id: "note-1",
    userId: "user-1",
    type: "memo",
    title: "一言",
    body: "本文",
    summary: null,
    tags: [],
    status: "completed",
    failureReason: null,
    imageKey: null,
    imageMimeType: null,
    concepts: [],
    extractedText: null,
    deletedAt: null,
    processingGeneration: 0,
    processingAttemptToken: null,
    // 埋め込み関連列(M1-4a §設計決定1 参照)。この spec の大半のケースでは未生成(null)固定。
    embedding: null,
    embeddingModel: null,
    embeddingFingerprint: null,
    enrichmentStatus: null,
    createdAt: new Date("2026-07-09T00:00:00.000Z"),
    updatedAt: new Date("2026-07-09T00:00:00.000Z"),
    ...overrides,
  };
}

function makePublicNote(overrides: Partial<PublicNote> = {}): PublicNote {
  return {
    id: "note-1",
    userId: "user-1",
    type: "memo",
    title: "一言",
    body: "本文",
    summary: null,
    tags: [],
    status: "completed",
    failureReason: null,
    concepts: [],
    extractedText: null,
    createdAt: "2026-07-09T00:00:00.000Z",
    updatedAt: "2026-07-09T00:00:00.000Z",
    ...overrides,
  };
}

describe("NotesController", () => {
  let app: INestApplication;
  const notesServiceMock = {
    list: vi.fn(),
    findOwned: vi.fn(),
    findRelated: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    markPendingForRetry: vi.fn(),
  };
  const queueMock = { add: vi.fn() };
  const noteEnrichmentQueueMock = { add: vi.fn() };

  beforeEach(async () => {
    Object.values(notesServiceMock).forEach((fn) => fn.mockReset());
    queueMock.add.mockReset().mockResolvedValue(undefined);
    noteEnrichmentQueueMock.add.mockReset().mockResolvedValue(undefined);

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [NotesController],
      providers: [
        { provide: NotesService, useValue: notesServiceMock },
        { provide: getQueueToken(SCREENSHOT_ANALYSIS_QUEUE_NAME), useValue: queueMock },
        { provide: getQueueToken(NOTE_ENRICHMENT_QUEUE_NAME), useValue: noteEnrichmentQueueMock },
        PerUserUploadLimiter,
        UploadRateLimitGuard,
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          const req = context.switchToHttp().getRequest<{ user?: unknown }>();
          req.user = { id: "user-1", email: "user@example.com" };
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it("GET /notes は一覧を返す", async () => {
    notesServiceMock.list.mockResolvedValue({ items: [makePublicNote()], nextCursor: null });

    const response = await request(app.getHttpServer()).get("/notes");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      items: [expect.objectContaining({ id: "note-1" })],
      nextCursor: null,
    });
    expect(notesServiceMock.list).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ limit: 20 }),
    );
  });

  it("GET /notes/:id は存在すれば内部列を除外した 200 を返す", async () => {
    notesServiceMock.findOwned.mockResolvedValue(
      makeDbNote({ imageKey: "screenshots/user-1/note-1.png" }),
    );

    const response = await request(app.getHttpServer()).get("/notes/note-1");

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({ id: "note-1" }));
    expect(response.body).not.toHaveProperty("imageKey");
    expect(response.body).not.toHaveProperty("processingGeneration");
  });

  it("GET /notes/:id は存在しなければ 404 を返す", async () => {
    notesServiceMock.findOwned.mockResolvedValue(null);

    const response = await request(app.getHttpServer()).get("/notes/missing");

    expect(response.status).toBe(404);
  });

  it("POST /notes は作成したノートを 201 で返す", async () => {
    notesServiceMock.create.mockResolvedValue(makePublicNote());

    const response = await request(app.getHttpServer()).post("/notes").send({ body: "本文" });

    expect(response.status).toBe(201);
    expect(notesServiceMock.create).toHaveBeenCalledWith("user-1", { body: "本文" });
  });

  it("POST /notes は作成成功後に note-enrichment ジョブを投入する(M1-4a 計画 §担当スコープ2 (a))", async () => {
    // fail-closed の投入順序: DB 書き込み(NotesService.create 内の insert。ここでは
    // create() の resolve で代表させる。insert 自体の検証は notes.service.spec.ts 側)が
    // 先に完了してから enqueue が呼ばれることを、実際の呼び出し順序で確認する。
    const callOrder: string[] = [];
    notesServiceMock.create.mockImplementation(() => {
      callOrder.push("create");
      return Promise.resolve(makePublicNote());
    });
    noteEnrichmentQueueMock.add.mockImplementation(() => {
      callOrder.push("enqueue");
      return Promise.resolve(undefined);
    });

    const response = await request(app.getHttpServer()).post("/notes").send({ body: "本文" });

    expect(response.status).toBe(201);
    expect(noteEnrichmentQueueMock.add).toHaveBeenCalledWith(
      NOTE_ENRICHMENT_QUEUE_NAME,
      { noteId: "note-1" },
      expect.objectContaining({ jobId: "note-enrichment-note-1" }),
    );
    expect(callOrder).toEqual(["create", "enqueue"]);
  });

  it("POST /notes は enrichment ジョブの投入に失敗しても 201 を返す(enqueue 失敗は握りつぶす)", async () => {
    notesServiceMock.create.mockResolvedValue(makePublicNote());
    noteEnrichmentQueueMock.add.mockRejectedValue(new Error("redis down"));

    const response = await request(app.getHttpServer()).post("/notes").send({ body: "本文" });

    expect(response.status).toBe(201);
  });

  it("PATCH /notes/:id は更新後のノートを 200 で返す", async () => {
    notesServiceMock.update.mockResolvedValue(makePublicNote({ title: "新タイトル" }));

    const response = await request(app.getHttpServer())
      .patch("/notes/note-1")
      .send({ title: "新タイトル" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({ title: "新タイトル" }));
  });

  it("PATCH /notes/:id は対象が無ければ 404 を返す", async () => {
    notesServiceMock.update.mockResolvedValue(null);

    const response = await request(app.getHttpServer()).patch("/notes/missing").send({});

    expect(response.status).toBe(404);
  });

  it("PATCH /notes/:id は更新対象フィールドが1つ以上あれば note-enrichment ジョブを投入する(M1-4a 計画 §担当スコープ2 (c))", async () => {
    notesServiceMock.update.mockResolvedValue(makePublicNote({ title: "新タイトル" }));

    const response = await request(app.getHttpServer())
      .patch("/notes/note-1")
      .send({ title: "新タイトル" });

    expect(response.status).toBe(200);
    expect(noteEnrichmentQueueMock.add).toHaveBeenCalledWith(
      NOTE_ENRICHMENT_QUEUE_NAME,
      { noteId: "note-1" },
      expect.objectContaining({ jobId: "note-enrichment-note-1" }),
    );
  });

  it("PATCH /notes/:id は空の PATCH では note-enrichment ジョブを投入しない(DB へ pending 書き込みが無いため)", async () => {
    notesServiceMock.update.mockResolvedValue(makePublicNote());

    const response = await request(app.getHttpServer()).patch("/notes/note-1").send({});

    expect(response.status).toBe(200);
    expect(noteEnrichmentQueueMock.add).not.toHaveBeenCalled();
  });

  it("PATCH /notes/:id は 404 の場合は note-enrichment ジョブを投入しない", async () => {
    notesServiceMock.update.mockResolvedValue(null);

    const response = await request(app.getHttpServer())
      .patch("/notes/missing")
      .send({ title: "新タイトル" });

    expect(response.status).toBe(404);
    expect(noteEnrichmentQueueMock.add).not.toHaveBeenCalled();
  });

  it("GET /notes/:id/related は status と類似ノート一覧を 200 で返す(ready)", async () => {
    const similar: RelatedNoteItem[] = [
      { id: "note-2", title: "類似ノート", type: "memo", excerpt: "要約", distance: 0.12 },
    ];
    notesServiceMock.findRelated.mockResolvedValue({ status: "ready", similar });

    const response = await request(app.getHttpServer()).get("/notes/note-1/related");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ready", similar });
    expect(notesServiceMock.findRelated).toHaveBeenCalledWith("user-1", "note-1");
  });

  it("GET /notes/:id/related は status: generating + 空配列を区別してそのまま返す(M1-4a 論点2)", async () => {
    notesServiceMock.findRelated.mockResolvedValue({ status: "generating", similar: [] });

    const response = await request(app.getHttpServer()).get("/notes/note-1/related");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "generating", similar: [] });
  });

  it("GET /notes/:id/related は対象が無ければ 404 を返す", async () => {
    notesServiceMock.findRelated.mockResolvedValue(null);

    const response = await request(app.getHttpServer()).get("/notes/missing/related");

    expect(response.status).toBe(404);
  });

  it("DELETE /notes/:id は成功時に 204 を返す", async () => {
    notesServiceMock.remove.mockResolvedValue(true);

    const response = await request(app.getHttpServer()).delete("/notes/note-1");

    expect(response.status).toBe(204);
  });

  it("DELETE /notes/:id は対象が無ければ 404 を返す", async () => {
    notesServiceMock.remove.mockResolvedValue(false);

    const response = await request(app.getHttpServer()).delete("/notes/missing");

    expect(response.status).toBe(404);
  });

  it("POST /notes/:id/retry は対象が無ければ 404 を返す", async () => {
    notesServiceMock.markPendingForRetry.mockResolvedValue("not_found");

    const response = await request(app.getHttpServer()).post("/notes/missing/retry");

    expect(response.status).toBe(404);
    expect(queueMock.add).not.toHaveBeenCalled();
  });

  it("POST /notes/:id/retry は failed 以外の状態なら 409 を返す", async () => {
    notesServiceMock.markPendingForRetry.mockResolvedValue("not_retryable");

    const response = await request(app.getHttpServer()).post("/notes/note-1/retry");

    expect(response.status).toBe(409);
    expect(queueMock.add).not.toHaveBeenCalled();
  });

  it("POST /notes/:id/retry は成功時に新しい世代でジョブを投入し 200 を返す", async () => {
    notesServiceMock.markPendingForRetry.mockResolvedValue({
      note: makePublicNote({ type: "screenshot", status: "pending" }),
      generation: 2,
    });

    const response = await request(app.getHttpServer()).post("/notes/note-1/retry");

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({ status: "pending" }));
    expect(queueMock.add).toHaveBeenCalledWith(
      SCREENSHOT_ANALYSIS_QUEUE_NAME,
      { noteId: "note-1", generation: 2 },
      expect.objectContaining({ jobId: "note-1-gen-2" }),
    );
  });

  it("同一ユーザーの retry が時間窓内の件数上限(20件)を超えると 429 を返す(Codex コードレビュー 2026-07-13 r9 指摘 [A-3])", async () => {
    notesServiceMock.markPendingForRetry.mockResolvedValue({
      note: makePublicNote({ type: "screenshot", status: "pending" }),
      generation: 2,
    });

    for (let i = 0; i < 20; i++) {
      const response = await request(app.getHttpServer()).post("/notes/note-1/retry");
      expect(response.status).toBe(200);
    }

    notesServiceMock.markPendingForRetry.mockClear();
    const response = await request(app.getHttpServer()).post("/notes/note-1/retry");

    expect(response.status).toBe(429);
    // Guard がハンドラーより前に弾いているため、markPendingForRetry(≒Claude API 呼び出しに
    // つながる再実行本体)にすら到達していないことを確認する。
    expect(notesServiceMock.markPendingForRetry).not.toHaveBeenCalled();
  }, 15_000);
});
