//! Screen brightness through WMI, the same interface the laptop's brightness keys and Windows Settings use.
//!
//! The brightness keys never reach apps (the laptop's firmware handles them), so the pill can't take them
//! over the way it does the volume keys. Instead it listens for Windows' "brightness changed" event and shows
//! the new level. Only built-in screens report a brightness; on other PCs the brightness tile is turned off.

use crate::util::{emit, init_com};
use crate::worker;
use serde::Serialize;
use std::cell::RefCell;
use std::mem::ManuallyDrop;
use std::sync::atomic::{AtomicI32, Ordering};
use std::time::Duration;
use windows::core::{w, Error, BSTR, HRESULT, PCWSTR};
use windows::Win32::System::Com::{
    CoCreateInstance, CoSetProxyBlanket, CoTaskMemFree, CLSCTX_INPROC_SERVER, EOAC_NONE, RPC_C_AUTHN_LEVEL_CALL,
    RPC_C_IMP_LEVEL_IMPERSONATE,
};
use windows::Win32::System::Rpc::{RPC_C_AUTHN_WINNT, RPC_C_AUTHZ_NONE};
use windows::Win32::System::Variant::{
    VariantClear, VariantToStringAlloc, VariantToUInt32, VARENUM, VARIANT, VARIANT_0, VARIANT_0_0, VARIANT_0_0_0,
    VT_I4, VT_UI1,
};
use windows::Win32::System::Wmi::{
    IEnumWbemClassObject, IWbemClassObject, IWbemLocator, IWbemServices, WbemLocator, WBEM_E_NOT_FOUND,
    WBEM_FLAG_FORWARD_ONLY, WBEM_FLAG_RETURN_IMMEDIATELY, WBEM_GENERIC_FLAG_TYPE, WBEM_INFINITE,
};

/// How long the watcher waits before listening again after WMI drops it (the WMI service restarted).
const RETRY_DELAY: Duration = Duration::from_secs(10);

#[derive(Serialize, Clone, Copy)]
pub struct Brightness {
    brightness: u32,
}

/// The last level the pill saw, so an event that repeats it doesn't flash the bar again.
static LAST: AtomicI32 = AtomicI32::new(-1);
/// The newest level the slider asked for, or -1. A dragged slider sends far more levels than WMI can set,
/// so only the latest one waiting is applied.
static PENDING: AtomicI32 = AtomicI32::new(-1);

struct Connection {
    services: IWbemServices,
    /// The screen's WmiMonitorBrightnessMethods object and a filled-in argument list for WmiSetBrightness,
    /// looked up on the first change.
    setter: Option<(BSTR, IWbemClassObject)>,
}

// Lives on the worker thread, where every read and write runs.
thread_local! {
    static CONNECTION: RefCell<Option<Connection>> = const { RefCell::new(None) };
}

fn not_found() -> Error {
    Error::from_hresult(HRESULT(WBEM_E_NOT_FOUND.0))
}

unsafe fn connect() -> windows::core::Result<IWbemServices> {
    let locator: IWbemLocator = CoCreateInstance(&WbemLocator, None, CLSCTX_INPROC_SERVER)?;
    let none = BSTR::new();
    let services = locator.ConnectServer(&BSTR::from("ROOT\\WMI"), &none, &none, &none, 0, &none, None)?;
    CoSetProxyBlanket(
        &services,
        RPC_C_AUTHN_WINNT,
        RPC_C_AUTHZ_NONE,
        PCWSTR::null(),
        RPC_C_AUTHN_LEVEL_CALL,
        RPC_C_IMP_LEVEL_IMPERSONATE,
        None,
        EOAC_NONE,
    )?;
    Ok(services)
}

unsafe fn query(services: &IWbemServices, wql: &str) -> windows::core::Result<IEnumWbemClassObject> {
    let flags = WBEM_GENERIC_FLAG_TYPE(WBEM_FLAG_FORWARD_ONLY.0 | WBEM_FLAG_RETURN_IMMEDIATELY.0);
    services.ExecQuery(&BSTR::from("WQL"), &BSTR::from(wql), flags, None)
}

/// The next object from a query, waiting for it if needed. None once the query has no more.
unsafe fn next(objects: &IEnumWbemClassObject) -> windows::core::Result<Option<IWbemClassObject>> {
    let mut found = [None];
    let mut count = 0;
    objects.Next(WBEM_INFINITE, &mut found, &mut count).ok()?;
    Ok(found[0].take())
}

unsafe fn number(object: &IWbemClassObject, name: PCWSTR) -> windows::core::Result<u32> {
    let mut value = VARIANT::default();
    object.Get(name, 0, &mut value, None, None)?;
    let number = VariantToUInt32(&value);
    let _ = VariantClear(&mut value);
    number
}

unsafe fn text(object: &IWbemClassObject, name: PCWSTR) -> windows::core::Result<BSTR> {
    let mut value = VARIANT::default();
    object.Get(name, 0, &mut value, None, None)?;
    let buffer = VariantToStringAlloc(&value);
    let _ = VariantClear(&mut value);
    let buffer = buffer?;
    let text = BSTR::from_wide(buffer.as_wide());
    CoTaskMemFree(Some(buffer.0 as *const _));
    Ok(text)
}

fn variant(vt: VARENUM, value: VARIANT_0_0_0) -> VARIANT {
    VARIANT {
        Anonymous: VARIANT_0 {
            Anonymous: ManuallyDrop::new(VARIANT_0_0 { vt, Anonymous: value, ..Default::default() }),
        },
    }
}

unsafe fn read_level(connection: &mut Connection) -> windows::core::Result<u32> {
    let screens = query(&connection.services, "SELECT CurrentBrightness FROM WmiMonitorBrightness WHERE Active = TRUE")?;
    let screen = next(&screens)?.ok_or_else(not_found)?;
    number(&screen, w!("CurrentBrightness"))
}

unsafe fn write_level(connection: &mut Connection, level: u32) -> windows::core::Result<()> {
    if connection.setter.is_none() {
        let screens = query(&connection.services, "SELECT __PATH FROM WmiMonitorBrightnessMethods WHERE Active = TRUE")?;
        let screen = next(&screens)?.ok_or_else(not_found)?;
        let path = text(&screen, w!("__PATH"))?;

        let mut class = None;
        connection.services.GetObject(
            &BSTR::from("WmiMonitorBrightnessMethods"),
            WBEM_GENERIC_FLAG_TYPE(0),
            None,
            Some(&mut class),
            None,
        )?;
        let mut signature = None;
        class.ok_or_else(not_found)?.GetMethod(w!("WmiSetBrightness"), 0, &mut signature, std::ptr::null_mut())?;
        let arguments = signature.ok_or_else(not_found)?.SpawnInstance(0)?;
        // Timeout 0: keep the level until something else changes it.
        arguments.Put(w!("Timeout"), 0, &variant(VT_I4, VARIANT_0_0_0 { lVal: 0 }), 0)?;
        connection.setter = Some((path, arguments));
    }
    let (path, arguments) = connection.setter.as_ref().ok_or_else(not_found)?;
    arguments.Put(w!("Brightness"), 0, &variant(VT_UI1, VARIANT_0_0_0 { bVal: level.min(100) as u8 }), 0)?;
    connection.services.ExecMethod(
        path,
        &BSTR::from("WmiSetBrightness"),
        WBEM_GENERIC_FLAG_TYPE(0),
        None,
        arguments,
        None,
        None,
    )
}

/// Runs a request on the worker thread's WMI connection. A connection can go stale if the WMI service
/// restarts, so a failed request is tried once more on a fresh one.
fn with_connection<T>(job: impl Fn(&mut Connection) -> windows::core::Result<T>) -> windows::core::Result<T> {
    CONNECTION.with(|cell| {
        let mut cell = cell.borrow_mut();
        let attempt =|cell: &mut Option<Connection>| {
            if cell.is_none() {
                *cell = Some(Connection { services: unsafe { connect()? }, setter: None });
            }
            job(cell.as_mut().ok_or_else(not_found)?)
        };
        attempt(&mut cell).or_else(|_| {
            *cell = None;
            attempt(&mut cell)
        })
    })
}

/// None when the screen's brightness can't be read, which means the brightness tile is turned off.
#[tauri::command]
pub async fn get_brightness() -> Result<Option<Brightness>, String> {
    worker::call(|| {
        let level = with_connection(|connection| unsafe { read_level(connection) }).ok();
        if let Some(level) = level {
            LAST.store(level as i32, Ordering::SeqCst);
        }
        Ok(level.map(|brightness| Brightness { brightness }))
    })
    .await
}

/// Not async on purpose, like set_volume: slider moves arrive in order.
#[tauri::command]
pub fn set_brightness(brightness: u32) -> Result<(), String> {
    if brightness > 100 {
        return Err("Invalid brightness.".into());
    }
    // Only queue a job when none is waiting; a waiting one picks up the newest level when it runs.
    if PENDING.swap(brightness as i32, Ordering::SeqCst) == -1 {
        worker::submit(|| {
            let level = PENDING.swap(-1, Ordering::SeqCst);
            if level >= 0 {
                if let Err(error) = with_connection(|connection| unsafe { write_level(connection, level as u32) }) {
                    eprintln!("Failed to set the brightness: {error}");
                }
            }
        });
    }
    Ok(())
}

/// Listens for brightness changes on a thread of its own, which sleeps inside WMI until one arrives.
pub fn start() {
    let spawned = std::thread::Builder::new().name("pill-brightness".into()).spawn(|| {
        init_com();
        loop {
            // Subscribing fails straight away on PCs that have no brightness to watch; give up then.
            let events = match unsafe { subscribe() } {
                Ok(events) => events,
                Err(error) => return eprintln!("Not watching the screen brightness: {error}"),
            };
            if let Err(error) = unsafe { listen(&events) } {
                eprintln!("Stopped hearing brightness changes, listening again shortly: {error}");
            }
            std::thread::sleep(RETRY_DELAY);
        }
    });
    if let Err(error) = spawned {
        eprintln!("Could not watch the screen brightness: {error}");
    }
}

unsafe fn subscribe() -> windows::core::Result<IEnumWbemClassObject> {
    let services = connect()?;
    let flags = WBEM_GENERIC_FLAG_TYPE(WBEM_FLAG_FORWARD_ONLY.0 | WBEM_FLAG_RETURN_IMMEDIATELY.0);
    services.ExecNotificationQuery(
        &BSTR::from("WQL"),
        &BSTR::from("SELECT * FROM WmiMonitorBrightnessEvent"),
        flags,
        None,
    )
}

unsafe fn listen(events: &IEnumWbemClassObject) -> windows::core::Result<()> {
    loop {
        // An event query never runs out while it's healthy, so an empty answer means it was dropped.
        let event = next(events)?.ok_or_else(not_found)?;
        let level = number(&event, w!("Brightness"))?.min(100);
        if LAST.swap(level as i32, Ordering::SeqCst) != level as i32 {
            emit("brightness", Brightness { brightness: level });
        }
    }
}
