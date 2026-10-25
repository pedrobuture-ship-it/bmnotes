//! Optional GitHub sign-in (OAuth device flow). Nothing here runs unless the user starts it.
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

type Res<T> = Result<T, String>;

/// Public identifier of the "bmnotes" OAuth App. Device flow needs no client secret.
const CLIENT_ID: &str = "Ov23li8KuIIKb5wDdfrb";
const SCOPE: &str = "repo";
const UA: &str = "bmnotes";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStart {
    device_code: String,
    user_code: String,
    verification_uri: String,
    interval: u64,
    expires_in: u64,
}

#[derive(Deserialize)]
struct DeviceCodeResp {
    device_code: String,
    user_code: String,
    verification_uri: String,
    interval: Option<u64>,
    expires_in: Option<u64>,
}

#[derive(Deserialize)]
struct TokenResp {
    access_token: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Deserialize)]
struct UserResp {
    login: String,
    name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PollResult {
    /// "pending" | "slow_down" | "done"
    status: &'static str,
    login: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubUser {
    login: String,
    name: Option<String>,
}

pub(crate) fn client() -> Res<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(UA)
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())
}

pub(crate) fn net(e: reqwest::Error) -> String {
    format!("Could not reach GitHub: {e}")
}

fn token_path(app: &AppHandle) -> Res<PathBuf> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("github-token");
    if !path.exists() {
        // Move, rather than copy: logging out must not resurrect an old credential.
        if let Some(parent) = dir.parent() {
            let legacy = parent.join("app.buturenotes").join("github-token");
            if legacy.is_file() {
                std::fs::rename(legacy, &path).map_err(|e| format!("Cannot migrate GitHub sign-in: {e}"))?;
            }
        }
    }
    Ok(path)
}

fn save_token(app: &AppHandle, token: &str) -> Res<()> {
    let path = token_path(app)?;
    std::fs::write(&path, token).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn load_token(app: &AppHandle) -> Option<String> {
    let t = std::fs::read_to_string(token_path(app).ok()?).ok()?;
    let t = t.trim().to_string();
    (!t.is_empty()).then_some(t)
}

async fn fetch_user(token: &str) -> Res<UserResp> {
    let resp = client()?
        .get("https://api.github.com/user")
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(net)?;
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("unauthorized".into());
    }
    resp.error_for_status().map_err(net)?.json::<UserResp>().await.map_err(net)
}

#[tauri::command]
pub async fn github_login_start() -> Res<DeviceStart> {
    let r = client()?
        .post("https://github.com/login/device/code")
        .header("Accept", "application/json")
        .json(&serde_json::json!({ "client_id": CLIENT_ID, "scope": SCOPE }))
        .send()
        .await
        .map_err(net)?
        .error_for_status()
        .map_err(net)?
        .json::<DeviceCodeResp>()
        .await
        .map_err(net)?;
    Ok(DeviceStart {
        device_code: r.device_code,
        user_code: r.user_code,
        verification_uri: r.verification_uri,
        interval: r.interval.unwrap_or(5),
        expires_in: r.expires_in.unwrap_or(900),
    })
}

#[tauri::command]
pub async fn github_login_poll(app: AppHandle, device_code: String) -> Res<PollResult> {
    let r = client()?
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .json(&serde_json::json!({
            "client_id": CLIENT_ID,
            "device_code": device_code,
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
        }))
        .send()
        .await
        .map_err(net)?
        .json::<TokenResp>()
        .await
        .map_err(net)?;
    if let Some(token) = r.access_token {
        let user = fetch_user(&token).await?;
        save_token(&app, &token)?;
        return Ok(PollResult { status: "done", login: Some(user.login) });
    }
    match r.error.as_deref() {
        Some("authorization_pending") => Ok(PollResult { status: "pending", login: None }),
        Some("slow_down") => Ok(PollResult { status: "slow_down", login: None }),
        Some("expired_token") => Err("The code expired. Start again.".into()),
        Some("access_denied") => Err("Authorization was cancelled on GitHub.".into()),
        other => Err(r.error_description.unwrap_or_else(|| other.unwrap_or("Unknown GitHub error").to_string())),
    }
}

/// The signed-in user, or `None` when not connected or the token was revoked.
#[tauri::command]
pub async fn github_status(app: AppHandle) -> Res<Option<GithubUser>> {
    let Some(token) = load_token(&app) else { return Ok(None) };
    match fetch_user(&token).await {
        Ok(u) => Ok(Some(GithubUser { login: u.login, name: u.name })),
        Err(e) if e == "unauthorized" => {
            let _ = github_logout(app);
            Ok(None)
        }
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub fn github_logout(app: AppHandle) -> Res<()> {
    let path = token_path(&app)?;
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
