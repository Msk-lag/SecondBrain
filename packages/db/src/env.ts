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

export interface DbConnectionOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
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
  };
}
