//! Open app windows, and switching to one of them.

use crate::util::{err, wide};
use crate::worker;
use serde::Serialize;
use std::collections::HashMap;
use std::ffi::c_void;
use std::path::Path;
use std::sync::{LazyLock, Mutex};
use windows::core::{BOOL, PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{keybd_event, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetForegroundWindow, GetWindow, GetWindowLongW, GetWindowTextLengthW,
    GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, SetForegroundWindow,
    ShowWindow, GWL_EXSTYLE, GW_OWNER, SW_RESTORE, WS_EX_APPWINDOW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OpenWindow {
    pub hwnd: i64,
    pub title: String,
    pub app_name: String,
}

// Only windows from the latest list can be activated, so the page can't poke at arbitrary windows.
static LISTED: Mutex<Vec<i64>> = Mutex::new(Vec::new());
// Reading a program's description means opening its file, so each name is looked up once.
static APP_NAMES: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(Default::default);

struct Search {
    windows: Vec<OpenWindow>,
    own_process: u32,
}

/// Windows in front-to-back order, the same ones Alt+Tab shows.
pub fn list() -> Vec<OpenWindow> {
    let mut search = Search { windows: Vec::new(), own_process: std::process::id() };
    unsafe {
        let _ = EnumWindows(Some(visit), LPARAM(&mut search as *mut Search as isize));
    }
    *LISTED.lock().unwrap() = search.windows.iter().map(|window| window.hwnd).collect();
    search.windows
}

unsafe extern "system" fn visit(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let search = &mut *(lparam.0 as *mut Search);
    if let Some(window) = describe(hwnd, search.own_process) {
        search.windows.push(window);
    }
    BOOL(1)
}

unsafe fn describe(hwnd: HWND, own_process: u32) -> Option<OpenWindow> {
    if !IsWindowVisible(hwnd).as_bool() {
        return None;
    }
    let style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
    let is_app_window = style & WS_EX_APPWINDOW.0 != 0;
    let is_tool = style & (WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0) != 0;
    let has_owner = GetWindow(hwnd, GW_OWNER).is_ok_and(|owner| !owner.is_invalid());
    if !is_app_window && (is_tool || has_owner) {
        return None;
    }
    // Cloaked windows are hidden by Windows itself, like apps on other virtual desktops.
    let mut cloaked = 0u32;
    if DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut c_void, 4).is_ok()
        && cloaked != 0
    {
        return None;
    }
    let title_length = GetWindowTextLengthW(hwnd);
    if title_length <= 0 {
        return None;
    }
    let mut class = [0u16; 256];
    let class_length = GetClassNameW(hwnd, &mut class).max(0) as usize;
    let class_name = String::from_utf16_lossy(&class[..class_length]);
    if class_name == "Progman" {
        return None;
    }
    let mut process = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut process));
    if process == own_process {
        return None;
    }

    let mut title = vec![0u16; title_length as usize + 1];
    let copied = GetWindowTextW(hwnd, &mut title).max(0) as usize;
    let title = String::from_utf16_lossy(&title[..copied]).trim().to_string();
    if title.is_empty() {
        return None;
    }
    // Store apps all run inside ApplicationFrameHost, so their title is the useful name.
    let app_name = if class_name == "ApplicationFrameWindow" { None } else { app_name(process) };
    Some(OpenWindow {
        hwnd: hwnd.0 as i64,
        app_name: app_name.unwrap_or_else(|| title.clone()),
        title,
    })
}

unsafe fn app_name(process: u32) -> Option<String> {
    let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process).ok()?;
    let mut buffer = [0u16; 1024];
    let mut size = buffer.len() as u32;
    let found = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buffer.as_mut_ptr()), &mut size).is_ok();
    let _ = CloseHandle(handle);
    if !found {
        return None;
    }
    let path = String::from_utf16_lossy(&buffer[..size as usize]);

    let mut names = APP_NAMES.lock().unwrap();
    if let Some(name) = names.get(&path) {
        return Some(name.clone());
    }
    let name = file_description(&path)
        .filter(|name| !name.trim().is_empty())
        .or_else(|| Path::new(&path).file_stem().map(|stem| stem.to_string_lossy().into_owned()))?
        .trim()
        .to_string();
    names.insert(path, name.clone());
    Some(name)
}

/// The program's "File description", the friendly name Task Manager shows.
unsafe fn file_description(path: &str) -> Option<String> {
    let path = wide(path);
    let size = GetFileVersionInfoSizeW(PCWSTR(path.as_ptr()), None);
    if size == 0 {
        return None;
    }
    let mut data = vec![0u8; size as usize];
    GetFileVersionInfoW(PCWSTR(path.as_ptr()), None, size, data.as_mut_ptr() as *mut c_void).ok()?;

    let query = |key: &str| -> Option<(*const c_void, u32)> {
        let key = wide(key);
        let mut value: *mut c_void = std::ptr::null_mut();
        let mut length = 0u32;
        VerQueryValueW(data.as_ptr() as *const c_void, PCWSTR(key.as_ptr()), &mut value, &mut length)
            .as_bool()
            .then_some((value as *const c_void, length))
    };

    // Each language the file has strings for, falling back to US English.
    let mut languages = vec![(0x0409u16, 0x04B0u16)];
    if let Some((value, length)) = query("\\VarFileInfo\\Translation") {
        let pairs = std::slice::from_raw_parts(value as *const u16, length as usize / 2);
        languages = pairs.as_chunks::<2>().0.iter().map(|&[language, code_page]| (language, code_page)).chain(languages).collect();
    }
    for (language, code_page) in languages {
        if let Some((value, length)) = query(&format!("\\StringFileInfo\\{language:04x}{code_page:04x}\\FileDescription")) {
            let text = std::slice::from_raw_parts(value as *const u16, length as usize);
            let end = text.iter().position(|&c| c == 0).unwrap_or(text.len());
            return Some(String::from_utf16_lossy(&text[..end]));
        }
    }
    None
}

/// Whether the window was in the latest list, so the page can only point at windows it was shown.
pub fn is_listed(hwnd: i64) -> bool {
    LISTED.lock().unwrap().contains(&hwnd)
}

pub fn activate(handle: i64) -> bool {
    let hwnd = HWND(handle as isize as *mut c_void);
    unsafe {
        if !IsWindow(Some(hwnd)).as_bool() {
            return false;
        }
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        if SetForegroundWindow(hwnd).as_bool() && GetForegroundWindow() == hwnd {
            return true;
        }
        // Windows only lets a process take the foreground after it receives input, so tap Alt first.
        keybd_event(0x12, 0, KEYBD_EVENT_FLAGS(0), 0);
        keybd_event(0x12, 0, KEYEVENTF_KEYUP, 0);
        let _ = SetForegroundWindow(hwnd);
        GetForegroundWindow() == hwnd
    }
}

#[tauri::command]
pub async fn get_open_windows() -> Result<Vec<OpenWindow>, String> {
    worker::call(|| Ok(list())).await
}

#[tauri::command]
pub async fn activate_window(hwnd: i64) -> Result<(), String> {
    if !LISTED.lock().map_err(err)?.contains(&hwnd) {
        return Err("The requested app is no longer available.".into());
    }
    worker::call(move || {
        if activate(hwnd) {
            Ok(())
        } else {
            Err("Windows did not switch to the selected app.".into())
        }
    })
    .await
}
