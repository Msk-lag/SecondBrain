import { FilePlus2, Home, LogOut, Share2 } from "lucide-react";
import { NavLink, useNavigate } from "react-router";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/store/useAuthStore";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const navItems = [
  { to: "/", label: "ホーム", icon: Home, end: true },
  { to: "/save", label: "保存", icon: FilePlus2, end: false },
  { to: "/network", label: "ネットワーク", icon: Share2, end: false },
];

export function AppSidebar() {
  const navigate = useNavigate();
  const clearAuth = useAuthStore((state) => state.clear);

  const handleLogout = () => {
    clearAuth();
    void navigate("/login", { replace: true });
  };

  return (
    <aside className="flex h-screen w-56 shrink-0 flex-col border-r border-border bg-surface">
      <div className="px-4 py-5">
        <span className="text-lg font-semibold text-ink-900">SecondBrain</span>
      </div>
      <nav className="flex flex-1 flex-col gap-1 px-2">
        {navItems.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-accent text-primary"
                  : "text-ink-700 hover:bg-surface-muted hover:text-ink-900",
              )
            }
          >
            <Icon className="size-4" />
            {label}
          </NavLink>
        ))}
      </nav>
      <div className="border-t border-border px-2 py-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="w-full justify-start gap-2 text-ink-700">
              <LogOut className="size-4" />
              アカウント
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={handleLogout}>ログアウト</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </aside>
  );
}
