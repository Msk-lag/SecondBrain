import sharp from "sharp";
import { ImageProcessingFailedError } from "./sanitize-error";
import {
  CLAUDE_MAX_BASE64_BYTES,
  CLAUDE_NATIVE_LONG_EDGE_PX,
  RESIZE_RETRY_STEPS,
  SAFETY_MARGIN_RATIO,
  base64ByteLength,
  handleChildRequest,
  passesClaudeLimit,
  resizeForClaudeCore,
  runResizeRetryLoop,
  type EncodeAttemptResult,
} from "./resize-for-claude.worker-entry";

describe("base64ByteLength", () => {
  it("returns the exact base64-encoded byte length for known input lengths", () => {
    expect(base64ByteLength(0)).toBe(0);
    expect(base64ByteLength(1)).toBe(4);
    expect(base64ByteLength(2)).toBe(4);
    expect(base64ByteLength(3)).toBe(4);
    expect(base64ByteLength(4)).toBe(8);
    expect(base64ByteLength(6)).toBe(8);
    expect(base64ByteLength(7)).toBe(12);
  });
});

describe("passesClaudeLimit", () => {
  // CLAUDE_MAX_BASE64_BYTES(10MiB) * SAFETY_MARGIN_RATIO(0.95) = 9,961,472 バイト。
  const BASE64_THRESHOLD = CLAUDE_MAX_BASE64_BYTES * SAFETY_MARGIN_RATIO;
  // base64ByteLength(7471104) は 9,961,472 と厳密に一致する(4 * ceil(7471104/3))。
  const BYTE_LENGTH_AT_BOUNDARY = 7471104;

  it("passes when base64ByteLength exactly equals the safety-margin threshold", () => {
    expect(base64ByteLength(BYTE_LENGTH_AT_BOUNDARY)).toBe(BASE64_THRESHOLD);
    expect(passesClaudeLimit(BYTE_LENGTH_AT_BOUNDARY, 100, 100)).toBe(true);
  });

  it("passes when just under the byte-length boundary", () => {
    expect(passesClaudeLimit(BYTE_LENGTH_AT_BOUNDARY - 3, 100, 100)).toBe(true);
  });

  it("fails when just over the byte-length boundary", () => {
    expect(passesClaudeLimit(BYTE_LENGTH_AT_BOUNDARY + 1, 100, 100)).toBe(false);
  });

  it("passes when the long edge exactly equals CLAUDE_NATIVE_LONG_EDGE_PX", () => {
    expect(passesClaudeLimit(100, CLAUDE_NATIVE_LONG_EDGE_PX, 10)).toBe(true);
    expect(passesClaudeLimit(100, 10, CLAUDE_NATIVE_LONG_EDGE_PX)).toBe(true);
  });

  it("fails when the long edge exceeds CLAUDE_NATIVE_LONG_EDGE_PX by 1px", () => {
    expect(passesClaudeLimit(100, CLAUDE_NATIVE_LONG_EDGE_PX + 1, 10)).toBe(false);
  });

  it("applies the same judgment regardless of whether the image is unmodified or post-transform", () => {
    // 無加工経路・変換後経路のいずれも同一の判定式を通るため、同じ (byteLength, width, height) の
    // 組であれば経路に関わらず判定結果は一致する(Codex レビュー r22 指摘 [4] 参照)。
    const args: [number, number, number] = [BYTE_LENGTH_AT_BOUNDARY + 1, 100, 100];
    expect(passesClaudeLimit(...args)).toBe(passesClaudeLimit(...args));
    expect(passesClaudeLimit(...args)).toBe(false);
  });
});

describe("runResizeRetryLoop", () => {
  const smallResult = (): EncodeAttemptResult => ({
    buffer: Buffer.alloc(100),
    width: 800,
    height: 600,
  });
  const oversizedResult = (): EncodeAttemptResult => ({
    buffer: Buffer.alloc(50 * 1024 * 1024),
    width: CLAUDE_NATIVE_LONG_EDGE_PX,
    height: CLAUDE_NATIVE_LONG_EDGE_PX,
  });

  it("resolves on the first attempt when it already satisfies the threshold", async () => {
    const encodeAttempt = vi.fn().mockResolvedValue(smallResult());

    const result = await runResizeRetryLoop(encodeAttempt);

    expect(encodeAttempt).toHaveBeenCalledTimes(1);
    expect(encodeAttempt).toHaveBeenCalledWith(RESIZE_RETRY_STEPS[0]);
    expect(result.buffer.length).toBe(100);
  });

  it("falls back through quality 85 -> 75 -> 65 -> scaled dimensions in order", async () => {
    const encodeAttempt = vi
      .fn()
      .mockResolvedValueOnce(oversizedResult())
      .mockResolvedValueOnce(oversizedResult())
      .mockResolvedValueOnce(oversizedResult())
      .mockResolvedValueOnce(smallResult());

    const result = await runResizeRetryLoop(encodeAttempt);

    expect(encodeAttempt).toHaveBeenCalledTimes(4);
    RESIZE_RETRY_STEPS.forEach((step, index) => {
      expect(encodeAttempt).toHaveBeenNthCalledWith(index + 1, step);
    });
    expect(result.buffer.length).toBe(100);
  });

  it("throws ImageProcessingFailedError when no attempt converges within the bounded loop", async () => {
    const encodeAttempt = vi.fn().mockResolvedValue(oversizedResult());

    await expect(runResizeRetryLoop(encodeAttempt)).rejects.toBeInstanceOf(
      ImageProcessingFailedError,
    );
    expect(encodeAttempt).toHaveBeenCalledTimes(RESIZE_RETRY_STEPS.length);
  });
});

describe("resizeForClaudeCore", () => {
  it("returns the original buffer untouched when it is already within the threshold", async () => {
    const buffer = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toBuffer();

    const result = await resizeForClaudeCore({ buffer, mimeType: "image/png" });

    expect(result.buffer).toBe(buffer);
    expect(result.mediaType).toBe("image/png");
  });

  it("resizes and re-encodes as JPEG when the long edge exceeds 2576px", async () => {
    // 総画素数は小さいまま(3000x2)長辺だけを閾値超過させ、テストを高速・軽量に保つ。
    const buffer = await sharp({
      create: { width: 3000, height: 2, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();

    const result = await resizeForClaudeCore({ buffer, mimeType: "image/png" });

    expect(result.mediaType).toBe("image/jpeg");
    const metadata = await sharp(result.buffer).metadata();
    expect(Math.max(metadata.width ?? 0, metadata.height ?? 0)).toBeLessThanOrEqual(
      CLAUDE_NATIVE_LONG_EDGE_PX,
    );
  });

  it("throws ImageProcessingFailedError for corrupt/unreadable image data without leaking sharp's raw error", async () => {
    const garbage = Buffer.from("this is not an image");

    await expect(
      resizeForClaudeCore({ buffer: garbage, mimeType: "image/png" }),
    ).rejects.toBeInstanceOf(ImageProcessingFailedError);
  });
});

describe("handleChildRequest", () => {
  it("responds with ok:true and the resized buffer/mediaType on success", async () => {
    const buffer = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();

    const response = await handleChildRequest({ buffer, mimeType: "image/png" });

    expect(response).toEqual({ ok: true, buffer, mediaType: "image/png" });
  });

  it("responds with ok:false (no error detail) when processing fails", async () => {
    const response = await handleChildRequest({
      buffer: Buffer.from("not an image"),
      mimeType: "image/png",
    });

    expect(response).toEqual({ ok: false });
  });
});
