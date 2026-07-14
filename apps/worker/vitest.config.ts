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
      exclude: ["src/**/*.spec.ts", "src/**/*.test.ts", "src/**/*.d.ts", "src/main.ts"],
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
