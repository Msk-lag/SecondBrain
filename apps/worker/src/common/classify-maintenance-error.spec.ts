import { StorageTimeoutError } from "@secondbrain/storage";
import {
  MaintenanceTimeoutError,
  SanitizedMaintenanceException,
  classifyMaintenanceError,
} from "./classify-maintenance-error";

describe("classifyMaintenanceError", () => {
  it("classifies MaintenanceTimeoutError as db_timeout", () => {
    expect(classifyMaintenanceError(new MaintenanceTimeoutError())).toEqual({
      category: "db_timeout",
    });
  });

  it("classifies StorageTimeoutError as storage_error", () => {
    expect(classifyMaintenanceError(new StorageTimeoutError("deleteObject", 15_000))).toEqual({
      category: "storage_error",
    });
  });

  it("classifies unrecognized errors as unknown_error", () => {
    expect(classifyMaintenanceError(new Error("something unexpected"))).toEqual({
      category: "unknown_error",
    });
    expect(classifyMaintenanceError("not an error at all")).toEqual({ category: "unknown_error" });
    expect(classifyMaintenanceError(undefined)).toEqual({ category: "unknown_error" });
  });

  it("never leaks the original error message into the sanitized result", () => {
    // 実際の接続文字列のような形式(scheme://user:pass@host)は secretlint の
    // database-connection-string ルールに誤検知されるため、意図的に URL 形式を避けた
    // ダミー値を使う(実在の資格情報ではない。テスト目的のプレースホルダ)。
    const secret = "db user=hunter2-test-password host=db-host db=secondbrain SELECT * FROM notes";
    const sanitized = classifyMaintenanceError(new Error(secret));
    expect(JSON.stringify(sanitized)).not.toContain(secret);
  });
});

describe("SanitizedMaintenanceException", () => {
  it("carries only the fixed category name, never the original error content", () => {
    const secret = "screenshots/user-1/note-1.png connection refused";
    const sanitized = classifyMaintenanceError(new Error(secret));
    const exception = new SanitizedMaintenanceException(sanitized);

    expect(exception).toBeInstanceOf(Error);
    expect(exception.category).toBe("unknown_error");
    expect(exception.message).not.toContain(secret);
  });
});
