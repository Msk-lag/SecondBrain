import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov", "json"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.spec.ts", "src/**/*.test.ts", "src/**/*.d.ts"],
      // 後退禁止 floor(ADR-0003)。実測値を下回らない範囲でのみ更新可(引き上げは歓迎)。
      thresholds: {
        statements: 27,
        branches: 30,
        functions: 14,
        lines: 27,
      },
    },
  },
});
