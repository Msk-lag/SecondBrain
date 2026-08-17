import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import type { Database } from "@secondbrain/db";
import type { NoteEnrichmentJobPayload } from "@secondbrain/shared";
import {
  buildEmbeddingInputText,
  computeEmbeddingFingerprint,
} from "./note-enrichment-fingerprint";
import type { OpenAiEmbeddingClientFactory } from "./openai-embedding.client";
import { NoteEnrichmentProcessor } from "./note-enrichment.processor";

type ExecuteResult = [unknown[], unknown[]] | [{ affectedRows: number }, unknown[]];

interface RawRowOverrides {
  id?: string;
  title?: string | null;
  summary?: string | null;
  body?: string | null;
  extracted_text?: string | null;
  tags?: string;
  updated_at?: Date;
  deleted_at?: Date | null;
  embedding_fingerprint?: string | null;
  enrichment_status?: string | null;
}

// notes.id は randomUUID()(RFC 4122 v4)で生成される実 DB の形式に合わせる(processor が
// job.data.noteId を UUID 形式検証するようになったため。Codex 最終セキュリティ監査 LOW 指摘対応)。
const VALID_NOTE_ID = "11111111-2222-4333-8444-555555555555";

function rawRow(overrides: RawRowOverrides = {}) {
  return {
    id: VALID_NOTE_ID,
    title: "タイトル",
    summary: "要約",
    body: "本文",
    extracted_text: null,
    tags: '["a","b"]',
    updated_at: new Date("2026-08-15T00:00:00.000Z"),
    deleted_at: null,
    embedding_fingerprint: null,
    enrichment_status: "pending",
    ...overrides,
  };
}

function createFakeDb(config: {
  executeQueue?: Array<ExecuteResult | Error>;
  executeSpy?: (query: unknown) => void;
}): Database {
  const executeQueue = [...(config.executeQueue ?? [])];
  const executeSpy = config.executeSpy ?? (() => undefined);

  return {
    execute: (query: unknown) => {
      executeSpy(query);
      const next = executeQueue.shift();
      if (next instanceof Error) {
        return Promise.reject(next);
      }
      return Promise.resolve(next ?? [[], []]);
    },
  } as unknown as Database;
}

/**
 * `db.execute()` が永遠に解決しない DB(withDbTimeout のタイムアウト分岐 —
 * NoteEnrichmentDbTimeoutError を実際に発生させるためのテスト専用)。
 */
function createNeverResolvingDb(): Database {
  return {
    execute: () => new Promise<never>(() => undefined),
  } as unknown as Database;
}

function createFakeJob(overrides: {
  noteId?: string;
  attemptsMade?: number;
  attempts?: number;
}): Job<NoteEnrichmentJobPayload> {
  return {
    data: { noteId: overrides.noteId ?? VALID_NOTE_ID },
    attemptsMade: overrides.attemptsMade ?? 0,
    opts: { attempts: overrides.attempts ?? 3 },
  } as unknown as Job<NoteEnrichmentJobPayload>;
}

/**
 * `job.data` を任意の(型安全性を無視した)値で差し替えた fake job を作る。不正 payload
 * (Codex 最終セキュリティ監査 LOW 指摘対応)のテスト専用。
 */
function createFakeJobWithRawData(
  data: unknown,
  overrides: { attemptsMade?: number; attempts?: number } = {},
): Job<NoteEnrichmentJobPayload> {
  return {
    data,
    attemptsMade: overrides.attemptsMade ?? 0,
    opts: { attempts: overrides.attempts ?? 3 },
  } as unknown as Job<NoteEnrichmentJobPayload>;
}

interface FakeEmbeddingClientFactory {
  factory: OpenAiEmbeddingClientFactory;
  embed: ReturnType<typeof vi.fn>;
  factorySpy: ReturnType<typeof vi.fn>;
}

function createFakeEmbeddingClientFactory(
  embedResult: number[] | Error = Array.from({ length: 1536 }, () => 0.1),
): FakeEmbeddingClientFactory {
  const embed =
    embedResult instanceof Error
      ? vi.fn().mockRejectedValue(embedResult)
      : vi.fn().mockResolvedValue(embedResult);
  const factorySpy = vi.fn().mockReturnValue({ embed });
  return { factory: factorySpy, embed, factorySpy };
}

/**
 * drizzle-orm の `sql` タグが生成する `SQL` インスタンス(`queryChunks`)を、実際の依存追加
 * (このワークスペースは `drizzle-orm` を直接の依存に持たない方針 — packages/db/src/index.ts
 * 参照)無しに、実行時のダックタイピングで概ねのクエリ文字列へ復元するテスト専用ヘルパー。
 * `StringChunk`(`{ value: string[] }`)・`Param`(`{ value: unknown }`)・入れ子の `SQL`
 * (`{ queryChunks: [...] }`)のいずれもプロパティ形状で判別する。
 */
function extractSqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks;
  if (!Array.isArray(chunks)) {
    return "";
  }
  return chunks
    .map((chunk) => {
      // バインド値が Param でラップされず生のプリミティブとして格納される場合がある。
      // `in` 演算子はオブジェクト以外に使えないため、先に判別する。
      if (typeof chunk !== "object" || chunk === null) {
        return String(chunk);
      }
      const c = chunk as { queryChunks?: unknown[]; value?: unknown };
      if (Array.isArray(c.queryChunks)) {
        return extractSqlText(c);
      }
      if (Array.isArray(c.value)) {
        return (c.value as unknown[]).map(String).join("");
      }
      if ("value" in c) {
        return String(c.value);
      }
      return "";
    })
    .join("");
}

describe("NoteEnrichmentProcessor.process", () => {
  it("ノートが存在しない場合は何もせず正常終了する(embedding client は生成しない)", async () => {
    const db = createFakeDb({ executeQueue: [[[], []]] });
    const { factory, factorySpy } = createFakeEmbeddingClientFactory();
    const processor = new NoteEnrichmentProcessor(db, factory);

    await expect(processor.process(createFakeJob({}))).resolves.toBeUndefined();

    expect(factorySpy).not.toHaveBeenCalled();
  });

  it("論理削除済みノートの場合は何もせず正常終了する", async () => {
    const db = createFakeDb({ executeQueue: [[[rawRow({ deleted_at: new Date() })], []]] });
    const { factory, factorySpy } = createFakeEmbeddingClientFactory();
    const processor = new NoteEnrichmentProcessor(db, factory);

    await expect(processor.process(createFakeJob({}))).resolves.toBeUndefined();

    expect(factorySpy).not.toHaveBeenCalled();
  });

  it("fingerprint が一致する場合は OpenAI を呼ばず、fingerprint・completed への UPDATE のみ行い、embedding 列は NULL 化しない(内容不変のため)", async () => {
    const stored = rawRow();
    // 保存済み fingerprint を「現在の内容から計算される値」と同じにする(computeEmbeddingFingerprint
    // をテスト側でも直接使い、行の内容から期待される fingerprint を算出する)。
    const fingerprint = computeEmbeddingFingerprint({
      title: stored.title,
      summary: stored.summary,
      body: stored.body,
      extractedText: stored.extracted_text,
      tagsRaw: stored.tags,
    });
    const executeSpy = vi.fn();
    const db = createFakeDb({
      executeQueue: [
        [[rawRow({ embedding_fingerprint: fingerprint })], []],
        [{ affectedRows: 1 }, []],
      ],
      executeSpy,
    });
    const { factory, factorySpy } = createFakeEmbeddingClientFactory();
    const processor = new NoteEnrichmentProcessor(db, factory);

    await processor.process(createFakeJob({}));

    expect(factorySpy).not.toHaveBeenCalled();
    expect(executeSpy).toHaveBeenCalledTimes(2);
    const updateQuery: unknown = executeSpy.mock.calls[1][0];
    const sqlText = extractSqlText(updateQuery);
    expect(sqlText).toContain("enrichment_status = 'completed'");
    expect(sqlText).not.toContain("embedding = NULL");
  });

  it("入力が実質空(全フィールド空)の場合は OpenAI を呼ばず、fingerprint・completed への UPDATE のみ行う", async () => {
    const executeSpy = vi.fn();
    const db = createFakeDb({
      executeQueue: [
        [
          [
            rawRow({
              title: null,
              summary: null,
              body: null,
              extracted_text: null,
              tags: "[]",
              embedding_fingerprint: null,
            }),
          ],
          [],
        ],
        [{ affectedRows: 1 }, []],
      ],
      executeSpy,
    });
    const { factory, factorySpy } = createFakeEmbeddingClientFactory();
    const processor = new NoteEnrichmentProcessor(db, factory);

    await processor.process(createFakeJob({}));

    expect(factorySpy).not.toHaveBeenCalled();
    expect(executeSpy).toHaveBeenCalledTimes(2);
  });

  it("以前に embedding が生成済みのノートが、更新で入力が実質空へ変化した場合、embedding・embedding_model を NULL 化する UPDATE を発行する(空内容のノートが古い埋め込みで類似候補に出続けないようにするため)", async () => {
    const executeSpy = vi.fn();
    const db = createFakeDb({
      executeQueue: [
        [
          [
            rawRow({
              title: null,
              summary: null,
              body: null,
              extracted_text: null,
              tags: "[]",
              // 空になる前の(非空だった)内容から計算された古い fingerprint。現在の内容
              // (空)から計算される fingerprint とは一致しないため、fingerprint 一致による
              // 冪等スキップ分岐ではなく、実質空入力の分岐に到達する。
              embedding_fingerprint: "fingerprint-from-before-content-was-cleared",
            }),
          ],
          [],
        ],
        [{ affectedRows: 1 }, []],
      ],
      executeSpy,
    });
    const { factory, factorySpy } = createFakeEmbeddingClientFactory();
    const processor = new NoteEnrichmentProcessor(db, factory);

    await processor.process(createFakeJob({}));

    expect(factorySpy).not.toHaveBeenCalled();
    expect(executeSpy).toHaveBeenCalledTimes(2);
    const updateQuery: unknown = executeSpy.mock.calls[1][0];
    const sqlText = extractSqlText(updateQuery);
    expect(sqlText).toContain("embedding = NULL");
    expect(sqlText).toContain("embedding_model = NULL");
    expect(sqlText).toContain("enrichment_status = 'completed'");
  });

  it("正常系: fingerprint 不一致・非空入力の場合、OpenAI へ正しい連結テキストを渡して埋め込みを書き戻す", async () => {
    const stored = rawRow({ embedding_fingerprint: "old-fingerprint" });
    const executeSpy = vi.fn();
    const db = createFakeDb({
      executeQueue: [
        [[stored], []],
        [{ affectedRows: 1 }, []],
      ],
      executeSpy,
    });
    const { factory, embed } = createFakeEmbeddingClientFactory();
    const processor = new NoteEnrichmentProcessor(db, factory);

    await processor.process(createFakeJob({}));

    const expectedInput = buildEmbeddingInputText({
      title: stored.title,
      summary: stored.summary,
      body: stored.body,
      extractedText: stored.extracted_text,
      tagsRaw: stored.tags,
    });
    expect(embed).toHaveBeenCalledWith(expectedInput);
    expect(executeSpy).toHaveBeenCalledTimes(2);
  });

  it("OpenAI 呼び出しが失敗し、最終試行でない場合は re-throw して failed 更新は行わない(BullMQ へ渡る例外はサニタイズ済みで原例外のメッセージを含まない。Codex 再レビュー HIGH 指摘対応)", async () => {
    const executeSpy = vi.fn();
    const db = createFakeDb({
      executeQueue: [[[rawRow({ embedding_fingerprint: "old" })], []]],
      executeSpy,
    });
    const secret = "openai failure: sk-super-secret-api-key";
    const { factory } = createFakeEmbeddingClientFactory(new Error(secret));
    const processor = new NoteEnrichmentProcessor(db, factory);

    const thrown: Error = await processor
      .process(createFakeJob({ attemptsMade: 0, attempts: 3 }))
      .then(
        () => {
          throw new Error("expected process() to reject");
        },
        (err: unknown) => err as Error,
      );

    expect(thrown.message).toBe("note enrichment operation failed");
    expect(thrown.message).not.toContain(secret);
    expect(String(thrown.stack)).not.toContain(secret);
    // 原例外を cause に保持していない(cause 経由の漏洩を防ぐ)。
    expect((thrown as { cause?: unknown }).cause).toBeUndefined();

    // loadSnapshot の SELECT(1回)のみ。failed への UPDATE(execute の2回目)は発生しない。
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  it("OpenAI 呼び出しが失敗し、最終試行の場合は re-throw せず enrichment_status='failed' で正常終了する", async () => {
    const executeSpy = vi.fn();
    const db = createFakeDb({
      executeQueue: [
        [[rawRow({ embedding_fingerprint: "old" })], []],
        [{ affectedRows: 1 }, []],
      ],
      executeSpy,
    });
    const { factory } = createFakeEmbeddingClientFactory(new Error("openai failure: secret"));
    const processor = new NoteEnrichmentProcessor(db, factory);

    await expect(
      processor.process(createFakeJob({ attemptsMade: 2, attempts: 3 })),
    ).resolves.toBeUndefined();

    expect(executeSpy).toHaveBeenCalledTimes(2);
    const updateQuery: unknown = executeSpy.mock.calls[1][0];
    expect(extractSqlText(updateQuery)).toContain("enrichment_status = 'failed'");
  });

  it("OpenAI 呼び出し失敗の例外に含まれる秘密情報がログへ出力されない(回帰テスト。Codex 再レビュー HIGH 指摘対応)", async () => {
    const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const executeSpy = vi.fn();
      const db = createFakeDb({
        executeQueue: [
          [[rawRow({ embedding_fingerprint: "old" })], []],
          [{ affectedRows: 1 }, []],
        ],
        executeSpy,
      });
      const secret = "redis unreachable: super-secret-password";
      const { factory } = createFakeEmbeddingClientFactory(new Error(secret));
      const processor = new NoteEnrichmentProcessor(db, factory);

      await expect(
        processor.process(createFakeJob({ attemptsMade: 2, attempts: 3 })),
      ).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalled();
      const loggedMessages = warnSpy.mock.calls.map((call) => String(call[0]));
      for (const message of loggedMessages) {
        expect(message).not.toContain(secret);
        expect(message).not.toContain("super-secret-password");
      }
      expect(loggedMessages.some((message) => message.includes("category=unknown_error"))).toBe(
        true,
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("スナップショット取得(SELECT)が10秒応答しない場合、withDbTimeout が NoteEnrichmentDbTimeoutError で10秒タイムアウトさせ、BullMQ へ渡る例外は db_timeout のサニタイズ済みメッセージになる(withDbTimeout のタイムアウト分岐の回帰テスト)", async () => {
    vi.useFakeTimers();
    try {
      const db = createNeverResolvingDb();
      const { factory, factorySpy } = createFakeEmbeddingClientFactory();
      const processor = new NoteEnrichmentProcessor(db, factory);

      const resultPromise = processor.process(createFakeJob({ attemptsMade: 0, attempts: 3 }));
      const assertion = resultPromise.then(
        () => {
          throw new Error("expected process() to reject");
        },
        (err: unknown) => err as Error,
      );
      await vi.advanceTimersByTimeAsync(10_000);
      const thrown = await assertion;

      expect(thrown.name).toBe("SanitizedNoteEnrichmentError");
      expect(thrown.message).toBe("note enrichment db operation timed out");
      expect(factorySpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("markFailed はジョブ開始時のスナップショット条件付き UPDATE(CAS)で保護される(id・updated_at・内容列の BINARY <=> 比較を含む)", async () => {
    const executeSpy = vi.fn();
    const db = createFakeDb({
      executeQueue: [
        [[rawRow({ embedding_fingerprint: "old" })], []],
        [{ affectedRows: 1 }, []],
      ],
      executeSpy,
    });
    const { factory } = createFakeEmbeddingClientFactory(new Error("openai failure"));
    const processor = new NoteEnrichmentProcessor(db, factory);

    await processor.process(createFakeJob({ attemptsMade: 2, attempts: 3 }));

    const sqlText = extractSqlText(executeSpy.mock.calls[1][0]);
    expect(sqlText).toContain("id =");
    expect(sqlText).toContain("updated_at =");
    expect(sqlText).toContain("deleted_at IS NULL");
    expect(sqlText).toContain("BINARY title <=>");
    expect(sqlText).toContain("BINARY summary <=>");
    expect(sqlText).toContain("BINARY body <=>");
    expect(sqlText).toContain("BINARY extracted_text <=>");
    expect(sqlText).toContain("BINARY tags <=>");
  });

  it("内容列の CAS 比較は BINARY を付けてバイト単位で比較する(照合順序が case-insensitive のため、素の <=> だと大文字小文字のみの変更を誤って「一致」判定してしまう。Codex 再レビュー HIGH 指摘対応)", async () => {
    const stored = rawRow({ embedding_fingerprint: "old-fingerprint" });
    const executeSpy = vi.fn();
    const db = createFakeDb({
      executeQueue: [
        [[stored], []],
        [{ affectedRows: 1 }, []],
      ],
      executeSpy,
    });
    const { factory } = createFakeEmbeddingClientFactory();
    const processor = new NoteEnrichmentProcessor(db, factory);

    await processor.process(createFakeJob({}));

    // writeBackEmbedding の UPDATE(2回目の execute 呼び出し)。
    const sqlText = extractSqlText(executeSpy.mock.calls[1][0]);
    expect(sqlText).toContain("BINARY title <=>");
    expect(sqlText).toContain("BINARY summary <=>");
    expect(sqlText).toContain("BINARY body <=>");
    expect(sqlText).toContain("BINARY extracted_text <=>");
    expect(sqlText).toContain("BINARY tags <=>");
  });

  it("OpenAI 呼び出し中に論理削除された(deleted_at が設定され、updated_at・内容列は開始時と同一秒のまま不変)場合、writeBackEmbedding の UPDATE は deleted_at IS NULL を CAS 条件に含み、削除済みノートへは書き戻さない(Codex D0 レビュー MEDIUM 指摘への対応)", async () => {
    const stored = rawRow({ embedding_fingerprint: "old-fingerprint" });
    const executeSpy = vi.fn();
    const db = createFakeDb({
      executeQueue: [
        [[stored], []],
        // 実 DB では、行取得後に論理削除が入っていると `deleted_at IS NULL` が不一致となり
        // affected rows = 0 になる(この単体テストではそのモジュール外の DB 挙動を実行できない
        // ため、UPDATE 文に条件が含まれることと、affected rows = 0 でも正常終了することの
        // 2点を検証する。実 DB での確認は note-enrichment.integration.spec.ts で行う)。
        [{ affectedRows: 0 }, []],
      ],
      executeSpy,
    });
    const { factory } = createFakeEmbeddingClientFactory();
    const processor = new NoteEnrichmentProcessor(db, factory);

    await expect(processor.process(createFakeJob({}))).resolves.toBeUndefined();

    expect(executeSpy).toHaveBeenCalledTimes(2);
    const updateQuery: unknown = executeSpy.mock.calls[1][0];
    const sqlText = extractSqlText(updateQuery);
    expect(sqlText).toContain("deleted_at IS NULL");
  });

  it("markFailed の CAS はジョブ開始時スナップショットの embedding_fingerprint・enrichment_status も <=> 比較する(遅延成功した書き戻しを誤って上書きしないため。Codex D0 レビュー HIGH 指摘への対応)", async () => {
    const executeSpy = vi.fn();
    const db = createFakeDb({
      executeQueue: [
        [[rawRow({ embedding_fingerprint: "old", enrichment_status: "pending" })], []],
        [{ affectedRows: 1 }, []],
      ],
      executeSpy,
    });
    const { factory } = createFakeEmbeddingClientFactory(new Error("openai failure"));
    const processor = new NoteEnrichmentProcessor(db, factory);

    await processor.process(createFakeJob({ attemptsMade: 2, attempts: 3 }));

    const sqlText = extractSqlText(executeSpy.mock.calls[1][0]);
    expect(sqlText).toContain("embedding_fingerprint <=> old");
    expect(sqlText).toContain("enrichment_status <=> pending");
  });

  it("writeBackEmbedding がアプリケーションタイムアウト後に遅れて成功した場合(embedding_fingerprint・enrichment_status がスナップショットと異なる状態に変化)、markFailed の CAS は不一致となり affected rows 0 を模擬しても正常終了する(completed な行を failed で上書きしない)", async () => {
    const db = createFakeDb({
      executeQueue: [
        [[rawRow({ embedding_fingerprint: "old", enrichment_status: "pending" })], []],
        // 遅延成功した writeBackEmbedding により実際の行は embedding_fingerprint='new-fp'・
        // enrichment_status='completed' へ既に遷移済み。markFailedCasCondition の
        // embedding_fingerprint/enrichment_status <=> 比較がスナップショット(old/pending)と
        // 一致しないため、実 DB では affected rows = 0 になる(ここではその結果を模擬する)。
        [{ affectedRows: 0 }, []],
      ],
    });
    const { factory } = createFakeEmbeddingClientFactory(new Error("openai failure"));
    const processor = new NoteEnrichmentProcessor(db, factory);

    await expect(
      processor.process(createFakeJob({ attemptsMade: 2, attempts: 3 })),
    ).resolves.toBeUndefined();
  });

  it("markFailed の CAS が不一致(affected rows 0。実行中に PUT 更新が入った)場合でもエラーにならず正常終了する(実 DB での pending 維持・収束の確認は note-enrichment.integration.spec.ts で行う)", async () => {
    const db = createFakeDb({
      executeQueue: [
        [[rawRow({ embedding_fingerprint: "old" })], []],
        // affected rows = 0(CAS 不一致)を模擬。writeBackEmbedding と同じ設計方針により、
        // このモジュールは affectedRows の値を検査せず常に正常終了する。
        [{ affectedRows: 0 }, []],
      ],
    });
    const { factory } = createFakeEmbeddingClientFactory(new Error("openai failure"));
    const processor = new NoteEnrichmentProcessor(db, factory);

    await expect(
      processor.process(createFakeJob({ attemptsMade: 2, attempts: 3 })),
    ).resolves.toBeUndefined();
  });

  it("OPENAI_API_KEY 未設定等でクライアント生成自体が例外を投げる場合も、最終試行なら failed で正常終了する", async () => {
    const executeSpy = vi.fn();
    const db = createFakeDb({
      executeQueue: [
        [[rawRow({ embedding_fingerprint: "old" })], []],
        [{ affectedRows: 1 }, []],
      ],
      executeSpy,
    });
    const factory = vi.fn(() => {
      throw new Error("OPENAI_API_KEY must be set to a non-empty value");
    }) as unknown as OpenAiEmbeddingClientFactory;
    const processor = new NoteEnrichmentProcessor(db, factory);

    await expect(
      processor.process(createFakeJob({ attemptsMade: 2, attempts: 3 })),
    ).resolves.toBeUndefined();

    expect(extractSqlText(executeSpy.mock.calls[1][0])).toContain("enrichment_status = 'failed'");
  });

  it("最終試行での markFailed 自体が失敗した場合は、サニタイズ済みの例外を re-throw する(原例外のメッセージ・スタックは含まれない。Codex 再レビュー HIGH 指摘対応)", async () => {
    // 実在の秘密ではなくサニタイズ回帰テスト用のダミー文字列。実際の接続文字列の形にすると
    // secretlint が「本物の秘密の混入」として検出し、pre-commit を止めてしまう(この検査は
    // 本物の秘密を防ぐ最後の砦なので allowlist で緩めない)。スキーム部を実在しない値にして
    // 検出パターンを避けつつ、「秘密らしい文字列が例外・スタックへ漏れないこと」の検証という
    // テストの目的は保つ。
    const secret = "db failure marking failed: dummy-scheme://user:super-secret-password@host/db";
    const db = createFakeDb({
      executeQueue: [[[rawRow({ embedding_fingerprint: "old" })], []], new Error(secret)],
    });
    const { factory } = createFakeEmbeddingClientFactory(new Error("openai failure"));
    const processor = new NoteEnrichmentProcessor(db, factory);

    const thrown: Error = await processor
      .process(createFakeJob({ attemptsMade: 2, attempts: 3 }))
      .then(
        () => {
          throw new Error("expected process() to reject");
        },
        (err: unknown) => err as Error,
      );

    expect(thrown.message).toBe("note enrichment operation failed");
    expect(thrown.message).not.toContain(secret);
    expect(thrown.message).not.toContain("super-secret-password");
    expect(String(thrown.stack)).not.toContain("super-secret-password");
    expect((thrown as { cause?: unknown }).cause).toBeUndefined();
  });

  it("スナップショット取得(SELECT)の失敗も、BullMQ へ渡る例外はサニタイズされ、原例外に含まれる秘密情報を含まない(回帰テスト。Codex 再レビュー HIGH 指摘対応)", async () => {
    // 上記と同じくサニタイズ回帰テスト用のダミー文字列(実在の秘密ではない)。
    // secretlint の接続文字列検出を避けるためスキーム部を実在しない値にしている。

    const secret =
      "connect ECONNREFUSED dummy-scheme://root:super-secret-db-password@127.0.0.1:3306";
    const db = createFakeDb({
      executeQueue: [new Error(secret)],
    });
    const { factory, factorySpy } = createFakeEmbeddingClientFactory();
    const processor = new NoteEnrichmentProcessor(db, factory);

    const thrown: Error = await processor
      .process(createFakeJob({ attemptsMade: 0, attempts: 3 }))
      .then(
        () => {
          throw new Error("expected process() to reject");
        },
        (err: unknown) => err as Error,
      );

    expect(thrown.message).not.toContain(secret);
    expect(thrown.message).not.toContain("super-secret-db-password");
    expect(String(thrown.stack)).not.toContain("super-secret-db-password");
    expect((thrown as { cause?: unknown }).cause).toBeUndefined();
    expect(factorySpy).not.toHaveBeenCalled();
  });

  it("書き戻し(writeBackEmbedding の UPDATE)の失敗も、BullMQ へ渡る例外はサニタイズされ、原例外に含まれる秘密情報を含まない(回帰テスト。Codex 再レビュー HIGH 指摘対応)", async () => {
    // 上記と同じくサニタイズ回帰テスト用のダミー文字列(実在の秘密ではない)。
    // eslint-disable-next-line sonarjs/no-hardcoded-passwords
    const secret = "mysql write failed: user=root password=super-secret-write-password";
    const db = createFakeDb({
      executeQueue: [[[rawRow({ embedding_fingerprint: "old" })], []], new Error(secret)],
    });
    const { factory } = createFakeEmbeddingClientFactory();
    const processor = new NoteEnrichmentProcessor(db, factory);

    const thrown: Error = await processor
      .process(createFakeJob({ attemptsMade: 0, attempts: 3 }))
      .then(
        () => {
          throw new Error("expected process() to reject");
        },
        (err: unknown) => err as Error,
      );

    expect(thrown.message).not.toContain(secret);
    expect(thrown.message).not.toContain("super-secret-write-password");
    expect(String(thrown.stack)).not.toContain("super-secret-write-password");
    expect((thrown as { cause?: unknown }).cause).toBeUndefined();
  });

  describe("不正な job.data(payload)の検証(Codex 最終セキュリティ監査 LOW 指摘対応)", () => {
    // job.data の分解・job.opts の参照が外側 try の内側に移動したことで、不正な payload に
    // 対しても生の TypeError ではなく、必ずサニタイズ済みの Error(payload の中身を含まない)が
    // 投げられることを検証する。いずれのケースも noteId 解決より前に失敗するため、DB(execute)
    // へは一切アクセスしない。

    it("noteId が UUID 形式でない場合、サニタイズ済みの Error を投げ、payload の中身(noteId の値)がメッセージ・スタックに含まれない", async () => {
      const secret = "not-a-uuid-but-looks-like-a-secret-token-xyz";
      const executeSpy = vi.fn();
      const db = createFakeDb({ executeQueue: [], executeSpy });
      const { factory, factorySpy } = createFakeEmbeddingClientFactory();
      const processor = new NoteEnrichmentProcessor(db, factory);

      const thrown: Error = await processor.process(createFakeJob({ noteId: secret })).then(
        () => {
          throw new Error("expected process() to reject");
        },
        (err: unknown) => err as Error,
      );

      expect(thrown.message).toBe("note enrichment job payload is invalid");
      expect(thrown.message).not.toContain(secret);
      expect(String(thrown.stack)).not.toContain(secret);
      expect((thrown as { cause?: unknown }).cause).toBeUndefined();
      expect(executeSpy).not.toHaveBeenCalled();
      expect(factorySpy).not.toHaveBeenCalled();
    });

    it("noteId が欠落している場合、サニタイズ済みの Error を投げ、payload の中身がメッセージ・スタックに含まれない", async () => {
      const secretField = "unexpectedSecretField-abc123";
      const executeSpy = vi.fn();
      const db = createFakeDb({ executeQueue: [], executeSpy });
      const { factory, factorySpy } = createFakeEmbeddingClientFactory();
      const processor = new NoteEnrichmentProcessor(db, factory);

      const thrown: Error = await processor
        .process(createFakeJobWithRawData({ [secretField]: "value" }))
        .then(
          () => {
            throw new Error("expected process() to reject");
          },
          (err: unknown) => err as Error,
        );

      expect(thrown.message).toBe("note enrichment job payload is invalid");
      expect(thrown.message).not.toContain(secretField);
      expect(String(thrown.stack)).not.toContain(secretField);
      expect((thrown as { cause?: unknown }).cause).toBeUndefined();
      expect(executeSpy).not.toHaveBeenCalled();
      expect(factorySpy).not.toHaveBeenCalled();
    });

    it("job.data が null の場合、サニタイズ済みの Error を投げ、生の TypeError を伝播させない", async () => {
      const executeSpy = vi.fn();
      const db = createFakeDb({ executeQueue: [], executeSpy });
      const { factory, factorySpy } = createFakeEmbeddingClientFactory();
      const processor = new NoteEnrichmentProcessor(db, factory);

      const thrown: Error = await processor.process(createFakeJobWithRawData(null)).then(
        () => {
          throw new Error("expected process() to reject");
        },
        (err: unknown) => err as Error,
      );

      expect(thrown.name).toBe("SanitizedNoteEnrichmentError");
      expect(thrown.message).toBe("note enrichment job payload is invalid");
      expect((thrown as { cause?: unknown }).cause).toBeUndefined();
      expect(executeSpy).not.toHaveBeenCalled();
      expect(factorySpy).not.toHaveBeenCalled();
    });

    it("noteId が文字列でない場合(型不一致)、サニタイズ済みの Error を投げる", async () => {
      const executeSpy = vi.fn();
      const db = createFakeDb({ executeQueue: [], executeSpy });
      const { factory } = createFakeEmbeddingClientFactory();
      const processor = new NoteEnrichmentProcessor(db, factory);

      const thrown: Error = await processor
        .process(createFakeJobWithRawData({ noteId: 12345 }))
        .then(
          () => {
            throw new Error("expected process() to reject");
          },
          (err: unknown) => err as Error,
        );

      expect(thrown.message).toBe("note enrichment job payload is invalid");
      expect(executeSpy).not.toHaveBeenCalled();
    });
  });
});
