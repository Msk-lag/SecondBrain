import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useDeleteNoteMutation } from "@/features/notes/api";

interface ConfirmDeleteDialogProps {
  noteId: string;
  trigger: ReactNode;
  onDeleted?: () => void;
}

export function ConfirmDeleteDialog({
  noteId,
  trigger,
  onDeleted,
}: Readonly<ConfirmDeleteDialogProps>) {
  const [open, setOpen] = useState(false);
  const deleteNote = useDeleteNoteMutation();

  const handleConfirm = () => {
    deleteNote.mutate(noteId, {
      onSuccess: () => {
        toast.success("削除しました");
        setOpen(false);
        onDeleted?.();
      },
    });
  };

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>ノートを削除しますか?</AlertDialogTitle>
          <AlertDialogDescription>この操作は取り消せません。</AlertDialogDescription>
        </AlertDialogHeader>
        {deleteNote.isError && (
          <Alert variant="destructive">
            <AlertDescription>
              削除に失敗しました。しばらくしてから再度お試しください。
            </AlertDescription>
          </Alert>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteNote.isPending}>キャンセル</AlertDialogCancel>
          <Button variant="destructive" onClick={handleConfirm} disabled={deleteNote.isPending}>
            {deleteNote.isPending ? "削除中…" : "削除する"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
