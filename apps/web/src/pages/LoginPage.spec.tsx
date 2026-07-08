import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { vi } from "vitest";
import { LoginPage } from "./LoginPage";
import { apiClient } from "../lib/api-client";
import { useAuthStore } from "../store/useAuthStore";

vi.mock("../lib/api-client", () => ({
  apiClient: {
    auth: {
      login: vi.fn(),
    },
  },
}));

function renderPage() {
  render(
    <MemoryRouter initialEntries={["/login"]}>
      <LoginPage />
    </MemoryRouter>,
  );
}

describe("LoginPage", () => {
  beforeEach(() => {
    useAuthStore.getState().clear();
    vi.mocked(apiClient.auth.login).mockReset();
  });

  it("未入力で送信するとバリデーションエラーを表示し送信しない", () => {
    renderPage();

    fireEvent.click(screen.getByTestId("login-submit"));

    expect(screen.getByTestId("email-error")).toHaveTextContent("メールアドレスを入力してください");
    expect(screen.getByTestId("password-error")).toHaveTextContent("パスワードを入力してください");
    expect(apiClient.auth.login).not.toHaveBeenCalled();
  });

  it("認証に失敗すると認証エラーバナーを表示する", async () => {
    vi.mocked(apiClient.auth.login).mockResolvedValue({
      status: 401,
      body: { message: "メールアドレスまたはパスワードが正しくありません。" },
      headers: new Headers(),
    });
    renderPage();

    fireEvent.change(screen.getByLabelText("メールアドレス"), {
      target: { value: "user@example.com" },
    });
    fireEvent.change(screen.getByLabelText("パスワード"), {
      target: { value: "wrong-password" },
    });
    fireEvent.click(screen.getByTestId("login-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("login-auth-error")).toHaveTextContent(
        "メールアドレスまたはパスワードが正しくありません。",
      ),
    );
  });

  it("通信エラーで送信に失敗すると汎用エラーバナーを表示する", async () => {
    vi.mocked(apiClient.auth.login).mockRejectedValue(new Error("network error"));
    renderPage();

    fireEvent.change(screen.getByLabelText("メールアドレス"), {
      target: { value: "user@example.com" },
    });
    fireEvent.change(screen.getByLabelText("パスワード"), {
      target: { value: "correct-password" },
    });
    fireEvent.click(screen.getByTestId("login-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("login-auth-error")).toHaveTextContent(
        "通信状態を確認して、もう一度お試しください。",
      ),
    );
  });

  it("認証に成功するとアクセストークンを保存する", async () => {
    vi.mocked(apiClient.auth.login).mockResolvedValue({
      status: 200,
      body: { accessToken: "token-abc" },
      headers: new Headers(),
    });
    renderPage();

    fireEvent.change(screen.getByLabelText("メールアドレス"), {
      target: { value: "user@example.com" },
    });
    fireEvent.change(screen.getByLabelText("パスワード"), {
      target: { value: "correct-password" },
    });
    fireEvent.click(screen.getByTestId("login-submit"));

    await waitFor(() => expect(useAuthStore.getState().accessToken).toBe("token-abc"));
  });

  it("既にログイン済みの場合はフォームを表示しない", () => {
    useAuthStore.getState().setToken("existing-token");
    renderPage();

    expect(screen.queryByLabelText("メールアドレス")).not.toBeInTheDocument();
  });
});
