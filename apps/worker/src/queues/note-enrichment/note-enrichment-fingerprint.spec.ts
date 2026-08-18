import { createHash } from "node:crypto";
import {
  buildEmbeddingInputText,
  computeEmbeddingFingerprint,
  isEmbeddingInputEmpty,
  type EmbeddingInputSnapshot,
} from "./note-enrichment-fingerprint";

function snapshot(overrides: Partial<EmbeddingInputSnapshot> = {}): EmbeddingInputSnapshot {
  return {
    title: "タイトル",
    summary: "要約",
    body: "本文",
    extractedText: null,
    tagsRaw: '["b","a"]',
    ...overrides,
  };
}

describe("buildEmbeddingInputText", () => {
  it("title/summary/body/tags(安定ソート済み)を \\n 区切りで連結する", () => {
    expect(buildEmbeddingInputText(snapshot())).toBe("タイトル\n要約\n本文\na,b");
  });

  it("body が null なら extractedText を使う", () => {
    expect(buildEmbeddingInputText(snapshot({ body: null, extractedText: "抽出テキスト" }))).toBe(
      "タイトル\n要約\n抽出テキスト\na,b",
    );
  });

  it("body が非 null なら extractedText より優先する", () => {
    expect(buildEmbeddingInputText(snapshot({ body: "本文", extractedText: "抽出テキスト" }))).toBe(
      "タイトル\n要約\n本文\na,b",
    );
  });

  it("title/summary が null の場合は空文字列として扱う", () => {
    expect(
      buildEmbeddingInputText(snapshot({ title: null, summary: null, body: null, tagsRaw: "[]" })),
    ).toBe("\n\n\n");
  });

  it("前後の空白のみのフィールドは空文字列として扱う(trim)", () => {
    expect(
      buildEmbeddingInputText(snapshot({ title: "   ", summary: "\t\n", body: "  x  " })),
    ).toBe("\n\nx\na,b");
  });

  it("tags の順序が違っても同じ集合なら同じ連結結果になる(安定ソート)", () => {
    const a = buildEmbeddingInputText(snapshot({ tagsRaw: '["b","a","c"]' }));
    const b = buildEmbeddingInputText(snapshot({ tagsRaw: '["c","a","b"]' }));
    expect(a).toBe(b);
  });

  it("tags が不正な JSON の場合は空配列として扱う", () => {
    expect(buildEmbeddingInputText(snapshot({ tagsRaw: "not json" }))).toBe(
      "タイトル\n要約\n本文\n",
    );
  });

  it("tags が JSON 配列でない場合(オブジェクト等)は空配列として扱う", () => {
    expect(buildEmbeddingInputText(snapshot({ tagsRaw: '{"a":1}' }))).toBe(
      "タイトル\n要約\n本文\n",
    );
  });

  it("tags 配列に文字列以外の要素が混じる場合はそれらを除外する", () => {
    expect(buildEmbeddingInputText(snapshot({ tagsRaw: '["a",1,null,"b"]' }))).toBe(
      "タイトル\n要約\n本文\na,b",
    );
  });
});

describe("isEmbeddingInputEmpty", () => {
  it("title/summary/body/extractedText/tags のすべてが空の場合は true", () => {
    expect(
      isEmbeddingInputEmpty(
        snapshot({ title: null, summary: null, body: null, extractedText: null, tagsRaw: "[]" }),
      ),
    ).toBe(true);
  });

  it("空白のみのフィールドのみで構成される場合も true(trim 後に空)", () => {
    expect(
      isEmbeddingInputEmpty(
        snapshot({ title: "  ", summary: "", body: "   ", extractedText: null, tagsRaw: "[]" }),
      ),
    ).toBe(true);
  });

  it("tags のみが非空の場合は false", () => {
    expect(
      isEmbeddingInputEmpty(
        snapshot({ title: null, summary: null, body: null, extractedText: null, tagsRaw: '["x"]' }),
      ),
    ).toBe(false);
  });

  it("title のみが非空の場合は false", () => {
    expect(
      isEmbeddingInputEmpty(
        snapshot({ title: "x", summary: null, body: null, extractedText: null, tagsRaw: "[]" }),
      ),
    ).toBe(false);
  });

  it("通常のスナップショット(全フィールド非空)は false", () => {
    expect(isEmbeddingInputEmpty(snapshot())).toBe(false);
  });
});

describe("computeEmbeddingFingerprint", () => {
  it("buildEmbeddingInputText の結果の UTF-8 SHA-256 hex を返す", () => {
    const input = buildEmbeddingInputText(snapshot());
    const expected = createHash("sha256").update(input, "utf8").digest("hex");
    expect(computeEmbeddingFingerprint(snapshot())).toBe(expected);
  });

  it("内容が同じなら常に同じ fingerprint になる(冪等性)", () => {
    expect(computeEmbeddingFingerprint(snapshot())).toBe(computeEmbeddingFingerprint(snapshot()));
  });

  it("内容が変われば fingerprint も変わる", () => {
    expect(computeEmbeddingFingerprint(snapshot())).not.toBe(
      computeEmbeddingFingerprint(snapshot({ title: "別のタイトル" })),
    );
  });

  it("tags の順序だけが違う場合は同じ fingerprint になる", () => {
    const a = computeEmbeddingFingerprint(snapshot({ tagsRaw: '["b","a"]' }));
    const b = computeEmbeddingFingerprint(snapshot({ tagsRaw: '["a","b"]' }));
    expect(a).toBe(b);
  });

  it("64文字の16進数文字列を返す(SHA-256 hex)", () => {
    expect(computeEmbeddingFingerprint(snapshot())).toMatch(/^[0-9a-f]{64}$/);
  });
});
