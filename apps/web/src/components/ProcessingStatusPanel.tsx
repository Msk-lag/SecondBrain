import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useNoteQuery, useRetryNoteMutation } from "@/features/notes/api";

export interface ProcessingStatusPanelProps {
  noteId: string;
}

/**
 * 保存フォーム下部の処理状況パネル(design/handoffs/20260708-m1-mvp-screens.md 画面3b)。
 * 受付直後(ローディング)/処理中(不定プログレス)/完了(タイトル・要約・タグ)/
 * 失敗+再実行ボタンの状態遷移を表示する。ポーリングは useNoteQuery の refetchInterval
 * (pending/processing の間だけ有効。§ 実装手順20 参照)に委ねる。
 */
export function ProcessingStatusPanel({ noteId }: Readonly<ProcessingStatusPanelProps>) {
  const noteQuery = useNoteQuery(noteId);
  const retryNote = useRetryNoteMutation(noteId);
  const note = noteQuery.data;

  if (noteQuery.isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          処理状況の取得に失敗しました。しばらくしてから再度お試しください。
        </AlertDescription>
      </Alert>
    );
  }

  if (noteQuery.isLoading || !note) {
    return (
      <div role="status" className="rounded-lg border border-border bg-surface px-4 py-3">
        <p className="text-sm text-ink-600">受け付けました。処理を開始しています…</p>
        <div className="progress-indeterminate mt-3" aria-hidden="true" />
      </div>
    );
  }

  if (note.status === "pending" || note.status === "processing") {
    return (
      <div role="status" className="rounded-lg border border-border bg-surface px-4 py-3">
        <p className="text-sm text-ink-600">処理中です。しばらくお待ちください。</p>
        <div className="progress-indeterminate mt-3" aria-hidden="true" />
      </div>
    );
  }

  if (note.status === "failed") {
    return (
      <Alert variant="destructive">
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
    );
  }

  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3">
      <p className="text-sm font-medium text-ink-900">{note.title}</p>
      {note.summary && <p className="mt-1 text-sm text-ink-700">{note.summary}</p>}
      {note.tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {note.tags.map((tag) => (
            <Badge key={tag} variant="secondary">
              {tag}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
