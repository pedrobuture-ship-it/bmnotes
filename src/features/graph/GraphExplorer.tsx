import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { useWorkspace } from "@/stores/workspace";
import { useUi } from "@/stores/ui";
import { hashUnit } from "@/lib/board";
import { EmptyBoard } from "@/components/doodles";
import { useTr } from "@/lib/i18n";

import { WorkerQueue } from "@/lib/workerQueue";
import type { GraphInput, GraphPosition } from "@/lib/graphLayout";
interface GNode { id: string; title: string; x: number; y: number; degree: number; tags: string[] }
const layouts = new WorkerQueue<GraphInput, GraphPosition[]>(() => new Worker(new URL("../../workers/graph.worker.ts", import.meta.url), { type: "module" }));

const COLORS = ["#d9a441", "#86a873", "#6f9bb5", "#c98a9a", "#9c86b5", "#c8553d", "#e6c75a"];

function wobblyPath(a: GNode, b: GNode): string {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.max(1, Math.hypot(dx, dy));
  const bend = hashUnit(a.id + b.id) * len * 0.12;
  const mx = a.x + dx / 2 + (-dy / len) * bend;
  const my = a.y + dy / 2 + (dx / len) * bend;
  return `M${a.x.toFixed(1)} ${a.y.toFixed(1)} Q${mx.toFixed(1)} ${my.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
}

export function GraphExplorer() {
  const tr = useTr();
  const meta = useWorkspace((s) => s.index.meta);
  const tagsIdx = useWorkspace((s) => s.index.tags);
  const openNote = useUi((s) => s.openNote);
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ width: 1200, height: 800 });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  // Titles/tags/content can change without changing the graph's topology.
  const signature = useMemo(() => JSON.stringify([...meta.values()].map((m) => [m.path, m.links])), [meta]);
  const input = useMemo<GraphInput>(() => {
    const entries = JSON.parse(signature) as [string, string[]][];
    return { paths: entries.map(([path]) => path), edges: entries.flatMap(([s, links]) => links.map((t) => ({ s, t }))) };
  }, [signature]);
  const [positions, setPositions] = useState<{ input: GraphInput; points: GraphPosition[] } | null>(null);
  const [layoutError, setLayoutError] = useState(false);
  useEffect(() => {
    if (input.paths.length === 0) return;
    let cancelled = false;
    setLayoutError(false);
    const job = layouts.submit(input);
    job.promise.then((points) => {
      if (!cancelled) setPositions({ input, points });
    }).catch(() => { if (!cancelled) setLayoutError(true); });
    return () => { cancelled = true; job.cancel(); };
  }, [input]);
  const edges = input.edges;
  const nodes = useMemo<GNode[]>(() => {
    const degree = new Map<string, number>();
    for (const e of input.edges) {
      degree.set(e.s, (degree.get(e.s) ?? 0) + 1);
      degree.set(e.t, (degree.get(e.t) ?? 0) + 1);
    }
    // Show deterministic initial positions if the worker fails; navigation still works.
    const points = positions?.input === input ? positions.points : input.paths.map((id, i) => ({ id, x: Math.cos(i * 2.4) * (40 + i * 6), y: Math.sin(i * 2.4) * (40 + i * 6) }));
    return points.map((p) => ({ ...p, title: meta.get(p.id)?.title ?? p.id, tags: meta.get(p.id)?.tags ?? [], degree: degree.get(p.id) ?? 0 }));
  }, [positions, input, meta]);
  const pending = positions?.input !== input && nodes.length > 0 && !layoutError;

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const q = query.trim().toLowerCase();
  const tagSet = tag ? new Set(tagsIdx.get(tag) ?? []) : null;
  const matches = (n: GNode) => (!q || n.title.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)) && (!tagSet || tagSet.has(n.id));
  const neighbors = useMemo(() => {
    const s = new Set<string>();
    if (hover) {
      s.add(hover);
      for (const e of edges) {
        if (e.s === hover) s.add(e.t);
        if (e.t === hover) s.add(e.s);
      }
    }
    return s;
  }, [hover, edges]);

  // wheel zoom around the cursor (non-passive so we can prevent page scroll)
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left - r.width / 2, my = e.clientY - r.top - r.height / 2;
      setView((v) => {
        const k = Math.max(0.1, Math.min(4, v.k * Math.exp(-e.deltaY * 0.0015)));
        return { k, x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k };
      });
    };
    const resize = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    resize.observe(el);
    el.addEventListener("wheel", wheel, { passive: false });
    return () => { resize.disconnect(); el.removeEventListener("wheel", wheel); };
  }, []);

  const bounds = { left: (-size.width / 2 - view.x - 80) / view.k, right: (size.width / 2 - view.x + 80) / view.k, top: (-size.height / 2 - view.y - 80) / view.k, bottom: (size.height / 2 - view.y + 80) / view.k };
  const visibleNodes = nodes.filter((n) => n.x >= bounds.left && n.x <= bounds.right && n.y >= bounds.top && n.y <= bounds.bottom);
  const allTags = useMemo(() => [...tagsIdx.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 12), [tagsIdx]);

  if (nodes.length === 0) {
    return (
      <div className="empty h-full"><EmptyBoard /><p className="hand">{tr("Nothing to explore yet.")}</p><p>{tr("Create notes and link them with [[wiki links]].")}</p></div>
    );
  }

  return (
    <div className="graph-root" aria-busy={pending}>
      {pending && <span className="sr-only" role="status">{tr("Laying out the graph…")}</span>}
      <div className="board-hud">
        <div className="relative" style={{ width: 240 }}>
          <Search size={15} className="absolute" style={{ left: 10, top: 10, color: "var(--ink-faint)" }} />
          <input className="field" style={{ paddingLeft: 32 }} placeholder={tr("Find a note…")} value={query} onChange={(e) => setQuery(e.target.value)} aria-label={tr("Search the graph")} />
        </div>
        {allTags.map(([t, p]) => (
          <button key={t} className="chip" data-active={tag === t} onClick={() => setTag(tag === t ? null : t)}>#{t} <span style={{ opacity: 0.6 }}>{p.length}</span></button>
        ))}
        {(tag || query) && <button className="btn btn-ghost btn-icon" onClick={() => { setTag(null); setQuery(""); }} aria-label={tr("Clear filters")}><X size={14} /></button>}
      </div>
      <svg
        ref={svgRef}
        role="img"
        aria-label={tr("Note graph")}
        onPointerDown={(e) => {
          if ((e.target as Element).closest(".graph-node")) return;
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d) setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
        }}
        onPointerUp={() => (drag.current = null)}
        style={{ cursor: drag.current ? "grabbing" : "grab", touchAction: "none" }}
      >
        <g style={{ transform: `translate(calc(50% + ${view.x}px), calc(50% + ${view.y}px)) scale(${view.k})` }}>
          {edges.map((e, i) => {
            const a = byId.get(e.s), b = byId.get(e.t);
            if (!a || !b) return null;
            // Include a margin for the curved edge; distant SVG elements need not mount.
            const margin = Math.hypot(b.x - a.x, b.y - a.y) * 0.12;
            if (Math.max(a.x, b.x) + margin < bounds.left || Math.min(a.x, b.x) - margin > bounds.right || Math.max(a.y, b.y) + margin < bounds.top || Math.min(a.y, b.y) - margin > bounds.bottom) return null;
            const hot = hover !== null && (e.s === hover || e.t === hover);
            const dim = (hover !== null && !hot) || !matches(a) || !matches(b);
            return <path key={i} className="graph-edge" d={wobblyPath(a, b)} data-hot={hot} data-dim={dim} />;
          })}
          {visibleNodes.map((n) => {
            const dim = !matches(n) || (hover !== null && !neighbors.has(n.id));
            const r = 6 + Math.min(14, Math.sqrt(n.degree) * 3.2);
            const color = COLORS[Math.floor((hashUnit(n.tags[0] ?? "x") + 1) * 3.49) % COLORS.length]!;
            return (
              <g
                key={n.id}
                className="graph-node"
                data-dim={dim}
                transform={`translate(${n.x.toFixed(1)} ${n.y.toFixed(1)})`}
                onMouseEnter={() => setHover(n.id)}
                onMouseLeave={() => setHover(null)}
                onClick={() => openNote(n.id)}
                tabIndex={0}
                role="button"
                aria-label={`Open ${n.title}`}
                onKeyDown={(e) => e.key === "Enter" && openNote(n.id)}
              >
                <circle r={r} fill={n.tags.length ? color : "#b9ad96"} />
                {(view.k > 0.55 || hover === n.id || neighbors.has(n.id) || (q && matches(n))) && <text y={r + 16} textAnchor="middle">{n.title.slice(0, 28)}</text>}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
