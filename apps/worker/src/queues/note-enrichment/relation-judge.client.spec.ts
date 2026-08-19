import {
  AnthropicRelationJudgeClient,
  createRelationJudgeClientFromEnv,
  isRelationJudgeErrorRetryable,
  RelationJudgeError,
  RELATION_JUDGE_REQUEST_TIMEOUT_MS,
  RELATION_JUDGE_TITLE_MAX_LENGTH,
  RELATION_JUDGE_SUMMARY_MAX_LENGTH,
  RELATION_JUDGE_BODY_MAX_LENGTH,
  type RelationJudgeCandidateInput,
  type RelationJudgeNoteInput,
} from "./relation-judge.client";

const { createMock, constructorMock, MockAPIError } = vi.hoisted(() => {
  class MockAPIError extends Error {
    status?: number;
    constructor(message: string, status?: number) {
      super(message);
      this.name = "APIError";
      this.status = status;
    }
  }
  return {
    createMock: vi.fn(),
    constructorMock: vi.fn(),
    MockAPIError,
  };
});

vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    static readonly APIError = MockAPIError;
    messages = { create: createMock };
    constructor(options: unknown) {
      constructorMock(options);
    }
  }
  return { default: MockAnthropic };
});

function textResponse(payload: unknown, stopReason = "end_turn"): unknown {
  return {
    stop_reason: stopReason,
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

/**
 * content に "text" ブロックが含まれない応答(例: tool_use のみ、または空配列)。
 * `isTextContentBlock` による find が undefined を返す分岐(relation-judge.client.ts の
 * `if (!textBlock)` 節)を検証するためのヘルパー。textResponse の隣に置く。
 */
function noTextBlockResponse(content: unknown[], stopReason = "end_turn"): unknown {
  return {
    stop_reason: stopReason,
    content,
  };
}

const SOURCE: RelationJudgeNoteInput = {
  title: "source title",
  summary: "source summary",
  body: "source body",
  extractedText: null,
};

const CANDIDATES: RelationJudgeCandidateInput[] = [
  { id: "candidate-1", title: "c1", summary: "s1", body: "b1", extractedText: null },
  { id: "candidate-2", title: "c2", summary: "s2", body: "b2", extractedText: null },
];

describe("AnthropicRelationJudgeClient", () => {
  beforeEach(() => {
    createMock.mockReset();
    constructorMock.mockReset();
  });

  it("constructs the Anthropic client with maxRetries: 0", () => {
    const client = new AnthropicRelationJudgeClient("api-key");
    expect(client).toBeInstanceOf(AnthropicRelationJudgeClient);
    expect(constructorMock).toHaveBeenCalledWith({ apiKey: "api-key", maxRetries: 0 });
  });

  it("passes timeout: 60_000 and returns normalized related=true results only", async () => {
    createMock.mockResolvedValue(
      textResponse({
        results: [
          {
            candidateId: "candidate-1",
            related: true,
            type: "cause-solution",
            direction: "outgoing",
            description: "説明文",
            relatedness: 0.734,
          },
          { candidateId: "candidate-2", related: false },
        ],
      }),
    );
    const client = new AnthropicRelationJudgeClient("api-key");

    const results = await client.judge(SOURCE, CANDIDATES, "note-1");

    expect(RELATION_JUDGE_REQUEST_TIMEOUT_MS).toBe(60_000);
    expect(createMock.mock.calls[0][1]).toEqual({ timeout: RELATION_JUDGE_REQUEST_TIMEOUT_MS });
    expect(results).toEqual([
      {
        candidateId: "candidate-1",
        type: "cause-solution",
        direction: "outgoing",
        description: "説明文",
        relatedness: 0.73,
      },
    ]);
  });

  it("candidateId が欠落している候補は related=false 相当として結果配列に含まれない(欠落は許容)", async () => {
    createMock.mockResolvedValue(textResponse({ results: [] }));
    const client = new AnthropicRelationJudgeClient("api-key");

    const results = await client.judge(SOURCE, CANDIDATES, "note-1");

    expect(results).toEqual([]);
  });

  it("truncates title/summary/body(またはextractedText)を上限で切り詰めてリクエストへ含める", async () => {
    createMock.mockResolvedValue(textResponse({ results: [] }));
    const client = new AnthropicRelationJudgeClient("api-key");

    const longSource: RelationJudgeNoteInput = {
      title: "t".repeat(RELATION_JUDGE_TITLE_MAX_LENGTH + 10),
      summary: "s".repeat(RELATION_JUDGE_SUMMARY_MAX_LENGTH + 10),
      body: "b".repeat(RELATION_JUDGE_BODY_MAX_LENGTH + 10),
      extractedText: null,
    };
    await client.judge(longSource, CANDIDATES, "note-1");

    const requestParams = createMock.mock.calls[0][0] as { messages: Array<{ content: string }> };
    const sentContent = JSON.parse(requestParams.messages[0].content) as {
      source: { title: string; summary: string; bodyOrExtractedText: string };
    };
    expect(sentContent.source.title).toHaveLength(RELATION_JUDGE_TITLE_MAX_LENGTH);
    expect(sentContent.source.summary).toHaveLength(RELATION_JUDGE_SUMMARY_MAX_LENGTH);
    expect(sentContent.source.bodyOrExtractedText).toHaveLength(RELATION_JUDGE_BODY_MAX_LENGTH);
  });

  it("body が null の場合は extractedText を使う(truncateNote の body ?? extractedText)", async () => {
    createMock.mockResolvedValue(textResponse({ results: [] }));
    const client = new AnthropicRelationJudgeClient("api-key");

    await client.judge(
      { title: null, summary: null, body: null, extractedText: "extracted text here" },
      CANDIDATES,
      "note-1",
    );

    const requestParams = createMock.mock.calls[0][0] as { messages: Array<{ content: string }> };
    const sentContent = JSON.parse(requestParams.messages[0].content) as {
      source: { bodyOrExtractedText: string };
    };
    expect(sentContent.source.bodyOrExtractedText).toBe("extracted text here");
  });

  it("rejects with a refusal RelationJudgeError (non-retryable) when stop_reason is refusal", async () => {
    createMock.mockResolvedValue(textResponse({ results: [] }, "refusal"));
    const client = new AnthropicRelationJudgeClient("api-key");

    const error: unknown = await client
      .judge(SOURCE, CANDIDATES, "note-1")
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(RelationJudgeError);
    expect((error as RelationJudgeError).category).toBe("refusal");
    expect(isRelationJudgeErrorRetryable(error)).toBe(false);
  });

  it("rejects with a structural_invalid RelationJudgeError (non-retryable) when the response text is not valid JSON", async () => {
    createMock.mockResolvedValue({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "not json at all" }],
    });
    const client = new AnthropicRelationJudgeClient("api-key");

    const error: unknown = await client
      .judge(SOURCE, CANDIDATES, "note-1")
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(RelationJudgeError);
    expect((error as RelationJudgeError).category).toBe("structural_invalid");
    expect(isRelationJudgeErrorRetryable(error)).toBe(false);
  });

  it("rejects with a structural_invalid RelationJudgeError (non-retryable) when the response content has no text block (e.g. tool_use only)", async () => {
    createMock.mockResolvedValue(
      noTextBlockResponse([{ type: "tool_use", id: "tool-1", name: "x", input: {} }]),
    );
    const client = new AnthropicRelationJudgeClient("api-key");

    const error: unknown = await client
      .judge(SOURCE, CANDIDATES, "note-1")
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(RelationJudgeError);
    expect((error as RelationJudgeError).category).toBe("structural_invalid");
    expect(isRelationJudgeErrorRetryable(error)).toBe(false);
  });

  it("rejects with a structural_invalid RelationJudgeError (non-retryable) when the response content is an empty array", async () => {
    createMock.mockResolvedValue(noTextBlockResponse([]));
    const client = new AnthropicRelationJudgeClient("api-key");

    const error: unknown = await client
      .judge(SOURCE, CANDIDATES, "note-1")
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(RelationJudgeError);
    expect((error as RelationJudgeError).category).toBe("structural_invalid");
    expect(isRelationJudgeErrorRetryable(error)).toBe(false);
  });

  it("rejects with a structural_invalid RelationJudgeError when a required key is missing (candidateId)", async () => {
    createMock.mockResolvedValue(textResponse({ results: [{ related: true }] }));
    const client = new AnthropicRelationJudgeClient("api-key");

    const error: unknown = await client
      .judge(SOURCE, CANDIDATES, "note-1")
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(RelationJudgeError);
    expect((error as RelationJudgeError).category).toBe("structural_invalid");
  });

  it("rejects with a structural_invalid RelationJudgeError when related=true item is missing type/direction/description/relatedness", async () => {
    createMock.mockResolvedValue(
      textResponse({ results: [{ candidateId: "candidate-1", related: true }] }),
    );
    const client = new AnthropicRelationJudgeClient("api-key");

    const error: unknown = await client
      .judge(SOURCE, CANDIDATES, "note-1")
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(RelationJudgeError);
    expect((error as RelationJudgeError).category).toBe("structural_invalid");
  });

  it("rejects with a response_invalid RelationJudgeError when an unknown candidateId is referenced (does not silently discard)", async () => {
    createMock.mockResolvedValue(
      textResponse({ results: [{ candidateId: "not-a-real-candidate", related: false }] }),
    );
    const client = new AnthropicRelationJudgeClient("api-key");

    const error: unknown = await client
      .judge(SOURCE, CANDIDATES, "note-1")
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(RelationJudgeError);
    expect((error as RelationJudgeError).category).toBe("response_invalid");
    expect(isRelationJudgeErrorRetryable(error)).toBe(false);
  });

  it("rejects with a response_invalid RelationJudgeError when a candidateId is duplicated in the response", async () => {
    createMock.mockResolvedValue(
      textResponse({
        results: [
          { candidateId: "candidate-1", related: false },
          { candidateId: "candidate-1", related: false },
        ],
      }),
    );
    const client = new AnthropicRelationJudgeClient("api-key");

    const error: unknown = await client
      .judge(SOURCE, CANDIDATES, "note-1")
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(RelationJudgeError);
    expect((error as RelationJudgeError).category).toBe("response_invalid");
  });

  it("未知の relation type は other へ丸め、direction は none へ強制する", async () => {
    createMock.mockResolvedValue(
      textResponse({
        results: [
          {
            candidateId: "candidate-1",
            related: true,
            type: "not-a-real-type",
            direction: "outgoing",
            description: "desc",
            relatedness: 0.5,
          },
        ],
      }),
    );
    const client = new AnthropicRelationJudgeClient("api-key");

    const results = await client.judge(SOURCE, CANDIDATES, "note-1");

    expect(results).toEqual([
      {
        candidateId: "candidate-1",
        type: "other",
        direction: "none",
        description: "desc",
        relatedness: 0.5,
      },
    ]);
  });

  it("same-theme の type でも direction は常に none へ強制する(AI が誤って向きを出力しても)", async () => {
    createMock.mockResolvedValue(
      textResponse({
        results: [
          {
            candidateId: "candidate-1",
            related: true,
            type: "same-theme",
            direction: "outgoing",
            description: "desc",
            relatedness: 0.5,
          },
        ],
      }),
    );
    const client = new AnthropicRelationJudgeClient("api-key");

    const results = await client.judge(SOURCE, CANDIDATES, "note-1");

    expect(results[0].direction).toBe("none");
  });

  it("不正な direction は none へ丸める", async () => {
    createMock.mockResolvedValue(
      textResponse({
        results: [
          {
            candidateId: "candidate-1",
            related: true,
            type: "cause-solution",
            direction: "not-a-real-direction",
            description: "desc",
            relatedness: 0.5,
          },
        ],
      }),
    );
    const client = new AnthropicRelationJudgeClient("api-key");

    const results = await client.judge(SOURCE, CANDIDATES, "note-1");

    expect(results[0].direction).toBe("none");
  });

  it("description が500文字を超える場合は切り詰める", async () => {
    const longDescription = "d".repeat(600);
    createMock.mockResolvedValue(
      textResponse({
        results: [
          {
            candidateId: "candidate-1",
            related: true,
            type: "cause-solution",
            direction: "outgoing",
            description: longDescription,
            relatedness: 0.5,
          },
        ],
      }),
    );
    const client = new AnthropicRelationJudgeClient("api-key");

    const results = await client.judge(SOURCE, CANDIDATES, "note-1");

    expect(results[0].description).toHaveLength(500);
  });

  it.each([
    ["negative", -0.4, 0],
    ["over 1", 1.5, 1],
    ["NaN", Number.NaN, 0],
    ["extra decimal digits", 0.666, 0.67],
  ])(
    "relatedness の境界値(%s: %s)を 0〜1 に clamp し小数第2位に丸める",
    async (_label, input, expected) => {
      createMock.mockResolvedValue(
        textResponse({
          results: [
            {
              candidateId: "candidate-1",
              related: true,
              type: "cause-solution",
              direction: "outgoing",
              description: "desc",
              relatedness: input,
            },
          ],
        }),
      );
      const client = new AnthropicRelationJudgeClient("api-key");

      const results = await client.judge(SOURCE, CANDIDATES, "note-1");

      expect(results[0].relatedness).toBe(expected);
    },
  );

  it("rejects with a transient RelationJudgeError (retryable) on Anthropic API errors (timeout/network/5xx/rate limit相当)", async () => {
    createMock.mockRejectedValue(new MockAPIError("internal error", 500));
    const client = new AnthropicRelationJudgeClient("api-key");

    const error: unknown = await client
      .judge(SOURCE, CANDIDATES, "note-1")
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(RelationJudgeError);
    expect((error as RelationJudgeError).category).toBe("transient");
    expect(isRelationJudgeErrorRetryable(error)).toBe(true);
  });

  it("分類不能な例外は unknown_error として再試行対象(retryable)扱いにする(安全側デフォルト)", async () => {
    createMock.mockRejectedValue(new Error("something unexpected"));
    const client = new AnthropicRelationJudgeClient("api-key");

    const error: unknown = await client
      .judge(SOURCE, CANDIDATES, "note-1")
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(RelationJudgeError);
    expect((error as RelationJudgeError).category).toBe("unknown_error");
    expect(isRelationJudgeErrorRetryable(error)).toBe(true);
  });

  it("RelationJudgeError 以外(例: DB エラー)は isRelationJudgeErrorRetryable の既定で retryable 扱いにする", () => {
    expect(isRelationJudgeErrorRetryable(new Error("some db error"))).toBe(true);
  });

  it("エラーメッセージは固定文言のみで、ノート本文・応答本文を含まない(ログ衛生。§設計決定9)", async () => {
    const secretBody = "very secret note content that must never leak";
    createMock.mockResolvedValue({
      stop_reason: "end_turn",
      content: [{ type: "text", text: `not json but contains ${secretBody}` }],
    });
    const client = new AnthropicRelationJudgeClient("api-key");

    const error: unknown = await client
      .judge({ ...SOURCE, body: secretBody }, CANDIDATES, "note-1")
      .catch((err: unknown) => err);

    expect((error as Error).message).not.toContain(secretBody);
    expect(String((error as Error).stack)).not.toContain(secretBody);
  });
});

describe("createRelationJudgeClientFromEnv", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it.each([undefined, "", "   "])(
    "ANTHROPIC_API_KEY が未設定・空・空白のみ('%s')の場合は起動時に例外を投げる",
    (invalid) => {
      if (invalid === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = invalid;
      }
      expect(() => createRelationJudgeClientFromEnv()).toThrow(
        /ANTHROPIC_API_KEY must be set to a non-empty value/,
      );
    },
  );

  it("ANTHROPIC_API_KEY が有効な値の場合はクライアントを構築する", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
    expect(() => createRelationJudgeClientFromEnv()).not.toThrow();
  });
});
