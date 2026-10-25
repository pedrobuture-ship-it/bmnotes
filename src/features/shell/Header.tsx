import { ChevronLeft, ChevronRight, Cloud, CloudAlert, Command, FolderOpen, Moon, RefreshCw, Search, Settings, Sun } from "lucide-react";
import { LogoMark } from "@/components/doodles";
import { useUi } from "@/stores/ui";
import { useSettings } from "@/stores/settings";
import { useSync } from "@/stores/sync";
import { openFolderFlow } from "@/features/onboarding/flows";
import { useTr } from "@/lib/i18n";

export function Header() {
  const tr = useTr();
  const setDialog = useUi((s) => s.setDialog);
  const toggleSidebar = useUi((s) => s.toggleSidebar);
  const theme = useSettings((s) => s.settings.appearance.theme);
  const update = useSettings((s) => s.update);
  const canBack = useUi((s) => s.histIdx > 0);
  const canForward = useUi((s) => s.histIdx < s.history.length - 1);
  const sync = useSync((s) => s.info);
  const syncing = useSync((s) => s.busy);
  const syncError = useSync((s) => s.error);
  const syncNow = useSync((s) => s.syncNow);
  const next = theme === "dark" ? "light" : "dark";
  return (
    <header className="header">
      <button className="logo" onClick={toggleSidebar} aria-label={`bmnotes — ${tr("Toggle sidebar")}`} data-tip={`${tr("Toggle sidebar")} (Ctrl+B)`}>
        <LogoMark />
        <span>bm<b>notes</b></span>
      </button>
      <button className="btn btn-ghost btn-icon" disabled={!canBack} onClick={() => useUi.getState().goBack()} aria-label={tr("Back")} data-tip={`${tr("Back")} (Alt+←)`}><ChevronLeft size={17} /></button>
      <button className="btn btn-ghost btn-icon" disabled={!canForward} onClick={() => useUi.getState().goForward()} aria-label={tr("Forward")} data-tip={`${tr("Forward")} (Alt+→)`}><ChevronRight size={17} /></button>
      <button className="search-trigger" onClick={() => setDialog("search")} aria-label={tr("Search notes")}>
        <Search size={16} />
        <span className="flex-1">{tr("Search notes…")}</span>
        <span className="kbd">Ctrl P</span>
      </button>
      <button className="btn" onClick={() => setDialog("palette")} aria-label={tr("Command palette")}>
        <Command size={15} /> <span className="kbd">Ctrl K</span>
      </button>
      <div className="flex-1" />
      {sync?.linked && (
        <button
          className="btn btn-ghost btn-icon"
          style={sync.conflicts.length || syncError ? { color: "var(--red)" } : undefined}
          aria-label={tr("Sync status")}
          data-tip={syncing ? tr("Syncing…") : sync.conflicts.length ? tr("Conflicts to resolve") : syncError ? tr("Sync failed: {e}", { e: syncError }) : tr("Synced with GitHub (click to sync now)")}
          onClick={() => (sync.conflicts.length ? useUi.getState().openSettings("Sync") : void syncNow())}
        >
          {syncing ? <RefreshCw size={17} className="spin" /> : sync.conflicts.length || syncError ? <CloudAlert size={17} /> : <Cloud size={17} />}
        </button>
      )}
      <button className="btn btn-ghost btn-icon" onClick={() => update((s) => ({ ...s, appearance: { ...s.appearance, theme: next } }))} aria-label={tr(next === "light" ? "Switch to light theme" : "Switch to dark theme")} data-tip={tr(next === "light" ? "Switch to light theme" : "Switch to dark theme")}>{theme === "dark" ? <Moon size={17} /> : <Sun size={17} />}</button>
      <button className="btn btn-ghost btn-icon" onClick={() => setDialog("settings")} aria-label={tr("Settings")} data-tip={`${tr("Settings")} (Ctrl+,)`}><Settings size={17} /></button>
      <button className="btn" onClick={() => void openFolderFlow()}><FolderOpen size={16} /> {tr("Open folder")}</button>
    </header>
  );
}
