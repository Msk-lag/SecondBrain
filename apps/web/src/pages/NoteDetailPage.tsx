import { Pencil, Trash2 } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import type {
  NoteRelationType,
  RelationItem,
  RelationStatus,
  RelationTypeDirection,
} from "@secondbrain/shared";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import {
  useNoteImage,
  useNoteQuery,
  useRelatedNotesQuery,
  useRetryNoteMutation,
} from "@/features/notes/api";
import { getDisplayTitle } from "@/features/notes/utils";

/**
 * `relationType`(7値固定語彙。M1-4b §設計決定1 参照)の日本語表示ラベル。
 * `satisfies Record<NoteRelationType, string>` により、契約側の語彙が増減した場合に
 * ここの網羅漏れをコンパイルエラーで検知できるようにしている。
 */
const RELATION_TYPE_LABELS = {
  "same-theme": "同じテーマ",
  "cause-solution": "原因と解決策",
  "claim-counter": "主張と反論",
  "concept-hierarchy": "上位/下位概念",
  "tech-example": "技術と具体例",
  "problem-remedy": "問題と対処法",
  other: "その他の関係",
} satisfies Record<NoteRelationType, string>;

/**
 * `typeDirection` が `outgoing`/`incoming` のとき、詳細画面のノートが種類の左項・右項の
 * どちらの役割かを表す短いラベル(契約 `relationTypeDirectionSchema` のコメント参照。
 * `outgoing` = このノートが種類の左項)。`same-theme`/`other` は契約上 `typeDirection` が
 * 常に `none` になるため、ここに項目を持たない(=向き自体を表示しない)。
 */
const RELATION_DIRECTION_ROLE_LABELS: Partial<
  Record<NoteRelationType, Record<"outgoing" | "incoming", string>>
> = {
  "cause-solution": { outgoing: "原因", incoming: "解決策" },
  "claim-counter": { outgoing: "主張", incoming: "反論" },
  "concept-hierarchy": { outgoing: "上位概念", incoming: "下位概念" },
  "tech-example": { outgoing: "技術", incoming: "具体例" },
  "problem-remedy": { outgoing: "問題", incoming: "対処法" },
};

function formatRelatedness(relatedness: number): string {
  return `関連度 ${Math.round(relatedness * 100)}%`;
}

function RelationDirectionLabel({
  type,
  direction,
}: Readonly<{ type: NoteRelationType; direction: RelationTypeDirection }>) {
  // none のときは向きを出さない(指示 (b) 参照)。
  if (direction === "none") {
    return null;
  }
  const roleLabel = RELATION_DIRECTION_ROLE_LABELS[type]?.[direction];
  if (!roleLabel) {
    return null;
  }
  return <span className="text-xs text-ink-500">({roleLabel})</span>;
}

function RelationListItem({ item }: Readonly<{ item: RelationItem }>) {
  return (
    <li>
      <Link
        to={`/notes/${item.id}`}
        className="block rounded-lg border border-border px-3 py-2 hover:bg-surface-muted"
      >
        <div className="mb-1 flex flex-wrap items-center gap-1.5">
          <Badge variant="gold">{RELATION_TYPE_LABELS[item.relationType]}</Badge>
          <RelationDirectionLabel type={item.relationType} direction={item.typeDirection} />
          <span className="text-xs text-ink-500">{formatRelatedness(item.relatedness)}</span>
        </div>
        <p className="truncate text-sm font-medium text-ink-900">
          {getDisplayTitle({ title: item.title, body: item.excerpt })}
        </p>
        <p className="mt-0.5 text-xs text-ink-600">{item.description}</p>
      </Link>
    </li>
  );
}

function formatSavedAt(iso: string): string {
  return new Date(iso).toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function ScreenshotImage({
  imageUrl,
  isError,
  isLoading,
  onRetry,
}: Readonly<{
  imageUrl: string | null;
  isError: boolean;
  isLoading: boolean;
  onRetry: () => void;
}>) {
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
          {/* 502/504等の一時的な障害から画面を開き直さずに回復できるようにする
              (Codex コードレビュー 2026-07-13 r6 指摘 [A-3] への対応)。 */}
          <Button type="button" size="sm" variant="outline" className="mt-2" onClick={onRetry}>
            再試行
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  return <Skeleton className="h-64 w-full" aria-busy={isLoading} />;
}

/**
 * `relationStatus`(M1-4b §設計決定10 の7規則を要約したアプリケーション概念。
 * `RelationStatus` 参照)+ relations 件数から、関係あり群に出す文言を決める。
 *
 * - `generating` かつ relations 非空: 「前回の結果」であることを必ず UI で表現する
 *   (計画 §設計決定11「Codex の条件を満たすための必須要件」)。表現しないなら relations も
 *   空にすべき、という誠実さの原則に対応するための文言。
 * - `generating` かつ relations 空: まだ一度も確定結果が無い判定中。
 * - `failed`: 現在の内容に対する判定が失敗(古い relations があれば単調追加規則により
 *   そのまま残り続けるので、リストは別途そのまま表示する)。
 * - `not_started`: 関係群自体を出さない(呼び出し側で判定。ここでは null を返す)。
 * - `ready` かつ relations 空: 確定的に0件。
 * - `ready` かつ relations 非空: 文言不要(リストのみで十分)。
 */
function getRelationStatusMessage(
  relationStatus: RelationStatus | undefined,
  relationsCount: number,
): string | null {
  switch (relationStatus) {
    case "generating":
      return relationsCount > 0 ? "関係を更新中です(表示は前回の結果です)" : "関係を判定中です";
    case "failed":
      return "関係の判定に失敗しました";
    case "ready":
      return relationsCount === 0 ? "関係のあるノートは見つかりませんでした" : null;
    case "not_started":
    default:
      return null;
  }
}

/**
 * 詳細画面の「関連ノート」セクション(M1-4a §設計決定3・M1-4b §設計決定10・11 参照)。
 * 「関係あり」群(種類バッジ+説明文+関連度。永続化された確定エッジ)と「類似」群
 * (embedding 距離ベースの候補)を視覚的に区別して表示する。取得失敗はセクション内で
 * 完結させ、ノート本体の閲覧を妨げない(§ テスト観点 参照)。
 *
 * 2群は互いに独立した状態遷移を持つ(relationStatusSchema のコメント参照)ため、
 * ローディング・生成中・失敗の表示条件をそれぞれ個別に判定する。特に「関係あり」群は
 * `relationStatus`(埋め込みの `status` とは別のアプリケーション概念)で出し分け、
 * `status`(埋め込み・類似検索)が generating/failed でも relations 自体は API 契約上
 * 常に返るため、`status` では条件分岐しない(§設計決定10)。
 */
function RelatedNotesSection({ noteId }: Readonly<{ noteId: string }>) {
  const relatedNotesQuery = useRelatedNotesQuery(noteId);
  const data = relatedNotesQuery.data;
  const status = data?.status;
  const relationStatus = data?.relationStatus;
  const relations = data?.relations ?? [];
  const similar = data?.similar ?? [];

  const relationStatusMessage = getRelationStatusMessage(relationStatus, relations.length);
  // not_started かつ relations が空(M1-4a 期の既存ノートの既定状態)のときだけ、
  // 「関係あり」群そのものを出さない(指示 (c) 参照)。
  const showRelationsGroup = relations.length > 0 || relationStatusMessage !== null;

  return (
    <Card className="mt-8">
      <CardHeader>
        <CardTitle className="text-base">関連ノート</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {relatedNotesQuery.isLoading && (
          <div className="flex flex-col gap-2" aria-busy="true">
            <p className="sr-only">関連ノートを読み込み中…</p>
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        )}

        {relatedNotesQuery.isError && (
          <p className="text-sm text-ink-600">類似ノートの取得に失敗しました。</p>
        )}

        {/* 表示条件を `!isError` ではなく「data があるか」で判定する(Codex D0 レビュー
            MEDIUM 指摘対応)。TanStack Query は**バックグラウンド再取得が失敗しても直前の
            `data` を保持したまま `isError` を立てる**ため、`!isError` で囲むと一時的な通信
            障害だけで、永続化済みの関係も直前まで見えていた類似候補も画面から消える。
            `relationStatus === 'generating'` の間は3秒間隔でポーリングしており、これは
            まさに relations を「前回の結果」として見せている状態(§設計決定11)なので、
            この経路を踏む確率が低くない。
            初回取得に失敗して `data` がまだ無い場合は、上のエラー文言だけを出す。 */}
        {!relatedNotesQuery.isLoading && data !== undefined && (
          <>
            {showRelationsGroup && (
              <section aria-label="関係のあるノート">
                <h3 className="mb-2 text-sm font-semibold text-ink-900">関係のあるノート</h3>
                {relationStatusMessage && (
                  <p role="status" className="mb-2 text-sm text-ink-600">
                    {relationStatusMessage}
                  </p>
                )}
                {relations.length > 0 && (
                  <ul className="flex flex-col gap-2">
                    {relations.map((item) => (
                      <RelationListItem key={item.id} item={item} />
                    ))}
                  </ul>
                )}
              </section>
            )}

            <section aria-label="類似ノート">
              <h3 className="mb-2 text-sm font-semibold text-ink-900">類似ノート</h3>

              {status === "generating" && (
                <div className="flex flex-col gap-2" aria-busy="true">
                  <p className="sr-only">類似ノートを生成中…</p>
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              )}

              {/* 埋め込み生成の失敗(控えめな表示。専用リトライは設けない。ノート再編集や
                  回収バッチによる既存の再生成経路に委ねる)。 */}
              {status === "failed" && (
                <p role="status" className="text-sm text-ink-600">
                  類似ノートを生成できませんでした。
                </p>
              )}

              {status === "ready" && similar.length === 0 && (
                <p role="status" className="text-sm text-ink-600">
                  類似するノートはまだありません。
                </p>
              )}

              {/* API は status === "failed" のとき similar を常に空配列で返す(findRelated が
                  埋め込み failed を検出した時点で早期 return し、古い候補を保持し続けない
                  ため)。以前は `status === "ready" || status === "failed"` を条件にしていたが
                  到達不能なデッドコードだったため、"ready" のみに整理する(指示 (d))。 */}
              {status === "ready" && similar.length > 0 && (
                <ul className="flex flex-col gap-2">
                  {similar.map((item) => (
                    <li key={item.id}>
                      <Link
                        to={`/notes/${item.id}`}
                        className="block rounded-lg border border-border px-3 py-2 hover:bg-surface-muted"
                      >
                        <p className="truncate text-sm font-medium text-ink-900">
                          {getDisplayTitle({ title: item.title, body: item.excerpt })}
                        </p>
                        {/* item.title が無い場合は上記の仮タイトルが既に excerpt 由来のため、
                            同じ文字列を二重表示しないよう title がある場合のみ抜粋行を出す。 */}
                        {item.title && item.excerpt && (
                          <p className="mt-0.5 truncate text-xs text-ink-600">{item.excerpt}</p>
                        )}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function NoteDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const noteQuery = useNoteQuery(id ?? "");
  const retryNote = useRetryNoteMutation(id ?? "");
  const isScreenshotType = noteQuery.data?.type === "screenshot";
  const {
    imageUrl,
    isLoading: isImageLoading,
    isError: isImageError,
    retry: retryImage,
  } = useNoteImage(isScreenshotType ? (id ?? "") : "");

  if (noteQuery.isLoading) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-10">
        <Skeleton className="mb-4 h-8 w-2/3" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (noteQuery.isError) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-10">
        <Alert variant="destructive">
          <AlertDescription>
            ノートの取得に失敗しました。しばらくしてから再度お試しください。
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!noteQuery.data) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-10 text-center">
        <h1 className="mb-2 text-xl font-semibold text-ink-900">ノートが見つかりません</h1>
        <p className="mb-6 text-sm text-ink-600">
          削除されたか、URL が間違っている可能性があります。
        </p>
        <Button asChild>
          <Link to="/">一覧へ戻る</Link>
        </Button>
      </div>
    );
  }

  const note = noteQuery.data;
  const isScreenshot = note.type === "screenshot";
  const isProcessing = note.status === "pending" || note.status === "processing";
  const isFailed = note.status === "failed";

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <div className="mb-6 flex items-start justify-between gap-4">
        <h1 className="text-2xl font-semibold text-ink-900">
          {isProcessing ? "処理中…" : getDisplayTitle(note)}
        </h1>
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" size="icon" asChild aria-label="編集">
            <Link to={`/notes/${note.id}/edit`}>
              <Pencil className="size-4" />
            </Link>
          </Button>
          <ConfirmDeleteDialog
            noteId={note.id}
            onDeleted={() => void navigate("/", { replace: true })}
            trigger={
              <Button variant="outline" size="icon" aria-label="削除">
                <Trash2 className="size-4" />
              </Button>
            }
          />
        </div>
      </div>

      <p className="mb-4 text-sm text-ink-600">{formatSavedAt(note.createdAt)}</p>

      {isScreenshot && (
        <div className="mb-6">
          <ScreenshotImage
            imageUrl={imageUrl}
            isError={isImageError}
            isLoading={isImageLoading}
            onRetry={retryImage}
          />
        </div>
      )}

      {isScreenshot && isProcessing && (
        <div role="status" className="mb-6 rounded-lg border border-border bg-surface px-4 py-3">
          <p className="text-sm text-ink-600">処理中です。要約はまもなく生成されます。</p>
          <div className="progress-indeterminate mt-3" aria-hidden="true" />
        </div>
      )}

      {isScreenshot && isFailed && (
        <Alert variant="destructive" className="mb-6">
          <AlertDescription>
            <p>処理に失敗しました。アーカイブ自体は保存済みです。</p>
            {note.failureReason && <p className="mt-1 text-xs">{note.failureReason}</p>}
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="mt-2"
              onClick={() =>
                retryNote.mutate(undefined, {
                  onError: (error) => toast.error(error.message),
                })
              }
              disabled={retryNote.isPending}
            >
              {retryNote.isPending ? "再実行中…" : "再実行する"}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {note.tags.length > 0 && (
        <div className="mb-6 flex flex-wrap gap-1.5">
          {note.tags.map((tag) => (
            <Badge key={tag} variant="secondary">
              {tag}
            </Badge>
          ))}
        </div>
      )}

      {note.summary && (
        <p className="mb-6 rounded-lg bg-surface-muted px-4 py-3 text-sm text-ink-700">
          {note.summary}
        </p>
      )}

      {isScreenshot ? (
        note.extractedText && (
          <Collapsible>
            <CollapsibleTrigger asChild>
              <Button type="button" variant="outline" size="sm">
                抽出したテキストを表示
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="font-reading mt-3 rounded-lg bg-surface-muted px-4 py-3 text-sm whitespace-pre-wrap text-ink-900">
              {note.extractedText}
            </CollapsibleContent>
          </Collapsible>
        )
      ) : (
        <p className="font-reading whitespace-pre-wrap text-base leading-relaxed text-ink-900">
          {note.body}
        </p>
      )}

      <RelatedNotesSection noteId={note.id} />
    </div>
  );
}
