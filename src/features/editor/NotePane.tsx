import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Link2, ListTree, Check, CircleAlert, Loader2, Lock, LockOpen, Pin, PinOff } from "lucide-react";
import { lockNote, relockNote, togglePin, unlockNote } from "@/lib/actions";
import { isEncrypted } from "@/lib/crypto";
import { useLocks } from "@/stores/locks";
import { useSync } from "@/stores/sync";
import { useTr } from "@/lib/i18n";
import { useWorkspace } from "@/stores/workspace";
import { useSettings } from "@/stores/settings";
import { useUi, type NoteMode } from "@/stores/ui";
import { basename } from "@/lib/paths";
import { extractHeadings } from "@/lib/headings";
import { propText, splitFrontmatter } from "@/lib/frontmatter";
import { UnlinkedMentions } from "./UnlinkedMentions";
import { MarkdownEditor } from "./MarkdownEditor";
import { Preview } from "./Preview";
import { Squiggle } from "@/components/doodles";

export function SaveIndicator() {
  const tr = useTr();
  const status = useWorkspace((s) => s.saveStatus);
  if (status === "idle") return <span className="save-pill" data-status="idle" aria-live="polite">&nbsp;</span>;
  return (
    <span className="save-pill" data-status={status} aria-live="polite">
      {status === "saving" && <><Loader2 size={14} className="animate-spin" /> {tr("Saving...")}</>}
      {status === "saved" && <><Check size={14} /> {tr("Saved")}</>}
      {status === "error" && <><CircleAlert size={14} /> {tr("Save failed")}</>}
    </span>
  );
}

/** Shown instead of the editor while a note is encrypted. */
function LockedView({ path }: { path: string }) {
  const tr = useTr();
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!pw) return;
    setBusy(true);
    const ok = await unlockNote(path, pw);
    setBusy(false);
    if (ok) setPw("");
  };
  return (
    <div className="empty h-full">
      <Lock size={42} style={{ color: "var(--amber)" }} />
      <p className="hand">{tr("This note is encrypted.")}</p>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <input className="field" type="password" autoFocus autoComplete="off" placeholder={tr("Password")} aria-label={tr("Password")} value={pw} onChange={(e) => setPw(e.target.value)} />
        <button className="btn btn-primary" type="submit" disabled={busy || !pw}>{busy ? "Unlocking…" : "Unlock"}</button>
      </form>
      <small style={{ color: "var(--ink-faint)", maxWidth: 360, textAlign: "center" }}>{tr("Unlocking turns the file back into plain text until you lock it again. Lost passwords cannot be recovered.")}</small>
    </div>
  );
}

export function NotePane({ path }: { path: string }) {
  const note = useWorkspace((s) => s.notes[path]);
  const setContent = useWorkspace((s) => s.setContent);
  const resolveConflict = useWorkspace((s) => s.resolveConflict);
  const backlinks = useWorkspace((s) => s.index.backlinks.get(path));
  const meta = useWorkspace((s) => s.index.meta);
  const editor = useSettings((s) => s.settings.editor);
  const mode = useUi((s) => s.noteMode);
  const setMode = useUi((s) => s.setNoteMode);
  const openNote = useUi((s) => s.openNote);
  const setView = useUi((s) => s.setView);

  const tr = useTr();
  // Select the stable array and filter outside: a selector returning a new array loops forever.
  const presence = useSync((s) => s.presence);
  const others = useMemo(() => presence.filter((p) => p.note === path), [presence, path]);
  const changedRemotely = useSync((s) => s.info?.remoteChanged.includes(path) ?? false);
  useEffect(() => { void useSync.getState().check(); }, [path]);
  const unlockedHere = useLocks((s) => path in s.passwords);
  const pinned = useSettings((s) => s.settings.nav.pinned.includes(path));
  const pending = useUi((s) => s.pendingHeading);
  const [jump, setJump] = useState<{ line: number; nonce: number } | null>(null);
  const previewRef = useRef<HTMLElement>(null);
  const noteContent = note?.content;
  // Opened through [[note#Section]]: scroll the preview and put the editor cursor on that heading.
  useEffect(() => {
    if (!pending || noteContent === undefined) return;
    const h = extractHeadings(noteContent).find((x) => x.slug === pending);
    if (h) setJump({ line: h.line, nonce: Date.now() });
    const root = previewRef.current;
    if (!root) { useUi.getState().setPendingHeading(null); return; }
    // Preview HTML arrives asynchronously from its worker.
    const scroll = () => {
      if (root.querySelector('[aria-busy="true"]')) return;
      const target = root.querySelector(`[data-heading="${CSS.escape(pending)}"]`);
      target?.scrollIntoView({ block: "start" });
      useUi.getState().setPendingHeading(null);
    };
    const observer = new MutationObserver(scroll);
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-busy"] });
    const frame = requestAnimationFrame(scroll);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [pending, noteContent, mode]);

  const props = useMemo(() => (noteContent ? Object.entries(splitFrontmatter(noteContent).data).filter(([, v]) => (Array.isArray(v) ? v.length : v !== "")) : []), [noteContent]);

  const options = useMemo(() => ({ lineNumbers: editor.lineNumbers, wordWrap: editor.wordWrap, fontSize: editor.fontSize }), [editor.lineNumbers, editor.wordWrap, editor.fontSize]);

  if (!note) {
    return (
      <div className="empty h-full">
        <p className="hand">{tr("This note is gone.")}</p>
        <button className="btn" onClick={() => setView("board")}>{tr("Back to the mural")}</button>
      </div>
    );
  }

  if (isEncrypted(note.content)) {
    return (
      <div className="note-pane">
        <div className="note-toolbar">
          <button className="btn btn-ghost btn-icon" onClick={() => setView("board")} aria-label={tr("Back to mural")} data-tip={tr("Back to mural")}><ArrowLeft size={16} /></button>
          <span className="handwritten-label" style={{ fontSize: "1.6rem" }}>{basename(path)}</span>
        </div>
        <LockedView path={path} />
      </div>
    );
  }

  const modes: { id: NoteMode; label: string }[] = [
    { id: "edit", label: "Edit" },
    { id: "split", label: "Split" },
    { id: "preview", label: "Preview" },
  ];

  return (
    <div className="note-pane">
      <div className="note-toolbar">
        <button className="btn btn-ghost btn-icon" onClick={() => setView("board")} aria-label={tr("Back to mural")} data-tip={tr("Back to mural")}><ArrowLeft size={16} /></button>
        <span className="handwritten-label" style={{ fontSize: "1.6rem" }}>{basename(path)}</span>
        <div className="flex-1" />
        <SaveIndicator />
        {unlockedHere
          ? <button className="btn" onClick={() => void relockNote(path)} data-tip={tr("Encrypt again with the same password")}><Lock size={15} /> {tr("Lock again")}</button>
          : <button className="btn btn-ghost btn-icon" onClick={() => void lockNote(path)} aria-label={tr("Encrypt note")} data-tip={tr("Encrypt with a password")}><LockOpen size={16} /></button>}
        <button className="btn btn-ghost btn-icon" onClick={() => useUi.getState().setDialog("mindmap")} aria-label={tr("Mind map")} data-tip={tr("Mind map of the headings")}><ListTree size={16} /></button>
        <button className="btn btn-ghost btn-icon" onClick={() => togglePin(path)} aria-label={pinned ? "Unpin note" : "Pin note"} data-tip={pinned ? "Unpin" : "Pin to top of the sidebar"}>{pinned ? <PinOff size={16} /> : <Pin size={16} />}</button>
        <div className="segmented" role="group" aria-label={tr("View mode")}>
          {modes.map((m) => (
            <button key={m.id} aria-pressed={mode === m.id} onClick={() => setMode(m.id)}>{m.label}</button>
          ))}
        </div>
      </div>

      {note.conflict !== null && (
        <div className="banner" role="alert">
          <CircleAlert size={16} />
          <span className="flex-1">{tr("This file changed on disk while you have unsaved edits.")}</span>
          <button className="btn" onClick={() => resolveConflict(path, true)}>{tr("Keep mine")}</button>
          <button className="btn" onClick={() => resolveConflict(path, false)}>{tr("Load disk version")}</button>
        </div>
      )}

      {others.length > 0 && (
        <div className="banner" role="status">
          <span aria-hidden="true">👥</span>
          <span className="flex-1">{tr("{names} is on this note right now.", { names: others.map((o) => o.login).join(", ") })}</span>
        </div>
      )}
      {changedRemotely && (
        <div className="banner" role="alert">
          <CircleAlert size={16} />
          <span className="flex-1">{tr("Someone changed this note on the remote. Sync before editing to avoid a conflict.")}</span>
          <button className="btn" onClick={() => void useSync.getState().syncNow()}>{tr("Sync now")}</button>
        </div>
      )}
      {unlockedHere && (
        <div className="banner" role="status">
          <LockOpen size={16} />
          <span className="flex-1">{tr("Unlocked: the file on disk is plain text until you lock it again.")}</span>
        </div>
      )}

      {props.length > 0 && (
        <div className="props-bar" aria-label={tr("Properties")}>
          {props.map(([k, v]) => (
            <span key={k} className="chip" data-tip={k}><b>{k}:</b> {propText(v)}</span>
          ))}
        </div>
      )}

      <div className="note-body" data-mode={mode}>
        {mode !== "preview" && (
          <section className="note-editor-wrap" aria-label={tr("Editor")}>
            <MarkdownEditor docKey={path} value={note.content} revision={note.revision} onChange={(v) => setContent(path, v)} options={options} autoFocus scrollToLine={jump} />
          </section>
        )}
        {mode !== "edit" && (
          <section ref={previewRef} className="note-preview-wrap" aria-label={tr("Preview")}>
            {note.content.trim() ? (
              <Preview path={path} content={note.content} embeds />
            ) : (
              <div className="empty"><Squiggle style={{ color: "var(--amber)" }} /><p className="hand">{tr("Nothing here yet.")}</p><p>{tr("Start typing in the editor.")}</p></div>
            )}
          </section>
        )}
      </div>

      <div className="backlinks" aria-label={tr("Backlinks")}>
        <div className="handwritten-label" style={{ fontSize: "1.35rem" }}><Link2 size={14} className="inline mr-1" />{tr("Backlinks")}</div>
        {backlinks && backlinks.length > 0 ? (
          <ul className="m-0 mt-1 p-0 list-none flex flex-wrap gap-2">
            {backlinks.map((p) => (
              <li key={p}>
                <button className="chip" onClick={() => openNote(p)} data-tip={p}>{meta.get(p)?.title ?? basename(p)}</button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0 mt-1" style={{ color: "var(--ink-faint)" }}>No other note links here yet. Use [[{basename(path).replace(/\.md$/i, "")}]] from another note.</p>
        )}
      </div>
      <UnlinkedMentions path={path} />
    </div>
  );
}
