//! Windows notifications, read from the notification center so the pill can show them.
//!
//! Windows only offers a change event to packaged apps, so a background thread checks once a second.
//! Each check is a single in-process call. Until the user grants access it checks every 5 seconds.

use crate::util::{emit, init_com, truncate};
use serde::Serialize;
use std::collections::HashSet;
use std::sync::Mutex;
use std::thread::sleep;
use std::time::Duration;
use windows::UI::Notifications::Management::{UserNotificationListener, UserNotificationListenerAccessStatus};
use windows::UI::Notifications::{KnownNotificationBindings, NotificationKinds, UserNotification};

const CHECK_INTERVAL: Duration = Duration::from_secs(1);
const ACCESS_CHECK_INTERVAL: Duration = Duration::from_secs(5);
const HISTORY_LIMIT: usize = 50;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    id: u64,
    app_name: String,
    title: String,
    message: String,
    time: String,
}

struct State {
    access: String,
    history: Vec<Entry>,
    next_id: u64,
}

static STATE: Mutex<State> = Mutex::new(State { access: String::new(), history: Vec::new(), next_id: 1 });

pub fn start() {
    std::thread::Builder::new()
        .name("pill-notifications".into())
        .spawn(run)
        .expect("could not start the pill's notification thread");
}

fn set_access(access: &str) {
    let mut state = STATE.lock().unwrap();
    if state.access != access {
        state.access = access.to_string();
        drop(state);
        emit("notification-status", access);
    }
}

fn run() {
    init_com();
    let listener = match UserNotificationListener::Current() {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("Windows notifications are unavailable: {error}");
            return set_access("Unavailable");
        }
    };

    // Notifications already in the notification center when the pill starts aren't shown again.
    let mut known: Option<HashSet<(u32, i64)>> = None;
    let mut reported_error = false;
    loop {
        let access = match listener.GetAccessStatus() {
            Ok(UserNotificationListenerAccessStatus::Allowed) => "Allowed",
            Ok(UserNotificationListenerAccessStatus::Denied) => "Denied",
            Ok(_) => "Unspecified",
            Err(_) => "Unavailable",
        };
        set_access(access);
        if access != "Allowed" {
            known = None;
            sleep(ACCESS_CHECK_INTERVAL);
            continue;
        }

        match listener.GetNotificationsAsync(NotificationKinds::Toast).and_then(|op| op.join()) {
            Ok(list) => {
                reported_error = false;
                let mut current = HashSet::new();
                for notification in &list {
                    let key = (
                        notification.Id().unwrap_or(0),
                        notification.CreationTime().map(|time| time.UniversalTime).unwrap_or(0),
                    );
                    current.insert(key);
                    if known.as_ref().is_some_and(|known| !known.contains(&key)) {
                        record(&notification);
                    }
                }
                // Keeping only what is still in the notification center stops this set from growing forever.
                known = Some(current);
            }
            Err(error) if !reported_error => {
                reported_error = true;
                eprintln!("Could not read Windows notifications: {error}");
            }
            Err(_) => {}
        }
        sleep(CHECK_INTERVAL);
    }
}

fn app_name(notification: &UserNotification) -> String {
    let info = notification.AppInfo();
    let display = info.as_ref().ok().and_then(|info| info.DisplayInfo().and_then(|d| d.DisplayName()).ok());
    let model = info.as_ref().ok().and_then(|info| info.AppUserModelId().ok());
    [display, model]
        .into_iter()
        .flatten()
        .map(|name| name.to_string())
        .find(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "Windows".into())
}

fn texts(notification: &UserNotification) -> windows::core::Result<Vec<String>> {
    let binding = notification
        .Notification()?
        .Visual()?
        .GetBinding(&KnownNotificationBindings::ToastGeneric()?)?;
    let mut texts = Vec::new();
    for element in &binding.GetTextElements()? {
        let text = element.Text()?.to_string();
        if !text.is_empty() {
            texts.push(text);
        }
    }
    Ok(texts)
}

fn record(notification: &UserNotification) {
    let app_name = app_name(notification);
    let texts = texts(notification).unwrap_or_default();
    let title = texts.first().cloned().unwrap_or_else(|| app_name.clone());
    let message = texts.get(1..).map(|rest| rest.join(" ")).unwrap_or_default();

    let mut state = STATE.lock().unwrap();
    let entry = Entry {
        id: state.next_id,
        app_name: truncate(&app_name, 200),
        title: truncate(&title, 240),
        message: truncate(&message, 900),
        time: chrono::Local::now().format("%-I:%M %p").to_string(),
    };
    state.next_id += 1;
    state.history.insert(0, entry.clone());
    state.history.truncate(HISTORY_LIMIT);
    drop(state);
    emit("notification", entry);
}

#[tauri::command]
pub fn get_notification_status() -> String {
    STATE.lock().unwrap().access.clone()
}

#[tauri::command]
pub fn get_notification_history() -> Vec<Entry> {
    STATE.lock().unwrap().history.clone()
}

#[tauri::command]
pub fn clear_notification_history() {
    STATE.lock().unwrap().history.clear();
}
