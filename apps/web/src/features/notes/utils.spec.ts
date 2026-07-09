import { getDisplayTitle } from "./utils";

describe("getDisplayTitle", () => {
  it("title があればそのまま返す", () => {
    expect(getDisplayTitle({ title: "一言", body: "本文" })).toBe("一言");
  });

  it("title が null なら本文をそのまま返す(30文字以下)", () => {
    expect(getDisplayTitle({ title: null, body: "短い本文" })).toBe("短い本文");
  });

  it("title が null で本文が30文字を超える場合は末尾を省略する", () => {
    const body = "あ".repeat(40);
    const result = getDisplayTitle({ title: null, body });
    expect(result).toBe(`${"あ".repeat(30)}…`);
  });
});
