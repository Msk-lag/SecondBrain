import type { GraphViewLink, GraphViewNode } from "@/features/graph/to-graph-data";
import {
  LABEL_BASE_FONT_SIZE,
  LABEL_MIN_GLOBAL_SCALE,
  LABEL_OFFSET_Y,
  LABEL_PLATE_HEIGHT_RATIO,
  LABEL_PLATE_PADDING_TOP,
  LABEL_PLATE_PADDING_X,
  LINK_HOVER_PRECISION,
  NODE_MIN_POINTER_RADIUS,
  NODE_REL_SIZE,
} from "./network-canvas-theme";

/**
 * `nodeCanvasObject` 呼び出し時点(force-graph がレイアウトを確定させた後)は `x`/`y` が
 * 必ず数値で埋まっている。型上は optional なままの `GraphViewNode` を、キャンバス描画・
 * 当たり判定に必要な座標つきの形へ絞り込むための内部型(不要な undefined ガード分岐を
 * 作らないため)。
 */
export interface PositionedGraphNode extends GraphViewNode {
  x: number;
  y: number;
}

/** 座標が確定しているノードか(force-graph がレイアウト後に x/y を書き込む)。 */
export function isPositionedNode(node: GraphViewNode): node is PositionedGraphNode {
  const maybePositioned = node as Partial<PositionedGraphNode>;
  return typeof maybePositioned.x === "number" && typeof maybePositioned.y === "number";
}

export interface GraphPoint {
  x: number;
  y: number;
}

/** `measureText` だけを使うため、テストから差し替えやすいよう最小のインターフェースにする。 */
export type LabelMeasureContext = Pick<
  CanvasRenderingContext2D,
  "font" | "textAlign" | "textBaseline" | "measureText"
>;

/**
 * ラベル描画で使う `ctx.font` / `textAlign` / `textBaseline` の設定をまとめたヘルパー。
 * 表の描画(`nodeCanvasObject`)と判定用の描画(`nodePointerAreaPaint`)の両方で同じ
 * フォント設定を使うことで `labelPlateRect` の `measureText` 結果を一致させる。
 */
export function applyLabelFont(ctx: LabelMeasureContext, globalScale: number): void {
  const fontSize = LABEL_BASE_FONT_SIZE / globalScale;
  ctx.font = `${fontSize}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
}

/**
 * ラベル背景板の矩形(グラフ座標)。`ctx.font` を設定した後に呼ぶこと(`measureText` が
 * 現在のフォントで幅を測るため)。表の描画(`nodeCanvasObject`)と判定用の描画
 * (`nodePointerAreaPaint`)で同じ矩形を使い、見た目と当たり判定を一致させる。
 * 座標は `ctx.textBaseline = "top"` を前提にしている。
 */
export function labelPlateRect(
  ctx: LabelMeasureContext,
  node: PositionedGraphNode,
  globalScale: number,
): { x: number; y: number; width: number; height: number; labelY: number } {
  const fontSize = LABEL_BASE_FONT_SIZE / globalScale;
  const labelY = node.y + LABEL_OFFSET_Y / globalScale;
  const textWidth = ctx.measureText(node.label).width;
  return {
    x: node.x - textWidth / 2 - LABEL_PLATE_PADDING_X / globalScale,
    y: labelY - LABEL_PLATE_PADDING_TOP / globalScale,
    width: textWidth + (LABEL_PLATE_PADDING_X * 2) / globalScale,
    height: fontSize * LABEL_PLATE_HEIGHT_RATIO,
    labelY,
  };
}

/** 点と線分の距離。線分の外側では端点までの距離。 */
export function distanceToSegment(p: GraphPoint, a: GraphPoint, b: GraphPoint): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lengthSquared = abx * abx + aby * aby;
  if (lengthSquared === 0) {
    // 退化線分(a === b)は点との距離に等しい。
    return Math.hypot(p.x - a.x, p.y - a.y);
  }
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / lengthSquared));
  const closestX = a.x + t * abx;
  const closestY = a.y + t * aby;
  return Math.hypot(p.x - closestX, p.y - closestY);
}

/**
 * ノードのクリック判定半径(グラフ座標)。`nodePointerAreaPaint`(`NetworkCanvas.tsx` の
 * `paintPointerArea`)が判定キャンバスへ描く円と同じ式。
 */
export function nodeHitRadius(node: GraphViewNode, globalScale: number): number {
  return Math.max(
    Math.sqrt(1 + node.degree) * NODE_REL_SIZE,
    NODE_MIN_POINTER_RADIUS / globalScale,
  );
}

/**
 * 点に当たるノードを返す。後から描かれる(index が大きい)ノードが手前なので逆順に走査する。
 * 円 →(`globalScale ≥ LABEL_MIN_GLOBAL_SCALE` かつ `measureCtx` あり)ラベル背景板の矩形、
 * の順に判定する。座標未確定のノードは無視する。
 */
export function hitTestNodes(
  nodes: readonly GraphViewNode[],
  point: GraphPoint,
  globalScale: number,
  measureCtx: LabelMeasureContext | null,
): GraphViewNode | null {
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const node = nodes[i];
    if (!isPositionedNode(node)) {
      continue;
    }
    const radius = nodeHitRadius(node, globalScale);
    const distance = Math.hypot(point.x - node.x, point.y - node.y);
    if (distance <= radius) {
      return node;
    }
    if (globalScale >= LABEL_MIN_GLOBAL_SCALE && measureCtx) {
      applyLabelFont(measureCtx, globalScale);
      const rect = labelPlateRect(measureCtx, node, globalScale);
      if (
        point.x >= rect.x &&
        point.x <= rect.x + rect.width &&
        point.y >= rect.y &&
        point.y <= rect.y + rect.height
      ) {
        return node;
      }
    }
  }
  return null;
}

/**
 * 線のクリック判定の半幅(グラフ座標)。force-graph が判定キャンバスへ描く線幅
 * `(linkWidth + linkHoverPrecision) / globalScale`(+ アンチエイリアス分 2px)の半分と同じ。
 * `linkWidth` は `NetworkCanvas` の `1 + relatedness * 4` と同式。
 */
export function linkHitHalfWidth(link: GraphViewLink, globalScale: number): number {
  const linkWidth = 1 + link.relatedness * 4;
  return (linkWidth + LINK_HOVER_PRECISION) / 2 / globalScale + 1 / globalScale;
}

/**
 * 点に当たる線を返す(逆順走査)。両端が座標つきノードオブジェクトでない link(初回レイアウト
 * 前は文字列 ID)は無視する。直線のみ(`linkCurvature` は使っていない)。
 */
export function hitTestLinks(
  links: readonly GraphViewLink[],
  point: GraphPoint,
  globalScale: number,
): GraphViewLink | null {
  for (let i = links.length - 1; i >= 0; i -= 1) {
    const link = links[i];
    const source = link.source;
    const target = link.target;
    if (typeof source === "string" || typeof target === "string") {
      continue;
    }
    if (!isPositionedNode(source) || !isPositionedNode(target)) {
      continue;
    }
    const halfWidth = linkHitHalfWidth(link, globalScale);
    const distance = distanceToSegment(point, source, target);
    if (distance <= halfWidth) {
      return link;
    }
  }
  return null;
}
