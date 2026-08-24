import type { GraphResponse, NoteRelationType, NoteType } from "@secondbrain/shared";
import { getDisplayTitle } from "@/features/notes/utils";

/**
 * `ForceGraph2D` へ渡すノード1件。`degree`(接続数)は API から返らないため
 * `edges` から算出する(M2-1 §設計決定5・M2-2 §設計決定2)。
 */
export interface GraphViewNode {
  id: string;
  label: string;
  type: NoteType;
  degree: number;
}

/**
 * `ForceGraph2D` へ渡すエッジ1件。API レスポンスのオブジェクトをそのまま流用せず、
 * 必ず新しいオブジェクトとして生成する(§下記コメント参照)。
 */
export interface GraphViewLink {
  id: string;
  /**
   * 初回描画前は文字列(ノート ID)。`react-force-graph` が `d3-force` へ渡した後、
   * この値は破壊的に `GraphViewNode` オブジェクト参照へ書き換わる(§下記 `toGraphData`
   * の JSDoc)。読むときは必ず {@link linkEndpointId} を通すこと。
   */
  source: string | GraphViewNode;
  /** {@link GraphViewLink.source} と同じ注意点。必ず {@link linkEndpointId} を通すこと。 */
  target: string | GraphViewNode;
  directed: boolean;
  relationType: NoteRelationType;
  description: string;
  relatedness: number;
}

/**
 * `GraphViewLink.source`/`target` の端点 ID を正規化して取得する。
 * 文字列(初回描画前)ならそのまま返し、`react-force-graph` による破壊的書き換え後の
 * ノードオブジェクトなら `.id` を返す。`link.source`/`link.target` を直接読む代わりに
 * 必ずこの関数を通すこと(§下記 `toGraphData` の JSDoc)。
 */
export function linkEndpointId(endpoint: string | GraphViewNode): string {
  return typeof endpoint === "string" ? endpoint : endpoint.id;
}

export interface GraphViewData {
  nodes: GraphViewNode[];
  links: GraphViewLink[];
}

/** 選択パネルの「接続ノード」表示に使う、あるエッジのもう一方の端点から見た情報。 */
export interface AdjacencyEdgeInfo {
  id: string;
  directed: boolean;
  relationType: NoteRelationType;
  description: string;
  relatedness: number;
}

/**
 * このエントリを持つノード(選択ノード)から見た、エッジの向き。
 * `"outgoing"` は選択ノード→相手、`"incoming"` は相手→選択ノード、`"none"` は無向
 * (`edge.directed === false`)を表す。`edge.source`/`edge.target` をそのまま
 * `adjacency` へコピーしない代わりに、選択ノード視点へ畳んだこの値を持たせる
 * (§下記コメント参照。`links` とのオブジェクト共有を避けるため)。
 */
export type AdjacencyDirection = "outgoing" | "incoming" | "none";

export interface AdjacencyEntry {
  edge: AdjacencyEdgeInfo;
  otherNodeId: string;
  // `toGraphData` は必ずこの値を設定する(必須。Codex レビュー指摘・修正2で必須化)。
  direction: AdjacencyDirection;
}

export type GraphAdjacency = Map<string, AdjacencyEntry[]>;

export interface ToGraphDataResult {
  graphData: GraphViewData;
  adjacency: GraphAdjacency;
}

/**
 * `GET /graph` のレスポンスを `ForceGraph2D` 用の `graphData` と、選択パネル用の
 * `adjacency` へ変換する純関数(M2-2 §設計決定2)。
 *
 * **`react-force-graph` は渡された `graphData` を破壊的に変更する**(`force-graph` が
 * 内部で `d3-force` へ渡す際、link の `source`/`target` を文字列からノードオブジェクト
 * 参照へ書き換え、node に `x`/`y`/`vx`/`vy`/`index` を追加する)。そのため:
 *
 * 1. API レスポンス(TanStack Query のキャッシュが保持するオブジェクト)をそのまま
 *    `graphData` として渡してはならない。この関数は常に新しいオブジェクトを生成する。
 * 2. `adjacency` は `graphData.links` と同一のオブジェクトを参照してはならない。
 *    同じオブジェクトを持つと、ライブラリによる破壊的変更が選択パネル側へ漏れ、
 *    パネルが表示する両端 ID が壊れる。`adjacency` の各エントリの `edge` は
 *    `links` の要素とは別オブジェクトとして生成し、ライブラリへ渡す `links` とは
 *    ライフサイクルを完全に分ける。この理由により、`edge.source`/`edge.target`
 *    (文字列)をそのまま `adjacency` エントリへコピーすることもしない
 *    (`react-force-graph` が書き換えるのは `links` 側のオブジェクトのみだが、
 *    将来 `adjacency` のエントリが `links` の要素を参照するよう書き換えられる
 *    誘因を残さないため)。選択ノードから見た向きは `AdjacencyEntry.direction`
 *    (`"outgoing"`/`"incoming"`/`"none"`)へ畳み込んで持たせる。
 *
 * この罠は `adjacency` 側では上記のとおり守られていたが、**エッジ選択パネルの経路
 * (`NetworkSelectionPanel.tsx` の `EdgeSelectionContent` が `link.source`/`link.target`
 * を直接読む箇所)だけが漏れていた**(2026-08-24 に両端ノート名が常に
 * `(不明なノート)` になる表示バグとして顕在化)。原因は `GraphViewLink.source`/`target`
 * の型が `string` のままで実行時の実態(書き換え後はオブジェクト)と食い違っており、
 * コンパイラが検知できなかったことにある。型を `string | GraphViewNode` に正直化した
 * 上で、`links` の端点を読むときは必ず {@link linkEndpointId} を通すこと。
 */
export function toGraphData(response: GraphResponse): ToGraphDataResult {
  const degreeByNodeId = new Map<string, number>();
  for (const edge of response.edges) {
    degreeByNodeId.set(edge.source, (degreeByNodeId.get(edge.source) ?? 0) + 1);
    degreeByNodeId.set(edge.target, (degreeByNodeId.get(edge.target) ?? 0) + 1);
  }

  const nodes: GraphViewNode[] = response.nodes.map((node) => ({
    id: node.id,
    label: getDisplayTitle({ title: node.title, body: node.bodyPreview }),
    type: node.type,
    degree: degreeByNodeId.get(node.id) ?? 0,
  }));

  const links: GraphViewLink[] = response.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    directed: edge.directed,
    relationType: edge.relationType,
    description: edge.description,
    relatedness: edge.relatedness,
  }));

  const adjacency: GraphAdjacency = new Map();
  const addAdjacency = (nodeId: string, entry: AdjacencyEntry) => {
    const existing = adjacency.get(nodeId);
    if (existing) {
      existing.push(entry);
    } else {
      adjacency.set(nodeId, [entry]);
    }
  };
  for (const edge of response.edges) {
    // `links` の要素とは別オブジェクトを都度生成する(§上記コメント2)。source 側・
    // target 側それぞれにも独立したコピーを持たせ、adjacency のエントリ同士でも
    // オブジェクトを共有しない。
    const edgeInfo: AdjacencyEdgeInfo = {
      id: edge.id,
      directed: edge.directed,
      relationType: edge.relationType,
      description: edge.description,
      relatedness: edge.relatedness,
    };
    // 無向エッジは常に "none"。有向エッジは source 側が "outgoing"(選択ノード→相手)、
    // target 側が "incoming"(相手→選択ノード)と、互いに反対の向きになる。
    const sourceDirection: AdjacencyDirection = edge.directed ? "outgoing" : "none";
    const targetDirection: AdjacencyDirection = edge.directed ? "incoming" : "none";
    addAdjacency(edge.source, {
      edge: { ...edgeInfo },
      otherNodeId: edge.target,
      direction: sourceDirection,
    });
    addAdjacency(edge.target, {
      edge: { ...edgeInfo },
      otherNodeId: edge.source,
      direction: targetDirection,
    });
  }

  return { graphData: { nodes, links }, adjacency };
}
