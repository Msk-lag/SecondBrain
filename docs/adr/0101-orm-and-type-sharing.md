# ADR 0101: ORM・型共有方式・認証ライブラリの決定(M0)

- 状態: 採用
- 記録日: 2026-07-07
- 由来: docs/requirements.md §9「M0 で決める詳細」への対応。.ai/plans/20260707-m0-monorepo-scaffold.md の実装として決定。

## 決定

### ORM: Drizzle ORM

MariaDB のネイティブ VECTOR 型(11.7+ の新機能)は Prisma のスキーマ DSL が現時点で正式サポートしない可能性が高い。raw SQL・カスタム型のエスケープハッチが軽量な Drizzle の方が、VECTOR 列や `VEC_FromText` / `VEC_DISTANCE_COSINE` 等の関数呼び出しを扱いやすいと判断した。

実際に `scripts/poc/mariadb-vector-poc.ts` で Drizzle + `mysql2` ドライバ + カスタム column type を用いて VECTOR 型の挿入・類似検索が問題なく行えることを確認済み(docs/adr/0102-vector-search-poc-result.md 参照)。

### 型共有方式: ts-rest

バックエンドが NestJS(REST 前提のフレームワーク)であるため、tRPC(通常 REST を置き換える設計)よりも、契約ファースト(Zod スキーマ)で REST API に型を後付けできる ts-rest の方が NestJS と自然に統合できると判断した。

契約定義は `packages/shared/src/contracts/` に置き、`apps/api` は `@ts-rest/nest` の `TsRestHandler` デコレータで実装、`apps/web` は `@ts-rest/core` の `initClient` でクライアントを生成する。M0 では `healthContract`(`GET /health`)で疎通確認済み。

### 認証ライブラリ: `@nestjs/passport` + `passport-jwt`(+ `@nestjs/jwt`)

NestJS 公式装備の標準的な組み合わせ。M1 では自分のアカウント1つのみだが、`user_id` によるデータ分離の土台として JWT ベースの `AuthModule`(`apps/api/src/modules/auth/`)の雛形のみを M0 で作成した。実際のログイン UI・ストラテジー実装・保護ルートの適用は M1 で行う。

## 却下した代替案

1. **Prisma(ORM)**: 型安全なスキーマ定義・マイグレーション体験は優れるが、MariaDB VECTOR 型のような最新機能への追従が遅く、raw SQL の扱いも Drizzle ほど軽量でない。
2. **tRPC(型共有)**: フロント/バック双方が TypeScript である利点を最大化できるが、通常 REST を置き換える設計思想のため、NestJS という REST 前提フレームワークとの統合に追加の適合コストがかかる。
3. **Passport 以外の認証ライブラリ(例: 自前 JWT 実装)**: NestJS エコシステムでの実績・保守性を優先し、公式装備の組み合わせを採用。

## 未確定・M1 での再検討事項

- Drizzle のスキーマ定義・マイグレーション運用(drizzle-kit の導入)は M1 の実データモデル設計時に行う。
- ts-rest の契約は M1 以降、実際のノート/検索/認証エンドポイントに合わせて拡充する。
- AuthModule の実ストラテジー(JWT 発行・検証・ガード)は M1 で実装する。

## 残余リスク

- 本 ADR の3決定はいずれも M0 時点の暫定決定であり、M1 の実装で不都合が判明した場合は本 ADR を改訂する前提とする(.ai/plans/20260707-m0-monorepo-scaffold.md の「リスク」節に記載済み)。
