import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Test, type TestingModule } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { getQueueToken } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import request from "supertest";
import { Client as MinioSdkClient } from "minio";
import { notes, users, type Database } from "@secondbrain/db";
import { SCREENSHOT_ANALYSIS_QUEUE_NAME, screenshotAnalysisJobId } from "@secondbrain/shared";
import { AppModule } from "../src/app.module";
import { DRIZZLE } from "../src/db/db.module";
import {
  API_TEST_APP_ACCESS_KEY,
  API_TEST_APP_SECRET_KEY,
  API_TEST_BUCKET,
  API_TEST_CONTROL_BUCKET,
  API_TEST_POLICY_NAME,
} from "./integration-constants";
import {
  getAnonymousStatus,
  removeBucketIfExists,
  runMinioAppPolicyScript,
  setAnonymousDownload,
} from "./minio-admin";

/**
 * `AppModule` を実際に起動した HTTP e2e テスト(§ テスト方針・実装手順25 参照。r4 指摘 [4] への
 * 対応)。DB/MinIO/Redis の接続先はテスト用値へ上書き済み(`integration-setup.ts` 参照)。
 * BullMQ ジョブは実際にキューへ積まれるが、worker 側の processor はこのテストでは動かさない
 * (HTTP レイヤーの検証が目的のため。worker 側のジョブ処理ロジックは
 * apps/worker/test/screenshot-analysis.integration.spec.ts で別途検証する)。
 */

// 1x1 の最小有効 PNG(file-type のマジックバイト検出用)。
const MINIMAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const MINIO_REGION = "us-east-1";

function minioTestClient(): MinioSdkClient {
  return new MinioSdkClient({
    endPoint: process.env.MINIO_HOST ?? "localhost",
    port: Number(process.env.MINIO_API_PORT ?? 9000),
    useSSL: process.env.MINIO_USE_SSL === "true",
    accessKey: API_TEST_APP_ACCESS_KEY,
    secretKey: API_TEST_APP_SECRET_KEY,
    region: MINIO_REGION,
  });
}

function objectPublicUrl(bucket: string, key: string): string {
  const host = process.env.MINIO_HOST ?? "localhost";
  const port = Number(process.env.MINIO_API_PORT ?? 9000);
  const scheme = process.env.MINIO_USE_SSL === "true" ? "https" : "http";
  return `${scheme}://${host}:${port}/${bucket}/${encodeURIComponent(key)}`;
}

/**
 * `minio` SDK の `listObjectsV2()` は Promise ではなく Readable ストリームを返し、権限エラーは
 * `error` イベントとして非同期に通知される(§ listObjectsV2() はストリーム API であることに
 * 注意する 参照)。単純に await/.catch() するだけでは権限拒否を検出できないため、ストリームを
 * 最後まで購読して `error` イベントで拒否コードを検証する。
 */
function expectListObjectsAccessDenied(client: MinioSdkClient, bucket: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const stream = client.listObjectsV2(bucket, "", true);
    let sawError = false;
    stream.on("data", () => {
      // ListBucket が誤って許可されている場合、ここでオブジェクト情報を受け取ってしまう。
    });
    stream.on("error", (err: unknown) => {
      sawError = true;
      const code = (err as { code?: string })?.code;
      if (code === "AccessDenied") {
        resolvePromise();
      } else {
        reject(new Error(`expected AccessDenied but got: ${code ?? String(err)}`));
      }
    });
    stream.on("end", () => {
      if (!sawError) {
        reject(new Error("listObjectsV2 succeeded unexpectedly; ListBucket should be denied"));
      }
    });
  });
}

/**
 * `scripts/minio-app-policy.sh` が生成するポリシー JSON の静的検証(§ ListBucket 禁止の検証手段
 * 参照)。ヒアドキュメント本体を抽出し、`${BUCKET_NAME}` プレースホルダをダミー値へ置換したうえで
 * パースする(実行時テストとの二重保証)。
 */
function extractGeneratedPolicyActions(): string[] {
  const scriptPath = fileURLToPath(new URL("../../../scripts/minio-app-policy.sh", import.meta.url));
  const content = readFileSync(scriptPath, "utf8");
  const match = content.match(/cat > "\$POLICY_FILE" <<EOF\n([\s\S]*?)\nEOF/);
  if (!match) {
    throw new Error("could not locate policy heredoc in scripts/minio-app-policy.sh");
  }
  const jsonText = match[1].replace(/\$\{BUCKET_NAME\}/g, "dummy-bucket-for-static-check");
  const policy = JSON.parse(jsonText) as { Statement: Array<{ Action: string[] }> };
  return policy.Statement.flatMap((statement) => statement.Action);
}

describe("screenshots e2e(HTTP 認可境界)", () => {
  let app: INestApplication;
  let db: Database;
  let ownerId: string;
  let otherId: string;
  let ownerToken: string;
  let otherToken: string;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    db = app.get(DRIZZLE);
    const jwtService = app.get(JwtService);

    ownerId = randomUUID();
    otherId = randomUUID();
    await db.insert(users).values([
      { id: ownerId, email: `${ownerId}@example.com`, passwordHash: "unused-in-this-test" },
      { id: otherId, email: `${otherId}@example.com`, passwordHash: "unused-in-this-test" },
    ]);
    ownerToken = await jwtService.signAsync({ sub: ownerId, email: `${ownerId}@example.com` });
    otherToken = await jwtService.signAsync({ sub: otherId, email: `${otherId}@example.com` });
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  describe("未認証", () => {
    it("アップロードは 401 を返す", async () => {
      const response = await request(app.getHttpServer())
        .post("/notes/screenshots")
        .attach("file", MINIMAL_PNG, "note.png");
      expect(response.status).toBe(401);
    });

    it("画像取得は 401 を返す", async () => {
      const response = await request(app.getHttpServer()).get(`/notes/${randomUUID()}/image`);
      expect(response.status).toBe(401);
    });

    it("retry は 401 を返す", async () => {
      const response = await request(app.getHttpServer()).post(`/notes/${randomUUID()}/retry`);
      expect(response.status).toBe(401);
    });
  });

  describe("アップロード", () => {
    let uploadedNoteId: string;

    it("有効な PNG のアップロードは 201 を返し内部列を含まない", async () => {
      const response = await request(app.getHttpServer())
        .post("/notes/screenshots")
        .set("Authorization", `Bearer ${ownerToken}`)
        .attach("file", MINIMAL_PNG, "note.png");

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ type: "screenshot", status: "pending" });
      expect(response.body).not.toHaveProperty("imageKey");
      expect(response.body).not.toHaveProperty("imageMimeType");
      expect(response.body).not.toHaveProperty("processingGeneration");
      expect(response.body).not.toHaveProperty("processingAttemptToken");
      expect(response.body).not.toHaveProperty("deletedAt");

      uploadedNoteId = response.body.id as string;
    });

    it("画像取得は 200 で Content-Type が一致する(所有者)", async () => {
      const response = await request(app.getHttpServer())
        .get(`/notes/${uploadedNoteId}/image`)
        .set("Authorization", `Bearer ${ownerToken}`);

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe("image/png");
    });

    it("別ユーザーによる画像取得は 404 を返す", async () => {
      const response = await request(app.getHttpServer())
        .get(`/notes/${uploadedNoteId}/image`)
        .set("Authorization", `Bearer ${otherToken}`);
      expect(response.status).toBe(404);
    });

    it("別ユーザーによる retry は 404 を返す", async () => {
      const response = await request(app.getHttpServer())
        .post(`/notes/${uploadedNoteId}/retry`)
        .set("Authorization", `Bearer ${otherToken}`);
      expect(response.status).toBe(404);
    });

    it("pending 状態のノートへの retry は 409 を返す(not_retryable)", async () => {
      const response = await request(app.getHttpServer())
        .post(`/notes/${uploadedNoteId}/retry`)
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(response.status).toBe(409);
    });

    it("対応していない形式のアップロードは 415 を返す", async () => {
      const response = await request(app.getHttpServer())
        .post("/notes/screenshots")
        .set("Authorization", `Bearer ${ownerToken}`)
        .attach("file", Buffer.from("this is not an image"), "note.txt");
      expect(response.status).toBe(415);
    });

    it("10MB を超えるアップロードは 413 を返す", async () => {
      const oversized = Buffer.alloc(10 * 1024 * 1024 + 1024, 1);
      const response = await request(app.getHttpServer())
        .post("/notes/screenshots")
        .set("Authorization", `Bearer ${ownerToken}`)
        .attach("file", oversized, "note.png");
      expect(response.status).toBe(413);
    });
  });

  describe("論理削除済みノート", () => {
    let deletedNoteId: string;

    beforeAll(async () => {
      deletedNoteId = randomUUID();
      await db.insert(notes).values({
        id: deletedNoteId,
        userId: ownerId,
        type: "screenshot",
        title: null,
        body: null,
        summary: null,
        tags: [],
        status: "completed",
        imageKey: `screenshots/${ownerId}/${deletedNoteId}.png`,
        imageMimeType: "image/png",
        concepts: [],
        extractedText: null,
        deletedAt: new Date(),
      });
    });

    it("画像取得は所有者本人でも 404 を返す", async () => {
      const response = await request(app.getHttpServer())
        .get(`/notes/${deletedNoteId}/image`)
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(response.status).toBe(404);
    });

    it("retry は所有者本人でも 404 を返す", async () => {
      const response = await request(app.getHttpServer())
        .post(`/notes/${deletedNoteId}/retry`)
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(response.status).toBe(404);
    });
  });

  describe("retry: 実HTTP+実BullMQ経路(r17 指摘 [3] への対応)", () => {
    it("failed ノートへの retry は 200 を返し、新しい世代のジョブが実際に Redis へ投入される", async () => {
      const noteId = randomUUID();
      await db.insert(notes).values({
        id: noteId,
        userId: ownerId,
        type: "screenshot",
        title: null,
        body: null,
        summary: null,
        tags: [],
        status: "failed",
        failureReason: "AI解析に失敗しました",
        imageKey: `screenshots/${ownerId}/${noteId}.png`,
        imageMimeType: "image/png",
        concepts: [],
        extractedText: null,
        processingGeneration: 1,
      });

      const response = await request(app.getHttpServer())
        .post(`/notes/${noteId}/retry`)
        .set("Authorization", `Bearer ${ownerToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ status: "pending" });

      const queue = app.get<Queue>(getQueueToken(SCREENSHOT_ANALYSIS_QUEUE_NAME));
      const expectedJobId = screenshotAnalysisJobId(noteId, 2);
      const job = await queue.getJob(expectedJobId);

      expect(job).not.toBeNull();
      expect(job?.data).toEqual({ noteId, generation: 2 });
    });
  });

  describe("MinIO 権限設定の smoke test(r6 指摘 [4]・r7 指摘 [3]・r11 指摘 [4]・r13 指摘 [5])", () => {
    let rawClient: MinioSdkClient;

    beforeAll(async () => {
      rawClient = minioTestClient();

      // 別バケットへの負テストの前提として、対象バケットへの Put/Get/Delete が同一インスタンスで
      // 成功することを確認する(§ region 指定必須の対応 参照。リージョン解決自体が機能している
      // ことを負テストの前に保証する)。
      const preflightKey = `__smoke-test-preflight__/${randomUUID()}`;
      const payload = Buffer.from("preflight");
      await rawClient.putObject(API_TEST_BUCKET, preflightKey, payload, payload.length);
      await new Promise<void>((resolvePromise, reject) => {
        rawClient.getObject(API_TEST_BUCKET, preflightKey, (err, stream) => {
          if (err) {
            reject(err);
            return;
          }
          stream.on("data", () => undefined);
          stream.on("end", () => resolvePromise());
          stream.on("error", reject);
        });
      });
      await rawClient.removeObject(API_TEST_BUCKET, preflightKey);
    });

    it("別バケット(制御用バケット)への putObject は AccessDenied で拒否される", async () => {
      await expect(
        rawClient.putObject(
          API_TEST_CONTROL_BUCKET,
          `__should-be-denied__/${randomUUID()}`,
          Buffer.from("denied"),
        ),
      ).rejects.toMatchObject({ code: "AccessDenied" });
    });

    it("未作成バケットへの makeBucket は AccessDenied で拒否される", async () => {
      // S3/MinIO のバケット名は63文字以内の制約があるため、短い prefix + UUID に収める
      // (`secondbrain-test-makebucket-` + UUID36文字だと65文字になり、mc 側のクライアント
      // 検証で `AccessDenied` より先に `InvalidBucketNameError` になってしまう)。
      const uniqueBucketName = `sb-test-mb-${randomUUID()}`;
      try {
        await expect(rawClient.makeBucket(uniqueBucketName, MINIO_REGION)).rejects.toMatchObject({
          code: "AccessDenied",
        });
      } finally {
        // 想定に反して作成されてしまった場合の後始末(root 資格情報で試みる。ベストエフォート)。
        await removeBucketIfExists(uniqueBucketName).catch(() => undefined);
      }
    });

    it("対象バケットへの listObjectsV2(ListBucket)は AccessDenied で拒否される", async () => {
      await expectListObjectsAccessDenied(rawClient, API_TEST_BUCKET);
    });

    it("生成されたポリシー JSON に s3:ListBucket が含まれない(静的検証)", () => {
      const actions = extractGeneratedPolicyActions();
      expect(actions).not.toContain("s3:ListBucket");
      expect(actions).toEqual(
        expect.arrayContaining(["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]),
      );
    });
  });

  describe("匿名アクセス拒否の検証(r29 指摘 [2]・r30 指摘 [2])", () => {
    it("既存の公開状態(mc anonymous set download)からポリシー適用で non-public へ収束する", async () => {
      const objectKey = `__anonymous-access-check__/${randomUUID()}`;
      const rawClient = minioTestClient();

      // 1. 意図的に匿名公開状態を作る(minio-app-policy.sh 実行前)。
      await setAnonymousDownload(API_TEST_BUCKET);

      // 2. 匿名公開状態が実際に機能していることを確認する(認証ヘッダーなしの生 HTTP リクエスト)。
      const payload = Buffer.from("anonymous access check");
      await rawClient.putObject(API_TEST_BUCKET, objectKey, payload, payload.length);
      const publicResponse = await fetch(objectPublicUrl(API_TEST_BUCKET, objectKey));
      expect(publicResponse.status).toBe(200);

      // 3. minio-app-policy.sh を再適用する(mc anonymous set none を含む。冪等)。
      await runMinioAppPolicyScript(
        "minio-app-policy.sh",
        [API_TEST_BUCKET, API_TEST_APP_ACCESS_KEY, API_TEST_POLICY_NAME],
        API_TEST_APP_SECRET_KEY,
      );

      // 4. 匿名アクセスが private(非公開)に収束し、同じオブジェクトへの匿名 HTTP リクエストが
      // 拒否される。`mc anonymous set none` は匿名ポリシーを除去する操作だが、
      // `mc anonymous get` はその結果を "none" ではなく "private" として報告する
      // (scripts/minio-app-policy.sh の同じ注記も参照)。
      const anonymousStatus = await getAnonymousStatus(API_TEST_BUCKET);
      expect(anonymousStatus).toContain("private");

      const deniedResponse = await fetch(objectPublicUrl(API_TEST_BUCKET, objectKey));
      expect(deniedResponse.status).toBe(403);
    }, 60_000);
  });
});
