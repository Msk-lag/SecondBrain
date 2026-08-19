import { sql } from "drizzle-orm";
import {
  check,
  datetime,
  decimal,
  index,
  mysqlEnum,
  mysqlTable,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/mysql-core";
import { notes } from "./notes.js";
import { users } from "./users.js";

// AI が判定した関係の種類(7値固定語彙。M1-4b §設計決定1 参照)。
// AI 出力がこれ以外の場合は "other" へ丸め、その場合 typeDirection は "none" になる。
// DB 制約としては単純な varchar(32) に留め、語彙の正当性はアプリ層
// (relation-judge クライアントの応答境界検証)で担保する。
export const noteRelationTypeValues = [
  "same-theme",
  "cause-solution",
  "claim-counter",
  "concept-hierarchy",
  "tech-example",
  "problem-remedy",
  "other",
] as const;
export type NoteRelationType = (typeof noteRelationTypeValues)[number];

// 保存ノート視点から見た関係の向き。読みは「a →(種類の左項→右項)→ b」
// (例: cause-solution で a-to-b なら a が原因・b が解決策)。
// same-theme/other は常に "none"(M1-4b §設計決定1 参照)。
export const noteRelationTypeDirectionValues = ["a-to-b", "b-to-a", "none"] as const;
export type NoteRelationTypeDirection = (typeof noteRelationTypeDirectionValues)[number];

export const noteRelations = mysqlTable(
  "note_relations",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    // 既存 notes.userId と同じ流儀(ON DELETE は既定)。
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id),
    // 正規化ペアの端点(note_a_id < note_b_id。CHECK は本テーブル末尾で定義)。
    // purge(NotePurgeProcessor)が notes を物理 DELETE するため、孤児エッジが
    // 蓄積しないよう ON DELETE CASCADE にする(M1-4b §設計決定1 参照)。
    noteAId: varchar("note_a_id", { length: 36 })
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    noteBId: varchar("note_b_id", { length: 36 })
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    // 生成契機となった(保存された側の)ノート。MariaDB では同一被参照行に
    // CASCADE と RESTRICT の FK が混在すると RESTRICT が勝ち note_a_id/note_b_id の
    // CASCADE を打ち消して purge が失敗するため、この列にも必ず CASCADE を付ける
    // (M1-4b §設計決定1 参照。CHECK により CASCADE 対象が余分に広がることはない)。
    sourceNoteId: varchar("source_note_id", { length: 36 })
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    relationType: varchar("relation_type", { length: 32 }).notNull(),
    typeDirection: mysqlEnum("type_direction", noteRelationTypeDirectionValues)
      .notNull()
      .default("none"),
    // なぜ繋がるかの説明(日本語)。AI 応答が 500 文字超過の場合は境界検証で切り詰める。
    description: varchar("description", { length: 500 }).notNull(),
    // 0.00〜1.00。AI 応答は境界検証で clamp・小数第2位丸め済みの値のみを書き込む。
    relatedness: decimal("relatedness", { precision: 3, scale: 2 }).notNull(),
    // 判定時点の note_a/note_b 側の embedding_fingerprint。generated_from(source 側のみ)
    // では候補側ノートの編集による陳腐化を検知できないため、両端で持つ
    // (M1-4b §設計決定1 参照。後から列を足してもバックフィル不能なため今入れる)。
    noteAFingerprint: varchar("note_a_fingerprint", { length: 64 }).notNull(),
    noteBFingerprint: varchar("note_b_fingerprint", { length: 64 }).notNull(),
    // 論理削除(UI・再有効化フローは F-22/M3。スキーマのみ先行して持たせる)。
    deletedAt: datetime("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (table) => [
    // 逆順重複の一意性規則(正規化により1組1行。M1-4b §設計決定1 参照)
    unique("note_relations_user_id_note_a_id_note_b_id_unique").on(
      table.userId,
      table.noteAId,
      table.noteBId,
    ),
    // 詳細画面・M2(ネットワーク描画)の両端参照用
    index("note_relations_note_a_id_idx").on(table.noteAId),
    index("note_relations_note_b_id_idx").on(table.noteBId),
    // 正規化をキー構造で担保する CHECK 制約(M1-4b §設計決定1 参照)。drizzle-kit の
    // MySQL dialect は CHECK 制約の生成に対応しているためここで定義するが、生成された
    // migration 側にも同一の CHECK が含まれていることを必ず確認すること
    // (生成されない場合は migration に手書きで補う)。
    check("note_relations_note_a_id_lt_note_b_id", sql`${table.noteAId} < ${table.noteBId}`),
    check(
      "note_relations_source_note_id_is_endpoint",
      sql`${table.sourceNoteId} = ${table.noteAId} or ${table.sourceNoteId} = ${table.noteBId}`,
    ),
  ],
);

export type NoteRelation = typeof noteRelations.$inferSelect;
export type NewNoteRelation = typeof noteRelations.$inferInsert;
