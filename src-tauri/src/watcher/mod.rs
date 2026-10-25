//! Debounced content/structure notifications. Access events never enter the queue.
use crate::filesystem::{hash_content, paths, AppState};
use notify::{Event, EventKind, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct FsChange {
    changed: Vec<String>,
    removed: Vec<String>,
    structure: bool,
}

fn relevant(event: &Event) -> bool {
    // In particular, reading a note to hash it produces Access(Open) on Linux.
    // Processing that event would make the watcher continuously trigger itself.
    matches!(event.kind, EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(notify::event::ModifyKind::Data(_) | notify::event::ModifyKind::Name(_) | notify::event::ModifyKind::Any)) || event.need_rescan()
}

fn changes(root: &Path, events: Vec<Event>, self_writes: &HashMap<PathBuf, u64>) -> FsChange {
    let mut candidates = HashSet::new();
    let mut structural = HashSet::new();
    let mut out = FsChange::default();
    for ev in events {
        if !relevant(&ev) { continue; }
        out.structure |= ev.need_rescan();
        let structure = matches!(ev.kind, EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(notify::event::ModifyKind::Name(_)));
        let folder = matches!(ev.kind, EventKind::Create(notify::event::CreateKind::Folder) | EventKind::Remove(notify::event::RemoveKind::Folder));
        for p in ev.paths {
            let Some(rel) = paths::to_rel(root, &p) else { continue };
            if rel.is_empty() || rel.split('/').any(|seg| paths::is_ignored(seg, &[]) || seg.ends_with(".bmnotes-tmp") || seg.starts_with('.')) { continue; }
            if folder || p.is_dir() {
                out.structure |= structure;
            } else if paths::is_markdown(&p) {
                if structure { structural.insert(p.clone()); }
                candidates.insert((rel, p));
            } else if structure && !p.exists() {
                // Rename/remove events do not always distinguish directories.
                out.structure = true;
            }
        }
    }
    for (rel, abs) in candidates {
        if !abs.exists() {
            out.removed.push(rel);
            out.structure = true;
            continue;
        }
        if let Ok(content) = std::fs::read_to_string(&abs) {
            if self_writes.get(&abs) == Some(&hash_content(&content)) {
                // A temp-file rename over an existing note is our save, not a tree change.
                continue;
            }
        }
        out.structure |= structural.contains(&abs);
        out.changed.push(rel);
    }
    out
}

pub fn start(app: &AppHandle, state: &State<'_, AppState>, root: PathBuf) -> Result<(), String> {
    let (tx, rx) = mpsc::channel::<Event>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        if let Ok(ev) = res {
            if relevant(&ev) { let _ = tx.send(ev); }
        }
    }).map_err(|e| e.to_string())?;
    watcher.watch(&root, RecursiveMode::Recursive).map_err(|e| format!("Cannot watch folder: {e}"))?;
    *state.watcher.lock().map_err(|_| "state poisoned")? = Some(watcher);
    let self_writes = state.self_writes.clone();
    let app = app.clone();
    std::thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let mut events = vec![first];
            let deadline = Instant::now() + Duration::from_millis(500);
            // Continuous activity must not postpone notifications indefinitely.
            while Instant::now() < deadline {
                let timeout = Duration::from_millis(150).min(deadline.saturating_duration_since(Instant::now()));
                match rx.recv_timeout(timeout) { Ok(ev) => events.push(ev), Err(_) => break }
            }
            // Do not hold the shared mutex while reading files from disk.
            let hashes = self_writes.lock().map(|m| m.clone()).unwrap_or_default();
            let change = changes(&root, events, &hashes);
            if !change.changed.is_empty() || !change.removed.is_empty() || change.structure {
                let _ = app.emit("fs-change", change);
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{AccessKind, AccessMode, CreateKind, ModifyKind, RenameMode};

    #[test]
    fn reads_never_trigger_content_or_structure_changes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        std::fs::write(&path, "note").unwrap();
        let event = Event::new(EventKind::Access(AccessKind::Open(AccessMode::Any))).add_path(path);
        assert!(!relevant(&event));
        let change = changes(dir.path(), vec![event], &HashMap::new());
        assert!(change.changed.is_empty());
        assert!(!change.structure);
    }

    #[test]
    fn own_atomic_save_is_not_a_structure_change_but_external_creation_is() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        std::fs::write(&path, "saved").unwrap();
        let rename = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
            .add_path(dir.path().join(".note.md.bmnotes-tmp")).add_path(path.clone());
        let hashes = HashMap::from([(path.clone(), hash_content("saved"))]);
        let change = changes(dir.path(), vec![rename], &hashes);
        assert!(change.changed.is_empty());
        assert!(!change.structure);
        let create = Event::new(EventKind::Create(CreateKind::File)).add_path(path);
        let change = changes(dir.path(), vec![create], &HashMap::new());
        assert_eq!(change.changed, vec!["note.md"]);
        assert!(change.structure);
    }

    #[test]
    fn external_edits_and_renames_are_reported() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("new.md");
        std::fs::write(&path, "new text").unwrap();
        let edit = Event::new(EventKind::Modify(ModifyKind::Data(notify::event::DataChange::Content))).add_path(path.clone());
        let change = changes(dir.path(), vec![edit], &HashMap::new());
        assert_eq!(change.changed, vec!["new.md"]);
        assert!(!change.structure);
        let rename = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both))).add_path(dir.path().join("old.md")).add_path(path);
        let change = changes(dir.path(), vec![rename], &HashMap::new());
        assert_eq!(change.removed, vec!["old.md"]);
        assert_eq!(change.changed, vec!["new.md"]);
        assert!(change.structure);
    }
    #[test]
    fn real_watcher_does_not_loop_on_reads_or_own_atomic_saves() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        std::fs::write(&path, "original").unwrap();
        let (tx, rx) = mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |event: notify::Result<Event>| {
            if let Ok(event) = event { if relevant(&event) { let _ = tx.send(event); } }
        }).unwrap();
        watcher.watch(dir.path(), RecursiveMode::Recursive).unwrap();
        std::fs::read_to_string(&path).unwrap();
        assert!(rx.recv_timeout(Duration::from_millis(200)).is_err());
        crate::filesystem::ops::write_note(dir.path(), "note.md", "saved").unwrap();
        let first = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let mut events = vec![first];
        while let Ok(event) = rx.recv_timeout(Duration::from_millis(150)) { events.push(event); }
        let hashes = HashMap::from([(path.clone(), hash_content("saved"))]);
        let change = changes(dir.path(), events, &hashes);
        assert!(change.changed.is_empty() && change.removed.is_empty() && !change.structure);
        // Hashing the save must not put another access event back in the queue.
        assert!(rx.recv_timeout(Duration::from_millis(200)).is_err());
        std::fs::write(&path, "external edit").unwrap();
        let first = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let mut events = vec![first];
        while let Ok(event) = rx.recv_timeout(Duration::from_millis(150)) { events.push(event); }
        let change = changes(dir.path(), events, &hashes);
        assert_eq!(change.changed, vec!["note.md"]);
    }

}
