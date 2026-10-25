import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ConnectionMode, Controls, MiniMap, ReactFlow, SelectionMode, applyEdgeChanges, applyNodeChanges, getViewportForBounds,
  useReactFlow, useStore, type Connection, type Edge, type EdgeChange, type Node, type NodeChange, type NodeTypes, type EdgeTypes,
  ViewportPortal,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { FileDown, AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignHorizontalDistributeCenter, AlignStartHorizontal, AlignStartVertical, AlignVerticalDistributeCenter, BoxSelect, Copy, Lock, ExternalLink, FilePlus, Frame as FrameIcon, Maximize, Pencil, Trash2 } from "lucide-react";
import { useBoard, MAIN_BOARD } from "@/stores/board";
import { BoardTabs } from "./BoardTabs";
import { BoardBackground } from "./BoardBackground";
import { useTr } from "@/lib/i18n";
import { exportBoardAsHtml } from "@/lib/exportAction";
import { firstCard, nearestInDirection, type Dir } from "@/lib/boardNav";
import { alignRects, distributeRects, snapRect, type AlignMode, type Rect } from "@/lib/align";
import { useWorkspace } from "@/stores/workspace";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { Menu, useContextMenu, type MenuEntry } from "@/components/Menu";
import { EmptyBoard, ArrowDoodle } from "@/components/doodles";
import { NoteNode, type NoteNodeData } from "./NoteNode";
import { FrameNode, type FrameNodeData } from "./FrameNode";
import { SketchEdge } from "./SketchEdge";
import { onBoardCommand } from "./boardBus";
import { copyPath, deleteEntry, lockNote, removeEdge, duplicateNote, newFrameTitle, otherMurals, revealInFolder, sendToMural } from "@/lib/actions";
import { CARD_COLORS, type CardColor, type Viewport } from "@/types";
import { CARD_H, CARD_W } from "@/lib/board";
import { basename, stripExt } from "@/lib/paths";
import { isEncrypted } from "@/lib/crypto";

const nodeTypes: NodeTypes = { note: NoteNode, frame: FrameNode };
const edgeTypes: EdgeTypes = { sketch: SketchEdge };
const FRAME = "frame:";
const PAN_BUTTONS = [1, 2];
const SNAP_GRID: [number, number] = [22, 22];
const MINIMAP_COLORS: Record<CardColor, string> = {
  paper: "#ece3cf", yellow: "#ecdc92", green: "#cfdcb8", blue: "#c1d4dd", pink: "#edcacf", purple: "#d6cbe1", dark: "#4a4038",
};
const SWATCH: Record<CardColor, string> = {
  paper: "var(--card-paper)", yellow: "var(--card-yellow)", green: "var(--card-green)", blue: "var(--card-blue)",
  pink: "var(--card-pink)", purple: "var(--card-purple)", dark: "var(--card-dark)",
};

function Swatches({ current, onPick }: { current?: CardColor; onPick: (c: CardColor) => void }) {
  return (
    <div className="flex gap-1.5 flex-wrap">
      {CARD_COLORS.map((c) => (
        <button key={c} className="swatch" style={{ ["--c" as string]: SWATCH[c] }} aria-label={c} aria-pressed={current === c} data-tip={c} onClick={() => onPick(c)} />
      ))}
    </div>
  );
}

function sameNode(a: Node, b: Node): boolean {
  if (a.position.x !== b.position.x || a.position.y !== b.position.y || a.width !== b.width || a.height !== b.height || a.selected !== b.selected) return false;
  const da = a.data as Record<string, unknown>;
  const db = b.data as Record<string, unknown>;
  for (const k of Object.keys(db)) if (da[k] !== db[k]) return false;
  return true;
}

export function Board() {
  const board = useBoard((s) => s.board);
  const patchCards = useBoard((s) => s.patchCards);
  const patchFrame = useBoard((s) => s.patchFrame);
  const patchFrames = useBoard((s) => s.patchFrames);
  const addFrame = useBoard((s) => s.addFrame);
  const removeFrame = useBoard((s) => s.removeFrame);
  const setViewport = useBoard((s) => s.setViewport);
  const meta = useWorkspace((s) => s.index.meta);
  const noteCount = useWorkspace((s) => s.index.meta.size);
  const createNote = useWorkspace((s) => s.createNote);
  const settings = useSettings((s) => s.settings.board);
  const theme = useSettings((s) => s.settings.appearance.theme);
  const tagFilter = useUi((s) => s.tagFilter);
  const tagMembers = useWorkspace((s) => (tagFilter ? s.index.tags.get(tagFilter) : undefined));
  const setEditing = useUi((s) => s.setEditingCard);
  const setRenaming = useUi((s) => s.setRenamingCard);
  const openNote = useUi((s) => s.openNote);
  const { menu, open: openMenu, close } = useContextMenu();
  const rf = useReactFlow();
  const rootRef = useRef<HTMLDivElement>(null);
  const onMoveStart = useCallback(() => {
    close();
    // Update presentation without a React render on every viewport frame.
    rootRef.current?.setAttribute("data-navigating", "true");
  }, [close]);
  const onMoveEnd = useCallback((_: unknown, viewport: Viewport) => {
    rootRef.current?.removeAttribute("data-navigating");
    setViewport(viewport);
  }, [setViewport]);
  useEffect(() => {
    const reset = () => rootRef.current?.removeAttribute("data-navigating");
    window.addEventListener("blur", reset);
    return () => window.removeEventListener("blur", reset);
  }, []);
  const tr = useTr();
  // With thousands of links, hide the lines while zoomed far out (they're unreadable and expensive).
  const farOut = useStore((st) => st.transform[2] < 0.3);

  // Start already fitted (computed up front) so thousands of cards never render at zoom 1 first.
  const [initialViewport] = useState(() => {
    const st = useBoard.getState();
    const cards = Object.values(st.board.cards);
    if (st.hasFile || cards.length === 0) return st.board.viewport;
    const x1 = Math.min(...cards.map((c) => c.x)), y1 = Math.min(...cards.map((c) => c.y));
    const x2 = Math.max(...cards.map((c) => c.x + c.w)), y2 = Math.max(...cards.map((c) => c.y + c.h));
    const vp = getViewportForBounds({ x: x1, y: y1, width: x2 - x1, height: y2 - y1 }, Math.max(400, window.innerWidth - 290), Math.max(300, window.innerHeight - 160), 0.05, 1, 0.12);
    return { x: vp.x, y: vp.y + 36, zoom: vp.zoom };
  });
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const nodesRef = useRef<Node[]>([]);
  nodesRef.current = nodes;
  const [guides, setGuides] = useState<{ x: number | null; y: number | null }>({ x: null, y: null });
  const snapRef = useRef<{ id: string; x: number; y: number } | null>(null);
  const dragRef = useRef<{ frame: string; start: { x: number; y: number }; members: Map<string, { x: number; y: number }> } | null>(null);

  /**
   * "Move to / Add to another mural…" (a searchable picker), and "Remove from this mural" when an extra one is on screen.
   * Right-clicking a card that is part of a selection acts on every selected card.
   */
  const boardEntries = (path: string): MenuEntry[] => {
    const st = useBoard.getState();
    const picked = nodesRef.current.filter((n) => n.selected && n.type === "note").map((n) => n.id);
    const paths = picked.includes(path) ? picked : [path];
    const count = paths.length > 1 ? ` (${paths.length})` : "";
    const curated = st.activeId !== MAIN_BOARD;
    const out: MenuEntry[] = [];
    if (otherMurals().length > 0) {
      if (curated) out.push({ label: tr("Move to another mural…") + count, onSelect: () => void sendToMural(paths, "move") });
      out.push({ label: tr("Add to another mural…") + count, onSelect: () => void sendToMural(paths, "add") });
    }
    if (curated) out.push({ label: tr("Remove from this mural") + count, onSelect: () => paths.forEach((p) => st.removePaths(p, false)) });
    return out.length ? [...out, { separator: true }] : [];
  };

  const showMenu = useCallback(
    (path: string, x: number, y: number) => {
      const color = useBoard.getState().board.cards[path]?.color;
      const entries: MenuEntry[] = [
        { label: "Edit here", icon: <Pencil size={15} />, onSelect: () => (isEncrypted(useWorkspace.getState().notes[path]?.content ?? "") ? openNote(path) : setEditing(path)) },
        { label: "Open as page", icon: <ExternalLink size={15} />, onSelect: () => openNote(path) },
        { separator: true },
        { label: "Color", heading: true },
        { custom: <Swatches current={color} onPick={(c) => { patchCards({ [path]: { color: c } }); close(); }} /> },
        { separator: true },
        ...boardEntries(path),
        { label: "Encrypt with a password…", icon: <Lock size={15} />, onSelect: () => void lockNote(path) },
        { label: "Duplicate", icon: <Copy size={15} />, onSelect: () => void duplicateNote(path) },
        { label: "Reveal file", onSelect: () => void revealInFolder(path) },
        { label: "Copy path", onSelect: () => void copyPath(path) },
        { separator: true },
        { label: "Delete", icon: <Trash2 size={15} />, danger: true, onSelect: () => void deleteEntry(path, false) },
      ];
      openMenu({ clientX: x, clientY: y, preventDefault() {} }, entries);
    },
    [close, openMenu, openNote, patchCards, setEditing],
  );

  const showFrameMenu = useCallback(
    (id: string, x: number, y: number) => {
      const frame = useBoard.getState().board.frames.find((f) => f.id === id);
      openMenu({ clientX: x, clientY: y, preventDefault() {} }, [
        { label: "Color", heading: true },
        { custom: <Swatches current={frame?.color} onPick={(c) => { patchFrame(id, { color: c }); close(); }} /> },
        { separator: true },
        { label: "Delete frame (notes stay)", icon: <Trash2 size={15} />, danger: true, onSelect: () => removeFrame(id) },
      ]);
    },
    [close, openMenu, patchFrame, removeFrame],
  );

  // Rebuild React Flow nodes from the board + notes, keeping selection.
  // Unchanged nodes keep their object identity so typing in one note doesn't re-render thousands of cards.
  useEffect(() => {
    setNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
      const selected = new Set(prev.filter((n) => n.selected).map((n) => n.id));
      const out: Node[] = board.frames.map((f) => ({
        id: FRAME + f.id,
        type: "frame",
        position: { x: f.x, y: f.y },
        width: f.w,
        height: f.h,
        zIndex: 0,
        selected: selected.has(FRAME + f.id),
        dragHandle: ".frame-drag",
        style: { pointerEvents: "none" },
        data: { id: f.id, title: f.title, color: f.color, onMenu: showFrameMenu } satisfies FrameNodeData,
      }));
      for (const [path, c] of Object.entries(board.cards)) {
        if (!meta.has(path)) continue;
        out.push({
          id: path,
          type: "note",
          position: { x: c.x, y: c.y },
          width: c.w,
          height: c.h,
          zIndex: 1,
          selected: selected.has(path),
          ariaLabel: meta.get(path)?.title ?? path,
          data: { path, color: c.color, dim: tagFilter ? !tagMembers?.includes(path) : false, onMenu: showMenu } satisfies NoteNodeData,
        });
      }
      return out.map((n) => {
        const old = prevById.get(n.id);
        return old && sameNode(old, n) ? old : n;
      });
    });
  }, [board.cards, board.frames, meta, tagFilter, tagMembers, showMenu, showFrameMenu]);

  // Edges: wiki links (automatic) + manual connections.
  useEffect(() => {
    if (!settings.showConnections) {
      setEdges([]);
      return;
    }
    setEdges((prev) => {
      const selected = new Set(prev.filter((e) => e.selected).map((e) => e.id));
      const prevById = new Map(prev.map((e) => [e.id, e]));
      const out: Edge[] = [];
      for (const [path, m] of meta) {
        if (!board.cards[path]) continue;
        for (const target of m.links) {
          if (!board.cards[target]) continue;
          const id = `auto:${path}->${target}`;
          out.push({ id, source: path, target, type: "sketch", selected: selected.has(id), data: { manual: false, label: board.labels[id] ?? "" } });
        }
      }
      for (const c of board.connections) {
        if (!board.cards[c.source] || !board.cards[c.target]) continue;
        out.push({ id: c.id, source: c.source, target: c.target, type: "sketch", selected: selected.has(c.id), data: { manual: true, label: board.labels[c.id] ?? "" } });
      }
      return out.map((e) => {
        const old = prevById.get(e.id);
        return old && old.source === e.source && old.target === e.target && old.selected === e.selected && old.data?.label === e.data?.label && old.data?.manual === e.data?.manual ? old : e;
      });
    });
  }, [meta, board.cards, board.connections, board.labels, settings.showConnections]);

  const onNodesChange = useCallback((changes: NodeChange[]) => setNodes((ns) => applyNodeChanges(changes, ns)), []);
  const onEdgesChange = useCallback((changes: EdgeChange[]) => setEdges((es) => applyEdgeChanges(changes, es)), []);

  const persistNodes = useCallback(
    (list: Node[]) => {
      const cards: Record<string, { x: number; y: number; w?: number; h?: number }> = {};
      const frames: Record<string, { x: number; y: number; w?: number; h?: number }> = {};
      for (const n of list) {
        const w = n.measured?.width ?? n.width;
        const h = n.measured?.height ?? n.height;
        const patch = { x: Math.round(n.position.x), y: Math.round(n.position.y), ...(w && h ? { w: Math.round(w), h: Math.round(h) } : {}) };
        if (n.id.startsWith(FRAME)) frames[n.id.slice(FRAME.length)] = patch;
        else cards[n.id] = patch;
      }
      if (Object.keys(cards).length) patchCards(cards);
      if (Object.keys(frames).length) patchFrames(frames);
    },
    [patchCards, patchFrames],
  );

  const onNodeDragStart = useCallback(
    (_: unknown, node: Node) => {
      if (!node.id.startsWith(FRAME)) return;
      const f = useBoard.getState().board.frames.find((x) => x.id === node.id.slice(FRAME.length));
      if (!f) return;
      const members = new Map<string, { x: number; y: number }>();
      for (const [p, c] of Object.entries(useBoard.getState().board.cards)) {
        const cx = c.x + c.w / 2;
        const cy = c.y + c.h / 2;
        if (cx >= f.x && cx <= f.x + f.w && cy >= f.y && cy <= f.y + f.h) members.set(p, { x: c.x, y: c.y });
      }
      dragRef.current = { frame: node.id, start: { x: f.x, y: f.y }, members };
    },
    [],
  );

  const onNodeDrag = useCallback((_: unknown, node: Node) => {
    if (!node.id.startsWith(FRAME) && !nodesRef.current.some((n) => n.selected && n.id !== node.id)) {
      // Magnetic guides: line the card up with the edges and centres of the others.
      const rect = (n: Node): Rect => ({ id: n.id, x: n.position.x, y: n.position.y, w: n.measured?.width ?? n.width ?? CARD_W, h: n.measured?.height ?? n.height ?? CARD_H });
      const s = snapRect(rect(node), nodesRef.current.filter((n) => n.id !== node.id).map(rect), 6 / Math.max(0.05, rf.getZoom()));
      setGuides((g) => (g.x === s.guideX && g.y === s.guideY ? g : { x: s.guideX, y: s.guideY }));
      if (s.dx || s.dy) {
        const pos = { x: node.position.x + s.dx, y: node.position.y + s.dy };
        snapRef.current = { id: node.id, ...pos };
        setNodes((ns) => ns.map((n) => (n.id === node.id ? { ...n, position: pos } : n)));
      } else snapRef.current = null;
    }
    const d = dragRef.current;
    if (!d || d.frame !== node.id) return;
    const dx = node.position.x - d.start.x;
    const dy = node.position.y - d.start.y;
    setNodes((ns) => ns.map((n) => (d.members.has(n.id) ? { ...n, position: { x: d.members.get(n.id)!.x + dx, y: d.members.get(n.id)!.y + dy } } : n)));
  }, []);

  const onNodeDragStop = useCallback(
    (_: unknown, node: Node, dragged: Node[]) => {
      const d = dragRef.current;
      dragRef.current = null;
      setGuides({ x: null, y: null });
      const list = new Map<string, Node>();
      for (const n of dragged.length ? dragged : [node]) list.set(n.id, n);
      const snapped = snapRef.current;
      snapRef.current = null;
      if (snapped && list.has(snapped.id)) list.set(snapped.id, { ...list.get(snapped.id)!, position: { x: snapped.x, y: snapped.y } });
      if (d && d.frame === node.id) {
        // Derive member positions from the frame's final position (the last drag tick may not be rendered yet).
        const dx = node.position.x - d.start.x;
        const dy = node.position.y - d.start.y;
        for (const n of nodesRef.current) {
          const origin = d.members.get(n.id);
          if (origin) list.set(n.id, { ...n, position: { x: origin.x + dx, y: origin.y + dy } });
        }
        setNodes((ns) => ns.map((n) => (list.has(n.id) && d.members.has(n.id) ? list.get(n.id)! : n)));
      }
      persistNodes([...list.values()]);
    },
    [persistNodes],
  );

  // Connecting two cards writes a [[wiki link]] into the source note; the edge then appears from the link itself.
  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target || c.source === c.target || c.source.startsWith(FRAME) || c.target.startsWith(FRAME)) return;
    const ws = useWorkspace.getState();
    const note = ws.notes[c.source];
    if (!note || !ws.notes[c.target]) return;
    if (ws.index.meta.get(c.source)?.links.includes(c.target)) return;
    const base = stripExt(basename(c.target));
    const unique = ws.index.resolver.resolve(base) === c.target;
    const name = unique ? base : stripExt(c.target);
    const sep = note.content === "" || note.content.endsWith("\n") ? "" : "\n";
    ws.setContent(c.source, `${note.content}${sep}[[${name}]]\n`);
  }, []);

  const flowCenter = useCallback(() => {
    const el = document.querySelector(".board-root")?.getBoundingClientRect();
    return rf.screenToFlowPosition({ x: (el?.left ?? 0) + (el?.width ?? 800) / 2, y: (el?.top ?? 0) + (el?.height ?? 600) / 2 });
  }, [rf]);

  const createNoteAt = useCallback(
    async (pos: { x: number; y: number }) => {
      const path = await createNote("", "Untitled", "");
      if (!path) return;
      useBoard.getState().ensureCard(path, { x: Math.round(pos.x), y: Math.round(pos.y) });
      // ensureCard keeps an existing auto-layout slot; force the click position for brand-new notes.
      patchCards({ [path]: { x: Math.round(pos.x), y: Math.round(pos.y) } });
      setRenaming(path);
    },
    [createNote, patchCards, setRenaming],
  );

  const createFrameAt = useCallback(
    async (pos: { x: number; y: number }) => {
      const title = await newFrameTitle();
      if (!title) return;
      addFrame({ id: `f-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, title: title.slice(0, 40), color: "paper", x: Math.round(pos.x), y: Math.round(pos.y), w: 520, h: 360 });
    },
    [addFrame],
  );

  useEffect(
    () =>
      onBoardCommand((a) => {
        if (a === "fit") void rf.fitView({ duration: 350, padding: 0.15 });
        if (a === "zoomIn") void rf.zoomIn({ duration: 180 });
        if (a === "zoomOut") void rf.zoomOut({ duration: 180 });
        if (a === "newFrame") {
          const c = flowCenter();
          void createFrameAt({ x: c.x - 260, y: c.y - 180 });
        }
        if (a === "newNote") {
          const c = flowCenter();
          void createNoteAt({ x: c.x - CARD_W / 2, y: c.y - CARD_H / 2 });
        }
      }),
    [rf, flowCenter, createFrameAt, createNoteAt],
  );

  const selectedCards = useMemo(() => nodes.filter((n) => n.selected && n.type === "note"), [nodes]);
  const selectedFrames = useMemo(() => nodes.filter((n) => n.selected && n.type === "frame"), [nodes]);
  const selectedEdges = useMemo(() => edges.filter((e) => e.selected), [edges]);

  const groupInFrame = useCallback(async () => {
    if (selectedCards.length === 0) return;
    const title = await newFrameTitle();
    if (!title) return;
    const pad = 36;
    const xs = selectedCards.map((n) => n.position.x);
    const ys = selectedCards.map((n) => n.position.y);
    const xe = selectedCards.map((n) => n.position.x + (n.measured?.width ?? n.width ?? CARD_W));
    const ye = selectedCards.map((n) => n.position.y + (n.measured?.height ?? n.height ?? CARD_H));
    const x = Math.min(...xs) - pad;
    const y = Math.min(...ys) - pad - 14;
    addFrame({ id: `f-${Date.now().toString(36)}`, title: title.slice(0, 40), color: "paper", x: Math.round(x), y: Math.round(y), w: Math.round(Math.max(...xe) + pad - x), h: Math.round(Math.max(...ye) + pad - y) });
  }, [selectedCards, addFrame]);

  const deleteSelection = useCallback(async () => {
    if (selectedEdges.length) {
      selectedEdges.forEach((e) => removeEdge(e.id, e.source, e.target));
      if (selectedCards.length === 0 && selectedFrames.length === 0) return;
    }
    selectedFrames.forEach((n) => removeFrame(n.id.slice(FRAME.length)));
    if (selectedCards.length === 0) return;
    // On an extra mural, Delete only takes the card off the mural; the note files are never touched.
    if (useBoard.getState().activeId !== MAIN_BOARD) {
      selectedCards.forEach((n) => useBoard.getState().removePaths(n.id, false));
      useUi.getState().toast("Removed from this mural. The notes are still in your folder.", "info");
      return;
    }
    const ui = useUi.getState();
    const ok = await ui.confirm({
      title: selectedCards.length > 1 ? `Delete ${selectedCards.length} notes?` : "Delete note?",
      message: `This permanently deletes ${selectedCards.length > 1 ? "these files" : `"${selectedCards[0]!.id}"`} from disk. This can't be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    for (const n of selectedCards) await useWorkspace.getState().deleteEntry(n.id);
  }, [selectedCards, selectedFrames, selectedEdges, removeFrame]);

  // Keyboard: Delete removes the selection (never while typing).
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, .cm-editor") || t.isContentEditable)) return;
      if (useUi.getState().dialog || useUi.getState().confirmReq || useUi.getState().promptReq) return;
      const arrow: Dir | null = e.key === "ArrowLeft" ? "left" : e.key === "ArrowRight" ? "right" : e.key === "ArrowUp" ? "up" : e.key === "ArrowDown" ? "down" : null;
      if (arrow && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.stopPropagation();
        const all = nodesRef.current.filter((n) => n.type === "note");
        const rect = (n: Node): Rect => ({ id: n.id, x: n.position.x, y: n.position.y, w: n.measured?.width ?? n.width ?? CARD_W, h: n.measured?.height ?? n.height ?? CARD_H });
        const sel = all.filter((n) => n.selected);
        if (e.shiftKey && sel.length) {
          // Shift + arrows nudge the selection by one grid step.
          e.preventDefault();
          const step = 22;
          const dx = arrow === "left" ? -step : arrow === "right" ? step : 0;
          const dy = arrow === "up" ? -step : arrow === "down" ? step : 0;
          patchCards(Object.fromEntries(sel.map((n) => [n.id, { x: Math.round(n.position.x + dx), y: Math.round(n.position.y + dy) }])));
          return;
        }
        if (all.length === 0) return;
        e.preventDefault();
        const next = sel.length ? nearestInDirection(rect(sel[sel.length - 1]!), all.map(rect), arrow) : firstCard(all.map(rect));
        if (!next) return;
        setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === next })));
        const target = all.find((n) => n.id === next);
        if (target) {
          const r = rect(target);
          void rf.setCenter(r.x + r.w / 2, r.y + r.h / 2, { zoom: rf.getZoom(), duration: 200 });
        }
        return;
      }
      if (e.key === "Enter" && selectedCards.length === 1) {
        e.preventDefault();
        useUi.getState().openNote(selectedCards[0]!.id);
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedCards.length || selectedFrames.length || selectedEdges.length) {
          e.preventDefault();
          void deleteSelection();
        }
      }
    };
    // Capture phase: arrows must not also reach React Flow's own keyboard handling.
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [deleteSelection, selectedCards, selectedFrames.length, selectedEdges.length, patchCards, rf]);

  const rectsOfSelection = (): Rect[] => selectedCards.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y, w: n.measured?.width ?? n.width ?? CARD_W, h: n.measured?.height ?? n.height ?? CARD_H }));
  const applyLayout = (res: Record<string, { x: number; y: number }>) => patchCards(res);

  const recolorSelection = (c: CardColor) => patchCards(Object.fromEntries(selectedCards.map((n) => [n.id, { color: c }])));

  return (
    <div
      ref={rootRef}
      className="board-root"
      data-grid={settings.grid}
      onMouseDownCapture={(e) => {
        if (e.button !== 1 && e.button !== 2) return;
        const target = e.target as HTMLElement;
        if (target.closest("input, textarea, .cm-editor, [contenteditable='true']")) return;
        // React Flow marks every draggable node `nopan`, which also blocks right/middle
        // viewport drags. Exempt this press only; left-button card dragging stays unchanged.
        const node = target.closest(".react-flow__node.nopan");
        if (node) {
          node.classList.remove("nopan");
          queueMicrotask(() => node.classList.add("nopan"));
        }
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={farOut && edges.length > 600 ? [] : edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStart={onNodeDragStart}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        onMoveStart={onMoveStart}
        onMoveEnd={onMoveEnd}
        onNodeClick={(_, n) => {
          const ed = useUi.getState().editingCard;
          if (ed && ed !== n.id) setEditing(null);
        }}
        onPaneClick={() => setEditing(null)}
        onPaneContextMenu={(e) => {
          const ev = e as unknown as MouseEvent;
          // React Flow dispatches this after a stationary right click, including on a card.
          // A right-button drag must never leave a menu over the zoom/pan surface.
          const node = ev.target instanceof Element ? ev.target.closest<HTMLElement>(".react-flow__node") : null;
          const id = node?.dataset.id;
          if (id) {
            if (id.startsWith(FRAME)) showFrameMenu(id.slice(FRAME.length), ev.clientX, ev.clientY);
            else showMenu(id, ev.clientX, ev.clientY);
            return;
          }
          const pos = rf.screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
          openMenu(ev, [
            { label: "New note here", icon: <FilePlus size={15} />, onSelect: () => void createNoteAt(pos) },
            { label: "New frame here", icon: <FrameIcon size={15} />, onSelect: () => void createFrameAt(pos) },
            { separator: true },
            { label: "Fit board", icon: <Maximize size={15} />, onSelect: () => void rf.fitView({ duration: 350, padding: 0.15 }) },
            { label: "Export as web page…", icon: <FileDown size={15} />, onSelect: () => void exportBoardAsHtml() },
          ]);
        }}
        onDoubleClick={(e) => {
          if (!(e.target as HTMLElement).classList.contains("react-flow__pane")) return;
          void createNoteAt(rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
        }}
        defaultViewport={initialViewport}
        minZoom={0.05}
        maxZoom={2.5}
        zoomOnDoubleClick={false}
        deleteKeyCode={null}
        selectionOnDrag
        selectionMode={SelectionMode.Partial}
        panOnDrag={PAN_BUTTONS}
        panActivationKeyCode="Space"
        multiSelectionKeyCode={["Shift", "Control", "Meta"]}
        selectNodesOnDrag={false}
        connectionMode={ConnectionMode.Loose}
        snapToGrid={settings.snap}
        snapGrid={SNAP_GRID}
        onlyRenderVisibleElements={noteCount > 150}
        nodeDragThreshold={3}
        colorMode={theme}
        aria-label={tr("Mural canvas")}
      >
        {settings.grid && <BoardBackground theme={theme} />}
        {(guides.x !== null || guides.y !== null) && (
          <ViewportPortal>
            {guides.x !== null && <div className="snap-guide v" style={{ transform: `translate(${guides.x}px, -100000px)` }} />}
            {guides.y !== null && <div className="snap-guide h" style={{ transform: `translate(-100000px, ${guides.y}px)` }} />}
          </ViewportPortal>
        )}
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap
          pannable
          zoomable
          position="bottom-right"
          maskColor={theme === "light" ? "rgb(120 95 40 / 0.28)" : "rgb(10 8 6 / 0.65)"}
          nodeStrokeWidth={2}
          nodeColor={(n) => (n.type === "frame" ? "transparent" : (MINIMAP_COLORS[(n.data as NoteNodeData).color] ?? "#ece3cf"))}
        />
      </ReactFlow>

      <BoardTabs />
      <div className="sr-only" role="status" aria-live="polite">
        {selectedCards.length === 1 ? `${meta.get(selectedCards[0]!.id)?.title ?? selectedCards[0]!.id}, ${tr("note {i} of {n}", { i: nodes.filter((n) => n.type === "note").findIndex((n) => n.id === selectedCards[0]!.id) + 1, n: nodes.filter((n) => n.type === "note").length })}` : ""}
      </div>

      <div className="board-hud">
        <button className="btn" onClick={() => void rf.fitView({ duration: 350, padding: 0.15 })} data-tip={tr("Fit board (Ctrl+0)")}><Maximize size={15} /> {tr("Fit")}</button>
        <button className="btn" onClick={() => void createFrameAt(flowCenter())} data-tip={tr("New frame")}><FrameIcon size={15} /> {tr("Frame")}</button>
        <button className="btn" onClick={() => { const c = flowCenter(); void createNoteAt({ x: c.x - CARD_W / 2, y: c.y - CARD_H / 2 }); }} data-tip={tr("New note on the mural (Ctrl+N)")}><FilePlus size={15} /> {tr("Note")}</button>
      </div>

      {noteCount === 0 && (
        <div className="board-hint">
          <div className="empty" style={{ color: "var(--ink-faint)" }}>
            <EmptyBoard />
            <p className="hand">{tr("Double-click anywhere to create your first note.")}</p>
            <ArrowDoodle style={{ color: "var(--amber)" }} />
          </div>
        </div>
      )}

      {selectedCards.length > 1 && (
        <div className="selection-bar" role="toolbar" aria-label={tr("Selection actions")}>
          <span className="handwritten-label" style={{ fontSize: "1.25rem" }}><BoxSelect size={15} className="inline mr-1" />{selectedCards.length} notes</span>
          <Swatches onPick={recolorSelection} />
          <div className="flex gap-1" role="group" aria-label={tr("Align and distribute")}>
            {([
              ["left", AlignStartVertical, "Align left"], ["hcenter", AlignCenterVertical, "Center horizontally"], ["right", AlignEndVertical, "Align right"],
              ["top", AlignStartHorizontal, "Align top"], ["vcenter", AlignCenterHorizontal, "Center vertically"], ["bottom", AlignEndHorizontal, "Align bottom"],
            ] as [AlignMode, typeof AlignStartVertical, string][]).map(([mode, Icon, label]) => (
              <button key={mode} className="btn btn-ghost btn-icon" onClick={() => applyLayout(alignRects(rectsOfSelection(), mode))} aria-label={label} data-tip={label}><Icon size={16} /></button>
            ))}
            <button className="btn btn-ghost btn-icon" disabled={selectedCards.length < 3} onClick={() => applyLayout(distributeRects(rectsOfSelection(), "x"))} aria-label={tr("Distribute horizontally")} data-tip={tr("Distribute horizontally")}><AlignHorizontalDistributeCenter size={16} /></button>
            <button className="btn btn-ghost btn-icon" disabled={selectedCards.length < 3} onClick={() => applyLayout(distributeRects(rectsOfSelection(), "y"))} aria-label={tr("Distribute vertically")} data-tip={tr("Distribute vertically")}><AlignVerticalDistributeCenter size={16} /></button>
          </div>
          <button className="btn" onClick={() => void groupInFrame()}><FrameIcon size={15} /> {tr("Group in frame")}</button>
          <button className="btn btn-danger" onClick={() => void deleteSelection()}><Trash2 size={15} /> {tr("Delete")}</button>
        </div>
      )}

      {menu && <Menu {...menu} onClose={close} />}
    </div>
  );
}
