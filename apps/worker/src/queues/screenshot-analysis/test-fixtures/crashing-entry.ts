/**
 * テスト専用フィクスチャ: `resize-for-claude.spec.ts` のクラッシュ検知検証で使う、親からの
 * IPC メッセージを受け取った直後に非ゼロ終了コードで異常終了する子プロセスエントリポイント
 * (§ 画像処理のハング・クラッシュ耐性 参照)。`resizeForClaude` が `exit` イベントから
 * `ImageProcessingCrashedError` を投げることを検証できるようにする。
 * このファイルは本番のビルド成果物(dist)には含めない(tsconfig.build.json の exclude 参照)。
 */
process.on("message", () => {
  process.exit(1);
});
