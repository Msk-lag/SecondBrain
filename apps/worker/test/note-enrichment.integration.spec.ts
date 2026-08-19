import { randomUUID } from "node:crypto";
import { Test, type TestingModule } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { getQueueToken } from "@nestjs/bullmq";
import type { Job, Queue } from "bullmq";
import {
  and,
  eq,
  notes,
  noteRelations,
  sql,
  users,
  type Database,
  type NoteRelation,
} from "@secondbrain/db";
import {
  noteEnrichmentJobId,
  NOTE_ENRICHMENT_QUEUE_NAME,
  type NoteEnrichmentJobPayload,
} from "@secondbrain/shared";
import { AppModule } from "../src/app.module";
import { DRIZZLE } from "../src/db/db.module";
import {
  CLAUDE_VISION_CLIENT,
  type ClaudeVisionClient,
} from "../src/queues/screenshot-analysis/claude-vision.client";
import { ScreenshotAnalysisProcessor } from "../src/queues/screenshot-analysis/screenshot-analysis.processor";
import { NoteStuckRequeueProcessor } from "../src/queues/note-stuck-requeue/note-stuck-requeue.processor";
import { NotePurgeProcessor } from "../src/queues/note-purge/note-purge.processor";
import {
  OPENAI_EMBEDDING_CLIENT_FACTORY,
  OPENAI_EMBEDDING_MODEL,
  type OpenAiEmbeddingClient,
  type OpenAiEmbeddingClientFactory,
} from "../src/queues/note-enrichment/openai-embedding.client";
import { buildEmbeddingInputText } from "../src/queues/note-enrichment/note-enrichment-fingerprint";
import {
  RELATION_JUDGE_CLIENT,
  type RelationJudgeClient,
  type RelationJudgeResultItem,
} from "../src/queues/note-enrichment/relation-judge.client";
import { NoteEnrichmentProcessor } from "../src/queues/note-enrichment/note-enrichment.processor";
import { NoteEnrichmentRequeueProcessor } from "../src/queues/note-enrichment-requeue/note-enrichment-requeue.processor";

const EMBEDDING_DIMENSIONS = 1536;

/**
 * HTTP を介さず、`@nestjs/testing` で apps/worker の実際の DI 構成(`AppModule` をそのまま
 * 起動する)を組み立て、外部送信を伴うクライアントのみスタブに差し替えるジョブ処理ロジックの
 * 統合テスト(screenshot-analysis.integration.spec.ts と同じパターン)。`AppModule` は
 * `ScreenshotAnalysisModule`(→ `CLAUDE_VISION_CLIENT`)を常に組み込むため、このファイルの
 * 対象が note-enrichment であっても `CLAUDE_VISION_CLIENT` のオーバーライドが必要
 * (`ANTHROPIC_API_KEY` 未設定でも `createClaudeVisionClientFromEnv` の起動時 fail-fast を
 * 回避するため)。
 *
 * `OPENAI_EMBEDDING_CLIENT_FACTORY` は `useValue`(関数そのもの)で登録されているため、
 * オーバーライドも同様に「呼び出すとスタブクライアントを返す関数」を渡す(実 OpenAI API は
 * 一切呼び出さない)。
 *
 * `RELATION_JUDGE_CLIENT`(M1-4b §設計決定9)も `CLAUDE_VISION_CLIENT` と同じく `useFactory`
 * (`createRelationJudgeClientFromEnv`)で登録されており、オーバーライドしないと
 * `app.init()` 時点で `ANTHROPIC_API_KEY` 未設定により起動が失敗する。本ファイルは
 * note-enrichment(embedding 書き戻し)のロジックを対象とし、関係判定ステージ自体の
 * 振る舞い(候補0件・エッジ upsert・rollback 等)の検証は別ファイルで行う想定のため、
 * ここでは「常に空配列を返す(=候補があっても related=false 扱い)」スタブに差し替えるに
 * 留める。
 */
function makeEnrichmentJob(overrides: {
  noteId: string;
  attemptsMade?: number;
  attempts?: number;
}): Job<NoteEnrichmentJobPayload> {
  return {
    data: { noteId: overrides.noteId },
    attemptsMade: overrides.attemptsMade ?? 0,
    opts: { attempts: overrides.attempts ?? 3 },
  } as unknown as Job<NoteEnrichmentJobPayload>;
}

interface RawEnrichmentRow {
  title: string | null;
  embedding_is_null: number | boolean;
  embedding_model: string | null;
  embedding_fingerprint: string | null;
  enrichment_status: "pending" | "completed" | "failed" | null;
  updated_at: Date;
}

describe("note-enrichment 統合テスト(ジョブ処理ロジック)", () => {
  let app: INestApplication;
  let db: Database;
  let claudeStub: { analyze: ReturnType<typeof vi.fn> };
  let embedMock: ReturnType<typeof vi.fn>;
  let relationJudgeMock: ReturnType<typeof vi.fn>;
  let ownerId: string;
  let noteEnrichmentProcessor: NoteEnrichmentProcessor;
  let noteEnrichmentRequeueProcessor: NoteEnrichmentRequeueProcessor;
  let screenshotAnalysisProcessor: ScreenshotAnalysisProcessor;
  let noteStuckRequeueProcessor: NoteStuckRequeueProcessor;
  let notePurgeProcessor: NotePurgeProcessor;
  let noteEnrichmentQueue: Queue;
  // `Queue.pause()` は Redis 上にキューの停止状態を永続化するため、テスト終了時に必ず
  // `resume()` で復帰させる必要がある(Codex 再レビュー HIGH 指摘対応)。セットアップ途中で
  // `pause()` 自体が失敗した場合は resume を呼ばない(そもそも停止していないため)よう、
  // 実際に pause が成功した場合のみこのフラグを立てる。
  let noteEnrichmentQueuePaused = false;

  beforeAll(async () => {
    claudeStub = { analyze: vi.fn() };
    embedMock = vi.fn();
    const embeddingClientFactoryStub: OpenAiEmbeddingClientFactory = () =>
      ({ embed: embedMock }) as unknown as OpenAiEmbeddingClient;
    relationJudgeMock = vi.fn().mockResolvedValue([]);
    const relationJudgeStub: RelationJudgeClient = { judge: relationJudgeMock };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(CLAUDE_VISION_CLIENT)
      .useValue(claudeStub as unknown as ClaudeVisionClient)
      .overrideProvider(OPENAI_EMBEDDING_CLIENT_FACTORY)
      .useValue(embeddingClientFactoryStub)
      .overrideProvider(RELATION_JUDGE_CLIENT)
      .useValue(relationJudgeStub)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    db = app.get(DRIZZLE);
    noteEnrichmentProcessor = app.get(NoteEnrichmentProcessor);
    noteEnrichmentRequeueProcessor = app.get(NoteEnrichmentRequeueProcessor);
    screenshotAnalysisProcessor = app.get(ScreenshotAnalysisProcessor);
    noteStuckRequeueProcessor = app.get(NoteStuckRequeueProcessor);
    notePurgeProcessor = app.get(NotePurgeProcessor);
    noteEnrichmentQueue = app.get<Queue>(getQueueToken(NOTE_ENRICHMENT_QUEUE_NAME));

    // 各 Worker のバックグラウンド消費を止める(本テストは processor.process() の直接呼び出しで
    // 制御する。screenshot-analysis.integration.spec.ts と同じ理由・同じ二段構え
    // 〔Worker.pause() + Queue.pause()〕で、pause 呼び出し時点で既に blocking pop 待機に
    // 入っている場合の取りこぼしを防ぐ)。
    await noteEnrichmentProcessor.worker.pause(true);
    await noteEnrichmentRequeueProcessor.worker.pause(true);
    await screenshotAnalysisProcessor.worker.pause(true);
    await noteStuckRequeueProcessor.worker.pause(true);
    await notePurgeProcessor.worker.pause(true);
    await noteEnrichmentQueue.pause();
    noteEnrichmentQueuePaused = true;

    ownerId = randomUUID();
    await db.insert(users).values({
      id: ownerId,
      email: `${ownerId}@example.com`,
      passwordHash: "unused-in-this-test",
    });
  }, 60_000);

  afterAll(async () => {
    // `noteEnrichmentQueue.pause()` は Redis 上に停止状態を永続化するため、`app.close()` の
    // 前に必ず `resume()` で復帰させる(同じ Redis を共有する後続テスト・プロセスがジョブを
    // 処理できなくなるのを防ぐ。Codex 再レビュー HIGH 指摘対応)。`resume()` 自体が失敗しても
    // `app.close()` は必ず実行する(try/finally)。
    //
    // 加えて、回収バッチ・二重投入防止のテストがキューに残した待機ジョブを、`resume()` の
    // 前に必ず取り除く(Codex 再レビュー HIGH 指摘対応: 前回修正で「停止したまま放置」は
    // 直ったが、「ジョブを残したまま再開」という新たな問題が生じていた。ジョブが残ったまま
    // 再開すると、同じ Redis を共有する後続テスト・別プロセスの Worker がそれを処理してしまい
    // テスト用ノートの更新・外部 API 呼び出し・テスト間の不安定性を引き起こす)。
    // `drain(true)` は wait/paused/delayed のジョブのみを一括削除する(BullMQ の仕様上
    // active/completed/failed には影響しない)。本テストは `beforeAll` で Worker・Queue の
    // 双方を一時停止しているため active なジョブは存在せず、対象キュー全体を空にしても
    // 安全である。`drain()` 自体が失敗しても `resume()`・`app.close()` は必ず実行する
    // (入れ子の try/finally)。
    try {
      if (noteEnrichmentQueuePaused) {
        try {
          await noteEnrichmentQueue.drain(true);
        } finally {
          await noteEnrichmentQueue.resume();
        }
      }
    } finally {
      await app.close();
    }
  });

  beforeEach(() => {
    // claudeStub/embedMock は describe 全体で使い回すため、前のテストの呼び出し履歴・
    // mockImplementationOnce/mockResolvedValueOnce のキューが残らないよう毎回リセットする。
    claudeStub.analyze.mockClear();
    embedMock.mockReset();
    embedMock.mockResolvedValue(Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.1));
    relationJudgeMock.mockReset();
    relationJudgeMock.mockResolvedValue([]);
  });

  async function insertMemoNote(overrides: {
    title?: string | null;
    summary?: string | null;
    body?: string | null;
    tags?: string[];
    deletedAt?: Date | null;
    enrichmentStatus?: "pending" | "completed" | "failed" | null;
  }): Promise<string> {
    const id = randomUUID();
    await db.insert(notes).values({
      id,
      userId: ownerId,
      type: "memo",
      title: overrides.title ?? "テストタイトル",
      body: overrides.body ?? "テスト本文です。",
      summary: overrides.summary ?? null,
      tags: overrides.tags ?? [],
      status: "completed",
      failureReason: null,
      imageKey: null,
      imageMimeType: null,
      concepts: [],
      extractedText: null,
      deletedAt: overrides.deletedAt ?? null,
      processingGeneration: 0,
      processingAttemptToken: null,
      enrichmentStatus: overrides.enrichmentStatus ?? "pending",
    });
    return id;
  }

  /**
   * `embedding` 列(raw VECTOR バイナリ)は customType 上 `data`/`driverData` が `never` で
   * クエリビルダ経由の読み書きができないため、raw SQL で `IS NULL` 判定のみ取得する
   * (note-enrichment.processor.ts の loadSnapshot と同じ raw SQL パターン)。
   */
  async function fetchEnrichmentRow(id: string): Promise<RawEnrichmentRow | null> {
    const result = await db.execute<RawEnrichmentRow>(sql`
      SELECT title, embedding IS NULL AS embedding_is_null, embedding_model, embedding_fingerprint,
             enrichment_status, updated_at
        FROM notes
       WHERE id = ${id}
       LIMIT 1
    `);
    const rows = result[0] as unknown as RawEnrichmentRow[];
    return rows[0] ?? null;
  }

  async function setStaleUpdatedAt(noteId: string, minutesAgo: number): Promise<void> {
    const staleDate = new Date(Date.now() - minutesAgo * 60 * 1000);
    await db.update(notes).set({ updatedAt: staleDate }).where(eq(notes.id, noteId));
  }

  /**
   * M1-4b 関係判定ステージの統合テスト専用ヘルパー群(受入条件1・8・9・10・11)。
   *
   * `VEC_DISTANCE_COSINE` は向き(角度)のみに依存するため、同じ `seed` から生成した
   * ベクトルは常に距離0(=最優先候補)になり、異なる `seed` 同士は高い確率で距離0にならない
   * (sin の位相をずらしているだけで理論上の衝突を完全には排除できないが、テストごとに
   * 大きく離れた seed を割り当てれば実務上無視できる)。このファイルの他のテストが使う
   * embedMock の既定値(全要素 0.1 の一様ベクトル)とも十分に離れた向きになるため、
   * このファイル内に既に蓄積された大量のノート(既定ベクトル)がノイズとして混入し、
   * `findRelationCandidates` の LIMIT 5 を横取りする事故を避けられる。
   */
  function buildSignatureVector(seed: number): number[] {
    return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => Math.sin(seed * 97 + i));
  }

  /**
   * 関係判定の「候補ノート」役を直接 INSERT する(note-enrichment プロセッサを経由しない)。
   * 候補ノート自身の関係判定ジョブは本テストの対象外であり、プロセッサ経由で作ると候補
   * ノート自身が enrichment ジョブの中で関係判定ステージを実行してしまい、余計な Claude
   * 呼び出し・エッジが発生してテストの決定性を損なうため、最短経路(直接 INSERT + raw SQL
   * での embedding 書き込み)で `enrichment_status='completed'` な行を作る。
   */
  async function insertRelationCandidateNote(overrides: {
    title?: string;
    body?: string;
    summary?: string | null;
    vectorSeed: number;
    embeddingFingerprint: string;
  }): Promise<string> {
    const id = randomUUID();
    await db.insert(notes).values({
      id,
      userId: ownerId,
      type: "memo",
      title: overrides.title ?? "候補ノート",
      body: overrides.body ?? "候補ノートの本文です。",
      summary: overrides.summary ?? null,
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
      enrichmentStatus: "completed",
    });
    const vectorText = `[${buildSignatureVector(overrides.vectorSeed).join(",")}]`;
    // embedding は customType 上クエリビルダ経由で書き込めないため raw SQL を使う
    // (note-enrichment.processor.ts の writeBackEmbedding と同じ VEC_FromText パターン)。
    await db.execute(sql`
      UPDATE notes
         SET embedding = VEC_FromText(${vectorText}),
             embedding_model = ${OPENAI_EMBEDDING_MODEL},
             embedding_fingerprint = ${overrides.embeddingFingerprint}
       WHERE id = ${id}
    `);
    return id;
  }

  /** note_relations の正規化済みペア(note_a_id < note_b_id)の行を、論理削除済みも含めて取得する。 */
  async function fetchRelationRows(noteXId: string, noteYId: string): Promise<NoteRelation[]> {
    const [noteAId, noteBId] = noteXId < noteYId ? [noteXId, noteYId] : [noteYId, noteXId];
    return db
      .select()
      .from(noteRelations)
      .where(and(eq(noteRelations.noteAId, noteAId), eq(noteRelations.noteBId, noteBId)));
  }

  /**
   * Claude スタブ(`relationJudgeMock`)を「呼ばれたことが外から検知できる、保留中の
   * Promise」に差し替える(受入条件9・10・11。TOCTOU テストはタイミング依存の並行
   * ストレステストにせず、この手動解決 Promise による決定的な再現に統一する方針
   * — 計画 §テスト方針 参照)。`invoked` を await することで「Claude 呼び出しの直後・
   * 応答受信の直前」という一点にテスト側の操作(論理削除・fingerprint 書き換え)を
   * 確実に割り込ませられる。
   */
  function makePendingJudge(): {
    invoked: Promise<void>;
    release: (results: RelationJudgeResultItem[]) => void;
  } {
    let invokedResolve!: () => void;
    const invoked = new Promise<void>((resolve) => {
      invokedResolve = resolve;
    });
    let releaseResolve!: (results: RelationJudgeResultItem[]) => void;
    const pendingResult = new Promise<RelationJudgeResultItem[]>((resolve) => {
      releaseResolve = resolve;
    });
    relationJudgeMock.mockImplementationOnce(() => {
      invokedResolve();
      return pendingResult;
    });
    return {
      invoked,
      release: (results) => releaseResolve(results),
    };
  }

  describe("正常系: embedding 生成・冪等スキップ", () => {
    it("pending のノートにジョブを実行すると、embedding・embedding_model・embedding_fingerprint が保存され enrichment_status='completed' になる(OpenAI はスタブ)", async () => {
      const tags = ["tag-a", "tag-b"];
      const noteId = await insertMemoNote({
        title: "メモのタイトル",
        summary: "メモの要約です。",
        body: "メモの本文です。",
        tags,
      });

      await noteEnrichmentProcessor.process(makeEnrichmentJob({ noteId }));

      const row = await fetchEnrichmentRow(noteId);
      expect(row?.enrichment_status).toBe("completed");
      expect(Boolean(row?.embedding_is_null)).toBe(false);
      expect(row?.embedding_model).toBe("text-embedding-3-small");
      expect(row?.embedding_fingerprint).toMatch(/^[0-9a-f]{64}$/);

      const expectedInput = buildEmbeddingInputText({
        title: "メモのタイトル",
        summary: "メモの要約です。",
        body: "メモの本文です。",
        extractedText: null,
        tagsRaw: JSON.stringify(tags),
      });
      expect(embedMock).toHaveBeenCalledTimes(1);
      expect(embedMock).toHaveBeenCalledWith(expectedInput);
    });

    it("fingerprint が一致する再実行では OpenAI を呼ばずスキップする(冪等)", async () => {
      const noteId = await insertMemoNote({ title: "冪等テスト", enrichmentStatus: "pending" });

      await noteEnrichmentProcessor.process(makeEnrichmentJob({ noteId }));
      expect(embedMock).toHaveBeenCalledTimes(1);
      const afterFirst = await fetchEnrichmentRow(noteId);
      expect(afterFirst?.enrichment_status).toBe("completed");

      // 内容を変えずに enrichment_status だけを pending に戻す(更新時 enqueue の再投入を模擬)。
      await db.update(notes).set({ enrichmentStatus: "pending" }).where(eq(notes.id, noteId));

      await noteEnrichmentProcessor.process(makeEnrichmentJob({ noteId }));

      // 2回目の実行でも embed は追加で呼ばれない(1回目の呼び出しのみのまま)。
      expect(embedMock).toHaveBeenCalledTimes(1);
      const afterSecond = await fetchEnrichmentRow(noteId);
      expect(afterSecond?.enrichment_status).toBe("completed");
      expect(afterSecond?.embedding_fingerprint).toBe(afterFirst?.embedding_fingerprint);
    });
  });

  describe("書き戻しの条件付き UPDATE(CAS)", () => {
    it("ジョブ実行中(OpenAI 呼び出し中)に内容が更新されると affected rows 0 となり、書き戻しをスキップして pending を維持する", async () => {
      const noteId = await insertMemoNote({ title: "元のタイトル" });

      embedMock.mockImplementationOnce(async () => {
        // スナップショット取得後・書き戻し前に、別経路(PUT 相当)で内容が更新された状況を
        // 再現する(embed() の呼び出し中に競合更新を挟む)。
        await db
          .update(notes)
          .set({ title: "実行中に更新されたタイトル" })
          .where(eq(notes.id, noteId));
        return Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.2);
      });

      await noteEnrichmentProcessor.process(makeEnrichmentJob({ noteId }));

      const row = await fetchEnrichmentRow(noteId);
      expect(row?.enrichment_status).toBe("pending");
      expect(Boolean(row?.embedding_is_null)).toBe(true);
      expect(row?.title).toBe("実行中に更新されたタイトル");
    });

    it("同一秒内に内容だけが変わった場合(updated_at が同値のまま)でも、内容列の <=> 比較により不一致を検出して書き戻しをスキップする", async () => {
      const noteId = await insertMemoNote({ title: "元のタイトル" });
      const original = await fetchEnrichmentRow(noteId);
      expect(original).not.toBeNull();
      const originalUpdatedAt = original?.updated_at as Date;

      embedMock.mockImplementationOnce(async () => {
        // 内容だけを変更したうえで、updated_at を明示的に元の値へ固定し直す(同一秒内の
        // PUT 更新を決定的に再現する。updated_at 単独の CAS では検知できないことの
        // 検証が目的であり、`<=>` 併用の設計根拠そのもの)。MariaDB の
        // `ON UPDATE CURRENT_TIMESTAMP` 列は UPDATE 文で明示的に値を指定した場合は
        // その値をそのまま採用し、自動更新しない。
        await db.execute(
          sql`UPDATE notes SET title = ${"同一秒内の更新後タイトル"} WHERE id = ${noteId}`,
        );
        await db.execute(
          sql`UPDATE notes SET updated_at = ${originalUpdatedAt} WHERE id = ${noteId}`,
        );
        return Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.3);
      });

      await noteEnrichmentProcessor.process(makeEnrichmentJob({ noteId }));

      const row = await fetchEnrichmentRow(noteId);
      expect(row?.updated_at).toEqual(originalUpdatedAt);
      expect(row?.title).toBe("同一秒内の更新後タイトル");
      expect(row?.enrichment_status).toBe("pending");
      expect(Boolean(row?.embedding_is_null)).toBe(true);
    });

    it("同一秒内に大文字小文字のみが変わった場合(updated_at が同値のまま)でも、BINARY による内容列比較により不一致を検出して書き戻しをスキップする(MariaDB のデフォルト照合順序 case-insensitive による誤検知の回帰テスト。Codex 再レビュー HIGH 指摘対応)", async () => {
      const noteId = await insertMemoNote({ title: "Hello" });
      const original = await fetchEnrichmentRow(noteId);
      expect(original).not.toBeNull();
      const originalUpdatedAt = original?.updated_at as Date;

      embedMock.mockImplementationOnce(async () => {
        // 大文字小文字のみが異なるタイトルへ変更したうえで、updated_at を明示的に元の値へ
        // 固定し直す(同一秒内の PUT 更新を決定的に再現する)。素の `<=>` は列の照合順序
        // (case-insensitive)に従うため "Hello" と "hello" を「同一」と誤判定してしまうが、
        // `BINARY <=>` はバイト単位で比較するため不一致として検出できるはずである
        // (この回帰テストの目的)。
        await db.execute(sql`UPDATE notes SET title = ${"hello"} WHERE id = ${noteId}`);
        await db.execute(
          sql`UPDATE notes SET updated_at = ${originalUpdatedAt} WHERE id = ${noteId}`,
        );
        return Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.35);
      });

      await noteEnrichmentProcessor.process(makeEnrichmentJob({ noteId }));

      const row = await fetchEnrichmentRow(noteId);
      expect(row?.updated_at).toEqual(originalUpdatedAt);
      expect(row?.title).toBe("hello");
      // CAS が不一致となり書き戻しが完全にスキップされるため、PUT 側が設定した pending が
      // 維持され、古い入力("Hello")から計算した fingerprint・embedding では上書きされない。
      expect(row?.enrichment_status).toBe("pending");
      expect(Boolean(row?.embedding_is_null)).toBe(true);
    });

    it("ジョブ実行中(OpenAI 呼び出し中)に論理削除されると(updated_at・内容列は開始時と同一秒のまま不変)、CAS の deleted_at IS NULL 条件により書き戻しをスキップし、削除済みノートへ embedding・completed を書き込まない(Codex D0 レビュー MEDIUM 指摘への対応)", async () => {
      const noteId = await insertMemoNote({ title: "削除競合テスト" });
      const original = await fetchEnrichmentRow(noteId);
      expect(original).not.toBeNull();
      const originalUpdatedAt = original?.updated_at as Date;

      embedMock.mockImplementationOnce(async () => {
        // スナップショット取得後・書き戻し前に論理削除された状況を再現する。updated_at・
        // 内容列は変化させず、CAS のうち deleted_at IS NULL のみが不一致になる状況を
        // 決定的に再現する(「同一秒内に内容だけが変わった場合」のテストと同じ手法で
        // updated_at を元の値へ固定し直す)。
        await db.execute(sql`UPDATE notes SET deleted_at = ${new Date()} WHERE id = ${noteId}`);
        await db.execute(
          sql`UPDATE notes SET updated_at = ${originalUpdatedAt} WHERE id = ${noteId}`,
        );
        return Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.4);
      });

      await noteEnrichmentProcessor.process(makeEnrichmentJob({ noteId }));

      const row = await fetchEnrichmentRow(noteId);
      // 書き戻しの UPDATE が0件のため、embedding は書き込まれず enrichment_status は
      // PUT/削除処理側が設定したままの pending を維持する(削除済みノートに embedding や
      // completed 状態が残らない)。
      expect(row?.enrichment_status).toBe("pending");
      expect(Boolean(row?.embedding_is_null)).toBe(true);
      expect(row?.updated_at).toEqual(originalUpdatedAt);
    });

    it("markFailed も同じ CAS で保護され、実行中に内容が更新された場合は failed へ上書きせず pending を維持する(最終試行での OpenAI 失敗)", async () => {
      const noteId = await insertMemoNote({ title: "元のタイトル" });

      embedMock.mockImplementationOnce(async () => {
        await db
          .update(notes)
          .set({ title: "失敗前に更新されたタイトル" })
          .where(eq(notes.id, noteId));
        throw new Error("openai failure during in-flight update");
      });

      await expect(
        noteEnrichmentProcessor.process(
          makeEnrichmentJob({ noteId, attemptsMade: 2, attempts: 3 }),
        ),
      ).resolves.toBeUndefined();

      const row = await fetchEnrichmentRow(noteId);
      // markFailed の CAS が(loadSnapshot 時点の古いスナップショットに対して)不一致となり
      // 何も書き込まれないため、PUT 側が設定した pending のまま維持される
      // (回収バッチ・次回 enqueue が新内容で再処理して収束する)。
      expect(row?.enrichment_status).toBe("pending");
      expect(row?.title).toBe("失敗前に更新されたタイトル");
    });

    it("VEC_FromText へ渡すベクトル文字列の次元数が1536と異なる場合、DB エラーとなり最終試行では failed へ遷移する(次元固定の検証)", async () => {
      const noteId = await insertMemoNote({ title: "次元不一致テスト" });
      embedMock.mockResolvedValueOnce([0.1, 0.2, 0.3]);

      await expect(
        noteEnrichmentProcessor.process(
          makeEnrichmentJob({ noteId, attemptsMade: 2, attempts: 3 }),
        ),
      ).resolves.toBeUndefined();

      const row = await fetchEnrichmentRow(noteId);
      expect(row?.enrichment_status).toBe("failed");
      expect(Boolean(row?.embedding_is_null)).toBe(true);
    });

    it("VEC_FromText の次元数不一致は最終試行でなければ re-throw され、リトライされる", async () => {
      const noteId = await insertMemoNote({ title: "次元不一致・非最終試行テスト" });
      embedMock.mockResolvedValueOnce([0.1, 0.2, 0.3]);

      await expect(
        noteEnrichmentProcessor.process(
          makeEnrichmentJob({ noteId, attemptsMade: 0, attempts: 3 }),
        ),
      ).rejects.toThrow();

      const row = await fetchEnrichmentRow(noteId);
      expect(row?.enrichment_status).toBe("pending");
    });
  });

  describe("入力が実質空へ変化した場合の embedding クリア", () => {
    it("embedding 生成済みのノートが更新で全フィールド空になると、次回実行で embedding・embedding_model が NULL 化される", async () => {
      const noteId = await insertMemoNote({ title: "後で空にするノート", body: "本文" });
      await noteEnrichmentProcessor.process(makeEnrichmentJob({ noteId }));
      const afterFirst = await fetchEnrichmentRow(noteId);
      expect(Boolean(afterFirst?.embedding_is_null)).toBe(false);

      // 内容を全フィールド空にし、enrichment_status を pending へ戻す(更新時 enqueue を模擬)。
      await db
        .update(notes)
        .set({ title: null, body: null, summary: null, tags: [], enrichmentStatus: "pending" })
        .where(eq(notes.id, noteId));

      await noteEnrichmentProcessor.process(makeEnrichmentJob({ noteId }));

      const afterSecond = await fetchEnrichmentRow(noteId);
      expect(Boolean(afterSecond?.embedding_is_null)).toBe(true);
      expect(afterSecond?.embedding_model).toBeNull();
      expect(afterSecond?.enrichment_status).toBe("completed");
    });
  });

  describe("note-enrichment 回収バッチ", () => {
    it("pending かつ10分以上前の行が再投入され、completed・failed・論理削除済みの行は再投入されない", async () => {
      const stalePendingId = await insertMemoNote({ title: "stale pending" });
      const staleCompletedId = await insertMemoNote({
        title: "stale completed",
        enrichmentStatus: "completed",
      });
      const staleFailedId = await insertMemoNote({
        title: "stale failed",
        enrichmentStatus: "failed",
      });
      const staleDeletedId = await insertMemoNote({
        title: "stale deleted",
        deletedAt: new Date(),
      });
      const freshPendingId = await insertMemoNote({ title: "fresh pending" });

      await setStaleUpdatedAt(stalePendingId, 11);
      await setStaleUpdatedAt(staleCompletedId, 11);
      await setStaleUpdatedAt(staleFailedId, 11);
      await setStaleUpdatedAt(staleDeletedId, 11);
      // freshPendingId は insert 直後の現在時刻のまま(10分未満)。

      await noteEnrichmentRequeueProcessor.process();

      await expect(
        noteEnrichmentQueue.getJob(noteEnrichmentJobId(stalePendingId)),
      ).resolves.toBeTruthy();
      await expect(
        noteEnrichmentQueue.getJob(noteEnrichmentJobId(staleCompletedId)),
      ).resolves.toBeUndefined();
      await expect(
        noteEnrichmentQueue.getJob(noteEnrichmentJobId(staleFailedId)),
      ).resolves.toBeUndefined();
      await expect(
        noteEnrichmentQueue.getJob(noteEnrichmentJobId(staleDeletedId)),
      ).resolves.toBeUndefined();
      await expect(
        noteEnrichmentQueue.getJob(noteEnrichmentJobId(freshPendingId)),
      ).resolves.toBeUndefined();
    });

    it("対応する BullMQ ジョブが waiting で現存する場合は二重投入しない", async () => {
      const noteId = await insertMemoNote({ title: "waiting job exists" });
      await setStaleUpdatedAt(noteId, 11);
      await noteEnrichmentQueue.add(
        NOTE_ENRICHMENT_QUEUE_NAME,
        { noteId },
        { jobId: noteEnrichmentJobId(noteId) },
      );

      await noteEnrichmentRequeueProcessor.process();

      const job = await noteEnrichmentQueue.getJob(noteEnrichmentJobId(noteId));
      expect(await job?.getState()).toBe("waiting");
    });
  });

  describe("関係判定ステージ: エッジ永続化(受入条件1)", () => {
    it("related=true の組が note_relations に正規化・source_note_id・type_direction・両端 fingerprint 付きで保存される", async () => {
      const candidateFingerprint = "fp-candidate-basic-001";
      const candidateId = await insertRelationCandidateNote({
        title: "候補ノート:認証設計",
        body: "JWT を用いた認証設計についてのメモ。",
        vectorSeed: 1001,
        embeddingFingerprint: candidateFingerprint,
      });
      const sourceId = await insertMemoNote({
        title: "ソースノート:ログイン画面",
        body: "ログイン画面の実装メモ。",
      });

      embedMock.mockResolvedValueOnce(buildSignatureVector(1001));
      const results: RelationJudgeResultItem[] = [
        {
          candidateId,
          type: "cause-solution",
          direction: "outgoing",
          description: "ログイン画面は JWT 認証設計を前提にしている。",
          relatedness: 0.82,
        },
      ];
      relationJudgeMock.mockResolvedValueOnce(results);

      await noteEnrichmentProcessor.process(makeEnrichmentJob({ noteId: sourceId }));

      const rows = await fetchRelationRows(sourceId, candidateId);
      expect(rows).toHaveLength(1);
      const row = rows[0];
      // 正規化(note_a_id < note_b_id)・重複なし(1行のみ)。
      expect(row.noteAId < row.noteBId).toBe(true);
      expect(row.sourceNoteId).toBe(sourceId);
      expect(row.relationType).toBe("cause-solution");
      expect(row.description).toBe("ログイン画面は JWT 認証設計を前提にしている。");
      expect(Number(row.relatedness)).toBeCloseTo(0.82, 2);
      expect(row.deletedAt).toBeNull();

      const sourceIsNoteA = sourceId < candidateId;
      expect(row.typeDirection).toBe(sourceIsNoteA ? "a-to-b" : "b-to-a");

      const sourceRow = await fetchEnrichmentRow(sourceId);
      const sourceFingerprint = sourceRow?.embedding_fingerprint;
      expect(sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
      // 両端 fingerprint が judge 実行時に観測した値で保存されている(generated_from ではなく
      // 両端 fingerprint を持たせる設計決定の直接的な検証)。
      if (sourceIsNoteA) {
        expect(row.noteAFingerprint).toBe(sourceFingerprint);
        expect(row.noteBFingerprint).toBe(candidateFingerprint);
      } else {
        expect(row.noteAFingerprint).toBe(candidateFingerprint);
        expect(row.noteBFingerprint).toBe(sourceFingerprint);
      }
    });
  });

  describe("物理 purge と FK CASCADE(受入条件8)", () => {
    it("エッジの非 source 側の端点(note_a_id/note_b_id いずれか)を物理 purge すると、エッジも消え purge 自体は FK エラーで失敗しない", async () => {
      const candidateFingerprint = "fp-candidate-purge-001";
      const candidateId = await insertRelationCandidateNote({
        vectorSeed: 2001,
        embeddingFingerprint: candidateFingerprint,
      });
      const sourceId = await insertMemoNote({ title: "purge対象の候補ノートを持つsource" });
      embedMock.mockResolvedValueOnce(buildSignatureVector(2001));
      const results: RelationJudgeResultItem[] = [
        { candidateId, type: "other", direction: "none", description: "d", relatedness: 0.5 },
      ];
      relationJudgeMock.mockResolvedValueOnce(results);
      await noteEnrichmentProcessor.process(makeEnrichmentJob({ noteId: sourceId }));
      expect(await fetchRelationRows(sourceId, candidateId)).toHaveLength(1);

      // note-purge.processor.ts の purgeOne と同じ物理削除操作(DELETE FROM notes)。
      // candidateId は source_note_id ではない側の端点であり、note_a_id/note_b_id いずれか
      // 一方に必ず該当する(UUID 生成順は制御していないため、どちらに該当するかはテスト
      // ごとに変わりうるが、両方のケースを本 describe 内の2テストで確実にカバーする)。
      await expect(db.delete(notes).where(eq(notes.id, candidateId))).resolves.toBeDefined();

      expect(await fetchRelationRows(sourceId, candidateId)).toHaveLength(0);
    });

    it("エッジの source 側ノートを物理 purge すると、source_note_id の ON DELETE CASCADE によりエッジも消え purge 自体は失敗しない", async () => {
      const candidateFingerprint = "fp-candidate-purge-002";
      const candidateId = await insertRelationCandidateNote({
        vectorSeed: 2002,
        embeddingFingerprint: candidateFingerprint,
      });
      const sourceId = await insertMemoNote({ title: "purge対象のsourceノート" });
      embedMock.mockResolvedValueOnce(buildSignatureVector(2002));
      const results: RelationJudgeResultItem[] = [
        { candidateId, type: "other", direction: "none", description: "d", relatedness: 0.5 },
      ];
      relationJudgeMock.mockResolvedValueOnce(results);
      await noteEnrichmentProcessor.process(makeEnrichmentJob({ noteId: sourceId }));
      const before = await fetchRelationRows(sourceId, candidateId);
      expect(before).toHaveLength(1);
      expect(before[0].sourceNoteId).toBe(sourceId);

      // sourceId は必ず source_note_id 列の値そのもの。かつ note_a_id/note_b_id のうち
      // 「候補側 purge テスト」で削除した列とは反対側の役割を担う(sourceId と candidateId は
      // 別ノートであり正規化ペアで必ずどちらかが note_a・もう一方が note_b になるため)。
      // 本テストと前テストの2本で note_a_id・note_b_id・source_note_id の3列すべてが
      // 少なくとも一度は削除対象になることを担保する。
      await expect(db.delete(notes).where(eq(notes.id, sourceId))).resolves.toBeDefined();

      expect(await fetchRelationRows(sourceId, candidateId)).toHaveLength(0);
    });
  });

  describe("判定中の端点論理削除(受入条件9。Claude スタブを保留し、その間に端点を論理削除する決定的なテスト)", () => {
    it("判定中に候補ノートが論理削除されると、そのエッジは生成されない", async () => {
      const candidateFingerprint = "fp-candidate-softdel-001";
      const candidateId = await insertRelationCandidateNote({
        vectorSeed: 3001,
        embeddingFingerprint: candidateFingerprint,
      });
      const sourceId = await insertMemoNote({ title: "候補側論理削除テストのsource" });
      embedMock.mockResolvedValueOnce(buildSignatureVector(3001));

      const { invoked, release } = makePendingJudge();
      const processPromise = noteEnrichmentProcessor.process(
        makeEnrichmentJob({ noteId: sourceId, attemptsMade: 0, attempts: 3 }),
      );
      await invoked;

      // Claude 呼び出し中(応答待ち)に候補ノートを論理削除する。エッジ upsert の
      // INSERT...SELECT は `b.deleted_at IS NULL` を要求するため、この1組だけが
      // スキップされる(§設計決定6)。
      await db.update(notes).set({ deletedAt: new Date() }).where(eq(notes.id, candidateId));
      release([
        { candidateId, type: "other", direction: "none", description: "d", relatedness: 0.5 },
      ]);

      await expect(processPromise).resolves.toBeUndefined();

      expect(await fetchRelationRows(sourceId, candidateId)).toHaveLength(0);
    });

    it("判定中に判定元(source)ノートが論理削除されると、そのエッジは生成されない", async () => {
      const candidateFingerprint = "fp-candidate-softdel-002";
      const candidateId = await insertRelationCandidateNote({
        vectorSeed: 3002,
        embeddingFingerprint: candidateFingerprint,
      });
      const sourceId = await insertMemoNote({ title: "判定元論理削除テストのsource" });
      embedMock.mockResolvedValueOnce(buildSignatureVector(3002));

      const { invoked, release } = makePendingJudge();
      // 完了確定 UPDATE(手順4)は判定元ノート自身の CAS(deleted_at IS NULL を含む)で
      // 保護されているため、論理削除後は affected rows が0になり
      // RelationStageCompletionRaceError で tx 全体(このケースではエッジ0件なので実質は
      // completed 更新のみ)が rollback される。最終試行にしておくことで re-throw されず
      // markRelationFailed へ倒れて process() が正常終了する経路を使い、決定的に
      // 「エッジが生成されないこと」だけを検証する(reject する非最終試行の経路は
      // relation-stage.spec.ts の単体テストで既に検証済み)。
      const processPromise = noteEnrichmentProcessor.process(
        makeEnrichmentJob({ noteId: sourceId, attemptsMade: 2, attempts: 3 }),
      );
      await invoked;

      await db.update(notes).set({ deletedAt: new Date() }).where(eq(notes.id, sourceId));
      release([
        { candidateId, type: "other", direction: "none", description: "d", relatedness: 0.5 },
      ]);

      await expect(processPromise).resolves.toBeUndefined();

      expect(await fetchRelationRows(sourceId, candidateId)).toHaveLength(0);
    });
  });

  describe("判定中の判定元ノート変更(受入条件10。markRelationCompleted の affected rows = 0 → tx 全体 rollback)", () => {
    it("Claude スタブ保留中に判定元の embedding_fingerprint が変わると、エッジが1件も永続化されない", async () => {
      const candidateFingerprint = "fp-candidate-race10-001";
      const candidateId = await insertRelationCandidateNote({
        vectorSeed: 4001,
        embeddingFingerprint: candidateFingerprint,
      });
      const sourceId = await insertMemoNote({ title: "判定元変更テストのsource" });
      embedMock.mockResolvedValueOnce(buildSignatureVector(4001));

      const { invoked, release } = makePendingJudge();
      const processPromise = noteEnrichmentProcessor.process(
        makeEnrichmentJob({ noteId: sourceId, attemptsMade: 2, attempts: 3 }),
      );
      await invoked;

      // 「判定中に判定元ノートの内容が変わった(= embedding_fingerprint が変わる状況)」を、
      // 実際にもう一度 enrichment ジョブを走らせるのではなく embedding_fingerprint 列を
      // 直接書き換えることで決定的に再現する(このファイルの他の CAS テスト群と同じ手法)。
      // §設計決定3 の関係ステージ CAS は embedding_fingerprint の一致のみを見るため、
      // この列を変えるだけで手順4の完了確定 UPDATE を不一致にできる。
      await db.execute(
        sql`UPDATE notes SET embedding_fingerprint = ${"changed-during-judge-fingerprint"} WHERE id = ${sourceId}`,
      );
      release([
        { candidateId, type: "other", direction: "none", description: "d", relatedness: 0.5 },
      ]);

      await expect(processPromise).resolves.toBeUndefined();

      // エッジ upsert 自体は候補の fingerprint と一致しており成立しうるが、同一トランザクション
      // 内の完了確定 UPDATE が不一致で例外を投げるため、INSERT 済みのエッジも含めて
      // tx 全体が rollback される(受入条件10 の核心)。
      expect(await fetchRelationRows(sourceId, candidateId)).toHaveLength(0);
    });
  });

  describe("判定中の候補ノート変更(受入条件11。変更された候補のエッジだけがスキップされ、他候補のエッジは保存される)", () => {
    it("候補Aの embedding_fingerprint を判定中に変更すると候補Aとのエッジはスキップされ、候補Bとのエッジは保存される", async () => {
      const candidateAFingerprint = "fp-candidate-race11-a";
      const candidateBFingerprint = "fp-candidate-race11-b";
      const candidateAId = await insertRelationCandidateNote({
        title: "候補A",
        vectorSeed: 5001,
        embeddingFingerprint: candidateAFingerprint,
      });
      const candidateBId = await insertRelationCandidateNote({
        title: "候補B",
        // source と同じベクトルを使い、候補A・候補Bともに LIMIT 5 の圏内(距離0)に確実に
        // 入るようにする。
        vectorSeed: 5001,
        embeddingFingerprint: candidateBFingerprint,
      });
      const sourceId = await insertMemoNote({ title: "候補変更テストのsource" });
      embedMock.mockResolvedValueOnce(buildSignatureVector(5001));

      const { invoked, release } = makePendingJudge();
      const processPromise = noteEnrichmentProcessor.process(
        makeEnrichmentJob({ noteId: sourceId, attemptsMade: 0, attempts: 3 }),
      );
      await invoked;

      // 候補Aだけ内容が変わった(embedding_fingerprint が変化した)状況を決定的に再現する。
      // upsert の WHERE は候補取得時に観測した(変更前の)fingerprint と現在値の一致を
      // 要求するため、候補Aとの組だけが0行を返してスキップされる(§設計決定6)。
      await db.execute(
        sql`UPDATE notes SET embedding_fingerprint = ${"changed-candidate-a-fingerprint"} WHERE id = ${candidateAId}`,
      );
      release([
        {
          candidateId: candidateAId,
          type: "other",
          direction: "none",
          description: "候補A説明(永続化されてはいけない)",
          relatedness: 0.4,
        },
        {
          candidateId: candidateBId,
          type: "same-theme",
          direction: "none",
          description: "候補B説明",
          relatedness: 0.6,
        },
      ]);

      await expect(processPromise).resolves.toBeUndefined();

      expect(await fetchRelationRows(sourceId, candidateAId)).toHaveLength(0);
      const rowsB = await fetchRelationRows(sourceId, candidateBId);
      expect(rowsB).toHaveLength(1);
      expect(rowsB[0].description).toBe("候補B説明");
      // 完了確定 UPDATE は判定元ノートの CAS のみで保護されており候補側の変更とは無関係の
      // ため、候補Aのスキップは tx 全体の rollback を伴わない(候補Bのエッジは保存される)。
    });
  });

  describe("冪等性: エッジ upsert の重複防止・論理削除保護・内容更新・fingerprint スキップ", () => {
    it("同じジョブを2回実行してもエッジが重複せず(UNIQUE制約 + 条件付きupsert)、有効行の内容は再判定のたびに更新される", async () => {
      const candidateFingerprint = "fp-candidate-idem-update";
      const candidateId = await insertRelationCandidateNote({
        vectorSeed: 6001,
        embeddingFingerprint: candidateFingerprint,
      });
      const sourceId = await insertMemoNote({ title: "重複防止・内容更新テストのsource" });
      embedMock.mockResolvedValueOnce(buildSignatureVector(6001));
      relationJudgeMock.mockResolvedValueOnce([
        {
          candidateId,
          type: "other",
          direction: "none",
          description: "初回説明",
          relatedness: 0.3,
        },
      ] satisfies RelationJudgeResultItem[]);

      await noteEnrichmentProcessor.process(makeEnrichmentJob({ noteId: sourceId }));
      const afterFirst = await fetchRelationRows(sourceId, candidateId);
      expect(afterFirst).toHaveLength(1);
      expect(afterFirst[0].description).toBe("初回説明");

      // 内容(embedding_fingerprint)は変えずに relation_status のみ pending へ戻し、
      // 再判定を強制する(回収バッチ・再enqueue 相当の再実行を模擬)。
      const snapshotAfterFirst = await fetchEnrichmentRow(sourceId);
      await db
        .update(notes)
        .set({
          relationStatus: "pending",
          relationFingerprint: snapshotAfterFirst?.embedding_fingerprint ?? null,
        })
        .where(eq(notes.id, sourceId));
      relationJudgeMock.mockResolvedValueOnce([
        {
          candidateId,
          type: "cause-solution",
          direction: "outgoing",
          description: "更新後の説明",
          relatedness: 0.9,
        },
      ] satisfies RelationJudgeResultItem[]);

      await noteEnrichmentProcessor.process(makeEnrichmentJob({ noteId: sourceId }));

      const afterSecond = await fetchRelationRows(sourceId, candidateId);
      // UNIQUE(user_id, note_a_id, note_b_id) + 条件付き upsert により2回目実行後も1行のまま
      // (id が同一であることまで確認し、削除→再作成ではなく UPDATE であることを保証する)。
      expect(afterSecond).toHaveLength(1);
      expect(afterSecond[0].id).toBe(afterFirst[0].id);
      expect(afterSecond[0].description).toBe("更新後の説明");
      expect(afterSecond[0].relationType).toBe("cause-solution");
      expect(Number(afterSecond[0].relatedness)).toBeCloseTo(0.9, 2);
    });

    it("論理削除済みエッジは再判定で復活しない(F-19)", async () => {
      const candidateFingerprint = "fp-candidate-idem-softdel";
      const candidateId = await insertRelationCandidateNote({
        vectorSeed: 6002,
        embeddingFingerprint: candidateFingerprint,
      });
      const sourceId = await insertMemoNote({ title: "論理削除エッジ非復活テストのsource" });
      embedMock.mockResolvedValueOnce(buildSignatureVector(6002));
      relationJudgeMock.mockResolvedValueOnce([
        {
          candidateId,
          type: "other",
          direction: "none",
          description: "削除前の説明",
          relatedness: 0.5,
        },
      ] satisfies RelationJudgeResultItem[]);
      await noteEnrichmentProcessor.process(makeEnrichmentJob({ noteId: sourceId }));
      const created = await fetchRelationRows(sourceId, candidateId);
      expect(created).toHaveLength(1);

      // F-22/M3(エッジのユーザー無効化)は本ユニットのスコープ外で API・UI とも未実装のため、
      // 論理削除済みエッジの状態を直接 note_relations.deleted_at で再現する。
      await db
        .update(noteRelations)
        .set({ deletedAt: new Date() })
        .where(eq(noteRelations.id, created[0].id));

      // 内容(embedding_fingerprint)は変えずに relation_status のみ pending に戻して
      // 再判定を強制する。
      const snapshot = await fetchEnrichmentRow(sourceId);
      await db
        .update(notes)
        .set({
          relationStatus: "pending",
          relationFingerprint: snapshot?.embedding_fingerprint ?? null,
        })
        .where(eq(notes.id, sourceId));
      relationJudgeMock.mockResolvedValueOnce([
        {
          candidateId,
          type: "cause-solution",
          direction: "outgoing",
          description: "再判定後の説明(復活してはいけない)",
          relatedness: 0.9,
        },
      ] satisfies RelationJudgeResultItem[]);

      await noteEnrichmentProcessor.process(makeEnrichmentJob({ noteId: sourceId }));

      const rowsAfter = await fetchRelationRows(sourceId, candidateId);
      expect(rowsAfter).toHaveLength(1);
      expect(rowsAfter[0].id).toBe(created[0].id);
      // deleted_at が入ったままで内容も削除前のまま(§設計決定6 の
      // `IF(deleted_at IS NULL, VALUES(...), 現在値)` により無更新であることの直接的な検証)。
      expect(rowsAfter[0].deletedAt).not.toBeNull();
      expect(rowsAfter[0].description).toBe("削除前の説明");
      expect(rowsAfter[0].relationType).toBe("other");
    });

    it("relation_fingerprint 一致でスキップされ、Claude スタブが呼ばれない", async () => {
      const candidateFingerprint = "fp-candidate-idem-skip";
      const candidateId = await insertRelationCandidateNote({
        vectorSeed: 6003,
        embeddingFingerprint: candidateFingerprint,
      });
      const sourceId = await insertMemoNote({ title: "fingerprint一致スキップテストのsource" });
      embedMock.mockResolvedValueOnce(buildSignatureVector(6003));
      relationJudgeMock.mockResolvedValueOnce([] satisfies RelationJudgeResultItem[]);

      await noteEnrichmentProcessor.process(makeEnrichmentJob({ noteId: sourceId }));
      expect(relationJudgeMock).toHaveBeenCalledTimes(1);

      // 内容・relation_status・relation_fingerprint のいずれも変更せず、無変更再保存
      // (更新時 enqueue の再投入)を模擬する。enrichment_status を pending へ戻すだけであり、
      // embedding_fingerprint 自体は不変のため、processor 側も OpenAI を呼ばず
      // completeWithoutNewEmbedding へフォールスルーする(M1-4a 既存の冪等スキップ)。
      await db.update(notes).set({ enrichmentStatus: "pending" }).where(eq(notes.id, sourceId));

      await noteEnrichmentProcessor.process(makeEnrichmentJob({ noteId: sourceId }));

      // 手順0(relation_status='completed' かつ fingerprint 一致)で冪等スキップされ、
      // judge は追加で呼ばれない(1回目の呼び出しのみ)。
      expect(relationJudgeMock).toHaveBeenCalledTimes(1);
    });
  });
});
