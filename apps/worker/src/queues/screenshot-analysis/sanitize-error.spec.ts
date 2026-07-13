import Anthropic from "@anthropic-ai/sdk";
import { ZodError, z } from "zod";
import { StorageTimeoutError } from "@secondbrain/storage";
import {
  ClaudeRefusalError,
  ImageFetchFailedError,
  ImageProcessingCrashedError,
  ImageProcessingFailedError,
  ImageProcessingTimeoutError,
  SanitizedException,
  classifyError,
  sanitizeError,
} from "./sanitize-error";

/**
 * Anthropic.APIError は実際には status/error/message/headers を要求するコンストラクタを持つ
 * (バージョンによっては protected)ため、コンストラクタの正確な引数形状に依存せず instanceof
 * チェックだけを対象にテストするためプロトタイプから直接生成する。
 */
function createFakeApiError(
  status: number,
  message: string,
): InstanceType<typeof Anthropic.APIError> {
  const err = Object.create(Anthropic.APIError.prototype) as InstanceType<
    typeof Anthropic.APIError
  > & {
    status?: number;
    message: string;
  };
  err.status = status;
  err.message = message;
  return err;
}

function createZodError(secretMessage: string): ZodError {
  const result = z.string().min(1).safeParse("");
  if (result.success) {
    throw new Error("expected validation to fail for an empty string");
  }
  // メッセージに秘匿情報を模した文字列を注入しても logDetail に現れないことを検証するため
  // (ZodError.message は issues から算出される読み取り専用アクセサのため defineProperty で上書きする)。
  Object.defineProperty(result.error, "message", { value: secretMessage, configurable: true });
  return result.error;
}

describe("classifyError", () => {
  it("classifies Anthropic.APIError as claude_api_error", () => {
    const err = createFakeApiError(500, "internal server error");
    expect(classifyError(err)).toBe("claude_api_error");
  });

  it("classifies ClaudeRefusalError as claude_refusal", () => {
    expect(classifyError(new ClaudeRefusalError())).toBe("claude_refusal");
  });

  it("classifies ZodError as output_validation_failed", () => {
    expect(classifyError(createZodError("secret"))).toBe("output_validation_failed");
  });

  it("classifies ImageProcessingTimeoutError as image_processing_timeout", () => {
    expect(classifyError(new ImageProcessingTimeoutError())).toBe("image_processing_timeout");
  });

  it("classifies ImageProcessingCrashedError as image_processing_crashed", () => {
    expect(classifyError(new ImageProcessingCrashedError())).toBe("image_processing_crashed");
  });

  it("classifies ImageProcessingFailedError as image_fetch_failed", () => {
    expect(classifyError(new ImageProcessingFailedError())).toBe("image_fetch_failed");
  });

  it("classifies StorageTimeoutError as image_fetch_failed", () => {
    expect(classifyError(new StorageTimeoutError("getObjectStream", 30_000))).toBe(
      "image_fetch_failed",
    );
  });

  it("classifies ImageFetchFailedError as image_fetch_failed", () => {
    expect(classifyError(new ImageFetchFailedError())).toBe("image_fetch_failed");
  });

  it("classifies SyntaxError(JSON.parse失敗)as output_validation_failed(Codex コードレビュー 2026-07-13 指摘 [A-4])", () => {
    let err: unknown;
    try {
      JSON.parse("not json at all");
    } catch (caught) {
      err = caught;
    }
    expect(classifyError(err)).toBe("output_validation_failed");
  });

  it("classifies unrecognized errors as unknown_error", () => {
    expect(classifyError(new Error("something unexpected"))).toBe("unknown_error");
    expect(classifyError("not an error at all")).toBe("unknown_error");
    expect(classifyError(undefined)).toBe("unknown_error");
  });
});

describe("sanitizeError", () => {
  it("maps each category to its fixed Japanese user message and includes noteId in logDetail", () => {
    const sanitized = sanitizeError(new ClaudeRefusalError(), "note-1");
    expect(sanitized.userMessage).toBe("画像の内容を解析できませんでした。");
    expect(sanitized.logDetail).toEqual({ category: "claude_refusal", noteId: "note-1" });
  });

  it("includes statusCode only for Anthropic.APIError-derived errors", () => {
    const sanitized = sanitizeError(createFakeApiError(429, "rate limited"), "note-2");
    expect(sanitized.logDetail.statusCode).toBe(429);
    expect(sanitized.logDetail.category).toBe("claude_api_error");

    const withoutStatus = sanitizeError(new ImageProcessingTimeoutError(), "note-3");
    expect(withoutStatus.logDetail.statusCode).toBeUndefined();
  });

  it("never leaks model output or image-data-like strings from err.message into logDetail", () => {
    const secret = "SECRET_MODEL_OUTPUT::base64imagedata==leaked-token";
    const candidates: unknown[] = [
      createFakeApiError(500, secret),
      createZodError(secret),
      new Error(secret),
      (() => {
        const err = new ImageProcessingCrashedError();
        // 想定外に message が上書きされていても logDetail には一切現れないことを保証する。
        (err as { message: string }).message = secret;
        return err;
      })(),
    ];

    for (const candidate of candidates) {
      const sanitized = sanitizeError(candidate, "note-4");
      expect(JSON.stringify(sanitized.logDetail)).not.toContain(secret);
      expect(JSON.stringify(sanitized)).not.toContain(secret);
    }
  });

  it("never reads err.request/err.response/err.cause/err.headers", () => {
    const err = createFakeApiError(500, "internal error") as InstanceType<
      typeof Anthropic.APIError
    > & {
      request?: unknown;
      response?: unknown;
      cause?: unknown;
      headers?: unknown;
    };
    err.request = { url: "https://api.anthropic.com/v1/messages", body: "secret-request-body" };
    err.response = { body: "secret-response-body" };
    err.cause = new Error("secret-cause");
    err.headers = { authorization: "Bearer secret-key" };

    const sanitized = sanitizeError(err, "note-5");
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain("secret-request-body");
    expect(serialized).not.toContain("secret-response-body");
    expect(serialized).not.toContain("secret-cause");
    expect(serialized).not.toContain("secret-key");
  });
});

describe("SanitizedException", () => {
  it("carries the sanitized userMessage as its own message and exposes logDetail/category", () => {
    const sanitized = sanitizeError(new ClaudeRefusalError(), "note-6");
    const exception = new SanitizedException(sanitized);

    expect(exception).toBeInstanceOf(Error);
    expect(exception.message).toBe(sanitized.userMessage);
    expect(exception.category).toBe("claude_refusal");
    expect(exception.logDetail).toEqual(sanitized.logDetail);
  });
});
