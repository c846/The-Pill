//! Turns on Do Not Disturb while the pill runs, so Windows stops showing its own notification popups and
//! they appear only in the pill. Windows still files every notification in the notification center, which
//! is where the pill reads them from.
//!
//! One gap: old-style tray icon balloons (some driver and utility apps) are never filed there. Windows
//! drops them while Do Not Disturb is on, so the pill doesn't see them either.
//!
//! Windows has no public way to switch Do Not Disturb, so this uses the internal service behind the
//! switch in Windows' notification center. If a Windows update removes it, the pill carries on and
//! Windows shows its popups as usual.
//!
//! The pill only switches Do Not Disturb off again if the pill switched it on. A small file records that,
//! so the watchdog and the installer know too.

#![allow(non_snake_case)]

use crate::util::{err, wide};
use std::path::PathBuf;
use windows::core::{interface, IUnknown, IUnknown_Vtbl, GUID, HRESULT, PCWSTR, PWSTR};
use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_LOCAL_SERVER};

const QUIET_HOURS_SETTINGS: GUID = GUID::from_u128(0xf53321fa_34f8_4b7f_b9a3_361877cb94cf);
const OFF: &str = "Microsoft.QuietHoursProfile.Unrestricted";
const ON: &str = "Microsoft.QuietHoursProfile.PriorityOnly";

// Only the first two methods are used, and they come first.
#[interface("6bff4732-81ec-4ffb-ae67-b6c1bc29631f")]
unsafe trait IQuietHoursSettings: IUnknown {
    fn get_UserSelectedProfile(&self, id: *mut PWSTR) -> HRESULT;
    fn put_UserSelectedProfile(&self, id: PCWSTR) -> HRESULT;
}

/// Switches Do Not Disturb on, unless it already is. Needs COM, so it runs on the worker thread.
pub fn enable() {
    let result = (|| -> Result<(), String> {
        let settings = settings()?;
        if profile(&settings)? != OFF {
            // Already on, by the user or by an earlier pill that never got to switch it back off.
            return Ok(());
        }
        // Written first, so Do Not Disturb is never on without the record that the pill turned it on.
        std::fs::write(marker()?, ON).map_err(err)?;
        set_profile(&settings, ON)
    })();
    if let Err(error) = result {
        eprintln!("Could not turn on Do Not Disturb: {error}");
    }
}

/// Switches Do Not Disturb back off if the pill switched it on. A different setting the user picked in the
/// meantime is left alone.
pub fn restore() {
    let Ok(marker) = marker() else { return };
    if !marker.exists() {
        return;
    }
    crate::util::init_com();
    let result = (|| -> Result<(), String> {
        let settings = settings()?;
        if profile(&settings)? == ON {
            set_profile(&settings, OFF)?;
        }
        Ok(())
    })();
    match result {
        // The record is only removed once nothing is left to undo, so a failed attempt can be retried.
        Ok(()) => {
            let _ = std::fs::remove_file(marker);
        }
        Err(error) => eprintln!("Could not turn Do Not Disturb back off: {error}"),
    }
}

fn settings() -> Result<IQuietHoursSettings, String> {
    unsafe { CoCreateInstance(&QUIET_HOURS_SETTINGS, None, CLSCTX_LOCAL_SERVER) }.map_err(err)
}

fn profile(settings: &IQuietHoursSettings) -> Result<String, String> {
    unsafe {
        let mut id = PWSTR::null();
        settings.get_UserSelectedProfile(&mut id).ok().map_err(err)?;
        let text = id.to_string().map_err(err);
        CoTaskMemFree(Some(id.0 as *const _));
        text
    }
}

fn set_profile(settings: &IQuietHoursSettings, profile: &str) -> Result<(), String> {
    let id = wide(profile);
    unsafe { settings.put_UserSelectedProfile(PCWSTR(id.as_ptr())) }.ok().map_err(err)
}

/// The record that the pill turned Do Not Disturb on. It sits with the pill's other files, found without
/// Tauri so the watchdog and the installer's helper can read it too.
fn marker() -> Result<PathBuf, String> {
    let roaming = std::env::var_os("APPDATA").ok_or("Could not find the app data folder.")?;
    let directory = PathBuf::from(roaming).join("com.thepill.desktop");
    std::fs::create_dir_all(&directory).map_err(err)?;
    Ok(directory.join("do-not-disturb-by-pill"))
}
