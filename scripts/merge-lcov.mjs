#!/usr/bin/env node
// merge-lcov.mjs — apps/*/coverage/lcov.info と packages/*/coverage/lcov.info を
// リポジトリルート相対パスに正規化して1つの lcov ファイルへ連結する。
// 依存パッケージなし(Node 24 の組み込みモジュールのみ)。
//
// 使い方:
//   node scripts/merge-lcov.mjs [出力先パス]
//   (既定の出力先: coverage/merged-lcov.info)
//
// 用途: diff-cover 等の diff カバレッジ検査に、各パッケージ個別の lcov.info をまとめて渡すため。
// SF: 行のパスは各パッケージの vitest 実行ディレクトリからの相対パス(例: src/foo.ts)になっているため、
// リポジトリルートから見た相対パス(例: apps/api/src/foo.ts)へ書き換える。
//
// 終了コード: 0=成功 1=失敗(lcov ファイルが1つも見つからない、または書き込み失敗)

import { readFileSync, writeFileSync, mkdirSync, globSync } from "node:fs";
import { dirname, join, relative, resolve, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const outputArg = process.argv[2] || "coverage/merged-lcov.info";
const outputPath = resolve(repoRoot, outputArg);

/**
 * リポジトリルートからの相対パスの glob パターンで lcov.info を探索する。
 * node:fs.globSync は Node 22+ で利用可能(Node 24 前提)。
 */
function findLcovFiles() {
  const patterns = ["apps/*/coverage/lcov.info", "packages/*/coverage/lcov.info"];
  const found = [];
  for (const pattern of patterns) {
    const matches = globSync(pattern, { cwd: repoRoot });
    for (const m of matches) {
      found.push(resolve(repoRoot, m));
    }
  }
  return found.sort();
}

/**
 * SF: 行のパスをリポジトリルート相対・"/" 区切りへ正規化する。
 * - 既に相対パスの場合: それを package ディレクトリからの相対パスとみなし、
 *   package ディレクトリ(lcov.info の親の親、つまり <pkg>/coverage/lcov.info の <pkg>)からの相対パスへ結合する。
 * - 絶対パス(Windows の "D:\..." 形式含む)の場合: repoRoot からの相対パスへ変換する。
 */
function normalizeSourcePath(sfValue, packageDir) {
  let raw = sfValue.trim();

  // Windows 絶対パス(例: D:\foo\bar か D:/foo/bar)または POSIX 絶対パスを判定する。
  const isWindowsAbsolute = /^[A-Za-z]:[\\/]/.test(raw);
  const isPosixAbsolute = raw.startsWith("/");

  let absolutePath;
  if (isWindowsAbsolute || isPosixAbsolute || isAbsolute(raw)) {
    absolutePath = raw;
  } else {
    // 相対パス: package ディレクトリからの相対とみなす。
    absolutePath = join(packageDir, raw);
  }

  let relPath = relative(repoRoot, absolutePath);
  // Windows のパス区切り("\")を "/" へ統一する。
  relPath = relPath.split(sep).join("/");
  // 念のため先頭の "./" を除去する。
  relPath = relPath.replace(/^\.\//, "");
  return relPath;
}

function mergeLcovFiles(files) {
  const outputLines = [];
  for (const file of files) {
    // <pkg>/coverage/lcov.info -> <pkg>
    const packageDir = dirname(dirname(file));
    const content = readFileSync(file, "utf8");
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      if (line.startsWith("SF:")) {
        const original = line.slice(3);
        const normalized = normalizeSourcePath(original, packageDir);
        outputLines.push(`SF:${normalized}`);
      } else {
        outputLines.push(line);
      }
    }
  }
  // 末尾に余分な空行が増えすぎないよう、末尾の連続する空行を1つにまとめる。
  while (
    outputLines.length > 1 &&
    outputLines[outputLines.length - 1] === "" &&
    outputLines[outputLines.length - 2] === ""
  ) {
    outputLines.pop();
  }
  return outputLines.join("\n");
}

function main() {
  const files = findLcovFiles();
  if (files.length === 0) {
    console.error(
      "ERROR: lcov.info が1つも見つかりませんでした(apps/*/coverage/lcov.info, packages/*/coverage/lcov.info)。先に `pnpm test:coverage` を実行してください。",
    );
    process.exit(1);
  }

  const merged = mergeLcovFiles(files);

  try {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, merged, "utf8");
  } catch (e) {
    console.error(`ERROR: 出力ファイルの書き込みに失敗しました: ${outputPath}\n${e.message}`);
    process.exit(1);
  }

  console.error(
    `merge-lcov: ${files.length} 件の lcov.info を処理し ${relative(repoRoot, outputPath)} へ出力しました。`,
  );
  for (const f of files) {
    console.error(`  - ${relative(repoRoot, f)}`);
  }
}

main();
