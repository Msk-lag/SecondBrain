import { randomUUID } from "node:crypto";
import { Test, type TestingModule } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import request from "supertest";
import {
  notes,
  noteRelations,
  users,
  type Database,
  type NoteRelationType,
  type NoteRelationTypeDirection,
} from "@secondbrain/db";
import { AppModule } from "../src/app.module";
import { DRIZZLE } from "../src/db/db.module";

/**
 * `GET /graph`(知識ネットワーク全体取得。M2-1 参照)の e2e テスト。
 *
 * `graph.service.spec.ts` の単体テストは DB をモックしているため、SQL の WHERE 句自体が
 * 担保する制約(他ユーザー除外・論理削除除外・誘導部分グラフの端点フィルタ)を実データで
 * 検証できない。ここでは実際の MariaDB(`secondbrain_test_api`)へ接続して受入条件
 * 1・2・3・9・10・12 を実証する(`notes-related.e2e-spec.ts` と同じ流儀)。
 *
 * embedding は graph API が一切参照しないため `VEC_FromText` の投入は不要。
 *
 * **受入条件5(誘導部分グラフの順序。指摘[1]の回帰観点)はここでは実証しない**: 実証するには
 * `GRAPH_NODE_LIMIT`(300)を超える数のノートを実データで投入する必要があり e2e としては
 * 重すぎるため、計画の逃げ道(`.ai/plans/20260819-m2-knowledge-network/m2-1.md` 実装手順4の
 * 注記)に従い `graph.service.spec.ts`(モックでノード数 GRAPH_NODE_LIMIT+1 件の擬似データを
 * 用意し、切り詰め後のノード ID 集合のみがエッジ SQL の IN 句に現れることを SQL 文字列で
 * 検証)側で担保する。受入条件4(ノード上限超過時の切り詰め)・6(エッジ上限)も同様の理由で
 * `graph.service.spec.ts` 側の担保とする。
 */

interface SeedNoteInput {
  id: string;
  userId: string;
  title?: string | null;
  body?: string | null;
  deletedAt?: Date | null;
  status?: "pending" | "processing" | "completed" | "failed";
  enrichmentStatus?: "pending" | "completed" | "failed" | null;
  relationStatus?: "pending" | "completed" | "failed" | null;
  relationFingerprint?: string | null;
  embeddingFingerprint?: string | null;
}

async function seedNote(db: Database, input: SeedNoteInput): Promise<void> {
  await db.insert(notes).values({
    id: input.id,
    userId: input.userId,
    type: "memo",
    title: input.title ?? "タイトル",
    body: input.body === undefined ? "本文" : input.body,
    summary: null,
    tags: [],
    concepts: [],
    status: input.status ?? "completed",
    deletedAt: input.deletedAt ?? null,
    enrichmentStatus: input.enrichmentStatus ?? null,
    relationStatus: input.relationStatus ?? null,
    relationFingerprint: input.relationFingerprint ?? null,
    embeddingFingerprint: input.embeddingFingerprint ?? null,
  });
}

/** `note_a_id < note_b_id`(CHECK 制約)になるよう並べ替える。UUID は ASCII のみで構成
 * されるため JS の文字列比較と MariaDB の既定照合順序の大小関係は一致する
 * (`apps/worker` の `normalizeEndpoints` と同じ前提)。 */
function sortPair(idA: string, idB: string): [string, string] {
  return idA < idB ? [idA, idB] : [idB, idA];
}

/** 大小関係が既知の固定 UUID(修正3)。`00000000-...` 系は先頭が `0` のため必ず先頭が `f` の
 * `ffffffff-...` 系より文字列として小さくなり、`sortPair` 後にどちらが note_a_id/note_b_id に
 * なるかをテストごとに固定できる。`randomUUID()` のままだと無効な端点(論理削除済み・他ユーザー
 * 所有)が note_a_id/note_b_id のどちらに来るかが実行ごとに変わり、片側だけを絞り込む実装への
 * 退行を UUID の大小関係次第で見逃してしまう(§設計決定5の多重防御の回帰観点)。 */
function fixedLowId(suffix: string): string {
  return `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
}
function fixedHighId(suffix: string): string {
  return `ffffffff-0000-4000-8000-${suffix.padStart(12, "0")}`;
}

/** processingNoteCount(修正4)の条件別テスト用に、ノートを持たない新規ユーザーとその JWT を作る。
 * processingNoteCount はユーザー単位の集計であるため、条件ごとに独立したユーザーを使うことで
 * 正例と負例が同一集計に混ざって相殺されることを防ぐ。 */
async function createTestUser(
  db: Database,
  jwtService: JwtService,
): Promise<{ id: string; token: string }> {
  const id = randomUUID();
  await db
    .insert(users)
    .values({ id, email: `${id}@example.com`, passwordHash: "unused-in-this-test" });
  const token = await jwtService.signAsync({ sub: id, email: `${id}@example.com` });
  return { id, token };
}

interface SeedEdgeInput {
  id: string;
  userId: string;
  idA: string;
  idB: string;
  sourceNoteId?: string;
  relationType?: NoteRelationType;
  typeDirection?: NoteRelationTypeDirection;
  description?: string;
  relatedness?: string;
  deletedAt?: Date | null;
}

async function seedEdge(
  db: Database,
  input: SeedEdgeInput,
): Promise<{ noteAId: string; noteBId: string }> {
  const [noteAId, noteBId] = sortPair(input.idA, input.idB);
  await db.insert(noteRelations).values({
    id: input.id,
    userId: input.userId,
    noteAId,
    noteBId,
    sourceNoteId: input.sourceNoteId ?? noteAId,
    relationType: input.relationType ?? "same-theme",
    typeDirection: input.typeDirection ?? "none",
    description: input.description ?? "説明文",
    relatedness: input.relatedness ?? "0.50",
    noteAFingerprint: "fp-a",
    noteBFingerprint: "fp-b",
    deletedAt: input.deletedAt ?? null,
  });
  return { noteAId, noteBId };
}

interface GraphNodeBody {
  id: string;
  title: string | null;
  type: string;
  bodyPreview: string | null;
}

interface GraphEdgeBody {
  id: string;
  source: string;
  target: string;
  directed: boolean;
  relationType: string;
  description: string;
  relatedness: number;
}

interface GraphResponseBody {
  nodes: GraphNodeBody[];
  edges: GraphEdgeBody[];
  truncated: { nodes: boolean; edges: boolean };
  processingNoteCount: number;
}

describe("GET /graph e2e(知識ネットワーク全体取得。M2-1)", () => {
  let app: INestApplication;
  let db: Database;
  let ownerId: string;
  let otherId: string;
  let emptyUserId: string;
  let ownerToken: string;
  let otherToken: string;
  let emptyUserToken: string;

  // 向き正規化(§設計決定3)の3ケース。
  let aToBEdgeId: string;
  let aToBExpected: { source: string; target: string };
  let bToAEdgeId: string;
  let bToAExpected: { source: string; target: string };
  let noneEdgeId: string;
  let noneExpected: { source: string; target: string };

  // 除外系フィクスチャ(受入条件2)。
  let deletedEdgeNoteAId: string;
  let deletedEdgeNoteBId: string;
  let deletedEdgeId: string;
  let otherUserNote1Id: string;
  let otherUserNote2Id: string;
  let otherUserEdgeId: string;

  // 無効な端点配置の4ケース(修正3。§設計決定5の多重防御の回帰観点)。無効端点(論理削除済み/
  // 他ユーザー所有)が note_a_id 側・note_b_id 側のどちらに来るかを固定 UUID の大小関係で固定し、
  // 片側だけを絞り込む実装への退行を確実に検出する。
  let deletedAsNoteAEdgeId: string;
  let deletedAsNoteAId: string;
  let deletedAsNoteAPartnerId: string;
  let deletedAsNoteBEdgeId: string;
  let deletedAsNoteBId: string;
  let deletedAsNoteBPartnerId: string;
  let otherOwnerAsNoteAEdgeId: string;
  let otherOwnerAsNoteAId: string;
  let otherOwnerAsNoteAPartnerId: string;
  let otherOwnerAsNoteBEdgeId: string;
  let otherOwnerAsNoteBId: string;
  let otherOwnerAsNoteBPartnerId: string;

  // processingNoteCount(受入条件9)。ownerId 上の合算フィクスチャ(既存。複数該当の相殺検証を
  // 兼ねた副次的な確認として残す。主たる検証は下記の条件別独立ユーザーで行う)。
  let procAId: string; // (a) status pending
  let procBId: string; // (b) enrichment_status pending
  let procCId: string; // (c) relation_status pending
  let procDId: string; // (d) 内容更新後の再判定待ち
  let procMultiId: string; // (a)+(b) 複数該当
  let procTerminalId: string; // 終端(数えない)
  let procM14aId: string; // M1-4a 期(NULL/NULL。数えない)
  let procDeletedId: string; // 論理削除済み(数えない)
  let procOtherUserId: string; // 他ユーザー(数えない)

  // processingNoteCount(修正4)条件別の独立ユーザー。正例と負例が同一集計に混ざらないよう
  // 条件ごとに専用ユーザーを用意し、件数を個別に検証する(相殺の見逃し対策)。
  let procPendingToken: string; // (a) status='pending' のみ
  let procProcessingToken: string; // (a) status='processing' のみ(現状フィクスチャが無かった穴)
  let procEnrichPendingToken: string; // (b) enrichment_status='pending' のみ
  let procRelationPendingToken: string; // (c) relation_status='pending' のみ
  let procStaleToken: string; // (d) 内容更新後の再判定待ちのみ
  let procIsolatedMultiToken: string; // (a)+(b) 複数該当が二重計上されないことの単独検証
  let procIsolatedTerminalToken: string; // 終端行のみ(数えない)
  let procIsolatedM14aToken: string; // M1-4a 期(NULL/NULL)のみ(数えない)
  let procIsolatedDeletedToken: string; // 論理削除済みのみ(数えない)
  let procCrossQueryingToken: string; // 他ユーザーの pending ノートを持つが自身は0件

  // bodyPreview / relatedness(受入条件10)。
  let longBodyNoteId: string;
  const LONG_BODY = "あ".repeat(200);

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
    emptyUserId = randomUUID();
    await db.insert(users).values([
      { id: ownerId, email: `${ownerId}@example.com`, passwordHash: "unused-in-this-test" },
      { id: otherId, email: `${otherId}@example.com`, passwordHash: "unused-in-this-test" },
      { id: emptyUserId, email: `${emptyUserId}@example.com`, passwordHash: "unused-in-this-test" },
    ]);
    ownerToken = await jwtService.signAsync({ sub: ownerId, email: `${ownerId}@example.com` });
    otherToken = await jwtService.signAsync({ sub: otherId, email: `${otherId}@example.com` });
    emptyUserToken = await jwtService.signAsync({
      sub: emptyUserId,
      email: `${emptyUserId}@example.com`,
    });

    // --- 向き正規化の3ケース ---
    const dirA1 = randomUUID();
    const dirA2 = randomUUID();
    await seedNote(db, { id: dirA1, userId: ownerId, title: "a-to-b 端点1" });
    await seedNote(db, { id: dirA2, userId: ownerId, title: "a-to-b 端点2" });
    aToBEdgeId = randomUUID();
    const aToBPair = await seedEdge(db, {
      id: aToBEdgeId,
      userId: ownerId,
      idA: dirA1,
      idB: dirA2,
      relationType: "cause-solution",
      typeDirection: "a-to-b",
      relatedness: "0.90",
    });
    aToBExpected = { source: aToBPair.noteAId, target: aToBPair.noteBId };

    const dirB1 = randomUUID();
    const dirB2 = randomUUID();
    await seedNote(db, { id: dirB1, userId: ownerId, title: "b-to-a 端点1" });
    await seedNote(db, { id: dirB2, userId: ownerId, title: "b-to-a 端点2" });
    bToAEdgeId = randomUUID();
    const bToAPair = await seedEdge(db, {
      id: bToAEdgeId,
      userId: ownerId,
      idA: dirB1,
      idB: dirB2,
      relationType: "claim-counter",
      typeDirection: "b-to-a",
      relatedness: "0.60",
    });
    // b-to-a: 読みの左項(source)が note_b_id 側になる(§設計決定3の表・最重要観点)。
    bToAExpected = { source: bToAPair.noteBId, target: bToAPair.noteAId };

    const dirNone1 = randomUUID();
    const dirNone2 = randomUUID();
    await seedNote(db, { id: dirNone1, userId: ownerId, title: "none 端点1" });
    await seedNote(db, { id: dirNone2, userId: ownerId, title: "none 端点2" });
    noneEdgeId = randomUUID();
    const nonePair = await seedEdge(db, {
      id: noneEdgeId,
      userId: ownerId,
      idA: dirNone1,
      idB: dirNone2,
      relationType: "same-theme",
      typeDirection: "none",
      relatedness: "0.30",
    });
    noneExpected = { source: nonePair.noteAId, target: nonePair.noteBId };

    // --- 除外系フィクスチャ:論理削除済みノートを端点に持つエッジ(修正3) ---
    // ケース1: 無効端点(論理削除済み)が note_a_id 側に来るよう、有効な相方より小さい固定 UUID を使う。
    deletedAsNoteAId = fixedLowId("01");
    deletedAsNoteAPartnerId = fixedHighId("01");
    await seedNote(db, {
      id: deletedAsNoteAId,
      userId: ownerId,
      title: "論理削除済み(note_a_id側)",
      deletedAt: new Date(),
    });
    await seedNote(db, {
      id: deletedAsNoteAPartnerId,
      userId: ownerId,
      title: "論理削除ノートの相手(note_a_id側ケース)",
    });
    deletedAsNoteAEdgeId = randomUUID();
    const deletedAsNoteAPair = await seedEdge(db, {
      id: deletedAsNoteAEdgeId,
      userId: ownerId,
      idA: deletedAsNoteAId,
      idB: deletedAsNoteAPartnerId,
    });
    // フィクスチャの前提(無効端点が note_a_id 側)が崩れていないことを確認してからテスト本体へ進む。
    expect(deletedAsNoteAPair.noteAId).toBe(deletedAsNoteAId);

    // ケース2: 無効端点(論理削除済み)が note_b_id 側に来るよう、有効な相方より大きい固定 UUID を使う。
    deletedAsNoteBId = fixedHighId("02");
    deletedAsNoteBPartnerId = fixedLowId("02");
    await seedNote(db, {
      id: deletedAsNoteBId,
      userId: ownerId,
      title: "論理削除済み(note_b_id側)",
      deletedAt: new Date(),
    });
    await seedNote(db, {
      id: deletedAsNoteBPartnerId,
      userId: ownerId,
      title: "論理削除ノートの相手(note_b_id側ケース)",
    });
    deletedAsNoteBEdgeId = randomUUID();
    const deletedAsNoteBPair = await seedEdge(db, {
      id: deletedAsNoteBEdgeId,
      userId: ownerId,
      idA: deletedAsNoteBId,
      idB: deletedAsNoteBPartnerId,
    });
    expect(deletedAsNoteBPair.noteBId).toBe(deletedAsNoteBId);

    deletedEdgeNoteAId = randomUUID();
    deletedEdgeNoteBId = randomUUID();
    await seedNote(db, { id: deletedEdgeNoteAId, userId: ownerId, title: "削除エッジの端点1" });
    await seedNote(db, { id: deletedEdgeNoteBId, userId: ownerId, title: "削除エッジの端点2" });
    deletedEdgeId = randomUUID();
    await seedEdge(db, {
      id: deletedEdgeId,
      userId: ownerId,
      idA: deletedEdgeNoteAId,
      idB: deletedEdgeNoteBId,
      deletedAt: new Date(),
    });

    otherUserNote1Id = randomUUID();
    otherUserNote2Id = randomUUID();
    await seedNote(db, { id: otherUserNote1Id, userId: otherId, title: "他ユーザー1" });
    await seedNote(db, { id: otherUserNote2Id, userId: otherId, title: "他ユーザー2" });
    otherUserEdgeId = randomUUID();
    await seedEdge(db, {
      id: otherUserEdgeId,
      userId: otherId,
      idA: otherUserNote1Id,
      idB: otherUserNote2Id,
    });

    // --- 除外系フィクスチャ:所有者不一致(nr.user_id は owner だが端点の一方が他ユーザー所有。
    // 修正3) --- (§設計決定5「認可の多重防御」の回帰観点。ノード ID 集合自体がユーザー一致で
    // 絞り込み済みのため、このエッジは誘導部分グラフの外側に落ちて自然に除外される)。
    // ケース3: 無効端点(他ユーザー所有)が note_a_id 側に来るケース。
    otherOwnerAsNoteAId = fixedLowId("03");
    otherOwnerAsNoteAPartnerId = fixedHighId("03");
    await seedNote(db, {
      id: otherOwnerAsNoteAId,
      userId: otherId,
      title: "不整合エッジのother側(note_a_id側ケース)",
    });
    await seedNote(db, {
      id: otherOwnerAsNoteAPartnerId,
      userId: ownerId,
      title: "不整合エッジのowner側(note_a_id側ケース)",
    });
    otherOwnerAsNoteAEdgeId = randomUUID();
    const otherOwnerAsNoteAPair = await seedEdge(db, {
      id: otherOwnerAsNoteAEdgeId,
      userId: ownerId,
      idA: otherOwnerAsNoteAId,
      idB: otherOwnerAsNoteAPartnerId,
    });
    expect(otherOwnerAsNoteAPair.noteAId).toBe(otherOwnerAsNoteAId);

    // ケース4: 無効端点(他ユーザー所有)が note_b_id 側に来るケース。
    otherOwnerAsNoteBId = fixedHighId("04");
    otherOwnerAsNoteBPartnerId = fixedLowId("04");
    await seedNote(db, {
      id: otherOwnerAsNoteBId,
      userId: otherId,
      title: "不整合エッジのother側(note_b_id側ケース)",
    });
    await seedNote(db, {
      id: otherOwnerAsNoteBPartnerId,
      userId: ownerId,
      title: "不整合エッジのowner側(note_b_id側ケース)",
    });
    otherOwnerAsNoteBEdgeId = randomUUID();
    const otherOwnerAsNoteBPair = await seedEdge(db, {
      id: otherOwnerAsNoteBEdgeId,
      userId: ownerId,
      idA: otherOwnerAsNoteBId,
      idB: otherOwnerAsNoteBPartnerId,
    });
    expect(otherOwnerAsNoteBPair.noteBId).toBe(otherOwnerAsNoteBId);

    // --- processingNoteCount(§設計決定6の4条件) ---
    procAId = randomUUID();
    await seedNote(db, { id: procAId, userId: ownerId, title: "processing(a)", status: "pending" });

    procBId = randomUUID();
    await seedNote(db, {
      id: procBId,
      userId: ownerId,
      title: "processing(b)",
      enrichmentStatus: "pending",
    });

    procCId = randomUUID();
    await seedNote(db, {
      id: procCId,
      userId: ownerId,
      title: "processing(c)",
      relationStatus: "pending",
      relationFingerprint: "rf-c",
    });

    procDId = randomUUID();
    await seedNote(db, {
      id: procDId,
      userId: ownerId,
      title: "processing(d)",
      enrichmentStatus: "completed",
      embeddingFingerprint: "ef-d",
      relationStatus: "completed",
      relationFingerprint: "rf-d-old",
    });

    procMultiId = randomUUID();
    await seedNote(db, {
      id: procMultiId,
      userId: ownerId,
      title: "processing(a)+(b) 複数該当",
      status: "pending",
      enrichmentStatus: "pending",
    });

    procTerminalId = randomUUID();
    await seedNote(db, {
      id: procTerminalId,
      userId: ownerId,
      title: "終端(数えない)",
      enrichmentStatus: "completed",
      relationStatus: "completed",
      embeddingFingerprint: "ef-terminal",
      relationFingerprint: "ef-terminal",
    });

    procM14aId = randomUUID();
    await seedNote(db, {
      id: procM14aId,
      userId: ownerId,
      title: "M1-4a期(数えない)",
      enrichmentStatus: "completed",
      embeddingFingerprint: "ef-m14a",
      relationStatus: null,
      relationFingerprint: null,
    });

    procDeletedId = randomUUID();
    await seedNote(db, {
      id: procDeletedId,
      userId: ownerId,
      title: "論理削除済み(数えない)",
      status: "pending",
      deletedAt: new Date(),
    });

    procOtherUserId = randomUUID();
    await seedNote(db, {
      id: procOtherUserId,
      userId: otherId,
      title: "他ユーザー(数えない)",
      status: "pending",
    });

    // --- processingNoteCount(修正4): 条件別の独立ユーザー ---
    // 正例と負例の相殺を防ぐため条件ごとに専用ユーザーを用意し、そのユーザーには対象ノート
    // 1件のみを投入する(「取りこぼしと過剰計上が相殺される実装」を検出できるようにする)。
    const procPendingUser = await createTestUser(db, jwtService);
    procPendingToken = procPendingUser.token;
    await seedNote(db, {
      id: randomUUID(),
      userId: procPendingUser.id,
      title: "isolated(a) status=pending",
      status: "pending",
    });

    // (a) status='processing' の正例(既存フィクスチャに無かった穴。'pending' のみを扱う退行を検出する)。
    const procProcessingUser = await createTestUser(db, jwtService);
    procProcessingToken = procProcessingUser.token;
    await seedNote(db, {
      id: randomUUID(),
      userId: procProcessingUser.id,
      title: "isolated(a) status=processing",
      status: "processing",
    });

    const procEnrichPendingUser = await createTestUser(db, jwtService);
    procEnrichPendingToken = procEnrichPendingUser.token;
    await seedNote(db, {
      id: randomUUID(),
      userId: procEnrichPendingUser.id,
      title: "isolated(b) enrichment_status=pending",
      enrichmentStatus: "pending",
    });

    const procRelationPendingUser = await createTestUser(db, jwtService);
    procRelationPendingToken = procRelationPendingUser.token;
    await seedNote(db, {
      id: randomUUID(),
      userId: procRelationPendingUser.id,
      title: "isolated(c) relation_status=pending",
      relationStatus: "pending",
    });

    const procStaleUser = await createTestUser(db, jwtService);
    procStaleToken = procStaleUser.token;
    await seedNote(db, {
      id: randomUUID(),
      userId: procStaleUser.id,
      title: "isolated(d) 内容更新後の再判定待ち",
      enrichmentStatus: "completed",
      embeddingFingerprint: "ef-isolated-d",
      relationStatus: "completed",
      relationFingerprint: "rf-isolated-d-old",
    });

    // (a)+(b) に同時該当する行が COUNT(*) により1件のまま(2件に二重計上されない)ことの検証用。
    const procIsolatedMultiUser = await createTestUser(db, jwtService);
    procIsolatedMultiToken = procIsolatedMultiUser.token;
    await seedNote(db, {
      id: randomUUID(),
      userId: procIsolatedMultiUser.id,
      title: "isolated(a)+(b) 複数該当",
      status: "pending",
      enrichmentStatus: "pending",
    });

    // 終端行(数えない負例)。
    const procIsolatedTerminalUser = await createTestUser(db, jwtService);
    procIsolatedTerminalToken = procIsolatedTerminalUser.token;
    await seedNote(db, {
      id: randomUUID(),
      userId: procIsolatedTerminalUser.id,
      title: "isolated終端(数えない)",
      enrichmentStatus: "completed",
      relationStatus: "completed",
      embeddingFingerprint: "ef-isolated-terminal",
      relationFingerprint: "ef-isolated-terminal",
    });

    // M1-4a 期(relation_status・relation_fingerprint とも NULL。数えない負例)。
    const procIsolatedM14aUser = await createTestUser(db, jwtService);
    procIsolatedM14aToken = procIsolatedM14aUser.token;
    await seedNote(db, {
      id: randomUUID(),
      userId: procIsolatedM14aUser.id,
      title: "isolatedM1-4a期(数えない)",
      enrichmentStatus: "completed",
      embeddingFingerprint: "ef-isolated-m14a",
      relationStatus: null,
      relationFingerprint: null,
    });

    // 論理削除済み(status='pending' でも deleted_at IS NULL で除外される。数えない負例)。
    const procIsolatedDeletedUser = await createTestUser(db, jwtService);
    procIsolatedDeletedToken = procIsolatedDeletedUser.token;
    await seedNote(db, {
      id: randomUUID(),
      userId: procIsolatedDeletedUser.id,
      title: "isolated論理削除済み(数えない)",
      status: "pending",
      deletedAt: new Date(),
    });

    // 他ユーザーの pending ノートは、問い合わせる側のユーザーの集計に混入しない
    // (ユーザー単位の集計であることの回帰観点。数えない負例)。
    const procCrossOtherUser = await createTestUser(db, jwtService);
    await seedNote(db, {
      id: randomUUID(),
      userId: procCrossOtherUser.id,
      title: "isolated他ユーザーのpending(数えない)",
      status: "pending",
    });
    const procCrossQueryingUser = await createTestUser(db, jwtService);
    procCrossQueryingToken = procCrossQueryingUser.token;

    // --- bodyPreview / relatedness ---
    longBodyNoteId = randomUUID();
    await seedNote(db, { id: longBodyNoteId, userId: ownerId, title: "長い本文", body: LONG_BODY });
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  it("未認証(Authorization ヘッダー無し)では 401", async () => {
    const response = await request(app.getHttpServer()).get("/graph");
    expect(response.status).toBe(401);
  });

  it("他ユーザーのノート・エッジ、論理削除済みノート・その端点のエッジ、論理削除済みエッジ、認可の不整合データを除外する(受入条件2)", async () => {
    const response = await request(app.getHttpServer())
      .get("/graph")
      .set("Authorization", `Bearer ${ownerToken}`);

    expect(response.status).toBe(200);
    const body = response.body as GraphResponseBody;
    const nodeIds = body.nodes.map((node) => node.id);
    const edgeIds = body.edges.map((edge) => edge.id);

    // 他ユーザーのノート・エッジは一切含まれない(最重要観点)。
    expect(nodeIds).not.toContain(otherUserNote1Id);
    expect(nodeIds).not.toContain(otherUserNote2Id);
    expect(edgeIds).not.toContain(otherUserEdgeId);

    // 論理削除済みノートを端点に持つエッジは、無効端点が note_a_id 側・note_b_id 側の
    // どちらでも現れない(修正3。片側だけを絞り込む実装への退行をケースごとに個別検出する)。
    expect(nodeIds).not.toContain(deletedAsNoteAId);
    expect(edgeIds).not.toContain(deletedAsNoteAEdgeId);
    // 削除されていない側の相手ノートはノードとして現れる(エッジのみが欠落する)。
    expect(nodeIds).toContain(deletedAsNoteAPartnerId);
    expect(nodeIds).not.toContain(deletedAsNoteBId);
    expect(edgeIds).not.toContain(deletedAsNoteBEdgeId);
    expect(nodeIds).toContain(deletedAsNoteBPartnerId);

    // エッジ自身が論理削除済みの場合、両端が有効ノートでもエッジは現れない。
    expect(edgeIds).not.toContain(deletedEdgeId);
    expect(nodeIds).toContain(deletedEdgeNoteAId);
    expect(nodeIds).toContain(deletedEdgeNoteBId);

    // nr.user_id は owner 一致だが端点の一方が他ユーザー所有、という不整合データは、無効端点が
    // note_a_id 側・note_b_id 側のどちらでも除外される(誘導部分グラフの外側に落ちるため。
    // §設計決定5。修正3)。
    expect(edgeIds).not.toContain(otherOwnerAsNoteAEdgeId);
    expect(edgeIds).not.toContain(otherOwnerAsNoteBEdgeId);

    // 正常な向き正規化用フィクスチャは通常どおり現れる。
    expect(edgeIds).toContain(aToBEdgeId);
    expect(edgeIds).toContain(bToAEdgeId);
    expect(edgeIds).toContain(noneEdgeId);
  });

  it("他ユーザーの視点でも owner のノート・エッジ・不整合エッジは一切見えない", async () => {
    const response = await request(app.getHttpServer())
      .get("/graph")
      .set("Authorization", `Bearer ${otherToken}`);

    expect(response.status).toBe(200);
    const body = response.body as GraphResponseBody;
    const nodeIds = body.nodes.map((node) => node.id);
    const edgeIds = body.edges.map((edge) => edge.id);

    // owner のノート・エッジは他ユーザー(other)の視点には一切現れない。
    expect(edgeIds).not.toContain(aToBEdgeId);
    expect(edgeIds).not.toContain(bToAEdgeId);
    expect(edgeIds).not.toContain(noneEdgeId);
    expect(edgeIds).not.toContain(otherOwnerAsNoteAEdgeId);
    expect(edgeIds).not.toContain(otherOwnerAsNoteBEdgeId);
    // other 自身のノート・エッジは通常どおり見える(除外条件が過剰に効いていないことの確認)。
    expect(nodeIds).toContain(otherUserNote1Id);
    expect(edgeIds).toContain(otherUserEdgeId);
  });

  it("type_direction の3値が§設計決定3の表どおり変換される。特にb-to-aでsourceがnote_b_idになる(受入条件3)", async () => {
    const response = await request(app.getHttpServer())
      .get("/graph")
      .set("Authorization", `Bearer ${ownerToken}`);

    expect(response.status).toBe(200);
    const body = response.body as GraphResponseBody;

    const aToBEdge = body.edges.find((edge) => edge.id === aToBEdgeId);
    expect(aToBEdge).toMatchObject({
      source: aToBExpected.source,
      target: aToBExpected.target,
      directed: true,
    });

    const bToAEdge = body.edges.find((edge) => edge.id === bToAEdgeId);
    expect(bToAEdge).toMatchObject({
      source: bToAExpected.source,
      target: bToAExpected.target,
      directed: true,
    });

    const noneEdge = body.edges.find((edge) => edge.id === noneEdgeId);
    expect(noneEdge).toMatchObject({
      source: noneExpected.source,
      target: noneExpected.target,
      directed: false,
    });
  });

  it("processingNoteCount が§設計決定6の4条件に一致する未削除ノート数と一致し、M1-4a期(NULL/NULL)の行・論理削除済み・他ユーザーを数えない(受入条件9。合算ケース。副次的な確認 — 主たる検証は下記の条件別独立ユーザーのテスト)", async () => {
    const response = await request(app.getHttpServer())
      .get("/graph")
      .set("Authorization", `Bearer ${ownerToken}`);

    expect(response.status).toBe(200);
    const body = response.body as GraphResponseBody;
    // (a)procA・(b)procB・(c)procC・(d)procD・(a)+(b)複数該当のprocMulti の5件のみが該当する。
    // procTerminal(終端)・procM14a(NULL/NULL)・procDeleted(論理削除済み)・procOtherUser
    // (他ユーザー)はいずれも数えない。
    expect(body.processingNoteCount).toBe(5);
  });

  // --- processingNoteCount 条件別の独立検証(修正4)。取りこぼしと過剰計上が相殺される実装は
  // 上の合算ケースだけでは検出できないため、条件ごとに専用ユーザー(対象ノート1件のみ)で
  // 個別に検証する。 ---

  it("(a) status='pending' のノート1件のみを持つユーザーは processingNoteCount が1になる(受入条件9・条件(a)の正例)", async () => {
    const response = await request(app.getHttpServer())
      .get("/graph")
      .set("Authorization", `Bearer ${procPendingToken}`);

    expect(response.status).toBe(200);
    expect((response.body as GraphResponseBody).processingNoteCount).toBe(1);
  });

  it("(a) status='processing' のノート1件のみを持つユーザーは processingNoteCount が1になる(受入条件9・条件(a)。'pending' のみを数える実装への退行を検出する)", async () => {
    const response = await request(app.getHttpServer())
      .get("/graph")
      .set("Authorization", `Bearer ${procProcessingToken}`);

    expect(response.status).toBe(200);
    expect((response.body as GraphResponseBody).processingNoteCount).toBe(1);
  });

  it("(b) enrichment_status='pending' のノート1件のみを持つユーザーは processingNoteCount が1になる(受入条件9・条件(b)の正例)", async () => {
    const response = await request(app.getHttpServer())
      .get("/graph")
      .set("Authorization", `Bearer ${procEnrichPendingToken}`);

    expect(response.status).toBe(200);
    expect((response.body as GraphResponseBody).processingNoteCount).toBe(1);
  });

  it("(c) relation_status='pending' のノート1件のみを持つユーザーは processingNoteCount が1になる(受入条件9・条件(c)の正例)", async () => {
    const response = await request(app.getHttpServer())
      .get("/graph")
      .set("Authorization", `Bearer ${procRelationPendingToken}`);

    expect(response.status).toBe(200);
    expect((response.body as GraphResponseBody).processingNoteCount).toBe(1);
  });

  it("(d) enrichment_status='completed' かつ relation_fingerprint が embedding_fingerprint と異なるノート1件のみを持つユーザーは processingNoteCount が1になる(受入条件9・条件(d)の正例)", async () => {
    const response = await request(app.getHttpServer())
      .get("/graph")
      .set("Authorization", `Bearer ${procStaleToken}`);

    expect(response.status).toBe(200);
    expect((response.body as GraphResponseBody).processingNoteCount).toBe(1);
  });

  it("(a)+(b) に同時該当するノート1件のみを持つユーザーは processingNoteCount が1のまま(2件に二重計上されない。COUNT(*) の回帰観点)", async () => {
    const response = await request(app.getHttpServer())
      .get("/graph")
      .set("Authorization", `Bearer ${procIsolatedMultiToken}`);

    expect(response.status).toBe(200);
    expect((response.body as GraphResponseBody).processingNoteCount).toBe(1);
  });

  it("終端行(status/enrichment_status/relation_status すべて完了・fingerprint一致)のみを持つユーザーは processingNoteCount が0になる(負例)", async () => {
    const response = await request(app.getHttpServer())
      .get("/graph")
      .set("Authorization", `Bearer ${procIsolatedTerminalToken}`);

    expect(response.status).toBe(200);
    expect((response.body as GraphResponseBody).processingNoteCount).toBe(0);
  });

  it("relation_status・relation_fingerprint とも NULL の行(M1-4a期の既存ノート)のみを持つユーザーは processingNoteCount が0になる(負例)", async () => {
    const response = await request(app.getHttpServer())
      .get("/graph")
      .set("Authorization", `Bearer ${procIsolatedM14aToken}`);

    expect(response.status).toBe(200);
    expect((response.body as GraphResponseBody).processingNoteCount).toBe(0);
  });

  it("論理削除済みのノート(status='pending')のみを持つユーザーは processingNoteCount が0になる(負例。deleted_at IS NULL の絞り込みの回帰観点)", async () => {
    const response = await request(app.getHttpServer())
      .get("/graph")
      .set("Authorization", `Bearer ${procIsolatedDeletedToken}`);

    expect(response.status).toBe(200);
    expect((response.body as GraphResponseBody).processingNoteCount).toBe(0);
  });

  it("他ユーザーの pending ノートは自身の processingNoteCount に混入しない(負例。ユーザー単位集計の回帰観点)", async () => {
    const response = await request(app.getHttpServer())
      .get("/graph")
      .set("Authorization", `Bearer ${procCrossQueryingToken}`);

    expect(response.status).toBe(200);
    expect((response.body as GraphResponseBody).processingNoteCount).toBe(0);
  });

  it("relatedness が数値として返り、bodyPreview が120文字以内に切り詰められる(受入条件10)", async () => {
    const response = await request(app.getHttpServer())
      .get("/graph")
      .set("Authorization", `Bearer ${ownerToken}`);

    expect(response.status).toBe(200);
    const body = response.body as GraphResponseBody;

    const aToBEdge = body.edges.find((edge) => edge.id === aToBEdgeId);
    expect(typeof aToBEdge?.relatedness).toBe("number");
    expect(aToBEdge?.relatedness).toBe(0.9);

    const longBodyNode = body.nodes.find((node) => node.id === longBodyNoteId);
    expect(longBodyNode?.bodyPreview).not.toBeNull();
    expect(longBodyNode?.bodyPreview?.length).toBeLessThanOrEqual(120);
    expect(longBodyNode?.bodyPreview).toBe(LONG_BODY.slice(0, 120));
  });

  it("レスポンスに embedding プロパティが現れない(受入条件11のe2e側担保)", async () => {
    const response = await request(app.getHttpServer())
      .get("/graph")
      .set("Authorization", `Bearer ${ownerToken}`);

    expect(response.status).toBe(200);
    const body = response.body as GraphResponseBody;
    for (const node of body.nodes) {
      expect(node).not.toHaveProperty("embedding");
    }
    for (const edge of body.edges) {
      expect(edge).not.toHaveProperty("embedding");
    }
  });

  it("ノート0件・エッジ0件のユーザーで空配列とprocessingNoteCount:0が返り例外にならない(受入条件12)", async () => {
    const response = await request(app.getHttpServer())
      .get("/graph")
      .set("Authorization", `Bearer ${emptyUserToken}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      nodes: [],
      edges: [],
      truncated: { nodes: false, edges: false },
      processingNoteCount: 0,
    });
  });
});
