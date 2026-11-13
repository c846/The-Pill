//! Weather from weather.gov for a US zip code. Refreshed every 15 minutes and when the PC wakes up; the
//! forecasts themselves only every 30 minutes. The page gets a finished report with text ready to show.

use crate::util::{app, emit, now_ms};
use chrono::{DateTime, Datelike, FixedOffset, Local};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;
use tauri::Manager;

const USER_AGENT: &str = "ThePill (https://github.com/c846/The-Pill)";
const REFRESH_INTERVAL: Duration = Duration::from_secs(15 * 60);
const FORECAST_INTERVAL_MS: i64 = 30 * 60 * 1000;
const OBSERVATION_MAX_AGE_MS: i64 = 2 * 60 * 60 * 1000;
const HOUR_MS: i64 = 60 * 60 * 1000;

// ---- Saved data ----

#[derive(Serialize, Deserialize, Clone)]
struct Location {
    lat: f64,
    lon: f64,
    city: String,
    state: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct Endpoints {
    forecast: String,
    forecast_hourly: String,
    station: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
struct Hour {
    time: String,
    temperature: Option<i32>,
    description: String,
    precipitation: Option<f64>,
    #[serde(default = "daytime")]
    is_daytime: bool,
}

fn daytime() -> bool {
    true
}

#[derive(Serialize, Deserialize, Clone)]
struct Day {
    name: String,
    start: String,
    end: String,
    high: Option<i32>,
    low: Option<i32>,
    description: String,
    precipitation: Option<f64>,
}

#[derive(Serialize, Deserialize, Clone)]
struct Alert {
    event: String,
    severity: String,
    start: Option<String>,
    end: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
struct Current {
    description: String,
    temperature: Option<i32>,
    #[serde(default = "daytime")]
    is_daytime: bool,
}

#[derive(Serialize, Deserialize, Clone)]
struct Saved {
    zip: String,
    location: Location,
    endpoints: Endpoints,
    #[serde(default)]
    hourly: Vec<Hour>,
    #[serde(default)]
    daily: Vec<Day>,
    #[serde(default)]
    alerts: Vec<Alert>,
    #[serde(default)]
    current: Option<Current>,
    #[serde(default)]
    forecast_fetched_at: Option<i64>,
    #[serde(default)]
    updated_at: Option<i64>,
}

struct State {
    saved: Option<Saved>,
    error: Option<String>,
}

static STATE: Mutex<State> = Mutex::new(State { saved: None, error: None });
static REFRESHING: AtomicBool = AtomicBool::new(false);
// Bumped when the zip code changes, so a refresh that started for the old one throws its results away.
static GENERATION: AtomicU64 = AtomicU64::new(0);

static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(15))
        .build()
        .expect("could not set up the weather client")
});
// weather.gov's zip search answers with a redirect, which has to be read rather than followed.
static NO_REDIRECT_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("could not set up the weather client")
});

fn file_path() -> Option<PathBuf> {
    let directory = app()?.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&directory).ok()?;
    Some(directory.join("weather.json"))
}

fn load() {
    let Some(path) = file_path() else { return };
    match std::fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<Saved>(&text) {
            Ok(saved) if is_zip(&saved.zip) => STATE.lock().unwrap().saved = Some(saved),
            _ => eprintln!("Saved weather has an invalid format."),
        },
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            eprintln!("Failed to read saved weather: {error}")
        }
        Err(_) => {}
    }
}

fn save(saved: &Saved) {
    let Some(path) = file_path() else { return };
    match serde_json::to_string(saved) {
        Ok(text) => {
            if let Err(error) = std::fs::write(path, text) {
                eprintln!("Failed to save weather: {error}");
            }
        }
        Err(error) => eprintln!("Failed to save weather: {error}"),
    }
}

fn is_zip(zip: &str) -> bool {
    zip.len() == 5 && zip.bytes().all(|byte| byte.is_ascii_digit())
}

// ---- Fetching ----

struct FetchError {
    message: String,
    status: Option<u16>,
}

async fn fetch_json(url: &str) -> Result<Value, FetchError> {
    let mut last = FetchError { message: "Could not reach weather.gov.".into(), status: None };
    // api.weather.gov regularly returns brief 5xx errors, so those are retried a couple of times.
    for attempt in 0..3u64 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(attempt * 1500)).await;
        }
        let response = match CLIENT.get(url).header("Accept", "application/geo+json").send().await {
            Ok(response) => response,
            Err(_) => {
                last = FetchError { message: "Could not reach weather.gov.".into(), status: None };
                continue;
            }
        };
        let status = response.status().as_u16();
        if response.status().is_success() {
            let bytes = response.bytes().await.map_err(|_| FetchError {
                message: "Could not reach weather.gov.".into(),
                status: None,
            })?;
            return serde_json::from_slice(&bytes).map_err(|_| FetchError {
                message: "weather.gov sent data the pill couldn't read.".into(),
                status: None,
            });
        }
        last = FetchError { message: format!("weather.gov responded with error {status}."), status: Some(status) };
        if status < 500 {
            break;
        }
    }
    Err(last)
}

async fn look_up_zip(zip: &str) -> Result<Location, String> {
    let unknown = || "weather.gov does not recognize that zip code.".to_string();
    let response = NO_REDIRECT_CLIENT
        .get(format!("https://forecast.weather.gov/zipcity.php?inputstring={zip}"))
        .send()
        .await
        .map_err(|_| "Could not reach weather.gov.".to_string())?;
    if !response.status().is_redirection() {
        return Err(unknown());
    }
    // The redirect points at a forecast page whose address holds the coordinates.
    let location = response.headers().get("location").and_then(|value| value.to_str().ok()).ok_or_else(unknown)?;
    let url = reqwest::Url::parse("https://forecast.weather.gov").unwrap().join(location).map_err(|_| unknown())?;
    let query = |name: &str| url.query_pairs().find(|(key, _)| key == name).map(|(_, value)| value.into_owned());
    let lat = query("lat").and_then(|v| v.parse::<f64>().ok()).filter(|v| v.is_finite()).ok_or_else(unknown)?;
    let lon = query("lon").and_then(|v| v.parse::<f64>().ok()).filter(|v| v.is_finite()).ok_or_else(unknown)?;
    Ok(Location { lat, lon, city: query("CityName").unwrap_or_default(), state: query("state").unwrap_or_default() })
}

async fn find_endpoints(location: &Location) -> Result<Endpoints, String> {
    let no_forecast = || "weather.gov has no forecast for that zip code.".to_string();
    let points = fetch_json(&format!("https://api.weather.gov/points/{:.4},{:.4}", location.lat, location.lon))
        .await
        .map_err(|error| if error.status == Some(404) { no_forecast() } else { error.message })?;
    let properties = &points["properties"];
    let forecast = properties["forecast"].as_str().ok_or_else(no_forecast)?.to_string();
    let forecast_hourly = properties["forecastHourly"].as_str().ok_or_else(no_forecast)?.to_string();

    // Without a station, current conditions fall back to the hourly forecast.
    let mut station = None;
    if let Some(stations_url) = properties["observationStations"].as_str() {
        match fetch_json(stations_url).await {
            Ok(stations) => {
                station = stations["features"][0]["properties"]["stationIdentifier"].as_str().map(String::from)
            }
            Err(error) => eprintln!("Failed to load weather stations: {}", error.message),
        }
    }
    Ok(Endpoints { forecast, forecast_hourly, station })
}

// ---- Turning weather.gov's data into the pill's ----

fn parse_time(text: &str) -> Option<DateTime<FixedOffset>> {
    DateTime::parse_from_rfc3339(text).ok()
}

fn time_ms(text: &str) -> Option<i64> {
    parse_time(text).map(|time| time.timestamp_millis())
}

fn temperature(period: &Value) -> Option<i32> {
    let value = period["temperature"].as_f64()?;
    Some(if period["temperatureUnit"] == "C" { value * 9.0 / 5.0 + 32.0 } else { value }.round() as i32)
}

fn precipitation(period: &Value) -> Option<f64> {
    period["probabilityOfPrecipitation"]["value"].as_f64()
}

fn text(value: &Value) -> String {
    value.as_str().unwrap_or_default().to_string()
}

fn periods(result: &Option<Result<Value, FetchError>>) -> Option<&Vec<Value>> {
    match result {
        Some(Ok(value)) => value["properties"]["periods"].as_array(),
        _ => None,
    }
}

fn build_hours(periods: &[Value]) -> Vec<Hour> {
    periods
        .iter()
        .take(60)
        .map(|period| Hour {
            time: text(&period["startTime"]),
            temperature: temperature(period),
            description: text(&period["shortForecast"]),
            precipitation: precipitation(period),
            is_daytime: period["isDaytime"].as_bool().unwrap_or(true),
        })
        .collect()
}

/// The forecast alternates day and night periods, so each night is folded into its day as the low.
fn build_days(periods: &[Value]) -> Vec<Day> {
    let mut days: Vec<Day> = Vec::new();
    for period in periods {
        let is_daytime = period["isDaytime"].as_bool().unwrap_or(true);
        let temperature = temperature(period);
        let precipitation = precipitation(period);
        match days.last_mut() {
            Some(day) if !is_daytime && day.low.is_none() => {
                day.low = temperature;
                day.end = text(&period["endTime"]);
                if let Some(chance) = precipitation {
                    day.precipitation = Some(day.precipitation.unwrap_or(0.0).max(chance));
                }
            }
            _ => days.push(Day {
                name: text(&period["name"]),
                start: text(&period["startTime"]),
                end: text(&period["endTime"]),
                high: if is_daytime { temperature } else { None },
                low: if is_daytime { None } else { temperature },
                description: text(&period["shortForecast"]),
                precipitation,
            }),
        }
    }
    days.truncate(7);
    days
}

fn upcoming(hours: &[Hour]) -> impl Iterator<Item = &Hour> {
    let now = now_ms();
    hours.iter().filter(move |hour| time_ms(&hour.time).is_some_and(|start| start + HOUR_MS > now))
}

fn build_current(observation: Option<&Value>, hours: &[Hour]) -> Option<Current> {
    let next_hour = upcoming(hours).next();
    let properties = observation.map(|observation| &observation["properties"]);
    let fresh = properties
        .and_then(|p| p["timestamp"].as_str())
        .and_then(time_ms)
        .is_some_and(|time| now_ms() - time < OBSERVATION_MAX_AGE_MS);
    let properties = properties.filter(|_| fresh);
    let observed_description = properties.map(|p| text(&p["textDescription"])).filter(|d| !d.is_empty());
    let observed_temperature =
        properties.and_then(|p| p["temperature"]["value"].as_f64()).map(|c| (c * 9.0 / 5.0 + 32.0).round() as i32);

    if observed_description.is_none() && next_hour.is_none() {
        return None;
    }
    // Observation icons read like .../icons/land/night/few, which tells day from night.
    let observed_daytime = properties
        .filter(|_| observed_description.is_some())
        .and_then(|p| p["icon"].as_str())
        .map(|icon| !icon.contains("/night/"));
    Some(Current {
        description: observed_description.or_else(|| next_hour.map(|h| h.description.clone())).unwrap_or_default(),
        temperature: observed_temperature.or_else(|| next_hour.and_then(|h| h.temperature)),
        is_daytime: observed_daytime.or_else(|| next_hour.map(|h| h.is_daytime)).unwrap_or(true),
    })
}

fn build_alerts(value: &Value) -> Option<Vec<Alert>> {
    let features = value["features"].as_array()?;
    Some(
        features
            .iter()
            .map(|feature| &feature["properties"])
            .filter_map(|alert| {
                let time = |a: &str, b: &str| alert[a].as_str().or_else(|| alert[b].as_str()).map(String::from);
                Some(Alert {
                    event: alert["event"].as_str()?.to_string(),
                    severity: text(&alert["severity"]),
                    start: time("onset", "effective"),
                    end: time("ends", "expires"),
                })
            })
            .collect(),
    )
}

// ---- Refreshing ----

async fn optional_fetch(url: Option<String>) -> Option<Result<Value, FetchError>> {
    match url {
        Some(url) => Some(fetch_json(&url).await),
        None => None,
    }
}

async fn refresh(force: bool) {
    let Some(target) = STATE.lock().unwrap().saved.clone() else { return };
    if REFRESHING.swap(true, Ordering::SeqCst) {
        return;
    }
    let generation = GENERATION.load(Ordering::SeqCst);

    let now = now_ms();
    let forecast_due = force || target.forecast_fetched_at.is_none_or(|at| now - at >= FORECAST_INTERVAL_MS);
    let Location { lat, lon, .. } = target.location;
    let (hourly, daily, observation, alerts) = tokio::join!(
        optional_fetch(forecast_due.then(|| target.endpoints.forecast_hourly.clone())),
        optional_fetch(forecast_due.then(|| target.endpoints.forecast.clone())),
        optional_fetch(
            target.endpoints.station.as_ref().map(|s| format!("https://api.weather.gov/stations/{s}/observations/latest"))
        ),
        optional_fetch(Some(format!("https://api.weather.gov/alerts/active?point={lat:.4},{lon:.4}"))),
    );
    REFRESHING.store(false, Ordering::SeqCst);

    // The weather counts as updated if any request worked; the error only shows when they all failed.
    let attempts = [&hourly, &daily, &observation, &alerts];
    let made = attempts.iter().filter(|result| result.is_some()).count();
    let failures: Vec<&FetchError> = attempts
        .iter()
        .filter_map(|result| match result {
            Some(Err(error)) => Some(error),
            _ => None,
        })
        .collect();
    for failure in &failures {
        eprintln!("Failed to refresh weather: {}", failure.message);
    }
    let error = (!failures.is_empty() && failures.len() == made).then(|| failures[0].message.clone());

    let mut state = STATE.lock().unwrap();
    if GENERATION.load(Ordering::SeqCst) != generation {
        return;
    }
    let Some(saved) = state.saved.as_mut() else { return };

    let hourly_periods = periods(&hourly);
    let daily_periods = periods(&daily);
    if let Some(periods) = hourly_periods {
        saved.hourly = build_hours(periods);
    }
    if let Some(periods) = daily_periods {
        saved.daily = build_days(periods);
    }
    if hourly_periods.is_some() && daily_periods.is_some() {
        saved.forecast_fetched_at = Some(now);
    }
    if let Some(Ok(value)) = &alerts {
        if let Some(alerts) = build_alerts(value) {
            saved.alerts = alerts;
        }
    }
    let observed = match &observation {
        Some(Ok(value)) => Some(value),
        _ => None,
    };
    if let Some(current) = build_current(observed, &saved.hourly) {
        saved.current = Some(current);
    }
    if error.is_none() {
        saved.updated_at = Some(now);
    }
    let snapshot = saved.clone();
    state.error = error;
    let report = report(&state);
    drop(state);
    save(&snapshot);
    emit("weather", report);
}

pub fn start() {
    tauri::async_runtime::spawn(async {
        load();
        refresh(false).await;
        loop {
            tokio::time::sleep(REFRESH_INTERVAL).await;
            refresh(false).await;
        }
    });
}

/// Called when the PC wakes up, since the forecast may be hours old by then.
pub fn resume() {
    tauri::async_runtime::spawn(refresh(false));
}

// ---- The report the page shows ----

/// The name of the pill's icon for a forecast, one of the files in ui/icons. Checked in order so the most
/// severe match wins; None when nothing matches.
fn icon(description: &str, is_daytime: bool) -> Option<&'static str> {
    let text = description.to_lowercase();
    let has = |words: &[&str]| words.iter().any(|word| text.contains(word));
    let day_or_night = |day, night| if is_daytime { day } else { night };
    Some(if has(&["tornado", "hurricane", "tropical storm", "blizzard"]) {
        "danger"
    } else if has(&["thunder", "t-storm"]) {
        "thunderstorm"
    } else if has(&["snow", "sleet", "flurr", "ice pellet", "wintry"]) {
        "snowy"
    } else if has(&["rain", "shower", "drizzle"]) {
        "rainy"
    } else if has(&["fog", "haze", "smoke", "dust", "mist"]) {
        "smoggy"
    } else if has(&["cloud", "overcast", "partly sunny"]) {
        day_or_night("cloudy-day", "cloudy-night")
    } else if has(&["sunny", "clear", "fair", "hot", "cold", "wind", "breez"]) {
        day_or_night("clear-day", "clear-night")
    } else {
        return None;
    })
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// "unset" until a zip code is saved, "loading" until the first conditions arrive, then "ready".
    status: &'static str,
    zip: String,
    place: String,
    temperature: Option<i32>,
    description: String,
    icon: Option<&'static str>,
    /// Severe and extreme alerts in effect now.
    alerts: Vec<String>,
    hourly: Vec<HourReport>,
    daily: Vec<DayReport>,
    updated: String,
    error: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct HourReport {
    /// The hour, like "3 PM".
    label: String,
    /// "Today" or the short weekday, so the page can mark where each day starts.
    day: String,
    temperature: Option<i32>,
    description: String,
    icon: Option<&'static str>,
    precipitation: Option<f64>,
}

#[derive(Serialize, Clone)]
pub struct DayReport {
    name: String,
    /// "Today", "Tonight" or the short weekday, for labeling the week's graph.
    short: String,
    high: Option<i32>,
    low: Option<i32>,
    description: String,
    icon: Option<&'static str>,
    precipitation: Option<f64>,
    /// Every alert, of any severity, that overlaps this day.
    notices: Vec<String>,
}

fn report(state: &State) -> Report {
    let Some(saved) = &state.saved else {
        return Report {
            status: "unset",
            zip: String::new(),
            place: String::new(),
            temperature: None,
            description: String::new(),
            icon: None,
            alerts: Vec::new(),
            hourly: Vec::new(),
            daily: Vec::new(),
            updated: String::new(),
            error: state.error.clone(),
        };
    };

    let severe: BTreeSet<String> = saved
        .alerts
        .iter()
        .filter(|alert| alert.severity == "Severe" || alert.severity == "Extreme")
        .map(|alert| alert.event.clone())
        .collect();

    let today = Local::now().date_naive();
    let hourly = upcoming(&saved.hourly)
        .take(48)
        .map(|hour| {
            let local = parse_time(&hour.time).map(|time| time.with_timezone(&Local));
            let label = local.map(|time| time.format("%-I %p").to_string()).unwrap_or_default();
            let day = local
                .map(|time| if time.date_naive() == today { "Today".into() } else { time.format("%a").to_string() })
                .unwrap_or_default();
            HourReport {
                label,
                day,
                temperature: hour.temperature,
                description: hour.description.clone(),
                icon: icon(&hour.description, hour.is_daytime),
                precipitation: hour.precipitation,
            }
        })
        .collect();

    let daily = saved
        .daily
        .iter()
        .map(|day| {
            let (start, end) = (time_ms(&day.start).unwrap_or(i64::MIN), time_ms(&day.end).unwrap_or(i64::MAX));
            let notices: BTreeSet<String> = saved
                .alerts
                .iter()
                .filter(|alert| {
                    alert.start.as_deref().and_then(time_ms).is_none_or(|alert_start| alert_start < end)
                        && alert.end.as_deref().and_then(time_ms).is_none_or(|alert_end| alert_end > start)
                })
                .map(|alert| alert.event.clone())
                .collect();
            let short = parse_time(&day.start)
                .map(|time| time.with_timezone(&Local))
                .map(|time| match (time.date_naive() == today, day.high.is_some()) {
                    (true, true) => "Today".into(),
                    (true, false) => "Tonight".into(),
                    _ => time.format("%a").to_string(),
                })
                .unwrap_or_else(|| day.name.chars().take(3).collect());
            DayReport {
                name: day.name.clone(),
                short,
                high: day.high,
                low: day.low,
                description: day.description.clone(),
                // A day that starts at night, like "Tonight", has no high and gets the night icon.
                icon: icon(&day.description, day.high.is_some()),
                precipitation: day.precipitation,
                notices: notices.into_iter().collect(),
            }
        })
        .collect();

    let place = [&saved.location.city, &saved.location.state]
        .into_iter()
        .filter(|part| !part.is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    let updated = saved
        .updated_at
        .and_then(DateTime::from_timestamp_millis)
        .map(|time| {
            let local = time.with_timezone(&Local);
            let same_day = local.date_naive() == today && local.year() == today.year();
            local.format(if same_day { "Updated %-I:%M %p" } else { "Updated %b %-d, %-I:%M %p" }).to_string()
        })
        .unwrap_or_default();

    Report {
        status: if saved.current.is_some() { "ready" } else { "loading" },
        zip: saved.zip.clone(),
        place,
        temperature: saved.current.as_ref().and_then(|current| current.temperature),
        description: saved.current.as_ref().map(|current| current.description.clone()).unwrap_or_default(),
        icon: saved.current.as_ref().and_then(|current| icon(&current.description, current.is_daytime)),
        alerts: severe.into_iter().collect(),
        hourly,
        daily,
        updated,
        error: state.error.clone(),
    }
}

// ---- Commands ----

#[tauri::command]
pub fn get_weather() -> Report {
    report(&STATE.lock().unwrap())
}

#[tauri::command]
pub async fn refresh_weather() {
    refresh(true).await;
}

#[tauri::command]
pub async fn set_weather_zip(zip: String) -> Result<Report, String> {
    if !is_zip(&zip) {
        return Err("Enter a 5-digit zip code.".into());
    }
    let location = look_up_zip(&zip).await?;
    let endpoints = find_endpoints(&location).await?;
    let saved = Saved {
        zip,
        location,
        endpoints,
        hourly: Vec::new(),
        daily: Vec::new(),
        alerts: Vec::new(),
        current: None,
        forecast_fetched_at: None,
        updated_at: None,
    };
    save(&saved);
    {
        let mut state = STATE.lock().unwrap();
        state.saved = Some(saved);
        state.error = None;
        GENERATION.fetch_add(1, Ordering::SeqCst);
    }
    // A refresh still running for the old zip code would make this one return early.
    while REFRESHING.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    refresh(true).await;
    Ok(get_weather())
}
