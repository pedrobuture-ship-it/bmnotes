import { ipc } from "@/lib/ipc";
import { lockNote, newNote, revealInFolder, togglePin } from "@/lib/actions";
import { useSettings } from "@/stores/settings";
import { runBackup } from "@/lib/backup";
import { usePlugins } from "@/stores/plugins";
import { exportBoardAsHtml } from "@/lib/exportAction";
import { boardCommand } from "@/features/board/boardBus";
import { useUi } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";
import { openFolderFlow } from "@/features/onboarding/flows";

export interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void | Promise<void>;
}

function onBoard(action: Parameters<typeof boardCommand>[0]) {
  const ui = useUi.getState();
  if (ui.view !== "board") {
    ui.setView("board");
    setTimeout(() => boardCommand(action), 120);
  } else boardCommand(action);
}

export function toggleEditPreview() {
  const ui = useUi.getState();
  if (ui.view !== "note") return;
  ui.setNoteMode(ui.noteMode === "preview" ? "edit" : "preview");
}

export function createNoteCommand() {
  const ui = useUi.getState();
  if (ui.view === "board") boardCommand("newNote");
  else void newNote("");
}

export function getCommands(): Command[] {
  const ui = useUi.getState;
  return [
    { id: "new-note", label: "New note", hint: "Ctrl N", run: createNoteCommand },
    { id: "new-frame", label: "New frame", run: () => onBoard("newFrame") },
    { id: "open-note", label: "Open note", hint: "Ctrl P", run: () => ui().setDialog("search") },
    { id: "search", label: "Search notes", hint: "Ctrl P", run: () => ui().setDialog("search") },
    { id: "open-folder", label: "Open folder", run: () => void openFolderFlow() },
    {
      id: "reveal",
      label: "Reveal file",
      run: () => void revealInFolder(ui().view === "note" && ui().activeNote ? ui().activeNote! : ""),
    },
    { id: "reveal-ws", label: "Reveal workspace in filesystem", run: () => void ipc.reveal("").catch(() => {}) },
    { id: "sidebar", label: "Toggle sidebar", hint: "Ctrl B", run: () => ui().toggleSidebar() },
    { id: "fit", label: "Fit board", hint: "Ctrl 0", run: () => onBoard("fit") },
    { id: "zoom-in", label: "Zoom in", hint: "Ctrl +", run: () => onBoard("zoomIn") },
    { id: "zoom-out", label: "Zoom out", hint: "Ctrl -", run: () => onBoard("zoomOut") },
    { id: "daily", label: "Open daily note", hint: "Ctrl Shift D", run: () => void useWorkspace.getState().openDaily() },
    { id: "toggle-preview", label: "Toggle preview", hint: "Ctrl E", run: () => { if (ui().view === "note") ui().setNoteMode(ui().noteMode === "edit" ? "split" : "edit"); } },
    { id: "toggle-editor", label: "Toggle editor", run: () => { if (ui().view === "note") ui().setNoteMode(ui().noteMode === "preview" ? "split" : "preview"); } },
    { id: "export-board", label: "Export this mural as a web page (.html)", run: () => void exportBoardAsHtml() },
    { id: "go-board", label: "Go to mural", run: () => ui().setView("board") },
    { id: "go-timeline", label: "Open timeline", run: () => ui().setView("timeline") },
    { id: "go-graph", label: "Explore graph", run: () => ui().setSidebarTab("explore") },
    { id: "new-from-template", label: "New note from template…", run: () => ui().setDialog("templates") },
    { id: "record", label: "Record audio into this note…", run: () => { if (ui().view === "note" && ui().activeNote) ui().setDialog("record"); } },
    { id: "table", label: "Edit table at cursor / insert table…", hint: "Ctrl Alt T", run: () => ui().setDialog("table") },
    { id: "calendar", label: "Open calendar", run: () => ui().setDialog("calendar") },
    { id: "tasks", label: "Open tasks", run: () => ui().setDialog("tasks") },
    { id: "backup", label: "Back up now", run: () => void runBackup() },
    { id: "mindmap", label: "Mind map of this note", run: () => { if (ui().view === "note" && ui().activeNote) ui().setDialog("mindmap"); } },
    { id: "health", label: "Check notes health (broken links, orphans)", run: () => ui().setDialog("health") },
    { id: "properties", label: "Open properties table", run: () => ui().setDialog("properties") },
    { id: "encrypt", label: "Encrypt this note with a password…", run: () => { if (ui().view === "note" && ui().activeNote) void lockNote(ui().activeNote!); } },
    { id: "zen", label: "Toggle focus mode", hint: "Ctrl Shift F", run: () => ui().setZen(!ui().zen) },
    ...usePlugins.getState().commands.map((c) => ({ id: `plugin:${c.key}`, label: `${c.plugin}: ${c.label}`, run: () => void usePlugins.getState().run(c.key) })),
    { id: "pin", label: "Pin / unpin this note", run: () => { if (ui().view === "note" && ui().activeNote) togglePin(ui().activeNote!); } },
    { id: "back", label: "Go back", hint: "Alt ←", run: () => ui().goBack() },
    { id: "forward", label: "Go forward", hint: "Alt →", run: () => ui().goForward() },
    ...useSettings.getState().settings.search.saved.map((s) => ({ id: `saved-${s.id}`, label: `Search: ${s.name}`, run: () => ui().openSearch(s.query) })),
    { id: "trash", label: "Open trash", run: () => ui().setDialog("trash") },
    { id: "settings", label: "Settings", hint: "Ctrl ,", run: () => ui().setDialog("settings") },
    { id: "shortcuts", label: "Keyboard shortcuts", hint: "Ctrl /", run: () => ui().setDialog("shortcuts") },
    { id: "about", label: "About bmnotes", run: () => ui().setDialog("about") },
    { id: "close-ws", label: "Close workspace", run: () => void useWorkspace.getState().closeWorkspace() },
  ];
}
