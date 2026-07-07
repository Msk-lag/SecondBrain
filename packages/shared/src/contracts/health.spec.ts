import { healthContract } from "./health.js";

describe("healthContract", () => {
  it("defines a GET /health endpoint", () => {
    expect(healthContract.getHealth.method).toBe("GET");
    expect(healthContract.getHealth.path).toBe("/health");
  });
});
