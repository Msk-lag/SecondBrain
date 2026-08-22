import { useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Link } from "react-router";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useGraphQuery } from "@/features/graph/api";
import {
  toGraphData,
  type GraphAdjacency,
  type GraphViewData,
  type GraphViewLink,
  type GraphViewNode,
} from "@/features/graph/to-graph-data";
import { NetworkCanvas } from "./network/NetworkCanvas";
import { NetworkSelectionPanel, type NetworkSelection } from "./network/NetworkSelectionPanel";

/**
 * 選択状態を保持する内部表現(Codex レビュー指摘・修正1)。エッジ選択では
 * `GraphViewLink` オブジェクトそのものではなく **`id` のみ** を保持する。
 *
 * 理由: ポーリング(`processingNoteCount > 0` で3秒、0で30秒。`useGraphQuery` 側の設定)
 * により再取得は必ず起こりうる。エッジ選択中に再取得が走ると、`toGraphData` は
 * `graphData` を毎回新しいオブジェクトとして生成する(§`to-graph-data.ts` の設計)ため、
 * 古い `GraphViewLink` オブジェクトを持ち続けると (1) AI が関係の説明・関連度を更新して
 * いてもパネルが古い内容を表示し続ける (2) 関係が削除されていても存在しない関係が
 * 表示され続ける (3) `react-force-graph` は渡した link の `source`/`target` を文字列から
 * ノードオブジェクト参照へ書き換える(§設計決定2)ため、古い link オブジェクトを保持し
 * 続けると書き換え済みの参照を持ったまま新しい `graphData` と食い違う、という3つの
 * 問題が起きる。`id` だけを保持し、描画のたびに最新の `graphData.links` から解決する
 * ことでこれを避ける。ノード選択もノート削除時に同じ問題が起こりうるため、
 * 同じ考え方で `nodeId` を保持し最新の `graphData.nodes` から解決する。
 */
type SelectionState = { type: "node"; nodeId: string } | { type: "edge"; edgeId: string };

// `useGraphQuery` の初回取得が確定していない間・データ0件のノート0件表示用の空の
// graphData/adjacency(§設計決定6・M2-2 §設計決定2 の「新しいオブジェクトを生成する」
// 方針は維持しつつ、毎レンダー再生成しないよう module scope の定数として持つ)。
const EMPTY_GRAPH_DATA: GraphViewData = { nodes: [], links: [] };
const EMPTY_ADJACENCY: GraphAdjacency = new Map();

/**
 * `/network`(F-20 本体。M2-2 §実装手順6)。
 *
 * **表示制御(§設計決定3)**: 既定で全ノードを表示し、「関係のあるノートのみ表示」トグルで
 * 次数 ≥ 1 へ**クライアント側で**絞り込む(トグル時に再取得しない)。件数は常に
 * `表示 N / 全 M ノート` の形式で表示する。空状態は「全ノート0件」のみで、
 * 「ノートはあるが関係0件」は通常どおりグラフを描く(専用の空状態は作らない)。
 *
 * **取得中・取得失敗(§設計決定6)**: 初回取得中(`data === undefined` かつ `isPending`)は
 * Skeleton。取得失敗時、キャッシュ済みの `data` が無ければエラー Alert + 再試行、
 * `data` があれば描画を維持したまま上部に警告のみを出す。表示条件はすべて
 * `data !== undefined` を基準に組み、`isError` 単独では描画を落とさない。
 */
export function NetworkPage() {
  const graphQuery = useGraphQuery();
  const [onlyConnected, setOnlyConnected] = useState(false);
  const [selection, setSelection] = useState<SelectionState | null>(null);

  const data = graphQuery.data;

  const { graphData, adjacency } = useMemo(() => {
    if (!data) {
      return { graphData: EMPTY_GRAPH_DATA, adjacency: EMPTY_ADJACENCY };
    }
    return toGraphData(data);
  }, [data]);

  const nodesById = useMemo(
    () => new Map(graphData.nodes.map((node) => [node.id, node] as const)),
    [graphData.nodes],
  );

  // 選択状態を最新の `graphData` から都度解決する(Codex レビュー指摘・修正1)。
  // ノード選択: `nodesById`(= 最新の `graphData.nodes`)に無ければ選択解除(ノート削除時)。
  // エッジ選択: 最新の `graphData.links` から `edgeId` で探し、無ければ選択解除
  // (関係の削除時。見つかった場合は `NetworkSelectionPanel` へ渡す最新の `link` を都度
  // 組み立てる — 上の `SelectionState` コメントのとおり、古いオブジェクトは保持しない)。
  // 描画のたびに(`useMemo` で)解決するだけで済ませ、`selection` state 自体を
  // 書き換えないため、無効な選択が生きたまま残っても次に有効な `graphData` が来れば
  // 自然に復元される、という副作用も生まない(常に最新の graphData を基準に導出する)。
  const resolvedSelection = useMemo<NetworkSelection | null>(() => {
    if (!selection) {
      return null;
    }
    if (selection.type === "node") {
      return nodesById.has(selection.nodeId) ? selection : null;
    }
    const link = graphData.links.find((candidate) => candidate.id === selection.edgeId);
    return link ? { type: "edge", link } : null;
  }, [selection, nodesById, graphData.links]);

  // 「関係のあるノートのみ表示」トグル(§設計決定3)。次数0のノードを除外する。
  // API への再取得は行わない(クライアント側の絞り込み)。
  //
  // **エッジ側は絞り込み不要**: `degree`(§設計決定2)は「返した edges から数えた接続数」
  // であり、あるノードが degree ≥ 1 であることと「そのノードを端点に持つエッジが
  // 存在すること」は同値になるよう定義されている。したがって `links` の各要素の
  // 両端点は、このトグルによる絞り込み後も常にどちらも degree ≥ 1(= 表示対象)であり、
  // 絞り込みで消えたノードを端点に持つエッジは存在しえない。エッジ側にも同じ絞り込みを
  // 掛けると、実データでは絶対に false にならない条件分岐(到達不能なコード)を
  // 作ってしまう(差分カバレッジ100%要件と相性が悪い)ため、あえて行わない。
  const visibleNodes = useMemo(
    () => (onlyConnected ? graphData.nodes.filter((node) => node.degree >= 1) : graphData.nodes),
    [graphData.nodes, onlyConnected],
  );
  const visibleGraphData = useMemo<GraphViewData>(
    () => ({ nodes: visibleNodes, links: graphData.links }),
    [visibleNodes, graphData.links],
  );

  const handleNodeClick = (node: GraphViewNode) => setSelection({ type: "node", nodeId: node.id });
  const handleLinkClick = (link: GraphViewLink) => setSelection({ type: "edge", edgeId: link.id });
  const handleBackgroundClick = () => setSelection(null);
  const handleSelectNode = (nodeId: string) => setSelection({ type: "node", nodeId });

  // 初回取得中(§設計決定6)。空状態(ノート0件)と取り違えないよう `data === undefined` を
  // 明示条件にする(ノート0件の応答が返った時点で isPending は既に false になる)。
  if (data === undefined && graphQuery.isPending) {
    return (
      <div className="flex h-full flex-col gap-4 p-6">
        <h1 className="text-2xl font-semibold text-ink-900">ネットワーク</h1>
        <Skeleton className="h-full min-h-80 w-full flex-1" aria-busy="true" />
      </div>
    );
  }

  // 取得失敗・キャッシュ無し: エラー Alert + 再試行(§設計決定6)。
  if (data === undefined && graphQuery.isError) {
    return (
      <div className="flex h-full flex-col gap-4 p-6">
        <h1 className="text-2xl font-semibold text-ink-900">ネットワーク</h1>
        <Alert variant="destructive">
          <AlertDescription>
            <p>ネットワークの取得に失敗しました。</p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="mt-2"
              onClick={() => void graphQuery.refetch()}
            >
              再試行
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  // ここから先は `data !== undefined` を前提に組む(§設計決定6)。`data` を直接条件にせず
  // 常に optional chaining で参照するのは、取得失敗直後で TypeScript 上は narrow できない
  // 一瞬(isPending/isError どちらでもない理論上の遷移中)にも安全に描けるようにするため。
  const truncated = data?.truncated;
  const isTruncated = Boolean(truncated?.nodes || truncated?.edges);
  const processingNoteCount = data?.processingNoteCount ?? 0;

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-ink-900">ネットワーク</h1>
        <div className="flex flex-wrap items-center gap-4">
          <p className="text-sm text-ink-600" aria-live="polite">
            表示 {visibleNodes.length} / 全 {graphData.nodes.length} ノート
          </p>
          <div className="flex items-center gap-2">
            <input
              id="network-only-connected-toggle"
              type="checkbox"
              checked={onlyConnected}
              onChange={(event) => setOnlyConnected(event.target.checked)}
              className="size-4 rounded border-border"
            />
            <Label htmlFor="network-only-connected-toggle" className="text-ink-700">
              関係のあるノートのみ表示
            </Label>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void graphQuery.refetch()}
          >
            <RefreshCw className="size-4" />
            更新
          </Button>
        </div>
      </div>

      {/* キャッシュ有りでの取得失敗: 描画は維持し、上部に警告のみを出す(§設計決定6)。 */}
      {graphQuery.isError && (
        <Alert variant="destructive">
          <AlertDescription>
            最新の取得に失敗しました。表示中の内容は前回取得できたものです。
          </AlertDescription>
        </Alert>
      )}

      {isTruncated && (
        <Alert>
          <AlertDescription>
            表示件数が上限に達したため、一部のノートまたは関係が表示されていません。
          </AlertDescription>
        </Alert>
      )}

      {processingNoteCount > 0 && (
        <p className="text-sm text-ink-600">AI が新しい関係を判定中です({processingNoteCount}件)</p>
      )}

      {graphData.nodes.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border py-16 text-center">
          <p className="text-sm text-ink-600">まだノートがありません。</p>
          <Button asChild>
            <Link to="/save">最初のノートを保存する</Link>
          </Button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 gap-4">
          <div className="min-h-0 min-w-0 flex-1 rounded-lg border border-border bg-surface">
            <NetworkCanvas
              graphData={visibleGraphData}
              selectedNodeId={resolvedSelection?.type === "node" ? resolvedSelection.nodeId : null}
              onNodeClick={handleNodeClick}
              onLinkClick={handleLinkClick}
              onBackgroundClick={handleBackgroundClick}
            />
          </div>
          <div className="w-80 shrink-0">
            <NetworkSelectionPanel
              selection={resolvedSelection}
              nodesById={nodesById}
              adjacency={adjacency}
              onSelectNode={handleSelectNode}
            />
          </div>
        </div>
      )}
    </div>
  );
}
