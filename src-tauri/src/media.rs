//! Music playing in any Windows app, through the system media transport controls.

use crate::util::err;
use crate::worker;
use serde::Serialize;
use std::cell::RefCell;
use std::time::{SystemTime, UNIX_EPOCH};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as Manager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
};

const TICKS_PER_SECOND: f64 = 10_000_000.0;
// Windows times count 100ns ticks from 1601; Unix time counts from 1970.
const UNIX_EPOCH_TICKS: i64 = 116_444_736_000_000_000;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Media {
    available: bool,
    session_id: String,
    title: String,
    artist: String,
    album: String,
    playing: bool,
    can_seek: bool,
    /// Seconds into the track right now, already moved forward from Windows' last report.
    position: f64,
    duration: f64,
}

thread_local! {
    // Every media request runs on the worker thread, so the manager is fetched once and kept there.
    static MANAGER: RefCell<Option<Manager>> = const { RefCell::new(None) };
}

fn manager() -> windows::core::Result<Manager> {
    MANAGER.with(|cell| {
        if let Some(manager) = cell.borrow().as_ref() {
            return Ok(manager.clone());
        }
        let manager = Manager::RequestAsync()?.join()?;
        *cell.borrow_mut() = Some(manager.clone());
        Ok(manager)
    })
}

fn now_ticks() -> i64 {
    let since_unix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    UNIX_EPOCH_TICKS + (since_unix.as_nanos() / 100) as i64
}

/// The session to show: whichever is playing, or else the one Windows considers current.
fn pick_session(manager: &Manager) -> Option<Session> {
    if let Ok(sessions) = manager.GetSessions() {
        for session in &sessions {
            let playing = session
                .GetPlaybackInfo()
                .and_then(|info| info.PlaybackStatus())
                .is_ok_and(|status| status == Status::Playing);
            if playing {
                return Some(session);
            }
        }
    }
    manager.GetCurrentSession().ok()
}

fn read() -> windows::core::Result<Media> {
    let manager = manager()?;
    let Some(session) = pick_session(&manager) else {
        return Ok(Media::default());
    };
    let properties = session.TryGetMediaPropertiesAsync()?.join()?;
    let playback = session.GetPlaybackInfo()?;
    let timeline = session.GetTimelineProperties()?;

    let playing = playback.PlaybackStatus()? == Status::Playing;
    let rate = playback.PlaybackRate().and_then(|rate| rate.Value()).unwrap_or(1.0);
    let can_seek = playback.Controls().and_then(|c| c.IsPlaybackPositionEnabled()).unwrap_or(false);

    let start = timeline.StartTime()?.Duration;
    let duration = (timeline.EndTime()?.Duration - start) as f64 / TICKS_PER_SECOND;
    let mut position = (timeline.Position()?.Duration - start) as f64 / TICKS_PER_SECOND;
    // Apps only report their position now and then, so add the time played since the last report.
    let updated = timeline.LastUpdatedTime()?.UniversalTime;
    if playing && updated > 0 {
        position += (now_ticks() - updated) as f64 / TICKS_PER_SECOND * rate;
    }
    if duration > 0.0 {
        position = position.clamp(0.0, duration);
    }

    Ok(Media {
        available: true,
        session_id: session.SourceAppUserModelId()?.to_string(),
        title: properties.Title()?.to_string(),
        artist: properties.Artist()?.to_string(),
        album: properties.AlbumTitle()?.to_string(),
        playing,
        can_seek,
        position: position.max(0.0),
        duration: duration.max(0.0),
    })
}

fn control(session_id: &str, action: &str, position: Option<f64>) -> Result<(), String> {
    let manager = manager().map_err(err)?;
    let sessions = manager.GetSessions().map_err(err)?;
    let session = (&sessions)
        .into_iter()
        .find(|session| session.SourceAppUserModelId().is_ok_and(|id| id == session_id))
        .ok_or("The selected media session is no longer available.")?;

    let accepted = match action {
        "toggle" => session.TryTogglePlayPauseAsync().and_then(|op| op.join()),
        "previous" => session.TrySkipPreviousAsync().and_then(|op| op.join()),
        "next" => session.TrySkipNextAsync().and_then(|op| op.join()),
        "seek" => {
            let seconds = position.filter(|p| p.is_finite() && *p >= 0.0).ok_or("Invalid track position.")?;
            let start = session.GetTimelineProperties().and_then(|t| t.StartTime()).map_err(err)?.Duration;
            session
                .TryChangePlaybackPositionAsync(start + (seconds * TICKS_PER_SECOND) as i64)
                .and_then(|op| op.join())
        }
        _ => return Err("Invalid media control action.".into()),
    }
    .map_err(err)?;

    if accepted {
        Ok(())
    } else {
        Err("The media app did not accept the requested control.".into())
    }
}

#[tauri::command]
pub async fn get_media() -> Result<Media, String> {
    worker::call(|| read().map_err(err)).await
}

#[tauri::command]
pub async fn control_media(session_id: String, action: String, position: Option<f64>) -> Result<(), String> {
    worker::call(move || control(&session_id, &action, position)).await
}
