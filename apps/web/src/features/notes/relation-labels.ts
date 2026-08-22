import type { NoteRelationType } from "@secondbrain/shared";

/**
 * `relationType`(7値固定語彙。M1-4b §設計決定1 参照)の日本語表示ラベル。
 * `satisfies Record<NoteRelationType, string>` により、契約側の語彙が増減した場合に
 * ここの網羅漏れをコンパイルエラーで検知できるようにしている。
 *
 * 元は `NoteDetailPage.tsx` に定義されていたが、`/network` 画面のエッジ選択パネルでも
 * 同じラベルが必要になったため共有モジュールへ移動した(M2-2 §設計決定5。コピーして
 * 二重管理しない — `pnpm duplication` の閾値後退防止の観点でも必要)。
 */
export const RELATION_TYPE_LABELS = {
  "same-theme": "同じテーマ",
  "cause-solution": "原因と解決策",
  "claim-counter": "主張と反論",
  "concept-hierarchy": "上位/下位概念",
  "tech-example": "技術と具体例",
  "problem-remedy": "問題と対処法",
  other: "その他の関係",
} satisfies Record<NoteRelationType, string>;

/**
 * `typeDirection` が `outgoing`/`incoming` のとき、視点となるノートが種類の左項・右項の
 * どちらの役割かを表す短いラベル(契約 `relationTypeDirectionSchema` のコメント参照。
 * `outgoing` = 視点ノートが種類の左項)。`same-theme`/`other` は契約上 `typeDirection` が
 * 常に `none` になるため、ここに項目を持たない(=向き自体を表示しない)。
 */
export const RELATION_DIRECTION_ROLE_LABELS: Partial<
  Record<NoteRelationType, Record<"outgoing" | "incoming", string>>
> = {
  "cause-solution": { outgoing: "原因", incoming: "解決策" },
  "claim-counter": { outgoing: "主張", incoming: "反論" },
  "concept-hierarchy": { outgoing: "上位概念", incoming: "下位概念" },
  "tech-example": { outgoing: "技術", incoming: "具体例" },
  "problem-remedy": { outgoing: "問題", incoming: "対処法" },
};
