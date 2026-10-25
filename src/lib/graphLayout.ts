import { hashUnit } from "./board";

export interface GraphEdge { s: string; t: string }
export interface GraphInput { paths: string[]; edges: GraphEdge[] }
export interface GraphPosition { id: string; x: number; y: number }

/** Exact local repulsion, indexed into 300-unit cells instead of scanning distant pairs. */
export function layoutGraph({ paths, edges }: GraphInput): GraphPosition[] {
  const nodes = paths.map((id, i) => ({ id, x: Math.cos(i * 2.4) * (40 + i * 6), y: Math.sin(i * 2.4) * (40 + i * 6), vx: 0, vy: 0 }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const iterations = nodes.length > 1500 ? 60 : 220;
  for (let it = 0; it < iterations; it++) {
    const cool = 1 - it / iterations;
    const cells = new Map<string, number[]>();
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const key = `${Math.floor(n.x / 300)},${Math.floor(n.y / 300)}`;
      const cell = cells.get(key);
      if (cell) cell.push(i); else cells.set(key, [i]);
    }
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      const cx = Math.floor(a.x / 300), cy = Math.floor(a.y / 300);
      for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
        for (const j of cells.get(`${cx + ox},${cy + oy}`) ?? []) {
          if (j <= i) continue;
          const b = nodes[j];
          let dx = a.x - b.x, dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 > 90000) continue;
          if (d2 < 1) { dx = hashUnit(a.id + b.id); dy = hashUnit(b.id + a.id); d2 = 1; }
          const f = (90 * 90) / d2;
          a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
        }
      }
    }
    for (const e of edges) {
      const a = byId.get(e.s), b = byId.get(e.t);
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.max(1, Math.hypot(dx, dy));
      const f = (d - 90) * 0.012;
      a.vx += (dx / d) * f * d * 0.05; a.vy += (dy / d) * f * d * 0.05;
      b.vx -= (dx / d) * f * d * 0.05; b.vy -= (dy / d) * f * d * 0.05;
    }
    for (const n of nodes) {
      n.vx -= n.x * 0.004; n.vy -= n.y * 0.004;
      n.x += Math.max(-30, Math.min(30, n.vx)) * cool * 0.5;
      n.y += Math.max(-30, Math.min(30, n.vy)) * cool * 0.5;
      n.vx *= 0.6; n.vy *= 0.6;
    }
  }
  return nodes.map(({ id, x, y }) => ({ id, x, y }));
}
