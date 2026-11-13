//! Night light. Windows keeps its on/off state and its settings in two binary "CloudStore" registry
//! values that it watches for changes. Nothing public switches it, so the pill edits those values.
//!
//! A blob reads: 43 42 01 00 0a 02 01 00 2a 06 <timestamp> 2a 2b 0e <payload size> 43 42 01 00 <payload>,
//! where the timestamp is a varint of Unix seconds.

use crate::util::{err, wide};
use crate::worker;
use serde::Serialize;
use std::thread::sleep;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use windows::core::PCWSTR;
use windows::Win32::System::Registry::{RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_BINARY, RRF_RT_REG_BINARY};

const HEADER: [u8; 4] = [0x43, 0x42, 0x01, 0x00];
// Strength runs from 0% at 6500K to 100% at 1200K, matching the slider in Windows Settings.
const COOLEST: f64 = 6500.0;
const WARMEST: f64 = 1200.0;
// How long night light stays off while a new strength is applied. Windows has to notice the off state,
// so writing the two back to back could be skipped over; much longer and the screen visibly flashes.
const PULSE_DELAY: Duration = Duration::from_millis(250);
const STATE: &str = "bluelightreductionstate";
const SETTINGS: &str = "settings";

fn invalid() -> String {
    "Windows returned night light data in an unknown format.".into()
}

fn key(part: &str) -> Vec<u16> {
    wide(&format!(
        "Software\\Microsoft\\Windows\\CurrentVersion\\CloudStore\\Store\\DefaultAccount\\Current\\\
         default$windows.data.bluelightreduction.{part}\\windows.data.bluelightreduction.{part}"
    ))
}

fn read_value(part: &str) -> Option<Vec<u8>> {
    let key = key(part);
    let name = wide("Data");
    unsafe {
        let mut size = 0u32;
        let path = PCWSTR(key.as_ptr());
        let value = PCWSTR(name.as_ptr());
        if RegGetValueW(HKEY_CURRENT_USER, path, value, RRF_RT_REG_BINARY, None, None, Some(&mut size)).is_err() {
            return None;
        }
        let mut data = vec![0u8; size as usize];
        RegGetValueW(
            HKEY_CURRENT_USER,
            path,
            value,
            RRF_RT_REG_BINARY,
            None,
            Some(data.as_mut_ptr().cast()),
            Some(&mut size),
        )
        .ok()
        .ok()?;
        data.truncate(size as usize);
        Some(data)
    }
}

fn write_value(part: &str, data: &[u8]) -> Result<(), String> {
    let key = key(part);
    let name = wide("Data");
    unsafe {
        RegSetKeyValueW(
            HKEY_CURRENT_USER,
            PCWSTR(key.as_ptr()),
            PCWSTR(name.as_ptr()),
            REG_BINARY.0,
            Some(data.as_ptr().cast()),
            data.len() as u32,
        )
        .ok()
        .map_err(err)
    }
}

fn read_varint(data: &[u8], start: usize) -> Result<(u64, usize), String> {
    let mut value = 0u64;
    let mut shift = 0;
    for (index, &byte) in data.iter().enumerate().skip(start) {
        value |= ((byte & 0x7f) as u64) << shift;
        shift += 7;
        if byte < 0x80 {
            return Ok((value, index + 1));
        }
        if shift > 56 {
            break;
        }
    }
    Err(invalid())
}

fn write_varint(mut value: u64) -> Vec<u8> {
    let mut bytes = Vec::new();
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            bytes.push(byte);
            return bytes;
        }
        bytes.push(byte | 0x80);
    }
}

#[derive(Clone)]
struct Blob {
    data: Vec<u8>,
    timestamp: u64,
    size: u8,
    payload_start: usize,
}

impl Blob {
    fn parse(data: Vec<u8>) -> Result<Blob, String> {
        if data.len() < 20 || data[0..4] != HEADER || data[8] != 0x2a || data[9] != 0x06 {
            return Err(invalid());
        }
        let (timestamp, end) = read_varint(&data, 10)?;
        let size_index = end + 3;
        let valid = data.get(end..end + 3) == Some(&[0x2a, 0x2b, 0x0e][..])
            && data.get(size_index).is_some_and(|&size| size < 0x80)
            && data.get(size_index + 1..size_index + 5) == Some(&HEADER[..]);
        if !valid {
            return Err(invalid());
        }
        Ok(Blob { size: data[size_index], payload_start: size_index + 5, timestamp, data })
    }

    fn payload(&self) -> &[u8] {
        &self.data[self.payload_start..]
    }

    fn is_on(&self) -> bool {
        self.payload().starts_with(&[0x10, 0x00])
    }

    /// The same blob with a new payload.
    fn with_payload(&self, payload: &[u8]) -> Result<Vec<u8>, String> {
        let size = self.size as i64 + payload.len() as i64 - self.payload().len() as i64;
        if !(0..0x80).contains(&size) {
            return Err("Could not build the night light change.".into());
        }
        // Windows only applies a change whose timestamp is newer than the last one.
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|t| t.as_secs()).unwrap_or(0);
        let mut data = self.data[..10].to_vec();
        data.extend(write_varint(now.max(self.timestamp + 1)));
        data.extend([0x2a, 0x2b, 0x0e, size as u8]);
        data.extend(HEADER);
        data.extend(payload);
        Ok(data)
    }
}

/// The color temperature is a cf 28 field holding kelvin times two. Windows leaves it out until it is
/// changed. Returns where the field starts and ends, and the kelvin.
fn find_temperature(payload: &[u8]) -> Option<(usize, usize, f64)> {
    (0..payload.len().saturating_sub(2))
        .find(|&i| payload[i] == 0xcf && payload[i + 1] == 0x28)
        .and_then(|i| read_varint(payload, i + 2).ok().map(|(value, end)| (i, end, value as f64 / 2.0)))
}

fn read_blob(part: &str) -> Result<Option<Blob>, String> {
    read_value(part).map(Blob::parse).transpose()
}

#[derive(Serialize)]
pub struct NightLight {
    available: bool,
    enabled: bool,
    strength: Option<u32>,
}

fn get() -> Result<NightLight, String> {
    let Some(state) = read_blob(STATE)? else {
        return Ok(NightLight { available: false, enabled: false, strength: None });
    };
    let temperature = read_blob(SETTINGS)?.and_then(|settings| find_temperature(settings.payload()));
    Ok(NightLight {
        available: true,
        enabled: state.is_on(),
        strength: temperature
            .map(|(_, _, kelvin)| ((COOLEST - kelvin) / (COOLEST - WARMEST) * 100.0).round().clamp(0.0, 100.0) as u32),
    })
}

fn set(enabled: Option<bool>, strength: Option<u32>) -> Result<(), String> {
    let setup_first = || "Set up night light in Windows Settings first.".to_string();
    let state = read_blob(STATE)?;
    let settings = read_blob(SETTINGS)?;
    let mut new_state = None;
    let mut new_settings = None;
    let mut state_after_pulse = None;

    if let Some(enabled) = enabled {
        let state = state.as_ref().ok_or_else(setup_first)?;
        if state.is_on() != enabled {
            let payload = if enabled {
                [&[0x10, 0x00][..], state.payload()].concat()
            } else {
                state.payload()[2..].to_vec()
            };
            new_state = Some(state.with_payload(&payload)?);
        }
    }

    if let Some(strength) = strength {
        let settings = settings.as_ref().ok_or_else(setup_first)?;
        let kelvin = COOLEST - (strength.min(100) as f64 / 100.0) * (COOLEST - WARMEST);
        let field = [&[0xcf, 0x28][..], &write_varint(kelvin.round() as u64 * 2)].concat();
        let payload = settings.payload();
        let new_payload = match find_temperature(payload) {
            Some((start, end, _)) => [&payload[..start], &field, &payload[end..]].concat(),
            None => {
                // A missing temperature goes where Windows writes it, just before the ca 32 field.
                let next = payload.windows(2).position(|pair| pair == [0xca, 0x32]).ok_or_else(invalid)?;
                [&payload[..next], &field, &payload[next..]].concat()
            }
        };
        new_settings = Some(settings.with_payload(&new_payload)?);

        // Windows only reads a saved strength when night light turns on, and rewriting the on state
        // unchanged doesn't count, so while it is on it goes off and straight back on.
        if let (None, Some(state)) = (&new_state, &state) {
            if state.is_on() {
                let off = Blob::parse(state.with_payload(&state.payload()[2..])?)?;
                state_after_pulse = Some(off.with_payload(state.payload())?);
                new_state = Some(off.data);
            }
        }
    }

    if let Some(settings) = new_settings {
        write_value(SETTINGS, &settings)?;
    }
    if let Some(state) = new_state {
        write_value(STATE, &state)?;
    }
    if let Some(state) = state_after_pulse {
        sleep(PULSE_DELAY);
        write_value(STATE, &state)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn get_night_light() -> Result<NightLight, String> {
    worker::call(get).await
}

#[tauri::command]
pub async fn set_night_light(enabled: Option<bool>, strength: Option<u32>) -> Result<NightLight, String> {
    if strength.is_some_and(|strength| strength > 100) {
        return Err("Invalid night light strength.".into());
    }
    worker::call(move || {
        set(enabled, strength)?;
        get()
    })
    .await
}
