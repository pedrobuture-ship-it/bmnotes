//! Local ZIP backups of the workspace folder.

use crate::filesystem::AppState;
use serde::Serialize;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::State;
use zip::write::SimpleFileOptions;

type Res<T> = Result<T, String>;

/// Folders that never go into a backup (the trash and old backups would only bloat it).
const SKIP_DIRS: [&str; 4] = [".git", "node_modules", ".bmnotes/trash", ".bmnotes/backups"];

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BackupResult {
    pub path: String,
    pub files: u32,
    pub bytes: u64,
}

fn skipped(rel: &str) -> bool {
    SKIP_DIRS.iter().any(|s| rel == *s || rel.starts_with(&format!("{s}/")))
}

fn collect(root: &Path, dir: &Path, dest_dir: &Path, out: &mut Vec<(PathBuf, String)>) -> Res<()> {
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        let meta = entry.file_type().map_err(|e| e.to_string())?;
        if meta.is_symlink() {
            continue;
        }
        let rel = path.strip_prefix(root).map_err(|e| e.to_string())?.to_string_lossy().replace('\\', "/");
        if skipped(&rel) {
            continue;
        }
        if meta.is_dir() {
            // Never zip the folder the backups are written to.
            if path.canonicalize().map(|c| c == dest_dir).unwrap_or(false) {
                continue;
            }
            collect(root, &path, dest_dir, out)?;
        } else if meta.is_file() {
            out.push((path, rel));
        }
    }
    Ok(())
}

fn safe_stamp(stamp: &str) -> bool {
    !stamp.is_empty() && stamp.len() <= 20 && stamp.chars().all(|c| c.is_ascii_digit() || c == '-')
}

fn safe_name(name: &str) -> String {
    let s: String = name.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' }).collect();
    let s = s.trim_matches('-').to_string();
    if s.is_empty() { "notes".into() } else { s }
}

pub fn backup(root: &Path, dest: &Path, name: &str, stamp: &str, keep: u32) -> Res<BackupResult> {
    if !safe_stamp(stamp) {
        return Err("Invalid backup timestamp".into());
    }
    fs::create_dir_all(dest).map_err(|e| format!("Cannot use backup folder: {e}"))?;
    let dest_dir = dest.canonicalize().map_err(|e| e.to_string())?;
    let mut files = Vec::new();
    collect(root, root, &dest_dir, &mut files)?;
    files.sort_by(|a, b| a.1.cmp(&b.1));

    let base = safe_name(name);
    let target = dest_dir.join(format!("{base}-{stamp}.zip"));
    let part = dest_dir.join(format!("{base}-{stamp}.zip.part"));
    let result = (|| -> Res<u64> {
        let mut zw = zip::ZipWriter::new(File::create(&part).map_err(|e| e.to_string())?);
        let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let mut buf = Vec::new();
        for (path, rel) in &files {
            buf.clear();
            File::open(path).and_then(|mut f| f.read_to_end(&mut buf)).map_err(|e| format!("{rel}: {e}"))?;
            zw.start_file(rel.as_str(), opts).map_err(|e| e.to_string())?;
            zw.write_all(&buf).map_err(|e| e.to_string())?;
        }
        zw.finish().map_err(|e| e.to_string())?;
        fs::rename(&part, &target).map_err(|e| e.to_string())?;
        fs::metadata(&target).map(|m| m.len()).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&part);
    }
    let bytes = result?;
    prune(&dest_dir, &base, keep);
    Ok(BackupResult { path: target.to_string_lossy().into_owned(), files: files.len() as u32, bytes })
}

/// Keeps only the `keep` newest `<base>-*.zip` files (names sort by timestamp).
fn prune(dest: &Path, base: &str, keep: u32) {
    let prefix = format!("{base}-");
    let mut all: Vec<_> = fs::read_dir(dest)
        .map(|rd| rd.flatten().map(|e| e.path()).collect())
        .unwrap_or_default();
    all.retain(|p| {
        let n = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        n.starts_with(&prefix) && n.ends_with(".zip")
    });
    all.sort();
    while all.len() > keep.max(1) as usize {
        let _ = fs::remove_file(all.remove(0));
    }
}

/// Modification time (ms since epoch) of the newest backup of `name` in `dest`, if any.
pub fn newest(dest: &Path, name: &str) -> Option<u64> {
    let prefix = format!("{}-", safe_name(name));
    fs::read_dir(dest)
        .ok()?
        .flatten()
        .filter(|e| {
            let n = e.file_name().to_string_lossy().into_owned();
            n.starts_with(&prefix) && n.ends_with(".zip")
        })
        .filter_map(|e| e.metadata().ok()?.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .max()
}

#[tauri::command]
pub async fn backup_now(state: State<'_, AppState>, dest: String, stamp: String, keep: u32) -> Res<BackupResult> {
    let root = state.root()?;
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || backup(&root, Path::new(&dest), &name, &stamp, keep))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn backup_newest(state: State<'_, AppState>, dest: String) -> Res<Option<u64>> {
    let root = state.root()?;
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(newest(Path::new(&dest), &name))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(zip: &Path) -> Vec<String> {
        let mut a = zip::ZipArchive::new(File::open(zip).unwrap()).unwrap();
        let mut v: Vec<String> = (0..a.len()).map(|i| a.by_index(i).unwrap().name().unwrap().to_string()).collect();
        v.sort();
        v
    }

    fn tree() -> (tempfile::TempDir, PathBuf) {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().canonicalize().unwrap();
        for (p, c) in [("a.md", "A"), ("sub/b.md", "B"), (".bmnotes/board.json", "{}"), (".bmnotes/trash/x/data", "t"), (".git/HEAD", "h"), ("node_modules/m/i.js", "j")] {
            let f = root.join(p);
            fs::create_dir_all(f.parent().unwrap()).unwrap();
            fs::write(f, c).unwrap();
        }
        (t, root)
    }

    #[test]
    fn zips_notes_and_skips_heavy_folders() {
        let (_t, root) = tree();
        let out = tempfile::tempdir().unwrap();
        let r = backup(&root, out.path(), "My Notes", "20260101-1200", 5).unwrap();
        assert_eq!(names(Path::new(&r.path)), vec![".bmnotes/board.json", "a.md", "sub/b.md"]);
        assert!(r.path.ends_with("My-Notes-20260101-1200.zip"));
        assert_eq!(r.files, 3);
    }

    #[test]
    fn backup_folder_inside_the_workspace_is_not_zipped_into_itself() {
        let (_t, root) = tree();
        let inside = root.join("backups-here");
        let r = backup(&root, &inside, "n", "20260101-1200", 5).unwrap();
        assert_eq!(names(Path::new(&r.path)), vec![".bmnotes/board.json", "a.md", "sub/b.md"]);
    }

    #[test]
    fn prunes_old_backups_and_reports_newest() {
        let (_t, root) = tree();
        let out = tempfile::tempdir().unwrap();
        for s in ["20260101-1000", "20260102-1000", "20260103-1000"] {
            backup(&root, out.path(), "n", s, 2).unwrap();
        }
        let left: Vec<_> = fs::read_dir(out.path()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(left.len(), 2);
        assert!(!left.contains(&"n-20260101-1000.zip".to_string()));
        assert!(newest(out.path(), "n").is_some());
        assert!(newest(out.path(), "other").is_none());
        assert!(backup(&root, out.path(), "n", "../x", 2).is_err());
    }
}
