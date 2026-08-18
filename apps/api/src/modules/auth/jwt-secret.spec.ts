import { getRequiredJwtSecret } from "./jwt-secret";

describe("getRequiredJwtSecret", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("JWT_SECRET が未設定の場合は例外を投げる", () => {
    delete process.env.JWT_SECRET;

    expect(() => getRequiredJwtSecret()).toThrow(
      /JWT_SECRET environment variable is required but not set/,
    );
  });

  it("JWT_SECRET が空白のみの場合は例外を投げる", () => {
    process.env.JWT_SECRET = "   ";

    expect(() => getRequiredJwtSecret()).toThrow(
      /JWT_SECRET environment variable is required but not set/,
    );
  });

  it("JWT_SECRET が .env.example のプレースホルダ値(changeme-jwt-secret)の場合は例外を投げる", () => {
    process.env.JWT_SECRET = "changeme-jwt-secret";

    expect(() => getRequiredJwtSecret()).toThrow(/placeholder value/);
  });

  it("JWT_SECRET が大文字小文字混在のプレースホルダ値の場合も例外を投げる", () => {
    process.env.JWT_SECRET = "CHANGEME-xxx";

    expect(() => getRequiredJwtSecret()).toThrow(/placeholder value/);
  });

  it("JWT_SECRET が change-me 接頭辞の場合も例外を投げる", () => {
    process.env.JWT_SECRET = "change-me-please";

    expect(() => getRequiredJwtSecret()).toThrow(/placeholder value/);
  });

  it("エラーメッセージに実際の秘密値を含めない", () => {
    process.env.JWT_SECRET = "changeme-jwt-secret";

    const error = ((): Error => {
      try {
        getRequiredJwtSecret();
        throw new Error("unreachable");
      } catch (err) {
        return err as Error;
      }
    })();

    expect(error.message).not.toContain("changeme-jwt-secret");
  });

  it("JWT_SECRET が単体テストで使われる既知の固定値(test-secret)の場合は例外を投げる", () => {
    process.env.JWT_SECRET = "test-secret";

    expect(() => getRequiredJwtSecret()).toThrow(/known fixture value/);
  });

  it("JWT_SECRET が統合テストで使われる既知の固定値(integration-test-jwt-secret)の場合は例外を投げる", () => {
    process.env.JWT_SECRET = "integration-test-jwt-secret";

    expect(() => getRequiredJwtSecret()).toThrow(/known fixture value/);
  });

  it("既知の固定値は大文字小文字混在でも例外を投げる", () => {
    process.env.JWT_SECRET = "Test-Secret";

    expect(() => getRequiredJwtSecret()).toThrow(/known fixture value/);
  });

  it("既知の固定値は前後に空白があっても例外を投げる", () => {
    process.env.JWT_SECRET = "  integration-test-jwt-secret  ";

    expect(() => getRequiredJwtSecret()).toThrow(/known fixture value/);
  });

  it("既知の固定値の場合、エラーメッセージはプレースホルダのものと区別がつく文言になる", () => {
    process.env.JWT_SECRET = "test-secret";

    expect(() => getRequiredJwtSecret()).not.toThrow(/placeholder value/);
  });

  it("既知の固定値の場合、エラーメッセージに実際の設定値を含めない", () => {
    process.env.JWT_SECRET = "integration-test-jwt-secret";

    const error = ((): Error => {
      try {
        getRequiredJwtSecret();
        throw new Error("unreachable");
      } catch (err) {
        return err as Error;
      }
    })();

    expect(error.message).not.toContain("integration-test-jwt-secret");
  });

  it("正常な値の場合はその値をそのまま返す", () => {
    process.env.JWT_SECRET = "a-real-production-secret-value";

    expect(getRequiredJwtSecret()).toBe("a-real-production-secret-value");
  });

  it("前後に空白がある正常な値は trim して返す", () => {
    process.env.JWT_SECRET = "  a-real-production-secret-value  ";

    expect(getRequiredJwtSecret()).toBe("a-real-production-secret-value");
  });
});
