import { buildBoardHtml, inlineAssets } from "./exportBoard";
import { renderMarkdown } from "./markdown";
import { isEncrypted } from "./crypto";
import { splitFrontmatter } from "./frontmatter";
import { ipc } from "./ipc";
import { stripExt, basename } from "./paths";
import { useBoard } from "@/stores/board";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";

/** Saves the mural on screen as one standalone HTML page (images embedded, no scripts from outside). */
export async function exportBoardAsHtml(): Promise<void> {
  const ui = useUi.getState();
  const ws = useWorkspace.getState();
  const { board, boards, activeId } = useBoard.getState();
  const name = boards.find((b) => b.id === activeId)?.name ?? "Mural";
  const dest = await ipc.pickSavePath(`${ws.info?.name ?? "bmnotes"}-${name}.html`.replace(/[\\/:*?"<>|]/g, "-"), "html");
  if (!dest) return;
  try {
    await ws.flushAll();
    const { index } = useWorkspace.getState();
    const cards = Object.keys(board.cards)
      .filter((p) => ws.notes[p])
      .map((p) => {
        const content = useWorkspace.getState().notes[p]!.content;
        const body = isEncrypted(content) ? "<p>🔒 Encrypted note</p>" : renderMarkdown(splitFrontmatter(content).body, { notePath: p, resolves: () => true, math: "mathml" });
        return { path: p, title: index.meta.get(p)?.title ?? stripExt(basename(p)), html: body };
      });
    // Embed the images the cards use.
    const wanted = new Set<string>();
    for (const c of cards) for (const m of c.html.matchAll(/src="(?:bmnotes:\/\/localhost|http:\/\/bmnotes\.localhost)\/([^"]*)"/g)) wanted.add(decodeURIComponent(m[1] ?? ""));
    const data = new Map<string, string>();
    await Promise.all([...wanted].map(async (rel) => { data.set(rel, await ipc.readAssetDataUri(rel).catch(() => "")); }));
    const resolve = (rel: string) => data.get(rel) || null;
    for (const c of cards) c.html = inlineAssets(c.html, resolve);

    const edges = [
      ...board.connections.map((c) => ({ id: c.id, source: c.source, target: c.target })),
      ...(useSettings.getState().settings.board.showConnections
        ? [...index.meta.values()].flatMap((m) => m.links.map((t) => ({ id: `auto:${m.path}->${t}`, source: m.path, target: t })))
        : []),
    ];
    const html = buildBoardHtml({ title: `${ws.info?.name ?? ""} — ${name}`, board, cards, edges, theme: useSettings.getState().settings.appearance.theme });
    await ipc.writeExport(dest, html);
    ui.toast("Mural exported", "success");
  } catch (e) {
    ui.toast(`Export failed: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}
