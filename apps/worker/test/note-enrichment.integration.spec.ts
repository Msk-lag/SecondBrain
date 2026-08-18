import { randomUUID } from "node:crypto";
import { Test, type TestingModule } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { getQueueToken } from "@nestjs/bullmq";
import type { Job, Queue } from "bullmq";
import { eq, notes, sql, users, type Database } from "@secondbrain/db";
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
  type OpenAiEmbeddingClient,
  type OpenAiEmbeddingClientFactory,
} from "../src/queues/note-enrichment/openai-embedding.client";
import { buildEmbeddingInputText } from "../src/queues/note-enrichment/note-enrichment-fingerprint";
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

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(CLAUDE_VISION_CLIENT)
      .useValue(claudeStub as unknown as ClaudeVisionClient)
      .overrideProvider(OPENAI_EMBEDDING_CLIENT_FACTORY)
      .useValue(embeddingClientFactoryStub)
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
});
