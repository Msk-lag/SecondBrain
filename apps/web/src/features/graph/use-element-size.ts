import { useEffect, useRef, useState, type RefObject } from "react";

export interface ElementSize {
  width: number;
  height: number;
}

export interface UseElementSizeResult<T extends HTMLElement> {
  ref: RefObject<T | null>;
  size: ElementSize;
}

const INITIAL_SIZE: ElementSize = { width: 0, height: 0 };

/**
 * ラッパー要素のサイズを `ResizeObserver` で計測するフック(M2-2 §設計決定7)。
 * `react-force-graph-2d` は `width`/`height` を明示しないと `window` サイズになるため、
 * キャンバスを埋め込む親要素の実サイズをこのフックで測って渡す。
 *
 * **計測値0のとき(初回レンダー・jsdom には `ResizeObserver` が無いためスタブが
 * 何もコールバックを呼ばない)は、呼び出し側でキャンバスを描画せず確定してから描く**
 * という判断ができるよう、`size` は `{ width: 0, height: 0 }` を初期値として返す。
 */
export function useElementSize<T extends HTMLElement>(): UseElementSizeResult<T> {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState<ElementSize>(INITIAL_SIZE);

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      const { width, height } = entry.contentRect;
      setSize({ width, height });
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, size };
}
