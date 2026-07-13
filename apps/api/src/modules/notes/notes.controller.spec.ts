process.env.JWT_SECRET ??= "test-secret";

import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ExecutionContext } from "@nestjs/common";
import { getQueueToken } from "@nestjs/bullmq";
import request from "supertest";
import type { Note } from "@secondbrain/db";
import { SCREENSHOT_ANALYSIS_QUEUE_NAME, type Note as PublicNote } from "@secondbrain/shared";
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
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    markPendingForRetry: vi.fn(),
  };
  const queueMock = { add: vi.fn() };

  beforeEach(async () => {
    Object.values(notesServiceMock).forEach((fn) => fn.mockReset());
    queueMock.add.mockReset().mockResolvedValue(undefined);

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [NotesController],
      providers: [
        { provide: NotesService, useValue: notesServiceMock },
        { provide: getQueueToken(SCREENSHOT_ANALYSIS_QUEUE_NAME), useValue: queueMock },
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
