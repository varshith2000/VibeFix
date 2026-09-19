import { useEffect, useRef, useState } from "react";

let renderCount = 0;

/** Renders a mermaid diagram; falls back to the raw source on parse failure. */
export function Mermaid({ chart, compact = false }: { chart: string; compact?: boolean }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const idRef = useRef(`mmd-${++renderCount}`);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    // Dynamic import: mermaid is heavy; it only loads when a diagram is shown.
    import("mermaid")
      .then(async (mermaid) => {
        mermaid.default.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict" });
        const { svg } = await mermaid.default.render(idRef.current, chart);
        if (!cancelled) setSvg(svg);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [chart]);

  if (failed) {
    return (
      <pre className="overflow-x-auto rounded border border-slate-800 bg-ink-950 p-2 font-mono text-[10px] text-slate-400">
        {chart}
      </pre>
    );
  }
  if (!svg) {
    return <div className="flex h-24 items-center justify-center text-[11px] text-slate-600">rendering diagram…</div>;
  }
  return (
    <div
      className={`overflow-x-auto rounded border border-slate-800 bg-ink-950 p-2 ${compact ? "max-h-56" : ""}`}
      // mermaid.render output with securityLevel:strict is sanitized SVG
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
