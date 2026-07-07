# ADR 0102: MariaDB ベクトル検索 技術検証(PoC)結果

- 状態: 採用(Qdrant 併用は現時点で不要と判断)
- 記録日: 2026-07-07
- 由来: docs/requirements.md §6「M0 で技術検証」への対応。.ai/plans/20260707-m0-monorepo-scaffold.md の実装として実施。

## 検証内容

Docker Compose 上の `mariadb:11.7` に対し、以下を確認した(再現スクリプト: `scripts/poc/mariadb-vector-poc.ts`、実行コマンド: `pnpm poc:vector`)。

1. `VECTOR(4)` 型カラム + `VECTOR INDEX` を持つテーブルの作成
2. `VEC_FromText('[...]')` によるベクトルデータの挿入
3. `VEC_DISTANCE_COSINE(embedding, ...)` によるコサイン距離での類似順ソート
4. 上記すべてを Drizzle ORM(`drizzle-orm/mysql2`)+ `mysql2` ドライバ経由(raw `sql` テンプレート)で実行

## 結果

すべて期待通りに動作した。意図的に用意した3件(`near-a`: 基準ベクトルと同一、`near-b`: 近いベクトル、`far`: 直交する遠いベクトル)を `VEC_DISTANCE_COSINE` でソートした結果:

| label | dist |
|---|---|
| near-a | 0 |
| near-b | 0.0061... |
| far | 1 |

期待した類似順(`near-a` → `near-b` → `far`)と一致した。追加のプラグイン有効化や特別な設定は不要で、`mariadb:11.7` イメージの初期状態からそのまま利用できた。

Drizzle ORM の型付きスキーマ DSL は VECTOR 型を組み込みでサポートしていないため、DDL・INSERT・SELECT はいずれも Drizzle の `sql` テンプレート(raw SQL)経由で実行した。これは ADR 0101 で Drizzle を選定した際の想定通りであり、M1 以降もベクトル列に関する操作は `sql` テンプレートで書く方針とする。

## 結論・Qdrant 併用の判断

**現時点(M0)では Qdrant の併用は不要と判断する。** 理由:

- MariaDB ネイティブ VECTOR 型で挿入・類似検索が問題なく行える(本検証で確認)
- インフラ構成をシンプルに保てる(docs/requirements.md §5 のコスト・小さく始める方針に合致)
- M1 で実際のデータ量・クエリパターンが明らかになった時点で、性能上の問題が出れば改めて Qdrant 併用を検討する(docs/requirements.md §6 に記載の既定の代替方針)

## 未検証・既知の制約

- 大量データでの性能・インデックス品質のベンチマークは行っていない(計画上スコープ外。M1 で実データ量に応じて再評価する)。
- RDS(AWS 本番)側で `mariadb:11.7` 相当のバージョンが提供されているかは未確認(デプロイ実施時に確認する。docs/requirements.md §10 の未決事項と関連)。
- **MariaDB は一時テーブル(`CREATE TEMPORARY TABLE`)への `VECTOR INDEX` 作成を許可しない**(`ER_INNODB_NO_FT_TEMP_TABLE`)。そのため PoC スクリプトは通常テーブルを使うが、固定名だと誤って既存の同名テーブルを削除するリスクがあるため、実行のたびに一意なテーブル名(`poc_vector_items_<uuid>`)を使い、`finally` で確実に削除する構成にした(Codex コードレビュー指摘への対応)。M1 で本実装するノートの埋め込みテーブルも、この制約を踏まえてテーブル設計を行うこと。
