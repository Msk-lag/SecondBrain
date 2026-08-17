import { Module } from "@nestjs/common";
import { NoteEnrichmentQueueModule } from "../note-enrichment-queue.module";
import {
  createOpenAiEmbeddingClientFromEnv,
  OPENAI_EMBEDDING_CLIENT_FACTORY,
} from "./openai-embedding.client";
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
 */
@Module({
  imports: [NoteEnrichmentQueueModule],
  providers: [
    NoteEnrichmentProcessor,
    { provide: OPENAI_EMBEDDING_CLIENT_FACTORY, useValue: createOpenAiEmbeddingClientFromEnv },
  ],
})
export class NoteEnrichmentModule {}
