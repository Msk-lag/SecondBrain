// 固定のテスト用シークレットはリポジトリに残さない(notes.controller.spec.ts と同じ方針)。
import { randomBytes } from "node:crypto";
process.env.JWT_SECRET ??= randomBytes(32).toString("hex");

import { Test, type TestingModule } from "@nestjs/testing";
import { INestApplication, type ExecutionContext } from "@nestjs/common";
import request from "supertest";
import type { GraphResponse } from "@secondbrain/shared";
import { GraphController } from "./graph.controller";
import { GraphService } from "./graph.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";

function makeGraphResponse(overrides: Partial<GraphResponse> = {}): GraphResponse {
  return {
    nodes: [{ id: "note-1", title: "タイトル", type: "memo", bodyPreview: "本文" }],
    edges: [
      {
        id: "edge-1",
        source: "note-1",
        target: "note-2",
        directed: true,
        relationType: "cause-solution",
        description: "説明文",
        relatedness: 0.75,
      },
    ],
    truncated: { nodes: false, edges: false },
    processingNoteCount: 0,
    ...overrides,
  };
}

describe("GraphController", () => {
  let app: INestApplication;
  const graphServiceMock = { findGraph: vi.fn() };

  beforeEach(async () => {
    graphServiceMock.findGraph.mockReset();

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [GraphController],
      providers: [{ provide: GraphService, useValue: graphServiceMock }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          const req = context.switchToHttp().getRequest<{ user?: unknown }>();
          req.user = { id: "user-1", email: "user@example.com" };
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

  it("GET /graph は GraphService.findGraph の結果を 200 で返す", async () => {
    const body = makeGraphResponse();
    graphServiceMock.findGraph.mockResolvedValue(body);

    const response = await request(app.getHttpServer()).get("/graph");

    expect(response.status).toBe(200);
    expect(response.body).toEqual(body);
  });

  it("GET /graph は認証済みユーザーの id を GraphService.findGraph へ渡す", async () => {
    graphServiceMock.findGraph.mockResolvedValue(makeGraphResponse());

    await request(app.getHttpServer()).get("/graph");

    expect(graphServiceMock.findGraph).toHaveBeenCalledWith("user-1");
  });

  it("ノート0件・エッジ0件でも例外にならず空配列を 200 で返す(受入条件12)", async () => {
    graphServiceMock.findGraph.mockResolvedValue(
      makeGraphResponse({
        nodes: [],
        edges: [],
        truncated: { nodes: false, edges: false },
        processingNoteCount: 0,
      }),
    );

    const response = await request(app.getHttpServer()).get("/graph");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      nodes: [],
      edges: [],
      truncated: { nodes: false, edges: false },
      processingNoteCount: 0,
    });
  });
});
