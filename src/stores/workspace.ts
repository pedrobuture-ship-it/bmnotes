import { create } from "zustand";
import { buildIndex, updateIndex, type NoteIndex } from "@/lib/noteIndex";
import { ipc, type FsChange } from "@/lib/ipc";
import { dateStamp, dailyTemplate } from "@/lib/daily";
import { basename, dirname, joinPath } from "@/lib/paths";
import { planLinkUpdates, type LinkPlan } from "@/lib/renameLinks";
import type { NoteFile, SaveStatus, TreeNode, WorkspaceInfo } from "@/types";
import { useBoard } from "./board";
import { useSettings } from "./settings";
import { useUi } from "./ui";
import { useLocks } from "./locks";

export interface NoteState {
  content: string;
  saved: string;
  mtime: number;
  created: number;
  /** Bumped when content is replaced from outside the editor (disk reload). */
  revision: number;
  /** External content waiting for the user's decision when there are unsaved local edits. */
  conflict: string | null;
}

interface WorkspaceState {
  info: WorkspaceInfo | null;
  loading: boolean;
  error: string | null;
  tree: TreeNode[];
  notes: Record<string, NoteState>;
  index: NoteIndex;
  saveStatus: SaveStatus;
  openWorkspace: (path: string) => Promise<boolean>;
  closeWorkspace: () => Promise<void>;
  setContent: (path: string, content: string) => void;
  saveNow: (path: string) => Promise<void>;
  flushAll: () => Promise<void>;
  createNote: (dir: string, name: string, content?: string) => Promise<string | null>;
  createFolder: (parent: string, name: string) => Promise<string | null>;
  renameEntry: (path: string, newName: string) => Promise<string | null>;
  moveEntry: (path: string, newParent: string) => Promise<string | null>;
  deleteEntry: (path: string) => Promise<boolean>;
  openDaily: () => Promise<void>;
  handleFsChange: (c: FsChange) => Promise<void>;
  resolveConflict: (path: string, keepMine: boolean) => void;
  syncWithDisk: () => Promise<void>;
}

const LAST_KEY = "bmnotes:lastWorkspace";
const EMPTY_INDEX: NoteIndex = buildIndex([]);

export function getLastWorkspace(): string | null {
  try {
    return localStorage.getItem(LAST_KEY) ?? localStorage.getItem("mural:lastWorkspace");
  } catch {
    return null;
  }
}
function setLastWorkspace(p: string | null) {
  try {
    if (p) localStorage.setItem(LAST_KEY, p);
    else { localStorage.removeItem(LAST_KEY); localStorage.removeItem("mural:lastWorkspace"); }
  } catch {
    /* storage unavailable */
  }
}

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
let inFlight = 0;
const saveJobs = new Map<string, Promise<void>>();
let indexTimer: ReturnType<typeof setTimeout> | undefined;
const indexDirty = new Set<string>();
let syncChain: Promise<void> | null = null;
let syncPending = false;
let unlisten: (() => void) | null = null;
let session = 0;

function ignored(): string[] {
  return useSettings.getState().settings.files.ignoredFolders;
}

function flattenPaths(nodes: TreeNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.isDir) flattenPaths(n.children, out);
    else out.push(n.path);
  }
  return out;
}

const toState = (f: NoteFile): NoteState => ({ content: f.content, saved: f.content, mtime: f.mtime, created: f.created ?? f.mtime, revision: 0, conflict: null });

export const useWorkspace = create<WorkspaceState>((set, get) => {
  const errorToast = (e: unknown) => useUi.getState().toast(e instanceof Error ? e.message : String(e), "error");

  const refreshStatus = () => {
    const busy = inFlight > 0 || saveTimers.size > 0;
    set((s) => (busy ? (s.saveStatus === "saving" ? s : { saveStatus: "saving" }) : s.saveStatus === "error" ? s : { saveStatus: "saved" }));
  };

  const scheduleIndex = (path: string) => {
    indexDirty.add(path);
    clearTimeout(indexTimer);
    indexTimer = setTimeout(() => {
      const { notes, index } = get();
      const changes = [...indexDirty].map((p) => ({ path: p, content: notes[p]?.content ?? null }));
      indexDirty.clear();
      set({ index: updateIndex(index, changes) });
    }, 250);
  };

  const fullReindex = () => {
    const entries: [string, string][] = Object.entries(get().notes).map(([p, n]) => [p, n.content]);
    set({ index: buildIndex(entries) });
  };

  const syncWithDisk = async () => {
    const mySession = session;
    const tree = await ipc.scan(ignored());
    if (mySession !== session) return;
    const onDisk = new Set(flattenPaths(tree));
    const missing = [...onDisk].filter((p) => !get().notes[p]);
    const loaded: (NoteFile | null)[] = [];
    for (let i = 0; i < missing.length; i += 8) {
      loaded.push(...await Promise.all(missing.slice(i, i + 8).map((p) => ipc.readNote(p).catch(() => null))));
      if (mySession !== session) return;
    }
    if (mySession !== session) return;
    // Edits can happen while IPC reads are in flight; merge into the latest state.
    const notes = { ...get().notes };
    for (const f of loaded) if (f && !notes[f.path]) notes[f.path] = toState(f);
    let gone = 0;
    for (const p of Object.keys(notes)) {
      if (onDisk.has(p)) continue;
      const n = notes[p];
      if (n && n.content !== n.saved) continue; // keep unsaved edits; next save recreates the file
      delete notes[p];
      gone++;
    }
    const pathsChanged = gone > 0 || loaded.some((f) => f !== null);
    if (JSON.stringify(tree) !== JSON.stringify(get().tree)) set({ tree });
    if (pathsChanged) {
      set({ notes });
      fullReindex();
      useBoard.getState().syncPaths(Object.keys(notes));
    }
    const ui = useUi.getState();
    if (ui.activeNote && !notes[ui.activeNote]) {
      ui.closeNote();
      if (gone) ui.toast("The open note no longer exists on disk", "info");
    }
  };

  const queueSync = () => {
    syncPending = true;
    if (!syncChain) {
      syncChain = Promise.resolve().then(async () => {
        try {
          while (syncPending) {
            syncPending = false;
            try { await syncWithDisk(); } catch (e) { errorToast(e); }
          }
        } finally { syncChain = null; }
      });
    }
    return syncChain;
  };

  const performSave = async (path: string) => {
    const n = get().notes[path];
    if (!n || n.content === n.saved) return;
    const snapshot = n.content;
    inFlight++;
    set({ saveStatus: "saving" });
    try {
      const mtime = await ipc.writeNote(path, snapshot);
      set((s) => {
        const cur = s.notes[path];
        return cur ? { notes: { ...s.notes, [path]: { ...cur, saved: snapshot, mtime } } } : s;
      });
    } catch (e) {
      set({ saveStatus: "error" });
      errorToast(e);
    } finally {
      inFlight--;
      refreshStatus();
    }
  };

  // Autosave and Ctrl+S can overlap; serialize writes to the same atomic temp file.
  const doSave = (path: string): Promise<void> => {
    const job = (saveJobs.get(path) ?? Promise.resolve()).then(() => performSave(path));
    saveJobs.set(path, job);
    void job.finally(() => { if (saveJobs.get(path) === job) saveJobs.delete(path); });
    return job;
  };

  return {
    info: null,
    loading: false,
    error: null,
    tree: [],
    notes: {},
    index: EMPTY_INDEX,
    saveStatus: "idle",

    openWorkspace: async (path) => {
      set({ loading: true, error: null });
      try {
        await get().flushAll();
        clearTimeout(indexTimer);
        indexDirty.clear();
        session++;
        const info = await ipc.openWorkspace(path);
        useBoard.getState().reset();
        useSettings.getState().reset();
        await useSettings.getState().load();
        const [tree, files] = await Promise.all([ipc.scan(ignored()), ipc.readAll(ignored())]);
        const notes: Record<string, NoteState> = {};
        for (const f of files) notes[f.path] = toState(f);
        set({ info, tree, notes, index: buildIndex(files.map((f) => [f.path, f.content])), loading: false, saveStatus: "idle" });
        await useBoard.getState().load(Object.keys(notes), info.root);
        const ui = useUi.getState();
        ui.setView("board");
        useUi.setState({ activeNote: null, tagFilter: null });
        ui.resetNav(info.root);
        setLastWorkspace(path);
        unlisten?.();
        unlisten = await ipc.onFsChange((c) => void get().handleFsChange(c)).then((u) => u);
        const rec = useBoard.getState().recovered;
        if (rec === "backup") ui.toast("board.json was corrupted — restored from the latest backup", "info");
        if (rec === "fresh") ui.toast("board.json was corrupted — started a fresh layout (notes are untouched)", "info");
        return true;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        set({ loading: false, error: message });
        if (getLastWorkspace() === path) setLastWorkspace(null);
        return false;
      }
    },

    closeWorkspace: async () => {
      await get().flushAll();
      clearTimeout(indexTimer);
      indexDirty.clear();
      session++;
      unlisten?.();
      unlisten = null;
      await ipc.closeWorkspace().catch(() => {});
      useBoard.getState().reset();
      useSettings.getState().reset();
      setLastWorkspace(null);
      useUi.setState({ activeNote: null, view: "board", editingCard: null });
      useUi.getState().resetNav("");
      set({ info: null, tree: [], notes: {}, index: EMPTY_INDEX, saveStatus: "idle", error: null });
    },

    setContent: (path, content) => {
      const n = get().notes[path];
      if (!n || n.content === content) return;
      set((s) => ({ notes: { ...s.notes, [path]: { ...n, content } } }));
      scheduleIndex(path);
      clearTimeout(saveTimers.get(path));
      saveTimers.set(
        path,
        setTimeout(() => {
          saveTimers.delete(path);
          void doSave(path);
        }, useSettings.getState().settings.editor.autosaveDelay),
      );
      set({ saveStatus: "saving" });
    },

    saveNow: async (path) => {
      clearTimeout(saveTimers.get(path));
      saveTimers.delete(path);
      await doSave(path);
    },

    flushAll: async () => {
      const paths = [...saveTimers.keys()];
      for (const p of paths) {
        clearTimeout(saveTimers.get(p));
        saveTimers.delete(p);
      }
      const scheduled = paths.map(doSave);
      await Promise.all([...scheduled, ...saveJobs.values()]);
    },

    createNote: async (dir, name, content = "") => {
      try {
        const path = await ipc.createNote(dir, name, content);
        const f = await ipc.readNote(path);
        set((s) => ({ notes: { ...s.notes, [path]: toState(f) } }));
        scheduleIndex(path);
        await queueSync();
        return path;
      } catch (e) {
        errorToast(e);
        return null;
      }
    },

    createFolder: async (parent, name) => {
      try {
        const p = await ipc.createDir(parent, name);
        await queueSync();
        return p;
      } catch (e) {
        errorToast(e);
        return null;
      }
    },

    renameEntry: async (path, newName) => {
      try {
        await get().flushAll();
        const isNote = !!get().notes[path];
        const name = isNote && !/\.(md|markdown)$/i.test(newName) ? `${newName}.md` : newName;
        const dir = dirname(path);
        const target = joinPath(dir, name);
        const links = await askLinkUpdate(path, target);
        if (links === "cancel") return null;
        const next = await ipc.rename(path, newName);
        if (next !== path) afterMove(path, next);
        if (links && next === target) applyLinkUpdate(links);
        await queueSync();
        return next;
      } catch (e) {
        errorToast(e);
        return null;
      }
    },

    moveEntry: async (path, newParent) => {
      try {
        await get().flushAll();
        const target = joinPath(newParent, basename(path));
        const links = await askLinkUpdate(path, target);
        if (links === "cancel") return null;
        const next = await ipc.move(path, newParent);
        if (next !== path) afterMove(path, next);
        if (links && next === target) applyLinkUpdate(links);
        await queueSync();
        return next;
      } catch (e) {
        errorToast(e);
        return null;
      }
    },

    deleteEntry: async (path) => {
      try {
        for (const p of [...saveTimers.keys()]) {
          if (p === path || p.startsWith(path + "/")) {
            clearTimeout(saveTimers.get(p));
            saveTimers.delete(p);
          }
        }
        await ipc.remove(path);
        useBoard.getState().removePaths(path);
        const gone = (p: string) => p === path || p.startsWith(path + "/");
        if (useSettings.getState().settings.nav.pinned.some(gone)) useSettings.getState().update((s) => ({ ...s, nav: { pinned: s.nav.pinned.filter((p) => !gone(p)) } }));
        useUi.getState().recent.filter(gone).forEach((p) => useUi.getState().forgetRecent(p));
        const notes = { ...get().notes };
        for (const p of Object.keys(notes)) if (p === path || p.startsWith(path + "/")) delete notes[p];
        set({ notes });
        await queueSync();
        return true;
      } catch (e) {
        errorToast(e);
        return false;
      }
    },

    openDaily: async () => {
      const stamp = dateStamp();
      const dir = useSettings.getState().settings.files.dailyFolder;
      const path = joinPath(dir, `${stamp}.md`);
      if (!get().notes[path]) {
        const created = await get().createNote(dir, stamp, dailyTemplate(stamp));
        if (created) useUi.getState().openNote(created);
        return;
      }
      useUi.getState().openNote(path);
    },

    handleFsChange: async (c) => {
      if (c.structure || c.removed.length) await queueSync();
      for (const p of c.changed) {
        const mySession = session;
        try {
          const f = await ipc.readNote(p);
          if (mySession !== session) return;
          const cur = get().notes[p];
          if (!cur) {
            set((s) => ({ notes: { ...s.notes, [p]: toState(f) } }));
          } else if (f.content === cur.content) {
            if (cur.saved === f.content && cur.mtime === f.mtime && cur.conflict === null) continue;
            set((s) => ({ notes: { ...s.notes, [p]: { ...cur, saved: f.content, mtime: f.mtime, conflict: null } } }));
            continue;
          } else if (cur.content !== cur.saved) {
            set((s) => ({ notes: { ...s.notes, [p]: { ...cur, conflict: f.content } } }));
            useUi.getState().toast(`"${p}" changed on disk while you have unsaved edits`, "info");
            continue;
          } else {
            set((s) => ({
              notes: { ...s.notes, [p]: { content: f.content, saved: f.content, mtime: f.mtime, created: cur.created, revision: cur.revision + 1, conflict: null } },
            }));
          }
          scheduleIndex(p);
        } catch {
          /* file vanished between event and read; the structure sync handles it */
        }
      }
    },

    resolveConflict: (path, keepMine) => {
      const n = get().notes[path];
      if (!n || n.conflict === null) return;
      if (keepMine) {
        // Keep local text; saving overwrites the external version on purpose.
        set((s) => ({ notes: { ...s.notes, [path]: { ...n, conflict: null, saved: n.conflict ?? n.saved } } }));
        void get().saveNow(path);
      } else {
        const ext = n.conflict;
        clearTimeout(saveTimers.get(path));
        saveTimers.delete(path);
        set((s) => ({ notes: { ...s.notes, [path]: { content: ext, saved: ext, mtime: n.mtime, created: n.created, revision: n.revision + 1, conflict: null } } }));
        scheduleIndex(path);
        refreshStatus();
      }
    },

    syncWithDisk: queueSync,
  };

  /** [oldPath, newPath] for every note touched by renaming/moving `from` to `to`. */
  function notePairs(from: string, to: string): [string, string][] {
    const out: [string, string][] = [];
    for (const p of Object.keys(get().notes)) {
      if (p === from) out.push([p, to]);
      else if (p.startsWith(from + "/")) out.push([p, to + p.slice(from.length)]);
    }
    return out;
  }

  /** Offers to rewrite [[links]] that would break. Returns the plan to apply, null for "rename only", or "cancel". */
  async function askLinkUpdate(from: string, to: string): Promise<LinkPlan | null | "cancel"> {
    if (from === to) return null;
    const pairs = notePairs(from, to);
    if (pairs.length === 0) return null;
    const plan = planLinkUpdates(Object.fromEntries(Object.entries(get().notes).map(([p, n]) => [p, n.content])), pairs);
    if (plan.total === 0) return null;
    const noun = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
    const choice = await useUi.getState().choose({
      title: "Update links?",
      message: `${basename(from)} → ${basename(to)}\nFound ${noun(plan.total, "link")} in ${noun(plan.files.length, "note")}:`,
      details: plan.files.map((f) => `${f.path} (${f.count})`),
      options: [
        { label: "Update references", value: "update", kind: "primary" },
        { label: "Rename only", value: "skip" },
      ],
    });
    if (choice === "update") return plan;
    return choice === "skip" ? null : "cancel";
  }

  function applyLinkUpdate(plan: LinkPlan) {
    let changed = 0;
    for (const [p, n] of Object.entries(get().notes)) {
      const next = plan.rewrite(n.content, p);
      if (next !== n.content) {
        get().setContent(p, next);
        changed++;
      }
    }
    if (changed) useUi.getState().toast(`Updated ${plan.total} ${plan.total === 1 ? "link" : "links"} in ${changed} ${changed === 1 ? "note" : "notes"}`, "success");
  }

  function afterMove(from: string, to: string) {
    useBoard.getState().remapPaths(from, to);
    const remap = (p: string) => (p === from ? to : p.startsWith(from + "/") ? to + p.slice(from.length) : p);
    if (useSettings.getState().settings.nav.pinned.some((p) => remap(p) !== p)) useSettings.getState().update((s) => ({ ...s, nav: { pinned: s.nav.pinned.map(remap) } }));
    useUi.getState().remapRecent(remap);
    useLocks.getState().remap(remap);
    const notes: Record<string, NoteState> = {};
    for (const [p, n] of Object.entries(get().notes)) {
      if (p === from) notes[to] = n;
      else if (p.startsWith(from + "/")) notes[to + p.slice(from.length)] = n;
      else notes[p] = n;
    }
    set({ notes });
    const ui = useUi.getState();
    if (ui.activeNote === from) useUi.setState({ activeNote: to });
    else if (ui.activeNote?.startsWith(from + "/")) useUi.setState({ activeNote: to + ui.activeNote.slice(from.length) });
  }
});
