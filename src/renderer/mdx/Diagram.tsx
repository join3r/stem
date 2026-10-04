import { useEffect, useId, useState } from 'react';
import { CodeBlock } from './components';

// <Diagram> draws Mermaid source (flowcharts, sequence diagrams, timelines…).
// mermaid is several MB, so it is imported on first use and never by the
// server bundle. securityLevel 'strict' sanitizes labels and disables click
// handlers, so a diagram can only be a picture. The theme is read from Stem's
// own tokens and redrawn when the theme changes. A diagram mermaid can't parse
// falls back to its source in a code block.

type Mermaid = typeof import('mermaid').default;
type Purify = typeof import('dompurify').default;
let loading: Promise<{ mermaid: Mermaid; purify: Purify }> | null = null;
/** Both load on the first diagram, in their own chunk, never with the app. */
function loadMermaid(): Promise<{ mermaid: Mermaid; purify: Purify }> {
  loading ??= Promise.all([import('mermaid'), import('dompurify')]).then(([m, p]) => ({
    mermaid: m.default,
    purify: p.default
  }));
  return loading;
}

function themeVariables(): Record<string, string> {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const surface = v('--surface', '#fffdf9');
  const ink = v('--ink', '#23211d');
  const line = v('--line', '#e0dccf');
  const muted = v('--muted', '#6d675d');
  return {
    fontFamily: v('--font-ui', 'system-ui, sans-serif'),
    fontSize: '13px',
    background: 'transparent',
    primaryColor: surface,
    primaryTextColor: ink,
    primaryBorderColor: muted,
    secondaryColor: v('--inline-bg', '#efeae0'),
    tertiaryColor: v('--content', '#faf8f3'),
    lineColor: muted,
    textColor: ink,
    mainBkg: surface,
    nodeBorder: muted,
    clusterBkg: v('--content', '#faf8f3'),
    clusterBorder: line,
    edgeLabelBackground: v('--content', '#faf8f3'),
    actorBkg: surface,
    actorBorder: muted,
    actorTextColor: ink,
    signalColor: ink,
    signalTextColor: ink,
    noteBkgColor: v('--inline-bg', '#efeae0'),
    noteTextColor: ink,
    noteBorderColor: line
  };
}

/** Bumps whenever the app's theme flips, so diagrams redraw in the new colors. */
function useThemeKey(): number {
  const [key, setKey] = useState(0);
  useEffect(() => {
    const bump = () => setKey((k) => k + 1);
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', bump);
    const observer = new MutationObserver(bump);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      media.removeEventListener('change', bump);
      observer.disconnect();
    };
  }, []);
  return key;
}

export function Diagram({ title, source }: { title?: string; source?: string }) {
  const id = `mdx-diagram-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const themeKey = useThemeKey();
  const [state, setState] = useState<{ svg: string } | { error: true } | null>(null);
  const code = (source ?? '').trim();

  useEffect(() => {
    if (!code) return;
    let live = true;
    void (async () => {
      try {
        const { mermaid, purify } = await loadMermaid();
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'base',
          themeVariables: themeVariables(),
          // Plain SVG text labels: HTML labels ride in <foreignObject>, which
          // the SVG sanitizer below rightly strips, leaving empty boxes.
          htmlLabels: false,
          flowchart: { htmlLabels: false, curve: 'basis' },
          sequence: { messageFontSize: 13, actorFontSize: 13, noteFontSize: 13 }
        });
        // Parse first: a failed render leaves mermaid's own error graphic in
        // the page body, and the source is shown as code instead anyway.
        if (!(await mermaid.parse(code, { suppressErrors: true }))) throw new Error('unparseable diagram');
        const renderId = `${id}-${themeKey}`;
        let svg: string;
        try {
          ({ svg } = await mermaid.render(renderId, code));
        } finally {
          document.getElementById(`d${renderId}`)?.remove();
        }
        // Mermaid sanitizes labels itself under 'strict'; the source is model
        // text, so the finished SVG goes through DOMPurify's SVG profile as well.
        const clean = purify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, ADD_TAGS: ['style'] });
        if (live) setState({ svg: clean });
      } catch {
        if (live) setState({ error: true });
      }
    })();
    return () => {
      live = false;
    };
  }, [code, id, themeKey]);

  if (!code) return <div className="chart-error">This diagram is empty.</div>;
  return (
    <figure className="mdx-diagram">
      {title && <figcaption className="chart-title">{title}</figcaption>}
      {state && 'svg' in state ? (
        // Mermaid's output, sanitized by it under 'strict' and again by DOMPurify.
        <div className="mdx-diagram-svg" dangerouslySetInnerHTML={{ __html: state.svg }} />
      ) : state && 'error' in state ? (
        <>
          <div className="mdx-diagram-note">Couldn’t draw this diagram; here is its source.</div>
          <CodeBlock lang="mermaid" value={code} />
        </>
      ) : (
        <div className="mdx-placeholder">
          <span className="mdx-placeholder-bar" aria-hidden="true" />
          <span className="mdx-placeholder-label">Drawing diagram…</span>
        </div>
      )}
    </figure>
  );
}
