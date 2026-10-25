export type BoardAction = "fit" | "zoomIn" | "zoomOut" | "newFrame" | "newNote";

/** Tiny event bus so commands outside the canvas (palette, shortcuts) can drive it. */
export function boardCommand(action: BoardAction) {
  window.dispatchEvent(new CustomEvent<BoardAction>("bmnotes:board", { detail: action }));
}

export function onBoardCommand(handler: (a: BoardAction) => void): () => void {
  const fn = (e: Event) => handler((e as CustomEvent<BoardAction>).detail);
  window.addEventListener("bmnotes:board", fn);
  return () => window.removeEventListener("bmnotes:board", fn);
}
