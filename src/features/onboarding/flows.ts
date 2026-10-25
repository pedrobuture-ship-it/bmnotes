import { ipc } from "@/lib/ipc";
import { useUi } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";
import { useBoard } from "@/stores/board";
import { boardCommand } from "@/features/board/boardBus";

export async function openFolderFlow(): Promise<boolean> {
  const dir = await ipc.pickFolder("Open a folder of Markdown notes");
  if (!dir) return false;
  const ok = await useWorkspace.getState().openWorkspace(dir);
  if (!ok) useUi.getState().toast(useWorkspace.getState().error ?? "Could not open the folder", "error");
  return ok;
}

const DEMO: { name: string; content: string; x: number; y: number; color: "paper" | "yellow" | "green" | "blue" | "pink" }[] = [
  {
    name: "Welcome",
    x: 0, y: 0, color: "yellow",
    content: `# Welcome to bmnotes\n\nYour notes are just files. Every card on this mural is a plain \`.md\` file in this folder.\n\n- Double-click empty space to create a note\n- Double-click a card to edit it in place\n- Link notes with [[Ideas]] and [[Architecture]]\n\n- [ ] Try ticking this checkbox\n- [x] Open MURAL.md\n\n#start\n`,
  },
  {
    name: "Ideas",
    x: 380, y: -40, color: "paper",
    content: `# Ideas\n\nA scratchpad for loose thoughts. See how it connects to [[Architecture]].\n\n> Good ideas are just notes that found each other.\n\n#ideas\n`,
  },
  {
    name: "Architecture",
    x: 380, y: 280, color: "blue",
    content: `# Architecture\n\n- Markdown files are the source of truth\n- Visual layout lives in \`.bmnotes/board.json\`\n- Tauri + Rust for the filesystem, React for the canvas\n\nRelated: [[Ideas]], [[Welcome]]\n\n#project\n`,
  },
  {
    name: "Roadmap",
    x: 0, y: 300, color: "green",
    content: `# Roadmap\n\n## Next\n\n- [ ] Write the first real note\n- [ ] Group related cards in a frame\n- [ ] Press Ctrl+Shift+D for a daily note\n\nBuilds on [[Architecture]].\n\n#project\n`,
  },
];

/** Creates a workspace in a user-chosen folder; demo notes only when asked. */
export async function createWorkspaceFlow(withDemo: boolean): Promise<boolean> {
  const dir = await ipc.pickFolder("Choose a folder for the new workspace");
  if (!dir) return false;
  const ws = useWorkspace.getState();
  if (!(await ws.openWorkspace(dir))) {
    useUi.getState().toast(useWorkspace.getState().error ?? "Could not open the folder", "error");
    return false;
  }
  await ws.createFolder("", "assets");
  if (withDemo) {
    const board = useBoard.getState();
    for (const d of DEMO) {
      const path = await useWorkspace.getState().createNote("", d.name, d.content);
      if (path) {
        board.ensureCard(path, { x: d.x, y: d.y });
        board.patchCards({ [path]: { x: d.x, y: d.y, color: d.color, w: 300, h: 230 } });
      }
    }
    board.addFrame({ id: "f-demo", title: "START HERE", color: "yellow", x: -40, y: -64, w: 740, h: 640 });
    setTimeout(() => boardCommand("fit"), 400);
  }
  return true;
}
