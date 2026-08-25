import { useCallback, useRef, type PointerEvent as ReactPointerEvent } from "react";
import ForceGraph2D, { type ForceGraphMethods } from "react-force-graph-2d";
import type { GraphViewData, GraphViewLink, GraphViewNode } from "@/features/graph/to-graph-data";
import { useElementSize } from "@/features/graph/use-element-size";
import {
  applyLabelFont,
  hitTestLinks,
  hitTestNodes,
  labelPlateRect,
  type LabelMeasureContext,
  type PositionedGraphNode,
} from "./network-canvas-hit-test";
import {
  BACKGROUND_CLICK_TOLERANCE_PX,
  DEGREE_ZERO_OPACITY,
  LABEL_MIN_GLOBAL_SCALE,
  LABEL_PLATE_COLOR,
  LINK_COLOR_BASE,
  LINK_HOVER_PRECISION,
  LINK_MIN_OPACITY,
  LINK_OPACITY_RANGE,
  NODE_LABEL_COLOR,
  NODE_MIN_POINTER_RADIUS,
  NODE_REL_SIZE,
  NODE_TYPE_COLORS,
  SELECTED_NODE_COLOR,
  hexToRgba,
} from "./network-canvas-theme";

// ラベル幅の計測専用 ctx(モジュールスコープで遅延生成・使い回す)。`document.createElement`
// はモジュール読み込み時ではなく初回使用時まで遅延させる(SSR 等 `document` が無い環境を
// 壊さないため)。jsdom など canvas 非対応環境では `getContext` が `null` を返すため、その
// 場合はラベル矩形の判定だけを省略する(円の判定は引き続き有効)。
let measureContext: LabelMeasureContext | null | undefined;
/** ラベル幅の計測専用 ctx。jsdom など canvas 非対応環境では null(ラベル矩形の判定だけ省略される)。 */
function getMeasureContext(): LabelMeasureContext | null {
  if (measureContext === undefined) {
    measureContext = document.createElement("canvas").getContext("2d");
  }
  return measureContext;
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
 *
 * **視認性・当たり判定の改善(2026-08-24)**: 次数の大きいノードの円が線を覆い、線を
 * 狙ってもノードが選ばれてしまう問題への対処として4点を変更した。(1) `linkHoverPrecision`
 * でエッジの当たり判定(シャドウキャンバス側)を広げる。(2) `linkColor` を明示し、
 * 既定のフォールバック色(淡すぎて見えない)ではなく `relatedness` に応じた濃淡を持つ
 * 基準色を返す(`linkWidth` と同じ「関連度が高いほど濃く太い」という意味づけ)。
 * (3) `nodeCanvasObject` にラベル背景板を追加し、線・円と重なっても文字が読めるようにする。
 * (4) `nodeRelSize` を既定値より小さくしてノード円を縮小し、線の露出を確保する。
 * `nodeRelSize` は `nodeVal` に依存しない共通の乗数なので、任意の2ノード間の半径比
 * (= 次数比の表現。F-20)は変えずに全体のスケールのみを縮小する。
 *
 * **背景クリックは force-graph に任せない(計画変更記録・2026-08-24)**: `onBackgroundClick`
 * を渡すと force-graph は押下中の pointermove を検出してクリックを破棄する経路を有効化し
 * (force-graph.js L12544 / L12577。`pointerType === 'mouse'` は移動量判定を短絡するため
 * 1px でも発動)、手ブレのあるマウス操作ではノード/線のクリックがほとんど発火しなくなる
 * (実ブラウザ計測: 2px 手ブレで 0/17 → 渡さなければ全件成功)。そのためラッパー `div` で
 * 押下→解放の移動量と、その間のノード/線クリックの有無から自前で判定する。
 *
 * **ラベル文字を押しても当たるようにする(2026-08-25)**: クリック判定は既定では円そのもの
 * のみで、次数0の円は半径 `√1 × NODE_REL_SIZE` = 画面上 5〜9px の極小の的になる。人は
 * 「丸+文字」を1つの的として文字を押すため、円の外側にある文字を押すと外れて背景クリック
 * (選択解除)として扱われる(実ブラウザ計測)。`nodePointerAreaPaint` で判定キャンバスに
 * だけ、画面px下限つきの円とラベル背景板の矩形を描き、文字を押しても当たるようにする
 * (見た目は不変)。
 *
 * **Brave のフィンガープリント対策への幾何フォールバック(2026-08-25)**: force-graph の
 * クリック判定は裏キャンバス(判定専用キャンバス)の画素色照合であり、Brave のフィンガー
 * プリント対策(`getImageData` の結果に混ぜられるノイズ)によって照合が一致せず失敗する
 * (実測: ヘッドレス Brave で 2/17、Chrome は 17/17)。force-graph の `onNodeClick`/
 * `onLinkClick` は引き続き渡し(Chrome 等では従来の画素判定経路が先に発火するため挙動は
 * 変わらない)、既存の「2 フレーム待って何も発火しなければ背景クリック」の判定を拡張し、
 * 背景と決める前にクリック位置をグラフ座標へ変換してノード → 線 → 背景の順に**幾何計算**
 * (画素読み取りに依存しない)で判定する。判定の幾何は `nodePointerAreaPaint`(円・ラベル
 * 矩形)/ force-graph の線幅と同じ式を `network-canvas-hit-test.ts` の純関数として共有する。
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

  // 左ボタン押下位置。解放時の移動量で「クリック」と「パン/ドラッグ」を分ける。
  const pointerDownRef = useRef<{ x: number; y: number } | null>(null);
  // 押下→解放の間にノード/線のクリックが force-graph から発火したか。
  const objectClickedRef = useRef(false);

  const handleNodeClick = (node: GraphViewNode, event: MouseEvent) => {
    objectClickedRef.current = true;
    onNodeClick(node, event);
  };

  const handleLinkClick = (link: GraphViewLink, event: MouseEvent) => {
    objectClickedRef.current = true;
    onLinkClick(link, event);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }
    pointerDownRef.current = { x: event.clientX, y: event.clientY };
    objectClickedRef.current = false;
  };

  // force-graph はこの prop の関数の同一性が変わるたびに判定キャンバスを即時再描画し、
  // スロットル中の後続再描画を打ち消す(= 判定が古い状態で固定されうる)。レンダーごとに
  // 新しい関数を渡さないよう useCallback で同一性を固定する(選択状態には依存しない)。
  const paintPointerArea = useCallback(
    (node: GraphViewNode, color: string, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const positioned = node as PositionedGraphNode;
      ctx.fillStyle = color;
      // (1) 円: 実半径(force-graph と同じ √(nodeVal) × nodeRelSize)と画面px下限の
      //     大きいほう。シャドウ側の nodeCanvasObjectMode は既定 "replace" なので円も
      //     自前で描く。
      const radius = Math.max(
        Math.sqrt(1 + node.degree) * NODE_REL_SIZE,
        NODE_MIN_POINTER_RADIUS / globalScale,
      );
      ctx.beginPath();
      ctx.arc(positioned.x, positioned.y, radius, 0, 2 * Math.PI, false);
      ctx.fill();
      // (2) ラベル背景板と同じ矩形(ラベルが表示される倍率のときだけ)。文字を押しても
      //     当たるようにする。
      if (globalScale < LABEL_MIN_GLOBAL_SCALE) {
        return;
      }
      applyLabelFont(ctx, globalScale);
      const rect = labelPlateRect(ctx, positioned, globalScale);
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    },
    [],
  );

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const down = pointerDownRef.current;
    pointerDownRef.current = null;
    if (!down || event.button !== 0) {
      return;
    }
    const distance = Math.hypot(event.clientX - down.x, event.clientY - down.y);
    if (distance > BACKGROUND_CLICK_TOLERANCE_PX) {
      return; // パン / ノードのドラッグ
    }
    const nativeEvent = event.nativeEvent;
    // クリック位置(ラッパー div 基準)。pointerup の同期実行中でないと `currentTarget` が
    // 取れないため、rAF で待つ前にここで確定させておく。
    const rect = event.currentTarget.getBoundingClientRect();
    const local = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    // force-graph はノード/線のクリックを pointerup の次の animation frame で発火する
    // (このラッパーは force-graph のコンテナの祖先なので、バブリング順で force-graph 側の
    // rAF が先に予約される)。その発火を待ってから「何も選ばれなかった」と判定するため
    // 2 フレーム待つ。
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (objectClickedRef.current) {
          return; // force-graph 側の画素判定が発火した(Chrome 等)。
        }
        // Brave 対策の幾何フォールバック(コンポーネント JSDoc 参照)。force-graph が何も
        // 発火しなかった場合に、クリック位置をグラフ座標へ変換しノード → 線 → 背景の順に
        // 幾何計算で判定する。
        const fg = fgRef.current;
        if (fg) {
          const point = fg.screen2GraphCoords(local.x, local.y);
          const k = fg.zoom();
          const node = hitTestNodes(graphData.nodes, point, k, getMeasureContext());
          if (node) {
            onNodeClick(node, nativeEvent);
            return;
          }
          const link = hitTestLinks(graphData.links, point, k);
          if (link) {
            onLinkClick(link, nativeEvent);
            return;
          }
        }
        onBackgroundClick(nativeEvent);
      });
    });
  };

  return (
    <div
      ref={ref}
      className="h-full w-full"
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
    >
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
            const positioned = node as PositionedGraphNode;
            applyLabelFont(ctx, globalScale);
            // 背景板の座標は `ctx.textBaseline = "top"` を前提にしている
            // (`fillText(label, x, labelY)` で文字の上端が `labelY` に来るため、板の上端も
            // `labelY` 基準で計算している)。`"top"` 以外に変えると板の上端計算が破綻する。
            const rect = labelPlateRect(ctx, positioned, globalScale);
            ctx.fillStyle = LABEL_PLATE_COLOR;
            ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
            // 背景板 → ラベルの順に描く(板がラベルを塗り潰さないため)。
            ctx.fillStyle = node.id === selectedNodeId ? SELECTED_NODE_COLOR : NODE_LABEL_COLOR;
            ctx.fillText(node.label, positioned.x, rect.labelY);
          }}
          linkWidth={(link) => 1 + link.relatedness * 4}
          linkDirectionalArrowLength={(link) => (link.directed ? 4 : 0)}
          linkColor={(link) =>
            hexToRgba(LINK_COLOR_BASE, LINK_MIN_OPACITY + link.relatedness * LINK_OPACITY_RANGE)
          }
          linkHoverPrecision={LINK_HOVER_PRECISION}
          nodeRelSize={NODE_REL_SIZE}
          nodePointerAreaPaint={paintPointerArea}
          onNodeClick={handleNodeClick}
          onLinkClick={handleLinkClick}
          onEngineStop={handleEngineStop}
        />
      )}
    </div>
  );
}
