// Release builds run without a console window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod apps;
mod audio;
mod backdrop;
mod battery;
mod cleanup;
mod dnd;
mod hotkeys;
mod media;
mod nightlight;
mod notifications;
mod pill;
mod power;
mod previews;
mod switcher;
mod taskbar;
mod util;
mod weather;
mod windows_list;
mod worker;

use tauri::Manager;

fn main() {
    // The pill also runs as small helpers that put Windows back the way it was; those exit here.
    if cleanup::run_helper() {
        return;
    }

    tauri::Builder::default()
        .setup(|app| {
            util::set_app(app.handle().clone());
            worker::start();
            let window = app
                .get_webview_window("pill")
                .ok_or("The pill window is missing from tauri.conf.json.")?;
            pill::init(&window)?;
            hotkeys::start();
            // The watchdog starts before anything it would have to undo.
            cleanup::start_watchdog();
            taskbar::start();
            worker::submit(dnd::enable);
            backdrop::start();
            notifications::start();
            weather::start();
            apps::preload();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pill::set_size,
            backdrop::get_theme,
            audio::get_volume,
            audio::set_volume,
            battery::get_battery,
            media::get_media,
            media::control_media,
            apps::get_apps,
            apps::launch_app,
            windows_list::get_open_windows,
            windows_list::activate_window,
            previews::show_previews,
            previews::hide_previews,
            switcher::switcher_cancel,
            nightlight::get_night_light,
            nightlight::set_night_light,
            power::get_battery_saver,
            power::set_battery_saver,
            power::power_action,
            power::open_settings,
            weather::get_weather,
            weather::refresh_weather,
            weather::set_weather_zip,
            notifications::get_notification_status,
            notifications::get_notification_history,
            notifications::clear_notification_history,
        ])
        .build(tauri::generate_context!())
        .expect("The Pill could not start")
        .run(|_, event| {
            if let tauri::RunEvent::Exit = event {
                cleanup::restore();
            }
        });
}
