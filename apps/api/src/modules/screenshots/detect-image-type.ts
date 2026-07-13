/**
 * `file-type` パッケージの代替(§ リスク「画像のマジックバイト検証ライブラリ(file-type)は
 * 新規依存」で計画済みのフォールバック)。`file-type` は ESM only パッケージで、CommonJS
 * ビルドの apps/api から `require()` すると `ERR_PACKAGE_PATH_NOT_EXPORTED` になり実行時に
 * 起動できない(実際に `nest start`/`node dist/main.js` で発生を確認)。対応する3形式のみを
 * 先頭バイト(マジックバイト)で判定する最小実装に置き換える。
 */
export interface DetectedImageType {
  mime: "image/png" | "image/jpeg" | "image/webp";
  ext: "png" | "jpg" | "webp";
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

export function detectImageType(buffer: Buffer): DetectedImageType | undefined {
  if (
    buffer.length >= PNG_SIGNATURE.length &&
    buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    return { mime: "image/png", ext: "png" };
  }
  if (
    buffer.length >= JPEG_SIGNATURE.length &&
    buffer.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)
  ) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { mime: "image/webp", ext: "webp" };
  }
  return undefined;
}
