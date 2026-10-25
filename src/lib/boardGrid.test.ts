import { expect, it } from "vitest";
import { BOARD_GRID_GAP, boardGridScale } from "./boardGrid";

it("bounds the number of grid dots at every supported zoom without changing their origin", () => {
  for (let step = 5; step <= 250; step++) {
    const zoom = step / 100;
    const scale = boardGridScale(zoom);
    const screenGap = BOARD_GRID_GAP * scale * zoom;
    expect(screenGap).toBeGreaterThanOrEqual(12);
    // A power-of-two multiplier preserves the existing dot lattice when density changes.
    expect(Number.isInteger(Math.log2(scale))).toBe(true);
    if (scale > 1) expect(screenGap).toBeLessThan(24);
  }
  expect(boardGridScale(1)).toBe(1);
  expect(boardGridScale(0.05)).toBe(16);
  expect(boardGridScale(Number.NaN)).toBe(1);
});
