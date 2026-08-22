import { useRef } from "react";
import ForceGraph2D, { type ForceGraphMethods } from "react-force-graph-2d";
import type { GraphViewData, GraphViewLink, GraphViewNode } from "@/features/graph/to-graph-data";
import { useElementSize } from "@/features/graph/use-element-size";
import {
  DEGREE_ZERO_OPACITY,
  LABEL_BASE_FONT_SIZE,
  LABEL_MIN_GLOBAL_SCALE,
  LABEL_OFFSET_Y,
  NODE_LABEL_COLOR,
  NODE_TYPE_COLORS,
  SELECTED_NODE_COLOR,
  hexToRgba,
} from "./network-canvas-theme";

/**
 * `nodeCanvasObject` 呼び出し時点(force-graph がレイアウトを確定させた後)は `x`/`y` が
 * 必ず数値で埋まっている。型上は optional なままの `GraphViewNode` を、キャンバス描画に
 * 必要な座標つきの形へ絞り込むための内部型(不要な undefined ガード分岐を作らないため)。
 */
interface PositionedGraphNode extends GraphViewNode {
  x: number;
  y: number;
}

export interface NetworkCanvasProps {
  graphData: GraphViewData;
  selectedNodeId: string | null;
  onNodeClick: (node: GraphViewNode, event: MouseEvent) => void;
  onLinkClick: (link: GraphViewLink, event: MouseEvent) => void;
  onBackgroundClick: (event: MouseEvent) => void;
}

/**
 * `ForceGraph2D` を使う唯一のコンポーネント(M2-2 §設計決定7)。**他のどこからも
 * `react-force-graph-2d` を import しないこと** — 3D 昇格時はこのファイルの差し替えだけで
 * 済む構造にするための境界。
 *
 * アクセサ props は §設計決定4 の表のとおりに実装する(F-20 の必須条件。値を勝手に変えない):
 * ノードサイズ=接続数(`nodeVal`)/ 線の太さ=関連度(`linkWidth`)/ 向き
 * (`linkDirectionalArrowLength`)/ ノードの色(種別固定色 + 選択強調 + 次数0の減衰)/
 * ラベル(`nodeCanvasObjectMode` + `nodeCanvasObject`。既定の円の後に描画し、円は自前で
 * 描き直さない)。`cooldownTicks` は既定のまま渡さない。
 *
 * **自動フィット(Codex レビュー指摘・追加2)**: `react-force-graph` はレイアウト収束後に
 * 自動でズーム/パンしないため、既定表示だとグラフがキャンバスの一部にしか広がらず、
 * ノードが密集してラベルが重なる。`onEngineStop`(収束時に呼ばれる)で `zoomToFit` を
 * 呼び、初回収束時のみキャンバス全体へフィットさせる(詳細は各 ref/フラグのコメント参照)。
 */
export function NetworkCanvas({
  graphData,
  selectedNodeId,
  onNodeClick,
  onLinkClick,
  onBackgroundClick,
}: Readonly<NetworkCanvasProps>) {
  const { ref, size } = useElementSize<HTMLDivElement>();
  // 計測値0(初回レンダー・jsdom には ResizeObserver が無くスタブが呼ばれない)のときは
  // キャンバスを描画せず、サイズが確定してから描く(§設計決定7)。
  const canDraw = size.width > 0 && size.height > 0;

  // `zoomToFit` を呼ぶための `ForceGraph2D` インスタンス参照(Codex レビュー指摘・追加2)。
  const fgRef = useRef<ForceGraphMethods<GraphViewNode, GraphViewLink> | undefined>(undefined);
  // 初回のレイアウト収束時のみフィットしたかどうかのフラグ。`onEngineStop` はポーリングに
  // よる `graphData` 更新で再レイアウトが走るたびに呼ばれる。フラグ無しで毎回 `zoomToFit`
  // すると、利用者が手動でズーム/パンした直後の再取得で視点が強制的に戻ってしまうため、
  // このコンポーネントインスタンスが生きている間は初回の1回だけに限定する。
  const hasFittedRef = useRef(false);

  const handleEngineStop = () => {
    // ノード0件のときは `zoomToFit` の対象が無い(空グラフでの誤動作防止)。
    if (hasFittedRef.current || graphData.nodes.length === 0) {
      return;
    }
    hasFittedRef.current = true;
    // duration=400ms: 一瞬で切り替わるのではなく視点の移動が視認できる程度の短いアニメー
    // ション。padding=40px: 余白を0にすると端のノードのラベル(円の外側に描画される)が
    // キャンバス端で切れてしまうため、ラベル文字が収まる程度の余白を確保する。
    fgRef.current?.zoomToFit(400, 40);
  };

  return (
    <div ref={ref} className="h-full w-full">
      {canDraw && (
        <ForceGraph2D<GraphViewNode, GraphViewLink>
          ref={fgRef}
          graphData={graphData}
          width={size.width}
          height={size.height}
          nodeVal={(node) => 1 + node.degree}
          nodeColor={(node) => {
            if (node.id === selectedNodeId) {
              return SELECTED_NODE_COLOR;
            }
            const baseColor = NODE_TYPE_COLORS[node.type];
            return node.degree === 0 ? hexToRgba(baseColor, DEGREE_ZERO_OPACITY) : baseColor;
          }}
          nodeCanvasObjectMode={() => "after"}
          nodeCanvasObject={(node, ctx, globalScale) => {
            if (globalScale < LABEL_MIN_GLOBAL_SCALE) {
              return;
            }
            const { x, y } = node as PositionedGraphNode;
            const fontSize = LABEL_BASE_FONT_SIZE / globalScale;
            ctx.font = `${fontSize}px sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            ctx.fillStyle = node.id === selectedNodeId ? SELECTED_NODE_COLOR : NODE_LABEL_COLOR;
            ctx.fillText(node.label, x, y + LABEL_OFFSET_Y / globalScale);
          }}
          linkWidth={(link) => 1 + link.relatedness * 4}
          linkDirectionalArrowLength={(link) => (link.directed ? 4 : 0)}
          onNodeClick={onNodeClick}
          onLinkClick={onLinkClick}
          onBackgroundClick={onBackgroundClick}
          onEngineStop={handleEngineStop}
        />
      )}
    </div>
  );
}
