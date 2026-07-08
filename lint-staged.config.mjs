const quote = (files) => files.map((f) => `"${f}"`).join(" ");

export default {
  "apps/web/src/**/*.{ts,tsx,js,jsx}": (files) => [
    `eslint --config apps/web/eslint.config.js --fix ${quote(files)}`,
    `prettier --write ${quote(files)}`,
  ],
  "apps/api/src/**/*.ts": (files) => [
    `eslint --config apps/api/eslint.config.mjs --fix ${quote(files)}`,
    `prettier --write ${quote(files)}`,
  ],
  "apps/worker/src/**/*.ts": (files) => [
    `eslint --config apps/worker/eslint.config.mjs --fix ${quote(files)}`,
    `prettier --write ${quote(files)}`,
  ],
  "packages/shared/src/**/*.ts": (files) => [
    `eslint --config packages/shared/eslint.config.mjs --fix ${quote(files)}`,
    `prettier --write ${quote(files)}`,
  ],
  "*.{json,md,yml,yaml}": (files) => [`prettier --write ${quote(files)}`],
};
