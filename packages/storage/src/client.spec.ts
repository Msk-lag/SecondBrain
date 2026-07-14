import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MinioClient } from "./client.js";
import { StorageTimeoutError } from "./errors.js";

/**
 * `getObjectStream` は返却後のストリームに `on("data", ...)`/`once("end"/"close"/"error", ...)`
 * を登録する(無通信タイムアウト。§ D-2 参照)ため、テストのフェイクも(単なる
 * `{ destroy: vi.fn() }` のようなプレーンオブジェクトではなく)実際の EventEmitter/Readable
 * 互換オブジェクトである必要がある。既定では何もデータを流さない Readable を使う。
 */
function createFakeReadableStream(): Readable {
  return new Readable({ read() {} });
}

// `vi.mock()` はファイル先頭へ hoist されるため、通常の `const` では TDZ 参照になりうる
// (Codex コードレビュー 2026-07-13 r6 指摘 [D-1]。実際には mock factory 内で参照している
// のは `mockImplementation` に渡すコンストラクタ関数の「本体」であり、この本体は
// `new Client()` が実際に呼ばれるまで実行されない〔クロージャの遅延評価〕ため、その時点では
// 既に下記の値が初期化済みであり実害は無いことを確認済みだが、`vi.hoisted()` を使う方が
// hoisting との関係が自明で紛れがない。同じ diff の reset-mariadb-database.spec.ts と
// 同じパターンに揃える)。
const { putObjectMock, getObjectMock, removeObjectMock } = vi.hoisted(() => ({
  putObjectMock: vi.fn(),
  getObjectMock: vi.fn(),
  removeObjectMock: vi.fn(),
}));

vi.mock("minio", () => {
  return {
    // `new.target` 経由で `Reflect.construct` されるため、実装はアロー関数ではなく
    // 通常の function 式にする(アロー関数は [[Construct]] を持たず「is not a constructor」になる)。
    Client: vi.fn().mockImplementation(function MockMinioSdkClient() {
      return {
        putObject: putObjectMock,
        getObject: getObjectMock,
        removeObject: removeObjectMock,
      };
    }),
  };
});

const testConfig = {
  host: "localhost",
  port: 9000,
  useSSL: false,
  accessKey: "app-access-key",
  secretKey: "app-secret-key",
  bucket: "test-bucket",
};

function delay<T>(value: T, ms: number): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), ms);
  });
}

beforeEach(() => {
  putObjectMock.mockReset();
  getObjectMock.mockReset();
  removeObjectMock.mockReset();
});

describe("MinioClient", () => {
  it("getBucketName は構築時に渡したバケット名を返す", () => {
    const client = new MinioClient(testConfig);
    expect(client.getBucketName()).toBe("test-bucket");
  });

  it("uploadObject は成功時に putObject へ正しい引数を渡す", async () => {
    putObjectMock.mockResolvedValue({ etag: "abc" });
    const client = new MinioClient(testConfig);
    const buffer = Buffer.from("hello");

    await client.uploadObject("screenshots/user-1/note-1.png", buffer, "image/png");

    expect(putObjectMock).toHaveBeenCalledWith(
      "test-bucket",
      "screenshots/user-1/note-1.png",
      buffer,
      buffer.length,
      { "Content-Type": "image/png" },
    );
  });

  it("action が同期的に例外を投げた場合も正しく reject し、timeoutPromise が後から満了しても未処理の Promise rejection にならない(Codex コードレビュー r7 指摘 [D-2])", async () => {
    putObjectMock.mockImplementation(() => {
      throw new Error("sync failure");
    });
    const client = new MinioClient(testConfig);

    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      await expect(client.uploadObject("k", Buffer.from("x"), "image/png", 20)).rejects.toThrow(
        "sync failure",
      );
      // 元のタイムアウト(20ms)が満了する時間を待ち、その間に未処理の rejection が
      // 発生しないことを確認する(修正前は timeoutPromise が誰にも監視されないまま
      // 満了し、unhandledRejection が発火していた)。
      await delay(undefined, 50);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }

    expect(unhandledRejections).toEqual([]);
  });

  it("uploadObject は既定タイムアウト内に完了しない場合 StorageTimeoutError を投げる", async () => {
    putObjectMock.mockImplementation(() => delay({ etag: "late" }, 100));
    const client = new MinioClient(testConfig);

    await expect(
      client.uploadObject("k", Buffer.from("x"), "image/png", 20),
    ).rejects.toBeInstanceOf(StorageTimeoutError);
  });

  it("deleteObject は成功時に removeObject を呼ぶ", async () => {
    removeObjectMock.mockResolvedValue(undefined);
    const client = new MinioClient(testConfig);

    await client.deleteObject("screenshots/user-1/note-1.png");

    expect(removeObjectMock).toHaveBeenCalledWith("test-bucket", "screenshots/user-1/note-1.png");
  });

  it("deleteObject は既定タイムアウト内に完了しない場合 StorageTimeoutError を投げる", async () => {
    removeObjectMock.mockImplementation(() => delay(undefined, 100));
    const client = new MinioClient(testConfig);

    await expect(client.deleteObject("k", 20)).rejects.toBeInstanceOf(StorageTimeoutError);
  });

  it("getObjectStream は成功時、取得したストリームの内容をそのまま返す(無通信タイムアウト監視のため PassThrough でラップされ、参照自体は元のストリームと一致しない)", async () => {
    const fakeStream = createFakeReadableStream();
    const destroySpy = vi.spyOn(fakeStream, "destroy");
    getObjectMock.mockResolvedValue(fakeStream);
    const client = new MinioClient(testConfig);

    const stream = await client.getObjectStream("k");
    expect(stream).not.toBe(fakeStream);

    fakeStream.push(Buffer.from("hello"));
    fakeStream.push(null);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }

    expect(Buffer.concat(chunks).toString("utf8")).toBe("hello");
    // 最後まで読み切った場合、Node の Readable 自体の既定動作(autoDestroy)により
    // `destroy()` が引数無しで呼ばれること自体は正常(既に自然終了しているため無害)。
    // ここで確認したいのは「強制的な(エラー付きの)破棄が起きていないこと」であり、
    // 呼び出し回数そのものではない。
    for (const call of destroySpy.mock.calls) {
      expect(call[0]).toBeUndefined();
    }
  });

  it('getObjectStream の返却直後、呼び出し元が購読する前にデータが届いてもチャンクが失われない(Codex コードレビュー r6 指摘 [D-1]: source へ直接 on("data") すると flowing モードへ即時移行し、購読前に届いたチャンクが失われうる)', async () => {
    const fakeStream = createFakeReadableStream();
    getObjectMock.mockResolvedValue(fakeStream);
    const client = new MinioClient(testConfig);

    const stream = await client.getObjectStream("k");
    // 呼び出し元がまだ for-await/pipe で購読していない間にデータが届くケースを再現する。
    fakeStream.push(Buffer.from("early-chunk"));
    fakeStream.push(null);

    // 購読開始を意図的に遅らせる。
    await delay(undefined, 10);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }

    expect(Buffer.concat(chunks).toString("utf8")).toBe("early-chunk");
  });

  it("getObjectStream はタイムアウト発火時に StorageTimeoutError を投げ、遅延して返却されたストリームを破棄する", async () => {
    const fakeStream = createFakeReadableStream();
    const destroySpy = vi.spyOn(fakeStream, "destroy");
    getObjectMock.mockImplementation(() => delay(fakeStream, 100));
    const client = new MinioClient(testConfig);

    await expect(client.getObjectStream("k", 20)).rejects.toBeInstanceOf(StorageTimeoutError);

    // SDK 呼び出し(モック)が遅れて解決するのを待ち、その後ストリームが破棄されたことを確認する
    await delay(undefined, 120);
    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  it("getObjectStream はタイムアウトしない場合、返却されたストリームを破棄しない", async () => {
    const fakeStream = createFakeReadableStream();
    const destroySpy = vi.spyOn(fakeStream, "destroy");
    getObjectMock.mockImplementation(() => delay(fakeStream, 5));
    const client = new MinioClient(testConfig);

    await client.getObjectStream("k", 200);

    await delay(undefined, 50);
    expect(destroySpy).not.toHaveBeenCalled();
  });

  it("getObjectStream はストリーム返却後にデータが一定時間届かない場合、無通信タイムアウトでストリームを破棄する(Codex コードレビュー r5 指摘 [D-2])", async () => {
    const fakeStream = createFakeReadableStream();
    const destroySpy = vi.spyOn(fakeStream, "destroy");
    getObjectMock.mockResolvedValue(fakeStream);
    const client = new MinioClient(testConfig);

    await client.getObjectStream("k", 20);
    // ストリーム自体は即座に返却される(タイムアウトしない)が、その後データを一切流さない。
    await delay(undefined, 40);

    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(destroySpy.mock.calls[0][0]).toBeInstanceOf(StorageTimeoutError);
  });

  it("getObjectStream はデータが届き続ける限り無通信タイムアウトで破棄しない", async () => {
    const fakeStream = createFakeReadableStream();
    const destroySpy = vi.spyOn(fakeStream, "destroy");
    getObjectMock.mockResolvedValue(fakeStream);
    const client = new MinioClient(testConfig);

    await client.getObjectStream("k", 30);
    fakeStream.push(Buffer.from("chunk-1"));
    await delay(undefined, 20);
    fakeStream.push(Buffer.from("chunk-2"));
    await delay(undefined, 20);

    expect(destroySpy).not.toHaveBeenCalled();
    fakeStream.push(null);
  });

  it("getObjectStream はダウンストリームのバックプレッシャーによる一時停止中、無通信タイムアウトを一時停止する(Codex コードレビュー r9 指摘 [D-2])", async () => {
    const fakeStream = createFakeReadableStream();
    const destroySpy = vi.spyOn(fakeStream, "destroy");
    getObjectMock.mockResolvedValue(fakeStream);
    const client = new MinioClient(testConfig);

    await client.getObjectStream("k", 30);
    // 呼び出し元(output)を一切消費しないまま、PassThrough の既定 highWaterMark(16KB)を
    // 超えるチャンクを push する。`pipe()` 自身のバックプレッシャー制御により、MinIO 側に
    // 何の問題も無くても source が `pause()` されたまま維持される状況を再現する。
    fakeStream.push(Buffer.alloc(64 * 1024, 1));

    // タイムアウト時間を超えて待っても、バックプレッシャーによる一時停止中は破棄されない。
    await delay(undefined, 60);
    expect(destroySpy).not.toHaveBeenCalled();

    fakeStream.push(null);
  });

  it("getObjectStream はsource自体が正常終了していれば、呼び出し元の購読・読み出しが遅れても無通信タイムアウトで破棄しない(Codex コードレビュー r10 指摘 [D-2])", async () => {
    const fakeStream = createFakeReadableStream();
    const destroySpy = vi.spyOn(fakeStream, "destroy");
    getObjectMock.mockResolvedValue(fakeStream);
    const client = new MinioClient(testConfig);

    const stream = await client.getObjectStream("k", 30);
    // source(MinIOからのストリーム)自体はすぐに完結させるが、呼び出し元は
    // タイムアウト時間を超えるまで一切購読・読み出しを行わない。
    fakeStream.push(Buffer.from("hello"));
    fakeStream.push(null);
    await delay(undefined, 60);
    // Node の Readable 自体の既定動作(autoDestroy)により、既に自然終了した source が
    // 引数無しで destroy() されること自体は正常(無害)。ここで確認したいのは
    // StorageTimeoutError による強制的な破棄が起きていないことである。
    for (const call of destroySpy.mock.calls) {
      expect(call[0]).toBeUndefined();
    }

    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    expect(Buffer.concat(chunks).toString("utf8")).toBe("hello");
  });
});
