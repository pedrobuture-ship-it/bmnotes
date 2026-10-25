import { useState } from "react";
import { FolderOpen, FolderPlus } from "lucide-react";
import { LogoMark, ArrowDoodle, Star } from "@/components/doodles";
import { useWorkspace } from "@/stores/workspace";
import { createWorkspaceFlow, openFolderFlow } from "./flows";
import { useTr } from "@/lib/i18n";

export function Onboarding() {
  const tr = useTr();
  const [demo, setDemo] = useState(false);
  const error = useWorkspace((s) => s.error);
  const loading = useWorkspace((s) => s.loading);
  return (
    <main className="onboarding">
      <div className="onboarding-card paper-card">
        <div className="flex justify-center mb-2"><LogoMark width={64} height={64} /></div>
        <h1>bm<b>notes</b></h1>
        <p className="tagline">{tr("Your notes are just files.")}</p>
        <p style={{ margin: "0 auto 22px", maxWidth: 440, fontFamily: "var(--font-body)", color: "#4a3f2d" }}>
          {tr("Pick a folder of Markdown files and spread them out on an infinite hand-drawn wall. No account, no cloud, no lock-in.")}
        </p>
        {error && <p role="alert" style={{ color: "#8a2f1d", fontWeight: 700 }}>{tr("Couldn't open the folder: {e}", { e: error })}</p>}
        <div className="flex gap-3 justify-center flex-wrap">
          <button className="btn btn-primary" disabled={loading} onClick={() => void openFolderFlow()}><FolderOpen size={17} /> {tr("Open Folder")}</button>
          <button className="btn" style={{ color: "var(--ink)" }} disabled={loading} onClick={() => void createWorkspaceFlow(demo)}><FolderPlus size={17} /> {tr("Create Workspace")}</button>
        </div>
        <label className="flex items-center justify-center gap-2 mt-4" style={{ color: "#4a3f2d", cursor: "pointer" }}>
          <input type="checkbox" checked={demo} onChange={(e) => setDemo(e.target.checked)} />
          {tr("Include a few demo notes in the new workspace")}
        </label>
        <div className="flex items-center justify-center gap-3 mt-5" style={{ color: "#8a6a1f" }}>
          <Star /><ArrowDoodle style={{ width: 70, height: 40 }} /><span className="handwritten-label" style={{ color: "#6a4f12", fontSize: "1.4rem" }}>{tr("works fully offline")}</span>
        </div>
      </div>
    </main>
  );
}
