//! The Alt+Space app switcher. Keep holding Alt and press Space to step through open apps, release Alt to
//! switch, or press Esc to cancel. Holding Space down instead opens the Open apps panel, with a live preview
//! of each app, on the selected one. The whole flow runs here; the page only shows the selected app.

use crate::util::emit;
use crate::{pill, windows_list, worker};
use serde::Serialize;
use std::sync::Mutex;
use std::thread::sleep;
use std::time::{Duration, Instant};
use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;

const ALT_CHECK_INTERVAL: Duration = Duration::from_millis(30);
/// Space held this long is a hold rather than a tap.
const HOLD_TIME: Duration = Duration::from_millis(350);
const VK_SPACE: i32 = 0x20;
const VK_MENU: i32 = 0x12;

struct State {
    active: bool,
    windows: Vec<windows_list::OpenWindow>,
    index: usize,
    // Tells an old Alt watcher that its switcher session is over.
    session: u64,
}

static STATE: Mutex<State> = Mutex::new(State { active: false, windows: Vec::new(), index: 0, session: 0 });

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Selection {
    app_name: String,
    title: String,
    position: usize,
    count: usize,
}

fn show(state: &State) {
    let selection = match state.windows.get(state.index) {
        Some(window) => Selection {
            app_name: window.app_name.clone(),
            title: if window.title == window.app_name { String::new() } else { window.title.clone() },
            position: state.index + 1,
            count: state.windows.len(),
        },
        None => Selection { app_name: "No open apps".into(), title: String::new(), position: 0, count: 0 },
    };
    emit("switcher", selection);
}

/// Alt+Space: opens the switcher on the previous app, or moves to the next one.
pub fn step() {
    worker::submit(|| {
        let mut state = STATE.lock().unwrap();
        if state.active {
            if !state.windows.is_empty() {
                state.index = (state.index + 1) % state.windows.len();
            }
            return show(&state);
        }
        // Listed before the pill takes focus, so the first entry is the app the user was in.
        state.windows = windows_list::list();
        state.index = if state.windows.len() > 1 { 1 } else { 0 };
        state.active = true;
        state.session += 1;
        let session = state.session;
        show(&state);
        drop(state);
        // Focus lets the page see Esc.
        pill::focus();
        std::thread::spawn(move || watch_alt(session));
    });
}

fn key_down(key: i32) -> bool {
    unsafe { GetAsyncKeyState(key) as u16 & 0x8000 != 0 }
}

/// Only runs while the switcher is open, watching for Alt to be released or Space to be held.
fn watch_alt(session: u64) {
    // The press that opened the switcher is already down.
    let mut space_since = Some(Instant::now());
    loop {
        sleep(ALT_CHECK_INTERVAL);
        {
            let state = STATE.lock().unwrap();
            if !state.active || state.session != session {
                return;
            }
        }
        if !key_down(VK_MENU) {
            return worker::submit(move || finish(Some(session), true));
        }
        if key_down(VK_SPACE) {
            if space_since.get_or_insert_with(Instant::now).elapsed() >= HOLD_TIME {
                return worker::submit(move || expand(session));
            }
        } else {
            space_since = None;
        }
    }
}

/// Hands over to the Open apps panel, which stays open until an app is picked or it is dismissed.
fn expand(session: u64) {
    let index = {
        let mut state = STATE.lock().unwrap();
        if !state.active || state.session != session {
            return;
        }
        state.active = false;
        state.index
    };
    emit("switcher-expand", index);
}

/// Switches to the selected app, or when cancelled, back to the app the user was in.
fn finish(session: Option<u64>, commit: bool) {
    let target = {
        let mut state = STATE.lock().unwrap();
        if !state.active || session.is_some_and(|session| session != state.session) {
            return;
        }
        state.active = false;
        let index = if commit { state.index } else { 0 };
        state.windows.get(index).map(|window| window.hwnd)
    };
    if let Some(hwnd) = target {
        if !windows_list::activate(hwnd) {
            eprintln!("Windows did not switch to the selected app.");
        }
    }
    emit("switcher-end", ());
}

#[tauri::command]
pub fn switcher_cancel() {
    worker::submit(|| finish(None, false));
}
