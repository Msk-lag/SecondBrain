/**
 * `.env.example` に記載されているプレースホルダの接頭辞(実際の値は `changeme-jwt-secret`)。
 * ユーザーの `.env` がこの値のまま公開デプロイされると、署名鍵が公開情報になり誰でも
 * 任意ユーザーになりすます JWT を偽造できてしまう(認証の完全無効化)。大文字小文字を
 * 区別せず、接頭辞一致で判定する。
 */
const PLACEHOLDER_PREFIXES = ["changeme", "change-me"];

/**
 * リポジトリのテストコードがかつて使用していた、固定文字列の JWT 署名鍵の denylist。
 *
 * 過去には単体テスト・統合テストの双方が固定文字列(`test-secret` /
 * `integration-test-jwt-secret`)を JWT_SECRET に設定していた。固定文字列は Git 管理下に
 * あり公開情報のため、設定ミス・コピペ・CI 設定の流用などで本番環境に混入すると、
 * プレースホルダと同じ経路で JWT を偽造できてしまう。テスト側は現在この denylist に
 * 載らない実行時生成の値(`node:crypto` の `randomBytes`)を使うよう改めたが、過去に
 * リポジトリへコミットされていた値は誰でも履歴から知り得るため、念のため denylist として
 * 残し拒否し続ける。
 *
 * 判定は `NODE_ENV` 等の環境変数分岐には頼らない(本番で `NODE_ENV` まで誤設定されると
 * 突破されるため)。値そのものを拒否する。
 */
const KNOWN_TEST_SECRETS = ["test-secret", "integration-test-jwt-secret"];

function isPlaceholderSecret(secret: string): boolean {
  const normalized = secret.toLowerCase();
  return PLACEHOLDER_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function isKnownTestSecret(secret: string): boolean {
  const normalized = secret.toLowerCase();
  return KNOWN_TEST_SECRETS.includes(normalized);
}

export function getRequiredJwtSecret(): string {
  const secret = process.env.JWT_SECRET?.trim();
  if (!secret) {
    throw new Error("JWT_SECRET environment variable is required but not set");
  }
  if (isPlaceholderSecret(secret)) {
    throw new Error(
      "JWT_SECRET is still set to the placeholder value from .env.example. " +
        "Generate a real secret and set it before starting the server.",
    );
  }
  if (isKnownTestSecret(secret)) {
    throw new Error(
      "JWT_SECRET is set to a known fixture value used by this repository's test suite. " +
        "Generate a real secret and set it before starting the server.",
    );
  }
  return secret;
}
