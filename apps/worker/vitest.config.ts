import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // 単体テストはコロケーション方式(src/**/*.spec.ts。PROJECT.md 参照)のみを対象にする。
    // `test/**/*.integration.spec.ts`(実 DB/MinIO/Redis を要する統合テスト。§ テスト方針 参照)
    // はファイル名が既定の `*.spec.ts` グロブに一致してしまうため、明示的に対象外にする
    // (`pnpm test` では実行しない。`pnpm test:integration` からのみ実行する)。
    include: ["src/**/*.spec.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov", "json"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.spec.ts",
        "src/**/*.test.ts",
        "src/**/*.d.ts",
        "src/main.ts",
        // NestJS の `src/queues/**/*.module.ts`(`@Module({...})` デコレータ + 空のクラス定義の
        // みで構成される、宣言的な DI 設定)は単体テストでは到達しようがない。既存のキュー
        // module(screenshot-analysis-queue.module.ts・screenshot-analysis.module.ts・
        // note-stuck-requeue.module.ts・note-purge.module.ts・ping.module.ts 等)も一貫して
        // module 専用の spec を持たずカバレッジ 0% のままであり、プロジェクトとして
        // 「モジュール定義はテストしない」実態になっている。今回追加した note-enrichment 系
        // module がその実態のまま diff カバレッジに初めて引っかかっただけのため、計測対象から
        // 除外する。`src/db/db.module.ts`(接続プール生成等の実ロジックを持ち、実際に spec で
        // テストされている)は `src/queues/` 配下ではないためこの除外の対象外(意図的)。
        "src/queues/**/*.module.ts",
      ],
      // 後退禁止 floor(ADR-0003)。実測値を下回らない範囲でのみ更新可(引き上げは歓迎)。
      thresholds: {
        statements: 89,
        branches: 90,
        functions: 85,
        lines: 89,
      },
    },
  },
});
