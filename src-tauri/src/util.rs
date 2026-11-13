//! Small helpers shared by the other modules.

use serde::Serialize;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn set_app(app: AppHandle) {
    let _ = APP.set(app);
}

pub fn app() -> Option<&'static AppHandle> {
    APP.get()
}

/// Sends an event to the pill's web page.
pub fn emit<T: Serialize + Clone>(event: &str, payload: T) {
    if let Some(app) = APP.get() {
        if let Err(error) = app.emit(event, payload) {
            eprintln!("Failed to send {event} to the pill: {error}");
        }
    }
}

/// Turns any error into the plain message the web page shows.
pub fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

/// A null-terminated UTF-16 string for Windows APIs.
pub fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Every thread that talks to COM must join an apartment first. Calling this twice is harmless.
pub fn init_com() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|time| time.as_millis() as i64)
        .unwrap_or(0)
}

/// Shortens text to at most `max` characters without splitting a character.
pub fn truncate(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}
