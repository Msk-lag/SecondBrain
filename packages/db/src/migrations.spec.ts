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

describe("notes テーブルのマイグレーション SQL", () => {
  const sql = readAllMigrationSql();

  it("notes テーブルを作成している", () => {
    expect(sql).toMatch(/CREATE TABLE `notes`/i);
  });

  it("id が varchar(36) の主キーである", () => {
    expect(sql).toMatch(/`id` varchar\(36\) NOT NULL/i);
    expect(sql).toMatch(/CONSTRAINT `notes_id` PRIMARY KEY\(`id`\)/i);
  });

  it("user_id が NOT NULL かつ users への外部キーである", () => {
    expect(sql).toMatch(/`user_id` varchar\(36\) NOT NULL/i);
    expect(sql).toMatch(
      /ALTER TABLE `notes` ADD CONSTRAINT `notes_user_id_users_id_fk` FOREIGN KEY \(`user_id`\) REFERENCES `users`\(`id`\)/i,
    );
  });

  it("type が memo/url/screenshot の enum で default memo である", () => {
    expect(sql).toMatch(/`type` enum\('memo','url','screenshot'\) NOT NULL DEFAULT 'memo'/i);
  });

  it("body が NOT NULL、title/summary は nullable である", () => {
    expect(sql).toMatch(/`body` text NOT NULL/i);
    expect(sql).toMatch(/`title` varchar\(255\),/i);
    expect(sql).toMatch(/`summary` text,/i);
  });

  it("tags が NOT NULL の json カラムである", () => {
    expect(sql).toMatch(/`tags` json NOT NULL/i);
  });

  it("created_at / updated_at がデフォルト付き NOT NULL である", () => {
    expect(sql).toMatch(/`created_at` timestamp NOT NULL DEFAULT/i);
    expect(sql).toMatch(/`updated_at` timestamp NOT NULL DEFAULT/i);
  });

  it("カーソルページネーション用の複合インデックスを持つ", () => {
    expect(sql).toMatch(
      /CREATE INDEX `notes_user_id_created_at_id_idx` ON `notes` \(`user_id`,`created_at`,`id`\)/i,
    );
  });
});
