import { useLayoutEffect, useState, type RefObject } from 'react';

/**
 * The element's content width in CSS pixels, tracked with a ResizeObserver.
 * Charts draw at this real width instead of scaling a fixed viewBox, so text
 * stays 11px in a narrow Quick Chat and a wide window alike. `fallback` is the
 * width before the first measurement (and in server-side rendering).
 */
export function useWidth(ref: RefObject<HTMLElement | null>, fallback: number): number {
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const w = Math.floor(el.getBoundingClientRect().width);
      if (w > 0) setWidth((prev) => (prev === w ? prev : w));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
