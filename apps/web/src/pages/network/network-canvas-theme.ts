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

/** 線の基準色。不透明度を `linkColor` で変えるため hex で持つ。 */
export const LINK_COLOR_BASE = "#475569";

/** `relatedness = 0` のときの線の不透明度(下限)。淡すぎて視認できなくなるのを防ぐ。 */
export const LINK_MIN_OPACITY = 0.35;

/**
 * `relatedness` に応じて `LINK_MIN_OPACITY` へ加算する幅。`relatedness = 1` のとき
 * 不透明度は `LINK_MIN_OPACITY + LINK_OPACITY_RANGE`(= 0.80、上限)になる。
 */
export const LINK_OPACITY_RANGE = 0.45;

/**
 * エッジのクリック当たり判定(シャドウキャンバス側)に加算する px。既定値 4 では
 * 次数の大きいノード付近で円に判定を奪われエッジを選択できないため広げる。
 * 表示上の線の太さ(`linkWidth`)には影響しない。
 */
export const LINK_HOVER_PRECISION = 10;

/**
 * ノード半径の係数(`r = √(nodeVal) × NODE_REL_SIZE`)。既定値 4 から縮小し、線の露出を
 * 確保して当たり判定の取り合いを緩和する。`nodeVal` に依存しない共通の乗数なので、
 * ノード間の半径比(= 次数比の表現)には影響しない。
 */
export const NODE_REL_SIZE = 3;

/**
 * ノードのクリック判定円の半径の下限(画面 px)。`nodePointerAreaPaint` でシャドウ
 * キャンバスにのみ描くため**見た目の円の大きさは変わらない**。次数0の円は半径
 * `√1 × NODE_REL_SIZE` = 画面上 5〜9px しかなく的として小さすぎるため、小さい円だけ
 * 判定を広げる(`max(実半径, この値 / globalScale)` なので大きい円は実半径のまま)。
 */
export const NODE_MIN_POINTER_RADIUS = 10;

/** ラベル背景板の左右パディング(px)。`globalScale` で割って拡大率に追従させる。 */
export const LABEL_PLATE_PADDING_X = 2;

/** ラベル背景板の上方向のはみ出し(px)。`globalScale` で割って拡大率に追従させる。 */
export const LABEL_PLATE_PADDING_TOP = 1;

/** ラベル背景板の高さ = `fontSize × この比`。文字の上下を余白付きで覆う。 */
export const LABEL_PLATE_HEIGHT_RATIO = 1.15;

export function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * ラベル背景板の色。線・円と重なってもラベルが読めるよう、ほぼ不透明な白を敷く。
 * `hexToRgba` を再利用するため、その定義より後ろに置く(巻き上げに依存しない)。
 */
export const LABEL_PLATE_COLOR = hexToRgba("#ffffff", 0.82);

/**
 * 「クリック」と「パン/ドラッグ」を分ける、押下→解放の移動量の閾値(画面 px)。
 * force-graph 内部の `DRAG_CLICK_TOLERANCE_PX`(5)と同値にし、ノードのドラッグ判定と揃える。
 */
export const BACKGROUND_CLICK_TOLERANCE_PX = 5;
