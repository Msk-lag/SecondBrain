import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import {
  ImageProcessingCrashedError,
  ImageProcessingFailedError,
  ImageProcessingTimeoutError,
} from "./sanitize-error";
import {
  RESIZE_FOR_CLAUDE_TIMEOUT_MS,
  resizeForClaude,
  resolveWorkerEntry,
} from "./resize-for-claude";

const HANGING_ENTRY = {
  entryPath: path.join(__dirname, "test-fixtures", "hanging-entry.ts"),
  execArgv: ["--import", "tsx"],
};
const CRASHING_ENTRY = {
  entryPath: path.join(__dirname, "test-fixtures", "crashing-entry.ts"),
  execArgv: ["--import", "tsx"],
};
const ENV_REPORTING_ENTRY = {
  entryPath: path.join(__dirname, "test-fixtures", "env-reporting-entry.ts"),
  execArgv: ["--import", "tsx"],
};
const MALFORMED_SUCCESS_ENTRY = {
  entryPath: path.join(__dirname, "test-fixtures", "malformed-success-entry.ts"),
  execArgv: ["--import", "tsx"],
};

describe("resolveWorkerEntry", () => {
  it("resolves to the compiled .js sibling when it exists (production layout)", () => {
    const existsSyncSpy = vi.spyOn(fs, "existsSync").mockReturnValue(true);
    try {
      const { entryPath, execArgv } = resolveWorkerEntry();
      expect(entryPath.endsWith("resize-for-claude.worker-entry.js")).toBe(true);
      expect(execArgv).toEqual([]);
    } finally {
      existsSyncSpy.mockRestore();
    }
  });

  it("falls back to the .ts source with the tsx loader when the compiled .js does not exist (test layout)", () => {
    const existsSyncSpy = vi.spyOn(fs, "existsSync").mockReturnValue(false);
    try {
      const { entryPath, execArgv } = resolveWorkerEntry();
      expect(entryPath.endsWith("resize-for-claude.worker-entry.ts")).toBe(true);
      expect(execArgv).toEqual(["--import", "tsx"]);
    } finally {
      existsSyncSpy.mockRestore();
    }
  });
});

describe("resizeForClaude", () => {
  it("runs the real worker-entry in a forked child process and returns the resized result", async () => {
    const buffer = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 5, g: 6, b: 7 } },
    })
      .png()
      .toBuffer();

    const result = await resizeForClaude({ buffer, mimeType: "image/png" });

    expect(result.mediaType).toBe("image/png");
    expect(Buffer.compare(result.buffer, buffer)).toBe(0);
  }, 20_000);

  // 子プロセスは攻撃者由来の画像をネイティブコード(sharp/libvips)で処理するために隔離した
  // 境界であり、`fork()` が親プロセスの全環境変数(ANTHROPIC_API_KEY・DBパスワード・MinIO
  // 資格情報等)をそのまま継承すると、ネイティブコード側の脆弱性等でコード実行に至った場合に
  // 資格情報窃取へ直結する(Codex コードレビュー 2026-07-13 r8 指摘 [A-3] への対応)。
  it("子プロセスへアプリケーションの秘密環境変数を継承しない(許可リストのみ渡す)", async () => {
    const fakeSecretKey = "FAKE_APP_SECRET_FOR_TEST_ONLY";
    process.env[fakeSecretKey] = "should-not-leak-to-child";
    try {
      const result = await resizeForClaude(
        {
          buffer: Buffer.from("does not matter for the env-reporting fixture"),
          mimeType: "image/png",
        },
        ENV_REPORTING_ENTRY,
      );

      const receivedEnvKeys = JSON.parse(result.buffer.toString("utf8")) as string[];
      expect(receivedEnvKeys).not.toContain(fakeSecretKey);
    } finally {
      delete process.env[fakeSecretKey];
    }
  }, 20_000);

  it("kills the child process with SIGKILL and rejects with ImageProcessingTimeoutError when it hangs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const promise = resizeForClaude(
        { buffer: Buffer.from("does not matter for the hanging fixture"), mimeType: "image/png" },
        HANGING_ENTRY,
      );
      // タイマーを進める前に rejects の待受(ハンドラ)を先に張っておく。advanceTimersByTimeAsync
      // が同期的にタイマーを発火させるため、先に .catch 相当を付けておかないと reject() の時点で
      // 一時的に「未処理」と判定され、後から処理されても PromiseRejectionHandledWarning が出る。
      const assertion = expect(promise).rejects.toBeInstanceOf(ImageProcessingTimeoutError);
      // 遅延を待たずにタイムアウトを即座に発火させる(実時間30秒を待たない)。
      await vi.advanceTimersByTimeAsync(RESIZE_FOR_CLAUDE_TIMEOUT_MS);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  it("rejects with ImageProcessingCrashedError when the child process exits abnormally", async () => {
    await expect(
      resizeForClaude(
        { buffer: Buffer.from("does not matter for the crashing fixture"), mimeType: "image/png" },
        CRASHING_ENTRY,
      ),
    ).rejects.toBeInstanceOf(ImageProcessingCrashedError);
  }, 20_000);

  it("rejects with ImageProcessingFailedError when the real entry reports a graceful processing failure", async () => {
    await expect(
      resizeForClaude({ buffer: Buffer.from("this is not a real image"), mimeType: "image/png" }),
    ).rejects.toBeInstanceOf(ImageProcessingFailedError);
  }, 20_000);

  // `{ ok: true }` のみ(buffer/mediaType 欠落)の壊れた成功応答は、以前は
  // `Buffer.from(undefined)` がイベントハンドラー内で同期例外を投げ、Promise の reject に
  // 変換されず worker プロセスまで伝播しうる不具合があった(Codex コードレビュー
  // 2026-07-13 r10 指摘 [A-1] への対応)。
  it("rejects with ImageProcessingFailedError (not an uncaught exception) when the child sends a malformed success response", async () => {
    await expect(
      resizeForClaude(
        {
          buffer: Buffer.from("does not matter for the malformed-success fixture"),
          mimeType: "image/png",
        },
        MALFORMED_SUCCESS_ENTRY,
      ),
    ).rejects.toBeInstanceOf(ImageProcessingFailedError);
  }, 20_000);
});
