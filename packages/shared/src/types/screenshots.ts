import type { Note } from "../contracts/notes.js";

/**
 * 契約外エンドポイント(アップロード・画像配信)の外部インターフェース定義。
 * ts-rest 契約には含めず、プレーンな TypeScript 型として web/api 双方から import する
 * (§ 契約外エンドポイントの外部インターフェース定義(Codex レビュー r4 指摘 [6] への対応) 参照)。
 */

/**
 * POST /notes/screenshots(スクショアップロード)
 * - 認証: Authorization: Bearer <JWT> 必須
 * - リクエスト: multipart/form-data、ファイルフィールド名は "file"(1ファイルのみ)
 */
export const SCREENSHOT_UPLOAD_FILE_FIELD_NAME = "file";

/** 201: 作成直後の pending 状態の note(toPublicNote() 適用済み) */
export type CreateScreenshotNoteResponse = Note;

/**
 * アップロードエラーレスポンス(400: リクエスト不備・413: サイズ超過・
 * 415: 非対応形式・502: MinIO/DB 起因の失敗)。いずれも同一のボディ形状。
 */
export interface ScreenshotUploadErrorResponse {
  message: string;
}

/**
 * GET /notes/:id/image(画像配信)
 * - 認証: Authorization: Bearer <JWT> 必須
 * - 200: Content-Type: <notes.imageMimeType> でバイナリストリーミング配信(型なし)
 * - 404/502/504 のエラーレスポンスボディ
 */
export interface ScreenshotImageErrorResponse {
  message: string;
}
