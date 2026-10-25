import { useState } from "react";
import { ipc } from "@/lib/ipc";
import { useTr } from "@/lib/i18n";
import { usePlugins } from "@/stores/plugins";

const EXAMPLE = `bmnotes.command("today", "Insert today's date", async () => {
  const title = await bmnotes.prompt("Note to append to");
  const notes = await bmnotes.notes.list();
  const hit = notes.find((n) => n.title === title);
  if (!hit) return bmnotes.toast("No note called " + title);
  const text = await bmnotes.notes.read(hit.path);
  await bmnotes.notes.write(hit.path, text + "\\n" + new Date().toISOString().slice(0, 10) + "\\n");
});`;

/** Plugins are small scripts in .bmnotes/plugins/. Each one needs your approval and runs in an isolated worker. */
export function PluginsPanel() {
  const tr = useTr();
  const { plugins, approve, revoke, load } = usePlugins();
  const [open, setOpen] = useState<string | null>(null);

  const openFolder = async () => {
    const dir = await ipc.ensurePluginsDir();
    await ipc.reveal(dir).catch(() => {});
    await load();
  };

  return (
    <>
      <p className="m-0" style={{ color: "var(--ink-dim)" }}>
        {tr("Plugins add commands to the palette (Ctrl+K). They are plain .js files in .bmnotes/plugins/ that run in an isolated worker with no network and no access to your computer: only the notes API below. They are never synced. Each file needs your approval, and changing it asks again.")}
      </p>
      <div className="flex gap-2" style={{ margin: "10px 0" }}>
        <button className="btn" onClick={() => void openFolder()}>{tr("Open plugins folder")}</button>
        <button className="btn btn-ghost" onClick={() => void load()}>{tr("Reload")}</button>
      </div>
      {plugins.length === 0 && <p style={{ color: "var(--ink-faint)" }}>{tr("No plugins found.")}</p>}
      {plugins.map((p) => (
        <div key={p.name} style={{ padding: "6px 0", borderBottom: "1px dashed var(--line-soft)" }}>
          <div className="flex items-center gap-2 flex-wrap">
            <b className="flex-1">{p.name}</b>
            <span className="chip" data-active={p.status === "running"}>{p.status === "running" ? tr("running") : p.status === "changed" ? tr("changed: approve again") : p.status === "error" ? tr("stopped") : tr("not approved")}</span>
            <button className="btn btn-ghost" onClick={() => setOpen(open === p.name ? null : p.name)}>{open === p.name ? tr("Hide code") : tr("Review code")}</button>
            {p.status !== "running" ? <button className="btn btn-primary" onClick={() => approve(p.name)}>{tr("Approve and run")}</button> : <button className="btn" onClick={() => revoke(p.name)}>{tr("Revoke")}</button>}
          </div>
          {open === p.name && <pre className="selectable" style={{ maxHeight: 220, overflow: "auto", background: "var(--surface-2)", padding: 10, borderRadius: 6, fontSize: "0.8rem" }}>{p.code}</pre>}
        </div>
      ))}
      <details style={{ marginTop: 12 }}>
        <summary>{tr("API and example")}</summary>
        <pre className="selectable" style={{ background: "var(--surface-2)", padding: 10, borderRadius: 6, fontSize: "0.8rem", overflow: "auto" }}>{`bmnotes.command(id, label, fn)   // add a palette command\nbmnotes.toast(text)\nbmnotes.openNote(path)\nawait bmnotes.prompt(title)\nawait bmnotes.notes.list()       // [{ path, title }]\nawait bmnotes.notes.read(path)\nawait bmnotes.notes.write(path, text)\nawait bmnotes.notes.create(name, text)\n\n${EXAMPLE}`}</pre>
      </details>
    </>
  );
}
