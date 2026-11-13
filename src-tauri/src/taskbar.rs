//! Hides the Windows taskbar and keeps the Start menu shut for as long as the pill is running.
//!
//! - Every taskbar (one per monitor) is hidden, and the screen space it reserved is handed back to apps.
//!   Explorer sometimes shows the taskbar again or restarts; the pill hears both and hides it again.
//! - Pressing the Windows key on its own, or Ctrl+Esc, no longer opens Start. Windows key shortcuts such
//!   as Win+E or Win+Shift+S still work. Alt+Tab and Win+Tab are blocked too, leaving the pill's Alt+Space switcher.
//! - The taskbar comes back when the pill closes, or the watchdog brings it back (see `cleanup.rs`).
//!
//! None of this changes a Windows setting, so restarting Explorer or signing out always brings the
//! taskbar back too.

use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, Ordering};
use windows::core::{w, BOOL, PCWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, MonitorFromWindow, HDC, HMONITOR, MONITORINFO, MONITOR_DEFAULTTONULL,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
    VIRTUAL_KEY, VK_CONTROL, VK_ESCAPE, VK_LWIN, VK_MENU, VK_RWIN, VK_TAB,
};
use windows::Win32::UI::Shell::{SHAppBarMessage, ABM_GETSTATE, ABS_AUTOHIDE, APPBARDATA};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, CreateWindowExW, DefWindowProcW, DispatchMessageW, EnumWindows, FindWindowExW, GetClassNameW,
    GetMessageW, GetWindowRect, GetWindowThreadProcessId, IsWindowVisible, IsZoomed, KillTimer, RegisterClassW,
    RegisterWindowMessageW, SetTimer, SetWindowPos, SetWindowsHookExW, ShowWindowAsync, SystemParametersInfoW,
    CHILDID_SELF, EVENT_OBJECT_SHOW, HC_ACTION, KBDLLHOOKSTRUCT, MSG, OBJID_WINDOW, SPI_SETWORKAREA,
    SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOZORDER, SW_HIDE, SW_SHOWNA, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
    WH_KEYBOARD_LL, WINDOW_EX_STYLE, WINDOW_STYLE, WINEVENT_OUTOFCONTEXT, WM_DISPLAYCHANGE, WM_KEYDOWN,
    WM_SETTINGCHANGE, WM_SYSKEYDOWN, WM_TIMER, WNDCLASSW,
};

/// The main taskbar, and the one on each extra monitor.
const TASKBAR_CLASSES: [PCWSTR; 2] = [w!("Shell_TrayWnd"), w!("Shell_SecondaryTrayWnd")];

/// Marks the keys the pill types itself, so its own keyboard hook lets them through.
const PILL_INPUT: usize = 0x5049_4C4C;
/// A key code Windows leaves unassigned. Pressing it while the Windows key is down stops Start opening.
const MASK_KEY: VIRTUAL_KEY = VIRTUAL_KEY(0xE8);

/// Explorer changes come in bursts, so the pill waits this long for them to settle before hiding again.
const REAPPLY_TIMER: usize = 1;
const REAPPLY_DELAY_MS: u32 = 250;

/// Whether the taskbar should be hidden. Cleared once the pill starts shutting down.
static ACTIVE: AtomicBool = AtomicBool::new(false);
/// The message Explorer broadcasts after it restarts and rebuilds the taskbar.
static TASKBAR_CREATED: AtomicU32 = AtomicU32::new(0);
/// The hook that hears Explorer showing windows, and the Explorer process it watches.
static SHOW_HOOK: AtomicIsize = AtomicIsize::new(0);
static EXPLORER_PID: AtomicU32 = AtomicU32::new(0);

// Keyboard state, touched only on the hook's own thread.
static WIN_HELD: AtomicBool = AtomicBool::new(false);
static WIN_USED: AtomicBool = AtomicBool::new(false);
static ESC_BLOCKED: AtomicBool = AtomicBool::new(false);
static TAB_BLOCKED: AtomicBool = AtomicBool::new(false);

pub fn start() {
    ACTIVE.store(true, Ordering::SeqCst);
    std::thread::Builder::new()
        .name("pill-taskbar".into())
        .spawn(|| unsafe { run() })
        .expect("could not start the pill's taskbar thread");
}

/// Shows the taskbar again and gives back its screen space. Safe to call more than once.
pub fn restore() {
    ACTIVE.store(false, Ordering::SeqCst);
    unsafe {
        for taskbar in taskbars() {
            let _ = ShowWindowAsync(taskbar, SW_SHOWNA);
        }
        set_work_areas(false);
    }
}

unsafe fn run() {
    let instance = match GetModuleHandleW(None) {
        Ok(instance) => instance,
        Err(error) => return eprintln!("Could not hide the taskbar: {error}"),
    };
    let class_name = w!("ThePillTaskbarWindow");
    let class = WNDCLASSW {
        lpfnWndProc: Some(window_proc),
        hInstance: instance.into(),
        lpszClassName: class_name,
        ..Default::default()
    };
    if RegisterClassW(&class) == 0 {
        return eprintln!("Could not hide the taskbar.");
    }
    // A hidden top-level window, because only those hear Explorer restart and screen changes.
    if let Err(error) = CreateWindowExW(
        WINDOW_EX_STYLE::default(),
        class_name,
        w!("The Pill Taskbar"),
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
        return eprintln!("Could not hide the taskbar: {error}");
    }
    TASKBAR_CREATED.store(RegisterWindowMessageW(w!("TaskbarCreated")), Ordering::Relaxed);

    // Windows calls the keyboard hook on this thread, so it must keep pumping messages below.
    if let Err(error) = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), Some(instance.into()), 0) {
        eprintln!("Could not keep the Start menu shut: {error}");
    }

    hide();

    let mut message = MSG::default();
    while GetMessageW(&mut message, None, 0, 0).as_bool() {
        DispatchMessageW(&message);
    }
}

/// Hides every taskbar and makes sure the pill hears if Explorer shows one again. Runs on the taskbar
/// thread only, since the hook it sets calls back there.
unsafe fn hide() {
    if !ACTIVE.load(Ordering::SeqCst) {
        return;
    }
    let taskbars = taskbars();
    for &taskbar in &taskbars {
        let _ = ShowWindowAsync(taskbar, SW_HIDE);
    }
    if let Some(&main) = taskbars.first() {
        watch_explorer(main);
    }
    set_work_areas(true);
}

/// Watches the Explorer process that owns the taskbar for windows being shown. A restarted Explorer is a
/// new process, so the hook moves to it.
unsafe fn watch_explorer(taskbar: HWND) {
    let mut pid = 0;
    GetWindowThreadProcessId(taskbar, Some(&mut pid));
    if pid == 0 || pid == EXPLORER_PID.swap(pid, Ordering::Relaxed) {
        return;
    }
    let old = SHOW_HOOK.swap(0, Ordering::Relaxed);
    if old != 0 {
        let _ = UnhookWinEvent(HWINEVENTHOOK(old as *mut _));
    }
    let hook = SetWinEventHook(EVENT_OBJECT_SHOW, EVENT_OBJECT_SHOW, None, Some(on_show), pid, 0, WINEVENT_OUTOFCONTEXT);
    if hook.is_invalid() {
        EXPLORER_PID.store(0, Ordering::Relaxed);
        return eprintln!("Could not watch the taskbar.");
    }
    SHOW_HOOK.store(hook.0 as isize, Ordering::Relaxed);
}

unsafe extern "system" fn window_proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let explorer_restarted = message != 0 && message == TASKBAR_CREATED.load(Ordering::Relaxed);
    let screen_changed = message == WM_DISPLAYCHANGE
        || (message == WM_SETTINGCHANGE && wparam.0 as u32 == SPI_SETWORKAREA.0);
    if explorer_restarted || screen_changed {
        SetTimer(Some(hwnd), REAPPLY_TIMER, REAPPLY_DELAY_MS, None);
        return LRESULT(0);
    }
    if message == WM_TIMER && wparam.0 == REAPPLY_TIMER {
        let _ = KillTimer(Some(hwnd), REAPPLY_TIMER);
        hide();
        return LRESULT(0);
    }
    DefWindowProcW(hwnd, message, wparam, lparam)
}

/// Explorer showed one of its windows. If it's a taskbar, it goes straight back into hiding.
unsafe extern "system" fn on_show(_: HWINEVENTHOOK, _: u32, hwnd: HWND, object: i32, child: i32, _: u32, _: u32) {
    if ACTIVE.load(Ordering::SeqCst) && object == OBJID_WINDOW.0 && child == CHILDID_SELF as i32 && is_taskbar(hwnd) {
        let _ = ShowWindowAsync(hwnd, SW_HIDE);
    }
}

unsafe fn is_taskbar(hwnd: HWND) -> bool {
    let mut buffer = [0u16; 64];
    let length = GetClassNameW(hwnd, &mut buffer).max(0) as usize;
    let class = &buffer[..length];
    TASKBAR_CLASSES.iter().any(|name| name.as_wide() == class)
}

/// Every taskbar window, the main one first.
unsafe fn taskbars() -> Vec<HWND> {
    let mut found = Vec::new();
    for class in TASKBAR_CLASSES {
        let mut after = None;
        while let Ok(hwnd) = FindWindowExW(None, after, class, PCWSTR::null()) {
            found.push(hwnd);
            after = Some(hwnd);
        }
    }
    found
}

/// Sets each monitor's work area, the part maximized windows fill. Hidden, it's the whole monitor;
/// otherwise it's the monitor minus the taskbar on it, as Explorer would set it.
unsafe fn set_work_areas(hidden: bool) {
    let mut monitors: Vec<HMONITOR> = Vec::new();
    let _ = EnumDisplayMonitors(None, None, Some(collect_monitor), LPARAM(&mut monitors as *mut _ as isize));
    let autohide = {
        let mut data = APPBARDATA {
            cbSize: std::mem::size_of::<APPBARDATA>() as u32,
            ..Default::default()
        };
        SHAppBarMessage(ABM_GETSTATE, &mut data) as u32 & ABS_AUTOHIDE != 0
    };
    let taskbars = taskbars();

    for monitor in monitors {
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            continue;
        }
        let mut work = info.rcMonitor;
        if !hidden && !autohide {
            for &taskbar in &taskbars {
                let mut bar = RECT::default();
                if MonitorFromWindow(taskbar, MONITOR_DEFAULTTONULL) == monitor && GetWindowRect(taskbar, &mut bar).is_ok() {
                    work = without_taskbar(work, bar);
                }
            }
        }
        if work == info.rcWork {
            continue;
        }
        // The change is made quietly. Announcing it would make Explorer recalculate the area around its
        // taskbar, hidden or not, and put the old one straight back. When Explorer does reset it on its
        // own, it announces that, and the pill hides again.
        let quiet = SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0);
        if SystemParametersInfoW(SPI_SETWORKAREA, 0, Some(&mut work as *mut RECT as *mut _), quiet).is_ok() {
            refit_maximized(monitor, info.rcWork, work);
        }
    }
}

/// Windows doesn't resize maximized windows for a quiet work area change, so the pill moves each edge of
/// the maximized windows on that monitor by as much as the work area's edge moved.
unsafe fn refit_maximized(monitor: HMONITOR, old: RECT, new: RECT) {
    let mut windows: Vec<HWND> = Vec::new();
    let _ = EnumWindows(Some(collect_window), LPARAM(&mut windows as *mut _ as isize));
    for hwnd in windows {
        let mut rect = RECT::default();
        if !IsWindowVisible(hwnd).as_bool()
            || !IsZoomed(hwnd).as_bool()
            || MonitorFromWindow(hwnd, MONITOR_DEFAULTTONULL) != monitor
            || GetWindowRect(hwnd, &mut rect).is_err()
        {
            continue;
        }
        let left = rect.left + new.left - old.left;
        let top = rect.top + new.top - old.top;
        let right = rect.right + new.right - old.right;
        let bottom = rect.bottom + new.bottom - old.bottom;
        // Asynchronous, so an app that has stopped responding can't hold the pill up.
        let flags = SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS;
        let _ = SetWindowPos(hwnd, None, left, top, right - left, bottom - top, flags);
    }
}

unsafe extern "system" fn collect_monitor(monitor: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> BOOL {
    let monitors = &mut *(data.0 as *mut Vec<HMONITOR>);
    monitors.push(monitor);
    true.into()
}

unsafe extern "system" fn collect_window(hwnd: HWND, data: LPARAM) -> BOOL {
    let windows = &mut *(data.0 as *mut Vec<HWND>);
    windows.push(hwnd);
    true.into()
}

/// Cuts the taskbar off whichever edge of the area it sits on.
fn without_taskbar(area: RECT, bar: RECT) -> RECT {
    let mut work = area;
    if bar.right - bar.left >= bar.bottom - bar.top {
        if bar.top <= area.top {
            work.top = work.top.max(bar.bottom);
        } else {
            work.bottom = work.bottom.min(bar.top);
        }
    } else if bar.left <= area.left {
        work.left = work.left.max(bar.right);
    } else {
        work.right = work.right.min(bar.left);
    }
    work
}

unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 && ACTIVE.load(Ordering::SeqCst) {
        let key = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
        let pressed = wparam.0 as u32 == WM_KEYDOWN || wparam.0 as u32 == WM_SYSKEYDOWN;
        if key.dwExtraInfo != PILL_INPUT && blocks(VIRTUAL_KEY(key.vkCode as u16), pressed) {
            return LRESULT(1);
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

/// Decides whether a key event is kept from Windows. This runs for every key press on the PC, so it
/// does no more than track a few flags.
unsafe fn blocks(key: VIRTUAL_KEY, pressed: bool) -> bool {
    if key == VK_LWIN || key == VK_RWIN {
        if pressed {
            // Held keys repeat, so only the first press starts a new tap.
            if !WIN_HELD.swap(true, Ordering::Relaxed) {
                WIN_USED.store(false, Ordering::Relaxed);
            }
            return false;
        }
        let tapped_alone = WIN_HELD.swap(false, Ordering::Relaxed) && !WIN_USED.load(Ordering::Relaxed);
        if tapped_alone {
            // Windows opens Start when the key comes back up with nothing pressed in between. The real
            // release is held back and replayed after a key Windows ignores, so Start stays shut.
            release_without_start(key);
            return true;
        }
        return false;
    }
    // Win+Tab (Task View). Windows never sees this Tab, so the Windows key still counts as tapped alone
    // and its release is kept from opening Start like any other bare tap.
    if key == VK_TAB && WIN_HELD.load(Ordering::Relaxed) {
        if pressed {
            TAB_BLOCKED.store(true, Ordering::Relaxed);
            return true;
        }
        if TAB_BLOCKED.swap(false, Ordering::Relaxed) {
            return true;
        }
    }
    if pressed && WIN_HELD.load(Ordering::Relaxed) {
        WIN_USED.store(true, Ordering::Relaxed);
    }
    if key == VK_ESCAPE {
        let ctrl_held = GetAsyncKeyState(VK_CONTROL.0 as i32) < 0;
        if pressed && ctrl_held {
            ESC_BLOCKED.store(true, Ordering::Relaxed);
            return true;
        }
        if !pressed && ESC_BLOCKED.swap(false, Ordering::Relaxed) {
            return true;
        }
    }
    // Alt+Tab, including Alt+Shift+Tab and Ctrl+Alt+Tab. The pill's own switcher is Alt+Space.
    if key == VK_TAB {
        let alt_held = GetAsyncKeyState(VK_MENU.0 as i32) < 0;
        if pressed && alt_held {
            // With Tab gone, letting go of Alt would look like a bare Alt tap, which opens the menu bar in
            // many apps. A key Windows ignores in between stops that.
            if !TAB_BLOCKED.swap(true, Ordering::Relaxed) {
                press_mask_key();
            }
            return true;
        }
        if !pressed && TAB_BLOCKED.swap(false, Ordering::Relaxed) {
            return true;
        }
    }
    false
}

unsafe fn release_without_start(win: VIRTUAL_KEY) {
    send_keys(&[(MASK_KEY, KEYBD_EVENT_FLAGS(0)), (MASK_KEY, KEYEVENTF_KEYUP), (win, KEYEVENTF_KEYUP)]);
}

unsafe fn press_mask_key() {
    send_keys(&[(MASK_KEY, KEYBD_EVENT_FLAGS(0)), (MASK_KEY, KEYEVENTF_KEYUP)]);
}

/// Types keys marked as the pill's own, so its hook lets them through.
unsafe fn send_keys(keys: &[(VIRTUAL_KEY, KEYBD_EVENT_FLAGS)]) {
    let key = |vk, flags| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: PILL_INPUT,
            },
        },
    };
    let inputs: Vec<INPUT> = keys.iter().map(|&(vk, flags)| key(vk, flags)).collect();
    SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
}
