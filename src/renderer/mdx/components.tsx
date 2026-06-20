import type { ReactNode } from 'react';
import { useState } from 'react';

// The fixed, vetted component library. The MDX renderer will ONLY instantiate
// components whose tag name appears in `componentMap`; anything else renders as
// inert text. None of these execute model-supplied code.

type CalloutType = 'info' | 'warn' | 'success' | 'danger';

export function Callout({ type, children }: { type?: string; children?: ReactNode }) {
  const kind: CalloutType = (['info', 'warn', 'success', 'danger'] as const).includes(type as CalloutType)
    ? (type as CalloutType)
    : 'info';
  return <div className={`callout callout-${kind}`}>{children}</div>;
}

export function Steps({ children }: { children?: ReactNode }) {
  return <ol className="steps">{children}</ol>;
}

export function Step({ children }: { children?: ReactNode }) {
  return <li className="step">{children}</li>;
}

export function Collapsible({ title, children }: { title?: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`collapsible${open ? ' open' : ''}`}>
      <button type="button" className="collapsible-header" onClick={() => setOpen((v) => !v)}>
        <span className="collapsible-caret">{open ? '▾' : '▸'}</span>
        {title ?? 'Details'}
      </button>
      {open && <div className="collapsible-body">{children}</div>}
    </div>
  );
}

export function CodeBlock({ lang, value }: { lang?: string; value: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="code-block-wrap">
      <button
        type="button"
        className="code-copy"
        onClick={copy}
        aria-label={copied ? 'Copied' : 'Copy code'}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre className="code-block" data-lang={lang ?? ''}>
        <code>{value}</code>
      </pre>
    </div>
  );
}

type ComponentEntry = (props: Record<string, string>, children: ReactNode) => ReactNode;

/** Allow-list of model-usable components, keyed by tag name. */
export const componentMap: Record<string, ComponentEntry> = {
  Callout: (props, children) => <Callout type={props.type}>{children}</Callout>,
  Steps: (_props, children) => <Steps>{children}</Steps>,
  Step: (_props, children) => <Step>{children}</Step>,
  Collapsible: (props, children) => <Collapsible title={props.title}>{children}</Collapsible>
};
