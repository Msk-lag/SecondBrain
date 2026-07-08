import { initClient, initContract, tsRestFetchApi, type ApiFetcher } from "@ts-rest/core";
import { authContract, healthContract } from "@secondbrain/shared";
import { useAuthStore } from "../store/useAuthStore";

const c = initContract();

const appContract = c.router({
  ...healthContract,
  auth: authContract,
});

// 401 応答を受けたら保存済みトークンを破棄する(期限切れ・改ざん・JWT_SECRET 変更時の共通処理)
const api: ApiFetcher = async (args) => {
  // baseHeaders は常に文字列を返す必要がある制約上、トークン未保存時は空文字列になる。
  // 未認証リクエスト(ログイン・ヘルスチェック等)に空の Authorization ヘッダーを
  // 送らないよう、ここで取り除く。
  const headers = { ...args.headers };
  if (!headers.Authorization) {
    delete headers.Authorization;
  }

  const result = await tsRestFetchApi({ ...args, headers });
  if (result.status === 401) {
    useAuthStore.getState().clear();
  }
  return result;
};

export const apiClient = initClient(appContract, {
  baseUrl: import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000",
  baseHeaders: {
    Authorization: () => {
      const token = useAuthStore.getState().accessToken;
      return token ? `Bearer ${token}` : "";
    },
  },
  api,
});
