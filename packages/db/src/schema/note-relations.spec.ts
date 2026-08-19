import { getTableConfig } from "drizzle-orm/mysql-core";
import { notes } from "./notes.js";
import {
  noteRelationTypeDirectionValues,
  noteRelationTypeValues,
  noteRelations,
} from "./note-relations.js";
import { users } from "./users.js";

/**
 * note_relations テーブル定義の単体テスト。foreign key / check / index / unique の
 * 各定義は drizzle 内部で `(table) => [...]` の extra-config コールバックと
 * `.references(() => ...)` の遅延コールバックが評価されるまで実行されないため、
 * drizzle が公開している `getTableConfig` を使って評価を強制し検証する
 * (notes.spec.ts 冒頭コメントの方針を踏襲: drizzle の内部クラスへ直接アクセスすると
 * 壊れやすいテストになるため、drizzle が公開している手段のみを使う)。
 */
const config = getTableConfig(noteRelations);

function findForeignKey(columnName: string) {
  const fk = config.foreignKeys.find((candidate) => {
    const { columns } = candidate.reference();
    return columns.some((column) => column.name === columnName);
  });
  if (!fk) {
    throw new Error(`foreign key for column "${columnName}" not found`);
  }
  return fk;
}

describe("noteRelationTypeValues", () => {
  it("7値固定語彙を持つ", () => {
    expect(noteRelationTypeValues).toEqual([
      "same-theme",
      "cause-solution",
      "claim-counter",
      "concept-hierarchy",
      "tech-example",
      "problem-remedy",
      "other",
    ]);
  });
});

describe("noteRelationTypeDirectionValues", () => {
  it("a-to-b/b-to-a/none を持つ", () => {
    expect(noteRelationTypeDirectionValues).toEqual(["a-to-b", "b-to-a", "none"]);
  });
});

describe("note_relations の外部キー(M1-4b §設計決定1 参照)", () => {
  it("note_a_id は notes を参照し ON DELETE CASCADE である", () => {
    const fk = findForeignKey("note_a_id");
    const { foreignTable, foreignColumns } = fk.reference();
    expect(foreignTable).toBe(notes);
    expect(foreignColumns[0]?.name).toBe("id");
    expect(fk.onDelete).toBe("cascade");
  });

  it("note_b_id は notes を参照し ON DELETE CASCADE である", () => {
    const fk = findForeignKey("note_b_id");
    const { foreignTable, foreignColumns } = fk.reference();
    expect(foreignTable).toBe(notes);
    expect(foreignColumns[0]?.name).toBe("id");
    expect(fk.onDelete).toBe("cascade");
  });

  // source_note_id は生成契機ノードであり notes を直接指すエッジの端点ではないが、
  // MariaDB では同一被参照行に CASCADE と RESTRICT の FK が混在すると RESTRICT が
  // 勝ち note_a_id/note_b_id 側の CASCADE を打ち消してしまうため、この列にも
  // 必ず CASCADE が必要(M1-4b §設計決定1 参照。note-purge が FK 違反で
  // 永久に失敗しないことを守る)。
  it("source_note_id は notes を参照し ON DELETE CASCADE である", () => {
    const fk = findForeignKey("source_note_id");
    const { foreignTable, foreignColumns } = fk.reference();
    expect(foreignTable).toBe(notes);
    expect(foreignColumns[0]?.name).toBe("id");
    expect(fk.onDelete).toBe("cascade");
  });

  it("user_id は users を参照し、CASCADE ではない(既定の ON DELETE のまま)", () => {
    const fk = findForeignKey("user_id");
    const { foreignTable, foreignColumns } = fk.reference();
    expect(foreignTable).toBe(users);
    expect(foreignColumns[0]?.name).toBe("id");
    expect(fk.onDelete).not.toBe("cascade");
  });
});

describe("note_relations の一意制約(正規化ペアの重複防止。M1-4b §設計決定1 参照)", () => {
  it("UNIQUE(user_id, note_a_id, note_b_id) が存在する", () => {
    const unique = config.uniqueConstraints.find(
      (candidate) => candidate.getName() === "note_relations_user_id_note_a_id_note_b_id_unique",
    );
    expect(unique).toBeDefined();
    expect(unique?.columns.map((column) => column.name)).toEqual([
      "user_id",
      "note_a_id",
      "note_b_id",
    ]);
  });
});

describe("note_relations の CHECK 制約(正規化をキー構造で担保。M1-4b §設計決定1 参照)", () => {
  it("note_a_id < note_b_id の CHECK が存在する", () => {
    const check = config.checks.find(
      (candidate) => candidate.name === "note_relations_note_a_id_lt_note_b_id",
    );
    expect(check).toBeDefined();
  });

  it("source_note_id が note_a_id/note_b_id いずれかと一致する CHECK が存在する", () => {
    const check = config.checks.find(
      (candidate) => candidate.name === "note_relations_source_note_id_is_endpoint",
    );
    expect(check).toBeDefined();
  });

  it("CHECK 制約は上記2本のみである", () => {
    expect(config.checks).toHaveLength(2);
  });
});

describe("note_relations の索引(詳細画面・M2ネットワーク描画の両端参照用)", () => {
  it("note_a_id の索引が存在する", () => {
    const index = config.indexes.find(
      (candidate) => candidate.config.name === "note_relations_note_a_id_idx",
    );
    expect(index).toBeDefined();
    const columnNames = index?.config.columns.map((column) =>
      "name" in column ? column.name : undefined,
    );
    expect(columnNames).toEqual(["note_a_id"]);
  });

  it("note_b_id の索引が存在する", () => {
    const index = config.indexes.find(
      (candidate) => candidate.config.name === "note_relations_note_b_id_idx",
    );
    expect(index).toBeDefined();
    const columnNames = index?.config.columns.map((column) =>
      "name" in column ? column.name : undefined,
    );
    expect(columnNames).toEqual(["note_b_id"]);
  });
});
