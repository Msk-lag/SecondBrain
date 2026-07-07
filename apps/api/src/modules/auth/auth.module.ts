import { Module } from "@nestjs/common";
import { PassportModule } from "@nestjs/passport";
import { JwtModule } from "@nestjs/jwt";

function getRequiredJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET environment variable is required but not set");
  }
  return secret;
}

@Module({
  imports: [
    PassportModule,
    JwtModule.register({
      secret: getRequiredJwtSecret(),
      signOptions: { expiresIn: "1h" },
    }),
  ],
  exports: [JwtModule, PassportModule],
})
export class AuthModule {}
