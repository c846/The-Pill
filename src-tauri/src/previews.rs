//! Live previews of open windows for the Open apps panel.
//!
//! Windows draws these itself (DWM thumbnails): the pill only says which window goes in which box, and the
//! compositor keeps each preview live on the graphics card. Nothing is captured, copied or encoded, so a
//! placed preview costs the pill nothing, and they all go away when the panel closes.

use crate::{pill, windows_list, worker};
use serde::Deserialize;
use std::ffi::c_void;
use std::sync::Mutex;
use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Dwm::{
    DwmGetWindowAttribute, DwmQueryThumbnailSourceSize, DwmRegisterThumbnail, DwmUnregisterThumbnail,
    DwmUpdateThumbnailProperties, DWMWA_EXTENDED_FRAME_BOUNDS, DWM_THUMBNAIL_PROPERTIES, DWM_TNP_OPACITY,
    DWM_TNP_RECTDESTINATION, DWM_TNP_RECTSOURCE, DWM_TNP_SOURCECLIENTAREAONLY, DWM_TNP_VISIBLE,
};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::WindowsAndMessaging::{GetWindowRect, IsIconic};

/// A minimized window may offer only its title bar, which isn't worth showing; the page shows the app's
/// name instead.
const MIN_SOURCE: (i32, i32) = (96, 64);

/// Where one window's preview goes, in CSS pixels from the page's top-left corner.
#[derive(Deserialize)]
pub struct Slot {
    hwnd: i64,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

// Each shown window and its thumbnail, kept while the panel is open so scrolling only moves them.
static THUMBNAILS: Mutex<Vec<(i64, isize)>> = Mutex::new(Vec::new());

/// Shows the given windows' previews and removes any others. Returns the windows that have one.
fn place(slots: Vec<Slot>) -> Vec<i64> {
    let mut thumbnails = THUMBNAILS.lock().unwrap();
    thumbnails.retain(|&(hwnd, id)| {
        let keep = slots.iter().any(|slot| slot.hwnd == hwnd);
        if !keep {
            unsafe {
                let _ = DwmUnregisterThumbnail(id);
            }
        }
        keep
    });

    let destination = pill::hwnd();
    let dpi = unsafe { GetDpiForWindow(destination) };
    let scale = if dpi == 0 { 1.0 } else { dpi as f64 / 96.0 };
    let mut shown = Vec::new();
    for slot in slots {
        let sizes = [slot.x, slot.y, slot.width, slot.height];
        if sizes.iter().any(|value| !value.is_finite() || value.abs() > 4000.0) || !windows_list::is_listed(slot.hwnd) {
            continue;
        }
        let source = HWND(slot.hwnd as isize as *mut c_void);
        let id = match thumbnails.iter().find(|(hwnd, _)| *hwnd == slot.hwnd) {
            Some(&(_, id)) => id,
            None => match unsafe { DwmRegisterThumbnail(destination, source) } {
                Ok(id) => {
                    thumbnails.push((slot.hwnd, id));
                    id
                }
                Err(_) => continue,
            },
        };
        let target = RECT {
            left: (slot.x * scale).round() as i32,
            top: (slot.y * scale).round() as i32,
            right: ((slot.x + slot.width) * scale).round() as i32,
            bottom: ((slot.y + slot.height) * scale).round() as i32,
        };
        let area = unsafe { visible_area(source, id) };
        let properties = match area {
            Some(area) => DWM_THUMBNAIL_PROPERTIES {
                dwFlags: DWM_TNP_RECTDESTINATION
                    | DWM_TNP_RECTSOURCE
                    | DWM_TNP_VISIBLE
                    | DWM_TNP_OPACITY
                    | DWM_TNP_SOURCECLIENTAREAONLY,
                rcDestination: fit(&area, &target),
                rcSource: area,
                opacity: 255,
                fVisible: BOOL(1),
                fSourceClientAreaOnly: BOOL(0),
            },
            None => DWM_THUMBNAIL_PROPERTIES { dwFlags: DWM_TNP_VISIBLE, fVisible: BOOL(0), ..Default::default() },
        };
        if unsafe { DwmUpdateThumbnailProperties(id, &properties) }.is_ok() && area.is_some() {
            shown.push(slot.hwnd);
        }
    }
    shown
}

/// The part of the window worth showing, in the thumbnail's own pixels. Windows 10 and 11 give windows an
/// invisible border for resizing, which is cut off so the preview fills its box.
unsafe fn visible_area(source: HWND, id: isize) -> Option<RECT> {
    let full = DwmQueryThumbnailSourceSize(id).ok()?;
    if full.cx < MIN_SOURCE.0 || full.cy < MIN_SOURCE.1 {
        return None;
    }
    let whole = RECT { left: 0, top: 0, right: full.cx, bottom: full.cy };
    if IsIconic(source).as_bool() {
        return Some(whole);
    }
    let mut window = RECT::default();
    let mut frame = RECT::default();
    let measured = GetWindowRect(source, &mut window).is_ok()
        && DwmGetWindowAttribute(
            source,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut frame as *mut RECT as *mut c_void,
            std::mem::size_of::<RECT>() as u32,
        )
        .is_ok();
    // An app Windows scales for DPI reports a different size here, and is shown whole rather than cut wrongly.
    if !measured || window.right - window.left != full.cx || window.bottom - window.top != full.cy {
        return Some(whole);
    }
    let area = RECT {
        left: (frame.left - window.left).max(0),
        top: (frame.top - window.top).max(0),
        right: (frame.right - window.left).min(full.cx),
        bottom: (frame.bottom - window.top).min(full.cy),
    };
    Some(if area.right > area.left && area.bottom > area.top { area } else { whole })
}

/// The largest rectangle with the source's shape that fits in the box, centered.
fn fit(source: &RECT, target: &RECT) -> RECT {
    let (source_w, source_h) = ((source.right - source.left) as f64, (source.bottom - source.top) as f64);
    let (target_w, target_h) = ((target.right - target.left) as f64, (target.bottom - target.top) as f64);
    let scale = (target_w / source_w).min(target_h / source_h);
    let (w, h) = ((source_w * scale).round() as i32, (source_h * scale).round() as i32);
    let left = target.left + (target.right - target.left - w) / 2;
    let top = target.top + (target.bottom - target.top - h) / 2;
    RECT { left, top, right: left + w, bottom: top + h }
}

fn clear() {
    for (_, id) in THUMBNAILS.lock().unwrap().drain(..) {
        unsafe {
            let _ = DwmUnregisterThumbnail(id);
        }
    }
}

#[tauri::command]
pub async fn show_previews(slots: Vec<Slot>) -> Result<Vec<i64>, String> {
    worker::call(move || Ok(place(slots))).await
}

/// Runs on the same worker as show_previews, so a hide sent after a show always wins.
#[tauri::command]
pub fn hide_previews() {
    worker::submit(clear);
}
