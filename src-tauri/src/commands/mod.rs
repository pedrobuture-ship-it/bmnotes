use crate::filesystem::{hash_content, ops, paths, trash, AppState};
use crate::watcher;
use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, State};

type Res<T> = Result<T, String>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub root: String,
    pub name: String,
}

#[tauri::command]
pub fn open_workspace(app: AppHandle, state: State<'_, AppState>, path: String) -> Res<WorkspaceInfo> {
    let root = std::path::PathBuf::from(&path)
        .canonicalize()
        .map_err(|e| format!("Cannot open folder: {e}"))?;
    if !root.is_dir() {
        return Err("Not a folder".into());
    }
    std::fs::read_dir(&root).map_err(|e| format!("Cannot read folder: {e}"))?;
    ops::migrate_metadata(&root)?;
    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.to_string_lossy().into_owned());
    *state.root.lock().map_err(|_| "state poisoned")? = Some(root.clone());
    state.self_writes.lock().map_err(|_| "state poisoned")?.clear();
    watcher::start(&app, &state, root.clone())?;
    Ok(WorkspaceInfo { root: root.to_string_lossy().into_owned(), name })
}

#[tauri::command]
pub fn close_workspace(state: State<'_, AppState>) -> Res<()> {
    *state.root.lock().map_err(|_| "state poisoned")? = None;
    *state.watcher.lock().map_err(|_| "state poisoned")? = None;
    Ok(())
}

#[tauri::command]
pub async fn scan_workspace(state: State<'_, AppState>, ignored: Vec<String>) -> Res<Vec<ops::TreeNode>> {
    let root = state.root()?;
    tauri::async_runtime::spawn_blocking(move || ops::scan(&root, &ignored)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn read_all_notes(state: State<'_, AppState>, ignored: Vec<String>) -> Res<Vec<ops::NoteFile>> {
    let root = state.root()?;
    tauri::async_runtime::spawn_blocking(move || ops::read_all(&root, &ignored)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn read_note(state: State<'_, AppState>, path: String) -> Res<ops::NoteFile> {
    let root = state.root()?;
    tauri::async_runtime::spawn_blocking(move || ops::read_note(&root, &path)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn write_note(state: State<'_, AppState>, path: String, content: String) -> Res<u64> {
    let root = state.root()?;
    let self_writes = state.self_writes.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let abs = paths::safe_join(&root, &path)?;
        self_writes.lock().map_err(|_| "state poisoned")?.insert(abs, hash_content(&content));
        ops::write_note(&root, &path, &content)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn create_note(state: State<'_, AppState>, dir: String, name: String, content: String) -> Res<String> {
    ops::create_note(&state.root()?, &dir, &name, &content)
}

#[tauri::command]
pub fn create_dir(state: State<'_, AppState>, parent: String, name: String) -> Res<String> {
    ops::create_dir(&state.root()?, &parent, &name)
}

#[tauri::command]
pub fn rename_entry(state: State<'_, AppState>, path: String, new_name: String) -> Res<String> {
    ops::rename(&state.root()?, &path, &new_name)
}

#[tauri::command]
pub fn move_entry(state: State<'_, AppState>, path: String, new_parent: String) -> Res<String> {
    ops::move_entry(&state.root()?, &path, &new_parent)
}

#[tauri::command]
pub fn delete_entry(state: State<'_, AppState>, path: String) -> Res<()> {
    trash::move_to_trash(&state.root()?, &path).map(|_| ())
}

#[tauri::command]
pub fn list_trash(state: State<'_, AppState>, retention_days: u32) -> Res<Vec<trash::TrashItem>> {
    let root = state.root()?;
    trash::purge_expired(&root, retention_days)?;
    trash::list(&root)
}

#[tauri::command]
pub fn restore_trash(state: State<'_, AppState>, id: String) -> Res<String> {
    trash::restore(&state.root()?, &id)
}

#[tauri::command]
pub fn delete_trash(state: State<'_, AppState>, id: String) -> Res<()> {
    trash::delete(&state.root()?, &id)
}

#[tauri::command]
pub fn empty_trash(state: State<'_, AppState>) -> Res<()> {
    trash::empty(&state.root()?)
}

#[tauri::command]
pub fn save_asset(state: State<'_, AppState>, assets_dir: String, file_name: String, data_base64: String) -> Res<String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|e| e.to_string())?;
    ops::save_asset(&state.root()?, &assets_dir, &file_name, &bytes)
}

/// An image of the workspace as a `data:` URI (used to embed images in exported pages). Images only, at most 5 MB.
#[tauri::command]
pub fn read_asset_data_uri(state: State<'_, AppState>, path: String) -> Res<String> {
    const MAX: u64 = 5 * 1024 * 1024;
    let abs = paths::safe_join(&state.root()?, &path)?;
    let mime = paths::image_mime(&abs).ok_or("Not an image")?;
    let len = std::fs::metadata(&abs).map_err(|e| e.to_string())?.len();
    if len > MAX {
        return Err("Image is too large to embed".into());
    }
    let bytes = std::fs::read(&abs).map_err(|e| e.to_string())?;
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

#[derive(Serialize)]
pub struct PluginFile {
    pub name: String,
    pub code: String,
}

const PLUGIN_DIR: &str = ".bmnotes/plugins";

/// The `.js` files of `.bmnotes/plugins/` (at most 30, 200 KB each, no symlinks). Running them is up to the frontend sandbox.
#[tauri::command]
pub fn list_plugins(state: State<'_, AppState>) -> Res<Vec<PluginFile>> {
    let dir = paths::safe_join(&state.root()?, PLUGIN_DIR)?;
    let Ok(rd) = std::fs::read_dir(&dir) else { return Ok(vec![]) };
    let mut out = Vec::new();
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Ok(ft) = e.file_type() else { continue };
        if !ft.is_file() || ft.is_symlink() || !name.ends_with(".js") || name.len() > 80 {
            continue;
        }
        let Ok(meta) = e.metadata() else { continue };
        if meta.len() > 200 * 1024 {
            continue;
        }
        if let Ok(code) = std::fs::read_to_string(e.path()) {
            out.push(PluginFile { name, code });
        }
        if out.len() >= 30 {
            break;
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Creates `.bmnotes/plugins/` (so it can be opened in a file manager) and returns its workspace-relative path.
#[tauri::command]
pub fn ensure_plugins_dir(state: State<'_, AppState>) -> Res<String> {
    let dir = paths::safe_join(&state.root()?, PLUGIN_DIR)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(PLUGIN_DIR.to_string())
}

/// Opens a PDF, audio file or image of the workspace with the system's default app. Nothing executable is ever opened.
#[tauri::command]
pub fn open_attachment(app: AppHandle, state: State<'_, AppState>, path: String) -> Res<()> {
    use tauri_plugin_opener::OpenerExt;
    let abs = paths::safe_join(&state.root()?, &path)?;
    if paths::attachment_mime(&abs).is_none() || !abs.is_file() {
        return Err("Only images, PDFs and audio files can be opened".into());
    }
    app.opener().open_path(abs.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

/// Writes an exported `.html` page to a location the user picked in the save dialog.
#[tauri::command]
pub fn write_export(dest: String, content: String) -> Res<()> {
    let p = std::path::Path::new(&dest);
    if !p.is_absolute() || !p.extension().is_some_and(|e| e.eq_ignore_ascii_case("html")) {
        return Err("Exports must be saved as an .html file".into());
    }
    if content.len() > 64 * 1024 * 1024 {
        return Err("The export is too large".into());
    }
    ops::atomic_write(p, content.as_bytes())
}

#[tauri::command]
pub fn absolute_path(state: State<'_, AppState>, path: String) -> Res<String> {
    let root = state.root()?;
    let abs = if path.is_empty() { root } else { paths::safe_join(&root, &path)? };
    Ok(abs.to_string_lossy().into_owned())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetaRead {
    pub content: Option<String>,
    /// Latest valid backup, only offered for board.json.
    pub backup: Option<String>,
}

#[tauri::command]
pub fn read_meta(state: State<'_, AppState>, file: String) -> Res<MetaRead> {
    let root = state.root()?;
    let content = ops::read_meta(&root, &file)?;
    let backup = if file == "board.json" { ops::latest_board_backup(&root) } else { None };
    Ok(MetaRead { content, backup })
}

#[tauri::command]
pub fn delete_meta(state: State<'_, AppState>, file: String) -> Res<()> {
    ops::delete_meta(&state.root()?, &file)
}

#[tauri::command]
pub async fn write_meta(state: State<'_, AppState>, file: String, content: String) -> Res<()> {
    let root = state.root()?;
    tauri::async_runtime::spawn_blocking(move || ops::write_meta(&root, &file, &content)).await.map_err(|e| e.to_string())?
}

/// Folder passed on the command line (`bmnotes /path/to/notes`), if any.
#[tauri::command]
pub fn launch_path() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|a| !a.starts_with('-') && std::path::Path::new(a).is_dir())
}
