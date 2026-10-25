use super::*;
use std::fs;
use tempfile::TempDir;

fn git_in(dir: &Path, args: &[&str]) {
    let st = Command::new("git").current_dir(dir).args(args).output().unwrap();
    assert!(st.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&st.stderr));
}

struct World {
    _remote: TempDir,
    url: String,
    a: TempDir,
    b: TempDir,
}

fn world() -> World {
    let remote = TempDir::new().unwrap();
    git_in(remote.path(), &["init", "-q", "--bare", "-b", "main"]);
    let url = remote.path().to_string_lossy().into_owned();
    let w = World { url, _remote: remote, a: TempDir::new().unwrap(), b: TempDir::new().unwrap() };
    w
}

fn git(dir: &TempDir) -> Git {
    Git::new(dir.path(), None)
}

fn write(dir: &TempDir, rel: &str, text: &str) {
    let p = dir.path().join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, text).unwrap();
}

fn read(dir: &TempDir, rel: &str) -> String {
    fs::read_to_string(dir.path().join(rel)).unwrap()
}

#[test]
fn two_people_converge_on_different_files() {
    let w = world();
    write(&w.a, "one.md", "# one\n");
    git(&w.a).link(&w.url).unwrap();
    git(&w.b).link(&w.url).unwrap();
    assert_eq!(read(&w.b, "one.md"), "# one\n");

    write(&w.a, "a-only.md", "from a\n");
    write(&w.b, "b-only.md", "from b\n");
    git(&w.a).sync().unwrap();
    git(&w.b).sync().unwrap();
    let st = git(&w.a).sync().unwrap();
    assert!(st.conflicts.is_empty());
    assert_eq!(read(&w.a, "b-only.md"), "from b\n");
    assert_eq!(read(&w.b, "a-only.md"), "from a\n");
}

#[test]
fn same_file_different_lines_merges_automatically() {
    let w = world();
    write(&w.a, "n.md", "l1\nl2\nl3\nl4\nl5\nl6\nl7\n");
    git(&w.a).link(&w.url).unwrap();
    git(&w.b).link(&w.url).unwrap();
    write(&w.a, "n.md", "A1\nl2\nl3\nl4\nl5\nl6\nl7\n");
    write(&w.b, "n.md", "l1\nl2\nl3\nl4\nl5\nl6\nB7\n");
    git(&w.a).sync().unwrap();
    let st = git(&w.b).sync().unwrap();
    assert!(st.conflicts.is_empty());
    assert_eq!(read(&w.b, "n.md"), "A1\nl2\nl3\nl4\nl5\nl6\nB7\n");
}

#[test]
fn same_line_conflicts_and_can_be_resolved() {
    let w = world();
    write(&w.a, "n.md", "title\n");
    git(&w.a).link(&w.url).unwrap();
    git(&w.b).link(&w.url).unwrap();
    write(&w.a, "n.md", "mine\n");
    write(&w.b, "n.md", "theirs\n");
    git(&w.a).sync().unwrap();
    let st = git(&w.b).sync().unwrap();
    assert_eq!(st.conflicts, vec!["n.md".to_string()]);
    // Syncing again while conflicted does not push or lose anything.
    assert_eq!(git(&w.b).sync().unwrap().conflicts.len(), 1);

    let st = git(&w.b).resolve("n.md", "both").unwrap();
    assert!(st.conflicts.is_empty());
    assert_eq!(read(&w.b, "n.md"), "theirs\n");
    assert_eq!(read(&w.b, "n (from other).md"), "mine\n");
    git(&w.a).sync().unwrap();
    assert_eq!(read(&w.a, "n.md"), "theirs\n");
}

#[test]
fn board_json_merges_per_card_and_ignores_viewport() {
    let w = world();
    let base = r#"{"version":1,"viewport":{"x":0,"y":0,"zoom":1},"cards":{"a.md":{"x":0,"y":0},"b.md":{"x":10,"y":10}},"frames":[],"connections":[],"labels":{}}"#;
    write(&w.a, ".bmnotes/board.json", base);
    write(&w.a, "a.md", "a\n");
    git(&w.a).link(&w.url).unwrap();
    git(&w.b).link(&w.url).unwrap();
    write(&w.a, ".bmnotes/board.json", &base.replace(r#""a.md":{"x":0,"y":0}"#, r#""a.md":{"x":99,"y":0}"#).replace(r#""zoom":1"#, r#""zoom":2"#));
    write(&w.b, ".bmnotes/board.json", &base.replace(r#""b.md":{"x":10,"y":10}"#, r#""b.md":{"x":10,"y":77}"#).replace(r#""zoom":1"#, r#""zoom":3"#));
    git(&w.a).sync().unwrap();
    let st = git(&w.b).sync().unwrap();
    assert!(st.conflicts.is_empty(), "{:?}", st.conflicts);
    let merged: serde_json::Value = serde_json::from_str(&read(&w.b, ".bmnotes/board.json")).unwrap();
    assert_eq!(merged["cards"]["a.md"]["x"], 99);
    assert_eq!(merged["cards"]["b.md"]["y"], 77);
}

#[test]
fn private_files_are_ignored_and_status_reports_link() {
    let w = world();
    write(&w.a, "n.md", "x\n");
    write(&w.a, ".bmnotes/settings.json", "{}");
    let g = git(&w.a);
    assert!(!g.status().linked);
    let st = g.link(&w.url).unwrap();
    assert!(st.linked && st.dirty == false && st.branch.as_deref() == Some("main"));
    let tracked = g.lines(&["ls-files"]);
    assert!(tracked.contains(&"n.md".to_string()));
    assert!(!tracked.iter().any(|f| f.contains("settings.json")));
    g.unlink().unwrap();
    assert!(!g.status().linked);
}

#[test]
fn edit_beats_delete_is_left_to_the_user() {
    let w = world();
    write(&w.a, "n.md", "x\n");
    git(&w.a).link(&w.url).unwrap();
    git(&w.b).link(&w.url).unwrap();
    fs::remove_file(w.a.path().join("n.md")).unwrap();
    write(&w.b, "n.md", "edited\n");
    git(&w.a).sync().unwrap();
    let st = git(&w.b).sync().unwrap();
    assert_eq!(st.conflicts, vec!["n.md".to_string()]);
    let st = git(&w.b).resolve("n.md", "mine").unwrap();
    assert!(st.conflicts.is_empty());
    assert_eq!(read(&w.b, "n.md"), "edited\n");
}

#[test]
fn check_reports_what_the_other_person_changed_before_you_sync() {
    let w = world();
    write(&w.a, "n.md", "one\n");
    git(&w.a).link(&w.url).unwrap();
    git(&w.b).link(&w.url).unwrap();
    assert!(git(&w.b).check().unwrap().remote_changed.is_empty());
    write(&w.a, "n.md", "two\n");
    git(&w.a).sync().unwrap();
    let st = git(&w.b).check().unwrap();
    assert_eq!(st.remote_changed, vec!["n.md".to_string()]);
    assert!(st.behind >= 1);
    git(&w.b).sync().unwrap();
    assert!(git(&w.b).check().unwrap().remote_changed.is_empty());
}

#[test]
fn presence_is_visible_to_others_but_not_to_yourself() {
    let w = world();
    write(&w.a, "n.md", "x\n");
    git(&w.a).link(&w.url).unwrap();
    git(&w.b).link(&w.url).unwrap();
    git(&w.a).presence_publish("ana", Some("n.md")).unwrap();
    git(&w.a).presence_publish("ana", Some("m.md")).unwrap(); // force-push replaces the old one
    let seen = git(&w.b).presence_list("bo").unwrap();
    assert_eq!(seen.len(), 1);
    assert_eq!((seen[0].login.as_str(), seen[0].note.as_deref()), ("ana", Some("m.md")));
    assert!(git(&w.b).presence_list("ana").unwrap().is_empty());
    assert!(git(&w.a).presence_publish("../evil", None).is_err());
    // Presence never lands on the main branch.
    git(&w.b).sync().unwrap();
    assert!(!w.b.path().join("presence.json").exists());
}

#[test]
fn private_files_stay_local_and_shared_ones_need_confirmation() {
    let w = world();
    write(&w.a, "open.md", "o\n");
    write(&w.a, "secret.md", "s\n");
    git(&w.a).link(&w.url).unwrap();
    git(&w.b).link(&w.url).unwrap();
    assert!(w.b.path().join("secret.md").exists());

    // Already shared: nothing changes until the user confirms.
    assert_eq!(git(&w.a).set_private(&["secret.md".into()], false).unwrap(), vec!["secret.md".to_string()]);
    assert!(git(&w.a).private_list().is_empty());
    assert!(git(&w.a).set_private(&["secret.md".into()], true).unwrap().is_empty());
    assert_eq!(git(&w.a).private_list(), vec!["secret.md".to_string()]);
    git(&w.a).sync().unwrap();
    assert!(w.a.path().join("secret.md").exists(), "the owner keeps the file");
    git(&w.b).sync().unwrap();
    assert!(!w.b.path().join("secret.md").exists(), "the other copy is removed on their next sync");

    // A new private file never leaves this computer.
    write(&w.a, "diary.md", "d\n");
    assert!(git(&w.a).set_private(&["diary.md".into()], false).unwrap().is_empty());
    git(&w.a).sync().unwrap();
    git(&w.b).sync().unwrap();
    assert!(!w.b.path().join("diary.md").exists());
    assert!(git(&w.a).status().private.contains(&"diary.md".to_string()));

    // Sharing it again.
    git(&w.a).remove_private("diary.md").unwrap();
    git(&w.a).sync().unwrap();
    git(&w.b).sync().unwrap();
    assert!(w.b.path().join("diary.md").exists());
    assert!(git(&w.a).set_private(&["../x".into()], false).is_err());
    assert!(git(&w.a).set_private(&[".git/config".into()], false).is_err());
}
