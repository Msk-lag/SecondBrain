import { loginRequestSchema } from "./auth.js";

describe("loginRequestSchema", () => {
  it("有効な email と password を受理する", () => {
    const result = loginRequestSchema.safeParse({
      email: "user@example.com",
      password: "secret",
    });
    expect(result.success).toBe(true);
  });

  it("email 形式でない値を拒否する", () => {
    const result = loginRequestSchema.safeParse({ email: "not-an-email", password: "secret" });
    expect(result.success).toBe(false);
  });

  it("空の password を拒否する", () => {
    const result = loginRequestSchema.safeParse({ email: "user@example.com", password: "" });
    expect(result.success).toBe(false);
  });
});
