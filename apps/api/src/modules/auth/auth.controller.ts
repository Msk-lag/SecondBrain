import { Controller, UseGuards } from "@nestjs/common";
import { TsRestHandler, tsRestHandler } from "@ts-rest/nest";
import { authContract, type AuthenticatedUser } from "@secondbrain/shared";
import { AuthService } from "./auth.service";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { CurrentUser } from "./current-user.decorator";

@Controller()
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @TsRestHandler(authContract.login)
  login() {
    return tsRestHandler(authContract.login, async ({ body }) => {
      const result = await this.authService.login(body.email, body.password);
      if (!result) {
        return {
          status: 401 as const,
          body: { message: "メールアドレスまたはパスワードが正しくありません。" },
        };
      }
      return { status: 200 as const, body: result };
    });
  }

  @UseGuards(JwtAuthGuard)
  @TsRestHandler(authContract.me)
  me(@CurrentUser() user: AuthenticatedUser) {
    return tsRestHandler(authContract.me, () => {
      return Promise.resolve({ status: 200 as const, body: user });
    });
  }
}
