//! The pill's own window: its size, its place at the top of the screen, and its focus.

use crate::{backdrop, util::err};
use std::sync::atomic::{AtomicIsize, Ordering};
use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTOPRIMARY};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, SetForegroundWindow, SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_SHOWWINDOW,
};

// Window handles can't be shared between threads directly, so the raw number is kept instead.
static PILL: AtomicIsize = AtomicIsize::new(0);

pub fn init(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    PILL.store(window.hwnd()?.0 as isize, Ordering::Relaxed);
    Ok(())
}

pub fn hwnd() -> HWND {
    HWND(PILL.load(Ordering::Relaxed) as *mut _)
}

/// Brings the pill to the front so it gets keyboard input. Windows allows this right after a shortcut.
pub fn focus() {
    unsafe {
        let _ = SetForegroundWindow(hwnd());
    }
}

/// The page reports its size in CSS pixels whenever it changes, and the window is fitted to match,
/// centered at the top of the primary display. Returns whether the mouse is still over the pill, since a
/// window that shrinks out from under a still mouse never hears that the mouse left.
#[tauri::command]
pub fn set_size(width: f64, height: f64) -> Result<bool, String> {
    if !(1.0..=1200.0).contains(&width) || !(1.0..=1200.0).contains(&height) {
        return Err("Invalid pill size.".into());
    }
    unsafe {
        let monitor = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return Err("Could not find the primary display.".into());
        }
        let (mut dpi_x, mut dpi_y) = (96u32, 96u32);
        let _ = GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y);
        let scale = dpi_x as f64 / 96.0;

        let w = (width * scale).ceil() as i32;
        let h = (height * scale).ceil() as i32;
        let area = info.rcMonitor;
        let x = area.left + (area.right - area.left - w) / 2;
        let y = area.top;
        // Reapplying topmost on every resize keeps the pill above other always-on-top windows.
        SetWindowPos(hwnd(), Some(HWND_TOPMOST), x, y, w, h, SWP_NOACTIVATE | SWP_SHOWWINDOW).map_err(err)?;
        // A bigger pill covers different screen, so the look may need to change.
        backdrop::nudge();

        let mut cursor = POINT::default();
        let inside = GetCursorPos(&mut cursor).is_ok()
            && cursor.x >= x
            && cursor.x < x + w
            && cursor.y >= y
            && cursor.y < y + h;
        Ok(inside)
    }
}
