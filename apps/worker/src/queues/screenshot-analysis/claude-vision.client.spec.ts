import {
  ClaudeVisionClient,
  CLAUDE_VISION_REQUEST_TIMEOUT_MS,
  createClaudeVisionClientFromEnv,
} from "./claude-vision.client";
import { SanitizedException } from "./sanitize-error";

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

const VALID_RESULT = {
  title: "スクリーンショットの要点",
  summary: "画面の内容を要約した文章です。",
  tags: ["tag1", "tag2"],
  concepts: ["concept1"],
  extractedText: "original text",
};

describe("ClaudeVisionClient", () => {
  beforeEach(() => {
    createMock.mockReset();
    constructorMock.mockReset();
  });

  it("constructs the Anthropic client with maxRetries: 0", () => {
    const client = new ClaudeVisionClient("api-key");
    expect(client).toBeInstanceOf(ClaudeVisionClient);
    expect(constructorMock).toHaveBeenCalledWith({ apiKey: "api-key", maxRetries: 0 });
  });

  it("returns the runtime-validated result on success, passing timeout: 60_000", async () => {
    createMock.mockResolvedValue(textResponse(VALID_RESULT));
    const client = new ClaudeVisionClient("api-key");

    const result = await client.analyze(
      { buffer: Buffer.from("fake-image-bytes"), mediaType: "image/png" },
      "note-1",
    );

    expect(result).toEqual(VALID_RESULT);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0][1]).toEqual({ timeout: CLAUDE_VISION_REQUEST_TIMEOUT_MS });
    expect(CLAUDE_VISION_REQUEST_TIMEOUT_MS).toBe(60_000);
  });

  it("rejects with a claude_refusal SanitizedException when stop_reason is refusal", async () => {
    createMock.mockResolvedValue(textResponse(VALID_RESULT, "refusal"));
    const client = new ClaudeVisionClient("api-key");

    const error = await client
      .analyze({ buffer: Buffer.from("img"), mediaType: "image/png" }, "note-2")
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(SanitizedException);
    expect((error as SanitizedException).category).toBe("claude_refusal");
    expect((error as SanitizedException).message).toBe("画像の内容を解析できませんでした。");
    expect((error as SanitizedException).logDetail).toEqual({
      category: "claude_refusal",
      noteId: "note-2",
    });
  });

  it("rejects with a claude_api_error SanitizedException carrying the status code on Anthropic API errors", async () => {
    createMock.mockRejectedValue(new MockAPIError("internal error", 500));
    const client = new ClaudeVisionClient("api-key");

    const error = await client
      .analyze({ buffer: Buffer.from("img"), mediaType: "image/png" }, "note-3")
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(SanitizedException);
    expect((error as SanitizedException).category).toBe("claude_api_error");
    expect((error as SanitizedException).message).toBe(
      "AI 解析サービスが一時的に利用できませんでした。",
    );
    expect((error as SanitizedException).logDetail).toEqual({
      category: "claude_api_error",
      statusCode: 500,
      noteId: "note-3",
    });
  });

  it.each([
    ["empty title", { ...VALID_RESULT, title: "" }],
    ["whitespace-only title", { ...VALID_RESULT, title: "   " }],
    ["empty summary", { ...VALID_RESULT, summary: "" }],
    ["whitespace-only summary", { ...VALID_RESULT, summary: "   " }],
  ])(
    "rejects with output_validation_failed when the model output has %s",
    async (_label, payload) => {
      createMock.mockResolvedValue(textResponse(payload));
      const client = new ClaudeVisionClient("api-key");

      const error = await client
        .analyze({ buffer: Buffer.from("img"), mediaType: "image/png" }, "note-4")
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(SanitizedException);
      expect((error as SanitizedException).category).toBe("output_validation_failed");
      expect((error as SanitizedException).message).toBe("AI の応答を処理できませんでした。");
    },
  );

  it("rejects with output_validation_failed when the response text is not valid JSON", async () => {
    createMock.mockResolvedValue({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "not json at all" }],
    });
    const client = new ClaudeVisionClient("api-key");

    const error = await client
      .analyze({ buffer: Buffer.from("img"), mediaType: "image/png" }, "note-5")
      .catch((err: unknown) => err);

    // JSON.parse の SyntaxError は output_validation_failed として分類される(Codex
    // コードレビュー 2026-07-13 指摘 [A-4] への対応。以前は既知のカテゴリに一致せず
    // unknown_error に分類されており、このテストのタイトルと実際の分類結果が矛盾していた)。
    expect(error).toBeInstanceOf(SanitizedException);
    expect((error as SanitizedException).category).toBe("output_validation_failed");
  });
});

describe("createClaudeVisionClientFromEnv", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it.each([undefined, "", "   "])(
    "ANTHROPIC_API_KEY が未設定・空・空白のみ('%s')の場合は起動時に例外を投げる(Codex コードレビュー 2026-07-13 r2 指摘 [A-3])",
    (invalid) => {
      if (invalid === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = invalid;
      }
      expect(() => createClaudeVisionClientFromEnv()).toThrow(
        /ANTHROPIC_API_KEY must be set to a non-empty value/,
      );
    },
  );

  it("ANTHROPIC_API_KEY が有効な値の場合はクライアントを構築する", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
    expect(() => createClaudeVisionClientFromEnv()).not.toThrow();
  });
});
