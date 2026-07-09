import { Trash2 } from "lucide-react";
import { Link } from "react-router";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { useNotesQuery } from "@/features/notes/api";
import { getDisplayTitle } from "@/features/notes/utils";

function formatSavedAt(iso: string): string {
  return new Date(iso).toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function NoteListPage() {
  const notesQuery = useNotesQuery();

  if (notesQuery.isLoading) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="mb-6 text-2xl font-semibold text-ink-900">ノート一覧</h1>
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-16 w-full" />
          ))}
        </div>
      </div>
    );
  }

  if (notesQuery.isError) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="mb-6 text-2xl font-semibold text-ink-900">ノート一覧</h1>
        <Alert variant="destructive">
          <AlertDescription>
            一覧の取得に失敗しました。しばらくしてから再度お試しください。
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const notes = notesQuery.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-ink-900">ノート一覧</h1>
        <Button asChild size="sm">
          <Link to="/save">保存する</Link>
        </Button>
      </div>

      {notes.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border py-16 text-center">
          <p className="text-sm text-ink-600">まだノートがありません。</p>
          <Button asChild>
            <Link to="/save">最初のノートを保存する</Link>
          </Button>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {notes.map((note) => (
            <li
              key={note.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-3"
            >
              <Link to={`/notes/${note.id}`} className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink-900">{getDisplayTitle(note)}</p>
                <p className="mt-0.5 text-xs text-ink-600">{formatSavedAt(note.createdAt)}</p>
              </Link>
              <ConfirmDeleteDialog
                noteId={note.id}
                trigger={
                  <Button variant="ghost" size="icon" aria-label="削除">
                    <Trash2 className="size-4" />
                  </Button>
                }
              />
            </li>
          ))}
        </ul>
      )}

      {notesQuery.hasNextPage && (
        <div className="mt-6 flex justify-center">
          <Button
            variant="outline"
            onClick={() => void notesQuery.fetchNextPage()}
            disabled={notesQuery.isFetchingNextPage}
          >
            {notesQuery.isFetchingNextPage ? "読み込み中…" : "さらに読み込む"}
          </Button>
        </div>
      )}
    </div>
  );
}
