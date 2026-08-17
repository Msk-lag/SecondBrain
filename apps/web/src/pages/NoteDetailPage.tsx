import { Pencil, Trash2 } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
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
 * 詳細画面の「類似ノート」セクション(M1-4a §設計決定3・対象範囲4 参照)。関係(種類・
 * 説明)は M1-4b で別枠として追加される予定のため、ここでは類似のみを扱う。取得失敗は
 * セクション内で完結させ、ノート本体の閲覧を妨げない(§ テスト観点 参照)。
 *
 * レスポンスの `status`(generating/ready/failed。relatedNotesStatusSchema 参照。Fable 5 +
 * Codex 独立議論 論点2 で確定)に応じて表示を出し分ける。`generating` は埋め込みが未生成
 * (=ポーリング中)であり、「類似候補が無い」という確定結果とは区別して生成中表示に留め、
 * 空状態メッセージは出さない。
 */
function RelatedNotesSection({ noteId }: Readonly<{ noteId: string }>) {
  const relatedNotesQuery = useRelatedNotesQuery(noteId);
  const status = relatedNotesQuery.data?.status;
  const similar = relatedNotesQuery.data?.similar ?? [];

  return (
    <Card className="mt-8">
      <CardHeader>
        <CardTitle className="text-base">類似ノート</CardTitle>
      </CardHeader>
      <CardContent>
        {(relatedNotesQuery.isLoading || status === "generating") && (
          <div className="flex flex-col gap-2" aria-busy="true">
            <p className="sr-only">類似ノートを生成中…</p>
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        )}

        {relatedNotesQuery.isError && (
          <p className="text-sm text-ink-600">類似ノートの取得に失敗しました。</p>
        )}

        {/* 埋め込み生成の失敗(控えめな表示。専用リトライは設けない。ノート再編集や
            回収バッチによる既存の再生成経路に委ねる)。 */}
        {status === "failed" && (
          <p className="text-sm text-ink-600">類似ノートを生成できませんでした。</p>
        )}

        {status === "ready" && similar.length === 0 && (
          <p className="text-sm text-ink-600">類似するノートはまだありません。</p>
        )}

        {(status === "ready" || status === "failed") && similar.length > 0 && (
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
