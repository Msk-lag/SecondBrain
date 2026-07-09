import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useNoteQuery, useUpdateNoteMutation } from "@/features/notes/api";

export function NoteEditPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const noteQuery = useNoteQuery(id ?? "");
  const updateNote = useUpdateNoteMutation(id ?? "");

  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [bodyError, setBodyError] = useState<string | null>(null);
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current || !noteQuery.data) {
      return;
    }
    initialized.current = true;
    setTitle(noteQuery.data.title ?? "");
    setSummary(noteQuery.data.summary ?? "");
    setBody(noteQuery.data.body);
    setTags(noteQuery.data.tags);
  }, [noteQuery.data]);

  const addTag = () => {
    const trimmed = tagInput.trim();
    if (trimmed && !tags.includes(trimmed)) {
      setTags([...tags, trimmed]);
    }
    setTagInput("");
  };

  const handleTagKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addTag();
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedBody = body.trim();
    if (!trimmedBody) {
      setBodyError("本文を入力してください");
      return;
    }
    setBodyError(null);

    const trimmedTitle = title.trim();
    updateNote.mutate(
      {
        title: trimmedTitle || null,
        summary: summary.trim() || null,
        body: trimmedBody,
        tags,
      },
      {
        onSuccess: () => {
          toast.success("保存しました");
          void navigate(`/notes/${id ?? ""}`);
        },
      },
    );
  };

  if (noteQuery.isLoading) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-10">
        <Skeleton className="mb-4 h-8 w-1/2" />
        <Skeleton className="h-64 w-full" />
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
        <Button asChild>
          <Link to="/">一覧へ戻る</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="mb-6 text-2xl font-semibold text-ink-900">ノートを編集</h1>
      <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
        {updateNote.isError && (
          <Alert variant="destructive">
            <AlertDescription>
              保存に失敗しました。しばらくしてから再度お試しください。
            </AlertDescription>
          </Alert>
        )}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="edit-title">タイトル</Label>
          <Input id="edit-title" value={title} onChange={(event) => setTitle(event.target.value)} />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="edit-summary">要約</Label>
          <Textarea
            id="edit-summary"
            rows={3}
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="edit-tags">タグ</Label>
          <div className="flex flex-wrap gap-1.5">
            {tags.map((tag) => (
              <Badge key={tag} variant="secondary" className="gap-1">
                {tag}
                <button
                  type="button"
                  aria-label={`${tag} を削除`}
                  onClick={() => setTags(tags.filter((t) => t !== tag))}
                >
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
          </div>
          <Input
            id="edit-tags"
            value={tagInput}
            onChange={(event) => setTagInput(event.target.value)}
            onKeyDown={handleTagKeyDown}
            onBlur={addTag}
            placeholder="タグを入力して Enter"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="edit-body">本文</Label>
          <Textarea
            id="edit-body"
            rows={10}
            value={body}
            onChange={(event) => {
              setBody(event.target.value);
              if (bodyError) {
                setBodyError(null);
              }
            }}
            aria-invalid={bodyError ? true : undefined}
          />
          {bodyError && <p className="text-sm text-danger">{bodyError}</p>}
        </div>

        <div className="flex gap-2">
          <Button type="submit" disabled={updateNote.isPending}>
            {updateNote.isPending ? "保存中…" : "保存する"}
          </Button>
          <Button variant="outline" type="button" asChild>
            <Link to={`/notes/${id ?? ""}`}>キャンセル</Link>
          </Button>
        </div>
      </form>
    </div>
  );
}
