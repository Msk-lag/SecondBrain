import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { AppSidebar } from "./AppSidebar";
import { useAuthStore } from "@/store/useAuthStore";

describe("AppSidebar", () => {
  beforeEach(() => {
    useAuthStore.getState().clear();
  });

  it("ホーム・保存・ネットワークへのナビゲーションリンクを表示する", () => {
    render(
      <MemoryRouter>
        <AppSidebar />
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "ホーム" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "保存" })).toHaveAttribute("href", "/save");
    expect(screen.getByRole("link", { name: "ネットワーク" })).toHaveAttribute("href", "/network");
  });

  it("ログアウトを選択するとトークンを破棄する", async () => {
    useAuthStore.getState().setToken("token-123");
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <AppSidebar />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: "アカウント" }));
    await user.click(await screen.findByRole("menuitem", { name: "ログアウト" }));

    expect(useAuthStore.getState().accessToken).toBeNull();
  });
});
