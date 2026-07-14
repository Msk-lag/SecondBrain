/**
 * テスト専用フィクスチャ: `resize-for-claude.spec.ts` の応答検証強化(Codex コードレビュー
 * 2026-07-13 r10 指摘 [A-1])で使う、`buffer`/`mediaType` を欠いた壊れた成功応答
 * (`{ ok: true }` のみ)を送り返す子プロセスエントリポイント。以前はこのような応答でも
 * 成功分岐に入り、`Buffer.from(undefined)` がイベントハンドラー内で同期例外を投げていた
 * (Promise の reject に変換されず worker プロセスまで伝播しうる不具合の再現に使う)。
 * このファイルは本番のビルド成果物(dist)には含めない(tsconfig.build.json の exclude 参照)。
 */
process.on("message", () => {
  process.send?.({ ok: true }, () => {
    process.exit(0);
  });
});
