import { Module } from "@nestjs/common";
import { PassportModule } from "@nestjs/passport";
import { JwtModule } from "@nestjs/jwt";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { JwtStrategy } from "./jwt.strategy";
import { getRequiredJwtSecret } from "./jwt-secret";

@Module({
  imports: [
    PassportModule,
    JwtModule.register({
      secret: getRequiredJwtSecret(),
      // 署名側のアルゴリズムを HS256 に固定する。セキュリティ境界はあくまで検証側
      // (JwtStrategy の `algorithms: ["HS256"]`)であり、署名側の固定はセキュリティ上
      // 必須ではない。ここで明示する狙いは、発行する JWT のアルゴリズムという「発行契約」
      // をコード上で明示し、ライブラリの既定値変更や設定変更による意図しないドリフトを
      // 防ぐことにある。必須ではないが低コストで入れる価値があるため設定する。
      signOptions: { expiresIn: "7d", algorithm: "HS256" },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [JwtModule, PassportModule],
})
export class AuthModule {}
