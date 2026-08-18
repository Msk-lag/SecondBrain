// 固定のテスト用シークレットはリポジトリに残さない(Codex HIGH 指摘対応)。実行時に
// ランダム生成する — 公開されたコミット履歴からの推測・本番環境への混入を構造的に防ぐ。
import { randomBytes } from "node:crypto";
process.env.JWT_SECRET ??= randomBytes(32).toString("hex");

vi.mock("./detect-image-type", () => ({
  detectImageType: vi.fn(),
}));

import { Readable } from "node:stream";
import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ExecutionContext } from "@nestjs/common";
import { getQueueToken } from "@nestjs/bullmq";
import request from "supertest";
import { SCREENSHOT_ANALYSIS_QUEUE_NAME } from "@secondbrain/shared";
import type { Note } from "@secondbrain/db";
import { StorageTimeoutError } from "@secondbrain/storage";
import { ScreenshotsController } from "./screenshots.controller";
import { detectImageType } from "./detect-image-type";
import { DRIZZLE } from "../../db/db.module";
import { MINIO_CLIENT } from "../../storage/storage.module";
import { NotesService } from "../notes/notes.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PerUserUploadLimiter } from "./upload-rate-limit";
import { UploadRateLimitGuard } from "./upload-rate-limit.guard";

const detectImageTypeMock = vi.mocked(detectImageType);

function makeScreenshotNote(overrides: Partial<Note> = {}): Note {
  return {
    id: "note-1",
    userId: "user-1",
    type: "screenshot",
    title: null,
    body: null,
    summary: null,
    tags: [],
    status: "pending",
    failureReason: null,
    imageKey: "screenshots/user-1/note-1.png",
    imageMimeType: "image/png",
    concepts: [],
    extractedText: null,
    deletedAt: null,
    processingGeneration: 0,
    processingAttemptToken: null,
    // 埋め込み関連列(M1-4a §設計決定1 参照)。この spec は enrichment 経路を対象としないため
    // 常に未生成(null)固定。
    embedding: null,
    embeddingModel: null,
    embeddingFingerprint: null,
    enrichmentStatus: null,
    createdAt: new Date("2026-07-11T00:00:00.000Z"),
    updatedAt: new Date("2026-07-11T00:00:00.000Z"),
    ...overrides,
  };
}

describe("ScreenshotsController", () => {
  let app: INestApplication;
  let dbMock: { insert: ReturnType<typeof vi.fn> };
  let minioClientMock: {
    uploadObject: ReturnType<typeof vi.fn>;
    deleteObject: ReturnType<typeof vi.fn>;
    getObjectStream: ReturnType<typeof vi.fn>;
  };
  let queueMock: { add: ReturnType<typeof vi.fn> };
  let notesServiceMock: { findOwned: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    detectImageTypeMock.mockReset();
    dbMock = {
      insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
    };
    minioClientMock = {
      uploadObject: vi.fn().mockResolvedValue(undefined),
      deleteObject: vi.fn().mockResolvedValue(undefined),
      getObjectStream: vi.fn(),
    };
    queueMock = { add: vi.fn().mockResolvedValue(undefined) };
    notesServiceMock = { findOwned: vi.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [ScreenshotsController],
      providers: [
        { provide: DRIZZLE, useValue: dbMock },
        { provide: MINIO_CLIENT, useValue: minioClientMock },
        { provide: getQueueToken(SCREENSHOT_ANALYSIS_QUEUE_NAME), useValue: queueMock },
        { provide: NotesService, useValue: notesServiceMock },
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

  describe("POST /notes/screenshots", () => {
    it("file が無い場合は 400 を返す", async () => {
      const response = await request(app.getHttpServer()).post("/notes/screenshots");

      expect(response.status).toBe(400);
    });

    it("file-type がサポート外形式と判定した場合は 415 を返し MinIO へアップロードしない", async () => {
      detectImageTypeMock.mockReturnValue(undefined);

      const response = await request(app.getHttpServer())
        .post("/notes/screenshots")
        .attach("file", Buffer.from("not an image"), "note.txt");

      expect(response.status).toBe(415);
      expect(minioClientMock.uploadObject).not.toHaveBeenCalled();
    });

    it("MinIO アップロードが失敗した場合は 502 を返し DB insert は呼ばない。孤児オブジェクトになりうるキーの削除もベストエフォートで試みる(Codex コードレビュー r3 指摘 [A-2])", async () => {
      detectImageTypeMock.mockReturnValue({ mime: "image/png", ext: "png" });
      minioClientMock.uploadObject.mockRejectedValue(new Error("minio down"));

      const response = await request(app.getHttpServer())
        .post("/notes/screenshots")
        .attach("file", Buffer.from([0x89, 0x50, 0x4e, 0x47]), "note.png");

      expect(response.status).toBe(502);
      expect(dbMock.insert).not.toHaveBeenCalled();
      expect(minioClientMock.deleteObject).toHaveBeenCalledTimes(1);
    });

    it("MinIO アップロード失敗後の補償削除自体が失敗しても 502 はそのまま返す", async () => {
      detectImageTypeMock.mockReturnValue({ mime: "image/png", ext: "png" });
      minioClientMock.uploadObject.mockRejectedValue(new Error("minio down"));
      minioClientMock.deleteObject.mockRejectedValue(new Error("delete also down"));

      const response = await request(app.getHttpServer())
        .post("/notes/screenshots")
        .attach("file", Buffer.from([0x89, 0x50, 0x4e, 0x47]), "note.png");

      expect(response.status).toBe(502);
    });

    it("DB insert が確定的に失敗した場合は補償削除してから 502 を返す", async () => {
      detectImageTypeMock.mockReturnValue({ mime: "image/png", ext: "png" });
      const dupError = Object.assign(new Error("dup"), { code: "ER_DUP_ENTRY" });
      dbMock.insert.mockReturnValue({ values: vi.fn().mockRejectedValue(dupError) });

      const response = await request(app.getHttpServer())
        .post("/notes/screenshots")
        .attach("file", Buffer.from([0x89, 0x50, 0x4e, 0x47]), "note.png");

      expect(response.status).toBe(502);
      expect(minioClientMock.deleteObject).toHaveBeenCalledTimes(1);
    });

    it("DB insert が不確定な失敗の場合は補償削除せず 502 を返す", async () => {
      detectImageTypeMock.mockReturnValue({ mime: "image/png", ext: "png" });
      dbMock.insert.mockReturnValue({
        values: vi.fn().mockRejectedValue(new Error("connection lost")),
      });

      const response = await request(app.getHttpServer())
        .post("/notes/screenshots")
        .attach("file", Buffer.from([0x89, 0x50, 0x4e, 0x47]), "note.png");

      expect(response.status).toBe(502);
      expect(minioClientMock.deleteObject).not.toHaveBeenCalled();
    });

    it("insert クエリ構築自体が同期的に例外を投げても、in-flight セマフォ枠を解放し次のアップロードを恒久的にブロックしない(Codex コードレビュー 2026-07-13 r9 指摘 [A-2])", async () => {
      detectImageTypeMock.mockReturnValue({ mime: "image/png", ext: "png" });
      // `this.db.insert(notes).values(...)` の評価自体を同期的に投げさせる
      // (Promise を返す前に例外が発生するケースを再現する)。
      dbMock.insert.mockImplementation(() => {
        throw new Error("query builder sync failure");
      });

      // アプリ層セマフォの上限(10)ぴったりの回数、同期例外を発生させる。
      for (let i = 0; i < 10; i++) {
        const response = await request(app.getHttpServer())
          .post("/notes/screenshots")
          .attach("file", Buffer.from([0x89, 0x50, 0x4e, 0x47]), "note.png");
        expect(response.status).toBe(502);
      }
      // この時点で `DbPoolInsertLimitError` による確定的失敗(補償削除あり)が一度も
      // 発生していないこと(=セマフォが枯渇していないこと)を確認する。
      expect(minioClientMock.deleteObject).not.toHaveBeenCalled();

      // セマフォが正しく解放されていれば、直後の正常な insert は
      // `DbPoolInsertLimitError`(上限超過)にならず成功するはず。
      dbMock.insert.mockImplementation(() => ({ values: vi.fn().mockResolvedValue(undefined) }));
      notesServiceMock.findOwned.mockResolvedValue(makeScreenshotNote());
      const finalResponse = await request(app.getHttpServer())
        .post("/notes/screenshots")
        .attach("file", Buffer.from([0x89, 0x50, 0x4e, 0x47]), "note.png");

      expect(finalResponse.status).toBe(201);
    });

    it("同一ユーザーのアップロードが時間窓内の件数上限(20件)を超えると 429 を返す(Codex コードレビュー r3 指摘 [A-1])", async () => {
      detectImageTypeMock.mockReturnValue({ mime: "image/png", ext: "png" });
      notesServiceMock.findOwned.mockImplementation((_userId: string, id: string) =>
        makeScreenshotNote({ id }),
      );

      for (let i = 0; i < 20; i++) {
        const response = await request(app.getHttpServer())
          .post("/notes/screenshots")
          .attach("file", Buffer.from([0x89, 0x50, 0x4e, 0x47]), "note.png");
        expect(response.status).toBe(201);
      }

      detectImageTypeMock.mockClear();
      const response = await request(app.getHttpServer())
        .post("/notes/screenshots")
        .attach("file", Buffer.from([0x89, 0x50, 0x4e, 0x47]), "note.png");

      expect(response.status).toBe(429);
      // Guard が Multer/FileInterceptor より前に弾いているため、ハンドラー内の
      // detectImageType にすら到達していないことを確認する(Codex コードレビュー
      // r4 指摘 [A-2] への対応の検証)。
      expect(detectImageTypeMock).not.toHaveBeenCalled();
    }, 15_000);

    it("Multer がハンドラー到達前にファイルサイズ超過で拒否しても、in-flight 枠は解放され後続の正常なアップロードは成功する(Codex コードレビュー r5 指摘 [A-1])", async () => {
      detectImageTypeMock.mockReturnValue({ mime: "image/png", ext: "png" });
      notesServiceMock.findOwned.mockImplementation((_userId: string, id: string) =>
        makeScreenshotNote({ id }),
      );
      const oversizedFile = Buffer.alloc(11 * 1024 * 1024, 1);

      for (let i = 0; i < 3; i++) {
        const response = await request(app.getHttpServer())
          .post("/notes/screenshots")
          .attach("file", oversizedFile, "note.png");
        expect(response.status).toBe(413);
      }

      const response = await request(app.getHttpServer())
        .post("/notes/screenshots")
        .attach("file", Buffer.from([0x89, 0x50, 0x4e, 0x47]), "note.png");

      expect(response.status).toBe(201);
    }, 15_000);

    it("multipart に想定外の追加フィールドを含めると、ハンドラー到達前に拒否される(Codex コードレビュー 2026-07-13 r2 指摘 [A-1])", async () => {
      const response = await request(app.getHttpServer())
        .post("/notes/screenshots")
        .field("extra", "unexpected-field")
        .attach("file", Buffer.from([0x89, 0x50, 0x4e, 0x47]), "note.png");

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      expect(detectImageTypeMock).not.toHaveBeenCalled();
    });

    it("成功時は pending 状態の note を 201 で返し、世代0でジョブを投入する", async () => {
      detectImageTypeMock.mockReturnValue({ mime: "image/png", ext: "png" });
      notesServiceMock.findOwned.mockImplementation((_userId: string, id: string) =>
        makeScreenshotNote({ id }),
      );

      const response = await request(app.getHttpServer())
        .post("/notes/screenshots")
        .attach("file", Buffer.from([0x89, 0x50, 0x4e, 0x47]), "note.png");

      expect(response.status).toBe(201);
      expect(response.body).toEqual(
        expect.objectContaining({ status: "pending", type: "screenshot" }),
      );
      // 内部列(imageKey・processingGeneration 等)が公開レスポンスへ漏れていないことを確認する
      expect(response.body).not.toHaveProperty("imageKey");
      expect(response.body).not.toHaveProperty("processingGeneration");
      expect(queueMock.add).toHaveBeenCalledTimes(1);
      const [queueName, payload, jobOptions] = queueMock.add.mock.calls[0] as [
        string,
        { generation: number },
        { jobId: string },
      ];
      expect(queueName).toBe(SCREENSHOT_ANALYSIS_QUEUE_NAME);
      expect(payload.generation).toBe(0);
      expect(jobOptions.jobId).toContain("-gen-0");
    });
  });

  describe("GET /notes/:id/image", () => {
    it("ノートが存在しない場合は 404 を返す", async () => {
      notesServiceMock.findOwned.mockResolvedValue(null);

      const response = await request(app.getHttpServer()).get("/notes/missing/image");

      expect(response.status).toBe(404);
    });

    it("screenshot 種別でない場合は 404 を返す", async () => {
      notesServiceMock.findOwned.mockResolvedValue(makeScreenshotNote({ type: "memo" }));

      const response = await request(app.getHttpServer()).get("/notes/note-1/image");

      expect(response.status).toBe(404);
    });

    it("imageKey が無い場合は 404 を返す", async () => {
      notesServiceMock.findOwned.mockResolvedValue(makeScreenshotNote({ imageKey: null }));

      const response = await request(app.getHttpServer()).get("/notes/note-1/image");

      expect(response.status).toBe(404);
    });

    it("MinIO 取得がタイムアウトした場合は 504 を返す", async () => {
      notesServiceMock.findOwned.mockResolvedValue(makeScreenshotNote());
      minioClientMock.getObjectStream.mockRejectedValue(
        new StorageTimeoutError("getObjectStream", 30_000),
      );

      const response = await request(app.getHttpServer()).get("/notes/note-1/image");

      expect(response.status).toBe(504);
    });

    it("MinIO 取得がタイムアウト以外で失敗した場合は 502 を返す", async () => {
      notesServiceMock.findOwned.mockResolvedValue(makeScreenshotNote());
      minioClientMock.getObjectStream.mockRejectedValue(new Error("NoSuchKey"));

      const response = await request(app.getHttpServer()).get("/notes/note-1/image");

      expect(response.status).toBe(502);
    });

    it("成功時は Content-Type ヘッダー付きで画像をストリーミング配信する", async () => {
      notesServiceMock.findOwned.mockResolvedValue(makeScreenshotNote());
      minioClientMock.getObjectStream.mockResolvedValue(Readable.from([Buffer.from([1, 2, 3])]));

      const response = await request(app.getHttpServer()).get("/notes/note-1/image");

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe("image/png");
    });

    it("最初のデータ送信前にMinIOストリームがエラーになった場合、502をapplication/jsonのContent-Typeで返し、ソースストリームを破棄する(Codex コードレビュー r7 指摘 [A-4]・2026-07-13 r4 指摘 [A-2])", async () => {
      notesServiceMock.findOwned.mockResolvedValue(makeScreenshotNote());
      const sourceStream = new Readable({
        read() {
          process.nextTick(() => this.emit("error", new Error("boom")));
        },
      });
      const destroySpy = vi.spyOn(sourceStream, "destroy");
      minioClientMock.getObjectStream.mockResolvedValue(sourceStream);

      const response = await request(app.getHttpServer()).get("/notes/note-1/image");

      expect(response.status).toBe(502);
      expect(response.headers["content-type"]).toMatch(/application\/json/);
      expect(destroySpy).toHaveBeenCalled();
    });

    it("クライアントがダウンロード完了前に切断した場合、MinIOのソースストリームを破棄する(Codex コードレビュー r5 指摘 [A-3])", async () => {
      notesServiceMock.findOwned.mockResolvedValue(makeScreenshotNote());
      // 意図的に完結させない Readable(client.abort() が発火するまでの猶予を作る)。
      let pushChunk: (() => void) | undefined;
      const sourceStream = new Readable({
        read() {
          pushChunk = () => this.push(Buffer.from([1, 2, 3]));
        },
      });
      const destroySpy = vi.spyOn(sourceStream, "destroy");
      minioClientMock.getObjectStream.mockResolvedValue(sourceStream);

      const req = request(app.getHttpServer()).get("/notes/note-1/image");
      const reqPromise = req.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 20));
      pushChunk?.();
      req.abort();
      await reqPromise;

      await vi.waitFor(() => {
        expect(destroySpy).toHaveBeenCalled();
      });
    });

    it("getObjectStream の解決待機中にクライアントが切断した場合も、後から取得されたストリームを直ちに破棄する(Codex コードレビュー r6 指摘 [A-1])", async () => {
      notesServiceMock.findOwned.mockResolvedValue(makeScreenshotNote());
      const sourceStream = Readable.from([Buffer.from([1, 2, 3])]);
      const destroySpy = vi.spyOn(sourceStream, "destroy");
      let resolveGetObjectStream: ((stream: Readable) => void) | undefined;
      const pendingGetObjectStream = new Promise<Readable>((resolve) => {
        resolveGetObjectStream = resolve;
      });
      minioClientMock.getObjectStream.mockReturnValue(pendingGetObjectStream);

      const req = request(app.getHttpServer()).get("/notes/note-1/image");
      const reqPromise = req.catch(() => undefined);
      // getObjectStream() がまだ解決していない間に切断する。
      await new Promise((resolve) => setTimeout(resolve, 20));
      req.abort();
      await reqPromise;

      // 切断後に遅れて解決した場合、pipe() を一切開始せず直ちに破棄されることを確認する。
      resolveGetObjectStream?.(sourceStream);

      await vi.waitFor(() => {
        expect(destroySpy).toHaveBeenCalled();
      });
    });
  });
});
