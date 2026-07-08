import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * 生成済みマイグレーション SQL の静的検証。
 * users テーブルは M1 全体(認証・user_id データ分離)の土台のため、
 * migration 再生成で重要制約が落ちた場合に CI で検出する。
 */
const migrationsDir = fileURLToPath(new URL("../migrations/", import.meta.url));

function readAllMigrationSql(): string {
  const files = readdirSync(migrationsDir).filter((file) => file.endsWith(".sql"));
  expect(files.length).toBeGreaterThan(0);
  return files.map((file) => readFileSync(join(migrationsDir, file), "utf8")).join("\n");
}

describe("users テーブルのマイグレーション SQL", () => {
  const sql = readAllMigrationSql();

  it("users テーブルを作成している", () => {
    expect(sql).toMatch(/CREATE TABLE `users`/i);
  });

  it("id が varchar(36) の主キーである", () => {
    expect(sql).toMatch(/`id` varchar\(36\) NOT NULL/i);
    expect(sql).toMatch(/PRIMARY KEY\(`id`\)/i);
  });

  it("email が NOT NULL かつ UNIQUE である", () => {
    expect(sql).toMatch(/`email` varchar\(255\) NOT NULL/i);
    expect(sql).toMatch(/UNIQUE\(`email`\)/i);
  });

  it("password_hash が NOT NULL である", () => {
    expect(sql).toMatch(/`password_hash` varchar\(255\) NOT NULL/i);
  });

  it("created_at / updated_at がデフォルト付き NOT NULL である", () => {
    expect(sql).toMatch(/`created_at` timestamp NOT NULL DEFAULT/i);
    expect(sql).toMatch(/`updated_at` timestamp NOT NULL DEFAULT/i);
  });
});
