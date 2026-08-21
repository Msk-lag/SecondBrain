import { NoteEnrichmentMissingApiKeyError } from "./note-enrichment-error-markers";

/**
 * OpenAI embeddings エンドポイント(https://api.openai.com/v1/embeddings)への薄い
 * fetch ベースクライアント(M1-4a 計画 §設計決定5 参照)。embeddings エンドポイント1つしか
 * 使わないため、公式 SDK(openai パッケージ)は追加依存として導入しない。
 */
export const OPENAI_EMBEDDING_ENDPOINT = "https://api.openai.com/v1/embeddings";
/** ユーザー承認済み(M1-4a 計画 背景・§設計決定1 参照)。 */
export const OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
export const OPENAI_EMBEDDING_DIMENSIONS = 1536;
/**
 * embeddings API はスクリーンショット解析(Claude Vision)ほど重い処理ではないため、
 * claude-vision.client.ts の60秒より短い30秒とする。`AbortController` によりこの時間を
 * 超えたリクエストを中断する(§ このクライアント自身はリトライしない・再試行は BullMQ の
 * attempts:3 に一元化する 参照)。
 */
export const OPENAI_EMBEDDING_REQUEST_TIMEOUT_MS = 30_000;

/**
 * このクライアントが投げるエラーはすべてこのクラスを使い、message に API キー・
 * リクエストボディ(ノート内容)を含めない(§ 実装スコープ「エラーメッセージに API キーを
 * 含めない」参照)。
 */
export class OpenAiEmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAiEmbeddingError";
    Object.setPrototypeOf(this, OpenAiEmbeddingError.prototype);
  }
}

interface OpenAiEmbeddingApiResponse {
  data?: Array<{ embedding?: unknown }>;
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === "number");
}

function extractEmbedding(parsed: unknown): number[] {
  const response = parsed as OpenAiEmbeddingApiResponse;
  const embedding = response.data?.[0]?.embedding;
  if (!isNumberArray(embedding)) {
    throw new OpenAiEmbeddingError(
      "OpenAI embeddings response did not contain a valid embedding array",
    );
  }
  return embedding;
}

/**
 * `text-embedding-3-small`(1536次元)で埋め込みベクトルを生成するクライアント。
 * このクライアント自身は内部リトライを行わない(再試行は呼び出し元の BullMQ ジョブの
 * attempts:3 に一元化する。claude-vision.client.ts と同じ方針)。
 */
export class OpenAiEmbeddingClient {
  // ECMAScript の真の private フィールド(TypeScript の `private readonly` 修飾子だけでは
  // 実行時には通常のプロパティのままで、インスタンスを console.log/JSON.stringify すると
  // 値が露出してしまうため。Codex レビュー指摘への対応)。
  readonly #apiKey: string;

  constructor(apiKey: string) {
    this.#apiKey = apiKey;
  }

  async embed(input: string): Promise<number[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OPENAI_EMBEDDING_REQUEST_TIMEOUT_MS);

    try {
      let response: Response;
      try {
        response = await fetch(OPENAI_EMBEDDING_ENDPOINT, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.#apiKey}`,
          },
          body: JSON.stringify({ model: OPENAI_EMBEDDING_MODEL, input }),
          signal: controller.signal,
        });
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          throw new OpenAiEmbeddingError("OpenAI embeddings request timed out");
        }
        throw new OpenAiEmbeddingError("OpenAI embeddings request failed");
      }

      if (!response.ok) {
        throw new OpenAiEmbeddingError(
          `OpenAI embeddings request failed with status ${response.status}`,
        );
      }

      // ヘッダ受信後もレスポンス本文の読み取り(json())は `AbortController` の保護下で
      // 行う。`clearTimeout` を本文読み取り完了後(この try ブロックの外側の finally)まで
      // 遅らせることで、サーバーがヘッダのみ返し本文を送らない場合でも `signal` の abort が
      // 効き、ジョブが無期限にハングしない(Codex D0 レビュー HIGH 指摘への対応)。
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          throw new OpenAiEmbeddingError("OpenAI embeddings request timed out");
        }
        throw new OpenAiEmbeddingError("OpenAI embeddings response was not valid JSON");
      }

      const embedding = extractEmbedding(parsed);
      if (embedding.length !== OPENAI_EMBEDDING_DIMENSIONS) {
        throw new OpenAiEmbeddingError(
          `OpenAI embeddings response had unexpected dimensions: expected ${OPENAI_EMBEDDING_DIMENSIONS}, got ${embedding.length}`,
        );
      }
      return embedding;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** NoteEnrichmentModule の DI 提供用トークン(値は関数そのもの。下記 createOpenAiEmbeddingClientFromEnv 参照)。 */
export const OPENAI_EMBEDDING_CLIENT_FACTORY = "OPENAI_EMBEDDING_CLIENT_FACTORY";
export type OpenAiEmbeddingClientFactory = () => OpenAiEmbeddingClient;

/**
 * `OPENAI_API_KEY` は worker 起動時には検証しない(実行時チェック。§ 実装スコープ「未設定でも
 * 他機能を止めないため」参照)。そのため NoteEnrichmentModule ではこの関数自体を
 * `useValue`(呼び出さずそのまま渡す)として DI 登録し、NoteEnrichmentProcessor が
 * ジョブ処理中に実際に埋め込みを生成する必要が生じた時点で呼び出す
 * (createClaudeVisionClientFromEnv が `useFactory` で起動時に即時評価されるのとは異なる)。
 *
 * 未設定時は素の `Error` ではなく `NoteEnrichmentMissingApiKeyError` を投げる(Issue #70 / A-1
 * 対応)。`sanitize-enrichment-error.ts` の `classifyEnrichmentError()` は `instanceof` のみで
 * 分類する設計のため、素の `Error` はどのマーカー型にも該当せず `unknown_error` に落ちて
 * 原因がログから判別できなくなっていた(バグではなく設計方針の適用漏れ)。
 */
export function createOpenAiEmbeddingClientFromEnv(): OpenAiEmbeddingClient {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new NoteEnrichmentMissingApiKeyError();
  }
  return new OpenAiEmbeddingClient(apiKey);
}
