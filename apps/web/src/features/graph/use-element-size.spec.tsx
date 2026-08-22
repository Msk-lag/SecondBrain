import { act, render, renderHook } from "@testing-library/react";
import { useElementSize, type ElementSize } from "./use-element-size";

type ResizeCallback = ConstructorParameters<typeof ResizeObserver>[0];

/**
 * jsdom のスタブ(setupTests.ts)は observe しても何もコールバックを呼ばない no-op のため、
 * 実際にサイズ変更通知を発火させて検証する spec では独自のモックへ差し替える。
 */
class MockResizeObserver {
  static readonly instances: MockResizeObserver[] = [];
  callback: ResizeCallback;
  observedElements: Element[] = [];
  disconnected = false;

  constructor(callback: ResizeCallback) {
    this.callback = callback;
    MockResizeObserver.instances.push(this);
  }

  observe(element: Element): void {
    this.observedElements.push(element);
  }

  unobserve(): void {
    // 未使用(hook は disconnect のみ呼ぶ)。
  }

  disconnect(): void {
    this.disconnected = true;
  }

  trigger(contentRect: { width: number; height: number }): void {
    this.callback([{ contentRect } as unknown as ResizeObserverEntry], this);
  }
}

// ref を実際の DOM 要素へアタッチするため(useElementSize は useEffect 内で
// ref.current を参照する)、renderHook ではなく実 JSX をレンダーするテスト用コンポーネントを使う。
function TestComponent({ onSize }: Readonly<{ onSize: (size: ElementSize) => void }>) {
  const { ref, size } = useElementSize<HTMLDivElement>();
  onSize(size);
  return <div ref={ref} data-testid="target" />;
}

describe("useElementSize", () => {
  let originalResizeObserver: typeof ResizeObserver;

  beforeEach(() => {
    originalResizeObserver = globalThis.ResizeObserver;
    MockResizeObserver.instances.length = 0;
    globalThis.ResizeObserver = MockResizeObserver;
  });

  afterEach(() => {
    globalThis.ResizeObserver = originalResizeObserver;
  });

  // ref をどこにもアタッチしない(=要素が無い)場合の初期状態。この場合は
  // useEffect が早期 return するため MockResizeObserver は生成されない
  // (renderHook は JSX を伴わないため、実要素は一切アタッチされない)。
  it("要素未アタッチのときは ref.current が null で size が {width:0, height:0}", () => {
    const { result } = renderHook(() => useElementSize<HTMLDivElement>());

    expect(result.current.ref.current).toBeNull();
    expect(result.current.size).toEqual({ width: 0, height: 0 });
  });

  it("要素アタッチ直後(通知前)は width=0, height=0 のまま", () => {
    let latestSize: ElementSize | undefined;
    render(<TestComponent onSize={(size) => (latestSize = size)} />);

    expect(latestSize).toEqual({ width: 0, height: 0 });
  });

  it("ResizeObserver が計測値を通知すると size が更新される", () => {
    let latestSize: ElementSize | undefined;
    render(<TestComponent onSize={(size) => (latestSize = size)} />);

    const [observer] = MockResizeObserver.instances;
    expect(observer).toBeDefined();
    expect(observer?.observedElements).toHaveLength(1);

    act(() => {
      observer?.trigger({ width: 640, height: 480 });
    });

    expect(latestSize).toEqual({ width: 640, height: 480 });
  });

  it("unmount で disconnect が呼ばれる", () => {
    const { unmount } = render(<TestComponent onSize={() => undefined} />);
    const [observer] = MockResizeObserver.instances;

    unmount();

    expect(observer?.disconnected).toBe(true);
  });
});
