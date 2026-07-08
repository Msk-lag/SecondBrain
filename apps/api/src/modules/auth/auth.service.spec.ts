import { JwtService } from "@nestjs/jwt";
import bcrypt from "bcryptjs";
import type { Database } from "@secondbrain/db";
import { AuthService } from "./auth.service";

interface MockUser {
  id: string;
  email: string;
  passwordHash: string;
}

function createMockDb(user: MockUser | undefined): Database {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(user ? [user] : []),
        }),
      }),
    }),
  } as unknown as Database;
}

describe("AuthService", () => {
  const jwtService = new JwtService({ secret: "test-secret" });

  it("正しい email と password でアクセストークンを返す", async () => {
    const passwordHash = await bcrypt.hash("correct-password", 10);
    const db = createMockDb({ id: "user-1", email: "user@example.com", passwordHash });
    const service = new AuthService(db, jwtService);

    const result = await service.login("user@example.com", "correct-password");

    expect(result).not.toBeNull();
    expect(typeof result?.accessToken).toBe("string");
  });

  it("存在しない email の場合は null を返す", async () => {
    const db = createMockDb(undefined);
    const service = new AuthService(db, jwtService);

    const result = await service.login("missing@example.com", "anything");

    expect(result).toBeNull();
  });

  it("パスワードが一致しない場合は null を返す", async () => {
    const passwordHash = await bcrypt.hash("correct-password", 10);
    const db = createMockDb({ id: "user-1", email: "user@example.com", passwordHash });
    const service = new AuthService(db, jwtService);

    const result = await service.login("user@example.com", "wrong-password");

    expect(result).toBeNull();
  });
});
