import { loadRootEnv } from "@secondbrain/db";

// main.ts の最初の import として読み込むこと。
// AuthModule のデコレータ評価(JWT_SECRET の fail-fast チェック)より前に
// リポジトリルートの .env を環境変数へ反映するための副作用モジュール。
loadRootEnv();
