import { Pencil, Trash2 } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { useNoteImage, useNoteQuery, useRetryNoteMutation } from "@/features/notes/api";
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
    </div>
  );
}
