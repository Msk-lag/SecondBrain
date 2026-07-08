import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

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
  },
});
