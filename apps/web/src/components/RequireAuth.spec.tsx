import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { vi } from "vitest";
import { RequireAuth } from "./RequireAuth";
import { apiClient } from "../lib/api-client";
import { useAuthStore } from "../store/useAuthStore";

vi.mock("../lib/api-client", () => ({
  apiClient: {
    auth: {
      me: vi.fn(),
    },
  },
}));

function renderWithRoutes(initialPath: string) {
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/login" element={<div>ログイン画面</div>} />
        <Route element={<RequireAuth />}>
          <Route path="/" element={<div>保護されたホーム</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("RequireAuth", () => {
  beforeEach(() => {
    useAuthStore.getState().clear();
    vi.mocked(apiClient.auth.me).mockReset();
  });

  it("トークンが無い場合は /login へリダイレクトし /auth/me を呼ばない", async () => {
    renderWithRoutes("/");

    await waitFor(() => expect(screen.getByText("ログイン画面")).toBeInTheDocument());
    expect(apiClient.auth.me).not.toHaveBeenCalled();
  });

  it("トークンが有効な場合は保護ルートを表示する", async () => {
    useAuthStore.getState().setToken("valid-token");
    vi.mocked(apiClient.auth.me).mockResolvedValue({
      status: 200,
      body: { id: "user-1", email: "user@example.com" },
      headers: new Headers(),
    });

    renderWithRoutes("/");

    await waitFor(() => expect(screen.getByText("保護されたホーム")).toBeInTheDocument());
  });

  it("トークンが無効な場合はストアを破棄して /login へリダイレクトする", async () => {
    useAuthStore.getState().setToken("expired-token");
    vi.mocked(apiClient.auth.me).mockResolvedValue({
      status: 401,
      body: { message: "unauthorized" },
      headers: new Headers(),
    });

    renderWithRoutes("/");

    await waitFor(() => expect(screen.getByText("ログイン画面")).toBeInTheDocument());
    expect(useAuthStore.getState().accessToken).toBeNull();
  });

  it("/auth/me が通信エラーで失敗した場合もストアを破棄して /login へリダイレクトする", async () => {
    useAuthStore.getState().setToken("stale-token");
    vi.mocked(apiClient.auth.me).mockRejectedValue(new Error("network error"));

    renderWithRoutes("/");

    await waitFor(() => expect(screen.getByText("ログイン画面")).toBeInTheDocument());
    expect(useAuthStore.getState().accessToken).toBeNull();
  });
});
