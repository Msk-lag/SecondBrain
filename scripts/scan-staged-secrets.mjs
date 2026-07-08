#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const secretlintPkgPath = require.resolve("secretlint/package.json");
const secretlintPkg = require(secretlintPkgPath);
const secretlintBin = join(dirname(secretlintPkgPath), secretlintPkg.bin);

const NUL = String.fromCharCode(0);

function getStagedFiles() {
  const out = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], {
    encoding: "utf8",
  });
  return out.split(NUL).filter(Boolean);
}

const stagedFiles = getStagedFiles();

if (stagedFiles.length === 0) {
  process.exit(0);
}

const tmpRoot = mkdtempSync(join(tmpdir(), "scan-staged-secrets-"));
let exitCode = 0;

try {
  const tmpPaths = [];

  for (const file of stagedFiles) {
    let content;
    try {
      // working tree ではなく index(staged content)を取得する。
      // 部分 staging(git add -p 等)時に commit される内容と検査対象がずれないようにするため。
      content = execFileSync("git", ["show", `:${file}`], { encoding: "utf8" });
    } catch {
      // バイナリファイル等、テキストとして取得できないものはスキップする。
      continue;
    }
    const tmpPath = join(tmpRoot, file);
    mkdirSync(dirname(tmpPath), { recursive: true });
    writeFileSync(tmpPath, content);
    tmpPaths.push(tmpPath);
  }

  if (tmpPaths.length === 0) {
    process.exit(0);
  }

  try {
    execFileSync(
      process.execPath,
      [
        secretlintBin,
        "--no-gitignore",
        "--secretlintrc",
        join(process.cwd(), ".secretlintrc.json"),
        ...tmpPaths,
      ],
      { stdio: "inherit", cwd: process.cwd() },
    );
  } catch (err) {
    exitCode = typeof err.status === "number" ? err.status : 1;
  }
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}

process.exit(exitCode);
