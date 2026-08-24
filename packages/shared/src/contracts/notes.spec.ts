import {
  createMemoNoteRequestSchema,
  listNotesQuerySchema,
  noteRelationTypeSchema,
  noteSchema,
  noteStatusSchema,
  relatedNoteItemSchema,
  relatedNotesResponseSchema,
  relatedNotesStatusSchema,
  relationItemSchema,
  relationStatusSchema,
  relationTypeDirectionSchema,
  screenshotAnalysisResultSchema,
  updateNoteRequestSchema,
} from "./notes.js";

describe("createMemoNoteRequestSchema", () => {
  it("本文のみを受理する(title は任意)", () => {
    const result = createMemoNoteRequestSchema.safeParse({ body: "メモ本文" });
    expect(result.success).toBe(true);
  });

  it("title を添えた場合も受理する", () => {
    const result = createMemoNoteRequestSchema.safeParse({ title: "一言", body: "メモ本文" });
    expect(result.success).toBe(true);
  });

  it("空の body を拒否する", () => {
    const result = createMemoNoteRequestSchema.safeParse({ body: "" });
    expect(result.success).toBe(false);
  });

  it("body が無い場合を拒否する", () => {
    const result = createMemoNoteRequestSchema.safeParse({ title: "一言" });
    expect(result.success).toBe(false);
  });
});

describe("updateNoteRequestSchema", () => {
  it("全フィールド省略(空オブジェクト)を受理する", () => {
    const result = updateNoteRequestSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("title に null を渡せる(未入力へ戻す)", () => {
    const result = updateNoteRequestSchema.safeParse({ title: null });
    expect(result.success).toBe(true);
  });

  it("空文字の title を拒否する(未入力へ戻す場合は null を使う)", () => {
    const result = updateNoteRequestSchema.safeParse({ title: "" });
    expect(result.success).toBe(false);
  });

  it("空文字の body を拒否する", () => {
    const result = updateNoteRequestSchema.safeParse({ body: "" });
    expect(result.success).toBe(false);
  });

  it("tags に空文字を含む配列を拒否する", () => {
    const result = updateNoteRequestSchema.safeParse({ tags: ["ok", ""] });
    expect(result.success).toBe(false);
  });
});

describe("listNotesQuerySchema", () => {
  it("何も指定しない場合 limit のデフォルト値(20)を適用する", () => {
    const result = listNotesQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(20);
      expect(result.data.cursor).toBeUndefined();
    }
  });

  it("limit の文字列を数値へ強制変換する(クエリパラメータ由来)", () => {
    const result = listNotesQuerySchema.safeParse({ limit: "5" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(5);
    }
  });

  it("limit の上限(100)を超える値を拒否する", () => {
    const result = listNotesQuerySchema.safeParse({ limit: "101" });
    expect(result.success).toBe(false);
  });

  it("limit に 0 以下の値を拒否する", () => {
    const result = listNotesQuerySchema.safeParse({ limit: "0" });
    expect(result.success).toBe(false);
  });
});

describe("noteSchema", () => {
  it("title/summary が null のノートを受理する", () => {
    const result = noteSchema.safeParse({
      id: "note-1",
      userId: "user-1",
      type: "memo",
      title: null,
      body: "本文",
      summary: null,
      tags: [],
      status: "completed",
      failureReason: null,
      concepts: [],
      extractedText: null,
      createdAt: "2026-07-09T00:00:00.000Z",
      updatedAt: "2026-07-09T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("不正な type を拒否する", () => {
    const result = noteSchema.safeParse({
      id: "note-1",
      userId: "user-1",
      type: "invalid",
      title: null,
      body: "本文",
      summary: null,
      tags: [],
      status: "completed",
      failureReason: null,
      concepts: [],
      extractedText: null,
      createdAt: "2026-07-09T00:00:00.000Z",
      updatedAt: "2026-07-09T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  it("body が null の screenshot ノート(解析前の pending 状態)を受理する", () => {
    const result = noteSchema.safeParse({
      id: "note-2",
      userId: "user-1",
      type: "screenshot",
      title: null,
      body: null,
      summary: null,
      tags: [],
      status: "pending",
      failureReason: null,
      concepts: [],
      extractedText: null,
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("不正な status を拒否する", () => {
    const result = noteSchema.safeParse({
      id: "note-2",
      userId: "user-1",
      type: "screenshot",
      title: null,
      body: null,
      summary: null,
      tags: [],
      status: "invalid",
      failureReason: null,
      concepts: [],
      extractedText: null,
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });
});

describe("noteStatusSchema", () => {
  it("pending/processing/completed/failed を受理する", () => {
    for (const status of ["pending", "processing", "completed", "failed"]) {
      expect(noteStatusSchema.safeParse(status).success).toBe(true);
    }
  });

  it("未知の値を拒否する", () => {
    expect(noteStatusSchema.safeParse("unknown").success).toBe(false);
  });
});

describe("relatedNoteItemSchema", () => {
  const valid = {
    id: "note-1",
    title: "類似ノート",
    type: "memo",
    excerpt: "抜粋テキスト",
    distance: 0.12,
  };

  it("正常な項目を受理する", () => {
    expect(relatedNoteItemSchema.safeParse(valid).success).toBe(true);
  });

  it("title/excerpt に null を受理する(未入力のノート)", () => {
    const result = relatedNoteItemSchema.safeParse({ ...valid, title: null, excerpt: null });
    expect(result.success).toBe(true);
  });

  it("不正な type を拒否する", () => {
    const result = relatedNoteItemSchema.safeParse({ ...valid, type: "invalid" });
    expect(result.success).toBe(false);
  });

  it("distance が数値以外の場合を拒否する", () => {
    const result = relatedNoteItemSchema.safeParse({ ...valid, distance: "0.12" });
    expect(result.success).toBe(false);
  });

  it("embedding フィールドを含んでいても公開スキーマには現れない(未知キーは strip される)", () => {
    const result = relatedNoteItemSchema.safeParse({ ...valid, embedding: [1, 2, 3] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("embedding");
    }
  });
});

describe("relatedNotesStatusSchema", () => {
  it("generating/ready/failed を受理する", () => {
    for (const status of ["generating", "ready", "failed"]) {
      expect(relatedNotesStatusSchema.safeParse(status).success).toBe(true);
    }
  });

  it("DB の enrichment_status 生値(pending/completed 等)をそのまま受理しない(アプリ概念への変換が必須)", () => {
    for (const status of ["pending", "completed"]) {
      expect(relatedNotesStatusSchema.safeParse(status).success).toBe(false);
    }
  });

  it("未知の値を拒否する", () => {
    expect(relatedNotesStatusSchema.safeParse("unknown").success).toBe(false);
  });
});

describe("noteRelationTypeSchema", () => {
  it("7値固定語彙をすべて受理する", () => {
    for (const type of [
      "same-theme",
      "cause-solution",
      "claim-counter",
      "concept-hierarchy",
      "tech-example",
      "problem-remedy",
      "other",
    ]) {
      expect(noteRelationTypeSchema.safeParse(type).success).toBe(true);
    }
  });

  it("未知の値を拒否する(worker 側で other へ丸め済みの値のみが渡ってくる想定)", () => {
    expect(noteRelationTypeSchema.safeParse("unknown-type").success).toBe(false);
  });
});

describe("relationTypeDirectionSchema", () => {
  it("outgoing/incoming/none を受理する(詳細画面のノート視点の向き)", () => {
    for (const direction of ["outgoing", "incoming", "none"]) {
      expect(relationTypeDirectionSchema.safeParse(direction).success).toBe(true);
    }
  });

  it("DB の a-to-b/b-to-a をそのまま受理しない(API 側で視点変換済みであるべき)", () => {
    for (const direction of ["a-to-b", "b-to-a"]) {
      expect(relationTypeDirectionSchema.safeParse(direction).success).toBe(false);
    }
  });
});

describe("relationItemSchema", () => {
  const valid = {
    id: "note-2",
    title: "関係ノート",
    type: "memo",
    excerpt: "抜粋テキスト",
    relationType: "cause-solution",
    typeDirection: "outgoing",
    description: "原因と解決策の関係にあるため",
    relatedness: 0.8,
  };

  it("正常な項目を受理する", () => {
    expect(relationItemSchema.safeParse(valid).success).toBe(true);
  });

  it("title/excerpt に null を受理する(未入力のノート)", () => {
    const result = relationItemSchema.safeParse({ ...valid, title: null, excerpt: null });
    expect(result.success).toBe(true);
  });

  it("description が 500 文字を超える場合を拒否する(worker 側の境界検証で切り詰め済みの値のみが渡ってくる想定)", () => {
    const result = relationItemSchema.safeParse({ ...valid, description: "a".repeat(501) });
    expect(result.success).toBe(false);
  });

  it("relatedness が 0〜1 の範囲外の場合を拒否する", () => {
    expect(relationItemSchema.safeParse({ ...valid, relatedness: -0.01 }).success).toBe(false);
    expect(relationItemSchema.safeParse({ ...valid, relatedness: 1.01 }).success).toBe(false);
  });

  it("不正な relationType を拒否する", () => {
    const result = relationItemSchema.safeParse({ ...valid, relationType: "invalid" });
    expect(result.success).toBe(false);
  });

  it("embedding フィールドを含んでいても公開スキーマには現れない(未知キーは strip される)", () => {
    const result = relationItemSchema.safeParse({ ...valid, embedding: [1, 2, 3] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("embedding");
    }
  });
});

describe("relationStatusSchema", () => {
  it("not_started/generating/ready/failed を受理する", () => {
    for (const status of ["not_started", "generating", "ready", "failed"]) {
      expect(relationStatusSchema.safeParse(status).success).toBe(true);
    }
  });

  it("DB の relation_status 生値(pending/completed 等)をそのまま受理しない(アプリ概念への変換が必須)", () => {
    for (const status of ["pending", "completed"]) {
      expect(relationStatusSchema.safeParse(status).success).toBe(false);
    }
  });

  it("未知の値を拒否する", () => {
    expect(relationStatusSchema.safeParse("unknown").success).toBe(false);
  });
});

describe("relatedNotesResponseSchema", () => {
  const relation = {
    id: "note-2",
    title: "関係ノート",
    type: "memo",
    excerpt: "抜粋テキスト",
    relationType: "same-theme",
    typeDirection: "none",
    description: "同じテーマを扱っているため",
    relatedness: 0.5,
  };

  it("status: ready + 空配列を受理する(生成済みだが類似候補が無い場合)", () => {
    const result = relatedNotesResponseSchema.safeParse({
      status: "ready",
      relationStatus: "ready",
      relations: [],
      similar: [],
    });
    expect(result.success).toBe(true);
  });

  it("status: generating + 空配列を受理する(未生成・生成中の場合)", () => {
    const result = relatedNotesResponseSchema.safeParse({
      status: "generating",
      relationStatus: "generating",
      relations: [],
      similar: [],
    });
    expect(result.success).toBe(true);
  });

  it("status: failed + 非空配列を受理する(生成失敗時も既存 embedding 由来の候補を返してよい)", () => {
    const result = relatedNotesResponseSchema.safeParse({
      status: "failed",
      relationStatus: "failed",
      relations: [],
      similar: [{ id: "note-1", title: "旧候補", type: "memo", excerpt: "抜粋", distance: 0.2 }],
    });
    expect(result.success).toBe(true);
  });

  it("relationStatus が generating/failed でも relations に非空配列を受理する(確定エッジは embedding 状態に非依存)", () => {
    const result = relatedNotesResponseSchema.safeParse({
      status: "generating",
      relationStatus: "generating",
      relations: [relation],
      similar: [],
    });
    expect(result.success).toBe(true);
  });

  it("status が欠けている場合を拒否する", () => {
    const result = relatedNotesResponseSchema.safeParse({
      relationStatus: "ready",
      relations: [],
      similar: [],
    });
    expect(result.success).toBe(false);
  });

  it("relationStatus が欠けている場合を拒否する", () => {
    const result = relatedNotesResponseSchema.safeParse({
      status: "ready",
      relations: [],
      similar: [],
    });
    expect(result.success).toBe(false);
  });

  it("relations が欠けている場合を拒否する", () => {
    const result = relatedNotesResponseSchema.safeParse({
      status: "ready",
      relationStatus: "ready",
      similar: [],
    });
    expect(result.success).toBe(false);
  });

  it("similar が配列以外の場合を拒否する", () => {
    const result = relatedNotesResponseSchema.safeParse({
      status: "ready",
      relationStatus: "ready",
      relations: [],
      similar: "not-an-array",
    });
    expect(result.success).toBe(false);
  });
});

describe("screenshotAnalysisResultSchema", () => {
  const valid = {
    title: "テストタイトル",
    summary: "テスト要約です。",
    tags: ["tag1"],
    concepts: ["concept1"],
    extractedText: "画像内のテキスト",
  };

  it("正常な AI 解析結果を受理する", () => {
    expect(screenshotAnalysisResultSchema.safeParse(valid).success).toBe(true);
  });

  it("extractedText が空文字列でも受理する(テキストが無い画像)", () => {
    const result = screenshotAnalysisResultSchema.safeParse({ ...valid, extractedText: "" });
    expect(result.success).toBe(true);
  });

  it("title が空白のみの場合は拒否する(trim 後に空文字列になるため)", () => {
    const result = screenshotAnalysisResultSchema.safeParse({ ...valid, title: "   " });
    expect(result.success).toBe(false);
  });

  it("summary が空白のみの場合は拒否する(trim 後に空文字列になるため)", () => {
    const result = screenshotAnalysisResultSchema.safeParse({ ...valid, summary: "   " });
    expect(result.success).toBe(false);
  });

  it("tags が上限(8個)を超える場合は8個に切り詰める", () => {
    const tags = Array.from({ length: 9 }, (_, i) => `tag${i}`);
    const result = screenshotAnalysisResultSchema.safeParse({ ...valid, tags });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tags).toHaveLength(8);
      expect(result.data.tags).toEqual(tags.slice(0, 8));
    }
  });

  it("tags がちょうど8個の場合は切り詰められずそのまま通る", () => {
    const tags = Array.from({ length: 8 }, (_, i) => `tag${i}`);
    const result = screenshotAnalysisResultSchema.safeParse({ ...valid, tags });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tags).toEqual(tags);
    }
  });

  it("concepts が上限(10個)を超える場合は10個に切り詰める", () => {
    const concepts = Array.from({ length: 11 }, (_, i) => `concept${i}`);
    const result = screenshotAnalysisResultSchema.safeParse({ ...valid, concepts });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.concepts).toHaveLength(10);
      expect(result.data.concepts).toEqual(concepts.slice(0, 10));
    }
  });

  it("concepts がちょうど10個の場合は切り詰められずそのまま通る", () => {
    const concepts = Array.from({ length: 10 }, (_, i) => `concept${i}`);
    const result = screenshotAnalysisResultSchema.safeParse({ ...valid, concepts });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.concepts).toEqual(concepts);
    }
  });

  it("extractedText が上限(3000文字)を超える場合は拒否する", () => {
    const result = screenshotAnalysisResultSchema.safeParse({
      ...valid,
      extractedText: "a".repeat(3001),
    });
    expect(result.success).toBe(false);
  });
});
