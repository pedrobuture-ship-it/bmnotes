//! Trash: deleted entries move to `.bmnotes/trash/<id>/data` with a `meta.json` describing where they came from.

use super::paths::*;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const TRASH: &str = ".bmnotes/trash";
static COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrashItem {
    pub id: String,
    pub name: String,
    pub original_path: String,
    pub is_dir: bool,
    /// Milliseconds since the Unix epoch.
    pub deleted_at: u64,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn trash_dir(root: &Path) -> Result<PathBuf, String> {
    safe_join(root, TRASH)
}

fn item_dir(root: &Path, id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("Invalid trash id".into());
    }
    Ok(trash_dir(root)?.join(id))
}

pub fn move_to_trash(root: &Path, rel: &str) -> Result<String, String> {
    let rel = rel.trim_matches('/');
    if rel.is_empty() {
        return Err("Refusing to delete the workspace root".into());
    }
    if rel == METADATA_DIR || rel.starts_with(".bmnotes/") {
        return Err("Refusing to delete workspace metadata".into());
    }
    let abs = safe_join(root, rel)?;
    let meta = abs.symlink_metadata().map_err(|e| e.to_string())?;
    let id = format!("{}-{}", now_ms(), COUNTER.fetch_add(1, Ordering::Relaxed));
    let dir = item_dir(root, &id)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let item = TrashItem {
        id: id.clone(),
        name: abs.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        original_path: rel.to_string(),
        is_dir: meta.is_dir(),
        deleted_at: now_ms(),
    };
    let json = serde_json::to_string(&item).map_err(|e| e.to_string())?;
    fs::write(dir.join("meta.json"), json).map_err(|e| e.to_string())?;
    if let Err(e) = fs::rename(&abs, dir.join("data")) {
        let _ = fs::remove_dir_all(&dir);
        return Err(format!("Could not move to the trash: {e}"));
    }
    Ok(id)
}

fn read_item(dir: &Path) -> Option<TrashItem> {
    serde_json::from_str(&fs::read_to_string(dir.join("meta.json")).ok()?).ok()
}

/// Permanently removes items older than `retention_days` (0 = keep forever).
pub fn purge_expired(root: &Path, retention_days: u32) -> Result<(), String> {
    if retention_days == 0 {
        return Ok(());
    }
    let cutoff = now_ms().saturating_sub(retention_days as u64 * 86_400_000);
    for it in list(root)? {
        if it.deleted_at < cutoff {
            delete(root, &it.id)?;
        }
    }
    Ok(())
}

pub fn list(root: &Path) -> Result<Vec<TrashItem>, String> {
    let dir = trash_dir(root)?;
    let Ok(rd) = fs::read_dir(&dir) else { return Ok(vec![]) };
    let mut items: Vec<TrashItem> = rd.filter_map(|e| e.ok()).filter_map(|e| read_item(&e.path())).collect();
    items.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
    Ok(items)
}

/// Puts the entry back where it was; if that spot is taken, restores next to it as "name (restored)".
pub fn restore(root: &Path, id: &str) -> Result<String, String> {
    let dir = item_dir(root, id)?;
    let item = read_item(&dir).ok_or("Trash item not found")?;
    let mut target = safe_join(root, &item.original_path)?;
    if target.symlink_metadata().is_ok() {
        let p = Path::new(&item.original_path);
        let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let ext = if item.is_dir { String::new() } else { p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default() };
        let parent = target.parent().map(Path::to_path_buf).unwrap_or_else(|| root.to_path_buf());
        let mut n = 0;
        loop {
            let tag = if n == 0 { " (restored)".to_string() } else { format!(" (restored {n})") };
            let cand = parent.join(format!("{stem}{tag}{ext}"));
            if cand.symlink_metadata().is_err() {
                target = cand;
                break;
            }
            n += 1;
        }
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(dir.join("data"), &target).map_err(|e| e.to_string())?;
    let _ = fs::remove_dir_all(&dir);
    to_rel(root, &target).ok_or_else(|| "Invalid path".into())
}

pub fn delete(root: &Path, id: &str) -> Result<(), String> {
    let dir = item_dir(root, id)?;
    match fs::remove_dir_all(dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

pub fn empty(root: &Path) -> Result<(), String> {
    for it in list(root)? {
        delete(root, &it.id)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (tempfile::TempDir, PathBuf) {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().canonicalize().unwrap();
        (t, root)
    }

    #[test]
    fn delete_goes_to_trash_and_restores() {
        let (_t, root) = setup();
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("sub/a.md"), "hello").unwrap();
        let id = move_to_trash(&root, "sub/a.md").unwrap();
        assert!(!root.join("sub/a.md").exists());
        let items = list(&root).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].original_path, "sub/a.md");
        assert_eq!(restore(&root, &id).unwrap(), "sub/a.md");
        assert_eq!(fs::read_to_string(root.join("sub/a.md")).unwrap(), "hello");
        assert!(list(&root).unwrap().is_empty());
    }

    #[test]
    fn restore_never_overwrites_and_recreates_folders() {
        let (_t, root) = setup();
        fs::create_dir_all(root.join("d")).unwrap();
        fs::write(root.join("d/a.md"), "old").unwrap();
        let id = move_to_trash(&root, "d").unwrap();
        fs::create_dir_all(root.join("d")).unwrap();
        fs::write(root.join("d/a.md"), "new").unwrap();
        assert_eq!(restore(&root, &id).unwrap(), "d (restored)");
        assert_eq!(fs::read_to_string(root.join("d/a.md")).unwrap(), "new");
        assert_eq!(fs::read_to_string(root.join("d (restored)/a.md")).unwrap(), "old");
    }

    #[test]
    fn guards_and_permanent_delete() {
        let (_t, root) = setup();
        fs::write(root.join("a.md"), "x").unwrap();
        assert!(move_to_trash(&root, "").is_err());
        assert!(move_to_trash(&root, ".bmnotes").is_err());
        assert!(move_to_trash(&root, "../x").is_err());
        assert!(restore(&root, "../../etc").is_err());
        let id = move_to_trash(&root, "a.md").unwrap();
        delete(&root, &id).unwrap();
        assert!(list(&root).unwrap().is_empty());
        assert!(restore(&root, &id).is_err());
    }

    #[test]
    fn purge_removes_only_expired() {
        let (_t, root) = setup();
        fs::write(root.join("old.md"), "x").unwrap();
        fs::write(root.join("new.md"), "y").unwrap();
        let old = move_to_trash(&root, "old.md").unwrap();
        move_to_trash(&root, "new.md").unwrap();
        // Age the first item by rewriting its metadata.
        let dir = item_dir(&root, &old).unwrap();
        let mut it = read_item(&dir).unwrap();
        it.deleted_at = now_ms() - 40 * 86_400_000;
        fs::write(dir.join("meta.json"), serde_json::to_string(&it).unwrap()).unwrap();
        purge_expired(&root, 0).unwrap();
        assert_eq!(list(&root).unwrap().len(), 2);
        purge_expired(&root, 30).unwrap();
        let left = list(&root).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].original_path, "new.md");
        empty(&root).unwrap();
        assert!(list(&root).unwrap().is_empty());
    }
}
