import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { AppLayout } from "./AppLayout";
import { useAuthStore } from "@/store/useAuthStore";

describe("AppLayout", () => {
  beforeEach(() => {
    useAuthStore.getState().clear();
  });

  it("サイドバーと子ルート(Outlet)の内容を表示する", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/" element={<div>子ルートの内容</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText("子ルートの内容")).toBeInTheDocument();
    expect(screen.getAllByText("SecondBrain").length).toBeGreaterThan(0);
  });

  it("モバイルヘッダーに /network へのリンクを表示する(F-20 のモバイル到達性)", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/" element={<div>子ルートの内容</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    // jsdom は CSS のメディアクエリを解釈しないため、`hidden md:flex`(サイドバー)と
    // `md:hidden`(モバイルヘッダー)のどちらも DOM 上には存在してしまう。そのため
    // 単純な screen.getByRole だと「ネットワーク」リンクがサイドバー側とモバイル
    // ヘッダー側の2件ヒットして曖昧になる。モバイルヘッダー(<header> の暗黙ロール
    // banner)の内側にスコープを絞って検証する。
    const mobileHeader = screen.getByRole("banner");
    const networkLink = within(mobileHeader).getByRole("link", { name: "ネットワーク" });
    expect(networkLink).toHaveAttribute("href", "/network");
  });

  it("モバイルヘッダーのログアウトボタンでもトークンを破棄する", async () => {
    useAuthStore.getState().setToken("token-123");
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/" element={<div>子ルートの内容</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: "ログアウト" }));

    expect(useAuthStore.getState().accessToken).toBeNull();
  });
});
