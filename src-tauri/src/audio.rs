//! System volume through Windows' Core Audio API.

use crate::util::{emit, err};
use crate::worker;
use serde::Serialize;
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};

const KEY_STEP: i32 = 2;

#[derive(Serialize, Clone, Copy)]
pub struct Volume {
    volume: u32,
    muted: bool,
}

pub enum Key {
    Up,
    Down,
    Mute,
}

/// The default output device can change at any time, so it is looked up again for every request.
fn endpoint() -> windows::core::Result<IAudioEndpointVolume> {
    unsafe {
        let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        // Render devices, console role: the device the Windows volume flyout controls.
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
        device.Activate(CLSCTX_ALL, None)
    }
}

fn read() -> Result<Volume, String> {
    unsafe {
        let endpoint = endpoint().map_err(err)?;
        let level = endpoint.GetMasterVolumeLevelScalar().map_err(err)?;
        let muted = endpoint.GetMute().map_err(err)?.as_bool();
        Ok(Volume { volume: (level * 100.0).round().clamp(0.0, 100.0) as u32, muted })
    }
}

fn write(volume: Option<u32>, muted: Option<bool>) -> Result<(), String> {
    unsafe {
        let endpoint = endpoint().map_err(err)?;
        if let Some(muted) = muted {
            endpoint.SetMute(muted, std::ptr::null()).map_err(err)?;
        }
        if let Some(volume) = volume {
            endpoint
                .SetMasterVolumeLevelScalar(volume.min(100) as f32 / 100.0, std::ptr::null())
                .map_err(err)?;
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn get_volume() -> Result<Volume, String> {
    worker::call(read).await
}

/// Not async on purpose: plain commands run in the order they arrive, so slider moves are queued in order.
#[tauri::command]
pub fn set_volume(volume: u32) -> Result<(), String> {
    if volume > 100 {
        return Err("Invalid volume.".into());
    }
    worker::submit(move || {
        if let Err(error) = write(Some(volume), None) {
            eprintln!("Failed to set the volume: {error}");
        }
    });
    Ok(())
}

/// Handles the keyboard's volume keys and shows the new level on the pill.
pub fn key(key: Key) {
    worker::submit(move || {
        let result = read().and_then(|mut state| {
            match key {
                Key::Mute => {
                    state.muted = !state.muted;
                    write(None, Some(state.muted))?;
                }
                Key::Up | Key::Down => {
                    let step = if matches!(key, Key::Up) { KEY_STEP } else { -KEY_STEP };
                    // Changing the level also unmutes, like the Windows flyout does.
                    let unmute = state.muted.then_some(false);
                    state.volume = (state.volume as i32 + step).clamp(0, 100) as u32;
                    state.muted = false;
                    write(Some(state.volume), unmute)?;
                }
            }
            Ok(state)
        });
        match result {
            Ok(state) => emit("volume", state),
            Err(error) => eprintln!("Failed to change the volume: {error}"),
        }
    });
}
