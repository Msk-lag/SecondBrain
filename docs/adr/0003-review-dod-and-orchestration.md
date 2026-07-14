# ADR 0003: レビュー終了条件(DoD)の再定義とオーケストレーション改訂

- 状態: 採用
- 記録日: 2026-07-14
- 由来: レビュー→修正の無限ループによるトークン過大消費(再レビューごとに新規 HIGH が出て終わらない)、実装計画書の肥大化(M1-3 で約308KB)、機能別設計書の不在、push 後の CI 未確認、サブエージェント全件 `model: inherit` によるトークン浪費、への対応。方針は Claude(Fable)と Codex の独立議論3ラウンド(2026-07-13〜14)で確定した。

## 決定

### 1. レビューは D0 → R1/R2 モデルに変更する(規則 REV-1)

- **D0(発見レビュー)**: base..head の変更全体を対象に**1回だけ**実施する。
- **R1/R2(修正検証)**: スコープは「D0 指摘の解消確認+**修正差分が導入した回帰**」のみ。未変更箇所の再探索・元 diff 全体の再レビューは禁止(remediation-verification プロンプトで機械的に固定)。新規指摘には `introduced_by_remediation: true|false` を必須付与し、`false` の指摘は再レビュー指摘とせず Issue 候補として記録する。
- 解消必須なのは「D0 の BLOCKER/HIGH+修正起因の BLOCKER/HIGH」。修正と無関係な後発指摘は自動修正せず **Issue 化(元 SHA・期限付き)**する。Markdown 記録のみで済ませることは禁止(先送り指摘の墓場化対策)。
- 指摘の状態は `resolved / invalid / risk-accepted / unresolved` の4値。**`risk-accepted` は人間のみが選択できる**(理由と Issue が必須)。
- R2 終了時に unresolved が残る場合は自動通過しない。PR を draft に戻して人間判断へエスカレーションする(自走モードは failed 記録して次へ。ただし壊れたブランチに依存する後続機能は積まず、最後の green な基点から独立機能のみ進める)。
- R2 後に1行でも変更したら検証結果は無効となり、新 HEAD への再検証が必須。**R2 は「自動修正ループの上限」であって「検証省略の上限」ではない。**
- 機械検査(lint / typecheck / test)が失敗している間は Codex レビューを開始しない。レビュー入力にはサイズ上限(D0 約50KB / R1・R2 約20KB)を設け、超過時はレビューを省略せず「PR 分割必須」として停止する。

### 2. DoD は「PR 作成条件」ではなく「Ready 化・マージ条件」とする(規則 DOD-1)

- feature ブランチの最初の push 直後に **Draft PR を作成**する(CI 確認の対象と base..head を固定するため)。
- Ready 化・マージ条件 = テスト全通過+受入条件全達成+diff カバレッジ100%+**現在の HEAD に対する検証が完了しており、D0 および修正起因(`introduced_by_remediation: true`)の BLOCKER/HIGH に未解決(unresolved/partial)が無いこと**+CI 成功。

### 3. タスク粒度(規則 PLAN-1)

- 第一基準は「**単一の受入成果・独立して green**(必要なら feature flag)」。数値は補助目安: 手書き変更 約12ファイル・論理変更 約600行・計画書 20KB ハード上限(生成物・lockfile は別計数)。
- 超過時は縦切りサブユニット(例: M1-4a, M1-4b)に分割する。計画書は「epic index+サブユニット計画」に分離し、実装時は**当該サブユニットのみ**をコンテキストへ供給する。
- サブユニット群が揃った時点で結合テストのチェックポイントを設けるほか、影響範囲に該当する PR では CI でも結合テストを実行する。

### 4. 機能別詳細設計書(規則 DOC-1)

- `docs/templates/feature-design.md` に基づき、機能の実装 PR と**同一 PR 内**で `docs/features/<機能ID>.md` を作成・更新する(完了後生成では実装との乖離を検知できない)。doc-writer サブエージェントが生成し、codex-review docs でレビューする(R1/R2 と同じ2ラウンド上限)。
- 対象は公開 API・複数 package・データモデル変更を含む機能(本 PJ の「1機能=画面+API+ジョブ」は実質全機能が該当)。fix/chore 等の小変更は README/JSDoc で足りる。

### 5. push 後の CI 確認と自己マージゲート(規則 CI-1)

- push 後は `gh pr checks <PR> --watch --fail-fast` で CI 完了を必ず確認する。失敗→修正→再 push は最大2回(インフラ障害の rerun は別計数)、超過で人間へエスカレーション。
- ci.yml に `if: always()` の**集約 gate job** を置き、必要 job の成否を明示検証する(skip は「対象外変更のみ」の場合のみ許容)。
- 自己マージゲート(自走モード)は branch protection 不在を前提に fail-closed で設計する: (1) 期待 check 名の**明示 allowlist** と照合し全 check の存在+成功を確認 (2) 確認対象が現在の HEAD SHA であることを検証 (3) マージは `--match-head-commit <SHA>` 付きに限る。`gh pr checks --required` は required check 未設定だと空振りするため単独では信頼しない。
- 手動モードのマージは「ユーザーを信頼境界に含めた運用上の fail-closed」であり、GitHub による強制ではない。

### 6. モデル役割分担(規則 MODEL-1)

- サブエージェントの frontmatter にエイリアスでモデルを固定する: implementer / doc-writer = `sonnet`、repo-scout / test-runner = `haiku`(test-runner は原則スクリプト実行+結果分類のみ)。
- メインエージェント(ユーザー選択。Fable 可)はオーケストレーション・分割・設計判断・**リスク受容の人間への依頼と記録**・検収のみを行い、ファイル書き換えはサブエージェントへ委任する。`risk-accepted` への遷移は人間の明示的な承認のみで行われ(規則 REV-1)、メインエージェントが自律的に `risk-accepted` を選択することはできない。

### 7. 実装担当のルーティング(Sonnet ⇔ Codex)(規則 ROUTE-1)

- Claude 側トークン残量を `scripts/check-claude-budget`(バージョン固定した ccusage を補助指標として利用)で取得し、**実装ユニット開始時**に担当を判定する(ユニット途中の担当変更は禁止):
  - **Green**(当該ユニットの予測消費を足しても 5時間枠の25%・週次枠の20%を Fable+レビュー用に残せる)→ Sonnet 実装
  - **Yellow**(予約枠を侵食)→ Codex 実装優先(Claude 文脈依存の小タスクのみ Sonnet)
  - **Red / unknown** → Codex 実装。Claude はレビュー・検収のみ。Sonnet レビュー枠も不足する場合は Draft PR で停止しマージしない
  - 復帰はヒステリシス(ウィンドウのリセット後、または使用率50%未満まで Sonnet に戻さない)。閾値は運用開始から2週間で実測校正する。
- 残量より優先する条件: セキュリティ/認証/DB 移行/公開 API 変更は Sonnet(枠不足なら**延期**し Codex に回さない)。大量の機械的編集は Codex。Sonnet 2回失敗時は即時切替せず、メインエージェントが仕様・分割を再整理してから再判定する。
- Codex 実装は `scripts/codex-implement`(workspace-write、feature ブランチのみ、git 操作禁止)経由に限る。入力は `docs/templates/implementation-packet.md` に基づく実装パケット、開始 SHA と終了 diff を照合し範囲外変更は失敗扱い。
- **独立性ルール**: 同一 PR で「実装したモデル系列がレビューしない」。Sonnet 実装→Codex レビュー / Codex 実装→Claude(Sonnet)レビュー。Sonnet レビューにも Codex と同一の重大度定義・出力形式・入力設計を適用する。Codex 実装の初期 PR はメインエージェントが重点検収し、見逃し・不具合を実装経路別に記録して弱点領域は経路を固定する。独立レビューを維持できない場合はマージせず延期する。

### 8. 追加問題への対策

- **jscpd**: 既定ブランチの実測値+マージンに閾値を変更し、生成物・test fixture を除外する(`threshold: 100` は無効ゲートだった)。
- **結合テスト**: MariaDB service container で CI job 化する。パスフィルタは fail-closed(db/api/worker に加え共有 package・migration/schema・lockfile・ルート設定・テスト基盤を対象に含め、判定不能時は実行する)。
- **規律の多重記載**: 規範文書を `docs/harness-architecture.md` に一本化し規則 ID(REV-1 等)を付与する。CLAUDE.md・development-workflow.md・SKILL.md は規則 ID 参照+要約に書き換える(自動生成・CI 同期検証は個人開発には過剰につき不採用)。
- **Codex 相談チャネル**: `scripts/codex-consult`(read-only、質問・許可 context・タイムアウト必須、出力は非ゲート)を新設し、エスカレーション方針「難所は Codex 相談」と整合させる。
- **husky**: pre-commit で staged ファイルの prettier、pre-push で `verify:fast`(lint+typecheck+unit)。CI と同一の package scripts を共有する。hook は迂回可能なため CI を最終権威とする。
- **カバレッジ**: 全 vitest config に `coverage.include`(全 source)+明示 exclude を設定(v8 provider は import されたファイルしか集計しないため先決)→ 実測 → package 単位で thresholds を現状値 floor に固定(後退禁止)→ diff カバレッジ100%(`diff-cover`、CI のみ必須・fail-closed、ローカルは Python があれば実行/なければ `SKIPPED` と明示)。
- **効果測定(軽量版)**: レビューラウンド数・トークン概算・CI 再実行数を機能 Issue のコメントに記録し、2〜4週間後に閾値・モデル配分を見直す。

## 却下した代替案

1. **「初回レビューの BLOCKER/HIGH 0件」を DoD にする案(当初案)**: 初回に1件でも出た時点で永久に満たせず条件定義が不整合(Codex 指摘)。D0/R1/R2 モデルに置き換え。
2. **全体カバレッジ100%の強制**: 既存コードの網羅作業に大きなコストがかかり境界外コードの除外設計も必要。「diff 100%+全体は現状値固定(後退禁止)」を採用。
3. **中央 role-to-model 設定+frontmatter 生成**: 個人開発では対象4ファイルの手動管理で足りるため過剰。frontmatter 直書き(エイリアスのみ)を採用。
4. **規則の重複箇所の自動生成+CI 同期検証**: 同上の理由で過剰。規範一本化+手動の ID 参照を採用。
5. **mutation testing の導入**: コスト過剰。重要ロジックには境界値・失敗経路テストを計画時に明記する方式で代替。
6. **Sonnet 2回失敗での Codex への即時自動切替**: 仕様不備を別モデルに渡すだけになる危険がある(Codex 指摘)。メインエージェントによる仕様・分割の再整理を先行させる。
7. **`gh pr checks --required` への依存**: branch protection 未設定だと required check ゼロでも成功扱いになり得るため、期待 check 名 allowlist+HEAD SHA 検証方式を採用。
8. **単純な使用率閾値(例: 70%)でのモデル切替**: 補足不能な消費(別端末等)と切替の振動を防げないため、予約量ベース+ヒステリシス方式を採用。

## 保留事項

- **開発プロセスのウォーターフォール転換(全体機能設計書の先行作成)**: ユーザーが再検討中。議論素材(完全ウォーターフォール vs マイルストーン契約先行 vs 現状維持の比較、Codex の推奨と破綻シナリオ)は議論ログ R3 論点B を参照。結論後に本 ADR の追補または ADR-0004 として記録する。過去機能(M0〜M1-3)の設計書バックフィルの範囲もこの結論に依存する。

## 残余リスク

- ccusage はローカル transcript からの推計であり、契約上の正確な残量とは限らない(別端末利用・ログ削除・上限仕様変更は捕捉不能)。`unknown` 時は Codex 実装に倒す fail-safe で補う。
- diff カバレッジ100%はテスト品質を保証しない(assertion の弱いテストでも通る)。受入条件と境界値・失敗経路テストの計画時明記で補完する。
- Sonnet レビューの品質が Codex レビューと同等である保証は事前にはない。実装経路別の見逃し記録で監視し、弱点領域は「Sonnet 実装→Codex レビュー」経路に固定する。
- 手動マージは技術的に迂回可能(branch protection 不在時)。ユーザー自身を信頼境界に含める運用で許容する。
