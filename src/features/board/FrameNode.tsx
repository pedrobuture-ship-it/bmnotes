import { memo, useState } from "react";
import { NodeResizer, type NodeProps } from "@xyflow/react";
import { useBoard } from "@/stores/board";
import type { CardColor } from "@/types";
import { useTr } from "@/lib/i18n";

export interface FrameNodeData extends Record<string, unknown> {
  id: string;
  title: string;
  color: CardColor;
  onMenu: (frameId: string, x: number, y: number) => void;
}

export const FrameNode = memo(function FrameNode({ data, selected }: NodeProps) {
  const tr = useTr();
  const { id, title, color, onMenu } = data as FrameNodeData;
  const patchFrame = useBoard((s) => s.patchFrame);
  const [editing, setEditing] = useState(false);

  return (
    <div
      className="frame-node board-frame"
      data-color={color}
      data-selected={selected}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.currentTarget.closest('.board-root[data-navigating="true"]')) return;
        onMenu(id, e.clientX, e.clientY);
      }}
    >
      <NodeResizer minWidth={160} minHeight={120} isVisible={selected} onResizeEnd={(_, p) => patchFrame(id, { x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.width), h: Math.round(p.height) })} lineStyle={{ borderColor: "var(--amber)" }} />
      {/* only the title tab and the border strip are grabbable so the inside stays free for the canvas */}
      <div className="frame-drag" onDoubleClick={() => setEditing(true)} title="Drag to move the frame">
        <span className="sticky-note frame-title">
          {editing ? (
            <input
              className="nodrag"
              autoFocus
              defaultValue={title}
              maxLength={40}
              aria-label={tr("Frame title")}
              onFocus={(e) => e.currentTarget.select()}
              onBlur={(e) => {
                setEditing(false);
                const v = e.currentTarget.value.trim();
                if (v) patchFrame(id, { title: v });
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") setEditing(false);
              }}
            />
          ) : (
            title
          )}
        </span>
      </div>
    </div>
  );
});
