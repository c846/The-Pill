//! Apps from the Start menu, read from the same "shell:AppsFolder" list that Get-StartApps uses.

use crate::util::err;
use serde::Serialize;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_APARTMENTTHREADED};
use windows::Win32::UI::Shell::{
    BHID_EnumItems, FOLDERID_AppsFolder, IEnumShellItems, IShellItem, SHGetKnownFolderItem, KF_FLAG_DEFAULT,
    SIGDN, SIGDN_NORMALDISPLAY, SIGDN_PARENTRELATIVEPARSING,
};

// New installs show up once the list is this old.
const MAX_AGE: Duration = Duration::from_secs(10 * 60);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct App {
    name: String,
    app_id: String,
}

static CACHE: Mutex<Option<(Instant, Arc<Vec<App>>)>> = Mutex::const_new(None);

/// Reads the list on its own thread, because the shell expects a single-threaded apartment.
fn load() -> Result<Vec<App>, String> {
    std::thread::spawn(|| unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let apps = enumerate().map_err(err);
        CoUninitialize();
        apps
    })
    .join()
    .map_err(|_| "Could not read the list of apps.".to_string())?
}

unsafe fn display_name(item: &IShellItem, kind: SIGDN) -> Option<String> {
    let name = item.GetDisplayName(kind).ok()?;
    let text = name.to_string().ok();
    CoTaskMemFree(Some(name.0 as *const _));
    text.filter(|text| !text.trim().is_empty())
}

unsafe fn enumerate() -> windows::core::Result<Vec<App>> {
    let folder: IShellItem = SHGetKnownFolderItem(&FOLDERID_AppsFolder, KF_FLAG_DEFAULT, None)?;
    let items: IEnumShellItems = folder.BindToHandler(None, &BHID_EnumItems)?;
    let mut apps = Vec::new();
    let mut seen = HashSet::new();
    loop {
        let mut batch = [None];
        let mut fetched = 0;
        if items.Next(&mut batch, Some(&mut fetched)).is_err() || fetched == 0 {
            break;
        }
        let Some(item) = batch[0].take() else { break };
        // The parsing name is the app's ID: a package family name or a path to a program.
        if let (Some(name), Some(app_id)) =
            (display_name(&item, SIGDN_NORMALDISPLAY), display_name(&item, SIGDN_PARENTRELATIVEPARSING))
        {
            if seen.insert(app_id.clone()) {
                apps.push(App { name, app_id });
            }
        }
    }
    apps.sort_by_cached_key(|app| (app.name.to_lowercase(), app.app_id.clone()));
    Ok(apps)
}

async fn cached_apps() -> Result<Arc<Vec<App>>, String> {
    let mut cache = CACHE.lock().await;
    if let Some((loaded_at, apps)) = cache.as_ref() {
        if loaded_at.elapsed() < MAX_AGE {
            return Ok(apps.clone());
        }
    }
    let apps = Arc::new(tauri::async_runtime::spawn_blocking(load).await.map_err(err)??);
    *cache = Some((Instant::now(), apps.clone()));
    Ok(apps)
}

/// Loads the list at startup so the apps panel opens instantly.
pub fn preload() {
    tauri::async_runtime::spawn(async {
        if let Err(error) = cached_apps().await {
            eprintln!("Failed to load the list of apps: {error}");
        }
    });
}

#[tauri::command]
pub async fn get_apps() -> Result<Vec<App>, String> {
    Ok(cached_apps().await?.as_ref().clone())
}

#[tauri::command]
pub async fn launch_app(app_id: String) -> Result<(), String> {
    // Only apps from the list can be launched, so the page can't be used to run anything else.
    if !cached_apps().await?.iter().any(|app| app.app_id == app_id) {
        return Err("The requested app is no longer available.".into());
    }
    std::process::Command::new("explorer.exe")
        .arg(format!("shell:AppsFolder\\{app_id}"))
        .spawn()
        .map(|_| ())
        .map_err(err)
}
