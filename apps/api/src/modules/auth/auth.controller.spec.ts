process.env.JWT_SECRET ??= "test-secret";

import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ExecutionContext } from "@nestjs/common";
import request from "supertest";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { JwtAuthGuard } from "./jwt-auth.guard";

describe("AuthController", () => {
  let app: INestApplication;
  const authServiceMock = {
    login: vi.fn(),
  };

  beforeEach(async () => {
    authServiceMock.login.mockReset();

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: authServiceMock }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          const request = context.switchToHttp().getRequest<{ user?: unknown }>();
          request.user = { id: "user-1", email: "user@example.com" };
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it("POST /auth/login は成功時に 200 とアクセストークンを返す", async () => {
    authServiceMock.login.mockResolvedValue({ accessToken: "token-123" });

    const response = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: "user@example.com", password: "correct-password" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ accessToken: "token-123" });
  });

  it("POST /auth/login は認証失敗時に 401 を返す", async () => {
    authServiceMock.login.mockResolvedValue(null);

    const response = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: "user@example.com", password: "wrong-password" });

    expect(response.status).toBe(401);
  });

  it("GET /auth/me は認証済みガードを通過するとユーザー情報を返す", async () => {
    const response = await request(app.getHttpServer()).get("/auth/me");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ id: "user-1", email: "user@example.com" });
  });
});
