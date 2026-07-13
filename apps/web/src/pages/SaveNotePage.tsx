import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ImageDropzone } from "@/components/ImageDropzone";
import { ProcessingStatusPanel } from "@/components/ProcessingStatusPanel";
import { useCreateNoteMutation, useCreateScreenshotNoteMutation } from "@/features/notes/api";

// design/handoffs/20260708-m1-mvp-screens.md 確定文言。
const IMAGE_VALIDATION_ERROR_MESSAGE =
  "対応していない形式です。PNG・JPG・WebP、最大10MBまでの画像を選択してください";

export function SaveNotePage() {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [bodyError, setBodyError] = useState<string | null>(null);
  const createNote = useCreateNoteMutation();

  const [screenshotFile, setScreenshotFile] = useState<File | null>(null);
  const [screenshotError, setScreenshotError] = useState<string | null>(null);
  const createScreenshotNote = useCreateScreenshotNoteMutation();

  // 直近の受付分のみ処理状況パネルに表示する(続けて貼り付け可能。
  // design/handoffs/20260708-m1-mvp-screens.md 画面3b 参照)。
  const [lastAcceptedNoteId, setLastAcceptedNoteId] = useState<string | null>(null);

  const handleMemoSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedBody = body.trim();
    if (!trimmedBody) {
      setBodyError("本文を入力してください");
      return;
    }
    setBodyError(null);

    const trimmedTitle = title.trim();
    createNote.mutate(
      { body: trimmedBody, ...(trimmedTitle ? { title: trimmedTitle } : {}) },
      {
        onSuccess: () => {
          setTitle("");
          setBody("");
          toast.success("受け付けました。続けて貼り付けできます");
        },
      },
    );
  };

  const handleScreenshotSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!screenshotFile) {
      setScreenshotError(IMAGE_VALIDATION_ERROR_MESSAGE);
      return;
    }
    setScreenshotError(null);

    createScreenshotNote.mutate(screenshotFile, {
      onSuccess: (note) => {
        setScreenshotFile(null);
        setLastAcceptedNoteId(note.id);
        toast.success("受け付けました。続けて貼り付けできます");
      },
    });
  };

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="mb-6 text-2xl font-semibold text-ink-900">保存</h1>
      <Tabs defaultValue="screenshot">
        <TabsList>
          <TabsTrigger value="screenshot">スクショ</TabsTrigger>
          <TabsTrigger value="memo">メモ</TabsTrigger>
          <TabsTrigger value="url" disabled>
            URL(将来対応)
          </TabsTrigger>
        </TabsList>

        <TabsContent value="screenshot" className="pt-6">
          <form className="flex flex-col gap-4" onSubmit={handleScreenshotSubmit} noValidate>
            {createScreenshotNote.isError && (
              <Alert variant="destructive">
                <AlertDescription>
                  受け付けに失敗しました。しばらくしてから再度お試しください。
                </AlertDescription>
              </Alert>
            )}
            <ImageDropzone
              selectedFileName={screenshotFile?.name ?? null}
              disabled={createScreenshotNote.isPending}
              onFileAccepted={(file) => {
                setScreenshotFile(file);
                setScreenshotError(null);
              }}
              onValidationError={(message) => {
                // 選択済みの有効なファイルが残ったままだと、直後に無効なファイルを
                // 選び直しても保存ボタンで以前のファイルがアップロードされてしまう
                // (Codex コードレビュー r10 指摘 [A-2] への対応)。
                setScreenshotFile(null);
                setScreenshotError(message);
              }}
            />
            {screenshotError && <p className="text-sm text-danger">{screenshotError}</p>}
            <Button type="submit" disabled={createScreenshotNote.isPending} className="self-start">
              {createScreenshotNote.isPending ? "受付中…" : "保存する"}
            </Button>
          </form>
        </TabsContent>

        <TabsContent value="memo" className="pt-6">
          <form className="flex flex-col gap-4" onSubmit={handleMemoSubmit} noValidate>
            {createNote.isError && (
              <Alert variant="destructive">
                <AlertDescription>
                  受け付けに失敗しました。しばらくしてから再度お試しください。
                </AlertDescription>
              </Alert>
            )}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="note-title">一言(任意)</Label>
              <Input
                id="note-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="例: 週末に読み返したい"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="note-body">メモ本文</Label>
              <Textarea
                id="note-body"
                rows={8}
                value={body}
                onChange={(event) => {
                  setBody(event.target.value);
                  if (bodyError) {
                    setBodyError(null);
                  }
                }}
                aria-invalid={bodyError ? true : undefined}
                placeholder="貼るだけでOK。一言添えることもできます。"
              />
              {bodyError && <p className="text-sm text-danger">{bodyError}</p>}
            </div>
            <Button type="submit" disabled={createNote.isPending} className="self-start">
              {createNote.isPending ? "受付中…" : "保存する"}
            </Button>
          </form>
        </TabsContent>

        <TabsContent value="url" className="pt-6">
          <p className="text-sm text-ink-600">URL からの保存は将来のアップデートで対応予定です。</p>
        </TabsContent>
      </Tabs>

      {lastAcceptedNoteId && (
        <div className="mt-6">
          <ProcessingStatusPanel noteId={lastAcceptedNoteId} />
        </div>
      )}
    </div>
  );
}
