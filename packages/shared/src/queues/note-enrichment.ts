import { z } from "zod";

/**
 * embedding 生成(M1-4a)ジョブのキュー定義。投入契機は (a) memo ノート作成直後(api)/
 * (b) スクショ AI 解析の completeAnalysis 成功直後(worker)/(c) ノート更新直後(api)の
 * 3経路(M1-4a 計画 §設計決定4 参照)。screenshot-analysis.ts のパターンに倣い、キュー名・
 * payload スキーマ・既定ジョブオプションをここに一元定義し、全経路(および worker 側の
 * @Processor 登録)がこの単一の定義を import して使う。
 *
 * キュー名は `note-enrichment` だが、M1-4b の関係判定ステージ(埋め込み生成後に類似ノートとの
 * 関係を判定・永続化する処理)も同一ジョブに載せる前提で命名している(M1-4a 計画 §設計決定4)。
 */
export const NOTE_ENRICHMENT_QUEUE_NAME = "note-enrichment";

/**
 * payload は noteId のみ(userId は含めない)。processor はジョブ開始時に noteId で
 * notes 行を1件取得し、userId・title・summary・body・tags 等はそこから読む
 * (書き戻しの条件付き UPDATE も同じ取得結果のスナップショットを使う。M1-4a 計画
 * §設計決定4 の「書き戻しは条件付き UPDATE で保護する」参照)。payload に userId を
 * 重複して持たせても DB 行との整合性チェックには使えない(payload 側の値は投入時点の
 * ものであり、処理開始時点の実データを正としなければならないため)ため、最小限の noteId
 * のみを持たせる。
 */
export const noteEnrichmentJobPayloadSchema = z.object({
  noteId: z.string(),
});
export type NoteEnrichmentJobPayload = z.infer<typeof noteEnrichmentJobPayloadSchema>;

export const NOTE_ENRICHMENT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 5000 },
  removeOnComplete: true,
  removeOnFail: true,
} as const;

/**
 * ノート単位で決定的な jobId を生成する。BullMQ は `:` を Redis キー名の内部区切り文字として
 * 予約しておりカスタム jobId に使えないため、ハイフン区切りにする(D0 指摘[1]対応。
 * screenshot-analysis.ts の `screenshotAnalysisJobId` と同じ配慮)。
 *
 * `removeOnComplete`/`removeOnFail` が true のため、完了・最終失敗後は同一 jobId で
 * 再投入できる(更新時 enqueue・回収バッチ経由の再処理)。実行中・待機中(waiting/active/
 * delayed)の間は同一 jobId の追加投入が BullMQ 側で抑止され、重複実行を防ぐ。
 */
export function noteEnrichmentJobId(noteId: string): string {
  return `note-enrichment-${noteId}`;
}
