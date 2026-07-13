import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { ImagePlus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const ALLOWED_EXTENSIONS = ["png", "jpg", "jpeg", "webp"];
const ALLOWED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * バリデーション文言(design/handoffs/20260708-m1-mvp-screens.md 確定文言)。
 * クライアント側は早期フィードバック用の簡易チェックのみ行う
 * (最終検証はサーバー側の file-type によるマジックバイト検証)。
 */
export const IMAGE_VALIDATION_ERROR_MESSAGE =
  "対応していない形式です。PNG・JPG・WebP、最大10MBまでの画像を選択してください";

function hasValidExtension(fileName: string): boolean {
  const ext = fileName.split(".").pop()?.toLowerCase();
  return ext ? ALLOWED_EXTENSIONS.includes(ext) : false;
}

function isValidImageFile(file: File): boolean {
  const validType = ALLOWED_MIME_TYPES.has(file.type) || hasValidExtension(file.name);
  return validType && file.size <= MAX_BYTES;
}

export interface ImageDropzoneProps {
  onFileAccepted: (file: File) => void;
  onValidationError: (message: string) => void;
  selectedFileName?: string | null;
  disabled?: boolean;
}

export function ImageDropzone({
  onFileAccepted,
  onValidationError,
  selectedFileName,
  disabled = false,
}: Readonly<ImageDropzoneProps>) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const validateAndEmit = (file: File) => {
    if (!isValidImageFile(file)) {
      onValidationError(IMAGE_VALIDATION_ERROR_MESSAGE);
      return;
    }
    onFileAccepted(file);
  };

  const openFileDialog = () => {
    if (disabled) {
      return;
    }
    inputRef.current?.click();
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (disabled) {
      return;
    }
    setIsDragging(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    if (disabled) {
      return;
    }
    const file = event.dataTransfer.files?.[0];
    if (file) {
      validateAndEmit(file);
    }
  };

  // ルート要素へ `onPaste` を設定するだけでは、その要素(またはその子孫)にフォーカスが
  // 無い通常の状態でCtrl+Vを行っても paste イベントが到達しない(paste は現在フォーカスされて
  // いる要素から発火・伝播するため)。この画面はテキスト入力欄にフォーカスを促す前提が無く、
  // 表示文言でも「貼り付け(Ctrl+V)」を主要な操作として案内しているため、コンポーネント表示中は
  // window レベルで購読し、フォーカス位置によらず機能するようにする(Codex コードレビュー
  // 2026-07-13 r6 指摘 [A-2] への対応。クリップボードに画像が無い通常のテキスト貼り付け
  // 〔他のテキスト入力欄等〕は素通りさせるため preventDefault しない)。
  useEffect(() => {
    if (disabled) {
      return;
    }
    const handleWindowPaste = (event: globalThis.ClipboardEvent) => {
      const item = Array.from(event.clipboardData?.items ?? []).find((entry) =>
        entry.type.startsWith("image/"),
      );
      const file = item?.getAsFile();
      if (file) {
        event.preventDefault();
        validateAndEmit(file);
      }
    };
    window.addEventListener("paste", handleWindowPaste);
    return () => {
      window.removeEventListener("paste", handleWindowPaste);
    };
    // `validateAndEmit` 自体を依存に含めると(毎レンダー再生成される関数のため)実質
    // disabled/onFileAccepted/onValidationError と同じ依存になる。実体である後者2つを
    // 直接依存に指定し、古いクロージャの `onFileAccepted`/`onValidationError` を呼ばないようにする。
    // eslint-disable-next-line react-hooks/exhaustive-deps -- validateAndEmit は上記2つのpropsだけに依存する純粋なローカル関数であり、それらを直接依存に含めているため無限ループ・staleクロージャのいずれも発生しない
  }, [disabled, onFileAccepted, onValidationError]);

  const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      validateAndEmit(file);
    }
    event.target.value = "";
  };

  return (
    <div
      data-testid="image-dropzone"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={cn(
        "flex flex-col items-center gap-3 rounded-lg border-2 border-dashed border-border px-6 py-10 text-center transition-colors",
        isDragging && "border-accent bg-accent-soft",
        disabled && "opacity-50",
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="sr-only"
        aria-label="スクリーンショット画像ファイルを選択"
        disabled={disabled}
        onChange={handleInputChange}
      />
      <ImagePlus className="size-6 text-ink-400" aria-hidden="true" />
      <p className="text-sm text-ink-600">
        画像をドラッグ&ドロップ、貼り付け(Ctrl+V)、または選択してください
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={openFileDialog}
      >
        画像を選択
      </Button>
      {selectedFileName && <p className="text-xs text-ink-700">選択中: {selectedFileName}</p>}
    </div>
  );
}
