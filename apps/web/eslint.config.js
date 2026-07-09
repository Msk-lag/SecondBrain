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
    // "**/" を付けるのは、pre-commit(lint-staged)がリポジトリルートから
    // 絶対パスで eslint を呼び出すため、config ファイル相対の単純なパターンだと
    // 一致しないことがあるため(apps/web ディレクトリから実行した場合にも一致させる)。
    files: [
      "**/src/pages/LoginPage.tsx",
      "**/src/pages/SaveNotePage.tsx",
      "**/src/pages/NoteEditPage.tsx",
    ],
    rules: {
      "sonarjs/deprecation": "off",
    },
  },
  {
    // shadcn/ui の慣習として、コンポーネントと同じファイルに
    // variants 定義(cva の戻り値)を co-locate する。HMR 最適化のための
    // このルールは shadcn/ui のエコシステム全体で無効化するのが標準的な扱い。
    files: ["**/src/components/ui/**/*.tsx"],
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },
);
