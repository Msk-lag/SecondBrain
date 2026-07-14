import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  ImageProcessingCrashedError,
  ImageProcessingFailedError,
  ImageProcessingTimeoutError,
} from "./sanitize-error";
import type { ResizeForClaudeInput, ResizeForClaudeOutput } from "./resize-for-claude.worker-entry";

/**
 * ネイティブコード側(sharp/libvips)のブロッキング処理は V8 のイベントループに制御が戻らない
 * 限り `Promise.race`/`AbortController` では中断できないため、別 OS プロセスに隔離し
 * `SIGKILL` で確実に強制終了する(§ 画像処理のハング・クラッシュ耐性 参照)。
 */
export const RESIZE_FOR_CLAUDE_TIMEOUT_MS = 30_000;

/**
 * エントリポイント解決(Codex レビュー r14 指摘 [2]・r15 指摘 [2] への対応)。
 * - 本番: `tsconfig.build.json` でコンパイルされた `resize-for-claude.worker-entry.js` が
 *   自身と同じディレクトリに存在するため、`__dirname` 基準でこれを解決する(`tsx`/`execArgv` 不要)。
 * - テスト(Vitest): ソースをコンパイルしないため上記 `.js` が存在しない。その場合のみ
 *   `resize-for-claude.worker-entry.ts` を `execArgv: ["--import", "tsx"]` 付きで fork する
 *   フォールバック経路を使う(`tsx` は開発時のみ必要な devDependency のまま)。
 */
export function resolveWorkerEntry(): { entryPath: string; execArgv: string[] } {
  const compiledPath = path.join(__dirname, "resize-for-claude.worker-entry.js");
  if (fs.existsSync(compiledPath)) {
    return { entryPath: compiledPath, execArgv: [] };
  }
  const sourcePath = path.join(__dirname, "resize-for-claude.worker-entry.ts");
  return { entryPath: sourcePath, execArgv: ["--import", "tsx"] };
}

/**
 * `fork()` は `env` を省略すると親プロセスの全環境変数(`ANTHROPIC_API_KEY`・DBパスワード・
 * MinIO資格情報等)をそのまま子プロセスへ継承する。この子プロセスは攻撃者由来の画像を
 * ネイティブコード(sharp/libvips)で処理するために意図的に隔離した境界であり、そこへ
 * 処理に不要なアプリケーション資格情報まで持ち込むと、ネイティブコード側の脆弱性等で
 * コード実行に至った場合に資格情報窃取へ直結する(Codex コードレビュー 2026-07-13 r8
 * 指摘 [A-3] への対応)。子プロセスの起動・実行に最低限必要な環境変数だけを許可リストで
 * 引き継ぐ。
 */
const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "Path", // Windows は歴史的に大文字小文字が揺れる
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "NODE_ENV",
  "SystemRoot", // Windows: 一部のネイティブ呼び出しに必要
];

function allowlistedChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

interface ChildSuccessResponse {
  ok: true;
  buffer: Buffer;
  mediaType: string;
}

/**
 * `"ok" in message` だけの検証では、`{ ok: true }`(buffer/mediaType 欠落)のような
 * 壊れた応答も成功応答として扱われ、その後の `Buffer.from(message.buffer)` が
 * `child.once("message", ...)` のイベントハンドラー内で同期例外を投げる。この例外は
 * Promise の reject に変換されず、`resizeForClaude` の呼び出し元(worker プロセス自身)まで
 * 伝播しうる(Codex コードレビュー 2026-07-13 r10 指摘 [A-1] への対応)。`ok` の型・
 * 成功時に必要なフィールドの有無まで検証する。
 */
function isChildSuccessResponse(message: unknown): message is ChildSuccessResponse {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const candidate = message as Partial<ChildSuccessResponse>;
  return (
    candidate.ok === true &&
    candidate.buffer !== undefined &&
    typeof candidate.mediaType === "string"
  );
}

/**
 * `resize-for-claude.worker-entry.ts` を別 OS プロセスとして起動し、IPC で画像を渡して
 * リサイズ済み結果を受け取る(親プロセス側の呼び出し口)。呼び出し元は
 * `ScreenshotAnalysisProcessor`(§ 実装手順13)であり、`ClaudeVisionClient` ではない
 * (責務を分離する。Codex レビュー r19 指摘 [1] 参照)。
 *
 * `entryOverride` はテスト専用の差し込み口(タイムアウト・クラッシュ検知を、意図的に応答しない/
 * 異常終了するテスト用エントリポイントへ差し替えて検証するため)。省略時は常に
 * `resolveWorkerEntry()` による通常解決を使う。
 */
export function resizeForClaude(
  input: ResizeForClaudeInput,
  entryOverride?: { entryPath: string; execArgv: string[] },
): Promise<ResizeForClaudeOutput> {
  const { entryPath, execArgv } = entryOverride ?? resolveWorkerEntry();

  return new Promise<ResizeForClaudeOutput>((resolve, reject) => {
    // Buffer を JSON 経由でシリアライズすると大幅なメモリ膨張・型不一致が起こるため、
    // V8 の構造化クローンアルゴリズムを使う "advanced" を指定する。
    const child: ChildProcess = fork(entryPath, [], {
      execArgv,
      serialization: "advanced",
      env: allowlistedChildEnv(),
    });

    let settled = false;

    // いずれの終了経路(正常完了・タイムアウト・クラッシュ)でも、タイマーの clearTimeout を
    // 確実に行い、子プロセスのイベントリスナーを解除してリークを防ぐ。
    const cleanup = (): void => {
      clearTimeout(timer);
      child.removeAllListeners("message");
      child.removeAllListeners("exit");
      child.removeAllListeners("error");
    };

    const settleOnce = (action: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      action();
    };

    const timer = setTimeout(() => {
      settleOnce(() => {
        child.kill("SIGKILL");
        reject(new ImageProcessingTimeoutError());
      });
    }, RESIZE_FOR_CLAUDE_TIMEOUT_MS);
    timer.unref?.();

    child.once("message", (message: unknown) => {
      settleOnce(() => {
        // 正規の応答受信後、子プロセス自身が自己終了(process.exit)しない実装
        // (テスト用フィクスチャ等)であっても確実にプロセスを終了させる
        // (Codex コードレビュー 2026-07-13 r10 指摘 [A-1] への対応。既に自己終了済みの
        // プロセスに対する kill は安全な no-op)。
        child.kill();
        try {
          if (isChildSuccessResponse(message)) {
            resolve({ buffer: Buffer.from(message.buffer), mediaType: message.mediaType });
          } else {
            reject(new ImageProcessingFailedError());
          }
        } catch {
          // `Buffer.from(message.buffer)` 等、応答の形は正しくても値の変換自体が失敗する
          // ケースを含め、生の例外を worker プロセスへ伝播させずサニタイズ済みエラーへ
          // 変換する(Codex コードレビュー 2026-07-13 r10 指摘 [A-1] への対応)。
          reject(new ImageProcessingFailedError());
        }
      });
    });

    // 子プロセスの異常終了(クラッシュ・OOM 等)は `exit` イベント(非ゼロ終了コード)で検知する。
    // message を受け取れないまま終了した場合はすべてクラッシュとして扱う。
    child.once("exit", () => {
      settleOnce(() => {
        reject(new ImageProcessingCrashedError());
      });
    });

    child.once("error", () => {
      settleOnce(() => {
        reject(new ImageProcessingCrashedError());
      });
    });

    child.send({ buffer: input.buffer, mimeType: input.mimeType });
  });
}
