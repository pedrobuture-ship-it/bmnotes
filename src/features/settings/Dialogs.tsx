import { useEffect, useRef, useState, type ReactNode } from "react";
import { Row, Toggle } from "./controls";
import { SyncPanel } from "./SyncPanel";
import { BackupPanel } from "./BackupPanel";
import { UpdatesPanel } from "./UpdatesPanel";
import { PluginsPanel } from "./PluginsPanel";
import { Dialog } from "@/components/Dialogs";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";
import { SHORTCUTS, effectiveCombos, formatCombo } from "@/lib/shortcuts";
import { ShortcutsSettings } from "./ShortcutsSettings";
import { LANGUAGES, useTr } from "@/lib/i18n";
import { ipc, type GithubDevice, type GithubUser } from "@/lib/ipc";
import { LogoMark } from "@/components/doodles";

function NumberField({ value, min, max, step = 1, onChange, label }: { value: number; min: number; max: number; step?: number; onChange: (n: number) => void; label: string }) {
  return <input className="field" style={{ width: 90 }} type="number" aria-label={label} value={value} min={min} max={max} step={step} onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) onChange(n); }} />;
}

export function ShortcutsList() {
  const tr = useTr();
  const groups = ["General", "Mural", "Editor"] as const;
  const eff = effectiveCombos(useSettings((s) => s.settings.shortcuts));
  return (
    <div className="overflow-auto px-5 pb-5" style={{ maxHeight: "60vh" }}>
      {groups.map((g) => (
        <div key={g} className="mb-3">
          <div className="handwritten-label" style={{ fontSize: "1.4rem" }}>{tr(g)}</div>
          {SHORTCUTS.filter((s) => s.group === g).map((s) => (
            <div key={s.keys + s.label} className="shortcut-row">
              <span>{tr(s.label)}</span>
              <span className="kbd">{s.action ? formatCombo(eff[s.action]) : s.keys}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function ShortcutsDialog() {
  const setDialog = useUi((s) => s.setDialog);
  return (
    <Dialog title="Keyboard shortcuts" onClose={() => setDialog(null)} width={600}>
      <ShortcutsList />
    </Dialog>
  );
}

/** Optional GitHub sign-in (device flow). Nothing is contacted until the user clicks Connect. */
function GithubConnect({ children }: { children?: ReactNode }) {
  const [user, setUser] = useState<GithubUser | null>(null);
  const [checking, setChecking] = useState(true);
  const [device, setDevice] = useState<GithubDevice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useRef(0);

  useEffect(() => {
    ipc.githubStatus().then(setUser).catch(() => {}).finally(() => setChecking(false));
    return () => { run.current++; };
  }, []);

  const cancel = () => { run.current++; setDevice(null); };

  const connect = async () => {
    const my = ++run.current;
    setError(null);
    try {
      const d = await ipc.githubLoginStart();
      if (run.current !== my) return;
      setDevice(d);
      void ipc.openExternal(d.verificationUri).catch(() => {});
      let wait = d.interval;
      const deadline = Date.now() + d.expiresIn * 1000;
      while (run.current === my && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, wait * 1000));
        if (run.current !== my) return;
        const r = await ipc.githubLoginPoll(d.deviceCode);
        if (r.status === "done") {
          setUser(await ipc.githubStatus());
          setDevice(null);
          return;
        }
        if (r.status === "slow_down") wait += 5;
      }
      if (run.current === my) throw new Error("The code expired. Start again.");
    } catch (e) {
      if (run.current === my) { setDevice(null); setError(e instanceof Error ? e.message : "Could not connect"); }
    }
  };

  const disconnect = async () => {
    await ipc.githubLogout().catch(() => {});
    setUser(null);
  };

  if (checking) return null;
  return (
    <>
      <Row title="GitHub" hint="Optional. Sign in to sync this folder with a repository. Off until you connect.">
        {user ? (
          <div className="flex items-center gap-2"><span className="chip" data-active="true">@{user.login}</span><button className="btn" onClick={() => void disconnect()}>Disconnect</button></div>
        ) : device ? (
          <button className="btn" onClick={cancel}>Cancel</button>
        ) : (
          <button className="btn btn-primary" onClick={() => void connect()}>Connect to GitHub</button>
        )}
      </Row>
      {device && (
        <div className="paper-card" style={{ padding: "14px 18px", margin: "6px 0 12px" }}>
          <div>Enter this code at <a href={device.verificationUri} onClick={(e) => { e.preventDefault(); void ipc.openExternal(device.verificationUri); }}>{device.verificationUri}</a>:</div>
          <div className="handwritten-label" style={{ fontSize: "2.2rem", letterSpacing: "0.12em", userSelect: "all" }}>{device.userCode}</div>
          <small>Waiting for you to authorize in the browser…</small>
        </div>
      )}
      {error && <p role="alert" style={{ color: "var(--red)", fontWeight: 700 }}>{error}</p>}
      {user && children}
    </>
  );
}

const SECTIONS = ["Appearance", "Editor", "Files", "Daily Notes", "Board", "Sync", "Backup", "Updates", "Plugins", "Keyboard"] as const;

export function SettingsDialog() {
  const tr = useTr();
  const setDialog = useUi((s) => s.setDialog);
  const { settings, update } = useSettings();
  const [section, setSection] = useState<(typeof SECTIONS)[number]>(() => {
    const s = useUi.getState().settingsSection;
    return (SECTIONS as readonly string[]).includes(s) ? (s as (typeof SECTIONS)[number]) : "Appearance";
  });
  const [ignored, setIgnored] = useState(settings.files.ignoredFolders.join(", "));

  return (
    <Dialog title="Settings" onClose={() => setDialog(null)} width={720}>
      <div className="settings-grid">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <button key={s} className="tab" style={{ flexDirection: "row", justifyContent: "flex-start", padding: "6px 10px" }} aria-selected={section === s} onClick={() => setSection(s)}>{tr(s)}</button>
          ))}
        </nav>
        <div className="settings-pane">
          {section === "Appearance" && (
            <>
              <Row title="Theme">
                <div className="segmented">
                  {(["dark", "light"] as const).map((t) => (
                    <button key={t} aria-pressed={settings.appearance.theme === t} onClick={() => update((s) => ({ ...s, appearance: { ...s.appearance, theme: t } }))}>{tr(t === "dark" ? "Dark" : "Light")}</button>
                  ))}
                </div>
              </Row>
              <Row title="Language">
                <select className="field" style={{ width: 200 }} aria-label={tr("Language")} value={settings.appearance.language} onChange={(e) => update((s) => ({ ...s, appearance: { ...s.appearance, language: e.target.value as "auto" | "en" | "pt-BR" } }))}>
                  {LANGUAGES.map((l) => <option key={l.id} value={l.id}>{tr(l.label)}</option>)}
                </select>
              </Row>
              <Row title="Card density">
                <div className="segmented">
                  {(["cozy", "compact"] as const).map((d) => (
                    <button key={d} aria-pressed={settings.appearance.density === d} onClick={() => update((s) => ({ ...s, appearance: { ...s.appearance, density: d } }))}>{tr(d === "cozy" ? "Cozy" : "Compact")}</button>
                  ))}
                </div>
              </Row>
              <Row title="Interface font size"><NumberField label="Interface font size" value={settings.appearance.fontSize} min={12} max={22} onChange={(n) => update((s) => ({ ...s, appearance: { ...s.appearance, fontSize: n } }))} /></Row>
            </>
          )}
          {section === "Editor" && (
            <>
              <Row title="Line numbers"><Toggle label="Line numbers" checked={settings.editor.lineNumbers} onChange={(v) => update((s) => ({ ...s, editor: { ...s.editor, lineNumbers: v } }))} /></Row>
              <Row title="Word wrap"><Toggle label="Word wrap" checked={settings.editor.wordWrap} onChange={(v) => update((s) => ({ ...s, editor: { ...s.editor, wordWrap: v } }))} /></Row>
              <Row title="Editor font size"><NumberField label="Editor font size" value={settings.editor.fontSize} min={11} max={26} onChange={(n) => update((s) => ({ ...s, editor: { ...s.editor, fontSize: n } }))} /></Row>
              <Row title="Autosave delay" hint="Milliseconds after you stop typing (200–5000)."><NumberField label="Autosave delay" value={settings.editor.autosaveDelay} min={200} max={5000} step={100} onChange={(n) => update((s) => ({ ...s, editor: { ...s.editor, autosaveDelay: n } }))} /></Row>
            </>
          )}
          {section === "Files" && (
            <>
              <Row title="Assets folder" hint="Pasted and dropped images are copied here.">
                <input className="field" style={{ width: 180 }} aria-label="Assets folder" defaultValue={settings.files.assetsFolder} onBlur={(e) => update((s) => ({ ...s, files: { ...s.files, assetsFolder: e.target.value } }))} />
              </Row>
              <Row title="Trash retention" hint="Days before deleted notes are removed for good. 0 keeps them until you empty the trash.">
                <NumberField label="Trash retention days" value={settings.files.trashRetentionDays} min={0} max={3650} onChange={(n) => update((s) => ({ ...s, files: { ...s.files, trashRetentionDays: n } }))} />
              </Row>
              <Row title="Ignored folders" hint="Comma separated. node_modules, .git and .bmnotes are always ignored.">
                <input
                  className="field"
                  style={{ width: 220 }}
                  aria-label="Ignored folders"
                  value={ignored}
                  onChange={(e) => setIgnored(e.target.value)}
                  onBlur={() => {
                    update((s) => ({ ...s, files: { ...s.files, ignoredFolders: ignored.split(",").map((x) => x.trim()).filter(Boolean) } }));
                    void useWorkspace.getState().syncWithDisk();
                  }}
                />
              </Row>
            </>
          )}
          {section === "Daily Notes" && (
            <Row title="Daily notes folder" hint="New daily notes are created as YYYY-MM-DD.md here.">
              <input className="field" style={{ width: 180 }} aria-label="Daily notes folder" defaultValue={settings.files.dailyFolder} onBlur={(e) => update((s) => ({ ...s, files: { ...s.files, dailyFolder: e.target.value } }))} />
            </Row>
          )}
          {section === "Board" && (
            <>
              <Row title="Dotted grid"><Toggle label="Dotted grid" checked={settings.board.grid} onChange={(v) => update((s) => ({ ...s, board: { ...s.board, grid: v } }))} /></Row>
              <Row title="Snap to grid"><Toggle label="Snap to grid" checked={settings.board.snap} onChange={(v) => update((s) => ({ ...s, board: { ...s.board, snap: v } }))} /></Row>
              <Row title="Show connections" hint="Lines drawn from [[wiki links]] and manual links."><Toggle label="Show connections" checked={settings.board.showConnections} onChange={(v) => update((s) => ({ ...s, board: { ...s.board, showConnections: v } }))} /></Row>
            </>
          )}
          {section === "Backup" && <BackupPanel />}
          {section === "Updates" && <UpdatesPanel />}
          {section === "Plugins" && <PluginsPanel />}
          {section === "Sync" && <GithubConnect><SyncPanel /></GithubConnect>}
          {section === "Keyboard" && <div style={{ margin: "-18px -22px" }}><ShortcutsSettings /><ShortcutsList /></div>}
        </div>
      </div>
      <div className="px-5 py-3" style={{ borderTop: "2px dashed var(--line-soft)", color: "var(--ink-faint)" }}>
        {tr("Saved to")} <span className="kbd">.bmnotes/settings.json</span> {tr("inside your workspace.")}
      </div>
    </Dialog>
  );
}

export function AboutDialog() {
  const tr = useTr();
  const setDialog = useUi((s) => s.setDialog);
  const root = useWorkspace((s) => s.info?.root);
  return (
    <Dialog title="About bmnotes" onClose={() => setDialog(null)} width={500}>
      <div className="px-5 pb-5 flex flex-col gap-3 selectable">
        <div className="flex items-center gap-3"><LogoMark width={46} height={46} /><div><div className="handwritten-label" style={{ fontSize: "1.9rem" }}>bmnotes</div><div style={{ color: "var(--ink-dim)" }}>{tr("Version 0.1.0 — a local-first spatial Markdown workspace.")}</div></div></div>
        <p className="m-0 handwritten-label" style={{ fontSize: "1.5rem", color: "var(--ink)" }}>{tr("Your notes are just files.")}</p>
        <div className="shortcut-row"><span>{tr("Data model")}</span><span>{tr("Plain Markdown + local assets.")}</span></div>
        <div className="shortcut-row"><span>{tr("Mural metadata")}</span><span className="kbd">.bmnotes/</span></div>
        <div className="shortcut-row"><span>{tr("Network")}</span><span>{tr("Off by default. Only the optional GitHub sync and update check use it.")}</span></div>
        {root && <div className="shortcut-row"><span>{tr("Workspace")}</span><span className="truncate" style={{ maxWidth: 300 }} title={root}>{root}</span></div>}
        <div className="flex justify-end">
          <button className="btn" onClick={() => void ipc.reveal("").catch(() => {})}>{tr("Reveal workspace in filesystem")}</button>
        </div>
      </div>
    </Dialog>
  );
}
