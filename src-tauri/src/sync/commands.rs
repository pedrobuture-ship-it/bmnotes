use super::{Git, SyncState};
use crate::filesystem::AppState;
use crate::github;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, State};

type Res<T> = Result<T, String>;

static LOCK: Mutex<()> = Mutex::new(());

fn auth(app: &AppHandle) -> Option<String> {
    github::load_token(app).map(|t| base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{t}")))
}

/// Runs blocking git work off the UI thread, one sync operation at a time.
async fn with_git<T: Send + 'static>(app: &AppHandle, state: &State<'_, AppState>, f: impl FnOnce(Git) -> Res<T> + Send + 'static) -> Res<T> {
    let root = state.root()?;
    let git = Git::new(&root, auth(app));
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = LOCK.try_lock().map_err(|_| "busy".to_string())?;
        f(git)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Accepts `owner/name` or an https://github.com/ URL and returns a canonical clone URL.
fn normalize_url(input: &str) -> Res<String> {
    let t = input.trim().trim_end_matches('/');
    let path = t
        .strip_prefix("https://github.com/")
        .or_else(|| t.strip_prefix("github.com/"))
        .unwrap_or(t)
        .trim_end_matches(".git");
    let mut parts = path.split('/');
    let (Some(owner), Some(name), None) = (parts.next(), parts.next(), parts.next()) else {
        return Err("Use the form owner/name or https://github.com/owner/name".into());
    };
    let ok = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if !ok(owner) || !ok(name) {
        return Err("That does not look like a GitHub repository.".into());
    }
    Ok(format!("https://github.com/{owner}/{name}.git"))
}

#[tauri::command]
pub async fn sync_status(app: AppHandle, state: State<'_, AppState>) -> Res<SyncState> {
    let root = state.root()?;
    let git = Git::new(&root, auth(&app));
    tauri::async_runtime::spawn_blocking(move || git.status()).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sync_link(app: AppHandle, state: State<'_, AppState>, url: String) -> Res<SyncState> {
    if github::load_token(&app).is_none() {
        return Err("Connect your GitHub account first.".into());
    }
    let url = normalize_url(&url)?;
    with_git(&app, &state, move |g| g.link(&url)).await
}

#[tauri::command]
pub async fn sync_now(app: AppHandle, state: State<'_, AppState>) -> Res<SyncState> {
    with_git(&app, &state, |g| g.sync()).await
}

#[tauri::command]
pub async fn sync_resolve(app: AppHandle, state: State<'_, AppState>, path: String, choice: String) -> Res<SyncState> {
    with_git(&app, &state, move |g| g.resolve(&path, &choice)).await
}

#[tauri::command]
pub async fn sync_unlink(app: AppHandle, state: State<'_, AppState>) -> Res<SyncState> {
    with_git(&app, &state, |g| {
        g.unlink()?;
        Ok(g.status())
    })
    .await
}

/// Fetches and reports what others changed on the remote.
#[tauri::command]
pub async fn sync_check(app: AppHandle, state: State<'_, AppState>) -> Res<SyncState> {
    with_git(&app, &state, |g| g.check()).await
}

/// Keeps paths out of the shared repository. Returns the paths that are already shared and were left alone (pass `force` to unshare).
#[tauri::command]
pub async fn sync_set_private(app: AppHandle, state: State<'_, AppState>, paths: Vec<String>, force: bool) -> Res<Vec<String>> {
    with_git(&app, &state, move |g| g.set_private(&paths, force)).await
}

#[tauri::command]
pub async fn sync_unset_private(app: AppHandle, state: State<'_, AppState>, path: String) -> Res<SyncState> {
    with_git(&app, &state, move |g| {
        g.remove_private(&path)?;
        Ok(g.status())
    })
    .await
}

#[tauri::command]
pub async fn sync_presence_publish(app: AppHandle, state: State<'_, AppState>, login: String, note: Option<String>) -> Res<()> {
    with_git(&app, &state, move |g| g.presence_publish(&login, note.as_deref())).await
}

#[tauri::command]
pub async fn sync_presence_list(app: AppHandle, state: State<'_, AppState>, me: String) -> Res<Vec<super::Presence>> {
    with_git(&app, &state, move |g| g.presence_list(&me)).await
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    pub full_name: String,
    pub private: bool,
    #[serde(skip_deserializing)]
    pub url: String,
}

#[derive(Deserialize)]
struct ApiRepo {
    full_name: String,
    private: bool,
}

fn token(app: &AppHandle) -> Res<String> {
    github::load_token(app).ok_or_else(|| "Connect your GitHub account first.".to_string())
}

#[tauri::command]
pub async fn github_list_repos(app: AppHandle) -> Res<Vec<Repo>> {
    let tk = token(&app)?;
    let list = github::client()?
        .get("https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member")
        .bearer_auth(tk)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(github::net)?
        .error_for_status()
        .map_err(github::net)?
        .json::<Vec<ApiRepo>>()
        .await
        .map_err(github::net)?;
    Ok(list
        .into_iter()
        .map(|r| Repo { url: format!("https://github.com/{}.git", r.full_name), full_name: r.full_name, private: r.private })
        .collect())
}

#[tauri::command]
pub async fn github_create_repo(app: AppHandle, name: String, private: bool) -> Res<Repo> {
    let tk = token(&app)?;
    let resp = github::client()?
        .post("https://api.github.com/user/repos")
        .bearer_auth(tk)
        .header("Accept", "application/vnd.github+json")
        .json(&serde_json::json!({ "name": name, "private": private, "description": "Notes synced with bmnotes" }))
        .send()
        .await
        .map_err(github::net)?;
    if resp.status() == reqwest::StatusCode::UNPROCESSABLE_ENTITY {
        return Err("A repository with that name already exists (or the name is invalid).".into());
    }
    let r = resp.error_for_status().map_err(github::net)?.json::<ApiRepo>().await.map_err(github::net)?;
    Ok(Repo { url: format!("https://github.com/{}.git", r.full_name), full_name: r.full_name, private: r.private })
}

#[cfg(test)]
mod tests {
    use super::normalize_url;

    #[test]
    fn normalizes_and_rejects_urls() {
        assert_eq!(normalize_url("a/b").unwrap(), "https://github.com/a/b.git");
        assert_eq!(normalize_url("https://github.com/a/b.git/").unwrap(), "https://github.com/a/b.git");
        assert!(normalize_url("ext::sh -c evil").is_err());
        assert!(normalize_url("file:///tmp/x").is_err());
        assert!(normalize_url("a/b/c").is_err());
    }
}
