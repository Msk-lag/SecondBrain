import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from "@nestjs/common";
import type { AuthenticatedUser } from "@secondbrain/shared";
import { PerUserUploadLimiter, UploadRateLimitError } from "./upload-rate-limit";

interface ReleasableResponse {
  once(event: "finish" | "close", listener: () => void): unknown;
}

/**
 * アップロードの濫用防止チェックを Multer/FileInterceptor より前に実行するための Guard
 * (Codex コードレビュー r4 指摘 [A-2] への対応)。NestJS の実行順は
 * Guard → Interceptor → Handler のため、コントローラーのメソッド本体(Interceptor 後に
 * 実行される)で acquire() していると、最大10MBのリクエストボディが既にメモリへ
 * 読み切られた後になってしまい、同時実行数を絞ってもメモリ枯渇を防げない。
 * この Guard を `@UseGuards(JwtAuthGuard, UploadRateLimitGuard)`(この順序が前提。
 * JwtAuthGuard が先に `request.user` を設定する)の形でルートへ適用することで、
 * ファイル本文の読み取り自体を上限超過時は一切発生させない。
 *
 * `acquire()` した in-flight 枠の解放(release)もこの Guard 自身がレスポンスの
 * `finish`/`close` イベントで行う(Codex コードレビュー r5 指摘 [A-1] への対応)。
 * 当初はコントローラーのメソッド本体の `finally` で解放していたが、Multer が
 * ファイルサイズ超過・不正な multipart 等でハンドラー本体に到達する前に例外を
 * 投げた場合、その `finally` 自体が実行されず枠が永久に解放されない不具合があった。
 * レスポンスの `finish`(正常完了・エラー応答いずれも含む)・`close`(クライアント切断)の
 * どちらか早い方で確実に1回だけ解放する。
 */
@Injectable()
export class UploadRateLimitGuard implements CanActivate {
  constructor(private readonly limiter: PerUserUploadLimiter) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const user = request.user;
    if (!user) {
      // JwtAuthGuard が先に実行される前提のためここには到達しない想定だが、
      // 万一の場合は後続の認可チェックに委ねる(この Guard 自体では拒否しない)。
      return true;
    }

    try {
      this.limiter.acquire(user.id);
    } catch (err) {
      if (err instanceof UploadRateLimitError) {
        throw new HttpException({ message: err.message }, HttpStatus.TOO_MANY_REQUESTS);
      }
      throw err;
    }

    const response = context.switchToHttp().getResponse<ReleasableResponse>();
    let released = false;
    const releaseOnce = () => {
      if (released) {
        return;
      }
      released = true;
      this.limiter.release(user.id);
    };
    response.once("finish", releaseOnce);
    response.once("close", releaseOnce);

    return true;
  }
}
