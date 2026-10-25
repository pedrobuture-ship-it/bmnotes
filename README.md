# bmnotes

**A local-first spatial Markdown workspace.**

> Your notes are just files.

Pick a folder of `.md` files and bmnotes spreads them out as cards on an infinite, hand-drawn wall.
Everything is plain Markdown on your disk. It works offline, and goes online only when you ask it to:
sync with GitHub to share a folder, or check for updates.

![The mural](docs/screenshots/mural.png)

## Highlights

### The mural
- **Infinite canvas**: pan, zoom, minimap, multi-select, resizable cards, dashed frames, light and dark (parchment) themes.
- **Linking by dragging**: every card has a dot on each side. Drag from one card to another and the `[[link]]` is written into the source note for you. Select an arrow and press **Delete** to remove it, and its `[[link]]` disappears from the `.md` too.
- **Wiki links** (`[[note]]`, `[[folder/note|alias]]`, `[[note#Section]]`) become hand-drawn arrows, with optional labels.
- **Several murals per folder**: "Main" shows every note; extra murals hold only the notes you add. Right-click a card → *Move to / Add to another mural…* and pick it from a searchable list (works on every selected card, and keeps size and color). Delete on an extra mural only removes the card, never the file.
- **Layout help**: magnetic alignment guides, align/distribute buttons, task progress on cards (`☑ 3/5`), full keyboard navigation (arrows, Enter, Shift+arrows).
- **Other views**: a **Graph** of every note and link, a **Timeline**, a **mind map** of a note's headings, and export of a mural as a standalone **HTML page**.

### Writing
- **Plain Markdown** is the single source of truth: edit the same files in VS Code or Obsidian at the same time.
- Templates (`templates/` folder + built-ins), `![[embeds]]`, autocomplete after `[[` and `#`, unlinked mentions, backlinks, tags (`#idea`), daily notes.
- Interactive checkboxes that edit the real file, a global **Tasks** view, `@2026-11-01` dates with a **Calendar** and due reminders.
- `mermaid` diagrams, `$LaTeX$` maths, a grid **table editor** (Ctrl+Alt+T).
- Paste or drop images, PDFs and audio: they are copied to `assets/` and linked as normal Markdown. You can also **record audio** straight into a note.
- **Focus mode** (Ctrl+Shift+F) hides everything but what you are working on; Esc leaves it.

### Finding things
- Search across names, titles, tags and content (Ctrl+P), with filters (`tag:`, `path:`, `title:`, any frontmatter property like `status:done`) and **saved searches**.
- Command palette (Ctrl+K), back/forward (`Alt+←/→`), pinned and recent notes, a Properties table.

### Safety
- **Smart rename**: renaming or moving a note updates `[[links]]` and `[text](note.md)` links in every other note.
- **Trash**: deleting moves notes to `.bmnotes/trash/`; restore them from the sidebar. Retention is configurable (default 30 days).
- Local **ZIP backups** (optional daily), a **notes-health** check (broken links, orphans), **password-encrypted notes** (AES-GCM).
- If one view breaks, it shows the error with *Try again* / *Back to the mural* instead of blanking the window.

### Working together (optional)
- **GitHub sync** to share a folder with a friend, see below.
- "Who is on this note right now", a warning when the remote changed the note you opened, and files you keep private on your computer.

### And
- English and **Português (Brasil)**, rebindable shortcuts, optional **update check**, simple sandboxed **plugins**.

| Note page | Graph | Card menu |
|---|---|---|
| ![](docs/screenshots/note.png) | ![](docs/screenshots/graph.png) | ![](docs/screenshots/card-menu.png) |

## Online only when you want

bmnotes needs no account and no server. With nothing turned on, it makes **no network calls**: no telemetry,
no analytics, strict CSP, and every library (mermaid, KaTeX, fonts) ships inside the app.

The app goes online only for things you switch on yourself:

| Feature | Talks to | When |
|---|---|---|
| GitHub sync | `github.com` (via `git`) | After you connect an account and pick a repository |
| Presence ("who is on this note") | your sync repository | Only while sync is on, and it can be turned off |
| Update check | GitHub releases API | When you click *Check now*, or daily if you opt in |

Turn sync off (Settings → Sync → Unlink) and the app is fully offline again. Nothing is deleted.

On Windows, all background Git commands run without creating console windows, including status checks, sync and presence.

## Your data

```
MyVault/
  ideas.md
  projects/app.md
  assets/            <- pasted / dropped images, PDFs, audio
  daily/2026-10-13.md
  .bmnotes/            <- the ONLY app-specific data
    board.json       <- Main mural: card positions, sizes, colors, frames, viewport
    boards.json      <- list of extra murals
    boards/<id>.json <- each extra mural
    settings.json    <- workspace preferences (never synced)
    trash/           <- deleted notes, until restored or expired (never synced)
    backups/         <- snapshots and ZIP backups (never synced)
    plugins/         <- your plugins (never synced)
```

- Visual information is **never** written into your Markdown.
- `.bmnotes/` is created lazily, only when there is something to save.
- Deleting `.bmnotes/` loses layout only; your notes are untouched.
- If `board.json` is corrupted, the app keeps the broken file as `board.corrupt.json`, restores the newest valid
  backup (or lays the board out again) and never touches a `.md`.

## Privacy & safety

- Every filesystem command validates paths against the opened workspace (no `..`, no absolute paths, no
  symlink escapes), writes are atomic (temp file + rename), and deleting always asks first.
- External edits are picked up live by the watcher. If a note has unsaved local edits when the file changes on
  disk, you get a banner to keep yours or load the disk version.
- Encrypted notes use AES-GCM with a PBKDF2 key (600k iterations). The password stays in memory only; a lost password cannot be recovered.

## Sync with GitHub (optional)

To share a folder with a friend:

1. **Settings → Sync → Connect to GitHub.** Your browser opens GitHub; paste the short code shown in the app. The token is kept in the app's config folder (permissions `0600`), never inside your notes.
2. **Pick a repository:** create a new one (private by default), choose an existing one, or paste `owner/name`. Your friend does the same with the same repository (they need write access).
3. From then on the app commits your changes ~15 s after you stop typing, checks for new changes every 45 s, and pushes. The cloud icon in the header shows the state; click it to sync now.

How conflicts are handled:

- Different notes, or different lines of the same note, merge automatically (it is plain `git`).
- If you both changed the same lines, the note shows up under **Settings → Sync → Changed on both sides**: *Keep mine*, *Keep theirs*, or *Keep both* (the other version is saved as `note (from other).md`). Nothing is lost.
- Murals (`board.json`, `boards/`) merge per card, so moving different cards never conflicts; the viewport is local.
- Settings, trash, backups and plugins are never uploaded (added to `.gitignore`).
- **Private files**: mark a note as private and it stays only on your computer. Making an already-shared file private removes it from your friend's copy on the next sync, so the app asks first.

Requirements: `git` installed. Large files (> 10 MB) trigger a warning because they make the repository heavy.

## Plugins

A plugin is a `.js` file in `.bmnotes/plugins/` (never synced). It runs in an isolated Web Worker: no network, no DOM, no access to your files except the small `bmnotes` API (`bmnotes.command`, `bmnotes.notes.list/read/write/create`, `bmnotes.toast`, `bmnotes.openNote`, `bmnotes.prompt`). Every file must be approved in **Settings → Plugins** after you read its code, and editing it asks again. A command that runs longer than 10 s is stopped. This is a sandbox, not a hard security boundary: only approve code you trust.

## Releases

Push a tag such as `v0.2.0` and the **Release** workflow (`.github/workflows/release.yml`) builds `.AppImage`, `.deb`, `.rpm`, `.msi`/`.exe` and `.dmg` and attaches them to a draft GitHub release. `CI` runs type-check, lint and all tests on every push. The builds are not code-signed yet, so Windows and macOS ask for confirmation on first launch.

## Upgrading to bmnotes

The app, executable, package, asset protocol (`bmnotes://`) and metadata directory
(`.bmnotes/`) now use the same name. On opening an existing workspace, bmnotes moves
its legacy `.mural/` directory to `.bmnotes/`, including settings, boards, backups,
plugins and trash. It never overwrites an existing `.bmnotes/`; if both directories
exist, both are preserved and `.bmnotes/` is used. Markdown files are unchanged.

The application identifier is now `app.bmnotes`. Select your notes folder once in
the renamed desktop app; browser storage belongs to the new application identity.
An existing GitHub sign-in is moved from the previous configuration directory when
needed. Previously encrypted notes and the old plugin `bm` API remain supported;
new notes and plugins use `bmnotes`.

The watcher ignores file reads and its own atomic saves. Markdown conversion and
graph layout run in background workers; graph rendering is limited to the viewport.

## Install / run from source

There are no published binaries yet: you build the app yourself (about 3-5 minutes the first time).
Everything below needs **Node 20+**, **Rust (stable)** and the system WebView libraries for your OS.
The app, binary, package and repository are called `bmnotes`.

```bash
git clone https://github.com/pedrobuture-ship-it/bmnotes.git
cd bmnotes
npm install
npm run tauri dev      # run the app
npm run tauri build    # build installers / binary for your OS
```

### Arch Linux (and Omarchy, Manjaro, EndeavourOS)

```bash
sudo pacman -S --needed webkit2gtk-4.1 gtk3 librsvg libayatana-appindicator base-devel openssl nodejs npm rustup
rustup default stable
```

Result: `src-tauri/target/release/bmnotes` (run it directly, optionally `bmnotes ~/Notes`), plus
`.deb`, `.rpm` and an AppImage in `src-tauri/target/release/bundle/`. On Arch the plain binary is the most
reliable option because it uses your system WebKit.

### Debian, Ubuntu, Linux Mint, Pop!_OS

```bash
sudo apt update
sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev nodejs npm
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # then restart the shell
```

Needs Ubuntu 22.04+ / Debian 12+ (WebKitGTK 4.1). Install the generated package with
`sudo apt install ./src-tauri/target/release/bundle/deb/bmnotes_0.1.0_amd64.deb`.

### Windows 10/11

1. Install [Node.js LTS](https://nodejs.org), [Rust](https://rustup.rs) (choose the MSVC toolchain) and
   **Visual Studio Build Tools** with the *Desktop development with C++* workload.
2. WebView2 ships with Windows 10/11 (otherwise get the Evergreen runtime from Microsoft).
3. In PowerShell:

```powershell
git clone https://github.com/pedrobuture-ship-it/bmnotes.git
cd bmnotes
npm install
npm run tauri build
```

Installers (`.msi` and `-setup.exe`) land in `src-tauri\target\release\bundle\`.
The Windows build has not been tested by the author yet; please open an issue if something breaks.

### macOS

`xcode-select --install`, install Node and Rust, then the same `npm install && npm run tauri build`
(produces a `.dmg`/`.app`). Also untested so far.

## Development

Requirements: Node 20+, Rust stable (this repo pins it in `mise.toml`).

```bash
npm install
npm run tauri dev            # run the desktop app with hot reload
npm run tauri dev -- -- /path/to/folder   # open a folder directly (or: bmnotes /path/to/folder)
npm run check                # typecheck + lint + frontend tests
(cd src-tauri && cargo test) # Rust tests (paths, symlinks, atomic writes, trash, backups, sync)
```

## Build

```bash
npm run tauri build                 # installers for the current OS (deb/rpm/AppImage on Linux, msi/nsis on Windows, dmg on macOS)
npm run tauri build -- --no-bundle  # just the optimized binary
```

Cross-platform builds must be run on each target OS (or in CI).

## Stack

React 19 · TypeScript (strict) · Vite · Tailwind CSS v4 · Zustand · XYFlow / React Flow (canvas) · CodeMirror 6 (editor) ·
unified/remark/rehype + highlight.js, KaTeX, mermaid (preview) · Tauri 2 · Rust (`notify` watcher, `git` CLI for sync, `zip` for backups).

## Architecture

```
src/
  app/          App shell
  components/   Menu, dialogs, error boundary, doodles (SVG), VirtualList
  features/
    board/      canvas, mural tabs, note/frame nodes, sketch edges
    editor/     CodeMirror editor, Markdown preview, note page
    sidebar/    notes, tags, file tree (virtualized), explore
    graph/      graph explorer
    timeline/   timeline view
    search/     global search + command palette
    settings/   settings, sync, backups, updates, plugins, shortcuts
    shell/      header and background hooks (auto sync, backup, presence, reminders)
    ...         trash, tasks, templates, calendar, tables, audio, mind map, health, properties
  lib/          pure logic (links, rename, tags, tasks, search, markdown, crypto, i18n, plugins) + tests
  stores/       zustand: workspace, board, settings, ui, sync, locks, plugins
  styles/       design system (tokens, paper-card, sketch-border, board-frame, sticky-note…)
src-tauri/src/
  filesystem/   safe paths, operations, trash (+ tests)
  commands/     the IPC surface
  watcher/      debounced notify watcher, ignores our own saves by content hash
  github/       browser login (device flow), token file
  sync/         git sync, board merge, presence, private files (+ tests)
  backup.rs     ZIP backups
  update.rs     update check
```

Performance notes: notes are read in parallel at startup; the note index (titles, tags, links, backlinks) is built once and updated incrementally per
edited note; Markdown rendering is cached; the canvas only renders cards in view and switches to a labelled
low-detail card when zoomed far out; long lists are windowed. Tested with 5,000 notes.

## Keyboard shortcuts

Press **Ctrl + /** in the app for the full list. App shortcuts can be changed in Settings.

| Shortcut | Action |
|---|---|
| Ctrl + K | Command palette |
| Ctrl + P | Search notes |
| Ctrl + N | New note |
| Ctrl + Shift + N | New note from template |
| Ctrl + Shift + D | Daily note |
| Ctrl + E | Toggle edit / preview |
| Ctrl + B | Toggle sidebar |
| Ctrl + Shift + F | Focus mode |
| Alt + ← / → | Back / forward |
| Ctrl + Alt + T | Edit table as a grid |
| Ctrl + 0 / + / - | Fit board / zoom in / zoom out |
| Space + drag | Pan |
| Delete | Delete the selected card (asks first) or arrow (also removes its `[[link]]`) |
| Esc | Close / leave editing / leave focus mode |

## Roadmap

- Signed releases and auto-install updates (opt-in)

## License

MIT
