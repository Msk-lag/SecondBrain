import type { Database } from "@secondbrain/db";
import { NoteEnrichmentDbTimeoutError } from "./sanitize-enrichment-error";
import { RelationJudgeError } from "./relation-judge.client";
import type { RelationJudgeClient, RelationJudgeResultItem } from "./relation-judge.client";
import { runRelationStage, type RelationStageSourceContent } from "./relation-stage";

type ExecuteResult = [unknown[], unknown[]] | [{ affectedRows: number }, unknown[]];

interface FakeDbConfig {
  executeQueue?: Array<ExecuteResult | Error>;
  executeSpy?: (query: unknown) => void;
  txExecuteQueue?: Array<ExecuteResult | Error>;
  txExecuteSpy?: (query: unknown) => void;
}

function createFakeDb(config: FakeDbConfig): Database {
  const executeQueue = [...(config.executeQueue ?? [])];
  const txExecuteQueue = [...(config.txExecuteQueue ?? [])];

  return {
    execute: (query: unknown) => {
      config.executeSpy?.(query);
      const next = executeQueue.shift();
      if (next instanceof Error) {
        return Promise.reject(next);
      }
      return Promise.resolve(next ?? [[], []]);
    },
    transaction: async (
      callback: (tx: { execute: (query: unknown) => Promise<unknown> }) => Promise<void>,
    ) => {
      const tx = {
        execute: (query: unknown) => {
          config.txExecuteSpy?.(query);
          const next = txExecuteQueue.shift();
          if (next instanceof Error) {
            return Promise.reject(next);
          }
          return Promise.resolve(next ?? [[], []]);
        },
      };
      return callback(tx);
    },
  } as unknown as Database;
}

/**
 * note-enrichment.processor.spec.ts と同じダックタイピングによる SQL 文字列復元ヘルパー。
 */
function extractSqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks;
  if (!Array.isArray(chunks)) {
    return "";
  }
  return chunks
    .map((chunk) => {
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

function createFakeJudgeClient(result: RelationJudgeResultItem[] | Error = []): {
  client: RelationJudgeClient;
  judge: ReturnType<typeof vi.fn>;
} {
  const judge =
    result instanceof Error ? vi.fn().mockRejectedValue(result) : vi.fn().mockResolvedValue(result);
  return { client: { judge }, judge };
}

const NOTE_ID = "note-source";
const FINGERPRINT = "fingerprint-current";
const SOURCE: RelationStageSourceContent = {
  title: "title",
  summary: "summary",
  body: "body",
  extractedText: null,
};

function casRow(
  overrides: Partial<{
    user_id: string;
    relation_status: string | null;
    relation_fingerprint: string | null;
  }> = {},
) {
  return {
    user_id: "user-1",
    relation_status: "pending",
    relation_fingerprint: "old-fingerprint",
    ...overrides,
  };
}

function candidateRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "candidate-1",
    title: "候補",
    type: "memo",
    summary: "候補要約",
    body: "候補本文",
    extracted_text: null,
    embedding_fingerprint: "fp-candidate-1",
    ...overrides,
  };
}

/**
 * S1(関係ステージ専用 CAS)・S2(updated_at 固定)の不変条件を検証する共通ヘルパー。
 * claim / markRelationCompleted / markRelationFailed の各 UPDATE で必ず成立すべき条件を
 * 1つずつ個別に assert する(1つでも欠けたら落ちる粒度にする。Codex D0 レビュー MEDIUM 指摘[4])。
 * これにより、専用 CAS の条件(deleted_at IS NULL・embedding_fingerprint 一致・
 * enrichment_status='completed')のいずれかが欠落した実装や、旧来の埋め込み CAS(内容列5つの
 * BINARY <=> 比較)を誤って持ち込んだ実装、updated_at を進めてしまう実装(並行 enrichment の
 * CAS を壊し、回収バッチのデバウンスを延長する)を検知できる。
 */
function expectRelationCasUpdate(sqlText: string): void {
  expect(sqlText).toContain("deleted_at IS NULL");
  expect(sqlText).toContain("embedding_fingerprint =");
  expect(sqlText).toContain("enrichment_status = 'completed'");
  expect(sqlText).toContain("updated_at = updated_at");
  // 退行検知: 旧埋め込み CAS(内容列5つの BINARY <=> 比較)を誤って持ち込んでいないこと(S1)。
  expect(sqlText).not.toContain("BINARY ");
  // 退行検知: updated_at を進める実装になっていないこと(S2)。進めると並行 enrichment の CAS を
  // 壊し、回収バッチのデバウンスを延長してしまう。
  expect(sqlText).not.toMatch(/updated_at\s*=\s*(CURRENT_TIMESTAMP|NOW\(\))/i);
}

describe("runRelationStage", () => {
  it("手順0: 現在行が無い(CAS 不一致)場合、claim・候補取得・Claude を呼ばず正常終了する", async () => {
    const executeSpy = vi.fn();
    const db = createFakeDb({ executeQueue: [[[], []]], executeSpy });
    const { client, judge } = createFakeJudgeClient();

    await expect(
      runRelationStage(db, client, NOTE_ID, FINGERPRINT, SOURCE, false),
    ).resolves.toBeUndefined();

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(judge).not.toHaveBeenCalled();
  });

  it("手順0: relation_status='completed' かつ fingerprint 一致の場合、Claude を呼ばず正常終了する(冪等スキップ)", async () => {
    const db = createFakeDb({
      executeQueue: [
        [[casRow({ relation_status: "completed", relation_fingerprint: FINGERPRINT })], []],
      ],
    });
    const { client, judge } = createFakeJudgeClient();

    await runRelationStage(db, client, NOTE_ID, FINGERPRINT, SOURCE, false);

    expect(judge).not.toHaveBeenCalled();
  });

  it("relation_status='failed' の行はスキップされず再判定される(fingerprint 不一致なら completed でも再判定される)", async () => {
    const executeSpy = vi.fn();
    const db = createFakeDb({
      executeQueue: [
        [[casRow({ relation_status: "failed", relation_fingerprint: "old-fingerprint" })], []],
        [{ affectedRows: 1 }, []],
        [[], []],
        [{ affectedRows: 1 }, []],
      ],
      executeSpy,
    });
    const { client } = createFakeJudgeClient();

    await runRelationStage(db, client, NOTE_ID, FINGERPRINT, SOURCE, false);

    // SELECT → claim UPDATE → candidates SELECT(0件)→ markRelationCompleted UPDATE
    expect(executeSpy).toHaveBeenCalledTimes(4);
  });

  it("claim 後に候補取得が失敗し最終試行の場合、relation_status='failed' を書いて正常終了する(pending のまま終端しないと relationStatus が永久に generating になる。Codex D0 レビュー HIGH 指摘)", async () => {
    const executeSpy = vi.fn();
    const db = createFakeDb({
      executeQueue: [
        [[casRow()], []],
        [{ affectedRows: 1 }, []],
        new Error("candidate fetch failed"),
        [{ affectedRows: 1 }, []],
      ],
      executeSpy,
    });
    const { client, judge } = createFakeJudgeClient();

    await expect(
      runRelationStage(db, client, NOTE_ID, FINGERPRINT, SOURCE, true),
    ).resolves.toBeUndefined();

    expect(judge).not.toHaveBeenCalled();
    // SELECT → claim UPDATE → candidates SELECT(失敗)→ markRelationFailed UPDATE
    expect(executeSpy).toHaveBeenCalledTimes(4);
    const markFailedSqlText = extractSqlText(executeSpy.mock.calls[3][0]);
    expect(markFailedSqlText).toContain("relation_status = 'failed'");
    // S1/S2: markRelationFailed も専用 CAS・updated_at 固定を満たすこと。
    expectRelationCasUpdate(markFailedSqlText);
  });

  it("claim 後に候補0件の完了記録が失敗し最終試行の場合、relation_status='failed' を書いて正常終了する(同上)", async () => {
    const executeSpy = vi.fn();
    const db = createFakeDb({
      executeQueue: [
        [[casRow()], []],
        [{ affectedRows: 1 }, []],
        [[], []],
        new Error("markRelationCompleted failed"),
        [{ affectedRows: 1 }, []],
      ],
      executeSpy,
    });
    const { client, judge } = createFakeJudgeClient();

    await expect(
      runRelationStage(db, client, NOTE_ID, FINGERPRINT, SOURCE, true),
    ).resolves.toBeUndefined();

    expect(judge).not.toHaveBeenCalled();
    const markFailedSqlText = extractSqlText(executeSpy.mock.calls[4][0]);
    expect(markFailedSqlText).toContain("relation_status = 'failed'");
    expectRelationCasUpdate(markFailedSqlText);
  });

  it("claim 後に候補取得が失敗し非最終試行の場合、re-throw して BullMQ のリトライへ委ねる", async () => {
    const db = createFakeDb({
      executeQueue: [
        [[casRow()], []],
        [{ affectedRows: 1 }, []],
        new Error("candidate fetch failed"),
      ],
    });
    const { client } = createFakeJudgeClient();

    await expect(runRelationStage(db, client, NOTE_ID, FINGERPRINT, SOURCE, false)).rejects.toThrow(
      "candidate fetch failed",
    );
  });

  it("手順0: claim(条件付き UPDATE)が CAS 不一致(affected rows 0)の場合、候補取得・Claude を呼ばず正常終了する", async () => {
    const executeSpy = vi.fn();
    const db = createFakeDb({
      executeQueue: [
        [[casRow()], []],
        [{ affectedRows: 0 }, []],
      ],
      executeSpy,
    });
    const { client, judge } = createFakeJudgeClient();

    await runRelationStage(db, client, NOTE_ID, FINGERPRINT, SOURCE, false);

    expect(executeSpy).toHaveBeenCalledTimes(2);
    expect(judge).not.toHaveBeenCalled();
    // S1/S2: claim UPDATE も専用 CAS・updated_at 固定を満たすこと。
    expectRelationCasUpdate(extractSqlText(executeSpy.mock.calls[1][0]));
  });

  it("手順1: 候補0件の場合、markRelationCompleted のみ実行し Claude を呼ばない", async () => {
    const executeSpy = vi.fn();
    const db = createFakeDb({
      executeQueue: [
        [[casRow()], []],
        [{ affectedRows: 1 }, []],
        [[], []],
        [{ affectedRows: 1 }, []],
      ],
      executeSpy,
    });
    const { client, judge } = createFakeJudgeClient();

    await runRelationStage(db, client, NOTE_ID, FINGERPRINT, SOURCE, false);

    expect(judge).not.toHaveBeenCalled();
    expect(executeSpy).toHaveBeenCalledTimes(4);
    // S1/S2: claim UPDATE。
    expectRelationCasUpdate(extractSqlText(executeSpy.mock.calls[1][0]));
    const sqlText = extractSqlText(executeSpy.mock.calls[3][0]);
    expect(sqlText).toContain("relation_status = 'completed'");
    // S1/S2: markRelationCompleted UPDATE。
    expectRelationCasUpdate(sqlText);
  });

  it("正常系: 候補取得 → Claude 判定 → related=true の候補のみエッジを upsert し、同一トランザクションで completed 確定する", async () => {
    const executeSpy = vi.fn();
    const txExecuteSpy = vi.fn();
    const db = createFakeDb({
      executeQueue: [
        [[casRow()], []],
        [{ affectedRows: 1 }, []],
        [[candidateRow({ id: "candidate-1" }), candidateRow({ id: "candidate-2" })], []],
      ],
      executeSpy,
      txExecuteQueue: [
        [[], []],
        [{ affectedRows: 1 }, []],
      ],
      txExecuteSpy,
    });
    const results: RelationJudgeResultItem[] = [
      {
        candidateId: "candidate-1",
        type: "cause-solution",
        direction: "outgoing",
        description: "説明文",
        relatedness: 0.8,
      },
    ];
    const { client, judge } = createFakeJudgeClient(results);

    await runRelationStage(db, client, NOTE_ID, FINGERPRINT, SOURCE, false);

    expect(judge).toHaveBeenCalledTimes(1);
    const [source, candidates] = judge.mock.calls[0] as [unknown, Array<{ id: string }>];
    expect(source).toEqual(SOURCE);
    expect(candidates.map((c) => c.id)).toEqual(["candidate-1", "candidate-2"]);

    // S1/S2: claim UPDATE。
    expectRelationCasUpdate(extractSqlText(executeSpy.mock.calls[1][0]));

    // related=false 相当(結果配列に含まれない candidate-2)はエッジを作らないため、
    // tx.execute は INSERT 1回 + 完了確定 UPDATE 1回の計2回のみ。
    expect(txExecuteSpy).toHaveBeenCalledTimes(2);
    const insertSqlText = extractSqlText(txExecuteSpy.mock.calls[0][0]);

    // S6: upsert が「INSERT ... SELECT」の単文であること(両端点の存在確認と挿入を原子的に
    // 行う)。これが崩れると存在しないノートに対してもエッジが作られ得る。
    expect(insertSqlText).toContain("INSERT INTO note_relations");
    expect(insertSqlText).toContain("FROM notes a");
    expect(insertSqlText).toContain("JOIN notes b");
    // S6: 両端点の deleted_at IS NULL(論理削除済みノートに対してエッジを作らない)。
    expect(insertSqlText).toContain("a.deleted_at IS NULL AND b.deleted_at IS NULL");
    // S6: 両端点の user_id 条件(テナント境界。他ユーザーのノートとエッジを作らせない)。
    expect(insertSqlText).toContain("a.user_id = ");
    expect(insertSqlText).toContain(" AND b.user_id = ");
    // S6: 両端点の enrichment_status = 'completed'(embedding 未生成のノートを対象にしない)。
    expect(insertSqlText).toContain(
      "a.enrichment_status = 'completed' AND b.enrichment_status = 'completed'",
    );
    // S6 の要: 両端点の embedding_fingerprint 条件(判定時に観測した fingerprint)。これが
    // 無いと、Claude 呼び出し中に候補ノートの内容が変わっても古い判定結果でエッジを
    // 作ってしまう(判定と永続化の間の TOCTOU を防ぐための条件)。
    expect(insertSqlText).toContain("a.embedding_fingerprint = ");
    expect(insertSqlText).toContain(" AND b.embedding_fingerprint = ");
    // 実際にバインドされた値(source 側の判定 fingerprint と候補側の embeddingFingerprint)が
    // SQL 中に現れていること(条件が「別の列」に対する偶然の文字列一致でないことを担保)。
    expect(insertSqlText).toContain(FINGERPRINT);
    expect(insertSqlText).toContain("fp-candidate-1");
    // S6: ON DUPLICATE KEY UPDATE は deleted_at IS NULL の行のみを条件付きで更新する
    // (IF(...) による分岐)。これが無いと「削除されたエッジは再生成で復活させない」という
    // 不変条件が崩れる。
    expect(insertSqlText).toContain("ON DUPLICATE KEY UPDATE");
    expect(insertSqlText).toContain("IF(note_relations.deleted_at IS NULL,");
    expect(insertSqlText).toContain("cause-solution");
    expect(insertSqlText).toContain("説明文");

    const completionSqlText = extractSqlText(txExecuteSpy.mock.calls[1][0]);
    expect(completionSqlText).toContain("relation_status = 'completed'");
    // S1/S2: markRelationCompleted UPDATE(同一トランザクション内)。
    expectRelationCasUpdate(completionSqlText);
  });

  it.each([
    // source(NOTE_ID='note-source') と candidateId の大小関係で note_a/note_b が入れ替わり、
    // type_direction が正しく反転する(§設計決定1 の a/b 変換表)。あわせて note_a_id <
    // note_b_id の正規化順で bind されていることも検証する(S7・S6 の「正規化された ID 順で
    // バインドされていること」)。
    ["aaa-candidate", "outgoing", "b-to-a", "aaa-candidate", "note-source"], // source > candidate → source は note_b
    ["aaa-candidate", "incoming", "a-to-b", "aaa-candidate", "note-source"],
    ["zzz-candidate", "outgoing", "a-to-b", "note-source", "zzz-candidate"], // source < candidate → source は note_a
    ["zzz-candidate", "incoming", "b-to-a", "note-source", "zzz-candidate"],
  ])(
    "type_direction の a/b 変換・正規化順序: candidateId=%s, direction=%s → type_direction=%s (note_a=%s, note_b=%s)",
    async (candidateId, direction, expectedTypeDirection, expectedNoteAId, expectedNoteBId) => {
      const txExecuteSpy = vi.fn();
      const db = createFakeDb({
        executeQueue: [
          [[casRow()], []],
          [{ affectedRows: 1 }, []],
          [[candidateRow({ id: candidateId })], []],
        ],
        txExecuteQueue: [
          [[], []],
          [{ affectedRows: 1 }, []],
        ],
        txExecuteSpy,
      });
      const results: RelationJudgeResultItem[] = [
        {
          candidateId,
          type: "cause-solution",
          direction: direction as "outgoing" | "incoming",
          description: "d",
          relatedness: 0.5,
        },
      ];
      const { client } = createFakeJudgeClient(results);

      await runRelationStage(db, client, NOTE_ID, FINGERPRINT, SOURCE, false);

      const insertSqlText = extractSqlText(txExecuteSpy.mock.calls[0][0]);
      expect(insertSqlText).toContain(expectedTypeDirection);
      // S6/S7: note_a_id < note_b_id になるよう正規化された順序でバインドされていること。
      expect(insertSqlText).toContain(`a.id = ${expectedNoteAId} AND b.id = ${expectedNoteBId}`);
    },
  );

  it("候補はあるが全候補 related=false(judge の結果配列が空)の場合、エッジは1件も作らず completed のみ記録する", async () => {
    const txExecuteSpy = vi.fn();
    const db = createFakeDb({
      executeQueue: [
        [[casRow()], []],
        [{ affectedRows: 1 }, []],
        [[candidateRow({ id: "candidate-1" }), candidateRow({ id: "candidate-2" })], []],
      ],
      txExecuteQueue: [[{ affectedRows: 1 }, []]],
      txExecuteSpy,
    });
    const { client, judge } = createFakeJudgeClient([]);

    await runRelationStage(db, client, NOTE_ID, FINGERPRINT, SOURCE, false);

    expect(judge).toHaveBeenCalledTimes(1);
    // INSERT は1回も発行されず、完了確定 UPDATE のみ実行される。
    expect(txExecuteSpy).toHaveBeenCalledTimes(1);
    expect(extractSqlText(txExecuteSpy.mock.calls[0][0])).toContain(
      "relation_status = 'completed'",
    );
  });

  it("S9 の契約(入力していない候補 ID を含む応答は判定失敗)はクライアント境界(relation-judge.client.ts)で担保されており、これは stage 側の多重防御(万一未知 candidateId が届いても不正なエッジを作らないこと)を確認するもの", async () => {
    const txExecuteSpy = vi.fn();
    const db = createFakeDb({
      executeQueue: [
        [[casRow()], []],
        [{ affectedRows: 1 }, []],
        [[candidateRow({ id: "candidate-1" })], []],
      ],
      txExecuteQueue: [[{ affectedRows: 1 }, []]],
      txExecuteSpy,
    });
    const results: RelationJudgeResultItem[] = [
      {
        candidateId: "not-a-known-candidate",
        type: "other",
        direction: "none",
        description: "d",
        relatedness: 0.5,
      },
    ];
    const { client } = createFakeJudgeClient(results);

    await runRelationStage(db, client, NOTE_ID, FINGERPRINT, SOURCE, false);

    // 未知 candidateId に対応するエッジが作られないこと(INSERT が一切発行されない)を明示的に
    // 確認する。これが崩れると、候補集合に無い ID に対して存在確認なしでエッジを作りかねない。
    const allTxSqlTexts = txExecuteSpy.mock.calls.map((call) => extractSqlText(call[0]));
    expect(allTxSqlTexts.some((text) => text.includes("INSERT INTO note_relations"))).toBe(false);
    // INSERT は発行されず、完了確定 UPDATE のみ実行される。
    expect(txExecuteSpy).toHaveBeenCalledTimes(1);
    expect(extractSqlText(txExecuteSpy.mock.calls[0][0])).toContain(
      "relation_status = 'completed'",
    );
  });

  it("判定中に判定元ノートが変更された場合(完了確定 UPDATE の affected rows が1でない)、トランザクション全体が rollback され、非最終試行なら例外が re-throw される(受入条件10)", async () => {
    const txExecuteSpy = vi.fn();
    const db = createFakeDb({
      executeQueue: [
        [[casRow()], []],
        [{ affectedRows: 1 }, []],
        [[candidateRow({ id: "candidate-1" })], []],
      ],
      txExecuteQueue: [
        [[], []],
        [{ affectedRows: 0 }, []],
      ],
      txExecuteSpy,
    });
    const results: RelationJudgeResultItem[] = [
      {
        candidateId: "candidate-1",
        type: "other",
        direction: "none",
        description: "d",
        relatedness: 0.5,
      },
    ];
    const { client } = createFakeJudgeClient(results);

    await expect(runRelationStage(db, client, NOTE_ID, FINGERPRINT, SOURCE, false)).rejects.toThrow(
      "relation stage completion update did not affect exactly one row",
    );
  });

  it("判定中に判定元ノートが変更され、最終試行の場合は re-throw せず relation_status='failed' で正常終了する", async () => {
    const executeSpy = vi.fn();
    const txExecuteSpy = vi.fn();
    const db = createFakeDb({
      executeQueue: [
        [[casRow()], []],
        [{ affectedRows: 1 }, []],
        [[candidateRow({ id: "candidate-1" })], []],
        [{ affectedRows: 1 }, []],
      ],
      executeSpy,
      txExecuteQueue: [
        [[], []],
        [{ affectedRows: 0 }, []],
      ],
      txExecuteSpy,
    });
    const results: RelationJudgeResultItem[] = [
      {
        candidateId: "candidate-1",
        type: "other",
        direction: "none",
        description: "d",
        relatedness: 0.5,
      },
    ];
    const { client } = createFakeJudgeClient(results);

    await expect(
      runRelationStage(db, client, NOTE_ID, FINGERPRINT, SOURCE, true),
    ).resolves.toBeUndefined();

    const markFailedSqlText = extractSqlText(executeSpy.mock.calls[3][0]);
    expect(markFailedSqlText).toContain("relation_status = 'failed'");
    expect(markFailedSqlText).toContain("relation_status = 'pending'");
    // S1/S2: markRelationFailed も専用 CAS・updated_at 固定を満たすこと。
    expectRelationCasUpdate(markFailedSqlText);
  });

  it("Claude 応答が構造不正等(RelationJudgeError, 非再試行)の場合、非最終試行でも re-throw せず relation_status='failed' で正常終了する(再試行対象外)", async () => {
    const executeSpy = vi.fn();
    const db = createFakeDb({
      executeQueue: [
        [[casRow()], []],
        [{ affectedRows: 1 }, []],
        [[candidateRow({ id: "candidate-1" })], []],
        [{ affectedRows: 1 }, []],
      ],
      executeSpy,
    });
    const { client } = createFakeJudgeClient(new RelationJudgeError("structural_invalid"));

    await expect(
      runRelationStage(db, client, NOTE_ID, FINGERPRINT, SOURCE, false),
    ).resolves.toBeUndefined();

    expect(executeSpy).toHaveBeenCalledTimes(4);
    const markFailedSqlText = extractSqlText(executeSpy.mock.calls[3][0]);
    expect(markFailedSqlText).toContain("relation_status = 'failed'");
    // S1/S2: markRelationFailed も専用 CAS・updated_at 固定を満たすこと。
    expectRelationCasUpdate(markFailedSqlText);
  });

  it("Claude 応答が一過性エラー(RelationJudgeError, 再試行対象)かつ非最終試行の場合、re-throw する(次の試行へ委ねる)", async () => {
    const executeSpy = vi.fn();
    const db = createFakeDb({
      executeQueue: [
        [[casRow()], []],
        [{ affectedRows: 1 }, []],
        [[candidateRow({ id: "candidate-1" })], []],
      ],
      executeSpy,
    });
    const { client } = createFakeJudgeClient(new RelationJudgeError("transient"));

    await expect(
      runRelationStage(db, client, NOTE_ID, FINGERPRINT, SOURCE, false),
    ).rejects.toBeInstanceOf(RelationJudgeError);

    // markRelationFailed の UPDATE は実行されない(次の試行に委ねる)。
    expect(executeSpy).toHaveBeenCalledTimes(3);
  });

  it("手順0(現在行の再確認・claim)で DB エラーが発生し非最終試行の場合、markRelationFailed を書かずにそのまま伝播する(この試行ではまだ relation_status='pending' を書いていないため、終端しないまま残る状態が無い。次の試行へ委ねる)", async () => {
    vi.useFakeTimers();
    try {
      const db = {
        execute: () => new Promise<never>(() => undefined),
      } as unknown as Database;
      const { client, judge } = createFakeJudgeClient();

      const resultPromise = runRelationStage(db, client, NOTE_ID, FINGERPRINT, SOURCE, false);
      const assertion = resultPromise.then(
        () => {
          throw new Error("expected runRelationStage to reject");
        },
        (err: unknown) => err,
      );
      await vi.advanceTimersByTimeAsync(10_000);
      const thrown = await assertion;

      expect(thrown).toBeInstanceOf(NoteEnrichmentDbTimeoutError);
      expect(judge).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("手順0(現在行の再確認・claim)で DB エラーが発生し最終試行の場合、伝播させる前に markRelationFailed を best-effort で試みてから元のエラーを伝播する(前の試行が書いた relation_status='pending' が取り残されるのを防ぐ。Codex D0 レビュー HIGH 指摘[1])", async () => {
    const executeSpy = vi.fn();
    const dbError = new Error("db connection lost");
    const db = createFakeDb({
      executeQueue: [dbError, [{ affectedRows: 1 }, []]],
      executeSpy,
    });
    const { client, judge } = createFakeJudgeClient();

    await expect(runRelationStage(db, client, NOTE_ID, FINGERPRINT, SOURCE, true)).rejects.toThrow(
      "db connection lost",
    );

    expect(judge).not.toHaveBeenCalled();
    // 手順0の DB エラー(1回目)→ markRelationFailed の best-effort UPDATE(2回目)。
    expect(executeSpy).toHaveBeenCalledTimes(2);
    const markFailedSqlText = extractSqlText(executeSpy.mock.calls[1][0]);
    expect(markFailedSqlText).toContain("relation_status = 'failed'");
    expect(markFailedSqlText).toContain("relation_status = 'pending'");
  });

  it("手順0(現在行の再確認・claim)で DB エラーが発生し最終試行かつ markRelationFailed 自体も失敗する場合、その失敗は握り潰され元のエラーが伝播する(best-effort なので markRelationFailed の失敗で元のエラーを覆い隠さない)", async () => {
    const dbError = new Error("db connection lost");
    const markFailedError = new Error("markRelationFailed also failed");
    const db = createFakeDb({
      executeQueue: [dbError, markFailedError],
    });
    const { client, judge } = createFakeJudgeClient();

    await expect(runRelationStage(db, client, NOTE_ID, FINGERPRINT, SOURCE, true)).rejects.toThrow(
      "db connection lost",
    );

    expect(judge).not.toHaveBeenCalled();
  });
});
