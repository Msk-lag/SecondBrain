import eslint from "@eslint/js";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import sonarjs from "eslint-plugin-sonarjs";
import security from "eslint-plugin-security";
import jsxA11y from "eslint-plugin-jsx-a11y";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "coverage", "report", "eslint.config.js", "vitest.config.ts"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  reactHooks.configs.flat["recommended-latest"],
  reactRefresh.configs.vite,
  sonarjs.configs.recommended,
  security.configs.recommended,
  jsxA11y.flatConfigs.recommended,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // React の合成イベント型(FormEvent 等)は型定義自体に
    // 「実在しない」という注記が付いており、このルールが誤検知するため、
    // 実際に使用しているファイルに限定して無効化する
    files: ["src/pages/LoginPage.tsx"],
    rules: {
      "sonarjs/deprecation": "off",
    },
  },
);
