import type { NoteType } from "@secondbrain/shared";

/**
 * `NetworkCanvas.tsx` が使うキャンバス描画用の色・しきい値の定数(M2-2 §設計決定4)。
 * **キャンバス内の描画色は CSS が使えないため、ここに定数として持つ**
 * (§デザインとの対応「キャンバス内の描画色のみ CSS が使えないため定数で持つ」)。
 *
 * `NetworkCanvas.tsx` 本体から分離しているのは、React Fast Refresh が「1ファイルは
 * コンポーネントのみを export する」ことを前提にしており、コンポーネントと定数を
 * 同一ファイルから export すると `react-refresh/only-export-components` に抵触するため。
 */

/** ノート種別ごとの固定色(M2-2 §設計決定4「ノードの色」)。 */
export const NODE_TYPE_COLORS: Record<NoteType, string> = {
  memo: "#5b7fff",
  url: "#1fb6a6",
  screenshot: "#e8a23c",
};

/** 選択中のノード(とそのラベル)を強調する色。 */
export const SELECTED_NODE_COLOR = "#e0245e";

/**
 * 次数0のノードを視覚的に減衰させる不透明度(§設計決定3)。彩度(種別色そのもの)は
 * 変えず、透明度のみ落とす。
 */
export const DEGREE_ZERO_OPACITY = 0.32;

/** ノードラベルの既定色(未選択時)。 */
export const NODE_LABEL_COLOR = "#1f2937";

/**
 * これ未満の `globalScale`(ズームアウトして小さく見えている状態)では、ラベルが重なって
 * 読めなくなるため描画しない(§設計決定4)。
 */
export const LABEL_MIN_GLOBAL_SCALE = 0.6;

/** ラベルの基準フォントサイズ(px)。`globalScale` で割ることで画面上の見た目サイズを一定に保つ。 */
export const LABEL_BASE_FONT_SIZE = 12;

/** ノード中心からラベルまでの垂直オフセット(px)。`globalScale` で割って拡大率に追従させる。 */
export const LABEL_OFFSET_Y = 8;

export function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
