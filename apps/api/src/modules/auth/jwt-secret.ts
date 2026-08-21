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

/**
 * JWT_SECRET に求める最小バイト長(UTF-8)。RFC 7518(JSON Web Algorithms, JWA)§3.2 は
 * HS256 について「ハッシュ出力と同サイズ(256 ビット = 32 バイト)以上の鍵を使用しなければ
 * ならない(MUST)」と規定しており、この値はその仕様適合を強制するための最小長である。
 * つまりこのチェックは単なる推奨事項の強制ではなく、32 バイト未満の鍵で HS256 を運用する
 * こと自体が JWA 仕様違反にあたる、という位置づけである。
 *
 * 背景: RFC 2104(HMAC)§3 は「鍵長がハッシュ出力長を下回ると強度が低下する」ことを示して
 * おり、JWA の MUST 要件はこの HMAC 一般論を HS256 に適用したものと理解できる。
 * `jsonwebtoken` はこの MUST をライブラリ側で自前に強制しないため、アプリケーション側で
 * 強制するのは確立された実務である。
 *
 * 注意: このチェックはあくまでバイト長のみを見ており、エントロピー(推測されにくさ)は
 * 保証しない。例えば `"a".repeat(32)` は 32 バイトあるためこのチェックを通過するが、
 * 攻撃者にとって自明な弱い鍵である。エントロピー推定まで実装すると複雑さに見合う効果が
 * 薄いため、実運用では鍵を `node:crypto` の `randomBytes` 等で生成する運用手順(README /
 * Issue #66 のコメント参照)側で強い鍵を担保する方針とする。
 */
const MIN_SECRET_BYTE_LENGTH = 32;

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
  // このチェックはプレースホルダ・既知テスト鍵の判定より後に置く。先に置いてしまうと
  // `.env.example` のプレースホルダ(`changeme-jwt-secret`、19 バイト)がこの長さチェックで
  // 先に弾かれ、「プレースホルダのままです」という具体的な誘導メッセージが失われてしまう。
  // より具体的な診断を優先し、それでも該当しない場合の最後の砦として長さを検証する。
  if (Buffer.byteLength(secret, "utf8") < MIN_SECRET_BYTE_LENGTH) {
    throw new Error(
      "JWT_SECRET must be at least 32 bytes. " +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }
  return secret;
}
