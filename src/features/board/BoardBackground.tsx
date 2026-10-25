import { memo } from "react";
import { Background, BackgroundVariant, useStore } from "@xyflow/react";
import { BOARD_GRID_GAP, boardGridScale } from "@/lib/boardGrid";

/** A full-density SVG pattern at zoom 0.05 makes WebKit paint hundreds of thousands of dots. */
export const BoardBackground = memo(function BoardBackground({ theme }: { theme: "light" | "dark" }) {
  const scale = useStore((s) => boardGridScale(s.transform[2]));
  return <Background variant={BackgroundVariant.Dots} gap={BOARD_GRID_GAP * scale} size={1.6 * scale} color={theme === "light" ? "rgb(90 65 20 / 0.2)" : "rgb(255 255 255 / 0.11)"} />;
});
