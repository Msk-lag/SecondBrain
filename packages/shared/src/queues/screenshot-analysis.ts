import { z } from "zod";

/**
 * screenshot-analysis キューへのジョブ投入はアップロード(apps/api)・retry(apps/api)・
 * stuck ノート再投入(apps/worker)の3経路から行われる。キュー名・payload 形状・
 * attempts/backoff がこれらの間で食い違うと、processor 側の最終試行判定
 * (`job.attemptsMade + 1 >= (job.opts.attempts ?? 1)`)が経路によって異なる挙動になりかねない。
 * これを防ぐため、キュー名・payload スキーマ・既定ジョブオプションをここに一元定義し、
 * 3経路すべて(および worker 側の @Processor 登録)がこの単一の定義を import して使う
 * (§ ジョブ契約の一元化(Codex レビュー r9 指摘 [2] への対応) 参照)。
 */
export const SCREENSHOT_ANALYSIS_QUEUE_NAME = "screenshot-analysis";

export const screenshotAnalysisJobPayloadSchema = z.object({
  noteId: z.string(),
  // 世代番号(fencing token)。§ 世代番号によるDB書き込みの整合性保証 参照
  generation: z.number().int().nonnegative(),
});
export type ScreenshotAnalysisJobPayload = z.infer<typeof screenshotAnalysisJobPayloadSchema>;

export const SCREENSHOT_ANALYSIS_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 5000 },
  removeOnComplete: true,
  removeOnFail: true,
} as const;

/**
 * ノート×世代単位で決定的な jobId を生成する。
 * `:` は BullMQ が Redis キー名の内部区切り文字として予約しておりカスタム jobId に
 * 使えないため `-gen-` を区切りに使う(Codex レビュー r18 指摘 [1] への対応)。
 * retry・stuck 再投入は必ず世代をインクリメントしてから新しい jobId で投入するため、
 * 旧世代の jobId とは文字列として異なり、旧ジョブの Redis 上の生存状態を確認しなくても
 * 新規投入できる(§ 世代番号によるDB書き込みの整合性保証 参照)。
 */
export function screenshotAnalysisJobId(noteId: string, generation: number): string {
  return `${noteId}-gen-${generation}`;
}
