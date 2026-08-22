import { RELATION_DIRECTION_ROLE_LABELS, RELATION_TYPE_LABELS } from "./relation-labels";

describe("RELATION_TYPE_LABELS", () => {
  it("7値すべてに日本語ラベルを持つ", () => {
    expect(RELATION_TYPE_LABELS).toEqual({
      "same-theme": "同じテーマ",
      "cause-solution": "原因と解決策",
      "claim-counter": "主張と反論",
      "concept-hierarchy": "上位/下位概念",
      "tech-example": "技術と具体例",
      "problem-remedy": "問題と対処法",
      other: "その他の関係",
    });
  });
});

describe("RELATION_DIRECTION_ROLE_LABELS", () => {
  it("向きのある5種類に outgoing/incoming の役割ラベルを持つ", () => {
    expect(RELATION_DIRECTION_ROLE_LABELS["cause-solution"]).toEqual({
      outgoing: "原因",
      incoming: "解決策",
    });
    expect(RELATION_DIRECTION_ROLE_LABELS["claim-counter"]).toEqual({
      outgoing: "主張",
      incoming: "反論",
    });
    expect(RELATION_DIRECTION_ROLE_LABELS["concept-hierarchy"]).toEqual({
      outgoing: "上位概念",
      incoming: "下位概念",
    });
    expect(RELATION_DIRECTION_ROLE_LABELS["tech-example"]).toEqual({
      outgoing: "技術",
      incoming: "具体例",
    });
    expect(RELATION_DIRECTION_ROLE_LABELS["problem-remedy"]).toEqual({
      outgoing: "問題",
      incoming: "対処法",
    });
  });

  it("向きの無い same-theme/other には役割ラベルを持たない", () => {
    expect(RELATION_DIRECTION_ROLE_LABELS["same-theme"]).toBeUndefined();
    expect(RELATION_DIRECTION_ROLE_LABELS.other).toBeUndefined();
  });
});
