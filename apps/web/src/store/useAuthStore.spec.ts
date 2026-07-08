import { useAuthStore } from "./useAuthStore";

describe("useAuthStore", () => {
  afterEach(() => {
    useAuthStore.getState().clear();
  });

  it("初期状態は accessToken が null である", () => {
    expect(useAuthStore.getState().accessToken).toBeNull();
  });

  it("setToken でトークンを保持する", () => {
    useAuthStore.getState().setToken("token-123");
    expect(useAuthStore.getState().accessToken).toBe("token-123");
  });

  it("clear でトークンを破棄する", () => {
    useAuthStore.getState().setToken("token-123");
    useAuthStore.getState().clear();
    expect(useAuthStore.getState().accessToken).toBeNull();
  });
});
