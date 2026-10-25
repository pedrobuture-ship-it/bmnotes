//! Optional folder sync through the system `git`. Nothing here runs unless the user links a repository.
mod board_merge;
mod collab;
mod commands;

pub use collab::Presence;
pub use commands::*;

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

type Res<T> = Result<T, String>;

const IGNORE_LINES: [&str; 6] = [".bmnotes/settings.json", ".bmnotes/sync.json", ".bmnotes/backups/", ".bmnotes/trash/", ".bmnotes/plugins/", ".bmnotes/*.corrupt.json"];
const LARGE_FILE: u64 = 10 * 1024 * 1024;
const BOARD: &str = ".bmnotes/board.json";

/// Board layout files that merge per card: the main mural, the extra murals and their index.
fn is_board_path(p: &str) -> bool {
    p == BOARD || p == ".bmnotes/boards.json" || (p.starts_with(".bmnotes/boards/") && p.ends_with(".json"))
}

#[derive(Serialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SyncState {
    pub git_available: bool,
    pub linked: bool,
    pub remote: Option<String>,
    pub branch: Option<String>,
    pub conflicts: Vec<String>,
    pub dirty: bool,
    pub ahead: u32,
    pub behind: u32,
    /// Files over 10 MB that were just committed (they make the repository heavy).
    pub large_files: Vec<String>,
    /// Files that changed on the remote since the last merge (what you would receive on the next sync).
    pub remote_changed: Vec<String>,
    /// Paths kept out of the shared repository on this computer.
    pub private: Vec<String>,
}

pub struct Git {
    root: PathBuf,
    /// Base64 of `x-access-token:<token>`, sent only to github.com.
    auth: Option<String>,
    identity: bool,
}

struct Out {
    ok: bool,
    stdout: String,
    stderr: String,
}

impl Git {
    pub fn new(root: &Path, auth: Option<String>) -> Self {
        let identity = Command::new("git")
            .current_dir(root)
            .args(["config", "user.email"])
            .output()
            .map(|o| o.status.success() && !o.stdout.is_empty())
            .unwrap_or(false);
        Git { root: root.to_path_buf(), auth, identity }
    }

    fn raw(&self, args: &[&str]) -> Res<Out> {
        self.raw_in(args, None)
    }

    /// Like `raw`, feeding `input` to git's stdin.
    fn raw_in(&self, args: &[&str], input: Option<&[u8]>) -> Res<Out> {
        use std::io::Write;
        use std::process::Stdio;
        let mut cmd = Command::new("git");
        cmd.current_dir(&self.root)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_ALLOW_PROTOCOL", "https:file")
            .env("LC_ALL", "C")
            .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(a) = &self.auth {
            cmd.arg("-c").arg(format!("http.https://github.com/.extraheader=Authorization: Basic {a}"));
        }
        if !self.identity {
            cmd.args(["-c", "user.name=bmnotes", "-c", "user.email=notes@bmnotes.local"]);
        }
        let mut child = cmd.args(args).spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound { "Git is not installed.".to_string() } else { e.to_string() }
        })?;
        if let (Some(data), Some(mut stdin)) = (input, child.stdin.take()) {
            stdin.write_all(data).map_err(|e| e.to_string())?;
        }
        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        Ok(Out {
            ok: out.status.success(),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        })
    }

    /// Runs git and fails with its stderr when it exits non-zero.
    fn run(&self, args: &[&str]) -> Res<String> {
        let o = self.raw(args)?;
        if o.ok { Ok(o.stdout) } else { Err(clean_err(&o.stderr, args)) }
    }

    fn run_in(&self, args: &[&str], input: &[u8]) -> Res<String> {
        let o = self.raw_in(args, Some(input))?;
        if o.ok { Ok(o.stdout) } else { Err(clean_err(&o.stderr, args)) }
    }

    fn ok(&self, args: &[&str]) -> bool {
        self.raw(args).map(|o| o.ok).unwrap_or(false)
    }

    fn lines(&self, args: &[&str]) -> Vec<String> {
        self.raw(args)
            .map(|o| o.stdout.lines().filter(|l| !l.is_empty()).map(String::from).collect())
            .unwrap_or_default()
    }

    pub fn is_repo(&self) -> bool {
        let Ok(o) = self.raw(&["rev-parse", "--show-toplevel"]) else { return false };
        if !o.ok {
            return false;
        }
        let top = PathBuf::from(o.stdout.trim());
        match (top.canonicalize(), self.root.canonicalize()) {
            (Ok(a), Ok(b)) => a == b,
            _ => false,
        }
    }

    fn merging(&self) -> bool {
        self.ok(&["rev-parse", "-q", "--verify", "MERGE_HEAD"])
    }

    fn has_commits(&self) -> bool {
        self.ok(&["rev-parse", "-q", "--verify", "HEAD"])
    }

    fn branch(&self) -> Option<String> {
        let b = self.run(&["symbolic-ref", "--short", "HEAD"]).ok()?;
        Some(b.trim().to_string())
    }

    fn conflicts(&self) -> Vec<String> {
        self.lines(&["diff", "--name-only", "--diff-filter=U"])
    }

    pub fn status(&self) -> SyncState {
        let mut s = SyncState { git_available: Command::new("git").arg("--version").output().is_ok(), ..Default::default() };
        if !s.git_available || !self.is_repo() {
            return s;
        }
        let remote = self.run(&["remote", "get-url", "origin"]).ok().map(|r| r.trim().to_string());
        s.linked = remote.is_some();
        s.remote = remote;
        s.branch = self.branch();
        s.conflicts = self.conflicts();
        s.dirty = !self.lines(&["status", "--porcelain"]).is_empty();
        s.private = self.private_list();
        if let Some(b) = &s.branch {
            let range = format!("HEAD...origin/{b}");
            if let Ok(o) = self.run(&["rev-list", "--left-right", "--count", &range]) {
                let mut it = o.split_whitespace().map(|n| n.parse::<u32>().unwrap_or(0));
                s.ahead = it.next().unwrap_or(0);
                s.behind = it.next().unwrap_or(0);
            }
            let theirs = format!("HEAD...origin/{b}");
            if s.behind > 0 {
                s.remote_changed = self.lines(&["diff", "--name-only", &theirs]);
            }
        }
        s
    }

    fn ensure_ignore(&self) -> Res<()> {
        let path = self.root.join(".gitignore");
        let cur = std::fs::read_to_string(&path).unwrap_or_default();
        let missing: Vec<&str> = IGNORE_LINES.iter().copied().filter(|l| !cur.lines().any(|x| x.trim() == *l)).collect();
        if missing.is_empty() {
            return Ok(());
        }
        let mut next = cur;
        if !next.is_empty() && !next.ends_with('\n') {
            next.push('\n');
        }
        for l in missing {
            next.push_str(l);
            next.push('\n');
        }
        std::fs::write(path, next).map_err(|e| e.to_string())
    }

    /// Stages everything and commits when something changed. Returns the large files that went in.
    fn commit_local(&self) -> Res<Vec<String>> {
        self.ensure_ignore()?;
        self.run(&["add", "-A"])?;
        if self.ok(&["diff", "--cached", "--quiet"]) {
            return Ok(vec![]);
        }
        let names = self.lines(&["diff", "--cached", "--name-only"]);
        let large = names
            .iter()
            .filter(|n| std::fs::metadata(self.root.join(n)).map(|m| m.len() > LARGE_FILE).unwrap_or(false))
            .cloned()
            .collect();
        let msg = match names.len() {
            1 => format!("sync: {}", names[0]),
            n => format!("sync: {n} files"),
        };
        self.run(&["commit", "-q", "-m", &msg])?;
        Ok(large)
    }

    fn remote_branch(&self, local: &str) -> Option<String> {
        let refs = self.lines(&["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"]);
        let has = |b: &str| refs.iter().any(|r| r == &format!("origin/{b}"));
        if has(local) {
            Some(local.to_string())
        } else if !self.has_commits() {
            ["main", "master"].iter().find(|b| has(b)).map(|b| b.to_string())
        } else {
            None
        }
    }

    /// Resolves board layout files automatically (per-card merge); anything else stays a conflict.
    fn auto_resolve_board(&self) {
        for path in self.conflicts().into_iter().filter(|c| is_board_path(c)) {
            let show = |stage: u8| self.run(&["show", &format!(":{stage}:{path}")]).ok();
            let merged = board_merge::merge_board(show(1).as_deref(), show(2).as_deref(), show(3).as_deref());
            if let Some(text) = merged {
                if std::fs::write(self.root.join(&path), text).is_ok() {
                    let _ = self.run(&["add", "--", &path]);
                }
            }
        }
    }

    fn finish_merge_if_clean(&self) -> Res<()> {
        if self.merging() && self.conflicts().is_empty() {
            self.run(&["add", "-A"])?;
            self.run(&["commit", "-q", "--no-edit"])?;
        }
        Ok(())
    }

    /// Commit local changes, merge what others pushed, then push. Stops (without pushing) on conflicts.
    pub fn sync(&self) -> Res<SyncState> {
        if !self.is_repo() {
            return Err("This folder is not linked to a repository.".into());
        }
        if self.merging() {
            self.auto_resolve_board();
            self.finish_merge_if_clean()?;
            if self.merging() {
                return Ok(self.status());
            }
        }
        let large = self.commit_local()?;
        let branch = self.branch().ok_or("No branch")?;
        for _ in 0..2 {
            self.run(&["fetch", "-q", "origin"]).map_err(|e| format!("Could not reach the repository: {e}"))?;
            if let Some(rb) = self.remote_branch(&branch) {
                let target = format!("origin/{rb}");
                if !self.ok(&["merge-base", "--is-ancestor", &target, "HEAD"]) {
                    let merged = self.raw(&["merge", "--no-edit", "--allow-unrelated-histories", &target])?;
                    if !merged.ok {
                        self.auto_resolve_board();
                        self.finish_merge_if_clean()?;
                        if self.merging() {
                            return Ok(SyncState { large_files: large, ..self.status() });
                        }
                        if !self.conflicts().is_empty() || !self.has_commits() {
                            return Err(clean_err(&merged.stderr, &["merge"]));
                        }
                    }
                }
            }
            let spec = format!("HEAD:refs/heads/{branch}");
            let pushed = self.raw(&["push", "-q", "-u", "origin", &spec])?;
            if pushed.ok {
                return Ok(SyncState { large_files: large, ..self.status() });
            }
            // Someone pushed in between: fetch + merge once more.
            if !(pushed.stderr.contains("rejected") || pushed.stderr.contains("fetch first")) {
                return Err(clean_err(&pushed.stderr, &["push"]));
            }
        }
        Err("The repository keeps changing; try again in a moment.".into())
    }

    pub fn link(&self, url: &str) -> Res<SyncState> {
        if !self.is_repo() {
            self.run(&["init", "-q", "-b", "main"])?;
        }
        self.ensure_ignore()?;
        if self.run(&["remote", "get-url", "origin"]).is_ok() {
            self.run(&["remote", "set-url", "origin", url])?;
        } else {
            self.run(&["remote", "add", "origin", url])?;
        }
        self.run(&["fetch", "-q", "origin"]).map_err(|e| format!("Could not reach the repository: {e}"))?;
        if !self.has_commits() {
            if let Some(rb) = self.remote_branch("main") {
                self.run(&["symbolic-ref", "HEAD", &format!("refs/heads/{rb}")])?;
            }
        }
        self.sync()
    }

    pub fn unlink(&self) -> Res<()> {
        if self.is_repo() && self.ok(&["remote", "get-url", "origin"]) {
            self.run(&["remote", "remove", "origin"])?;
        }
        Ok(())
    }

    /// `choice`: "mine" | "theirs" | "both".
    pub fn resolve(&self, path: &str, choice: &str) -> Res<SyncState> {
        if path.starts_with('-') || path.contains("..") {
            return Err("Invalid path".into());
        }
        let stage = |n: u8| self.run(&["show", &format!(":{n}:{path}")]).ok();
        let (ours, theirs) = (stage(2), stage(3));
        let abs = self.root.join(path);
        let take = |s: Option<String>| -> Res<()> {
            match s {
                Some(text) => {
                    std::fs::write(&abs, text).map_err(|e| e.to_string())?;
                    self.run(&["add", "--", path])?;
                }
                None => {
                    let _ = std::fs::remove_file(&abs);
                    self.run(&["rm", "-q", "--cached", "--ignore-unmatch", "--", path])?;
                }
            }
            Ok(())
        };
        match choice {
            "mine" => take(ours)?,
            "theirs" => take(theirs)?,
            "both" => {
                if let (Some(o), Some(t)) = (ours.clone(), theirs) {
                    let copy = sibling_name(&self.root, path);
                    std::fs::write(self.root.join(&copy), t).map_err(|e| e.to_string())?;
                    take(Some(o))?;
                } else {
                    take(ours)?;
                }
            }
            _ => return Err("Unknown choice".into()),
        }
        self.finish_merge_if_clean()?;
        if !self.merging() {
            return self.sync();
        }
        Ok(self.status())
    }
}

fn sibling_name(root: &Path, path: &str) -> String {
    let p = Path::new(path);
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let dir = p.parent().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
    let mut n = 0;
    loop {
        let suffix = if n == 0 { " (from other)".to_string() } else { format!(" (from other {n})") };
        let name = format!("{stem}{suffix}{ext}");
        let rel = if dir.is_empty() { name } else { format!("{dir}/{name}") };
        if !root.join(&rel).exists() {
            return rel;
        }
        n += 1;
    }
}

fn clean_err(stderr: &str, args: &[&str]) -> String {
    let msg = stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("git failed").trim().to_string();
    let lower = msg.to_lowercase();
    if lower.contains("authentication") || lower.contains("403") || lower.contains("401") || lower.contains("could not read username") {
        "GitHub refused access. Reconnect your account or check that you can write to this repository.".into()
    } else if lower.contains("could not resolve host") || lower.contains("unable to access") {
        "No connection to GitHub.".into()
    } else {
        format!("git {}: {msg}", args.first().copied().unwrap_or(""))
    }
}

#[cfg(test)]
mod tests;
