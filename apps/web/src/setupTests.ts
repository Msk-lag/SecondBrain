import "@testing-library/jest-dom/vitest";

// jsdom には `ResizeObserver` が無いため、最小限の no-op スタブを用意する
// (M2-2 §設計決定7。`features/graph/use-element-size.ts` が利用する)。
if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    observe(): void {
      // no-op(jsdom はレイアウトを計算しないため、実際のサイズ変更通知を発火できない)。
    }
    unobserve(): void {
      // no-op。
    }
    disconnect(): void {
      // no-op。
    }
  }

  globalThis.ResizeObserver = ResizeObserverStub;
}
