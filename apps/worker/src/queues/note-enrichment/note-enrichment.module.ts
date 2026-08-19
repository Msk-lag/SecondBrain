import { Module } from "@nestjs/common";
import { NoteEnrichmentQueueModule } from "../note-enrichment-queue.module";
import {
  createOpenAiEmbeddingClientFromEnv,
  OPENAI_EMBEDDING_CLIENT_FACTORY,
} from "./openai-embedding.client";
import { createRelationJudgeClientFromEnv, RELATION_JUDGE_CLIENT } from "./relation-judge.client";
import { NoteEnrichmentProcessor } from "./note-enrichment.processor";

/**
 * `queues/screenshot-analysis/` パターンを踏襲した module(M1-4a 計画 実装手順4 参照)。
 * `@Processor` が `NOTE_ENRICHMENT_QUEUE_NAME` のキューを解決できるよう
 * `NoteEnrichmentQueueModule` を import する。
 *
 * `OPENAI_EMBEDDING_CLIENT_FACTORY` は `useValue`(関数そのものを渡すだけで呼び出さない)で
 * 登録する。`useFactory` にすると NestJS が DI 解決(=worker 起動)時に即時評価してしまい、
 * `OPENAI_API_KEY` 未設定時に起動そのものが失敗する(§ このモジュールでは worker 起動時に
 * fail-fast させない 参照。createClaudeVisionClientFromEnv が `useFactory` で即時評価される
 * ScreenshotAnalysisModule とは異なる)。
 *
 * `RELATION_JUDGE_CLIENT` は上記の `OPENAI_EMBEDDING_CLIENT_FACTORY` とは逆に `useFactory`
 * で登録する(M1-4b 計画 §設計決定9 参照。`ScreenshotAnalysisModule` の
 * `CLAUDE_VISION_CLIENT` と同じ扱い)。`OPENAI_API_KEY` を遅延評価にしているのは
 * 「未設定でも worker の他機能(screenshot-analysis 等)を止めない」ためだが、
 * `ANTHROPIC_API_KEY` は既に `ScreenshotAnalysisModule` の `CLAUDE_VISION_CLIENT` が
 * `useFactory` で起動時 fail-fast させており、worker は元々このキー無しでは起動できない
 * (§現状調査8 参照)。したがってこちらを `useFactory` にしても新しい失敗モードは増えず、
 * OpenAI 側と同じ「遅延評価」に揃える理由も無い。
 */
@Module({
  imports: [NoteEnrichmentQueueModule],
  providers: [
    NoteEnrichmentProcessor,
    { provide: OPENAI_EMBEDDING_CLIENT_FACTORY, useValue: createOpenAiEmbeddingClientFromEnv },
    { provide: RELATION_JUDGE_CLIENT, useFactory: createRelationJudgeClientFromEnv },
  ],
})
export class NoteEnrichmentModule {}
