import {
  createOpenAiEmbeddingClientFromEnv,
  OpenAiEmbeddingClient,
  OpenAiEmbeddingError,
  OPENAI_EMBEDDING_DIMENSIONS,
  OPENAI_EMBEDDING_ENDPOINT,
  OPENAI_EMBEDDING_MODEL,
} from "./openai-embedding.client";

function validEmbeddingPayload(dimensions = OPENAI_EMBEDDING_DIMENSIONS): unknown {
  return { data: [{ embedding: Array.from({ length: dimensions }, (_, i) => i / dimensions) }] };
}

describe("OpenAiEmbeddingClient.embed", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("正常系: 1536次元の埋め込み配列を返す", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(validEmbeddingPayload()), { status: 200 }),
    );
    const client = new OpenAiEmbeddingClient("sk-test");

    const embedding = await client.embed("入力テキスト");

    expect(embedding).toHaveLength(OPENAI_EMBEDDING_DIMENSIONS);
  });

  it("正しいエンドポイント・モデル・Authorization ヘッダーでリクエストする", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(validEmbeddingPayload()), { status: 200 }),
    );
    const client = new OpenAiEmbeddingClient("sk-test-key");

    await client.embed("入力テキスト");

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(OPENAI_EMBEDDING_ENDPOINT);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-test-key");
    expect(JSON.parse(init.body as string)).toEqual({
      model: OPENAI_EMBEDDING_MODEL,
      input: "入力テキスト",
    });
  });

  it("HTTP エラー応答(status !== ok)は OpenAiEmbeddingError になり、API キーを含まない", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 401 }));
    const client = new OpenAiEmbeddingClient("sk-secret-key");

    const error = await client.embed("x").catch((err: unknown) => err);

    expect(error).toBeInstanceOf(OpenAiEmbeddingError);
    expect((error as Error).message).toContain("401");
    expect((error as Error).message).not.toContain("sk-secret-key");
  });

  it("レスポンスが不正な JSON の場合は OpenAiEmbeddingError になる", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("not json", { status: 200 }));
    const client = new OpenAiEmbeddingClient("sk-test");

    const error = await client.embed("x").catch((err: unknown) => err);

    expect(error).toBeInstanceOf(OpenAiEmbeddingError);
  });

  it("レスポンスに埋め込み配列が含まれない場合は OpenAiEmbeddingError になる", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const client = new OpenAiEmbeddingClient("sk-test");

    const error = await client.embed("x").catch((err: unknown) => err);

    expect(error).toBeInstanceOf(OpenAiEmbeddingError);
  });

  it("埋め込み配列に数値以外が混じる場合は OpenAiEmbeddingError になる", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: [{ embedding: [1, "not-a-number", 3] }] }), {
        status: 200,
      }),
    );
    const client = new OpenAiEmbeddingClient("sk-test");

    const error = await client.embed("x").catch((err: unknown) => err);

    expect(error).toBeInstanceOf(OpenAiEmbeddingError);
  });

  it("次元数が1536と異なる場合は OpenAiEmbeddingError になる(次元固定の検証)", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(validEmbeddingPayload(10)), { status: 200 }),
    );
    const client = new OpenAiEmbeddingClient("sk-test");

    const error = await client.embed("x").catch((err: unknown) => err);

    expect(error).toBeInstanceOf(OpenAiEmbeddingError);
    expect((error as Error).message).toContain("1536");
  });

  it("fetch 自体が失敗した場合(ネットワークエラー)は OpenAiEmbeddingError になる", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("network unreachable"));
    const client = new OpenAiEmbeddingClient("sk-test");

    const error = await client.embed("x").catch((err: unknown) => err);

    expect(error).toBeInstanceOf(OpenAiEmbeddingError);
  });

  it("タイムアウト(AbortError)の場合は OpenAiEmbeddingError になる", async () => {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    vi.mocked(fetch).mockRejectedValue(abortError);
    const client = new OpenAiEmbeddingClient("sk-test");

    const error = await client.embed("x").catch((err: unknown) => err);

    expect(error).toBeInstanceOf(OpenAiEmbeddingError);
    expect((error as Error).message).toContain("timed out");
  });

  it("ヘッダ受信後・本文読み取り中(response.json())に AbortError が発生した場合も OpenAiEmbeddingError(タイムアウト)になる(Codex D0 レビュー HIGH 指摘: fetch のタイムアウト保護が本文受信まで及んでいなかった問題への対応)", async () => {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    const fakeResponse = { ok: true, status: 200, json: vi.fn().mockRejectedValue(abortError) };
    vi.mocked(fetch).mockResolvedValue(fakeResponse as unknown as Response);
    const client = new OpenAiEmbeddingClient("sk-test");

    const error = await client.embed("x").catch((err: unknown) => err);

    expect(error).toBeInstanceOf(OpenAiEmbeddingError);
    expect((error as Error).message).toContain("timed out");
  });

  it("clearTimeout はヘッダ受信直後ではなく、本文読み取り(response.json())完了後に呼ばれる(本文受信が無保護のままハングしないことの確認)", async () => {
    vi.useFakeTimers();
    try {
      let resolveJson!: (value: unknown) => void;
      const jsonPromise = new Promise((resolve) => {
        resolveJson = resolve;
      });
      const fakeResponse = { ok: true, status: 200, json: () => jsonPromise };
      vi.mocked(fetch).mockResolvedValue(fakeResponse as unknown as Response);
      const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");
      const client = new OpenAiEmbeddingClient("sk-test");

      const embedPromise = client.embed("x");
      // fetch(ヘッダ受信)自体は解決済みだが、response.json()(本文読み取り)はまだ pending。
      await Promise.resolve();
      await Promise.resolve();
      expect(clearTimeoutSpy).not.toHaveBeenCalled();

      resolveJson(validEmbeddingPayload());
      await embedPromise;

      expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("!response.ok の早期 return 経路でも timer は必ずクリアされる(リークしない)", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 500 }));
    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");
    const client = new OpenAiEmbeddingClient("sk-test");

    await expect(client.embed("x")).rejects.toBeInstanceOf(OpenAiEmbeddingError);

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  it("インスタンスを JSON.stringify しても API キーが含まれない(#apiKey は ECMAScript の真の private フィールドで列挙不可。Codex レビュー指摘への回帰テスト)", () => {
    const client = new OpenAiEmbeddingClient("sk-super-secret-key");

    expect(JSON.stringify(client)).not.toContain("sk-super-secret-key");
    expect(Object.keys(client)).not.toContain("apiKey");
  });
});

describe("createOpenAiEmbeddingClientFromEnv", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it.each([undefined, "", "   "])(
    "OPENAI_API_KEY が未設定・空・空白のみ('%s')の場合は呼び出し時に例外を投げる",
    (invalid) => {
      if (invalid === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = invalid;
      }
      expect(() => createOpenAiEmbeddingClientFromEnv()).toThrow(
        /OPENAI_API_KEY must be set to a non-empty value/,
      );
    },
  );

  it("OPENAI_API_KEY が有効な値の場合はクライアントを構築する", () => {
    process.env.OPENAI_API_KEY = "sk-ant-test-key";
    expect(createOpenAiEmbeddingClientFromEnv()).toBeInstanceOf(OpenAiEmbeddingClient);
  });
});
