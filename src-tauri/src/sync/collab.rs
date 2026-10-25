//! Collaboration helpers on top of git: who is on which note, early conflict warnings, and files kept private.

use super::*;
use serde::Deserialize;
use std::time::{SystemTime, UNIX_EPOCH};

const EXCLUDE_BEGIN: &str = "# >>> bmnotes: private (managed, do not edit)";
const EXCLUDE_END: &str = "# <<< bmnotes: private";
/// Presence older than this is ignored.
const PRESENCE_TTL_MS: u64 = 3 * 60 * 1000;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Presence {
    pub login: String,
    pub note: Option<String>,
    /// Milliseconds since the Unix epoch.
    pub at: u64,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn safe_login(l: &str) -> Option<&str> {
    (!l.is_empty() && l.len() <= 39 && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')).then_some(l)
}

fn valid_private(p: &str) -> bool {
    let p = p.trim_matches('/');
    !p.is_empty() && !p.contains('\n') && !p.contains('\0') && !p.split('/').any(|s| s == ".." || s == ".") && !p.starts_with(".git") && !p.starts_with('-')
}

fn ignore_escape(p: &str) -> String {
    let mut out = String::from("/");
    for c in p.trim_matches('/').chars() {
        if matches!(c, '*' | '?' | '[' | ']' | '\\' | '!' | '#') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn ignore_unescape(line: &str) -> String {
    let mut out = String::new();
    let mut esc = false;
    for c in line.trim_start_matches('/').chars() {
        if esc {
            out.push(c);
            esc = false;
        } else if c == '\\' {
            esc = true;
        } else {
            out.push(c);
        }
    }
    out
}

impl Git {
    fn exclude_path(&self) -> PathBuf {
        self.root.join(".git").join("info").join("exclude")
    }

    /// Paths kept private on this computer (read from the managed block of `.git/info/exclude`).
    pub fn private_list(&self) -> Vec<String> {
        let text = std::fs::read_to_string(self.exclude_path()).unwrap_or_default();
        let mut inside = false;
        let mut out = Vec::new();
        for line in text.lines() {
            if line == EXCLUDE_BEGIN || line == "# >>> b&m notes: private (managed, do not edit)" {
                inside = true;
            } else if line == EXCLUDE_END || line == "# <<< b&m notes: private" {
                inside = false;
            } else if inside && !line.trim().is_empty() {
                out.push(ignore_unescape(line));
            }
        }
        out
    }

    fn write_private(&self, list: &[String]) -> Res<()> {
        let path = self.exclude_path();
        std::fs::create_dir_all(path.parent().ok_or("Invalid path")?).map_err(|e| e.to_string())?;
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        // Drop the old managed block, keep everything else.
        let mut kept = Vec::new();
        let mut inside = false;
        for line in text.lines() {
            if line == EXCLUDE_BEGIN || line == "# >>> b&m notes: private (managed, do not edit)" {
                inside = true;
            } else if line == EXCLUDE_END || line == "# <<< b&m notes: private" {
                inside = false;
            } else if !inside {
                kept.push(line.to_string());
            }
        }
        if !list.is_empty() {
            kept.push(EXCLUDE_BEGIN.to_string());
            kept.extend(list.iter().map(|p| ignore_escape(p)));
            kept.push(EXCLUDE_END.to_string());
        }
        std::fs::write(path, kept.join("\n") + "\n").map_err(|e| e.to_string())
    }

    /// Keeps `paths` out of the shared repository. Paths that are already shared are only changed with `force`
    /// (their copies disappear for the other people on their next sync); otherwise they are returned untouched.
    pub fn set_private(&self, paths: &[String], force: bool) -> Res<Vec<String>> {
        if !self.is_repo() {
            return Err("This folder is not linked to a repository.".into());
        }
        if let Some(bad) = paths.iter().find(|p| !valid_private(p)) {
            return Err(format!("Cannot keep \"{bad}\" private"));
        }
        let clean: Vec<String> = paths.iter().map(|p| p.trim_matches('/').to_string()).collect();
        let tracked: Vec<String> = clean.iter().filter(|p| !self.lines(&["ls-files", "--", p.as_str()]).is_empty()).cloned().collect();
        if !tracked.is_empty() && !force {
            return Ok(tracked);
        }
        let mut all = self.private_list();
        for p in &clean {
            if !all.contains(p) {
                all.push(p.clone());
            }
        }
        self.write_private(&all)?;
        for p in &tracked {
            self.run(&["rm", "-r", "--cached", "-q", "--ignore-unmatch", "--", p.as_str()])?;
        }
        Ok(vec![])
    }

    /// Shares `path` again; it is added on the next sync.
    pub fn remove_private(&self, path: &str) -> Res<()> {
        let want = path.trim_matches('/');
        let list: Vec<String> = self.private_list().into_iter().filter(|p| p != want).collect();
        self.write_private(&list)
    }

    /// Fetches, then reports what changed on the remote (cheap "is someone ahead of me?" check).
    pub fn check(&self) -> Res<SyncState> {
        if !self.is_repo() {
            return Ok(self.status());
        }
        self.run(&["fetch", "-q", "origin"]).map_err(|e| format!("Could not reach the repository: {e}"))?;
        Ok(self.status())
    }

    /// Publishes "`login` is on `note`" as a one-commit branch `bmnotes-presence-<login>` (force-pushed, never touching main).
    pub fn presence_publish(&self, login: &str, note: Option<&str>) -> Res<()> {
        let login = safe_login(login).ok_or("Invalid user name")?;
        let json = serde_json::to_string(&Presence { login: login.to_string(), note: note.map(String::from), at: now_ms() }).map_err(|e| e.to_string())?;
        let blob = self.run_in(&["hash-object", "-w", "--stdin"], json.as_bytes())?;
        let tree = self.run_in(&["mktree"], format!("100644 blob {}\tpresence.json\n", blob.trim()).as_bytes())?;
        let commit = self.run(&["commit-tree", tree.trim(), "-m", "presence"])?;
        let spec = format!("{}:refs/heads/bmnotes-presence-{login}", commit.trim());
        self.run(&["push", "-q", "--force", "origin", &spec])?;
        Ok(())
    }

    /// Other people seen in the last few minutes.
    pub fn presence_list(&self, me: &str) -> Res<Vec<Presence>> {
        self.run(&["fetch", "-q", "origin", "+refs/heads/bmnotes-presence-*:refs/remotes/origin/bmnotes-presence-*"])?;
        let cutoff = now_ms().saturating_sub(PRESENCE_TTL_MS);
        let mut out = Vec::new();
        for r in self.lines(&["for-each-ref", "--format=%(refname)", "refs/remotes/origin/"]) {
            if !r.starts_with("refs/remotes/origin/bmnotes-presence-") {
                continue;
            }
            let Ok(text) = self.run(&["show", &format!("{r}:presence.json")]) else { continue };
            let Ok(p) = serde_json::from_str::<Presence>(&text) else { continue };
            if p.login != me && p.at >= cutoff && safe_login(&p.login).is_some() {
                out.push(p);
            }
        }
        out.sort_by(|a, b| a.login.cmp(&b.login));
        Ok(out)
    }
}
