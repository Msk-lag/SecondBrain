import path from "node:path";
import sharp from "sharp";
import { ImageProcessingFailedError } from "./sanitize-error";

/**
 * Claude API(直接呼び出し)の画像入力上限(Anthropic 公式ドキュメントを Codex 経由で調査。
 * § Claude 入力画像のリサイズ・再圧縮 参照): base64 後 10MB・8000×8000px。
 */
export const CLAUDE_MAX_BASE64_BYTES = 10 * 1024 * 1024;
export const CLAUDE_MAX_INPUT_PIXELS = 8000 * 8000;
/** 実上限ぴったりを狙わず 5% の安全マージンを取る(Codex レビュー r22 指摘 [4] 参照)。 */
export const SAFETY_MARGIN_RATIO = 0.95;
/** claude-sonnet-5 のネイティブ処理長辺。これを超える解像度は品質向上に寄与せずコストのみ増える。 */
export const CLAUDE_NATIVE_LONG_EDGE_PX = 2576;

/**
 * Base64 エンコード後の正確なバイト数を決定的に算出する(パディングを含め概算ではなく計算式で
 * 求める。Codex レビュー r22 指摘 [4] への対応)。
 */
export function base64ByteLength(bufferLength: number): number {
  return 4 * Math.ceil(bufferLength / 3);
}

/**
 * 判定式: base64ByteLength(buffer.length) <= CLAUDE_MAX_BASE64_BYTES * SAFETY_MARGIN_RATIO
 * を満たし、かつ長辺が CLAUDE_NATIVE_LONG_EDGE_PX 以下であること。無加工経路・変換後経路の
 * 両方がこの同一の最終検証関数を通ることで、境界値付近の画像が経路によって異なる基準で
 * 判定される不整合を無くす(Codex レビュー r22 指摘 [4] 参照)。
 */
export function passesClaudeLimit(byteLength: number, width: number, height: number): boolean {
  const withinBase64Budget =
    base64ByteLength(byteLength) <= CLAUDE_MAX_BASE64_BYTES * SAFETY_MARGIN_RATIO;
  const withinLongEdge = Math.max(width, height) <= CLAUDE_NATIVE_LONG_EDGE_PX;
  return withinBase64Budget && withinLongEdge;
}

export interface ResizeRetryStep {
  longEdgePx: number;
  quality: number;
}

/**
 * 手順4: 再エンコード後のバイト数・寸法を上限超過の場合、quality を 85→75→65 の順に下げて
 * 再試行し、それでも超える場合は寸法をさらに 80% に縮小する。最大3回程度の有界ループとし、
 * それでも収束しない場合は失敗させる(§ Claude 入力画像のリサイズ・再圧縮 手順3・4 参照)。
 */
export const RESIZE_RETRY_STEPS: ResizeRetryStep[] = [
  { longEdgePx: CLAUDE_NATIVE_LONG_EDGE_PX, quality: 85 },
  { longEdgePx: CLAUDE_NATIVE_LONG_EDGE_PX, quality: 75 },
  { longEdgePx: CLAUDE_NATIVE_LONG_EDGE_PX, quality: 65 },
  { longEdgePx: Math.round(CLAUDE_NATIVE_LONG_EDGE_PX * 0.8), quality: 65 },
];

export interface EncodeAttemptResult {
  buffer: Buffer;
  width: number;
  height: number;
}

export type EncodeAttempt = (step: ResizeRetryStep) => Promise<EncodeAttemptResult>;

/**
 * RESIZE_RETRY_STEPS を順に試し、判定式(passesClaudeLimit)を満たした時点の結果を返す。
 * 実際の sharp 呼び出しから切り離した純粋なループとして実装し、テストではフェイクの
 * encodeAttempt を注入して境界値・フォールバック・非収束ケースを検証できるようにする。
 */
export async function runResizeRetryLoop(
  encodeAttempt: EncodeAttempt,
): Promise<EncodeAttemptResult> {
  for (const step of RESIZE_RETRY_STEPS) {
    const result = await encodeAttempt(step);
    if (passesClaudeLimit(result.buffer.length, result.width, result.height)) {
      return result;
    }
  }
  throw new ImageProcessingFailedError();
}

async function encodeWithSharp(
  originalBuffer: Buffer,
  step: ResizeRetryStep,
): Promise<EncodeAttemptResult> {
  const { data, info } = await sharp(originalBuffer, { limitInputPixels: CLAUDE_MAX_INPUT_PIXELS })
    .resize({
      width: step.longEdgePx,
      height: step.longEdgePx,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: step.quality })
    .toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height };
}

export interface ResizeForClaudeInput {
  buffer: Buffer;
  mimeType: string;
}

export interface ResizeForClaudeOutput {
  buffer: Buffer;
  mediaType: string;
}

/**
 * 手順1〜5(§ Claude 入力画像のリサイズ・再圧縮 参照)の実処理本体。子プロセス
 * (resize-for-claude.worker-entry.ts)の中でのみ実行される想定(§ 画像処理のハング・
 * クラッシュ耐性 参照)。
 */
export async function resizeForClaudeCore(
  input: ResizeForClaudeInput,
): Promise<ResizeForClaudeOutput> {
  try {
    const metadata = await sharp(input.buffer, {
      limitInputPixels: CLAUDE_MAX_INPUT_PIXELS,
    }).metadata();
    if (!metadata.width || !metadata.height) {
      throw new ImageProcessingFailedError();
    }

    if (passesClaudeLimit(input.buffer.length, metadata.width, metadata.height)) {
      // 大多数の通常のスクリーンショットはこの経路(無加工でそのまま渡す)。
      return { buffer: input.buffer, mediaType: input.mimeType };
    }

    const resized = await runResizeRetryLoop((step) => encodeWithSharp(input.buffer, step));
    return { buffer: resized.buffer, mediaType: "image/jpeg" };
  } catch (err) {
    if (err instanceof ImageProcessingFailedError) {
      throw err;
    }
    // sharp のデコードエラー(画素数超過・破損画像等)を含め、生のエラー内容は一切引き継がない。
    throw new ImageProcessingFailedError();
  }
}

type ChildRequestMessage = ResizeForClaudeInput;
type ChildResponseMessage = { ok: true; buffer: Buffer; mediaType: string } | { ok: false };

/**
 * IPC メッセージハンドラ本体(テストから直接呼び出せるようエクスポートする)。
 * `resize-for-claude.ts`(親プロセス)からの `{ buffer, mimeType }` を受け取り、結果または
 * 失敗マーカーを `process.send` で返す。プロトタイプチェーンが IPC のシリアライズを跨いで
 * 保持される保証が無いため、レスポンスは判別可能なプレーンオブジェクト(`ok` フラグのみ)に
 * 限定する(生のエラーメッセージ・スタックは一切送らない)。
 */
export async function handleChildRequest(
  message: ChildRequestMessage,
): Promise<ChildResponseMessage> {
  try {
    const result = await resizeForClaudeCore(message);
    return { ok: true, buffer: result.buffer, mediaType: result.mediaType };
  } catch {
    return { ok: false };
  }
}

/**
 * このファイル自身が `child_process.fork()` の実行対象(エントリポイント)として
 * 起動されたかどうかを判定する。`process.send` の有無だけでは不十分(Vitest 自体が
 * `pool: "forks"` でテストランナーを `child_process.fork()` しており、テストランナー
 * プロセス自身にも `process.send` が存在するため、これを唯一のガードにすると、
 * 単体テストからこのファイルを import しただけで意図せず IPC 待受が有効化され、
 * Vitest 自身の内部 IPC メッセージを誤って処理して `process.exit(0)` を呼び、
 * テストランナーごと終了させてしまう)。`process.argv[1]`(実際に起動されたスクリプトの
 * パス)がこのファイル自身と一致する場合のみエントリポイントとして扱う。
 */
function isRunningAsEntryPoint(): boolean {
  const entryArg = process.argv[1];
  if (!entryArg || typeof process.send !== "function") {
    return false;
  }
  // このファイルは CommonJS としてコンパイル/実行されるため(apps/worker の package.json に
  // "type": "module" が無い)、`import.meta.url` は使えない。CommonJS で常に利用できる
  // `__filename` を使う。
  const thisFilePath = __filename;
  const resolvedEntryArg = path.resolve(entryArg);
  return (
    resolvedEntryArg === thisFilePath ||
    resolvedEntryArg === thisFilePath.replace(/\.ts$/, ".js") ||
    path.basename(resolvedEntryArg) === path.basename(thisFilePath)
  );
}

/**
 * 実際に `child_process.fork()` のエントリポイントとして起動された場合のみ IPC 待受を
 * 登録する。単体テストからこのファイルを import して `base64ByteLength`/
 * `resizeForClaudeCore`/`handleChildRequest` 等の関数だけを直接利用する場合は登録しない。
 */
/* v8 ignore start -- 実プロセス起動時のみ通る配線コードのため、ユニットテスト対象外 */
if (isRunningAsEntryPoint()) {
  process.on("message", (message: ChildRequestMessage) => {
    void handleChildRequest(message).then((response) => {
      process.send?.(response, () => {
        process.exit(0);
      });
    });
  });
}
/* v8 ignore stop */
