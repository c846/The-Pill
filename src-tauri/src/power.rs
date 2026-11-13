//! Battery saver, lock/shut down/restart, and opening Windows Settings.

use crate::util::{err, wide};
use crate::worker;
use std::ffi::c_void;
use std::os::windows::process::CommandExt;
use std::process::Command;
use windows::core::PCWSTR;
use windows::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD};
use windows::Win32::System::Shutdown::LockWorkStation;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// Energy saver has no public switch. Quick Settings publishes this undocumented WNF state (1 on, 2 off),
// and Windows mirrors the result into EnergySaverState, which is readable without admin rights.
const ENERGY_SAVER_STATE_NAME: u64 = 0x41C6_013D_A3BC_3075;

#[link(name = "ntdll")]
extern "system" {
    fn RtlPublishWnfStateData(
        state_name: u64,
        type_id: *const c_void,
        buffer: *const c_void,
        length: u32,
        explicit_scope: *const c_void,
    ) -> i32;
}

/// None on Windows builds without energy saver.
fn read_battery_saver() -> Option<bool> {
    let key = wide("SYSTEM\\CurrentControlSet\\Control\\Power");
    let name = wide("EnergySaverState");
    let mut value = 0u32;
    let mut size = 4u32;
    let found = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            PCWSTR(key.as_ptr()),
            PCWSTR(name.as_ptr()),
            RRF_RT_REG_DWORD,
            None,
            Some(&mut value as *mut u32 as *mut c_void),
            Some(&mut size),
        )
    }
    .is_ok();
    match (found, value) {
        (true, 1) => Some(true),
        (true, 2) => Some(false),
        _ => None,
    }
}

#[tauri::command]
pub async fn get_battery_saver() -> Result<Option<bool>, String> {
    worker::call(|| Ok(read_battery_saver())).await
}

#[tauri::command]
pub async fn set_battery_saver(on: bool) -> Result<(), String> {
    worker::call(move || {
        let data: u32 = if on { 1 } else { 2 };
        let status = unsafe {
            RtlPublishWnfStateData(
                ENERGY_SAVER_STATE_NAME,
                std::ptr::null(),
                &data as *const u32 as *const c_void,
                4,
                std::ptr::null(),
            )
        };
        if status == 0 {
            Ok(())
        } else {
            Err("Windows did not accept the battery saver change.".into())
        }
    })
    .await
}

#[tauri::command]
pub fn power_action(action: String) -> Result<(), String> {
    let arguments = match action.as_str() {
        "lock" => return unsafe { LockWorkStation() }.map_err(err),
        "shutdown" => ["/s", "/t", "0"],
        "restart" => ["/r", "/t", "0"],
        _ => return Err("Invalid power request.".into()),
    };
    Command::new("shutdown.exe")
        .args(arguments)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(err)
}

#[tauri::command]
pub fn open_settings(page: String) -> Result<(), String> {
    let uri = match page.as_str() {
        "windows" => "ms-settings:",
        "notifications" => "ms-settings:privacy-notifications",
        _ => return Err("Unknown settings page.".into()),
    };
    Command::new("explorer.exe").arg(uri).spawn().map(|_| ()).map_err(err)
}
