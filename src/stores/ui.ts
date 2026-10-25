import { create } from "zustand";

export type SidebarTab = "notes" | "tags" | "files" | "explore";
export type MainView = "board" | "graph" | "note" | "timeline";
export type NoteMode = "edit" | "preview" | "split";
export type DialogName = "palette" | "search" | "shortcuts" | "settings" | "about" | "trash" | "templates" | "tasks" | "properties" | "health" | "mindmap" | "calendar" | "table" | "record" | null;

export interface Toast {
  id: number;
  kind: "info" | "error" | "success";
  message: string;
}

interface ConfirmReq {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

export interface ChoiceOption {
  label: string;
  value: string;
  kind?: "primary" | "danger";
}

interface ChoiceReq {
  title: string;
  message: string;
  /** Optional scrollable list under the message. */
  details?: string[];
  options: ChoiceOption[];
  resolve: (value: string | null) => void;
}

export interface PickItem {
  value: string;
  label: string;
  hint?: string;
}

interface PickReq {
  title: string;
  placeholder?: string;
  items: PickItem[];
  resolve: (value: string | null) => void;
}

interface PromptReq {
  title: string;
  label?: string;
  initial?: string;
  confirmLabel?: string;
  /** Hide what is typed (passwords). */
  secret?: boolean;
  resolve: (value: string | null) => void;
}

export interface NavEntry {
  view: MainView;
  note: string | null;
}

const RECENT_MAX = 8;
const recentKey = (root: string) => `bmnotes.recent:${root}`;

function loadRecent(root: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(recentKey(root)) ?? localStorage.getItem(`bm.recent:${root}`) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

interface UiState {
  sidebarOpen: boolean;
  sidebarTab: SidebarTab;
  view: MainView;
  activeNote: string | null;
  noteMode: NoteMode;
  dialog: DialogName;
  settingsSection: string;
  /** Section slug to scroll to after opening a note through a [[note#section]] link. */
  pendingHeading: string | null;
  /** Query to open the search dialog with (saved searches). */
  searchPrefill: string | null;
  navRoot: string;
  /** Focus mode: only the current view, no header or sidebar. */
  zen: boolean;
  history: NavEntry[];
  histIdx: number;
  recent: string[];
  tagFilter: string | null;
  editingCard: string | null;
  renamingCard: string | null;
  toasts: Toast[];
  confirmReq: ConfirmReq | null;
  promptReq: PromptReq | null;
  choiceReq: ChoiceReq | null;
  pickReq: PickReq | null;
  setSidebarOpen: (v: boolean) => void;
  toggleSidebar: () => void;
  setSidebarTab: (t: SidebarTab) => void;
  setView: (v: MainView) => void;
  openNote: (path: string) => void;
  closeNote: () => void;
  setNoteMode: (m: NoteMode) => void;
  setDialog: (d: DialogName) => void;
  openSettings: (section: string) => void;
  setPendingHeading: (h: string | null) => void;
  setZen: (v: boolean) => void;
  openSearch: (query: string) => void;
  /** Starts a fresh navigation history for a (re)opened workspace. */
  resetNav: (root: string) => void;
  goBack: () => void;
  goForward: () => void;
  forgetRecent: (path: string) => void;
  remapRecent: (map: (p: string) => string) => void;
  setTagFilter: (t: string | null) => void;
  setEditingCard: (p: string | null) => void;
  setRenamingCard: (p: string | null) => void;
  toast: (message: string, kind?: Toast["kind"]) => void;
  dismissToast: (id: number) => void;
  confirm: (req: Omit<ConfirmReq, "resolve">) => Promise<boolean>;
  prompt: (req: Omit<PromptReq, "resolve">) => Promise<string | null>;
  resolveConfirm: (ok: boolean) => void;
  resolvePrompt: (v: string | null) => void;
  choose: (req: Omit<ChoiceReq, "resolve">) => Promise<string | null>;
  resolveChoice: (v: string | null) => void;
  /** A searchable list to pick one item from (long lists, like murals). */
  pick: (req: Omit<PickReq, "resolve">) => Promise<string | null>;
  resolvePick: (v: string | null) => void;
}

let toastId = 1;

function saveRecent(root: string, recent: string[]) {
  if (!root) return;
  try {
    localStorage.setItem(recentKey(root), JSON.stringify(recent));
  } catch {
    /* recents are a convenience */
  }
}

export const useUi = create<UiState>((set, get) => {
  /** Records a navigation step (dropping any "forward" entries), skipping repeats. */
  const push = (e: NavEntry) => {
    const { history, histIdx } = get();
    const cur = history[histIdx];
    if (cur && cur.view === e.view && cur.note === e.note) return;
    const next = [...history.slice(0, histIdx + 1), e].slice(-50);
    set({ history: next, histIdx: next.length - 1 });
  };
  const step = (dir: -1 | 1) => {
    const { history, histIdx } = get();
    const to = histIdx + dir;
    const e = history[to];
    if (!e) return;
    set({ histIdx: to, view: e.view, activeNote: e.note ?? get().activeNote, editingCard: null, dialog: null });
  };
  return {
  sidebarOpen: true,
  sidebarTab: "files",
  view: "board",
  activeNote: null,
  noteMode: "split",
  dialog: null,
  settingsSection: "Appearance",
  pendingHeading: null,
  searchPrefill: null,
  navRoot: "",
  zen: false,
  history: [{ view: "board", note: null }],
  histIdx: 0,
  recent: [],
  tagFilter: null,
  editingCard: null,
  renamingCard: null,
  toasts: [],
  confirmReq: null,
  promptReq: null,
  choiceReq: null,
  pickReq: null,
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarTab: (sidebarTab) => {
    set({ sidebarTab, sidebarOpen: true, ...(sidebarTab === "explore" ? { view: "graph" as const } : {}) });
    if (sidebarTab === "explore") push({ view: "graph", note: null });
  },
  setView: (view) => {
    set({ view, editingCard: null });
    push({ view, note: view === "note" ? get().activeNote : null });
  },
  openNote: (path) => {
    set({ activeNote: path, view: "note", editingCard: null, dialog: null });
    push({ view: "note", note: path });
    const recent = [path, ...get().recent.filter((p) => p !== path)].slice(0, RECENT_MAX);
    set({ recent });
    saveRecent(get().navRoot, recent);
  },
  closeNote: () => {
    set({ activeNote: null, view: "board" });
    push({ view: "board", note: null });
  },
  setNoteMode: (noteMode) => set({ noteMode }),
  setDialog: (dialog) => set({ dialog }),
  openSettings: (settingsSection) => set({ settingsSection, dialog: "settings" }),
  setPendingHeading: (pendingHeading) => set({ pendingHeading }),
  setZen: (zen) => set({ zen }),
  openSearch: (query) => set({ searchPrefill: query, dialog: "search" }),
  resetNav: (root) => set({ navRoot: root, history: [{ view: "board", note: null }], histIdx: 0, recent: root ? loadRecent(root) : [] }),
  goBack: () => step(-1),
  goForward: () => step(1),
  forgetRecent: (path) => {
    const recent = get().recent.filter((p) => p !== path);
    set({ recent });
    saveRecent(get().navRoot, recent);
  },
  remapRecent: (map) => {
    const recent = get().recent.map(map);
    set({ recent });
    saveRecent(get().navRoot, recent);
  },
  setTagFilter: (tagFilter) => set({ tagFilter }),
  setEditingCard: (editingCard) => set({ editingCard }),
  setRenamingCard: (renamingCard) => set({ renamingCard }),
  toast: (message, kind = "info") => {
    const id = toastId++;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, message }] }));
    setTimeout(() => get().dismissToast(id), kind === "error" ? 6000 : 3000);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  confirm: (req) => new Promise((resolve) => set({ confirmReq: { ...req, resolve } })),
  prompt: (req) => new Promise((resolve) => set({ promptReq: { ...req, resolve } })),
  choose: (req) => new Promise((resolve) => set({ choiceReq: { ...req, resolve } })),
  resolveChoice: (v) => {
    get().choiceReq?.resolve(v);
    set({ choiceReq: null });
  },
  resolveConfirm: (ok) => {
    get().confirmReq?.resolve(ok);
    set({ confirmReq: null });
  },
  resolvePrompt: (v) => {
    get().promptReq?.resolve(v);
    set({ promptReq: null });
  },
  pick: (req) => new Promise((resolve) => {
    get().pickReq?.resolve(null);
    set({ pickReq: { ...req, resolve } });
  }),
  resolvePick: (v) => {
    get().pickReq?.resolve(v);
    set({ pickReq: null });
  },
};
});
