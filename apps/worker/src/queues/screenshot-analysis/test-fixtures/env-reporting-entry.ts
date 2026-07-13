/**
 * テスト専用フィクスチャ: `resize-for-claude.spec.ts` の env allowlist 検証で使う、実際の画像処理を
 * 行わず、代わりに自分が受け取った環境変数のキー一覧を成功レスポンスと同じ形式で送り返す
 * 子プロセスエントリポイント(Codex コードレビュー 2026-07-13 r8 指摘 [A-3] への対応)。
 * `resizeForClaude` 側は成功レスポンスのバッファをそのまま返すだけなので、既存の解析ロジックを
 * 変更せずにこのフィクスチャを差し込める。
 * このファイルは本番のビルド成果物(dist)には含めない(tsconfig.build.json の exclude 参照)。
 *
 * 本番の `resize-for-claude.worker-entry.ts` は応答送信後に `process.exit(0)` で自己終了するが、
 * このフィクスチャは元々それを行っておらず、テストのたびに子プロセスが残り続けていた
 * (Codex コードレビュー 2026-07-13 r10 指摘 [A-1] への対応。`resizeForClaude` 側で応答受信後に
 * `child.kill()` する防御も別途追加済みだが、フィクスチャ自身も本番エントリと同じ振る舞いに揃える)。
 */
process.on("message", () => {
  const envKeys = Object.keys(process.env);
  process.send?.(
    {
      ok: true,
      buffer: Buffer.from(JSON.stringify(envKeys)),
      mediaType: "application/json",
    },
    () => {
      process.exit(0);
    },
  );
});
