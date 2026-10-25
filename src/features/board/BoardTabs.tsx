import { Lock, Plus, X } from "lucide-react";
import { isPrivate, togglePrivate } from "@/lib/actions";
import { useSync } from "@/stores/sync";
import { useBoard, MAIN_BOARD } from "@/stores/board";
import { useUi } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";
import { useTr } from "@/lib/i18n";

const notePaths = () => Object.keys(useWorkspace.getState().notes);

/** Tabs for the murals of this folder: "Main" shows every note, the others hold the notes added to them. */
export function BoardTabs() {
  const tr = useTr();
  const boards = useBoard((s) => s.boards);
  const activeId = useBoard((s) => s.activeId);
  const linked = useSync((s) => s.info?.linked ?? false);
  useSync((s) => s.info?.private);
  const { switchBoard, createBoard, renameBoard, deleteBoard } = useBoard.getState();

  const create = async () => {
    const ui = useUi.getState();
    const name = await ui.prompt({ title: "New mural", label: "Name", initial: "Ideas", confirmLabel: "Create" });
    if (!name) return;
    const copy = activeId === MAIN_BOARD && boards.length === 1 ? false : await ui.confirm({ title: "Start from a copy?", message: "Copy the cards and frames of the current mural, or start empty?", confirmLabel: "Copy current" });
    await createBoard(name, copy, notePaths());
  };

  const rename = async (id: string, current: string) => {
    if (id === MAIN_BOARD) return;
    const name = await useUi.getState().prompt({ title: "Rename mural", label: "Name", initial: current, confirmLabel: "Rename" });
    if (name) await renameBoard(id, name);
  };

  const remove = async (id: string, name: string) => {
    const ok = await useUi.getState().confirm({ title: "Delete mural?", message: `"${name}" will be deleted. Your notes are not touched.`, confirmLabel: "Delete mural", danger: true });
    if (ok) await deleteBoard(id, notePaths());
  };

  return (
    <div className="board-tabs" role="tablist" aria-label={tr("Murals")}>
      {boards.map((b) => (
        <div key={b.id} className="board-tab" role="tab" aria-selected={b.id === activeId} data-active={b.id === activeId}>
          <button className="board-tab-name" onClick={() => void switchBoard(b.id, notePaths())} onDoubleClick={() => void rename(b.id, b.name)} title={b.id === MAIN_BOARD ? "Shows every note" : "Double-click to rename"}>
            {b.name}
          </button>
          {b.id !== MAIN_BOARD && linked && (
            <button className="board-tab-x" onClick={() => void togglePrivate(`.bmnotes/boards/${b.id}.json`)} aria-label={`${isPrivate(`.bmnotes/boards/${b.id}.json`) ? "Share" : "Keep private"} mural ${b.name}`} data-tip={isPrivate(`.bmnotes/boards/${b.id}.json`) ? "Private (click to share)" : "Keep private"} style={isPrivate(`.bmnotes/boards/${b.id}.json`) ? { opacity: 1, color: "var(--amber)" } : undefined}><Lock size={11} /></button>
          )}
          {b.id !== MAIN_BOARD && (
            <button className="board-tab-x" onClick={() => void remove(b.id, b.name)} aria-label={`Delete mural ${b.name}`}><X size={12} /></button>
          )}
        </div>
      ))}
      <button className="board-tab-add" onClick={() => void create()} aria-label={tr("New mural")} data-tip={tr("New mural")}><Plus size={14} /></button>
    </div>
  );
}
