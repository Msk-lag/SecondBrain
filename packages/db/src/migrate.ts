import { fileURLToPath } from "node:url";
import type { Pool } from "mysql2/promise";
import { migrate as drizzleMigrate } from "drizzle-orm/mysql2/migrator";
import { createDb } from "./client.js";

/**
 * `packages/db/migrations/` の生成済み SQL を順に適用する drizzle-orm 標準のマイグレーション
 * ランナー。`pnpm db:migrate`(drizzle-kit CLI)と同様に `0000`〜`00XX` を順次適用する。
 *
 * apps/api・apps/worker の統合テスト用セットアップ(§ テスト方針・実装手順25 参照)が、
 * 専用テスト DB に対してこの同一の適用処理を呼び出す(Codex レビュー r7 指摘 [1] への対応:
 * `AppModule`/`DbModule` の起動だけではテーブルは作成されないため、この関数で明示的に適用する)。
 * `src/`・`dist/` は同じ深さにあるため、ビルド後も同じ相対パスで migrations フォルダを解決できる
 * (packages/db の他の *FromEnv 系ファイルと同じパターン)。
 */
export async function runMigrations(pool: Pool): Promise<void> {
  const migrationsFolder = fileURLToPath(new URL("../migrations/", import.meta.url));
  const db = createDb(pool);
  await drizzleMigrate(db, { migrationsFolder });
}
