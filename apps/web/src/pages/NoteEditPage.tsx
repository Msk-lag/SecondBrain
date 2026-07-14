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
import {
  NoteUpdateBadRequestError,
  useNoteQuery,
  useRetryNoteMutation,
  useUpdateNoteMutation,
} from "@/features/notes/api";

export function NoteEditPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const noteQuery = useNoteQuery(id ?? "");
  const updateNote = useUpdateNoteMutation(id ?? "");
  const retryNote = useRetryNoteMutation(id ?? "");

  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [bodyError, setBodyError] = useState<string | null>(null);
  // ノートIDだけでなく status も含めたキーで「初期化済みか」を管理する。理由は2つ:
  // (1) クライアント側遷移で同じ画面のまま別ノートの編集(/notes/A/edit → /notes/B/edit)に
  //     切り替わった場合、id だけの判定だとフォームに旧ノートの内容が残留する
  //     (Codex コードレビュー r1 指摘 [A-2] への対応)。
  // (2) 同一ノートのまま screenshot の解析が processing→completed に遷移した場合、id だけの
  //     判定だと「初期化済み」のまま再初期化されず、processing 中に読み込んだ空値(title=null
  //     等)がフォームに残ったままになる。completed 到達時点で fieldsLocked が解除されるため、
  //     その状態で保存すると AI が生成した内容を空値で上書きしてしまう
  //     (Codex コードレビュー r4 指摘 [A-1] への対応)。
  const initializedKey = useRef<string | null>(null);

  useEffect(() => {
    if (!noteQuery.data) {
      return;
    }
    const key = `${noteQuery.data.id}:${noteQuery.data.status}`;
    if (initializedKey.current === key) {
      return;
    }
    initializedKey.current = key;
    setTitle(noteQuery.data.title ?? "");
    setSummary(noteQuery.data.summary ?? "");
    setBody(noteQuery.data.body ?? "");
    setTags(noteQuery.data.tags);
  }, [noteQuery.data]);

  const isScreenshot = noteQuery.data?.type === "screenshot";
  // screenshot ノートは status が completed の場合のみ title/summary/tags の編集を許可する
  // (§ notes テーブル拡張・削除の論理削除化「screenshot ノートは status が completed の場合の
  // み編集を許可する」参照。failed でも入力欄は無効化したまま再実行ボタンのみ操作可能にする)。
  const fieldsLocked = isScreenshot && noteQuery.data?.status !== "completed";
  const isFailed = noteQuery.data?.status === "failed";

  const addTag = () => {
    if (fieldsLocked) {
      return;
    }
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
    if (fieldsLocked) {
      return;
    }

    if (!isScreenshot) {
      const trimmedBody = body.trim();
      if (!trimmedBody) {
        setBodyError("本文を入力してください");
        return;
      }
    }
    setBodyError(null);

    const trimmedTitle = title.trim();
    updateNote.mutate(
      {
        title: trimmedTitle || null,
        summary: summary.trim() || null,
        tags,
        // screenshot ノートへの body 更新はサーバー側で 400 拒否されるため送信自体を省く
        // (§ notes テーブル拡張・削除の論理削除化「screenshot ノートへの body 更新をサーバー
        // 側で拒否する」参照。手順8 と UI・API 両方で防御する)。
        ...(isScreenshot ? {} : { body: body.trim() }),
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
              {updateNote.error instanceof NoteUpdateBadRequestError
                ? updateNote.error.message
                : "保存に失敗しました。しばらくしてから再度お試しください。"}
            </AlertDescription>
          </Alert>
        )}

        {fieldsLocked && (
          <Alert>
            <AlertDescription>
              <p>
                {isFailed
                  ? "処理に失敗しました。再実行してから編集してください。"
                  : "処理が完了するまで編集できません。"}
              </p>
              {isFailed && (
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
              )}
            </AlertDescription>
          </Alert>
        )}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="edit-title">タイトル</Label>
          <Input
            id="edit-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            disabled={fieldsLocked}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="edit-summary">要約</Label>
          <Textarea
            id="edit-summary"
            rows={3}
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
            disabled={fieldsLocked}
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
                  disabled={fieldsLocked}
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
            disabled={fieldsLocked}
          />
        </div>

        {!isScreenshot && (
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
        )}

        <div className="flex gap-2">
          <Button type="submit" disabled={updateNote.isPending || fieldsLocked}>
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
