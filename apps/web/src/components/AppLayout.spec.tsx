import { render, screen } from "@testing-library/react";
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
