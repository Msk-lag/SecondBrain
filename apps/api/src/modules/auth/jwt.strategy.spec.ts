process.env.JWT_SECRET ??= "test-secret";

import { JwtStrategy } from "./jwt.strategy";

describe("JwtStrategy", () => {
  it("payload から AuthenticatedUser を組み立てる", () => {
    const strategy = new JwtStrategy();

    const result = strategy.validate({ sub: "user-1", email: "user@example.com" });

    expect(result).toEqual({ id: "user-1", email: "user@example.com" });
  });
});
