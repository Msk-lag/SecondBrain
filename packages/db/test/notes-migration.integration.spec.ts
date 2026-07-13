import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import { loadRootEnv } from "../src/env.js";
import { NOTES_MIGRATION_TEST_DB } from "./integration-setup.js";

/**
 * notes マイグレーションの実 DB 検証(§ テスト方針・実装手順25 参照。r4 指摘 [3] への対応)。
 * `packages/db/src/migrations.spec.ts` の静的検証(SQL テキストの正規表現照合)とは異なり、
 * 実際に MariaDB へ適用しながら「0000 → 0001 → (M1-2 時点相当のデータ投入) → 0002 →
 * (concepts backfill 確認) → 0003 → (NOT NULL 化後も読み出せること確認)」の適用順序自体を検証する。
 * MinIO・Redis・HTTP は一切関与しない。
 */

const migrationsDir = fileURLToPath(new URL("../migrations/", import.meta.url));

function readMigrationStatements(fileName: string): string[] {
  const sql = readFileSync(join(migrationsDir, fileName), "utf8");
  return sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

async function applyMigration(connection: mysql.Connection, fileName: string): Promise<void> {
  for (const statement of readMigrationStatements(fileName)) {
    await connection.query(statement);
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is required but not set`);
  }
  return value;
}

async function createTestDbConnection(): Promise<mysql.Connection> {
  loadRootEnv();
  return mysql.createConnection({
    host: process.env.MARIADB_HOST ?? "localhost",
    port: Number(process.env.MARIADB_PORT ?? 3306),
    // root 資格情報はテストセットアップ・このマイグレーション適用検証専用に限る
    // (アプリ実行時コードからは引き続き参照しない)。
    user: "root",
    password: requireEnv("MARIADB_ROOT_PASSWORD"),
    database: NOTES_MIGRATION_TEST_DB,
  });
}

interface ConceptsRow {
  concepts: string;
}

describe("notes テーブル拡張マイグレーションの実 DB 順次適用(0000→0001→データ投入→0002→0003)", () => {
  it("既存メモ相当のデータを壊さずに concepts の2段階 NOT NULL 化まで適用できる", async () => {
    const connection = await createTestDbConnection();
    try {
      // 0000: users テーブル作成
      await applyMigration(connection, "0000_chubby_northstar.sql");
      // 0001: notes テーブル作成(この時点の notes は M1-2 相当。body は NOT NULL)
      await applyMigration(connection, "0001_redundant_trauma.sql");

      // M1-2 時点を模した既存データを1件投入する(concepts 列がまだ存在しない状態)。
      const userId = randomUUID();
      const noteId = randomUUID();
      await connection.query(
        "INSERT INTO `users` (`id`, `email`, `password_hash`) VALUES (?, ?, ?)",
        [userId, `${userId}@example.com`, "dummy-hash"],
      );
      await connection.query(
        "INSERT INTO `notes` (`id`, `user_id`, `body`, `tags`) VALUES (?, ?, ?, ?)",
        [noteId, userId, "M1-2 時点の既存メモ本文", "[]"],
      );

      // 0002: status/failureReason/imageKey/imageMimeType/concepts(nullable)/extractedText/
      // deletedAt/processingGeneration/processingAttemptToken 追加 + concepts の backfill。
      await applyMigration(connection, "0002_naive_doctor_doom.sql");

      const [afterAddRows] = await connection.query<mysql.RowDataPacket[]>(
        "SELECT `concepts` FROM `notes` WHERE `id` = ?",
        [noteId],
      );
      const afterAdd = afterAddRows[0] as ConceptsRow;
      expect(JSON.parse(afterAdd.concepts)).toEqual([]);

      // 0003: concepts を NOT NULL化。backfill 済みの既存行が引き続き読み出せることを確認する。
      await applyMigration(connection, "0003_shiny_blob.sql");

      const [afterNotNullRows] = await connection.query<mysql.RowDataPacket[]>(
        "SELECT `concepts` FROM `notes` WHERE `id` = ?",
        [noteId],
      );
      const afterNotNull = afterNotNullRows[0] as ConceptsRow;
      expect(JSON.parse(afterNotNull.concepts)).toEqual([]);
    } finally {
      await connection.end();
    }
  });
});
