import "dotenv/config";
import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { sql } from "drizzle-orm";

interface SimilarityRow {
  label: string;
  dist: number;
}

async function main() {
  const connection = await mysql.createConnection({
    host: "localhost",
    port: Number(process.env.MARIADB_PORT ?? 3306),
    user: process.env.MARIADB_USER ?? "secondbrain",
    password: process.env.MARIADB_PASSWORD ?? "changeme-app",
    database: process.env.MARIADB_DATABASE ?? "secondbrain",
  });
  const db = drizzle(connection);

  // 実行ごとに一意なテーブル名を使う: MariaDB は一時テーブルへの VECTOR INDEX 作成を
  // 許可しない(ER_INNODB_NO_FT_TEMP_TABLE)ため通常テーブルを使うが、固定名だと
  // 既存の同名テーブルを誤って削除するリスクがあるため、実行のたびに異なる名前にする。
  const tableName = `poc_vector_items_${randomUUID().replace(/-/g, "")}`;

  try {
    await db.execute(sql`
      CREATE TABLE ${sql.identifier(tableName)} (
        id INT PRIMARY KEY AUTO_INCREMENT,
        label VARCHAR(50) NOT NULL,
        embedding VECTOR(4) NOT NULL,
        VECTOR INDEX (embedding)
      )
    `);

    await db.execute(sql`
      INSERT INTO ${sql.identifier(tableName)} (label, embedding) VALUES
        ('near-a', VEC_FromText('[1,0,0,0]')),
        ('near-b', VEC_FromText('[0.9,0.1,0,0]')),
        ('far',    VEC_FromText('[0,0,0,1]'))
    `);

    const result = await db.execute<SimilarityRow>(sql`
      SELECT label, VEC_DISTANCE_COSINE(embedding, VEC_FromText('[1,0,0,0]')) AS dist
      FROM ${sql.identifier(tableName)}
      ORDER BY dist ASC
    `);

    const rows = result[0] as unknown as SimilarityRow[];
    console.table(rows);

    const labelsInOrder = rows.map((row) => row.label);
    const expectedOrder = ["near-a", "near-b", "far"];
    const matches =
      labelsInOrder.length === expectedOrder.length &&
      labelsInOrder.every((label, index) => label === expectedOrder[index]);

    if (!matches) {
      throw new Error(
        `unexpected similarity order: got [${labelsInOrder.join(", ")}], expected [${expectedOrder.join(", ")}]`,
      );
    }

    console.log(
      "OK: MariaDB VECTOR type + VEC_DISTANCE_COSINE returned the expected similarity order.",
    );
  } finally {
    await db.execute(sql`DROP TABLE IF EXISTS ${sql.identifier(tableName)}`);
    await connection.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
