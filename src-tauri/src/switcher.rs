//! The Alt+Space app switcher. Keep holding Alt and press Space to step through open apps, release Alt to
//! switch, or press Esc to cancel. The whole flow runs here; the page only shows the selected app.

use crate::util::emit;
use crate::{pill, windows_list, worker};
use serde::Serialize;
use std::sync::Mutex;
use std::thread::sleep;
use std::time::Duration;
use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;

const ALT_CHECK_INTERVAL: Duration = Duration::from_millis(30);

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

/// Only runs while the switcher is open.
fn watch_alt(session: u64) {
    loop {
        sleep(ALT_CHECK_INTERVAL);
        {
            let state = STATE.lock().unwrap();
            if !state.active || state.session != session {
                return;
            }
        }
        let alt_down = unsafe { GetAsyncKeyState(0x12) } as u16 & 0x8000 != 0;
        if !alt_down {
            return worker::submit(move || finish(Some(session), true));
        }
    }
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
