import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCreateNoteMutation } from "@/features/notes/api";

export function SaveNotePage() {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [bodyError, setBodyError] = useState<string | null>(null);
  const createNote = useCreateNoteMutation();

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
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

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="mb-6 text-2xl font-semibold text-ink-900">保存</h1>
      <Tabs defaultValue="memo">
        <TabsList>
          <TabsTrigger value="url" disabled>
            URL
          </TabsTrigger>
          <TabsTrigger value="screenshot" disabled>
            スクショ
          </TabsTrigger>
          <TabsTrigger value="memo">メモ</TabsTrigger>
        </TabsList>
        <TabsContent value="memo" className="pt-6">
          <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
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
      </Tabs>
    </div>
  );
}
