import {
  customType,
  index,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";
import { users } from "./users.js";

export const noteTypeValues = ["memo", "url", "screenshot"] as const;
export type NoteType = (typeof noteTypeValues)[number];

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
    body: text("body").notNull(),
    summary: text("summary"),
    tags: jsonTextArray("tags").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (table) => [
    // カーソルページネーション(user_id 絞り込み + created_at/id 降順走査)を索引で支える
    index("notes_user_id_created_at_id_idx").on(table.userId, table.createdAt, table.id),
  ],
);

export type Note = typeof notes.$inferSelect;
export type NewNote = typeof notes.$inferInsert;
