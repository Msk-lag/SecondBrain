import { DbPoolInsertLimitError } from "./db-pool-insert-limit";
import { classifyUploadError } from "./sanitize-upload-error";

describe("classifyUploadError", () => {
  it("minio_upload は常に minio_upload_failed に分類する", () => {
    const result = classifyUploadError("minio_upload", "note-1", new Error("secret message"));

    expect(result).toEqual({ category: "minio_upload_failed", noteId: "note-1" });
  });

  it("compensation_delete は常に compensation_delete_failed に分類する", () => {
    const result = classifyUploadError("compensation_delete", "note-1", new Error("boom"));

    expect(result).toEqual({ category: "compensation_delete_failed", noteId: "note-1" });
  });

  it("enqueue は常に enqueue_failed に分類する", () => {
    const result = classifyUploadError("enqueue", "note-1", new Error("boom"));

    expect(result).toEqual({ category: "enqueue_failed", noteId: "note-1" });
  });

  it("db_insert で DbPoolInsertLimitError は確定的失敗に分類する(insert 自体を呼んでいないため)", () => {
    const result = classifyUploadError("db_insert", "note-1", new DbPoolInsertLimitError());

    expect(result).toEqual({ category: "db_insert_confirmed_failed", noteId: "note-1" });
  });

  it("db_insert で ER_DUP_ENTRY(構造化エラーコード)は確定的失敗に分類する", () => {
    const err = Object.assign(new Error("Duplicate entry"), { code: "ER_DUP_ENTRY" });

    const result = classifyUploadError("db_insert", "note-1", err);

    expect(result).toEqual({ category: "db_insert_confirmed_failed", noteId: "note-1" });
  });

  it("db_insert でタイムアウト(自前の Promise.race)は不確定な失敗に分類する(再照会に頼らない)", () => {
    const result = classifyUploadError("db_insert", "note-1", new Error("notes insert timed out"));

    expect(result).toEqual({ category: "db_insert_ambiguous", noteId: "note-1" });
  });

  it("db_insert で ER_DUP_ENTRY 以外の構造化エラーコード(接続断等)は不確定な失敗に分類する", () => {
    const err = Object.assign(new Error("connection lost"), { code: "PROTOCOL_CONNECTION_LOST" });

    const result = classifyUploadError("db_insert", "note-1", err);

    expect(result).toEqual({ category: "db_insert_ambiguous", noteId: "note-1" });
  });

  it("err.message の文字列内容を分類結果へ一切含めない", () => {
    const sensitive = new Error(
      "MinIO key=screenshots/user-1/note-1.png; MARIADB_PASSWORD=super-secret",
    );

    const result = classifyUploadError("minio_upload", "note-1", sensitive);

    expect(JSON.stringify(result)).not.toContain("MARIADB_PASSWORD");
    expect(JSON.stringify(result)).not.toContain("screenshots/user-1/note-1.png");
  });

  it("未知の値(文字列・null・undefined)を渡しても例外を投げず unknown 系にフォールバックしない db_insert 判定を保つ", () => {
    expect(classifyUploadError("db_insert", "note-1", null)).toEqual({
      category: "db_insert_ambiguous",
      noteId: "note-1",
    });
    expect(classifyUploadError("db_insert", "note-1", "raw string error")).toEqual({
      category: "db_insert_ambiguous",
      noteId: "note-1",
    });
  });
});
