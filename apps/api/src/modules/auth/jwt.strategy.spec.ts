// 固定のテスト用シークレットはリポジトリに残さない(Codex HIGH 指摘対応)。実行時に
// ランダム生成する — 公開されたコミット履歴からの推測・本番環境への混入を構造的に防ぐ。
import { randomBytes } from "node:crypto";
process.env.JWT_SECRET ??= randomBytes(32).toString("hex");

import { JwtStrategy } from "./jwt.strategy";

describe("JwtStrategy", () => {
  it("payload から AuthenticatedUser を組み立てる", () => {
    const strategy = new JwtStrategy();

    const result = strategy.validate({ sub: "user-1", email: "user@example.com" });

    expect(result).toEqual({ id: "user-1", email: "user@example.com" });
  });
});
