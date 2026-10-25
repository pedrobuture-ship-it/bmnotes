import type { BoardData, CardColor } from "@/types";
import { hashUnit } from "./board";

export interface ExportCard {
  path: string;
  title: string;
  /** Already-sanitised HTML of the note (from `renderMarkdown`). */
  html: string;
}

export interface ExportEdge {
  id: string;
  source: string;
  target: string;
}

export interface ExportInput {
  title: string;
  board: BoardData;
  cards: ExportCard[];
  edges: ExportEdge[];
  theme: "dark" | "light";
}

const PAPER: Record<CardColor, string> = { paper: "#ece3cf", yellow: "#ecdc92", green: "#cfdcb8", blue: "#c1d4dd", pink: "#edcacf", purple: "#d6cbe1", dark: "#2d2722" };
const FRAME_COLOR: Record<string, string> = { paper: "#8a7d6a", yellow: "#b99a2f", green: "#6d8f5a", blue: "#5b86a0", pink: "#b4707f", purple: "#8a76a3", dark: "#6a5d50" };

export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/** Replaces `bmnotes://` image URLs (which only work inside the app) using `resolve`; unknown ones are dropped. */
export function inlineAssets(html: string, resolve: (relPath: string) => string | null): string {
  return html.replace(/src="(?:bmnotes:\/\/localhost|http:\/\/bmnotes\.localhost)\/([^"]*)"/g, (_, enc: string) => {
    let rel = enc;
    try {
      rel = enc.split("/").map(decodeURIComponent).join("/");
    } catch {
      /* keep as is */
    }
    const data = resolve(rel);
    return data ? `src="${data}"` : 'src="" alt="image not included"';
  });
}

function edgePath(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }, id: string) {
  const dir = b.x + b.w / 2 >= a.x + a.w / 2 ? 1 : -1;
  const s = { x: dir > 0 ? a.x + a.w : a.x, y: a.y + a.h / 2 };
  const t = { x: dir > 0 ? b.x : b.x + b.w, y: b.y + b.h / 2 };
  const reach = Math.max(40, Math.abs(t.x - s.x) * 0.45);
  const sag = hashUnit(id) * 10;
  const c1 = { x: s.x + dir * reach, y: s.y + sag };
  const c2 = { x: t.x - dir * reach, y: t.y - sag };
  const ang = Math.atan2(t.y - c2.y, t.x - c2.x);
  const head = (da: number, l: number) => `${(t.x - Math.cos(ang + da) * l).toFixed(1)} ${(t.y - Math.sin(ang + da) * l).toFixed(1)}`;
  return {
    d: `M ${s.x} ${s.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${t.x} ${t.y}`,
    head: `M ${head(0.5, 13)} L ${t.x} ${t.y} L ${head(-0.45, 15)}`,
    mid: { x: (s.x + t.x) / 2, y: (s.y + t.y) / 2 },
  };
}

const CSS = (dark: boolean) => `
*{box-sizing:border-box}html,body{margin:0;height:100%;overflow:hidden;background:${dark ? "#14110f" : "#f1e6bd"};color:${dark ? "#efe6d2" : "#3a2f17"};font-family:Georgia,serif}
#vp{position:fixed;inset:0;cursor:grab;touch-action:none}#vp.drag{cursor:grabbing}#world{position:absolute;left:0;top:0;transform-origin:0 0}
.card{position:absolute;overflow:hidden;border-radius:3px 5px 3px 6px;box-shadow:1px 3px 8px rgba(0,0,0,.4);color:#2a241c;display:flex;flex-direction:column}
.card.dark{color:#efe6d2}.card h2.t{margin:0;padding:7px 12px 5px;font:700 19px/1.1 "Segoe Print","Comic Sans MS",cursive;border-bottom:2px dashed rgba(0,0,0,.18)}
.card .b{padding:8px 12px;font-size:14px;line-height:1.5;overflow:hidden;flex:1}.card .b h1,.card .b h2,.card .b h3{margin:.4em 0 .2em;font-size:1.15em}.card .b p{margin:.3em 0}
.card .b img{max-width:100%}.card .b pre{background:#231d17;color:#e9dfc8;padding:6px 8px;border-radius:4px;overflow:auto}.card .b code{font-family:ui-monospace,monospace;font-size:.9em}
.card .b table{border-collapse:collapse}.card .b td,.card .b th{border:1px solid rgba(0,0,0,.25);padding:2px 6px}.card .b a{color:#8a5a12}.card .b blockquote{margin:.4em 0;padding-left:10px;border-left:3px solid rgba(0,0,0,.3)}
.frame{position:absolute;border:2px dashed;border-radius:12px;padding:4px 10px;font:700 18px "Segoe Print","Comic Sans MS",cursive;opacity:.9}
svg{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}.edge{fill:none;stroke:${dark ? "#b9ad96" : "#6b5c38"};stroke-width:2.2;stroke-linecap:round}.lbl{font:15px "Segoe Print","Comic Sans MS",cursive;fill:#2a241c;paint-order:stroke;stroke:#ecdc92;stroke-width:6px}
.hint{position:fixed;left:12px;bottom:10px;font:13px sans-serif;opacity:.6}`;

const SCRIPT = `(function(){var vp=document.getElementById('vp'),w=document.getElementById('world'),W=+w.dataset.w,H=+w.dataset.h;var s=1,x=0,y=0;
function apply(){w.style.transform='translate('+x+'px,'+y+'px) scale('+s+')'}
function fit(){var k=Math.min(innerWidth/W,innerHeight/H,1)*.95;s=k;x=(innerWidth-W*k)/2;y=(innerHeight-H*k)/2;apply()}
vp.addEventListener('wheel',function(e){e.preventDefault();var f=e.deltaY<0?1.1:1/1.1,n=Math.min(3,Math.max(.05,s*f));x=e.clientX-(e.clientX-x)*n/s;y=e.clientY-(e.clientY-y)*n/s;s=n;apply()},{passive:false});
var d=null;vp.addEventListener('pointerdown',function(e){d={x:e.clientX-x,y:e.clientY-y};vp.classList.add('drag');vp.setPointerCapture(e.pointerId)});
vp.addEventListener('pointermove',function(e){if(d){x=e.clientX-d.x;y=e.clientY-d.y;apply()}});
vp.addEventListener('pointerup',function(){d=null;vp.classList.remove('drag')});addEventListener('resize',fit);fit()})();`;

/** One self-contained HTML page of the mural: cards, frames and arrows, with scroll-to-zoom and drag-to-pan. */
export function buildBoardHtml(input: ExportInput): string {
  const { board, cards, edges, theme } = input;
  const byPath = new Map(cards.map((c) => [c.path, c]));
  const placed = Object.entries(board.cards).filter(([p]) => byPath.has(p));
  const rects = [
    ...placed.map(([, c]) => ({ x: c.x, y: c.y, w: c.w, h: c.h })),
    ...board.frames.map((f) => ({ x: f.x, y: f.y, w: f.w, h: f.h })),
  ];
  const minX = rects.length ? Math.min(...rects.map((r) => r.x)) - 40 : 0;
  const minY = rects.length ? Math.min(...rects.map((r) => r.y)) - 40 : 0;
  const maxX = rects.length ? Math.max(...rects.map((r) => r.x + r.w)) + 40 : 400;
  const maxY = rects.length ? Math.max(...rects.map((r) => r.y + r.h)) + 40 : 300;
  const W = Math.round(maxX - minX);
  const H = Math.round(maxY - minY);
  const at = (r: { x: number; y: number; w: number; h: number }) => ({ x: r.x - minX, y: r.y - minY, w: r.w, h: r.h });

  const frames = board.frames
    .map((f) => {
      const r = at(f);
      const col = FRAME_COLOR[f.color] ?? FRAME_COLOR.paper;
      return `<div class="frame" style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;border-color:${col};color:${col}">${esc(f.title)}</div>`;
    })
    .join("");

  const rectOf = new Map(placed.map(([p, c]) => [p, at(c)]));
  const svg = edges
    .filter((e) => rectOf.has(e.source) && rectOf.has(e.target) && e.source !== e.target)
    .map((e) => {
      const p = edgePath(rectOf.get(e.source)!, rectOf.get(e.target)!, e.id);
      const label = board.labels[e.id];
      return `<path class="edge" d="${p.d}"/><path class="edge" d="${p.head}"/>${label ? `<text class="lbl" x="${p.mid.x}" y="${p.mid.y}" text-anchor="middle">${esc(label)}</text>` : ""}`;
    })
    .join("");

  const cardHtml = placed
    .map(([p, c]) => {
      const r = at(c);
      const card = byPath.get(p)!;
      return `<article class="card${c.color === "dark" ? " dark" : ""}" style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;background:${PAPER[c.color] ?? PAPER.paper}"><h2 class="t">${esc(card.title)}</h2><div class="b">${card.html}</div></article>`;
    })
    .join("");

  const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'unsafe-inline'";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}"><title>${esc(input.title)}</title><style>${CSS(theme === "dark")}</style></head>
<body><div id="vp"><div id="world" data-w="${W}" data-h="${H}" style="width:${W}px;height:${H}px">${frames}<svg width="${W}" height="${H}">${svg}</svg>${cardHtml}</div></div>
<div class="hint">Scroll to zoom · drag to move · made with bmnotes</div><script>${SCRIPT}</script></body></html>
`;
}
