import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

/**
 * リポジトリルートの .env を読み込む(既に設定済みの環境変数は上書きしない)。
 * cwd に依存しないよう、このファイルからの相対位置で解決する
 * (src/ と dist/ は同じ深さにあるためビルド後も同じパスになる)。
 */
export function loadRootEnv(): void {
  config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });
}

/**
 * mysql2(`SslOptions`)と drizzle-kit(dbCredentials.ssl の型)の両方に構造的に適合する、
 * このモジュールが実際に生成するフィールドだけの最小限の TLS オプション型。
 * mysql2 側の `SslOptions.ca` は `string | string[] | Buffer | Buffer[]` を許容するが、
 * drizzle-kit 側の型定義は `string | string[]` までしか許容しないため、`Buffer` を使わず
 * `string` に統一することで、`packages/db/src/client.ts`(mysql2 経由)と
 * `packages/db/drizzle.config.ts`(drizzle-kit 経由)の両方へ同じ値をそのまま渡せるようにする。
 */
export interface MariadbTlsOptions {
  ca?: string;
  rejectUnauthorized: true;
}

export interface DbConnectionOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  /**
   * mysql2 の TLS 接続オプション。未設定(undefined)なら mysql2 の既定どおり TLS 無しで
   * 接続する(ローカルの docker MariaDB は既定 `require_secure_transport=0` のため、
   * これで挙動が変わらない)。RDS for MariaDB 11.8 は `require_secure_transport` の既定値が
   * `0` → `1` に変更されているため、本番では `MARIADB_SSL=true` を設定して有効化する
   * (M1-4b 計画 §設計決定12)。
   */
  ssl?: MariadbTlsOptions;
}

/**
 * `MARIADB_SSL` の許容値は `"true"` / `"false"` のみ(未設定は `"false"` 相当)。
 * それ以外の値(例: "1"・"yes"・大文字小文字違い等)を黙って false 扱いにすると、
 * 「TLS を有効にしたつもりが実は無効だった」「無効にしたつもりが実は有効だった」という
 * 設定ミスに気づけないまま本番稼働してしまう。不正値は起動時に例外で落として
 * 設定ミスを早期に検出できるようにする(黙って false へフォールバックしない)。
 */
function parseMariadbSslFlag(): boolean {
  const raw = process.env.MARIADB_SSL;
  if (raw === undefined) {
    return false;
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  throw new Error(
    `MARIADB_SSL environment variable must be "true" or "false" (got: ${JSON.stringify(raw)})`,
  );
}

/**
 * 環境変数から mysql2 の `ssl` オプションを組み立てる。
 *
 * `packages/db` の `createPool` はこの関数の戻り値をそのまま `mysql2.createPool` の `ssl`
 * オプションへ渡す。api・worker・migration(drizzle-kit)はいずれも最終的にこの関数
 * (または `dbConnectionOptionsFromEnv` 経由)を通って接続オプションを組み立てるため、
 * ここ1箇所の実装で全経路に TLS 対応が及ぶ。
 *
 * - `MARIADB_SSL` が未設定/`"false"` の場合は `undefined` を返す(TLS を有効化しない。
 *   ローカル docker の挙動は変わらない)
 * - `MARIADB_SSL=true` の場合、`MARIADB_SSL_CA`(CA バンドルの PEM ファイルパス)が
 *   指定されていればそれを読み込んで `ca` に渡す。未指定なら `ca` を設定せず、
 *   Node.js の既定の信頼ストア(システム CA)で検証させる。それで接続に失敗する場合は
 *   黙って検証を落とさず、そのまま失敗させる(§設計決定12 の必須制約)
 * - `rejectUnauthorized` は必ず `true` を明示する(mysql2 の既定も true だが、将来の
 *   ライブラリ既定値変更に備えて明示的に固定する)。これを `false` にする経路・
 *   検証を無効化する環境変数は絶対に追加しない
 */
export function sslOptionsFromEnv(): MariadbTlsOptions | undefined {
  if (!parseMariadbSslFlag()) {
    return undefined;
  }

  const caPath = process.env.MARIADB_SSL_CA;
  const ssl: MariadbTlsOptions = { rejectUnauthorized: true };
  if (caPath) {
    // 読み込み失敗(ファイル不在・権限不足等)はここで例外を送出し、TLS 無し・検証無しへ
    // 黙ってフォールバックさせない(§設計決定12 の必須制約: 起動時に明示的なエラーで落とす)。
    ssl.ca = readFileSync(caPath, "utf8");
  }
  return ssl;
}

export function dbConnectionOptionsFromEnv(): DbConnectionOptions {
  const password = process.env.MARIADB_PASSWORD;
  if (!password) {
    throw new Error("MARIADB_PASSWORD environment variable is required but not set");
  }
  return {
    host: process.env.MARIADB_HOST ?? "localhost",
    port: Number(process.env.MARIADB_PORT ?? 3306),
    user: process.env.MARIADB_USER ?? "secondbrain",
    password,
    database: process.env.MARIADB_DATABASE ?? "secondbrain",
    ssl: sslOptionsFromEnv(),
  };
}
