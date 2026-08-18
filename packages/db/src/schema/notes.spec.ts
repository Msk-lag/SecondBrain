import { getTableColumns } from "drizzle-orm";
import { noteEnrichmentStatusValues, noteStatusValues, noteTypeValues, notes } from "./notes.js";

/**
 * notes テーブル定義の単体テスト。migrations.spec.ts は生成済み SQL の静的検証のみで
 * このモジュール自体を import しないため、customType(embeddingVector/jsonTextArray)の
 * 挙動やスキーマ定義の詳細はここで検証する。drizzle の内部クラスへ直接アクセスすると
 * 壊れやすいテストになるため、`getTableColumns` など drizzle が公開している手段
 * (column.name / column.notNull / column.enumValues / column.getSQLType() /
 * column.mapToDriverValue() / column.mapFromDriverValue())のみを使う。
 */
const columns = getTableColumns(notes);

describe("noteTypeValues", () => {
  it("memo/url/screenshot を持つ", () => {
    expect(noteTypeValues).toEqual(["memo", "url", "screenshot"]);
  });
});

describe("noteStatusValues", () => {
  it("pending/processing/completed/failed を持つ", () => {
    expect(noteStatusValues).toEqual(["pending", "processing", "completed", "failed"]);
  });
});

describe("noteEnrichmentStatusValues(M1-4a §設計決定4 参照)", () => {
  it("pending/completed/failed を持つ", () => {
    expect(noteEnrichmentStatusValues).toEqual(["pending", "completed", "failed"]);
  });
});

describe("notes テーブル拡張(M1-4a 埋め込み生成)の列定義", () => {
  it("embedding が DB列名 embedding・vector(1536)・nullable である", () => {
    expect(columns.embedding.name).toBe("embedding");
    expect(columns.embedding.getSQLType()).toBe("vector(1536)");
    expect(columns.embedding.notNull).toBe(false);
  });

  it("embeddingModel が DB列名 embedding_model・varchar(64)・nullable である", () => {
    expect(columns.embeddingModel.name).toBe("embedding_model");
    expect(columns.embeddingModel.getSQLType()).toBe("varchar(64)");
    expect(columns.embeddingModel.notNull).toBe(false);
  });

  it("embeddingFingerprint が DB列名 embedding_fingerprint・varchar(64)・nullable である", () => {
    expect(columns.embeddingFingerprint.name).toBe("embedding_fingerprint");
    expect(columns.embeddingFingerprint.getSQLType()).toBe("varchar(64)");
    expect(columns.embeddingFingerprint.notNull).toBe(false);
  });

  it("enrichmentStatus が DB列名 enrichment_status・pending/completed/failed の enum・nullable である", () => {
    expect(columns.enrichmentStatus.name).toBe("enrichment_status");
    expect(columns.enrichmentStatus.enumValues).toEqual(["pending", "completed", "failed"]);
    expect(columns.enrichmentStatus.getSQLType()).toBe("enum('pending','completed','failed')");
    expect(columns.enrichmentStatus.notNull).toBe(false);
  });
});

describe("jsonTextArray customType(tags/concepts の参照実装。§ MariaDB の JSON カラムの実装パターン 参照)", () => {
  it("dataType() が json を返す(tags 列で検証)", () => {
    expect(columns.tags.getSQLType()).toBe("json");
  });

  it("dataType() が json を返す(concepts 列でも同一実装であることを確認)", () => {
    expect(columns.concepts.getSQLType()).toBe("json");
  });

  it("toDriver が配列を JSON 文字列化する", () => {
    expect(columns.tags.mapToDriverValue(["a", "b"])).toBe('["a","b"]');
  });

  it("fromDriver が JSON 文字列をパースする", () => {
    expect(columns.tags.mapFromDriverValue('["a","b"]')).toEqual(["a", "b"]);
  });

  it("fromDriver は文字列以外が来た場合そのまま返す(mysql2 が既に配列を返した場合に壊さない)", () => {
    // MariaDB の JSON 型は mysql2 で自動パースされないため通常は文字列で届くが、
    // 将来のドライバ挙動変化・テスト用のモックデータ等で非文字列が渡っても
    // 安全に通過させるフォールバック(notes.ts の実装コメント参照)。
    const alreadyParsed = ["a", "b"] as unknown as string;
    expect(columns.tags.mapFromDriverValue(alreadyParsed)).toBe(alreadyParsed);
  });
});
