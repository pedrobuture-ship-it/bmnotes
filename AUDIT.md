# bmnotes — final audit (v0.1.0)

## 1. Final architecture

- **Rust / Tauri 2** (`src-tauri/src`)
  - `filesystem/paths.rs`: the only place paths are validated (`safe_join`: no absolute paths, no `..`, no NUL,
    nearest existing ancestor must canonicalize *inside* the workspace, so symlink escapes are rejected).
  - `filesystem/ops.rs`: scan (never follows symlinks, skips `.git`, `node_modules`, `.bmnotes`, hidden folders),
    read, atomic write (temp + fsync + rename), create/rename/move/delete, asset import, `.bmnotes` metadata with
    whitelisted file names and rotating `board.json` backups.
  - `commands/`: the IPC surface (15 commands + `launch_path`). `watcher/`: debounced `notify` watcher that
    drops events caused by our own saves (content hash).
  - A read-only `bmnotes://` URI scheme serves **images only**, from inside the open workspace.
- **React 19 / TypeScript strict** (`src`)
  - `lib/`: pure, tested logic (wiki links, tags, titles, checkbox toggling, note index + backlinks, search,
    Markdown pipeline, board schema/normalisation, paths).
  - `stores/`: `workspace` (notes, autosave, external changes, conflicts, index), `board`, `settings`, `ui`.
  - `features/`: board (canvas), editor, sidebar, graph, search/palette, settings, onboarding, shell.
  - `styles/`: design system (tokens, `paper-card`, `sketch-border`, `handwritten-label`, `doodle-line`,
    `board-frame`, `sticky-note`…), CSS/SVG only, bundled offline fonts.
- Source of truth = the `.md` files. Visual data lives only in `.bmnotes/`.

## 2. Features implemented (all 42 prompts)

Foundation (Tauri + React shell, drawn-art design system) · open folder + auto-reopen last workspace · file
explorer (create/rename/move/delete with confirmation, drag & drop move, context menu) · CodeMirror editor with
autosave + Saving…/Saved · preview with highlighting, Edit/Preview/Split · infinite canvas (pan, zoom, minimap,
fit, drag, resize, multi-select, area select) persisted in `board.json` · double-click to create a note at the
cursor with inline title → safe slug rename · in-card editing · frames (cards move with their frame) · card
colours and context menu · wiki links, hand-drawn connections with preset/custom labels, manual links ·
backlinks · global search (Ctrl+P) · command palette (Ctrl+K, fuzzy) · tags · daily notes · interactive
checkboxes · image drop/paste into `assets/` · live filesystem watcher with conflict banner · graph explorer ·
shortcuts + shortcuts screen · settings (`.bmnotes/settings.json`) · animations (reduced-motion aware) ·
performance work · error recovery · board backups · onboarding + demo workspace · empty states with SVG
illustrations · opening existing Obsidian-style vaults · reveal workspace + About · tests · security review ·
README · release build.

## 3. Problems found

| # | Problem | Severity |
|---|---|---|
| 1 | `read_meta` joined a frontend-supplied file name onto `.bmnotes/` without validation (path traversal read). Found in the security pass. | High |
| 2 | `percent_decode` for `bmnotes://` URLs could panic on multi-byte input (string slicing on a non-char boundary). | Medium |
| 3 | Wiki-link resolver was rebuilt (sorting every path) for every link of every rendered card: 3,000 notes took ~23 s to open. | High (perf) |
| 4 | Context-menu helper returned unstable callbacks → effect loop → "Maximum update depth exceeded" on the board. | High |
| 5 | Rendering every card at fit-zoom (3,000 full Markdown cards), minimap calling `getComputedStyle` per node, every edit rebuilding all node objects. | High (perf) |
| 6 | Board mounted before the board file loaded, so the initial fit was computed on an empty board. | Medium |
| 7 | Dragging a frame left contained cards one drag tick behind the frame. | Low |
| 8 | Redundant dialog permissions (`ask`, `message`) in the Tauri capability. | Low |
| 9 | `Preview` memoisation defeated by an inline callback in cards. | Low |

## 4. Fixes made

1. `read_meta`/`write_meta` share one whitelist (`board.json`, `settings.json`, `board.corrupt.json`) and resolve
   through `safe_join` (also stops a symlinked `.bmnotes`). Test added.
2. Byte-wise percent decoding with a unit test (incl. UTF-8).
3. Resolver built once per index and reused. 3,000 notes: index 38 ms, search 14 ms.
4. `useContextMenu` returns memoised callbacks.
5. Level-of-detail cards below 45 % zoom, edges hidden when zoomed far out with many links, precomputed minimap
   colours, node/edge identity reuse, windowed sidebar lists, initial viewport computed up front.
   3,000 notes: ~23 s → ~2.7 s to a fully laid-out wall (dev build, software rendering).
6. Board renders only once loaded.
7. Frame drag derives member positions from the frame's final position.
8. Capability reduced to `dialog:allow-open`, `opener:allow-reveal-item-in-dir`, `opener:allow-open-url`.
9. Removed the inline callback.

Verification: `tsc`, `eslint` (no `any`), 24 Vitest tests, 12 Rust tests, plus end-to-end runs of the real UI
(headless Chromium with a stand-in for the IPC layer) and of the real Tauri binary (folder argument, `bmnotes://`
images, live watcher updates verified by editing files from outside). Release bundles built locally: `.deb`,
`.rpm`, AppImage.

## 5. Known gaps / future improvements

- Renaming/moving a note offers to rewrite `[[links]]` and relative `[text](note.md)` links (**done**).
- Delete now moves to `.bmnotes/trash/` with restore and configurable retention (**done**).
- Light theme (**done**).
- Only the Linux bundle was built and run here; Windows/macOS configs are standard Tauri but untested.
- Embeds (`![[note]]`) and `[[note#heading]]` links are supported in the preview; aliases and headings are not drawn in the graph.
- Canvas keyboard accessibility is limited to what React Flow provides (focusable nodes); a full keyboard
  navigation model for the mural would be a good next step.
- Conflict banner exists on the note page; a card being edited in place only gets a toast.
- Frontend bundle is ~1 MB (CodeMirror language data); could be split with dynamic imports.

## 6. Notes on later additions

- **Encrypted notes** use AES-GCM with a PBKDF2-SHA256 key (600k iterations). While a note is locked it is not indexed
  (no title, tags or links in the graph). Unlocking writes plain text to disk until "Lock again". Lost passwords are unrecoverable.
- **Extra murals** have no automatic file snapshots (only the main `board.json` does); with GitHub sync, Git is the history.
- **Backups** are plain ZIPs (not encrypted); the trash, `.git` and `node_modules` are skipped.

## 7. Round 3 additions: what is verified and what is not

Verified by automated tests: alignment/snap maths, timeline grouping, mind-map layout, HTML export builder, `$` maths guard and KaTeX rendering,
`@date` parsing and calendar grid, table parser/serialiser, attachment markdown, byte-range parsing, update version comparison, the plugin host protocol
(with a fake worker), presence/remote-change/private-files over a real local git remote, parallel loading of 1500 notes, 5000-note index/search timing,
translation placeholders, keyboard-navigation geometry.

**Not exercised in a real window** (written carefully, but please try them): microphone recording (WebKitGTK may ask for or refuse microphone access),
mermaid diagrams in the preview, the HTML export file dialog, PDF "open with the system app", audio seeking through the `bmnotes://` range responses,
the release workflow (needs a pushed tag), and the real-time behaviour of presence between two machines.

Known limits: the plugin sandbox relies on a Web Worker plus the app's CSP (no network); it is not a security boundary against a determined attacker,
which is why every plugin needs explicit approval of its exact code. Translations cover the main interface (menus, dialogs, settings, toasts) in
English and Portuguese (Brasil); text built with variable names inside sentences may still appear in English. Presence publishes one force-pushed
branch `bmnotes-presence-<login>` per person. Making an already-shared file private removes it from the repository, so the other person's copy is deleted
on their next sync. Large folders still load every note into memory; an on-disk index was not needed for the measured sizes.
