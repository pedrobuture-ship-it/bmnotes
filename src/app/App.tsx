import { useEffect, useRef } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { Network, X, LayoutDashboard, Clock3 } from "lucide-react";
import { Header } from "@/features/shell/Header";
import { Sidebar } from "@/features/sidebar/Sidebar";
import { Board } from "@/features/board/Board";
import { NotePane, SaveIndicator } from "@/features/editor/NotePane";
import { GraphExplorer } from "@/features/graph/GraphExplorer";
import { Onboarding } from "@/features/onboarding/Onboarding";
import { SearchDialog } from "@/features/search/SearchDialog";
import { CommandPalette } from "@/features/search/CommandPalette";
import { SettingsDialog, ShortcutsDialog, AboutDialog } from "@/features/settings/Dialogs";
import { useGlobalShortcuts } from "@/features/shell/useGlobalShortcuts";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ChoiceDialog, ConfirmDialog, PickDialog, PromptDialog, Toasts } from "@/components/Dialogs";
import { useWorkspace, getLastWorkspace } from "@/stores/workspace";
import { useSettings } from "@/stores/settings";
import { useBoard } from "@/stores/board";
import { useUi } from "@/stores/ui";
import { basename } from "@/lib/paths";
import { ipc } from "@/lib/ipc";
import { TemplateDialog } from "@/features/templates/TemplateDialog";
import { RecordDialog } from "@/features/audio/RecordDialog";
import { TableDialog } from "@/features/tables/TableDialog";
import { CalendarDialog } from "@/features/calendar/CalendarDialog";
import { usePluginsLoader } from "@/features/shell/usePluginsLoader";
import { useDueReminder } from "@/features/shell/useDueReminder";
import { MindMapDialog } from "@/features/mindmap/MindMapDialog";
import { HealthDialog } from "@/features/health/HealthDialog";
import { PropertiesDialog } from "@/features/properties/PropertiesDialog";
import { Timeline } from "@/features/timeline/Timeline";
import { useTr } from "@/lib/i18n";
import { TasksDialog } from "@/features/tasks/TasksDialog";
import { TrashDialog } from "@/features/trash/TrashDialog";
import { useUpdateCheck } from "@/features/shell/useUpdateCheck";
import { usePresence } from "@/features/shell/usePresence";
import { useAutoBackup } from "@/features/shell/useAutoBackup";
import { useAutoSync } from "@/features/shell/useAutoSync";

function MainArea() {
  const view = useUi((s) => s.view);
  const active = useUi((s) => s.activeNote);
  const setView = useUi((s) => s.setView);
  const closeNote = useUi((s) => s.closeNote);
  const tr = useTr();
  const boardReady = useBoard((s) => s.ready);
  const activeBoard = useBoard((s) => s.activeId);
  return (
    <div className="main">
      <div className="main-tabs" role="tablist">
        <button role="tab" className="main-tab" aria-selected={view === "board"} onClick={() => setView("board")}><LayoutDashboard size={15} /><span className="label">{tr("Mural")}</span></button>
        <button role="tab" className="main-tab" aria-selected={view === "graph"} onClick={() => setView("graph")}><Network size={15} /><span className="label">{tr("Explore")}</span></button>
        <button role="tab" className="main-tab" aria-selected={view === "timeline"} onClick={() => setView("timeline")}><Clock3 size={15} /><span className="label">{tr("Timeline")}</span></button>
        {active && (
          <div role="tab" className="main-tab" aria-selected={view === "note"} tabIndex={0} onClick={() => useUi.getState().openNote(active)} onKeyDown={(e) => e.key === "Enter" && useUi.getState().openNote(active)}>
            <span className="label">{basename(active)}</span>
            <button aria-label={tr("Close note")} onClick={(e) => { e.stopPropagation(); closeNote(); }} className="btn-ghost" style={{ lineHeight: 0 }}><X size={14} /></button>
          </div>
        )}
        <div className="flex-1" />
        <div className="pb-1.5 pr-1"><SaveIndicator /></div>
      </div>
      <div className="main-content">
        <ErrorBoundary resetKey={`${view}:${active ?? ""}`} onBack={view === "board" ? undefined : () => setView("board")}>
          {view === "board" && (boardReady ? <Board key={activeBoard} /> : <div className="empty h-full"><p className="hand">{tr("Laying out the wall…")}</p></div>)}
          {view === "graph" && <GraphExplorer />}
          {view === "timeline" && <Timeline />}
          {view === "note" && active && <NotePane path={active} />}
        </ErrorBoundary>
      </div>
    </div>
  );
}

export function App() {
  const tr = useTr();
  const zen = useUi((s) => s.zen);
  const info = useWorkspace((s) => s.info);
  const loading = useWorkspace((s) => s.loading);
  const openWorkspace = useWorkspace((s) => s.openWorkspace);
  const sidebarOpen = useUi((s) => s.sidebarOpen);
  const dialog = useUi((s) => s.dialog);
  const appearance = useSettings((s) => s.settings.appearance);
  const booted = useRef(false);

  useGlobalShortcuts(!!info);

  // Reopen the last workspace automatically.
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    // A folder given on the command line wins over the remembered workspace.
    void ipc.launchPath().catch(() => null).then((cli) => {
      const target = cli ?? getLastWorkspace();
      if (target) void openWorkspace(target);
    });
  }, [openWorkspace]);

  useEffect(() => {
    document.documentElement.style.setProperty("--ui-size", `${appearance.fontSize}px`);
    document.documentElement.dataset.density = appearance.density;
    document.documentElement.dataset.theme = appearance.theme;
    document.documentElement.style.colorScheme = appearance.theme;
  }, [appearance]);

  useAutoSync();
  useAutoBackup();
  usePresence();
  useUpdateCheck();
  useDueReminder();
  usePluginsLoader();

  // Flush pending saves when the window is closing / hidden.
  useEffect(() => {
    const flush = () => void useWorkspace.getState().flushAll();
    window.addEventListener("beforeunload", flush);
    const visibility = () => { if (document.hidden) flush(); };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  return (
    <ReactFlowProvider>
      <div className="app" data-zen={zen}>
        {!zen && <Header />}
        {info ? (
          <div className="body">
            {sidebarOpen && !zen && <Sidebar />}
            <MainArea />
          </div>
        ) : loading ? (
          <div className="empty h-full"><p className="hand">{tr("Opening your notes…")}</p></div>
        ) : (
          <Onboarding />
        )}
      </div>
      {info && dialog === "search" && <SearchDialog />}
      {info && dialog === "palette" && <CommandPalette />}
      {dialog === "settings" && <SettingsDialog />}
      {dialog === "shortcuts" && <ShortcutsDialog />}
      {dialog === "about" && <AboutDialog />}
      {info && dialog === "trash" && <TrashDialog />}
      {info && dialog === "templates" && <TemplateDialog />}
      {info && dialog === "tasks" && <TasksDialog />}
      {info && dialog === "properties" && <PropertiesDialog />}
      {info && dialog === "health" && <HealthDialog />}
      {info && dialog === "mindmap" && <MindMapDialog />}
      {info && dialog === "calendar" && <CalendarDialog />}
      {info && dialog === "table" && <TableDialog />}
      {info && dialog === "record" && <RecordDialog />}
      <ConfirmDialog />
      <ChoiceDialog />
      <PickDialog />
      <PromptDialog />
      <Toasts />
    </ReactFlowProvider>
  );
}
