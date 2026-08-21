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

  it("アルゴリズムを HS256 に固定し、alg:none 等のアルゴリズム混同攻撃を防ぐ", () => {
    // passport-jwt の Strategy はコンストラクタで受け取った algorithms オプションを
    // 内部状態 `_verifOpts.algorithms` として保持し、トークン検証時にこの一覧に含まれる
    // アルゴリズムしか許可しない。専用のモックを新設せず、既存テストと同様にインスタンス化
    // した上でこの内部状態を直接検証する。
    const strategy = new JwtStrategy();

    expect(
      (strategy as unknown as { _verifOpts: { algorithms: string[] } })._verifOpts.algorithms,
    ).toEqual(["HS256"]);
  });
});
