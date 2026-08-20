import { Controller, UseGuards } from "@nestjs/common";
import { TsRestHandler, tsRestHandler } from "@ts-rest/nest";
import { graphContract, type AuthenticatedUser } from "@secondbrain/shared";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import { GraphService } from "./graph.service";

/**
 * `GET /graph`(M2-1 参照)。`notes.controller.ts` の `@TsRestHandler` + `tsRestHandler` +
 * `@CurrentUser()` の流儀をそのまま踏襲する。
 *
 * **`UploadRateLimitGuard` は付けない**(M2-1 §設計決定5): このガードは screenshot 解析・
 * retry 経路の AI 課金(Claude API 呼び出し)予算を守るためのものであり、`/graph` は外部 API を
 * 一切呼ばない読み取り専用エンドポイントのため対象外。読み取り系エンドポイント全般への
 * 一般的なレート制限の追加は #65 の担当範囲であり、本ユニットのスコープ外。
 */
@UseGuards(JwtAuthGuard)
@Controller()
export class GraphController {
  constructor(private readonly graphService: GraphService) {}

  @TsRestHandler(graphContract.get)
  get(@CurrentUser() user: AuthenticatedUser) {
    return tsRestHandler(graphContract.get, async () => {
      const body = await this.graphService.findGraph(user.id);
      return { status: 200 as const, body };
    });
  }
}
