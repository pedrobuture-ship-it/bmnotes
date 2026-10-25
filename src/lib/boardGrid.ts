export const BOARD_GRID_GAP = 22;

/** Drop every other dot as zoom decreases, keeping at least 12 screen pixels between dots. */
export function boardGridScale(zoom: number): number {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return Math.max(1, 2 ** Math.ceil(Math.log2(12 / (BOARD_GRID_GAP * safeZoom))));
}
