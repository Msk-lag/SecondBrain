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
      reporter: ["text", "html"],
    },
  },
});
