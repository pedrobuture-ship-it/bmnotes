import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Handle, NodeResizer, Position, useStore, type NodeProps } from "@xyflow/react";
import { MoreHorizontal } from "lucide-react";
import { useBoard } from "@/stores/board";
import { useWorkspace } from "@/stores/workspace";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { MarkdownEditor } from "@/features/editor/MarkdownEditor";
import { Preview } from "@/features/editor/Preview";
import { basename, stripExt } from "@/lib/paths";
import { hashUnit } from "@/lib/board";
import { renameNoteFromTitle } from "@/lib/actions";
import { isEncrypted } from "@/lib/crypto";
import { extractTasks } from "@/lib/tasks";
import type { CardColor } from "@/types";
import { useTr } from "@/lib/i18n";

export interface NoteNodeData extends Record<string, unknown> {
  path: string;
  color: CardColor;
  dim: boolean;
  onMenu: (path: string, x: number, y: number) => void;
}

export const NoteNode = memo(function NoteNode({ data, selected, dragging }: NodeProps) {
  const tr = useTr();
  const { path, color, dim, onMenu } = data as NoteNodeData;
  const note = useWorkspace((s) => s.notes[path]);
  const tags = useWorkspace((s) => s.index.meta.get(path)?.tags);
  const setContent = useWorkspace((s) => s.setContent);
  const editorSettings = useSettings((s) => s.settings.editor);
  const editing = useUi((s) => s.editingCard === path);
  const renaming = useUi((s) => s.renamingCard === path);
  const setEditing = useUi((s) => s.setEditingCard);
  const setRenaming = useUi((s) => s.setRenamingCard);
  const openNote = useUi((s) => s.openNote);
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [clamp, setClamp] = useState(false);
  const tilt = useMemo(() => `${(hashUnit(path) * 0.9).toFixed(2)}deg`, [path]);
  const fileName = basename(path);
  // Level of detail: zoomed far out, cards become labelled paper (keeps 1000s of notes smooth).
  const lod = useStore((s) => s.transform[2] < 0.45);

  // Leave edit mode when clicking anywhere outside this card (no modal, contextual editing).
  useEffect(() => {
    if (!editing) return;
    const down = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setEditing(null);
    };
    window.addEventListener("pointerdown", down, true);
    return () => window.removeEventListener("pointerdown", down, true);
  }, [editing, setEditing]);

  // Only fade the bottom edge when the preview is actually cut off.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || editing) return;
    const check = () => setClamp(el.scrollHeight > el.clientHeight + 2);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [note?.content, editing]);

  const options = useMemo(() => ({ lineNumbers: false, wordWrap: true, fontSize: Math.max(12, editorSettings.fontSize - 2) }), [editorSettings.fontSize]);

  const taskStat = useMemo(() => {
    const t = note ? extractTasks(note.content) : [];
    return { total: t.length, done: t.filter((x) => x.done).length };
  }, [note]);

  if (!note) return null;
  if (lod && !editing) {
    return (
      <div className="note-node paper-card note-lod" data-color={color} data-selected={selected} style={{ ["--tilt" as string]: tilt, opacity: dim ? 0.28 : 1, animation: "none" }}>
        <Handle type="source" position={Position.Left} id="l" />
        <Handle type="source" position={Position.Right} id="r" />
        <span>{stripExt(fileName)}</span>
      </div>
    );
  }
  const commitTitle = (value: string) => {
    setRenaming(null);
    const v = value.trim();
    if (v && v !== stripExt(fileName)) void renameNoteFromTitle(path, v);
  };

  return (
    <div
      ref={rootRef}
      className="note-node paper-card"
      data-color={color}
      data-selected={selected}
      data-dragging={dragging}
      data-editing={editing}
      style={{ ["--tilt" as string]: tilt, opacity: dim ? 0.28 : 1 }}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest(".note-head")) return;
        e.stopPropagation();
        if (isEncrypted(note.content)) useUi.getState().openNote(path);
        else setEditing(path);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.currentTarget.closest('.board-root[data-navigating="true"]')) return;
        onMenu(path, e.clientX, e.clientY);
      }}
    >
      <NodeResizer minWidth={180} minHeight={110} isVisible={selected && !editing} onResizeEnd={(_, p) => useBoard.getState().patchCards({ [path]: { x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.width), h: Math.round(p.height) } })} lineStyle={{ borderColor: "var(--amber)", borderStyle: "dashed" }} />
      <span className="tape" aria-hidden="true" />
      <Handle type="source" position={Position.Left} id="l" />
      <Handle type="source" position={Position.Right} id="r" />
      <div className="note-head">
        <div className="fname" onDoubleClick={(e) => { e.stopPropagation(); setRenaming(path); }} title={path}>
          {renaming ? (
            <input
              className="nodrag"
              autoFocus
              defaultValue={stripExt(fileName)}
              aria-label={tr("Note name")}
              onFocus={(e) => e.currentTarget.select()}
              onBlur={(e) => commitTitle(e.currentTarget.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") setRenaming(null);
              }}
              onDoubleClick={(e) => e.stopPropagation()}
            />
          ) : (
            fileName
          )}
        </div>
        <button className="nodrag" aria-label={tr("Card menu")} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); onMenu(path, r.left, r.bottom + 4); }}>
          <MoreHorizontal size={16} />
        </button>
      </div>
      <div ref={bodyRef} className={`note-body-card ${editing ? "nodrag nowheel nopan" : ""}`} data-editing={editing} data-clamp={!editing && clamp}>
        {editing ? (
          <MarkdownEditor
            docKey={path}
            value={note.content}
            revision={note.revision}
            onChange={(v) => setContent(path, v)}
            options={options}
            compact
            autoFocus
            onEscape={() => setEditing(null)}
            placeholderText="Write something…"
          />
        ) : note.content.trim() ? (
          <Preview path={path} content={note.content} />
        ) : (
          <p className="m-0 italic" style={{ opacity: 0.55 }} onDoubleClick={() => setEditing(path)}>{tr("Empty note — double-click to write.")}</p>
        )}
      </div>
      <div className="note-foot">
        {taskStat.total > 0 && <span className="chip" data-tip={tr("Tasks done")} aria-label={`${taskStat.done} of ${taskStat.total} tasks done`}>☑ {taskStat.done}/{taskStat.total}</span>}
        {(tags ?? []).slice(0, 4).map((t) => <span key={t} className="chip">#{t}</span>)}
        {tags && tags.length > 4 && <span className="chip">+{tags.length - 4}</span>}
        {selected && !editing && (
          <button className="chip nodrag ml-auto" style={{ cursor: "pointer" }} onClick={() => openNote(path)}>open as page</button>
        )}
      </div>
    </div>
  );
});
