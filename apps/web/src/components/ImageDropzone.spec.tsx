import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IMAGE_VALIDATION_ERROR_MESSAGE, ImageDropzone } from "./ImageDropzone";

function createFile(name: string, type: string, sizeInBytes: number): File {
  const file = new File(["x".repeat(Math.min(sizeInBytes, 10))], name, { type });
  Object.defineProperty(file, "size", { value: sizeInBytes });
  return file;
}

describe("ImageDropzone", () => {
  it("ファイル選択で有効な画像を選ぶと onFileAccepted を呼ぶ", async () => {
    const onFileAccepted = vi.fn();
    const onValidationError = vi.fn();
    const user = userEvent.setup();

    render(<ImageDropzone onFileAccepted={onFileAccepted} onValidationError={onValidationError} />);

    const file = createFile("screenshot.png", "image/png", 1024);
    const input = screen.getByLabelText("スクリーンショット画像ファイルを選択");
    await user.upload(input, file);

    expect(onFileAccepted).toHaveBeenCalledWith(file);
    expect(onValidationError).not.toHaveBeenCalled();
  });

  it("非対応形式を選ぶと onValidationError を呼ぶ", () => {
    const onFileAccepted = vi.fn();
    const onValidationError = vi.fn();

    render(<ImageDropzone onFileAccepted={onFileAccepted} onValidationError={onValidationError} />);

    // `userEvent.upload()` は input の `accept` 属性に基づき非対応ファイルの選択自体を
    // (実ブラウザのファイル選択ダイアログを模して)拒否してしまい、コンポーネント自身の
    // JS バリデーション(defense-in-depth。D&D 等 accept 属性が効かない経路のため必要)を
    // 通過させられない。ここでは `accept` によるブラウザ側フィルタを経由しない選択(OS の
    // 「すべてのファイル」選択や一部ブラウザの実装差異等)を模すため、input の change
    // イベントを直接発火させる。
    const file = createFile("document.pdf", "application/pdf", 1024);
    const input = screen.getByLabelText("スクリーンショット画像ファイルを選択");
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onValidationError).toHaveBeenCalledWith(IMAGE_VALIDATION_ERROR_MESSAGE);
    expect(onFileAccepted).not.toHaveBeenCalled();
  });

  it("10MBを超える画像は onValidationError を呼ぶ", async () => {
    const onFileAccepted = vi.fn();
    const onValidationError = vi.fn();
    const user = userEvent.setup();

    render(<ImageDropzone onFileAccepted={onFileAccepted} onValidationError={onValidationError} />);

    const file = createFile("large.png", "image/png", 11 * 1024 * 1024);
    const input = screen.getByLabelText("スクリーンショット画像ファイルを選択");
    await user.upload(input, file);

    expect(onValidationError).toHaveBeenCalledWith(IMAGE_VALIDATION_ERROR_MESSAGE);
    expect(onFileAccepted).not.toHaveBeenCalled();
  });

  it("ドロップされた画像を受け付ける", () => {
    const onFileAccepted = vi.fn();
    const onValidationError = vi.fn();

    render(<ImageDropzone onFileAccepted={onFileAccepted} onValidationError={onValidationError} />);

    const file = createFile("dropped.webp", "image/webp", 2048);
    const dropzone = screen.getByTestId("image-dropzone");
    dropzone.dispatchEvent(
      Object.assign(new Event("drop", { bubbles: true, cancelable: true }), {
        dataTransfer: { files: [file] },
      }),
    );

    expect(onFileAccepted).toHaveBeenCalledWith(file);
  });

  it("貼り付けられた画像を受け付ける", () => {
    const onFileAccepted = vi.fn();
    const onValidationError = vi.fn();

    render(<ImageDropzone onFileAccepted={onFileAccepted} onValidationError={onValidationError} />);

    const file = createFile("pasted.png", "image/png", 2048);
    const dropzone = screen.getByTestId("image-dropzone");
    dropzone.dispatchEvent(
      Object.assign(new Event("paste", { bubbles: true, cancelable: true }), {
        clipboardData: {
          items: [{ type: "image/png", getAsFile: () => file }],
        },
      }),
    );

    expect(onFileAccepted).toHaveBeenCalledWith(file);
  });

  it("ドロップゾーン自体にフォーカスが無く、documentがpasteのターゲットになった場合でも画像を受け付ける(Codex コードレビュー 2026-07-13 r6 指摘 [A-2])", () => {
    const onFileAccepted = vi.fn();
    const onValidationError = vi.fn();

    render(<ImageDropzone onFileAccepted={onFileAccepted} onValidationError={onValidationError} />);

    // ドロップゾーンはフォーカス不能なため、実際のブラウザでは paste イベントは
    // document(フォーカスが無い場合の既定のターゲット)から発火する。ドロップゾーン要素
    // 自体をターゲットにせず、window レベルの購読だけで拾えることを確認する。
    const file = createFile("pasted-unfocused.png", "image/png", 2048);
    document.dispatchEvent(
      Object.assign(new Event("paste", { bubbles: true, cancelable: true }), {
        clipboardData: {
          items: [{ type: "image/png", getAsFile: () => file }],
        },
      }),
    );

    expect(onFileAccepted).toHaveBeenCalledWith(file);
  });

  it("disabled のときは document への貼り付けを無視する", () => {
    const onFileAccepted = vi.fn();
    const onValidationError = vi.fn();

    render(
      <ImageDropzone
        onFileAccepted={onFileAccepted}
        onValidationError={onValidationError}
        disabled
      />,
    );

    const file = createFile("pasted-disabled.png", "image/png", 2048);
    document.dispatchEvent(
      Object.assign(new Event("paste", { bubbles: true, cancelable: true }), {
        clipboardData: {
          items: [{ type: "image/png", getAsFile: () => file }],
        },
      }),
    );

    expect(onFileAccepted).not.toHaveBeenCalled();
  });

  it("選択済みファイル名を表示する", () => {
    render(
      <ImageDropzone
        onFileAccepted={vi.fn()}
        onValidationError={vi.fn()}
        selectedFileName="screenshot.png"
      />,
    );

    expect(screen.getByText("選択中: screenshot.png")).toBeInTheDocument();
  });

  it("disabled のときは入力が無効化される", () => {
    render(<ImageDropzone onFileAccepted={vi.fn()} onValidationError={vi.fn()} disabled />);

    expect(screen.getByLabelText("スクリーンショット画像ファイルを選択")).toBeDisabled();
    expect(screen.getByRole("button", { name: "画像を選択" })).toBeDisabled();
  });
});
