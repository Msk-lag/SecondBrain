import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      globals: true,
      environment: "jsdom",
      setupFiles: ["./src/setupTests.ts"],
      coverage: {
        provider: "v8",
        reporter: ["text", "html", "lcov", "json"],
        include: ["src/**/*.{ts,tsx}"],
        exclude: [
          "src/**/*.spec.{ts,tsx}",
          "src/**/*.test.{ts,tsx}",
          "src/**/*.d.ts",
          "src/setupTests.ts",
          "src/main.tsx",
        ],
        // 後退禁止 floor(ADR-0003)。実測値を下回らない範囲でのみ更新可(引き上げは歓迎)。
        thresholds: {
          statements: 84,
          branches: 80,
          functions: 79,
          lines: 85,
        },
      },
    },
  }),
);
