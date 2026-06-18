import { memo, useMemo } from 'react';
import { renderMdx } from '../mdx/render';

/** Renders finalized assistant text as the safe MDX subset (memoized by content). */
export const MdxView = memo(function MdxView({ text }: { text: string }) {
  const content = useMemo(() => renderMdx(text), [text]);
  return <div className="mdx">{content}</div>;
});
