import { FilePlus2, Home, LogOut, Share2 } from "lucide-react";
import { NavLink, Outlet, useNavigate } from "react-router";
import { AppSidebar } from "@/components/AppSidebar";
import { useAuthStore } from "@/store/useAuthStore";

export function AppLayout() {
  const navigate = useNavigate();
  const clearAuth = useAuthStore((state) => state.clear);

  const handleLogout = () => {
    clearAuth();
    void navigate("/login", { replace: true });
  };

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <div className="hidden md:flex">
        <AppSidebar />
      </div>
      <header className="flex items-center justify-between border-b border-border bg-surface px-4 py-3 md:hidden">
        <span className="text-base font-semibold text-ink-900">SecondBrain</span>
        <nav className="flex items-center gap-3">
          <NavLink to="/" end className="text-ink-700" aria-label="ホーム">
            <Home className="size-5" />
          </NavLink>
          <NavLink to="/save" className="text-ink-700" aria-label="保存">
            <FilePlus2 className="size-5" />
          </NavLink>
          <NavLink to="/network" className="text-ink-700" aria-label="ネットワーク">
            <Share2 className="size-5" />
          </NavLink>
          <button
            type="button"
            onClick={handleLogout}
            className="text-ink-700"
            aria-label="ログアウト"
          >
            <LogOut className="size-5" />
          </button>
        </nav>
      </header>
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
