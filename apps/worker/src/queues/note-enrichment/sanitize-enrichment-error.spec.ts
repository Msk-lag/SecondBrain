import { OpenAiEmbeddingError } from "./openai-embedding.client";
import {
  NoteEnrichmentDbTimeoutError,
  NoteEnrichmentEnqueueTimeoutError,
  NoteEnrichmentInvalidPayloadError,
  NoteEnrichmentMissingApiKeyError,
  SanitizedNoteEnrichmentError,
  classifyEnrichmentError,
  toSanitizedEnrichmentError,
} from "./sanitize-enrichment-error";

describe("classifyEnrichmentError", () => {
  it("classifies NoteEnrichmentEnqueueTimeoutError as enqueue_timeout", () => {
    expect(classifyEnrichmentError(new NoteEnrichmentEnqueueTimeoutError())).toBe(
      "enqueue_timeout",
    );
  });

  it("classifies NoteEnrichmentDbTimeoutError as db_timeout (note-enrichment.processor.ts の withDbTimeout がタイムアウト時に投げるマーカーエラー)", () => {
    expect(classifyEnrichmentError(new NoteEnrichmentDbTimeoutError())).toBe("db_timeout");
  });

  it("classifies NoteEnrichmentInvalidPayloadError as invalid_payload", () => {
    expect(classifyEnrichmentError(new NoteEnrichmentInvalidPayloadError())).toBe(
      "invalid_payload",
    );
  });

  it("classifies OpenAiEmbeddingError as openai_error", () => {
    expect(
      classifyEnrichmentError(new OpenAiEmbeddingError("OpenAI embeddings request failed")),
    ).toBe("openai_error");
  });

  it("classifies NoteEnrichmentMissingApiKeyError as missing_api_key(Issue #70 / A-1: 素の Error に落ちて unknown_error になっていた穴を塞ぐ)", () => {
    expect(classifyEnrichmentError(new NoteEnrichmentMissingApiKeyError())).toBe("missing_api_key");
  });

  it("classifies unrecognized errors as unknown_error", () => {
    expect(classifyEnrichmentError(new Error("something unexpected"))).toBe("unknown_error");
    expect(classifyEnrichmentError("not an error at all")).toBe("unknown_error");
    expect(classifyEnrichmentError(undefined)).toBe("unknown_error");
  });
});

describe("toSanitizedEnrichmentError / SanitizedNoteEnrichmentError", () => {
  it("wraps NoteEnrichmentDbTimeoutError into a SanitizedNoteEnrichmentError carrying only the db_timeout category and a fixed message", () => {
    const sanitized = toSanitizedEnrichmentError(new NoteEnrichmentDbTimeoutError());

    expect(sanitized).toBeInstanceOf(SanitizedNoteEnrichmentError);
    expect(sanitized.category).toBe("db_timeout");
    expect(sanitized.message).toBe("note enrichment db operation timed out");
  });

  it("wraps OpenAiEmbeddingError into a SanitizedNoteEnrichmentError carrying only the openai_error category and a fixed message", () => {
    const sanitized = toSanitizedEnrichmentError(
      new OpenAiEmbeddingError("OpenAI embeddings request failed with status 500"),
    );

    expect(sanitized).toBeInstanceOf(SanitizedNoteEnrichmentError);
    expect(sanitized.category).toBe("openai_error");
    expect(sanitized.message).toBe("note enrichment openai embeddings call failed");
  });

  it("wraps NoteEnrichmentMissingApiKeyError into a SanitizedNoteEnrichmentError carrying only the missing_api_key category and a fixed message", () => {
    const sanitized = toSanitizedEnrichmentError(new NoteEnrichmentMissingApiKeyError());

    expect(sanitized).toBeInstanceOf(SanitizedNoteEnrichmentError);
    expect(sanitized.category).toBe("missing_api_key");
    expect(sanitized.message).toBe(
      "note enrichment required api key environment variable is not set",
    );
  });

  it("never leaks the original error's message into the sanitized result (cause も保持しない)", () => {
    // 実際の接続文字列のような形式(scheme://user:pass@host)は secretlint の
    // database-connection-string ルールに誤検知されるため、意図的に URL 形式を避けた
    // ダミー値を使う(実在の資格情報ではない。テスト目的のプレースホルダ)。
    const secret = "db user=hunter2-test-password host=db-host db=secondbrain SELECT * FROM notes";
    const sanitized = toSanitizedEnrichmentError(new Error(secret));

    expect(sanitized.category).toBe("unknown_error");
    expect(sanitized.message).not.toContain(secret);
    expect((sanitized as { cause?: unknown }).cause).toBeUndefined();
  });
});
