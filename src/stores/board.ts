import { create } from "zustand";
import { autoLayout, emptyBoard, normalizeBoard } from "@/lib/board";
import { ipc } from "@/lib/ipc";
import { timeStamp } from "@/lib/daily";
import type { BoardData, CardLayout, FrameLayout, Viewport } from "@/types";

export interface BoardMeta {
  id: string;
  name: string;
}

export const MAIN_BOARD = "main";
const fileOf = (id: string) => (id === MAIN_BOARD ? "board.json" : `boards/${id}.json`);
const activeKey = (root: string) => `bmnotes.board:${root}`;

function readActive(root: string): string | null {
  try {
    return localStorage.getItem(activeKey(root)) ?? localStorage.getItem(`bm.board:${root}`);
  } catch {
    return null;
  }
}

function writeActive(root: string, id: string) {
  try {
    localStorage.setItem(activeKey(root), id);
  } catch {
    /* private mode: the main board opens next time */
  }
}

interface BoardState {
  /** Main first, then the extra murals. */
  boards: BoardMeta[];
  activeId: string;
  rootKey: string;
  board: BoardData;
  ready: boolean;
  /** True when .bmnotes/board.json exists (or has been written) for this workspace. */
  hasFile: boolean;
  recovered: "none" | "backup" | "fresh";
  load: (notePaths: string[], rootKey?: string, wantId?: string) => Promise<void>;
  switchBoard: (id: string, notePaths: string[]) => Promise<void>;
  createBoard: (name: string, copyCurrent: boolean, notePaths: string[]) => Promise<string>;
  renameBoard: (id: string, name: string) => Promise<void>;
  deleteBoard: (id: string, notePaths: string[]) => Promise<void>;
  /** Adds notes to a (curated) mural, whether or not it is the one on screen. */
  addToBoard: (id: string, paths: string | string[]) => Promise<void>;
  /** Adds notes to another mural and takes them off the extra mural on screen. False if the target couldn't be written. */
  moveToBoard: (id: string, paths: string[]) => Promise<boolean>;
  reset: () => void;
  syncPaths: (notePaths: string[]) => void;
  patchCards: (patch: Record<string, Partial<CardLayout>>) => void;
  ensureCard: (path: string, at: { x: number; y: number }) => void;
  addFrame: (frame: FrameLayout) => void;
  patchFrame: (id: string, patch: Partial<FrameLayout>) => void;
  patchFrames: (patch: Record<string, Partial<FrameLayout>>) => void;
  removeFrame: (id: string) => void;
  addConnection: (source: string, target: string) => string;
  removeConnection: (id: string) => void;
  setLabel: (edgeId: string, label: string) => void;
  setViewport: (vp: Viewport) => void;
  remapPaths: (from: string, to: string) => void;
  /** Drops cards under `prefix`. `everywhere: false` only touches the mural on screen ("remove from board"). */
  removePaths: (prefix: string, everywhere?: boolean) => void;
}

let timer: ReturnType<typeof setTimeout> | undefined;
let pending = false;
let loadToken = 0;

function schedulePersist(get: () => BoardState, set: (p: Partial<BoardState>) => void) {
  clearTimeout(timer);
  pending = true;
  timer = setTimeout(async () => {
    pending = false;
    try {
      await ipc.writeMeta(fileOf(get().activeId), JSON.stringify(get().board, null, 2));
      set({ hasFile: true });
    } catch {
      // Metadata failures never touch Markdown; the next change retries.
    }
  }, 600);
}

/** Writes the pending change of the mural on screen right away (before switching murals). */
async function flush(get: () => BoardState) {
  if (!pending) return;
  clearTimeout(timer);
  pending = false;
  try {
    await ipc.writeMeta(fileOf(get().activeId), JSON.stringify(get().board, null, 2));
  } catch {
    /* retried on the next change */
  }
}

export const useBoard = create<BoardState>((set, get) => {
  const mutate = (fn: (b: BoardData) => BoardData) => {
    set({ board: fn(get().board) });
    schedulePersist(get, set);
  };
  const writeIndex = async (boards: BoardMeta[]) => {
    const extras = boards.filter((b) => b.id !== MAIN_BOARD);
    await ipc.writeMeta("boards.json", JSON.stringify({ version: 1, boards: extras }, null, 2));
  };
  /** Rewrites every mural file other than the one on screen (used when notes are renamed or deleted). */
  const forOthers = async (fn: (b: BoardData) => BoardData) => {
    for (const m of get().boards) {
      if (m.id === get().activeId) continue;
      try {
        const { content } = await ipc.readMeta(fileOf(m.id));
        if (content === null) continue;
        const next = fn(normalizeBoard(JSON.parse(content)));
        await ipc.writeMeta(fileOf(m.id), JSON.stringify(next, null, 2));
      } catch {
        /* an unreadable mural is left alone */
      }
    }
  };
  /** Places `paths` on mural `id`, keeping the size and color each card has on the mural on screen. */
  const addPaths = async (id: string, paths: string[]): Promise<boolean> => {
    const here = get().board.cards;
    const place = (b: BoardData): BoardData => {
      const cards = autoLayout([...Object.keys(b.cards), ...paths], b.cards);
      for (const p of paths) {
        const src = here[p];
        const dst = cards[p];
        if (src && dst && !b.cards[p]) cards[p] = { ...dst, w: src.w, h: src.h, color: src.color };
      }
      return { ...b, cards };
    };
    if (id === get().activeId) {
      mutate(place);
      return true;
    }
    try {
      const { content } = await ipc.readMeta(fileOf(id));
      const cur = content ? normalizeBoard(JSON.parse(content)) : emptyBoard();
      await ipc.writeMeta(fileOf(id), JSON.stringify(place(cur), null, 2));
      return true;
    } catch {
      return false; // the mural file is unreadable; nothing to add to
    }
  };

  return {
    boards: [{ id: MAIN_BOARD, name: "Main" }],
    activeId: MAIN_BOARD,
    rootKey: "",
    board: emptyBoard(),
    ready: false,
    hasFile: false,
    recovered: "none",
    reset: () => {
      clearTimeout(timer);
      pending = false;
      loadToken++;
      set({ board: emptyBoard(), ready: false, hasFile: false, recovered: "none", boards: [{ id: MAIN_BOARD, name: "Main" }], activeId: MAIN_BOARD, rootKey: "" });
    },
    load: async (notePaths, rootKey = get().rootKey, wantId) => {
      const token = ++loadToken;
      let boards: BoardMeta[] = [{ id: MAIN_BOARD, name: "Main" }];
      try {
        const { content } = await ipc.readMeta("boards.json");
        const list = content ? (JSON.parse(content) as { boards?: unknown }).boards : null;
        if (Array.isArray(list)) {
          for (const b of list as Partial<BoardMeta>[]) {
            if (typeof b?.id === "string" && typeof b.name === "string" && b.id !== MAIN_BOARD && !boards.some((x) => x.id === b.id)) boards.push({ id: b.id, name: b.name });
          }
        }
      } catch {
        boards = [{ id: MAIN_BOARD, name: "Main" }];
      }
      const remembered = wantId ?? (rootKey ? readActive(rootKey) : null);
      const id = remembered && boards.some((b) => b.id === remembered) ? remembered : MAIN_BOARD;
      const curated = id !== MAIN_BOARD;
      let board = emptyBoard();
      let hasFile = false;
      let recovered: BoardState["recovered"] = "none";
      try {
        const { content, backup } = await ipc.readMeta(fileOf(id));
        if (content !== null) {
          hasFile = true;
          try {
            board = normalizeBoard(JSON.parse(content));
          } catch {
            // Corrupt board.json: keep the broken file aside, restore the newest valid snapshot.
            await ipc.writeMeta("board.corrupt.json", content).catch(() => {});
            if (backup && !curated) {
              board = normalizeBoard(JSON.parse(backup));
              recovered = "backup";
            } else recovered = "fresh";
            await ipc.writeMeta(fileOf(id), JSON.stringify(board, null, 2)).catch(() => {});
          }
        }
      } catch {
        recovered = "none";
      }
      if (token !== loadToken) return;
      const present = new Set(notePaths);
      for (const p of Object.keys(board.cards)) if (!present.has(p)) delete board.cards[p];
      board.connections = board.connections.filter((c) => present.has(c.source) && present.has(c.target));
      // Only the main mural shows every note; the others hold just the notes added to them.
      if (!curated) board.cards = autoLayout(notePaths, board.cards);
      set({ board, ready: true, hasFile: hasFile || curated, recovered, boards, activeId: id, rootKey });
    },
    switchBoard: async (id, notePaths) => {
      const { activeId, rootKey, boards } = get();
      if (id === activeId || !boards.some((b) => b.id === id)) return;
      await flush(get);
      if (rootKey) writeActive(rootKey, id);
      set({ ready: false });
      await get().load(notePaths, rootKey, id);
    },
    createBoard: async (name, copyCurrent, notePaths) => {
      const { boards, board } = get();
      const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "board";
      let id = base;
      for (let n = 2; boards.some((b) => b.id === id) || id === MAIN_BOARD; n++) id = `${base}-${n}`;
      const data = copyCurrent ? board : emptyBoard();
      await flush(get);
      await ipc.writeMeta(fileOf(id), JSON.stringify(data, null, 2));
      const next = [...boards, { id, name: name.trim() || "Board" }];
      await writeIndex(next);
      set({ boards: next });
      await get().switchBoard(id, notePaths);
      return id;
    },
    renameBoard: async (id, name) => {
      const clean = name.trim();
      if (!clean || id === MAIN_BOARD) return;
      const next = get().boards.map((b) => (b.id === id ? { ...b, name: clean } : b));
      set({ boards: next });
      await writeIndex(next);
    },
    deleteBoard: async (id, notePaths) => {
      if (id === MAIN_BOARD) return;
      if (get().activeId === id) await get().switchBoard(MAIN_BOARD, notePaths);
      await ipc.deleteMeta(fileOf(id));
      const next = get().boards.filter((b) => b.id !== id);
      set({ boards: next });
      await writeIndex(next);
    },
    addToBoard: async (id, paths) => {
      await addPaths(id, Array.isArray(paths) ? paths : [paths]);
    },
    moveToBoard: async (id, paths) => {
      const from = get().activeId;
      if (id === from || paths.length === 0) return false;
      if (!(await addPaths(id, paths))) return false;
      // "Main" shows every note, so there is nothing to take the cards off.
      if (from !== MAIN_BOARD) for (const p of paths) get().removePaths(p, false);
      return true;
    },
    syncPaths: (notePaths) => {
      const { board, ready } = get();
      if (!ready) return;
      const present = new Set(notePaths);
      let changed = false;
      const cards = { ...board.cards };
      for (const p of Object.keys(cards)) {
        if (!present.has(p)) {
          delete cards[p];
          changed = true;
        }
      }
      const laidOut = get().activeId === MAIN_BOARD ? autoLayout(notePaths, cards) : cards;
      const connections = board.connections.filter((c) => present.has(c.source) && present.has(c.target));
      if (connections.length !== board.connections.length) changed = true;
      set({ board: { ...board, cards: laidOut, connections } });
      if (changed && get().hasFile) schedulePersist(get, set);
    },
    patchCards: (patch) =>
      mutate((b) => {
        const cards = { ...b.cards };
        for (const [p, v] of Object.entries(patch)) {
          const cur = cards[p];
          if (cur) cards[p] = { ...cur, ...v };
        }
        return { ...b, cards };
      }),
    ensureCard: (path, at) =>
      mutate((b) => ({ ...b, cards: { ...b.cards, [path]: b.cards[path] ?? { x: at.x, y: at.y, w: 280, h: 200, color: "paper" } } })),
    addFrame: (frame) => mutate((b) => ({ ...b, frames: [...b.frames, frame] })),
    patchFrame: (id, patch) => mutate((b) => ({ ...b, frames: b.frames.map((f) => (f.id === id ? { ...f, ...patch } : f)) })),
    patchFrames: (patch) => mutate((b) => ({ ...b, frames: b.frames.map((f) => (patch[f.id] ? { ...f, ...patch[f.id] } : f)) })),
    removeFrame: (id) => mutate((b) => ({ ...b, frames: b.frames.filter((f) => f.id !== id) })),
    addConnection: (source, target) => {
      const id = `c-${timeStamp()}-${Math.random().toString(36).slice(2, 6)}`;
      mutate((b) => ({ ...b, connections: [...b.connections, { id, source, target }] }));
      return id;
    },
    removeConnection: (id) =>
      mutate((b) => {
        const labels = { ...b.labels };
        delete labels[id];
        return { ...b, connections: b.connections.filter((c) => c.id !== id), labels };
      }),
    setLabel: (edgeId, label) =>
      mutate((b) => {
        const labels = { ...b.labels };
        if (label.trim()) labels[edgeId] = label.trim();
        else delete labels[edgeId];
        return { ...b, labels };
      }),
    setViewport: (viewport) => {
      const previous = get().board.viewport;
      if (previous.x === viewport.x && previous.y === viewport.y && previous.zoom === viewport.zoom) return;
      set({ board: { ...get().board, viewport } });
      if (get().hasFile) schedulePersist(get, set);
    },
    remapPaths: (from, to) => {
      const map = (p: string) => (p === from ? to : p.startsWith(from + "/") ? to + p.slice(from.length) : p);
      const remap = (b: BoardData): BoardData => {
        const cards: Record<string, CardLayout> = {};
        for (const [p, v] of Object.entries(b.cards)) cards[map(p)] = v;
        const labels: Record<string, string> = {};
        for (const [k, v] of Object.entries(b.labels)) {
          const m = /^auto:(.*)->(.*)$/.exec(k);
          labels[m ? `auto:${map(m[1] ?? "")}->${map(m[2] ?? "")}` : k] = v;
        }
        return {
          ...b,
          cards,
          labels,
          connections: b.connections.map((c) => ({ ...c, source: map(c.source), target: map(c.target) })),
        };
      };
      mutate(remap);
      void forOthers(remap);
    },
    removePaths: (prefix, everywhere = true) => {
      const hit = (p: string) => p === prefix || p.startsWith(prefix + "/");
      const drop = (b: BoardData): BoardData => {
        const cards: Record<string, CardLayout> = {};
        for (const [p, v] of Object.entries(b.cards)) if (!hit(p)) cards[p] = v;
        return { ...b, cards, connections: b.connections.filter((c) => !hit(c.source) && !hit(c.target)) };
      };
      mutate(drop);
      if (everywhere) void forOthers(drop);
    },
  };
});
