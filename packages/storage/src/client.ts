import { PassThrough, type Readable } from "node:stream";
import { Client as MinioSdkClient } from "minio";
import { StorageTimeoutError } from "./errors.js";
import { loadRootEnv, minioConfigFromEnv, type MinioEnvConfig } from "./env.js";

/**
 * MinIO は通常 "us-east-1" を既定リージョンとして扱う。ローカル・EC2 いずれも単一リージョン運用の
 * ため固定値で問題ない。クライアント初期化時にこれを明示指定することで、`minio` SDK が初回操作時に
 * 行いうる内部的なバケットリージョン解決(s3:GetBucketLocation 相当)の呼び出し自体を回避する。
 * バケット限定ポリシーは GetObject/PutObject/DeleteObject のみを許可し、この解決呼び出しが拒否される
 * と初回操作から失敗しうるため(§バケット限定ポリシーの権限範囲・Codex レビュー r13 指摘 [2] 参照)。
 */
const MINIO_REGION = "us-east-1";

export const DEFAULT_UPLOAD_TIMEOUT_MS = 15_000;
export const DEFAULT_DELETE_TIMEOUT_MS = 15_000;
export const DEFAULT_GET_OBJECT_TIMEOUT_MS = 30_000;

/**
 * タイムアウト発火後に遅れて解決した値が、破棄可能なストリーム/リクエスト形状であれば破棄する。
 * `getObjectStream` が返す Readable ストリームはこの経路で `destroy()` される
 * (§外部通信タイムアウトの一貫適用 参照。Promise.race で待機側だけ諦めて背後の処理が
 * 残り続ける状態を作らないため)。
 */
function destroyIfDestroyable(value: unknown): void {
  if (value === null || typeof value !== "object") {
    return;
  }
  const candidate = value as { destroy?: unknown; abort?: unknown };
  if (typeof candidate.destroy === "function") {
    (candidate.destroy as () => void)();
    return;
  }
  if (typeof candidate.abort === "function") {
    (candidate.abort as () => void)();
  }
}

/**
 * `getObjectStream` の既定タイムアウトは Readable が返却される(ヘッダー取得完了)までしか
 * 保護しない。返却後にデータ転送そのものが停止した場合、返却済みストリームとその裏側の
 * HTTP 接続が無期限に残り得る(Codex コードレビュー r5 指摘 [D-2] への対応)。データが
 * `timeoutMs` 内に届かない場合、ストリームを `StorageTimeoutError` で破棄する無通信
 * タイムアウトを追加で監視する。
 *
 * 監視対象の `source` に直接 `on("data", ...)` を張ると、Node.js の Readable はその時点で
 * flowing モードへ移行する。呼び出し元(`pipe()`・`for await`)がまだ購読していない場合、
 * その間に届いたチャンクは呼び出し元に一切渡らないまま消費されてしまう
 * (Codex コードレビュー r6 指摘 [D-1] への対応)。`PassThrough` を挟み、`source` への
 * `pipe()`(内部で自動的に data 購読・バックプレッシャーを扱う標準経路)と監視用の
 * `on("data", ...)` を同一の同期区間で登録することで、`source` 側は "自分の pipe 呼び出し"
 * 以外から観測されない。呼び出し元が実際に触れるのは `output`(PassThrough)のみであり、
 * その flowing モードへの移行は呼び出し元自身の購読タイミングに委ねられる
 * (`output` は自身の消費者が付くまで内部バッファ〔highWaterMark〕で保持するため、
 * データは失われない)。
 */
function withInactivityTimeout(source: Readable, operation: string, timeoutMs: number): Readable {
  const output = new PassThrough();
  let timer: ReturnType<typeof setTimeout>;
  // `source` の `data` イベントだけでタイマーを更新すると、下流(呼び出し元)の消費が
  // 一時的に遅い場合も誤検知する。`output`(PassThrough)のバッファが満杯になると
  // `pipe()` 自身のバックプレッシャー制御により `source` が正常に `pause()` され、
  // MinIO 側に何の問題も無くても `data` が一時的に止まる(Codex コードレビュー r9
  // 指摘 [D-2] への対応)。`source` の `pause`/`resume` を監視し、バックプレッシャーに
  // よる一時停止中はタイマーを止め、再開時にのみ再開することで、"上流(MinIO)側の
  // 無通信" と "下流の消費速度による一時停止" を区別する。
  let timerSuspended = false;
  const clear = () => clearTimeout(timer);
  const reset = () => {
    clear();
    if (timerSuspended) {
      return;
    }
    timer = setTimeout(() => {
      const err = new StorageTimeoutError(operation, timeoutMs);
      source.destroy(err);
      output.destroy(err);
    }, timeoutMs);
    timer.unref?.();
  };
  reset();
  source.on("data", reset);
  source.on("pause", () => {
    timerSuspended = true;
    clear();
  });
  source.on("resume", () => {
    timerSuspended = false;
    reset();
  });
  source.once("error", (err) => {
    clear();
    output.destroy(err);
  });
  // `output`(PassThrough)の "end" は呼び出し元がバッファ済みデータを実際に読み切った
  // 時点で初めて発火するため、購読開始や読み出しが遅い呼び出し元では `source` 側の転送が
  // 正常に完了済みでも "end" が届かず、タイマーが動き続けてしまう(Codex コードレビュー
  // r10 指摘 [D-2] への対応)。`source` 自身の正常終了時点でも監視を止め、MinIO 側の転送
  // 完了後は下流の消費タイミングに関わらずタイムアウトしないようにする。
  source.once("end", clear);
  source.pipe(output);
  output.once("end", clear);
  output.once("close", () => {
    clear();
    // 呼び出し元(例: apps/api の getImage)がクライアント切断等で output を先に破棄した
    // 場合、`pipe()` は自動では source 側を破棄しない。output 経由でしか触れられない
    // 呼び出し元からも、裏側の MinIO ストリームを確実に解放する。ただし正常に最後まで
    // 読み切られた場合(source.readableEnded)は既に自然終了しているため、無用な
    // destroy() を呼ばない。
    if (!source.destroyed && !source.readableEnded) {
      source.destroy();
    }
  });
  output.once("error", clear);
  return output;
}

/**
 * `@secondbrain/storage` の MinIO クライアントラッパー。
 * uploadObject/getObjectStream/deleteObject のいずれも既定タイムアウトを内部に持ち、タイムアウト
 * 発火時は `StorageTimeoutError` を投げる。`minio` SDK の putObject/getObject/removeObject は
 * リクエスト単位の AbortSignal を受け付けない(2026年時点の SDK 形状)ため、タイムアウト発火後に
 * 遅れて返却されたストリーム/リクエストを明示的に破棄することで背後の接続を確実に終了させる
 * (§外部通信タイムアウトの一貫適用 参照)。
 */
export class MinioClient {
  private readonly sdkClient: MinioSdkClient;
  private readonly bucket: string;

  constructor(config: MinioEnvConfig) {
    this.bucket = config.bucket;
    this.sdkClient = new MinioSdkClient({
      endPoint: config.host,
      port: config.port,
      useSSL: config.useSSL,
      accessKey: config.accessKey,
      secretKey: config.secretKey,
      region: MINIO_REGION,
    });
  }

  getBucketName(): string {
    return this.bucket;
  }

  async uploadObject(
    key: string,
    buffer: Buffer,
    contentType: string,
    timeoutMs: number = DEFAULT_UPLOAD_TIMEOUT_MS,
  ): Promise<void> {
    await this.runWithTimeout("uploadObject", timeoutMs, () =>
      this.sdkClient.putObject(this.bucket, key, buffer, buffer.length, {
        "Content-Type": contentType,
      }),
    );
  }

  async getObjectStream(
    key: string,
    timeoutMs: number = DEFAULT_GET_OBJECT_TIMEOUT_MS,
  ): Promise<Readable> {
    const stream = await this.runWithTimeout("getObjectStream", timeoutMs, () =>
      this.sdkClient.getObject(this.bucket, key),
    );
    return withInactivityTimeout(stream, "getObjectStream", timeoutMs);
  }

  async deleteObject(key: string, timeoutMs: number = DEFAULT_DELETE_TIMEOUT_MS): Promise<void> {
    await this.runWithTimeout("deleteObject", timeoutMs, () =>
      this.sdkClient.removeObject(this.bucket, key),
    );
  }

  /**
   * 指定した操作を既定タイムアウト内に完了させる共通ヘルパー。
   * タイムアウト発火時は `StorageTimeoutError` を投げる。タイムアウト後に action が遅れて解決/拒否
   * した場合、解決値が破棄可能な形状であれば破棄し(destroyIfDestroyable)、遅延拒否は
   * 未処理拒否(unhandledRejection)にならないよう内部で握りつぶす
   * (呼び出し元には既に StorageTimeoutError が伝わっているため)。
   */
  private async runWithTimeout<T>(
    operation: string,
    timeoutMs: number,
    action: () => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout>;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new StorageTimeoutError(operation, timeoutMs));
      }, timeoutMs);
      timer.unref?.();
    });

    // `action()` を直接呼ぶと、SDK が引数検証等で同期的に例外を投げた場合にその例外が
    // `try` ブロックへ到達する前に呼び出し元まで伝播し、`timeoutPromise` のタイマーが
    // 解除されないまま残る(未処理の Promise rejection にもなりうる。Codex コードレビュー
    // r7 指摘 [D-2] への対応)。`Promise.resolve().then(action)` で必ず非同期の
    // Promise rejection に変換してから以降のチェーンへ渡す。
    const actionPromise = Promise.resolve()
      .then(action)
      .then((result) => {
        if (timedOut) {
          destroyIfDestroyable(result);
        }
        return result;
      })
      .catch((error: unknown) => {
        if (timedOut) {
          // タイムアウト後の遅延失敗は握りつぶす(呼び出し元へは既に StorageTimeoutError が
          // 伝わっており、二重にエラーを伝える必要が無いため)。
          return undefined as never;
        }
        throw error;
      });

    try {
      return await Promise.race([actionPromise, timeoutPromise]);
    } finally {
      clearTimeout(timer!);
    }
  }
}

/**
 * 環境変数からリポジトリルートの .env を読み込んだうえで MinioClient を構築する。
 * apps/api・apps/worker それぞれの StorageModule から利用される想定(packages/db の
 * createPoolFromEnv と同じパターン)。
 */
export function createMinioClientFromEnv(): MinioClient {
  loadRootEnv();
  return new MinioClient(minioConfigFromEnv());
}
