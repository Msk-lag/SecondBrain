process.env.JWT_SECRET ??= "test-secret";

import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ExecutionContext } from "@nestjs/common";
import request from "supertest";
import type { Note } from "@secondbrain/db";
import { NotesController } from "./notes.controller";
import { NotesService } from "./notes.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: "note-1",
    userId: "user-1",
    type: "memo",
    title: "一言",
    body: "本文",
    summary: null,
    tags: [],
    createdAt: new Date("2026-07-09T00:00:00.000Z"),
    updatedAt: new Date("2026-07-09T00:00:00.000Z"),
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
  };

  beforeEach(async () => {
    Object.values(notesServiceMock).forEach((fn) => fn.mockReset());

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [NotesController],
      providers: [{ provide: NotesService, useValue: notesServiceMock }],
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
    notesServiceMock.list.mockResolvedValue({ items: [makeNote()], nextCursor: null });

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

  it("GET /notes/:id は存在すれば 200 を返す", async () => {
    notesServiceMock.findOwned.mockResolvedValue(makeNote());

    const response = await request(app.getHttpServer()).get("/notes/note-1");

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({ id: "note-1" }));
  });

  it("GET /notes/:id は存在しなければ 404 を返す", async () => {
    notesServiceMock.findOwned.mockResolvedValue(null);

    const response = await request(app.getHttpServer()).get("/notes/missing");

    expect(response.status).toBe(404);
  });

  it("POST /notes は作成したノートを 201 で返す", async () => {
    notesServiceMock.create.mockResolvedValue(makeNote());

    const response = await request(app.getHttpServer()).post("/notes").send({ body: "本文" });

    expect(response.status).toBe(201);
    expect(notesServiceMock.create).toHaveBeenCalledWith("user-1", { body: "本文" });
  });

  it("PATCH /notes/:id は更新後のノートを 200 で返す", async () => {
    notesServiceMock.update.mockResolvedValue(makeNote({ title: "新タイトル" }));

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
});
