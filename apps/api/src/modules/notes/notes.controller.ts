import { Controller, UseGuards } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { TsRestHandler, tsRestHandler } from "@ts-rest/nest";
import type { Queue } from "bullmq";
import {
  notesContract,
  NOTE_ENRICHMENT_QUEUE_NAME,
  SCREENSHOT_ANALYSIS_QUEUE_NAME,
  toPublicNote,
  type AuthenticatedUser,
} from "@secondbrain/shared";
import { enqueueScreenshotAnalysis } from "../screenshots/screenshots.producer";
import { UploadRateLimitGuard } from "../screenshots/upload-rate-limit.guard";
import { enqueueNoteEnrichment } from "./note-enrichment.producer";
import { NotesService } from "./notes.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";

const NOT_FOUND_BODY = { message: "ノートが見つかりません。" };
const NOT_RETRYABLE_BODY = { message: "再実行できる状態ではありません。" };

@UseGuards(JwtAuthGuard)
@Controller()
export class NotesController {
  constructor(
    private readonly notesService: NotesService,
    @InjectQueue(SCREENSHOT_ANALYSIS_QUEUE_NAME) private readonly screenshotAnalysisQueue: Queue,
    @InjectQueue(NOTE_ENRICHMENT_QUEUE_NAME) private readonly noteEnrichmentQueue: Queue,
  ) {}

  @TsRestHandler(notesContract.list)
  list(@CurrentUser() user: AuthenticatedUser) {
    return tsRestHandler(notesContract.list, async ({ query }) => {
      const result = await this.notesService.list(user.id, query);
      return {
        status: 200 as const,
        body: { items: result.items, nextCursor: result.nextCursor },
      };
    });
  }

  @TsRestHandler(notesContract.get)
  get(@CurrentUser() user: AuthenticatedUser) {
    return tsRestHandler(notesContract.get, async ({ params }) => {
      const note = await this.notesService.findOwned(user.id, params.id);
      if (!note) {
        return { status: 404 as const, body: NOT_FOUND_BODY };
      }
      return { status: 200 as const, body: toPublicNote(note) };
    });
  }

  // 意味的に近い過去ノートの類似候補探索(M1-4a §設計決定3 参照)+ 確定エッジ(relations)・
  // relationStatus(M1-4b §設計決定10 参照)。レスポンス形の詳細・派生ロジックは
  // NotesService.findRelated 側に集約しており、ここでは 404 判定のみを担う。404 方針は既存
  // エンドポイントと同じく「対象が存在しない」「他ユーザー所有」を区別しない。
  @TsRestHandler(notesContract.related)
  related(@CurrentUser() user: AuthenticatedUser) {
    return tsRestHandler(notesContract.related, async ({ params }) => {
      const result = await this.notesService.findRelated(user.id, params.id);
      if (result === null) {
        return { status: 404 as const, body: NOT_FOUND_BODY };
      }
      return { status: 200 as const, body: result };
    });
  }

  @TsRestHandler(notesContract.create)
  create(@CurrentUser() user: AuthenticatedUser) {
    return tsRestHandler(notesContract.create, async ({ body }) => {
      const note = await this.notesService.create(user.id, body);
      // DB へ enrichment_status='pending' を書き込んだ(NotesService.create の insert)後に
      // enqueue する(fail-closed の投入順序。M1-4a 計画 §担当スコープ2 参照。enqueue 失敗は
      // ログのみで、レスポンスは常に成功のまま返す)。screenshot ノートはこの経路を通らない
      // (create() は memo 専用)ため、AI 解析完了後の worker 側投入(担当外)と競合しない。
      await enqueueNoteEnrichment(this.noteEnrichmentQueue, note.id);
      return { status: 201 as const, body: note };
    });
  }

  @TsRestHandler(notesContract.update)
  update(@CurrentUser() user: AuthenticatedUser) {
    return tsRestHandler(notesContract.update, async ({ params, body }) => {
      const note = await this.notesService.update(user.id, params.id, body);
      if (!note) {
        return { status: 404 as const, body: NOT_FOUND_BODY };
      }
      // 更新対象フィールドが1つ以上ある場合のみ enqueue する(空の PATCH は
      // NotesService.update が DB へ書き込まないため、enrichment_status='pending' が
      // 書き込まれておらず fail-closed の前提を満たさない。M1-4a 計画 §担当スコープ2 参照)。
      if (Object.keys(body).length > 0) {
        await enqueueNoteEnrichment(this.noteEnrichmentQueue, note.id);
      }
      return { status: 200 as const, body: note };
    });
  }

  @TsRestHandler(notesContract.delete)
  delete(@CurrentUser() user: AuthenticatedUser) {
    return tsRestHandler(notesContract.delete, async ({ params }) => {
      const removed = await this.notesService.remove(user.id, params.id);
      if (!removed) {
        return { status: 404 as const, body: NOT_FOUND_BODY };
      }
      return { status: 204 as const, body: undefined };
    });
  }

  // アップロード経路と同じユーザー単位レート制限(同時実行数・時間窓内の件数)を適用する
  // (Codex コードレビュー 2026-07-13 r9 指摘 [A-3] への対応。以前は retry に制限が無く、
  // failed ノートへの retry を繰り返すことでアップロード制限を迂回してAI課金〔Claude API
  // 呼び出し〕を無制限に消費できた。PerUserUploadLimiter はアップロードと同一インスタンスを
  // 共有するため、両経路の試行が同じ予算を消費する)。
  @UseGuards(UploadRateLimitGuard)
  @TsRestHandler(notesContract.retry)
  retry(@CurrentUser() user: AuthenticatedUser) {
    return tsRestHandler(notesContract.retry, async ({ params }) => {
      const result = await this.notesService.markPendingForRetry(user.id, params.id);
      if (result === "not_found") {
        return { status: 404 as const, body: NOT_FOUND_BODY };
      }
      if (result === "not_retryable") {
        return { status: 409 as const, body: NOT_RETRYABLE_BODY };
      }
      // BullMQ 投入が失敗しても 200 を返す(§ retry(ユーザー起点の再実行)の冪等性 参照)。
      await enqueueScreenshotAnalysis(this.screenshotAnalysisQueue, params.id, result.generation);
      return { status: 200 as const, body: result.note };
    });
  }
}
