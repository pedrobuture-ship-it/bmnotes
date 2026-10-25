//! Filesystem operations, all relative to an already validated workspace root.

use super::paths::*;
use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::time::UNIX_EPOCH;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Vec<TreeNode>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NoteFile {
    pub path: String,
    pub content: String,
    pub mtime: u64,
    /// Creation time when the filesystem records it, otherwise the modification time.
    pub created: u64,
}

fn created_ms(p: &Path) -> u64 {
    fs::metadata(p)
        .and_then(|m| m.created())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or_else(|| mtime_ms(p))
}

fn mtime_ms(p: &Path) -> u64 {
    fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn scan(root: &Path, ignored: &[String]) -> Result<Vec<TreeNode>, String> {
    fn walk(root: &Path, dir: &Path, ignored: &[String], depth: usize) -> Result<Vec<TreeNode>, String> {
        if depth > 32 {
            return Ok(vec![]);
        }
        let mut nodes = Vec::new();
        let entries = fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if is_ignored(&name, ignored) {
                continue;
            }
            // Never follow symlinks: they could point outside the workspace.
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_symlink() {
                continue;
            }
            let path = entry.path();
            let Some(rel) = to_rel(root, &path) else { continue };
            if ft.is_dir() {
                // Hidden folders (e.g. .obsidian) are skipped.
                if name.starts_with('.') {
                    continue;
                }
                let children = walk(root, &path, ignored, depth + 1).unwrap_or_default();
                nodes.push(TreeNode { name, path: rel, is_dir: true, children });
            } else if ft.is_file() && is_markdown(&path) {
                nodes.push(TreeNode { name, path: rel, is_dir: false, children: vec![] });
            }
        }
        nodes.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(nodes)
    }
    walk(root, root, ignored, 0)
}

/// Notes larger than this are left out of the bulk load (they would freeze the editor anyway).
const MAX_NOTE_BYTES: u64 = 5 * 1024 * 1024;

fn read_one(root: &Path, rel: &str) -> Option<NoteFile> {
    let abs = root.join(rel);
    if fs::metadata(&abs).map(|m| m.len() > MAX_NOTE_BYTES).unwrap_or(true) {
        return None;
    }
    // Unreadable / non-UTF8 files are skipped rather than failing the whole load.
    let content = fs::read_to_string(&abs).ok()?;
    Some(NoteFile { mtime: mtime_ms(&abs), created: created_ms(&abs), path: rel.to_string(), content })
}

pub fn read_all(root: &Path, ignored: &[String]) -> Result<Vec<NoteFile>, String> {
    fn collect(nodes: &[TreeNode], out: &mut Vec<String>) {
        for n in nodes {
            if n.is_dir {
                collect(&n.children, out)
            } else {
                out.push(n.path.clone())
            }
        }
    }
    let tree = scan(root, ignored)?;
    let mut paths = Vec::new();
    collect(&tree, &mut paths);
    // Reading thousands of files is I/O bound: spread it over a few threads, keeping the scan order.
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2).clamp(1, 8);
    let chunk = paths.len().div_ceil(threads).max(1);
    let mut out = Vec::with_capacity(paths.len());
    std::thread::scope(|s| {
        let handles: Vec<_> = paths
            .chunks(chunk)
            .map(|part| s.spawn(move || part.iter().filter_map(|rel| read_one(root, rel)).collect::<Vec<_>>()))
            .collect();
        for h in handles {
            if let Ok(mut v) = h.join() {
                out.append(&mut v);
            }
        }
    });
    Ok(out)
}

pub fn read_note(root: &Path, rel: &str) -> Result<NoteFile, String> {
    let abs = safe_join(root, rel)?;
    let content = fs::read_to_string(&abs).map_err(|e| format!("{rel}: {e}"))?;
    Ok(NoteFile { path: rel.to_string(), mtime: mtime_ms(&abs), created: created_ms(&abs), content })
}

/// Atomic write: temp file in the same dir, fsync, rename over the target.
pub fn atomic_write(abs: &Path, content: &[u8]) -> Result<(), String> {
    let dir = abs.parent().ok_or("Invalid path")?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!(
        ".{}.bmnotes-tmp",
        abs.file_name().and_then(|n| n.to_str()).unwrap_or("file")
    ));
    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(content).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, abs).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

pub fn write_note(root: &Path, rel: &str, content: &str) -> Result<u64, String> {
    if !is_markdown(Path::new(rel)) {
        return Err("Only Markdown files can be written".into());
    }
    let abs = safe_join(root, rel)?;
    atomic_write(&abs, content.as_bytes())?;
    Ok(mtime_ms(&abs))
}

pub fn create_note(root: &Path, dir_rel: &str, stem: &str, content: &str) -> Result<String, String> {
    let stem = validate_name(stem.trim_end_matches(".md"))?;
    let dir = safe_join(root, dir_rel)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = unique_name(&dir, &stem, "md");
    let abs = dir.join(&file);
    fs::write(&abs, content).map_err(|e| e.to_string())?;
    to_rel(root, &abs).ok_or_else(|| "Invalid path".into())
}

pub fn create_dir(root: &Path, parent_rel: &str, name: &str) -> Result<String, String> {
    let name = validate_name(name)?;
    let parent = safe_join(root, parent_rel)?;
    let unique = unique_name(&parent, &name, "");
    let abs = parent.join(unique);
    fs::create_dir_all(&abs).map_err(|e| e.to_string())?;
    to_rel(root, &abs).ok_or_else(|| "Invalid path".into())
}

pub fn rename(root: &Path, rel: &str, new_name: &str) -> Result<String, String> {
    let abs = safe_join(root, rel)?;
    if !abs.exists() {
        return Err("Source does not exist".into());
    }
    let mut new_name = validate_name(new_name)?;
    if abs.is_file() && is_markdown(&abs) && !is_markdown(Path::new(&new_name)) {
        new_name.push_str(".md");
    }
    let parent = abs.parent().ok_or("Invalid path")?;
    let target = parent.join(&new_name);
    if target == abs {
        return to_rel(root, &abs).ok_or_else(|| "Invalid path".into());
    }
    if target.exists() {
        return Err(format!("\"{new_name}\" already exists"));
    }
    fs::rename(&abs, &target).map_err(|e| e.to_string())?;
    to_rel(root, &target).ok_or_else(|| "Invalid path".into())
}

pub fn move_entry(root: &Path, rel: &str, new_parent_rel: &str) -> Result<String, String> {
    let abs = safe_join(root, rel)?;
    let parent = safe_join(root, new_parent_rel)?;
    if !abs.exists() {
        return Err("Source does not exist".into());
    }
    if !parent.is_dir() {
        return Err("Destination is not a folder".into());
    }
    if parent.starts_with(&abs) {
        return Err("Cannot move a folder into itself".into());
    }
    let name = abs.file_name().ok_or("Invalid path")?;
    let target = parent.join(name);
    if target == abs {
        return to_rel(root, &abs).ok_or_else(|| "Invalid path".into());
    }
    if target.exists() {
        return Err("Destination already contains an entry with that name".into());
    }
    fs::rename(&abs, &target).map_err(|e| e.to_string())?;
    to_rel(root, &target).ok_or_else(|| "Invalid path".into())
}

/// Saves a pasted/dropped image into the assets folder with a safe unique name.
pub fn save_asset(root: &Path, assets_dir: &str, file_name: &str, bytes: &[u8]) -> Result<String, String> {
    let ext = Path::new(file_name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    const MAX_ATTACHMENT: usize = 25 * 1024 * 1024;
    if !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif" | "pdf" | "mp3" | "wav" | "ogg" | "oga" | "opus" | "m4a" | "aac" | "webm" | "flac") {
        return Err("Unsupported file type".into());
    }
    if bytes.len() > MAX_ATTACHMENT {
        return Err("File is too large (25 MB maximum)".into());
    }
    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("image");
    let safe_stem: String = stem
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    let safe_stem = if safe_stem.is_empty() { "image".to_string() } else { safe_stem };
    let dir = safe_join(root, assets_dir)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = unique_name(&dir, &safe_stem, &ext);
    let abs = dir.join(&name);
    fs::write(&abs, bytes).map_err(|e| e.to_string())?;
    to_rel(root, &abs).ok_or_else(|| "Invalid path".into())
}

/// Move the legacy workspace metadata once, without overwriting an existing new directory.
pub fn migrate_metadata(root: &Path) -> Result<(), String> {
    let legacy = safe_join(root, ".mural")?;
    let current = safe_join(root, METADATA_DIR)?;
    if !current.exists() && legacy.is_dir() {
        fs::rename(&legacy, &current).map_err(|e| format!("Cannot migrate workspace metadata: {e}"))?;
    }
    Ok(())
}

// ----- .bmnotes metadata -----------------------------------------------------

const MAX_BACKUPS: usize = 8;

const META_FILES: [&str; 4] = ["board.json", "settings.json", "board.corrupt.json", "boards.json"];

/// `boards/<id>.json` with a simple lowercase id, for the extra murals of a workspace.
fn is_board_file(file: &str) -> bool {
    let Some(id) = file.strip_prefix("boards/").and_then(|f| f.strip_suffix(".json")) else { return false };
    !id.is_empty() && id.len() <= 40 && id.chars().next().is_some_and(|c| c.is_ascii_alphanumeric()) && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// `.bmnotes/<file>` for a whitelisted metadata file; `.bmnotes` itself may not be a symlink out of the workspace.
fn meta_path(root: &Path, file: &str) -> Result<std::path::PathBuf, String> {
    if !META_FILES.contains(&file) && !is_board_file(file) {
        return Err("Unknown metadata file".into());
    }
    safe_join(root, &format!("{METADATA_DIR}/{file}"))
}

pub fn read_meta(root: &Path, file: &str) -> Result<Option<String>, String> {
    let abs = meta_path(root, file)?;
    match fs::read_to_string(&abs) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Deletes an extra mural's file (`boards/<id>.json`). The main board and settings can't be deleted this way.
pub fn delete_meta(root: &Path, file: &str) -> Result<(), String> {
    if !is_board_file(file) {
        return Err("Only extra murals can be deleted".into());
    }
    match fs::remove_file(meta_path(root, file)?) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Writes metadata, snapshotting the previous version first (board.json only).
pub fn write_meta(root: &Path, file: &str, content: &str) -> Result<(), String> {
    let target = meta_path(root, file)?;
    let dir = target.parent().ok_or("Invalid path")?.to_path_buf();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    if file == "board.json" && target.exists() {
        snapshot(&dir, &target)?;
    }
    atomic_write(&target, content.as_bytes())
}

fn snapshot(dir: &Path, target: &Path) -> Result<(), String> {
    let backups = dir.join("backups");
    fs::create_dir_all(&backups).map_err(|e| e.to_string())?;
    // At most one snapshot per 30 seconds so autosaves don't flush the history.
    let mut existing: Vec<_> = fs::read_dir(&backups)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("board-"))
        .collect();
    existing.sort_by_key(|e| e.file_name());
    let now = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Some(last) = existing.last() {
        let n = last.file_name().to_string_lossy().into_owned();
        let ts: u64 = n.trim_start_matches("board-").trim_end_matches(".json").parse().unwrap_or(0);
        if now.saturating_sub(ts) < 30 {
            return Ok(());
        }
    }
    // Don't snapshot a file that is already corrupt-looking/empty.
    let current = fs::read_to_string(target).unwrap_or_default();
    if serde_json::from_str::<serde_json::Value>(&current).is_err() {
        return Ok(());
    }
    fs::write(backups.join(format!("board-{now}.json")), current).map_err(|e| e.to_string())?;
    let mut all: Vec<_> = fs::read_dir(&backups)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.path())
        .collect();
    all.sort();
    while all.len() > MAX_BACKUPS {
        let old = all.remove(0);
        let _ = fs::remove_file(old);
    }
    Ok(())
}

/// Latest valid backup of board.json, used for recovery.
pub fn latest_board_backup(root: &Path) -> Option<String> {
    let backups = root.join(METADATA_DIR).join("backups");
    let mut files: Vec<_> = fs::read_dir(backups).ok()?.flatten().map(|e| e.path()).collect();
    files.sort();
    files
        .into_iter()
        .rev()
        .filter_map(|p| fs::read_to_string(p).ok())
        .find(|s| serde_json::from_str::<serde_json::Value>(s).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (tempfile::TempDir, std::path::PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        (tmp, root)
    }

    #[test]
    fn create_read_rename_delete_roundtrip() {
        let (_t, root) = setup();
        let rel = create_note(&root, "", "Minha ideia", "# oi").unwrap();
        assert_eq!(rel, "Minha ideia.md");
        let again = create_note(&root, "", "Minha ideia", "x").unwrap();
        assert_eq!(again, "Minha ideia-2.md");
        assert_eq!(read_note(&root, &rel).unwrap().content, "# oi");
        let renamed = rename(&root, &rel, "nova").unwrap();
        assert_eq!(renamed, "nova.md");
        crate::filesystem::trash::move_to_trash(&root, &renamed).unwrap();
        assert!(read_note(&root, &renamed).is_err());
    }

    #[test]
    fn operations_cannot_escape_root() {
        let (_t, root) = setup();
        assert!(write_note(&root, "../evil.md", "x").is_err());
        assert!(crate::filesystem::trash::move_to_trash(&root, "../x").is_err());
        assert!(crate::filesystem::trash::move_to_trash(&root, "").is_err());
        assert!(rename(&root, "a.md", "../b.md").is_err());
    }

    #[test]
    fn bulk_load_reads_many_notes_in_scan_order_and_skips_huge_ones() {
        let (_t, root) = setup();
        for i in 0..1500 {
            fs::create_dir_all(root.join(format!("d{}", i % 7))).unwrap();
            fs::write(root.join(format!("d{}/n{i:04}.md", i % 7)), format!("# Note {i}\n")).unwrap();
        }
        fs::write(root.join("huge.md"), vec![b'a'; (MAX_NOTE_BYTES + 1) as usize]).unwrap();
        fs::write(root.join("bad.md"), [0xff, 0xfe, 0x00]).unwrap();
        let all = read_all(&root, &[]).unwrap();
        assert_eq!(all.len(), 1500);
        assert!(all.iter().all(|n| n.content.starts_with("# Note ")));
        let tree_order: Vec<_> = {
            let mut v = Vec::new();
            fn walk(nodes: &[TreeNode], v: &mut Vec<String>) {
                for n in nodes {
                    if n.is_dir { walk(&n.children, v) } else { v.push(n.path.clone()) }
                }
            }
            walk(&scan(&root, &[]).unwrap(), &mut v);
            v.into_iter().filter(|p| p != "huge.md" && p != "bad.md").collect()
        };
        assert_eq!(all.iter().map(|n| n.path.clone()).collect::<Vec<_>>(), tree_order);
    }

    #[test]
    fn move_into_self_is_rejected() {
        let (_t, root) = setup();
        create_dir(&root, "", "a").unwrap();
        create_dir(&root, "a", "b").unwrap();
        assert!(move_entry(&root, "a", "a/b").is_err());
    }

    #[test]
    fn scan_skips_ignored_and_non_markdown() {
        let (_t, root) = setup();
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::write(root.join("node_modules/x.md"), "").unwrap();
        fs::write(root.join("a.md"), "").unwrap();
        fs::write(root.join("b.txt"), "").unwrap();
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("sub/c.md"), "").unwrap();
        let tree = scan(&root, &[]).unwrap();
        let names: Vec<_> = tree.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names, vec!["sub", "a.md"]);
    }

    #[test]
    fn board_backup_and_recovery() {
        let (_t, root) = setup();
        write_meta(&root, "board.json", "{\"v\":1}").unwrap();
        write_meta(&root, "board.json", "{\"v\":2}").unwrap();
        assert_eq!(latest_board_backup(&root).unwrap(), "{\"v\":1}");
        assert!(write_meta(&root, "../evil.json", "x").is_err());
        assert!(read_meta(&root, "../../etc/passwd").is_err());
    }

    #[test]
    fn extra_boards_are_whitelisted_and_deletable() {
        let (_t, root) = setup();
        write_meta(&root, "boards/study-2.json", "{}").unwrap();
        write_meta(&root, "boards.json", "{}").unwrap();
        assert_eq!(read_meta(&root, "boards/study-2.json").unwrap().as_deref(), Some("{}"));
        for bad in ["boards/../x.json", "boards/A.json", "boards/-x.json", "boards/a/b.json", "boards/.json", "boards/x.md"] {
            assert!(write_meta(&root, bad, "{}").is_err(), "{bad}");
        }
        delete_meta(&root, "boards/study-2.json").unwrap();
        assert!(read_meta(&root, "boards/study-2.json").unwrap().is_none());
        assert!(delete_meta(&root, "board.json").is_err());
        assert!(delete_meta(&root, "boards.json").is_err());
    }

    #[test]
    fn assets_get_safe_unique_names() {
        let (_t, root) = setup();
        let a = save_asset(&root, "assets", "My Shot!.PNG", b"1").unwrap();
        let b = save_asset(&root, "assets", "My Shot!.PNG", b"2").unwrap();
        assert_eq!(a, "assets/My-Shot.png");
        assert_eq!(b, "assets/My-Shot-2.png");
        assert!(save_asset(&root, "assets", "x.exe", b"1").is_err());
        assert_eq!(save_asset(&root, "assets", "Voice memo.WEBM", b"1").unwrap(), "assets/Voice-memo.webm");
        assert_eq!(save_asset(&root, "assets", "doc.pdf", b"%PDF").unwrap(), "assets/doc.pdf");
        assert!(save_asset(&root, "../out", "x.png", b"1").is_err());
    }
    #[test]
    fn migrates_legacy_metadata_without_losing_layout_settings_or_trash() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join(".mural/trash/item")).unwrap();
        fs::write(root.join(".mural/board.json"), "layout").unwrap();
        fs::write(root.join(".mural/settings.json"), "settings").unwrap();
        fs::write(root.join(".mural/trash/item/data"), "deleted note").unwrap();
        migrate_metadata(root).unwrap();
        assert!(!root.join(".mural").exists());
        assert_eq!(fs::read_to_string(root.join(".bmnotes/board.json")).unwrap(), "layout");
        assert_eq!(fs::read_to_string(root.join(".bmnotes/settings.json")).unwrap(), "settings");
        assert_eq!(fs::read_to_string(root.join(".bmnotes/trash/item/data")).unwrap(), "deleted note");
        // An existing new-format directory always wins; never overwrite either copy.
        fs::create_dir_all(root.join(".mural")).unwrap();
        fs::write(root.join(".mural/board.json"), "older copy").unwrap();
        migrate_metadata(root).unwrap();
        assert_eq!(fs::read_to_string(root.join(".bmnotes/board.json")).unwrap(), "layout");
        assert_eq!(fs::read_to_string(root.join(".mural/board.json")).unwrap(), "older copy");
    }

}
