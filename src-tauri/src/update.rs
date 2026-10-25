//! Optional "is there a newer version?" check against the GitHub releases of this project.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

const REPO: &str = "pedrobuture-ship-it/bmnotes";

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub newer: bool,
    pub url: String,
    pub notes: String,
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    html_url: String,
    #[serde(default)]
    body: Option<String>,
}

fn parts(v: &str) -> Vec<u64> {
    v.trim().trim_start_matches(['v', 'V']).split(['.', '-', '+']).map(|p| p.parse::<u64>().unwrap_or(0)).take(3).collect()
}

/// True when `latest` (e.g. "v0.2.0") is a higher version than `current` ("0.1.0").
pub fn is_newer(latest: &str, current: &str) -> bool {
    let (mut a, mut b) = (parts(latest), parts(current));
    a.resize(3, 0);
    b.resize(3, 0);
    a > b
}

/// Looks up the latest published release. Makes one request to api.github.com, only when the user asks or opted in.
#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<UpdateInfo, String> {
    let current = app.package_info().version.to_string();
    let rel = crate::github::client()?
        .get(format!("https://api.github.com/repos/{REPO}/releases/latest"))
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(crate::github::net)?;
    if rel.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(UpdateInfo { latest: current.clone(), current, newer: false, url: format!("https://github.com/{REPO}/releases"), notes: String::new() });
    }
    let rel = rel.error_for_status().map_err(crate::github::net)?.json::<Release>().await.map_err(crate::github::net)?;
    Ok(UpdateInfo {
        newer: is_newer(&rel.tag_name, &current),
        latest: rel.tag_name.trim_start_matches(['v', 'V']).to_string(),
        url: rel.html_url,
        notes: rel.body.unwrap_or_default().chars().take(1500).collect(),
        current,
    })
}

#[cfg(test)]
mod tests {
    use super::is_newer;

    #[test]
    fn compares_versions() {
        assert!(is_newer("v0.2.0", "0.1.0"));
        assert!(is_newer("0.1.1", "0.1.0"));
        assert!(is_newer("v1.0", "0.9.9"));
        assert!(!is_newer("v0.1.0", "0.1.0"));
        assert!(!is_newer("0.0.9", "0.1.0"));
        assert!(is_newer("v0.10.0", "0.9.0"));
        assert!(!is_newer("garbage", "0.1.0"));
    }
}
