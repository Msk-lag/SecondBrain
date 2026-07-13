export * from "./schema/index.js";
export * from "./client.js";
export * from "./env.js";
export * from "./seed-user.js";
export * from "./migrate.js";
// resetMariadbTestDatabase/dropMariadbTestDatabase(root資格情報でDBをDROPする、テスト
// セットアップ専用のユーティリティ)はここでは re-export しない。パッケージのメイン
// エントリーポイントから公開すると、本番コードから誤って import・使用できてしまう
// (Codex コードレビュー r6 指摘 [D-3] への対応)。必要な呼び出し元(apps/*/test/
// integration-setup.ts 等)は `@secondbrain/db/dist/testing/reset-mariadb-database.js`
// のサブパスから明示的に import すること(このパッケージに "exports" マップは無いため、
// サブパス import はパッケージルートからの実ファイルパスにそのまま対応する)。
// drizzle-orm のクエリ演算子は @secondbrain/db 経由で re-export する
// (消費側が独自に "drizzle-orm" に依存すると、mysql2 ピア解決の食い違いで
//  同一パッケージの二重インスタンス化・型不整合が発生するため)
// sql: NotesService.markPendingForRetry の世代番号インクリメント
// (`processing_generation = processing_generation + 1`)に使う raw SQL 断片ヘルパー
// (§ 世代番号によるDB書き込みの整合性保証・§ 実装手順8 参照)。
export { eq, and, or, lt, gt, asc, desc, isNull, sql } from "drizzle-orm";
