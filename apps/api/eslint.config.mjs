// @ts-check
import eslint from "@eslint/js";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import sonarjs from "eslint-plugin-sonarjs";
import security from "eslint-plugin-security";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist", "coverage", "report", "eslint.config.mjs", "vitest.config.ts"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  sonarjs.configs.recommended,
  security.configs.recommended,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.vitest,
      },
      sourceType: "commonjs",
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-floating-promises": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "prettier/prettier": ["error", { endOfLine: "auto" }],
    },
  },
  {
    files: ["**/*.spec.ts"],
    rules: {
      // テスト用の固定文字列(実秘密情報ではない)・DBモックのチェーン構造(select().from().where()...)
      // を誤検知するため、spec ファイルに限り無効化する
      "sonarjs/no-hardcoded-passwords": "off",
      "sonarjs/no-nested-functions": "off",
    },
  },
);
