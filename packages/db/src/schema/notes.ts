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

// 埋め込み生成(enrichment)ジョブの状態。NULL = 対象外/旧データ(M1-4a §設計決定4 参照)。
export const noteEnrichmentStatusValues = ["pending", "completed", "failed"] as const;
export type NoteEnrichmentStatus = (typeof noteEnrichmentStatusValues)[number];

// 関係判定(AI によるエッジ生成)ジョブの状態。NULL = 一度も判定していない
// (M1-4b §設計決定2・§設計決定10 の状態遷移表 参照)。
//
// pending が必要な理由(Codex 計画レビュー指摘[1]対応): この列に pending が無いと、
// 埋め込み完了直後〜関係判定完了までの窓(Claude 呼び出し中。最大60秒)で NULL のままとなり、
// API 側の relationStatus 派生が not_started(終端)へ落ちて、web が初回の関係結果を
// 受け取る前にポーリングを止めてしまう。失敗後の再試行中も同様に failed(終端)のまま
// ポーリングが止まる。関係ステージ開始時に pending を書くことで「判定中」と
// 「判定予定なし」を区別する。
export const noteRelationStatusValues = ["pending", "completed", "failed"] as const;
export type NoteRelationStatus = (typeof noteRelationStatusValues)[number];

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

/**
 * MariaDB の VECTOR(1536) 型(M1-4a §設計決定1 参照)。drizzle-orm には対応する組み込み型が
 * 無いため customType で `dataType()` が `vector(1536)` を返す形で定義する。書き込み
 * (`VEC_FromText`)・距離計算(`VEC_DISTANCE_COSINE`)は raw SQL(`sql` テンプレート)経由で
 * 行う運用のため、`toDriver`/`fromDriver` は実装しない。`data`/`driverData` を意図的に
 * `never` にすることで、Drizzle のクエリビルダ経由(`select()`/`.values()`)でこの列を
 * 誤って読み書きしようとした場合に型エラーとなるようにしている(埋め込みバイナリの
 * 意図しない SELECT 混入を防ぐ。D0 指摘[4]の回帰観点にも寄与)。
 */
const embeddingVector = customType<{ data: never; driverData: never }>({
  dataType() {
    return "vector(1536)";
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
    // 埋め込みベクトル(M1-4a §設計決定1 参照)。NULL = 未生成。読み出しは行わず、
    // 距離計算は raw SQL(VEC_DISTANCE_COSINE)経由で行う。
    embedding: embeddingVector("embedding"),
    // 埋め込み生成に使ったモデル名(例: text-embedding-3-small)。NULL = 未生成。
    embeddingModel: varchar("embedding_model", { length: 64 }),
    // 埋め込み入力(title/summary/body 等の正規化連結)の SHA-256 hex。
    // 再実行時にこの値が一致すれば OpenAI API を呼ばずスキップする(冪等性の担保)。
    embeddingFingerprint: varchar("embedding_fingerprint", { length: 64 }),
    // enrichment(埋め込み生成)ジョブの状態。NULL = 対象外/旧データ。
    enrichmentStatus: mysqlEnum("enrichment_status", noteEnrichmentStatusValues),
    // 関係判定ジョブの状態。NULL = 一度も判定していない(M1-4b §設計決定2 参照)。既存行の
    // backfill は行わない(NULL = 未判定を正直に表現する)。判定スキップ条件は
    // 「completed かつ relation_fingerprint 一致」であり、pending・failed はスキップせず
    // 次の機会に再判定する。
    relationStatus: mysqlEnum("relation_status", noteRelationStatusValues),
    // 最後に「試行」した関係判定の入力 fingerprint(embedding_fingerprint と同じ値域)。
    // 成功・失敗を問わず試行時に書く(relation_status がその試行の結果を表す)。この2列の組で
    // 「現在の内容に対する判定が、進行中か・完了か・失敗か・まだ始まっていないか」が一意に
    // 決まり、API の relationStatus 派生(M1-4b §設計決定10 の状態遷移表)が閉じる。
    //
    // 「最後に成功した値」ではなく「最後に試行した値」である点が重要(Codex 計画レビュー
    // 指摘[1]対応)。成功時のみ書く設計だと、「現在の内容で失敗した(終端。再試行しても
    // 同じ)」と「古い内容で失敗し、現在の内容では再判定待ち(継続)」を API が区別できず、
    // ポーリングを止めるべき場面で回し続ける/回すべき場面で止める、の両方が起きる。
    //
    // 候補0件・全候補 related=false の場合も completed として記録し、無変更再保存での
    // Claude 再呼び出しを防ぐ。
    relationFingerprint: varchar("relation_fingerprint", { length: 64 }),
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
    // enrichment 回収バッチ(note-enrichment-requeue)のスキャン用
    // (enrichment_status='pending' AND updated_at < now()-10分 の走査)
    index("notes_enrichment_status_idx").on(table.enrichmentStatus),
  ],
);

export type Note = typeof notes.$inferSelect;
export type NewNote = typeof notes.$inferInsert;
