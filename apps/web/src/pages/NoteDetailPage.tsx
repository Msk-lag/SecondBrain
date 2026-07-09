import { Pencil, Trash2 } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { useNoteQuery } from "@/features/notes/api";
import { getDisplayTitle } from "@/features/notes/utils";

function formatSavedAt(iso: string): string {
  return new Date(iso).toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function NoteDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const noteQuery = useNoteQuery(id ?? "");

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

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <div className="mb-6 flex items-start justify-between gap-4">
        <h1 className="text-2xl font-semibold text-ink-900">{getDisplayTitle(note)}</h1>
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

      <p className="font-reading whitespace-pre-wrap text-base leading-relaxed text-ink-900">
        {note.body}
      </p>
    </div>
  );
}
