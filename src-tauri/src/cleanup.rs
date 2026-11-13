//! Puts Windows back the way the pill found it: the taskbar, and Do Not Disturb.
//!
//! This happens when the pill closes. A second, tiny copy of the pill (the watchdog) waits in the
//! background and does it if the pill is ended without a chance to clean up (a crash or Task Manager).
//! The installer runs it too, since it closes every copy of the pill, the watchdog included.
//!
//! During development, `npm run dev` can end the watchdog along with the pill when it restarts the pill.
//! The new pill takes over, but if the rebuild fails nothing does; `the-pill.exe --restore` puts things
//! back by hand.

use crate::{dnd, taskbar};
use std::os::windows::process::CommandExt;
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Threading::{
    CreateMutexW, OpenMutexW, OpenProcess, WaitForSingleObject, INFINITE, PROCESS_SYNCHRONIZE,
    SYNCHRONIZATION_SYNCHRONIZE,
};

/// Command-line modes for the helper copies of the pill.
const LAUNCHER_FLAG: &str = "--start-watchdog";
const WATCHDOG_FLAG: &str = "--watchdog";
const RESTORE_FLAG: &str = "--restore";

/// Exists for as long as any pill is running. Windows removes it when the last pill ends, however it ends.
const RUNNING: PCWSTR = w!("Local\\ThePillIsRunning");

pub fn restore() {
    taskbar::restore();
    dnd::restore();
}

/// Runs a helper mode if the pill was started as one, and returns whether it did. Helpers do their job
/// and exit without opening the pill.
pub fn run_helper() -> bool {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some(RESTORE_FLAG) => {
            restore();
            true
        }
        Some(LAUNCHER_FLAG) => {
            if let Some(pid) = args.next() {
                spawn_helper(&[WATCHDOG_FLAG, &pid]);
            }
            true
        }
        Some(WATCHDOG_FLAG) => {
            if let Some(pid) = args.next().and_then(|pid| pid.parse().ok()) {
                wait_for_exit(pid);
            }
            // A pill that started in the meantime (a quick restart) has taken over, and undoing its
            // changes would leave it running without them.
            if !pill_running() {
                restore();
            }
            true
        }
        _ => false,
    }
}

/// Starts a copy of the pill that waits for this one to end, then restores everything.
pub fn start_watchdog() {
    // The handle is kept open until the pill ends, so the marker lives exactly as long as the pill.
    if let Err(error) = unsafe { CreateMutexW(None, false, RUNNING) } {
        eprintln!("Could not mark the pill as running: {error}");
    }
    // Ending a process tree in Task Manager ends every process the pill started. So the pill starts a
    // launcher that starts the watchdog and exits straight away, which leaves the watchdog outside the
    // pill's tree.
    spawn_helper(&[LAUNCHER_FLAG, &std::process::id().to_string()]);
}

fn spawn_helper(args: &[&str]) {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // Leaves any job the pill was started in, so whatever ends the pill doesn't end the watchdog too.
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;

    let exe = match std::env::current_exe() {
        Ok(exe) => exe,
        Err(error) => return eprintln!("Could not start the watchdog: {error}"),
    };
    let spawn = |flags| std::process::Command::new(&exe).args(args).creation_flags(flags).spawn();
    // Breaking away fails when the job doesn't allow it, so it tries again without.
    if let Err(error) = spawn(CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB).or_else(|_| spawn(CREATE_NO_WINDOW)) {
        eprintln!("Could not start the watchdog: {error}");
    }
}

fn pill_running() -> bool {
    match unsafe { OpenMutexW(SYNCHRONIZATION_SYNCHRONIZE, false, RUNNING) } {
        Ok(handle) => {
            let _ = unsafe { CloseHandle(handle) };
            true
        }
        Err(_) => false,
    }
}

fn wait_for_exit(pid: u32) {
    unsafe {
        // If the pill is already gone this fails, and everything is restored straight away.
        if let Ok(process) = OpenProcess(PROCESS_SYNCHRONIZE, false, pid) {
            WaitForSingleObject(process, INFINITE);
            let _ = CloseHandle(process);
        }
    }
}
