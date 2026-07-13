import {
  customType,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";
import { users } from "./users.js";

export const noteTypeValues = ["memo", "url", "screenshot"] as const;
export type NoteType = (typeof noteTypeValues)[number];

export const noteStatusValues = ["pending", "processing", "completed", "failed"] as const;
export type NoteStatus = (typeof noteStatusValues)[number];

/**
 * MariaDB の JSON 型は LONGTEXT + CHECK 制約のエイリアスで、MySQL のような
 * プロトコルレベルの JSON 型フラグを持たない。そのため mysql2 ドライバは
 * 自動パースせず、drizzle-orm 標準の json() は文字列のまま返してしまう
 * (mapFromDriverValue 未実装のため)。customType で読み出し時の JSON.parse を明示する。
 */
const jsonTextArray = customType<{ data: string[]; driverData: string }>({
  dataType() {
    return "json";
  },
  toDriver(value) {
    return JSON.stringify(value);
  },
  fromDriver(value) {
    return typeof value === "string" ? (JSON.parse(value) as string[]) : value;
  },
});

export const notes = mysqlTable(
  "notes",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id),
    type: mysqlEnum("type", noteTypeValues).notNull().default("memo"),
    title: varchar("title", { length: 255 }),
    // screenshot ノートはユーザー入力本文が存在しないため body: null で作成する
    // (§ notes テーブル拡張・削除の論理削除化 参照。抽出原文は extractedText に保存する)。
    body: text("body"),
    summary: text("summary"),
    tags: jsonTextArray("tags").notNull(),
    // AI 解析ステージ(screenshot ノートのみ意味を持つ。memo は作成時に "completed" を即時設定)
    status: mysqlEnum("status", noteStatusValues).notNull().default("completed"),
    // サニタイズ済みの短い利用者向け文言のみを保存する(§ failureReason のサニタイズ方針 参照)
    failureReason: varchar("failure_reason", { length: 500 }),
    // MinIO オブジェクトキー(screenshot ノートのみ)
    imageKey: varchar("image_key", { length: 512 }),
    // アップロード時に file-type で検出した実 MIME(画像配信の Content-Type・Claude 入力の media_type 双方に使う)
    imageMimeType: varchar("image_mime_type", { length: 100 }),
    // concepts は tags と同じ customType パターン。DEFAULT の無い NOT NULL 列のため、
    // 既存行の移行手順(§ concepts 列の NOT NULL 化)に従い、0002 でまず nullable として追加し
    // 既存行を '[]' で backfill、0003 でこの .notNull() を追加する2段階構成にした。
    concepts: jsonTextArray("concepts").notNull(),
    // AI 派生データ(画像内テキストの書き起こし)
    extractedText: text("extracted_text"),
    // 論理削除(null でなければ削除済み)
    deletedAt: timestamp("deleted_at"),
    // 世代番号(fencing token)。新しい解析試行を始めるたびにインクリメントする
    // (§ 世代番号によるDB書き込みの整合性保証 参照)
    processingGeneration: int("processing_generation").notNull().default(0),
    // 試行単位の fencing token(UUID)。claimForProcessing が呼ばれるたびに新しい値へ更新する
    // (§ 試行単位のfencing token(attempt token) 参照)
    processingAttemptToken: varchar("processing_attempt_token", { length: 36 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (table) => [
    // カーソルページネーション(user_id 絞り込み + created_at/id 降順走査)を索引で支える
    index("notes_user_id_created_at_id_idx").on(table.userId, table.createdAt, table.id),
    // 物理削除バッチのスキャン用
    index("notes_deleted_at_idx").on(table.deletedAt),
    // stuck ノート再投入バッチのスキャン用
    index("notes_status_idx").on(table.status),
  ],
);

export type Note = typeof notes.$inferSelect;
export type NewNote = typeof notes.$inferInsert;
