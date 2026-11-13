//! Battery charge, pushed to the pill when Windows reports a change instead of being checked on a timer.

use crate::util::emit;
use serde::Serialize;
use std::sync::Mutex;
use windows::Win32::Foundation::{HANDLE, HWND};
use windows::Win32::System::Power::{GetSystemPowerStatus, RegisterPowerSettingNotification, SYSTEM_POWER_STATUS};
use windows::Win32::System::SystemServices::{GUID_ACDC_POWER_SOURCE, GUID_BATTERY_PERCENTAGE_REMAINING};
use windows::Win32::UI::WindowsAndMessaging::DEVICE_NOTIFY_WINDOW_HANDLE;

#[derive(Serialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Battery {
    percentage: u8,
    is_charging: bool,
}

static LAST: Mutex<Option<Battery>> = Mutex::new(None);

/// None on PCs without a battery.
fn read() -> Option<Battery> {
    let mut status = SYSTEM_POWER_STATUS::default();
    unsafe { GetSystemPowerStatus(&mut status) }.ok()?;
    // 128 means no battery, 255 means Windows doesn't know.
    if status.BatteryFlag == 255 || status.BatteryFlag & 128 != 0 || status.BatteryLifePercent > 100 {
        return None;
    }
    Some(Battery {
        percentage: status.BatteryLifePercent,
        is_charging: status.BatteryFlag & 8 != 0 && status.ACLineStatus == 1,
    })
}

#[tauri::command]
pub fn get_battery() -> Option<Battery> {
    let battery = read();
    *LAST.lock().unwrap() = battery;
    battery
}

/// Asks Windows to tell the message window when the charge or the power source changes.
pub fn watch(hwnd: HWND) {
    for setting in [GUID_ACDC_POWER_SOURCE, GUID_BATTERY_PERCENTAGE_REMAINING] {
        if let Err(error) =
            unsafe { RegisterPowerSettingNotification(HANDLE(hwnd.0), &setting, DEVICE_NOTIFY_WINDOW_HANDLE) }
        {
            eprintln!("Could not watch the battery: {error}");
        }
    }
}

pub fn changed() {
    let battery = read();
    let mut last = LAST.lock().unwrap();
    if *last != battery {
        *last = battery;
        emit("battery", battery);
    }
}
