//! Workspace-relative path handling. Every path coming from the frontend goes
//! through `safe_join` so nothing can escape the opened workspace.

use std::path::{Component, Path, PathBuf};

pub const METADATA_DIR: &str = ".bmnotes";
pub const DEFAULT_IGNORED: [&str; 3] = ["node_modules", ".git", ".bmnotes"];

/// Validates a relative path ("a/b/c.md") and joins it onto `root`.
/// Rejects absolute paths, `..`, NUL bytes and anything that resolves (through
/// symlinks) outside the workspace root.
pub fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.contains('\0') {
        return Err("Invalid path".into());
    }
    let rel_path = Path::new(rel);
    for c in rel_path.components() {
        match c {
            Component::Normal(_) | Component::CurDir => {}
            _ => return Err(format!("Path not allowed: {rel}")),
        }
    }
    let joined = root.join(rel_path);
    // Walk up to the nearest existing ancestor and make sure it is inside root.
    let mut probe = joined.as_path();
    loop {
        if probe.exists() || probe.symlink_metadata().is_ok() {
            let canon = probe.canonicalize().map_err(|e| e.to_string())?;
            if !canon.starts_with(root) {
                return Err(format!("Path escapes workspace: {rel}"));
            }
            break;
        }
        match probe.parent() {
            Some(p) => probe = p,
            None => return Err("Invalid path".into()),
        }
    }
    Ok(joined)
}

/// Converts an absolute path inside `root` into a '/'-separated relative path.
pub fn to_rel(root: &Path, abs: &Path) -> Option<String> {
    let rel = abs.strip_prefix(root).ok()?;
    let parts: Vec<String> = rel
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    Some(parts.join("/"))
}

/// A single file/folder name: no separators, no traversal, no reserved chars.
pub fn validate_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." {
        return Err("Invalid name".into());
    }
    if name.chars().any(|c| matches!(c, '/' | '\\' | '\0' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control()) {
        return Err("Name contains invalid characters".into());
    }
    if name.len() > 200 {
        return Err("Name too long".into());
    }
    Ok(name.to_string())
}

pub fn is_ignored(name: &str, extra: &[String]) -> bool {
    DEFAULT_IGNORED.contains(&name) || extra.iter().any(|e| e == name)
}

pub fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"))
        .unwrap_or(false)
}

pub fn image_mime(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        "svg" => Some("image/svg+xml"),
        _ => None,
    }
}

/// Mime type for files the app may embed or open from a note: images, PDFs and audio.
pub fn attachment_mime(path: &Path) -> Option<&'static str> {
    if let Some(m) = image_mime(path) {
        return Some(m);
    }
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "pdf" => Some("application/pdf"),
        "mp3" => Some("audio/mpeg"),
        "wav" => Some("audio/wav"),
        "ogg" | "oga" | "opus" => Some("audio/ogg"),
        "m4a" | "aac" => Some("audio/mp4"),
        "webm" => Some("audio/webm"),
        "flac" => Some("audio/flac"),
        _ => None,
    }
}

/// Returns `name` or `name 2`, `name 3`… so that it does not collide in `dir`.
pub fn unique_name(dir: &Path, stem: &str, ext: &str) -> String {
    let make = |n: u32| {
        let base = if n == 1 { stem.to_string() } else { format!("{stem}-{n}") };
        if ext.is_empty() { base } else { format!("{base}.{ext}") }
    };
    let mut n = 1;
    loop {
        let candidate = make(n);
        if !dir.join(&candidate).exists() {
            return candidate;
        }
        n += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn rejects_traversal_and_absolute() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        assert!(safe_join(&root, "../x.md").is_err());
        assert!(safe_join(&root, "a/../../x.md").is_err());
        assert!(safe_join(&root, "/etc/passwd").is_err());
        assert!(safe_join(&root, "ok/new.md").is_ok());
    }

    #[test]
    fn rejects_symlink_escape() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.path(), root.join("link")).unwrap();
            assert!(safe_join(&root, "link/secret.md").is_err());
        }
        fs::write(root.join("a.md"), "x").unwrap();
        assert!(safe_join(&root, "a.md").is_ok());
    }

    #[test]
    fn validates_names() {
        assert!(validate_name("ok name.md").is_ok());
        assert!(validate_name("..").is_err());
        assert!(validate_name("a/b").is_err());
        assert!(validate_name("   ").is_err());
        assert!(validate_name("a\\b").is_err());
    }

    #[test]
    fn unique_names_do_not_collide() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("nota.md"), "").unwrap();
        assert_eq!(unique_name(tmp.path(), "nota", "md"), "nota-2.md");
        assert_eq!(unique_name(tmp.path(), "outra", "md"), "outra.md");
    }

    #[test]
    fn relative_paths_use_forward_slashes() {
        let root = Path::new("/w");
        assert_eq!(to_rel(root, Path::new("/w/a/b.md")).unwrap(), "a/b.md");
    }
}
