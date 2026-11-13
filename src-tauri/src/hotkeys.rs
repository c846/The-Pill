//! Global shortcuts and power events.
//!
//! A hidden window on its own thread receives both. The thread sleeps inside GetMessage until Windows has
//! something for it, so it costs nothing while the pill is idle.

use crate::{audio, battery, pill, switcher, util::emit, weather, worker};
use windows::core::w;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, HOT_KEY_MODIFIERS, MOD_ALT, MOD_NOREPEAT};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW, MSG, WINDOW_EX_STYLE,
    WINDOW_STYLE, WM_HOTKEY, WM_POWERBROADCAST, WNDCLASSW,
};

const ALT_W: i32 = 1;
const ALT_Q: i32 = 2;
const ALT_SPACE: i32 = 3;
const VOLUME_MUTE: i32 = 4;
const VOLUME_DOWN: i32 = 5;
const VOLUME_UP: i32 = 6;

const PBT_APMRESUMEAUTOMATIC: u32 = 0x12;
const PBT_POWERSETTINGCHANGE: u32 = 0x8013;

pub fn start() {
    std::thread::Builder::new()
        .name("pill-hotkeys".into())
        .spawn(|| unsafe { run() })
        .expect("could not start the pill's shortcut thread");
}

unsafe fn run() {
    let instance = match GetModuleHandleW(None) {
        Ok(instance) => instance,
        Err(error) => return eprintln!("Could not set up shortcuts: {error}"),
    };
    let class_name = w!("ThePillMessageWindow");
    let class = WNDCLASSW {
        lpfnWndProc: Some(window_proc),
        hInstance: instance.into(),
        lpszClassName: class_name,
        ..Default::default()
    };
    if RegisterClassW(&class) == 0 {
        return eprintln!("Could not set up shortcuts.");
    }
    // A plain hidden top-level window rather than a message-only one, because only top-level windows
    // hear that the PC woke from sleep.
    let hwnd = match CreateWindowExW(
        WINDOW_EX_STYLE::default(),
        class_name,
        w!("The Pill"),
        WINDOW_STYLE::default(),
        0,
        0,
        0,
        0,
        None,
        None,
        Some(instance.into()),
        None,
    ) {
        Ok(hwnd) => hwnd,
        Err(error) => return eprintln!("Could not set up shortcuts: {error}"),
    };

    let none = HOT_KEY_MODIFIERS(0);
    // Registering the volume keys keeps them from Windows, which hides its own volume flyout. They repeat
    // while held; the rest fire once per press.
    let hotkeys = [
        (ALT_W, MOD_ALT | MOD_NOREPEAT, 0x57, "Alt+W"),
        (ALT_Q, MOD_ALT | MOD_NOREPEAT, 0x51, "Alt+Q"),
        (ALT_SPACE, MOD_ALT | MOD_NOREPEAT, 0x20, "Alt+Space"),
        (VOLUME_MUTE, MOD_NOREPEAT, 0xAD, "Volume Mute"),
        (VOLUME_DOWN, none, 0xAE, "Volume Down"),
        (VOLUME_UP, none, 0xAF, "Volume Up"),
    ];
    for (id, modifiers, key, name) in hotkeys {
        if let Err(error) = RegisterHotKey(Some(hwnd), id, modifiers, key) {
            eprintln!("Could not register the {name} shortcut: {error}");
        }
    }
    battery::watch(hwnd);

    let mut message = MSG::default();
    while GetMessageW(&mut message, None, 0, 0).as_bool() {
        DispatchMessageW(&message);
    }
}

unsafe extern "system" fn window_proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match message {
        WM_HOTKEY => {
            on_hotkey(wparam.0 as i32);
            LRESULT(0)
        }
        WM_POWERBROADCAST => {
            match wparam.0 as u32 {
                PBT_POWERSETTINGCHANGE => battery::changed(),
                PBT_APMRESUMEAUTOMATIC => weather::resume(),
                _ => {}
            }
            LRESULT(1)
        }
        _ => DefWindowProcW(hwnd, message, wparam, lparam),
    }
}

fn on_hotkey(id: i32) {
    match id {
        ALT_W => emit("shortcut", "toggle-idle"),
        ALT_Q => worker::submit(|| {
            pill::focus();
            emit("shortcut", "open-apps");
        }),
        ALT_SPACE => switcher::step(),
        VOLUME_MUTE => audio::key(audio::Key::Mute),
        VOLUME_DOWN => audio::key(audio::Key::Down),
        VOLUME_UP => audio::key(audio::Key::Up),
        _ => {}
    }
}
