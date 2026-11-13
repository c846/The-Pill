//! Picks the pill's light or dark look from the screen around it: a light pill over dark backdrops and a
//! dark pill over light ones.
//!
//! A thread reads a thin band of screen around the pill's window and averages its brightness. It checks
//! straight away when the foreground window changes, moves or minimizes (see hotkeys.rs) or the pill
//! resizes, and otherwise once every couple of seconds to catch content changing inside a window. Each check
//! copies only that small band, which takes about a millisecond.

use crate::{pill, util::emit};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::Duration;
use windows::Win32::Foundation::RECT;
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC, SelectObject,
    BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, SRCCOPY,
};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, GetWindowRect, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

const POLL_INTERVAL: Duration = Duration::from_secs(2);
/// Windows animate when they open, close and minimize, so a nudge waits for that to finish.
const SETTLE_DELAY: Duration = Duration::from_millis(250);
/// How far around the pill to look, in CSS pixels.
const MARGIN: i32 = 24;
// Linear luminance where the look flips. Black and white text read about equally well near 0.18, and the
// gap between the two keeps in-between backdrops from flipping back and forth.
const DARK_BELOW: f32 = 0.15;
const LIGHT_ABOVE: f32 = 0.22;

static NUDGE: OnceLock<Mutex<mpsc::Sender<()>>> = OnceLock::new();
/// True when the pill should be dark, that is, when the backdrop is light.
static DARK: AtomicBool = AtomicBool::new(false);

fn name(dark: bool) -> &'static str {
    if dark {
        "dark"
    } else {
        "light"
    }
}

pub fn start() {
    let (sender, receiver) = mpsc::channel::<()>();
    if NUDGE.set(Mutex::new(sender)).is_err() {
        return;
    }
    std::thread::Builder::new()
        .name("pill-backdrop".into())
        .spawn(move || {
            let table = linear_table();
            loop {
                match receiver.recv_timeout(POLL_INTERVAL) {
                    Ok(()) => {
                        std::thread::sleep(SETTLE_DELAY);
                        // Nudges that arrived while waiting are covered by this one check.
                        while receiver.try_recv().is_ok() {}
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
                check(&table);
            }
        })
        .expect("could not start the pill's backdrop thread");
}

/// Asks for a check soon, because something on screen probably changed.
pub fn nudge() {
    if let Some(sender) = NUDGE.get() {
        let _ = sender.lock().unwrap().send(());
    }
}

#[tauri::command]
pub fn get_theme() -> &'static str {
    name(DARK.load(Ordering::Relaxed))
}

fn check(table: &[f32; 256]) {
    // Fails while the screen is locked or the band is off screen; the look then stays as it is.
    let Some(luminance) = (unsafe { luminance(table) }) else { return };
    let was_dark = DARK.load(Ordering::Relaxed);
    let dark = if luminance > LIGHT_ABOVE {
        true
    } else if luminance < DARK_BELOW {
        false
    } else {
        was_dark
    };
    if dark != was_dark {
        DARK.store(dark, Ordering::Relaxed);
        emit("theme", name(dark));
    }
}

/// sRGB byte to linear light, worked out once.
fn linear_table() -> [f32; 256] {
    let mut table = [0.0; 256];
    for (value, entry) in table.iter_mut().enumerate() {
        let c = value as f32 / 255.0;
        *entry = if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) };
    }
    table
}

/// Average linear luminance (0 to 1) of the screen in a band around the pill's window, leaving out the
/// window itself so the pill never measures its own glass.
unsafe fn luminance(table: &[f32; 256]) -> Option<f32> {
    let hwnd = pill::hwnd();
    let mut window = RECT::default();
    GetWindowRect(hwnd, &mut window).ok()?;
    let margin = MARGIN * GetDpiForWindow(hwnd).max(96) as i32 / 96;

    let screen_left = GetSystemMetrics(SM_XVIRTUALSCREEN);
    let screen_top = GetSystemMetrics(SM_YVIRTUALSCREEN);
    let left = (window.left - margin).max(screen_left);
    let top = (window.top - margin).max(screen_top);
    let right = (window.right + margin).min(screen_left + GetSystemMetrics(SM_CXVIRTUALSCREEN));
    let bottom = (window.bottom + margin).min(screen_top + GetSystemMetrics(SM_CYVIRTUALSCREEN));
    let (width, height) = (right - left, bottom - top);
    if width <= 0 || height <= 0 {
        return None;
    }

    let screen = GetDC(None);
    if screen.is_invalid() {
        return None;
    }
    let memory = CreateCompatibleDC(Some(screen));
    let info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            // Negative height stores rows top to bottom.
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut bits = std::ptr::null_mut();
    let result = match CreateDIBSection(Some(memory), &info, DIB_RGB_COLORS, &mut bits, None, 0) {
        Ok(bitmap) => {
            let previous = SelectObject(memory, bitmap.into());
            let copied = BitBlt(memory, 0, 0, width, height, Some(screen), left, top, SRCCOPY).is_ok();
            let average = if copied && !bits.is_null() {
                let pixels = std::slice::from_raw_parts(bits as *const u8, (width * height * 4) as usize);
                average(pixels, width, height, &window, left, top, table)
            } else {
                None
            };
            SelectObject(memory, previous);
            let _ = DeleteObject(bitmap.into());
            average
        }
        Err(_) => None,
    };
    let _ = DeleteDC(memory);
    ReleaseDC(None, screen);
    result
}

fn average(pixels: &[u8], width: i32, height: i32, window: &RECT, left: i32, top: i32, table: &[f32; 256]) -> Option<f32> {
    // Every other pixel in each direction is plenty for an average.
    const STEP: usize = 2;
    let mut total = 0.0f32;
    let mut count = 0u32;
    for y in (0..height).step_by(STEP) {
        let screen_y = top + y;
        let row_inside = screen_y >= window.top && screen_y < window.bottom;
        let row = &pixels[(y * width * 4) as usize..((y + 1) * width * 4) as usize];
        for x in (0..width).step_by(STEP) {
            let screen_x = left + x;
            if row_inside && screen_x >= window.left && screen_x < window.right {
                continue;
            }
            let i = x as usize * 4;
            // Pixels are stored blue, green, red.
            total += 0.0722 * table[row[i] as usize] + 0.7152 * table[row[i + 1] as usize] + 0.2126 * table[row[i + 2] as usize];
            count += 1;
        }
    }
    (count > 0).then(|| total / count as f32)
}
