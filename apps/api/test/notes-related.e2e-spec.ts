import { randomUUID } from "node:crypto";
import { Test, type TestingModule } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import request from "supertest";
import { notes, users, sql, type Database } from "@secondbrain/db";
import { AppModule } from "../src/app.module";
import { DRIZZLE } from "../src/db/db.module";

/**
 * `GET /notes/:id/related`(類似候補探索。M1-4a 計画 §設計決定3・実装手順7・論点2)の e2e テスト。
 *
 * `notes.service.spec.ts` の `NotesService.findRelated` 単体テストは DB をモックしているため、
 * SQL の WHERE 句自体が担保する制約(自ノート除外・論理削除除外・user_id 分離)を検証できない
 * (同ファイルのコメント参照)。ここでは実際の MariaDB(`secondbrain_test_api`)へ接続し、
 * `VEC_FromText` で実ベクトルを投入したうえで、計画の受入条件4を実証する。加えて、
 * status マッピング(論点2。Fable 5 + Codex 独立議論で確定)のうち `status: "ready"` +
 * 空配列と `status: "generating"` + 空配列が実 DB 経由でも区別されることを確認する
 * (status マッピングの全パターンは notes.service.spec.ts のモックテストで網羅する)。
 *
 * OpenAI API は呼ばない(embedding は `VEC_FromText` で直接投入する。note-enrichment ジョブは
 * このテストでは一切動かさない)。
 */

// notes.embedding は VECTOR(1536)(packages/db/src/schema/notes.ts 参照)。
const EMBEDDING_DIMENSIONS = 1536;

// このテストで「同一モデル」として扱う値。target・near系・deleted系など、モデル差し替え観点
// 以外のノートはすべてこのモデルに統一する(異なる embedding_model による除外を検証する
// テストケースだけが別モデルを使う。Codex D0 MEDIUM 指摘の回帰観点)。
const EMBEDDING_MODEL = "text-embedding-3-small";
const DIFFERENT_EMBEDDING_MODEL = "text-embedding-3-large";

/**
 * 先頭 `head` 要素以降を 0 で埋めた 1536 次元の `VEC_FromText` 用リテラル文字列を作る。
 * 距離の大小関係は先頭2要素(cos/sin)だけで決まるため、残りは全ノート共通で 0 固定にする。
 */
function vectorLiteral(head: number[]): string {
  const values = [...head, ...new Array(EMBEDDING_DIMENSIONS - head.length).fill(0)];
  return `[${values.join(",")}]`;
}

/**
 * 単位円上の角度(度)から2次元ベクトル([cos, sin])を作る。原点からの角度が大きいほど
 * 基準ベクトル(角度0)との cosine 距離(= 1 - cosθ)が単調に大きくなるため、角度の大小で
 * 距離順を制御できる(θ∈[0°,180°] の範囲で cos は単調減少)。
 */
function unitVectorAtAngleDegrees(degrees: number): number[] {
  const radians = (degrees * Math.PI) / 180;
  return [Math.cos(radians), Math.sin(radians)];
}

interface SeedNoteInput {
  id: string;
  userId: string;
  title: string;
  vector: number[];
  deletedAt?: Date;
  // 既定は EMBEDDING_MODEL(全ノート共通)。異なるモデル間の除外を検証するケースのみ
  // 明示的に別の値を渡す。
  embeddingModel?: string;
  // 既定は "completed"(実運用では worker が embedding と enrichment_status='completed' を
  // 同一 UPDATE で原子的に書き込むため、embedding が存在する行は通常 completed)。
  // 候補ノート側の pending 除外(Codex 再レビュー MEDIUM 指摘)を検証するケースのみ
  // 明示的に "pending" を渡す。
  enrichmentStatus?: "pending" | "completed" | "failed";
}

/**
 * embedding 以外の列を drizzle 経由で insert した後、embedding のみ raw SQL の
 * `VEC_FromText` で書き込む(embedding は customType の設計上クエリビルダ経由で書けない。
 * packages/db/src/schema/notes.ts の embeddingVector 定義参照)。embedding_model は
 * 通常の varchar 列のため drizzle 経由の insert でそのまま書き込める。
 */
async function seedNoteWithEmbedding(db: Database, input: SeedNoteInput): Promise<void> {
  await db.insert(notes).values({
    id: input.id,
    userId: input.userId,
    type: "memo",
    title: input.title,
    body: "本文",
    summary: null,
    tags: [],
    concepts: [],
    deletedAt: input.deletedAt ?? null,
    embeddingModel: input.embeddingModel ?? EMBEDDING_MODEL,
    enrichmentStatus: input.enrichmentStatus ?? "completed",
  });
  await db.execute(sql`
    UPDATE notes SET embedding = VEC_FromText(${vectorLiteral(input.vector)}) WHERE id = ${input.id}
  `);
}

/**
 * embedding 未生成(NULL のまま)のノートを insert する。`enrichmentStatus` を省略すると
 * NULL のまま(M1-4a 以前の旧データを模す)になる。status マッピング(論点2)の
 * "generating" ケースを再現する場合は `enrichmentStatus: "pending"` を明示的に渡す
 * (実運用で NotesService.create が insert 時に書き込む値と同じ)。
 */
async function seedNoteWithoutEmbedding(
  db: Database,
  input: {
    id: string;
    userId: string;
    title: string;
    enrichmentStatus?: "pending" | "completed" | "failed";
  },
): Promise<void> {
  await db.insert(notes).values({
    id: input.id,
    userId: input.userId,
    type: "memo",
    title: input.title,
    body: "本文",
    summary: null,
    tags: [],
    concepts: [],
    enrichmentStatus: input.enrichmentStatus ?? null,
  });
}

describe("GET /notes/:id/related e2e(類似候補探索。M1-4a 計画 手順7)", () => {
  let app: INestApplication;
  let db: Database;
  let ownerId: string;
  let otherId: string;
  let ownerToken: string;
  let otherToken: string;

  let targetId: string;
  // 角度昇順 = 距離(1 - cosθ)昇順。5件までが期待される類似結果。
  let nearId: string;
  let near2Id: string;
  let near3Id: string;
  let near4Id: string;
  let near5Id: string;
  // 6番目に近い(= LIMIT 5 で除外されるべき)ノート。
  let sixthNearestId: string;
  // 本来は最も近い角度だが論理削除済みのため除外されるべきノート。
  let deletedNearestId: string;
  // 本来は全ノート中で最も近い角度だが、対象ノートと異なる embedding_model のため
  // 除外されるべきノート(Codex D0 MEDIUM 指摘の回帰観点。フィルタ欠落を必ず検知できるよう
  // 意図的に最も近い角度に配置する)。
  let differentModelNearestId: string;
  // 本来は全ノート中で最も近い角度だが、候補ノート側が enrichment_status='pending'(内容
  // 更新済みで再生成待ち=embedding が古い)のため除外されるべきノート(Codex 再レビュー
  // MEDIUM 指摘の回帰観点。フィルタ欠落を必ず検知できるよう意図的に最も近い角度に配置する)。
  let pendingCandidateNearestId: string;
  // embedding 未生成のため除外されるべきノート。
  let noEmbeddingId: string;
  // 他ユーザー所有・角度的には最も近いが、結果に混入してはならないノート(最重要観点)。
  let otherUserNearestId: string;
  // 対象ノート自体の embedding が未生成のケース用(enrichment_status が NULL の旧データを模す)。
  let targetWithoutEmbeddingId: string;
  // 対象ノート自体が enrichment 処理中(enrichment_status='pending')のケース用。
  // status: "ready" + 空配列(targetWithoutEmbeddingId)と status: "generating" + 空配列が
  // 区別されることを確認する(M1-4a 論点2 の主眼)。
  let generatingTargetId: string;
  // 対象ノート自体が enrichment_status='failed' かつ、生成失敗前(または失敗した再生成の前)に
  // 書き込まれた embedding が残存しているケース用。Codex 最終セキュリティ監査 MEDIUM 指摘
  // (ABA 問題)への対応により、failed の場合は類似検索自体を行わず空配列を返す(以前の
  // 「failed でも既存 embedding があれば返す」という仕様を覆した)。
  let failedTargetWithStaleEmbeddingId: string;

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

    targetId = randomUUID();
    await seedNoteWithEmbedding(db, {
      id: targetId,
      userId: ownerId,
      title: "対象ノート",
      vector: unitVectorAtAngleDegrees(0),
    });

    nearId = randomUUID();
    await seedNoteWithEmbedding(db, {
      id: nearId,
      userId: ownerId,
      title: "近い1",
      vector: unitVectorAtAngleDegrees(5),
    });
    near2Id = randomUUID();
    await seedNoteWithEmbedding(db, {
      id: near2Id,
      userId: ownerId,
      title: "近い2",
      vector: unitVectorAtAngleDegrees(15),
    });
    near3Id = randomUUID();
    await seedNoteWithEmbedding(db, {
      id: near3Id,
      userId: ownerId,
      title: "近い3",
      vector: unitVectorAtAngleDegrees(30),
    });
    near4Id = randomUUID();
    await seedNoteWithEmbedding(db, {
      id: near4Id,
      userId: ownerId,
      title: "近い4",
      vector: unitVectorAtAngleDegrees(60),
    });
    near5Id = randomUUID();
    await seedNoteWithEmbedding(db, {
      id: near5Id,
      userId: ownerId,
      title: "近い5",
      vector: unitVectorAtAngleDegrees(100),
    });
    sixthNearestId = randomUUID();
    await seedNoteWithEmbedding(db, {
      id: sixthNearestId,
      userId: ownerId,
      title: "6番目に近い(除外されるべき)",
      vector: unitVectorAtAngleDegrees(170),
    });

    deletedNearestId = randomUUID();
    await seedNoteWithEmbedding(db, {
      id: deletedNearestId,
      userId: ownerId,
      title: "論理削除済み(本来は最も近い)",
      vector: unitVectorAtAngleDegrees(1),
      deletedAt: new Date(),
    });

    differentModelNearestId = randomUUID();
    await seedNoteWithEmbedding(db, {
      id: differentModelNearestId,
      userId: ownerId,
      title: "異なるモデルの埋め込み(本来は最も近い)",
      vector: unitVectorAtAngleDegrees(0.1),
      embeddingModel: DIFFERENT_EMBEDDING_MODEL,
    });

    pendingCandidateNearestId = randomUUID();
    await seedNoteWithEmbedding(db, {
      id: pendingCandidateNearestId,
      userId: ownerId,
      title: "候補が enrichment 再生成待ち(本来は最も近い)",
      vector: unitVectorAtAngleDegrees(0.2),
      enrichmentStatus: "pending",
    });

    noEmbeddingId = randomUUID();
    await seedNoteWithoutEmbedding(db, {
      id: noEmbeddingId,
      userId: ownerId,
      title: "埋め込み未生成",
    });

    otherUserNearestId = randomUUID();
    await seedNoteWithEmbedding(db, {
      id: otherUserNearestId,
      userId: otherId,
      title: "他ユーザーの近いノート(本来は最も近い)",
      vector: unitVectorAtAngleDegrees(0.5),
    });

    targetWithoutEmbeddingId = randomUUID();
    await seedNoteWithoutEmbedding(db, {
      id: targetWithoutEmbeddingId,
      userId: ownerId,
      title: "対象自体が埋め込み未生成",
    });

    generatingTargetId = randomUUID();
    await seedNoteWithoutEmbedding(db, {
      id: generatingTargetId,
      userId: ownerId,
      title: "対象自体が enrichment 処理中",
      enrichmentStatus: "pending",
    });

    // 対象ノート自体は failed だが、embedding 列には(生成失敗前の)古いベクトルが残存して
    // いる状態を再現する。target が近傍(角度0)に位置するよう seed しているため、もし
    // (a)(b) の対処が効いていなければ nearId 等が similar に混入してしまう(この観点は
    // 下記テストで確認する)。
    failedTargetWithStaleEmbeddingId = randomUUID();
    await seedNoteWithEmbedding(db, {
      id: failedTargetWithStaleEmbeddingId,
      userId: ownerId,
      title: "対象自体が failed(embedding は残存)",
      vector: unitVectorAtAngleDegrees(0),
      enrichmentStatus: "failed",
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  it("距離昇順で最大5件を返し、6件目・論理削除済み・埋め込み未生成・自ノート・他ユーザーのノートを除外する(計画の受入条件4)", async () => {
    const response = await request(app.getHttpServer())
      .get(`/notes/${targetId}/related`)
      .set("Authorization", `Bearer ${ownerToken}`);

    expect(response.status).toBe(200);
    // 対象ノートは埋め込み生成済み(seedNoteWithEmbedding)なので status: ready を返す。
    expect(response.body.status).toBe("ready");
    const similar = response.body.similar as Array<{ id: string; distance: number }>;

    // 最大5件・距離昇順で近い順の5件がそのまま返る。
    expect(similar).toHaveLength(5);
    const expectedOrder = [nearId, near2Id, near3Id, near4Id, near5Id];
    expect(similar.map((item) => item.id)).toEqual(expectedOrder);

    const distances = similar.map((item) => item.distance);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));

    const returnedIds = similar.map((item) => item.id);
    // 自ノート除外
    expect(returnedIds).not.toContain(targetId);
    // LIMIT 5 による除外(6番目に近いノート)
    expect(returnedIds).not.toContain(sixthNearestId);
    // 論理削除済みノートの除外(本来は最も近い角度)
    expect(returnedIds).not.toContain(deletedNearestId);
    // 埋め込み未生成ノートの除外
    expect(returnedIds).not.toContain(noEmbeddingId);
    // user_id 分離(最重要観点。本来は最も近い角度だが他ユーザー所有のため混入してはならない)
    expect(returnedIds).not.toContain(otherUserNearestId);
    // 異なる embedding_model のノートの除外(本来は全ノート中で最も近い角度)
    expect(returnedIds).not.toContain(differentModelNearestId);
    // 候補ノート側が pending(再生成待ち=古い embedding)の除外(本来は全ノート中で最も近い角度。
    // Codex 再レビュー MEDIUM 指摘の回帰観点)
    expect(returnedIds).not.toContain(pendingCandidateNearestId);
  });

  it("embedding 本体はレスポンスに含まれない(D0 指摘[4]の回帰観点)", async () => {
    const response = await request(app.getHttpServer())
      .get(`/notes/${targetId}/related`)
      .set("Authorization", `Bearer ${ownerToken}`);

    expect(response.status).toBe(200);
    const similar = response.body.similar as Array<Record<string, unknown>>;
    expect(similar.length).toBeGreaterThan(0);
    for (const item of similar) {
      expect(item).not.toHaveProperty("embedding");
    }
  });

  it("対象ノートの embedding が未生成かつ enrichment_status が NULL(旧データ)の場合は status: ready + 空配列を返す(判別不能ケースは終端状態へ倒す。M1-4a 論点2)", async () => {
    const response = await request(app.getHttpServer())
      .get(`/notes/${targetWithoutEmbeddingId}/related`)
      .set("Authorization", `Bearer ${ownerToken}`);

    expect(response.status).toBe(200);
    // M1-4b §設計決定10: relationStatus/relations が追加された(エッジ未生成のため
    // relationStatus は「一度も判定されておらず投入予定も無い」= not_started、relations は
    // 空配列)。
    expect(response.body).toEqual({
      status: "ready",
      relationStatus: "not_started",
      relations: [],
      similar: [],
    });
  });

  it("対象ノートが enrichment 処理中(enrichment_status='pending')の場合は status: generating + 空配列を返し、ready + 空配列(上記ケース)と区別できる(M1-4a 論点2 の主眼)", async () => {
    const response = await request(app.getHttpServer())
      .get(`/notes/${generatingTargetId}/related`)
      .set("Authorization", `Bearer ${ownerToken}`);

    expect(response.status).toBe(200);
    // 規則1(status==='generating' → relationStatus も generating)。relations はエッジ未生成
    // のため空配列(M1-4b §設計決定10)。
    expect(response.body).toEqual({
      status: "generating",
      relationStatus: "generating",
      relations: [],
      similar: [],
    });
  });

  it("対象ノートが enrichment_status='failed' で古い embedding が残存していても、類似検索を行わず status: failed + 空配列を返す(Codex 最終セキュリティ監査 MEDIUM 指摘対応。ABA 問題対策)", async () => {
    const response = await request(app.getHttpServer())
      .get(`/notes/${failedTargetWithStaleEmbeddingId}/related`)
      .set("Authorization", `Bearer ${ownerToken}`);

    expect(response.status).toBe(200);
    // 規則2(status==='failed' → relationStatus も終端の failed)。relations はエッジ未生成の
    // ため空配列(M1-4b §設計決定10)。
    expect(response.body).toEqual({
      status: "failed",
      relationStatus: "failed",
      relations: [],
      similar: [],
    });
  });

  it("存在しない ID は 404 を返す", async () => {
    const response = await request(app.getHttpServer())
      .get(`/notes/${randomUUID()}/related`)
      .set("Authorization", `Bearer ${ownerToken}`);

    expect(response.status).toBe(404);
  });

  it("他ユーザー所有の ID は 404 を返す(既存の404方針。ID列挙防止)", async () => {
    const response = await request(app.getHttpServer())
      .get(`/notes/${targetId}/related`)
      .set("Authorization", `Bearer ${otherToken}`);

    expect(response.status).toBe(404);
  });
});
