import { useEffect, useRef } from 'react';

/**
 * Returns a ref for a scrollable element. While the user scrolls it, an
 * `is-scrolling` class is applied (and removed ~900ms after they stop), so the
 * scrollbar can be styled to appear only during scrolling.
 */
export function useAutoHideScroll<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let timer: number;
    const onScroll = () => {
      el.classList.add('is-scrolling');
      clearTimeout(timer);
      timer = window.setTimeout(() => el.classList.remove('is-scrolling'), 900);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      clearTimeout(timer);
    };
  }, []);
  return ref;
}
