import { defineConfig } from "vitest/config";

/**
 * 統合テスト専用の Vitest 設定(§ テスト方針 参照)。単体テスト用の vitest.config.ts とは
 * 対象パターンを分離し、実 MariaDB への接続を要する `test/*.integration.spec.ts` のみを扱う。
 * DB の DROP→CREATE・マイグレーション適用・後始末を伴うため、既定より長いタイムアウトを設定する。
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.integration.spec.ts"],
    setupFiles: ["./test/integration-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
