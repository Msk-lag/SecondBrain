import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";
import { sslOptionsFromEnv } from "./src/env.js";

// リポジトリルートの .env を読み込む(cwd 非依存)
config({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });

export default defineConfig({
  dialect: "mysql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dbCredentials: {
    host: process.env.MARIADB_HOST ?? "localhost",
    port: Number(process.env.MARIADB_PORT ?? 3306),
    user: process.env.MARIADB_USER ?? "secondbrain",
    password: process.env.MARIADB_PASSWORD ?? "",
    database: process.env.MARIADB_DATABASE ?? "secondbrain",
    // `pnpm db:migrate`(drizzle-kit CLI)は packages/db/src/client.ts の createPool を
    // 通らない独立した接続経路のため、ここにも同じ TLS 設定を個別に適用する
    // (M1-4b 計画 §設計決定12。migration 経路にも require_secure_transport=1 対応が必要)。
    // src/env.ts の sslOptionsFromEnv() と同一のロジックを再利用する(二重実装を避ける)。
    ssl: sslOptionsFromEnv(),
  },
});
