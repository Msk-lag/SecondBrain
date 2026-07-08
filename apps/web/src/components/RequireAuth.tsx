import { useEffect, useState } from "react";
import { Navigate, Outlet, useLocation } from "react-router";
import { apiClient } from "../lib/api-client";
import { useAuthStore } from "../store/useAuthStore";

interface VerifiedToken {
  token: string;
  valid: boolean;
}

export function RequireAuth() {
  const accessToken = useAuthStore((state) => state.accessToken);
  const clear = useAuthStore((state) => state.clear);
  const location = useLocation();
  const [verifiedToken, setVerifiedToken] = useState<VerifiedToken | null>(null);

  useEffect(() => {
    if (!accessToken) {
      return;
    }
    let cancelled = false;
    apiClient.auth
      .me()
      .then((response) => {
        if (cancelled) return;
        if (response.status === 200) {
          setVerifiedToken({ token: accessToken, valid: true });
        } else {
          clear();
          setVerifiedToken({ token: accessToken, valid: false });
        }
      })
      .catch(() => {
        if (!cancelled) {
          clear();
          setVerifiedToken({ token: accessToken, valid: false });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, clear]);

  if (!accessToken) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  if (!verifiedToken || verifiedToken.token !== accessToken) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <span className="text-sm" style={{ color: "var(--ink-600)" }}>
          読み込み中…
        </span>
      </div>
    );
  }

  if (!verifiedToken.valid) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return <Outlet />;
}
