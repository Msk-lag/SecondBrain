import { useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { loginRequestSchema } from "@secondbrain/shared";
import { apiClient } from "../lib/api-client";
import { useAuthStore } from "../store/useAuthStore";

type FieldErrors = Partial<Record<"email" | "password", string>>;

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const accessToken = useAuthStore((state) => state.accessToken);
  const setToken = useAuthStore((state) => state.setToken);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [authError, setAuthError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (accessToken) {
    return <Navigate to="/" replace />;
  }

  const redirectTo =
    (location.state as { from?: { pathname: string } } | null)?.from?.pathname ?? "/";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthError(null);

    const result = loginRequestSchema.safeParse({ email, password });
    if (!result.success) {
      const nextErrors: FieldErrors = {};
      for (const issue of result.error.issues) {
        if (issue.path[0] === "email") {
          nextErrors.email = "メールアドレスを入力してください";
        }
        if (issue.path[0] === "password") {
          // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- 検証エラーの文言であり秘密情報ではない
          nextErrors.password = "パスワードを入力してください";
        }
      }
      setFieldErrors(nextErrors);
      return;
    }
    setFieldErrors({});
    setSubmitting(true);
    try {
      const response = await apiClient.auth.login({ body: result.data });
      if (response.status === 200) {
        setToken(response.body.accessToken);
        void navigate(redirectTo, { replace: true });
        return;
      }
      setAuthError("メールアドレスまたはパスワードが正しくありません。");
    } catch {
      setAuthError("通信状態を確認して、もう一度お試しください。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main
      className="flex min-h-screen items-center justify-center"
      style={{ backgroundColor: "var(--bg)" }}
    >
      <div style={{ width: 380 }}>
        <div className="mb-8 flex items-center justify-center gap-2">
          <div
            className="flex h-7 w-7 items-center justify-center text-white"
            style={{ backgroundColor: "var(--accent)", borderRadius: 7 }}
          >
            <span className="text-xs font-bold">SB</span>
          </div>
          <span className="text-[17px] font-bold tracking-tight">SecondBrain</span>
        </div>

        <div
          className="p-7"
          style={{
            backgroundColor: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-lg)",
          }}
        >
          <h1 className="mb-1 text-base font-bold">ログイン</h1>
          <p className="mb-5 text-[12.5px]" style={{ color: "var(--ink-600)" }}>
            貼るだけで、知識が溜まっていく。
          </p>

          {authError && (
            <div
              role="alert"
              data-testid="login-auth-error"
              className="mb-4 rounded-md px-3 py-2.5 text-[12.5px]"
              style={{
                backgroundColor: "var(--danger-soft)",
                border: "1px solid var(--danger-soft-border)",
                color: "var(--danger)",
              }}
            >
              {authError}
            </div>
          )}

          <form onSubmit={(event) => void handleSubmit(event)} noValidate>
            <div className="mb-4">
              <label className="mb-1.5 block text-[12.5px] font-semibold" htmlFor="email">
                メールアドレス
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                className="w-full px-3 py-2 text-[13.5px] focus:outline-none"
                style={{
                  border: `1px solid ${fieldErrors.email ? "var(--danger)" : "var(--border-strong)"}`,
                  borderRadius: "var(--radius-md)",
                }}
                placeholder="you@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={submitting}
              />
              {fieldErrors.email && (
                <p
                  className="mt-1.5 text-xs"
                  style={{ color: "var(--danger)" }}
                  data-testid="email-error"
                >
                  {fieldErrors.email}
                </p>
              )}
            </div>
            <div className="mb-5">
              <label className="mb-1.5 block text-[12.5px] font-semibold" htmlFor="password">
                パスワード
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                className="w-full px-3 py-2 text-[13.5px] focus:outline-none"
                style={{
                  border: `1px solid ${fieldErrors.password ? "var(--danger)" : "var(--border-strong)"}`,
                  borderRadius: "var(--radius-md)",
                }}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={submitting}
              />
              {fieldErrors.password && (
                <p
                  className="mt-1.5 text-xs"
                  style={{ color: "var(--danger)" }}
                  data-testid="password-error"
                >
                  {fieldErrors.password}
                </p>
              )}
            </div>
            <button
              type="submit"
              disabled={submitting}
              data-testid="login-submit"
              className="w-full py-2 text-[13.5px] font-medium text-white disabled:opacity-50"
              style={{ backgroundColor: "var(--accent)", borderRadius: "var(--radius-md)" }}
            >
              {submitting ? "ログインしています…" : "ログイン"}
            </button>
          </form>
        </div>
        <p className="mt-5 text-center text-[11.5px]" style={{ color: "var(--ink-400)" }}>
          MVPにつき新規登録は管理者による招待制です。
        </p>
      </div>
    </main>
  );
}
