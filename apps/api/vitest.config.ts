import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // 単体テストはコロケーション方式(src/**/*.spec.ts。PROJECT.md 参照)のみを対象にする。
    // `test/**/*.e2e-spec.ts`(実 DB/MinIO/Redis を要する統合テスト。§ テスト方針 参照)は
    // 既定の `*.spec.ts` グロブには一致しないが、明示しておくことで意図を固定する
    // (`pnpm test` では実行しない。`pnpm test:integration` からのみ実行する)。
    include: ["src/**/*.spec.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov", "json"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.spec.ts", "src/**/*.test.ts", "src/**/*.d.ts", "src/main.ts"],
      // 後退禁止 floor(ADR-0003)。実測値を下回らない範囲でのみ更新可(引き上げは歓迎)。
      thresholds: {
        statements: 87,
        branches: 78,
        functions: 91,
        lines: 87,
      },
    },
  },
});
