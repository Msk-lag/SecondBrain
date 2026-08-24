import { Link } from "react-router";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  AdjacencyDirection,
  AdjacencyEdgeInfo,
  GraphAdjacency,
  GraphViewLink,
  GraphViewNode,
} from "@/features/graph/to-graph-data";
import { linkEndpointId } from "@/features/graph/to-graph-data";
import { useNoteImage, useNoteQuery } from "@/features/notes/api";
import {
  RELATION_DIRECTION_ROLE_LABELS,
  RELATION_TYPE_LABELS,
} from "@/features/notes/relation-labels";
import { getDisplayTitle } from "@/features/notes/utils";

/** キャンバス右側パネルの選択状態(M2-2 §設計決定5)。ノード選択とエッジ選択の2モード。 */
export type NetworkSelection =
  { type: "node"; nodeId: string } | { type: "edge"; link: GraphViewLink };

export interface NetworkSelectionPanelProps {
  selection: NetworkSelection | null;
  /** `graphData.nodes` を id で引けるようにしたもの(接続ノード名・エッジ両端名の表示用)。 */
  nodesById: ReadonlyMap<string, GraphViewNode>;
  adjacency: GraphAdjacency;
  /** 「接続ノード」項目クリック時に、そのノードを選択状態にする(§設計決定5)。 */
  onSelectNode: (nodeId: string) => void;
}

function formatRelatedness(relatedness: number): string {
  return `関連度 ${Math.round(relatedness * 100)}%`;
}

function nodeLabelOf(nodesById: ReadonlyMap<string, GraphViewNode>, nodeId: string): string {
  return nodesById.get(nodeId)?.label ?? "(不明なノート)";
}

/**
 * 接続ノード一覧の各項目(=隣接ノート)が、選択ノードから見た向き `direction` に応じて
 * どちらの役割を持つかを返す(Codex レビュー指摘・修正2)。`direction` が `"none"`、または
 * その関係種別が役割ラベルを持たない(`RELATION_DIRECTION_ROLE_LABELS` に項目が無い)ときは
 * `null`(バッジのみ表示)。
 *
 * エッジ選択時の表示(`sourceLabel(roleLabels.outgoing) → targetLabel(roleLabels.incoming)`)
 * と一貫させる: `direction === "outgoing"`(選択ノード→隣接)なら隣接は `incoming` 側の役割、
 * `direction === "incoming"`(隣接→選択ノード)なら隣接は `outgoing` 側の役割になる。
 */
function connectionRoleLabel(
  direction: AdjacencyDirection,
  relationType: AdjacencyEdgeInfo["relationType"],
): string | null {
  if (direction === "none") {
    return null;
  }
  const roleLabels = RELATION_DIRECTION_ROLE_LABELS[relationType];
  if (!roleLabels) {
    return null;
  }
  return direction === "outgoing" ? roleLabels.incoming : roleLabels.outgoing;
}

/**
 * スクリーンショットの元画像表示。`NoteDetailPage.tsx` の `ScreenshotImage` と同じ作り
 * (Skeleton → 画像 / 失敗時は再試行ボタン付き Alert)だが、あちらは export されておらず
 * `NoteDetailPage.tsx` を変更する権限も無いため、この画面専用に複製する(§厳守事項2・3)。
 * `useNoteImage` 自体は既存フックをそのまま再利用しており、詳細画面とキャッシュを共有する
 * ため追加リクエストは実質発生しない。
 */
function ScreenshotThumbnail({ nodeId }: Readonly<{ nodeId: string }>) {
  const { imageUrl, isLoading, isError, retry } = useNoteImage(nodeId);

  if (imageUrl) {
    return (
      <img
        src={imageUrl}
        alt="保存したスクリーンショット"
        className="w-full rounded-lg border border-border"
      />
    );
  }
  if (isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          <p>画像の取得に失敗しました。</p>
          <Button type="button" size="sm" variant="outline" className="mt-2" onClick={retry}>
            再試行
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  return <Skeleton className="h-40 w-full" aria-busy={isLoading} />;
}

function ConnectedNodesSection({
  nodeId,
  nodesById,
  adjacency,
  onSelectNode,
}: Readonly<{
  nodeId: string;
  nodesById: ReadonlyMap<string, GraphViewNode>;
  adjacency: GraphAdjacency;
  onSelectNode: (nodeId: string) => void;
}>) {
  // 追加リクエストなしで作る(§設計決定2・5。API から取得済みの graphData 由来)。
  const connections = adjacency.get(nodeId) ?? [];

  return (
    <section aria-label="接続ノード">
      <h4 className="mb-2 text-sm font-semibold text-ink-900">接続ノード({connections.length})</h4>
      {connections.length === 0 ? (
        <p className="text-sm text-ink-600">接続しているノートはありません。</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {connections.map(({ edge, otherNodeId, direction }) => {
            const roleLabel = connectionRoleLabel(direction, edge.relationType);
            return (
              <li key={edge.id}>
                <button
                  type="button"
                  onClick={() => onSelectNode(otherNodeId)}
                  className="block w-full rounded-lg border border-border px-3 py-2 text-left hover:bg-surface-muted"
                >
                  <div className="mb-1 flex flex-wrap items-center gap-1.5">
                    <Badge variant="gold">{RELATION_TYPE_LABELS[edge.relationType]}</Badge>
                    {roleLabel && <span className="text-xs text-ink-500">({roleLabel})</span>}
                  </div>
                  <p className="truncate text-sm font-medium text-ink-900">
                    {nodeLabelOf(nodesById, otherNodeId)}
                  </p>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * ノード選択時の表示(F-20「要約・種別に応じた内容・接続ノード」。§設計決定5)。
 * `useNoteQuery` / `useNoteImage` はいずれも既存フックの再利用で、詳細画面とキャッシュを
 * 共有するため追加リクエストは実質発生しない。
 */
function NodeSelectionContent({
  nodeId,
  nodesById,
  adjacency,
  onSelectNode,
}: Readonly<{
  nodeId: string;
  nodesById: ReadonlyMap<string, GraphViewNode>;
  adjacency: GraphAdjacency;
  onSelectNode: (nodeId: string) => void;
}>) {
  const noteQuery = useNoteQuery(nodeId);

  return (
    <div className="flex flex-col gap-4">
      {noteQuery.isLoading && (
        <div className="flex flex-col gap-2" aria-busy="true">
          <p className="sr-only">ノートを読み込み中…</p>
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}

      {!noteQuery.isLoading && noteQuery.isError && (
        <Alert variant="destructive">
          <AlertDescription>ノートの取得に失敗しました。</AlertDescription>
        </Alert>
      )}

      {!noteQuery.isLoading && !noteQuery.isError && noteQuery.data === null && (
        <p className="text-sm text-ink-600">このノートは削除されています。</p>
      )}

      {!noteQuery.isLoading && !noteQuery.isError && noteQuery.data && (
        <>
          <h3 className="text-base font-semibold text-ink-900">
            {getDisplayTitle(noteQuery.data)}
          </h3>

          {noteQuery.data.summary && (
            <p className="rounded-lg bg-surface-muted px-3 py-2 text-sm text-ink-700">
              {noteQuery.data.summary}
            </p>
          )}

          {/* 種別に応じた内容(スクショ=元スクショ、メモ・url=本文。§設計決定5)。 */}
          {noteQuery.data.type === "screenshot" ? (
            <ScreenshotThumbnail nodeId={nodeId} />
          ) : (
            noteQuery.data.body && (
              <p className="font-reading text-sm whitespace-pre-wrap text-ink-900">
                {noteQuery.data.body}
              </p>
            )
          )}

          <Button asChild size="sm" className="self-start">
            <Link to={`/notes/${nodeId}`}>詳細を開く</Link>
          </Button>
        </>
      )}

      <ConnectedNodesSection
        nodeId={nodeId}
        nodesById={nodesById}
        adjacency={adjacency}
        onSelectNode={onSelectNode}
      />
    </div>
  );
}

/**
 * エッジ選択時の表示(§設計決定5)。役割ラベル付きで向きを表示するのは
 * **`link.directed` かつ `RELATION_DIRECTION_ROLE_LABELS` に項目がある種類**のときのみ
 * (Codex レビュー指摘・修正1)。`directed === false` のエッジは、たとえ役割ラベルを持つ
 * 種類(`cause-solution` 等。向き無し/有りどちらも取り得る)であっても、保存データに
 * 存在しない向きをユーザーに提示しないよう両端名のみを表示する。`same-theme` / `other`
 * (契約上つねに `directed === false`)はそもそも役割ラベルを持たないため、この分岐に
 * 関わらず常に両端名のみになる。
 */
function EdgeSelectionContent({
  link,
  nodesById,
  onSelectNode,
}: Readonly<{
  link: GraphViewLink;
  nodesById: ReadonlyMap<string, GraphViewNode>;
  /** 「関係するノート」一覧の項目クリック時に、そのノートを選択状態にする(§設計決定3)。 */
  onSelectNode: (nodeId: string) => void;
}>) {
  // `link.source`/`link.target` は `react-force-graph` による破壊的書き換え後は
  // ノードオブジェクト参照になっているため、素で読まず必ず `linkEndpointId()` で
  // 正規化してから使う(§`to-graph-data.ts` の設計コメント参照)。
  const sourceId = linkEndpointId(link.source);
  const targetId = linkEndpointId(link.target);
  const sourceLabel = nodeLabelOf(nodesById, sourceId);
  const targetLabel = nodeLabelOf(nodesById, targetId);
  // `directed === false` のエッジは、役割ラベルを持つ種類(`cause-solution` 等)であっても
  // 保存データに存在しない向きをユーザーに提示しないため、ここで undefined へ畳んでおく
  // (Codex レビュー指摘・修正1 の判断を踏襲)。以降は `roleLabels` の有無だけで分岐でき、
  // 到達不能な分岐(`hasRoleLabels` が真なのに `roleLabels` が無い経路)が生まれない。
  const roleLabels = link.directed ? RELATION_DIRECTION_ROLE_LABELS[link.relationType] : undefined;

  // 「関係するノート」一覧の2項目(source → target の順)。役割ラベルは既存の向き表示と
  // 同じ規則(`roleLabels` が存在するときのみ)で付ける(§設計決定5)。
  //
  // `side` は React key 用(Codex レビュー指摘・LOW)。現在の DB スキーマでは
  // `note_a_id < note_b_id`(`packages/db/src/schema/note-relations.ts` の
  // `note_relations_note_a_id_lt_note_b_id` CHECK 制約。migration
  // `0006_add_note_relations.sql` L18 に生成済み)により source/target が同一ノートを
  // 指す自己ループは発生しないが、key をノート ID だけに依存させるとこの DB 制約が
  // 将来変わった場合に静かに壊れる(2項目が同じ key になり React の要素識別が不安定に
  // なる)。一覧内での位置(source 側 / target 側)は常に一意で安定しているため、
  // 分岐を増やさずに key へ含めておく。
  const relatedNoteEndpoints = [
    {
      side: "source",
      id: sourceId,
      label: sourceLabel,
      roleLabel: roleLabels?.outgoing ?? null,
    },
    {
      side: "target",
      id: targetId,
      label: targetLabel,
      roleLabel: roleLabels?.incoming ?? null,
    },
  ] as const;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="gold">{RELATION_TYPE_LABELS[link.relationType]}</Badge>
        <span className="text-xs text-ink-500">{formatRelatedness(link.relatedness)}</span>
      </div>

      <p className="text-sm text-ink-700">{link.description}</p>

      {roleLabels ? (
        // ラベルと役割ラベルを兄弟要素として分ける(入れ子にすると要素の textContent が
        // 結合されてしまい、spec からのテキスト検証がしづらくなるため)。
        // `data-testid` は、下の「関係するノート」一覧にも同じラベルが出るため
        // (spec が `within()` で表示領域を区別できるようにするための追加。見た目には影響しない)。
        <div
          data-testid="edge-endpoint-summary"
          className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-ink-900"
        >
          <span>{sourceLabel}</span>
          <span className="text-xs text-ink-500">({roleLabels.outgoing})</span>
          <span aria-hidden="true">→</span>
          <span>{targetLabel}</span>
          <span className="text-xs text-ink-500">({roleLabels.incoming})</span>
        </div>
      ) : (
        <p data-testid="edge-endpoint-summary" className="text-sm text-ink-900">
          {sourceLabel} ・ {targetLabel}
        </p>
      )}

      {/*
       * 「関係するノート」一覧(§設計決定5)。既存の表示(バッジ・説明・向き表示)の
       * 下に追記し、既存表示は変更しない。件数は常に2(このエッジの両端)。
       * マークアップ・className は `ConnectedNodesSection` を踏襲する。
       */}
      <section aria-label="関係するノート">
        <h4 className="mb-2 text-sm font-semibold text-ink-900">関係するノート(2)</h4>
        <ul className="flex flex-col gap-2">
          {relatedNoteEndpoints.map((endpoint) => {
            const isKnown = nodesById.has(endpoint.id);
            // ボタン/プレーン要素の両方で使い回す中身(重複を避けるため一度だけ組み立てる)。
            const itemContent = (
              <>
                <div className="mb-1 flex flex-wrap items-center gap-1.5">
                  {endpoint.roleLabel && (
                    <span className="text-xs text-ink-500">({endpoint.roleLabel})</span>
                  )}
                </div>
                <p className="truncate text-sm font-medium text-ink-900">{endpoint.label}</p>
              </>
            );
            return (
              <li key={`${endpoint.side}:${endpoint.id}`}>
                {isKnown ? (
                  <button
                    type="button"
                    onClick={() => onSelectNode(endpoint.id)}
                    className="block w-full rounded-lg border border-border px-3 py-2 text-left hover:bg-surface-muted"
                  >
                    {itemContent}
                  </button>
                ) : (
                  // 存在しないノート ID で onSelectNode を呼ぶと NetworkPage 側の
                  // resolvedSelection が nodesById.has() で弾いて選択解除になり、パネルが
                  // 初期表示へ戻ってしまう(決定4)。クリックしたのに情報が消える行き止まりを
                  // 避けるため、クリック不可のプレーンなテキスト項目として描画する。
                  <div className="block w-full rounded-lg border border-border px-3 py-2 text-left">
                    {itemContent}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

/**
 * キャンバス右側の選択パネル(M2-2 §設計決定5)。ノード選択・エッジ選択の2モードを
 * `selection` prop で切り替える(切り替え自体・背景クリックでの解除は呼び出し側の責務)。
 */
export function NetworkSelectionPanel({
  selection,
  nodesById,
  adjacency,
  onSelectNode,
}: Readonly<NetworkSelectionPanelProps>) {
  const title = (() => {
    if (selection?.type === "node") {
      return "ノートの詳細";
    }
    if (selection?.type === "edge") {
      return "関係の詳細";
    }
    return "詳細";
  })();

  return (
    <Card className="flex h-full flex-col">
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4 overflow-y-auto">
        {selection === null && (
          <p className="text-sm text-ink-600">ノードまたは関係線を選択すると詳細が表示されます。</p>
        )}
        {selection?.type === "node" && (
          <NodeSelectionContent
            nodeId={selection.nodeId}
            nodesById={nodesById}
            adjacency={adjacency}
            onSelectNode={onSelectNode}
          />
        )}
        {selection?.type === "edge" && (
          <EdgeSelectionContent
            link={selection.link}
            nodesById={nodesById}
            onSelectNode={onSelectNode}
          />
        )}
      </CardContent>
    </Card>
  );
}
