import { isValidElement, type ReactNode } from 'react';
import { useMdxActions, useMdxMessage } from './ActionContext';
import { collectByType } from './components';

// <Replies>: two to four suggested follow-ups under an answer. Clicking one
// sends its text as the user's next message, through the same path as typing.
// Only the newest settled reply shows them, and only where something can be
// sent (a chat, not the Inbox); once the user sends anything they are gone,
// because that reply is no longer the newest.

export function Reply({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

function text(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  if (isValidElement(node)) return text((node.props as { children?: ReactNode }).children);
  return '';
}

/** Reply markers, found through the Fragments and host wrappers the renderer adds. */
function replies(children: ReactNode): string[] {
  return collectByType<{ children?: ReactNode }>(children, Reply)
    .map((r) => text(r.props.children).trim())
    .filter(Boolean)
    .slice(0, 4);
}

export function Replies({ children }: { children?: ReactNode }) {
  const actions = useMdxActions();
  const { isLatest } = useMdxMessage();
  if (!actions || !isLatest) return null;
  const items = replies(children);
  if (!items.length) return null;
  return (
    <div className="mdx-replies" role="group" aria-label="Suggested replies">
      {items.map((t) => (
        <button
          key={t}
          type="button"
          className="mdx-reply"
          disabled={actions.running}
          onClick={() => {
            if (!actions.running) actions.submit(t);
          }}
        >
          {t}
        </button>
      ))}
    </div>
  );
}
