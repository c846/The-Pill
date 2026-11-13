'use strict';

// The page only shows things and passes clicks on. Everything that talks to Windows lives in Rust
// (src-tauri/src), reached through `invoke` and the events it sends.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const COLLAPSE_DELAY = 250;
const TOAST_DURATION = 5500;
const VOLUME_FLASH_DURATION = 1500;
// After a seek, apps take a moment to report their new position, so the slider waits before following.
const SEEK_SETTLE_DELAY = 2500;
const POWER_CONFIRM_DURATION = 4000;

const pill = $('#pill');

// Everything the pill is showing. render() turns this into the page.
const ui = {
  hover: false,
  panel: null, // music, apps, running, weather, center or settings
  view: 'grid', // the Pill Center page: grid, volume, nightlight, power or notifications
  keyboard: false, // opened from a shortcut, so it stays open without the mouse
  switcher: null,
  volumeFlash: null,
  toast: null,
  idleHidden: false,
};

// ---- Saved preferences ----

function loadJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.error(`Could not save ${key}:`, error);
  }
}

const OPTION_NAMES = {
  music: 'Music',
  weather: 'Weather',
  apps: 'Apps',
  running: 'Open apps',
  date: 'Date',
  time: 'Time',
  battery: 'Battery',
};
const options = Object.fromEntries(Object.keys(OPTION_NAMES).map((key) => [key, true]));
for (const [key, value] of Object.entries(loadJson('pill-options', {}))) {
  if (key in options && typeof value === 'boolean') {
    options[key] = value;
  }
}
let favorites = loadJson('pill-favorite-apps', []);
if (!Array.isArray(favorites)) {
  favorites = [];
}
favorites = favorites.filter((id) => typeof id === 'string');

// ---- Showing and sizing ----

function isPinned() {
  const typing = document.hasFocus() && document.activeElement?.matches('input[type="text"], input[type="search"]');
  return Boolean(ui.keyboard || ui.switcher || ui.toast || ui.volumeFlash || typing);
}

function render() {
  const expanded = Boolean(ui.hover || ui.panel || isPinned());
  pill.classList.toggle('collapsed', !expanded);
  pill.classList.toggle('idle-hidden', ui.idleHidden);

  const showMain = !ui.toast;
  $('#toast').hidden = !ui.toast;
  $('#bar').hidden = !showMain || Boolean(ui.switcher);
  $('#switcher').hidden = !showMain || !ui.switcher;
  $('#volume-flash').hidden = !showMain || !ui.volumeFlash || Boolean(ui.switcher);
  for (const panel of $$('.panel')) {
    panel.hidden = !showMain || Boolean(ui.switcher) || panel.dataset.panel !== ui.panel;
  }
  for (const view of $$('[data-view]')) {
    view.hidden = view.dataset.view !== ui.view;
  }
  for (const button of $$('[data-open]')) {
    button.setAttribute('aria-pressed', String(button.dataset.open === ui.panel));
  }
  for (const element of $$('[data-option]')) {
    element.hidden = !options[element.dataset.option];
  }
}

// The window is fitted to the pill whenever the pill's size changes.
let lastSize = '';
new ResizeObserver(() => {
  const { width, height } = pill.getBoundingClientRect();
  const size = `${width}x${height}`;
  if (size === lastSize) {
    return;
  }
  lastSize = size;
  invoke('set_size', { width, height })
    .then((mouseInside) => {
      // A window that shrinks away from a still mouse is never told the mouse left.
      if (!mouseInside && ui.hover) {
        ui.hover = false;
        scheduleCollapse();
      }
    })
    .catch((error) => console.error('Could not resize the pill:', error));
}).observe(pill);

let collapseTimer;
function scheduleCollapse() {
  clearTimeout(collapseTimer);
  collapseTimer = setTimeout(() => {
    if (!ui.hover && !isPinned()) {
      closeAll();
    } else {
      render();
    }
  }, COLLAPSE_DELAY);
}

function closeAll() {
  ui.keyboard = false;
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
  openPanel(null);
}

document.addEventListener('mouseover', () => {
  clearTimeout(collapseTimer);
  if (!ui.hover) {
    ui.hover = true;
    render();
  }
});
document.documentElement.addEventListener('mouseleave', () => {
  ui.hover = false;
  scheduleCollapse();
});
window.addEventListener('blur', () => {
  ui.keyboard = false;
  scheduleCollapse();
});
document.addEventListener('contextmenu', (event) => event.preventDefault());
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') {
    return;
  }
  if (ui.switcher) {
    invoke('switcher_cancel');
  } else {
    closeAll();
  }
});

function openPanel(name) {
  if (ui.panel === 'music' && name !== 'music') {
    stopMusic();
  }
  ui.panel = name;
  ui.view = 'grid';
  clearPowerConfirm();
  if (name !== 'apps') {
    ui.keyboard = false;
  }
  if (name === 'music') {
    startMusic();
  } else if (name === 'apps') {
    showApps();
  } else if (name === 'running') {
    showRunning();
  } else if (name === 'weather') {
    renderWeather();
  } else if (name === 'center') {
    refreshCenter();
  } else if (name === 'settings') {
    renderSettings();
  }
  render();
}

for (const button of $$('[data-open]')) {
  button.addEventListener('click', () => openPanel(ui.panel === button.dataset.open ? null : button.dataset.open));
}
$('#bar').addEventListener('contextmenu', () => openPanel(ui.panel === 'settings' ? null : 'settings'));

// ---- Clock and battery ----

function updateClock() {
  const now = new Date();
  $('#bar-time').textContent = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  $('#bar-date').textContent = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  // Wakes once a minute, just after the minute changes.
  setTimeout(updateClock, (60 - now.getSeconds()) * 1000 - now.getMilliseconds() + 50);
}

function showBattery(battery) {
  $('#bar-battery').textContent = battery
    ? `${battery.percentage}%${battery.isCharging ? ' charging' : ''}`
    : '';
}

// ---- Toasts ----

const toastQueue = [];
let toastTimer;

function enqueueToast(toast) {
  toastQueue.push(toast);
  if (!ui.toast) {
    nextToast();
  }
}

function nextToast() {
  clearTimeout(toastTimer);
  ui.toast = toastQueue.shift() || null;
  if (ui.toast) {
    $('#toast-app').textContent = ui.toast.appName || 'Windows';
    $('#toast-title').textContent = ui.toast.title || '';
    $('#toast-message').textContent = ui.toast.message || '';
    $('#toast-settings').hidden = ui.toast.kind !== 'settings';
    // The settings prompt waits for the user; real notifications go away on their own.
    if (ui.toast.kind !== 'settings') {
      toastTimer = setTimeout(nextToast, TOAST_DURATION);
    }
  }
  render();
  if (!ui.toast) {
    scheduleCollapse();
  }
}

$('#toast-close').addEventListener('click', nextToast);
$('#toast-settings').addEventListener('click', () => {
  invoke('open_settings', { page: 'notifications' }).catch(console.error);
  nextToast();
});

// ---- Notifications ----

let unreadNotifications = false;

function handleNotificationAccess(access) {
  const needsSettings = access === 'Denied' || access === 'Unspecified';
  const isSettingsToast = (toast) => toast?.kind === 'settings';
  if (needsSettings) {
    if (!isSettingsToast(ui.toast) && !toastQueue.some(isSettingsToast)) {
      enqueueToast({
        kind: 'settings',
        appName: 'The Pill',
        title: 'Notifications are off',
        message: 'Allow The Pill to read your notifications so it can show them.',
      });
    }
    return;
  }
  for (let index = toastQueue.length - 1; index >= 0; index -= 1) {
    if (isSettingsToast(toastQueue[index])) {
      toastQueue.splice(index, 1);
    }
  }
  if (isSettingsToast(ui.toast)) {
    nextToast();
  }
}

function showNotification(entry) {
  const viewing = ui.panel === 'center' && ui.view === 'notifications';
  unreadNotifications = !viewing;
  if (viewing) {
    showNotificationHistory();
  }
  updateNotificationTile();
  enqueueToast({ kind: 'notification', ...entry });
}

function updateNotificationTile() {
  $('#tile-notifications').textContent = unreadNotifications ? 'Notifications (new)' : 'Notifications';
}

async function showNotificationHistory() {
  unreadNotifications = false;
  updateNotificationTile();
  const history = await invoke('get_notification_history');
  $('#notifications-list').replaceChildren(...history.map((entry) => {
    const item = document.createElement('div');
    item.className = 'item notification';
    const heading = document.createElement('div');
    heading.className = 'dim';
    heading.textContent = `${entry.appName} · ${entry.time}`;
    const title = document.createElement('strong');
    title.textContent = entry.title;
    const message = document.createElement('div');
    message.textContent = entry.message;
    item.append(heading, title, message);
    return item;
  }));
  $('#notifications-empty').hidden = history.length > 0;
  $('#notifications-clear').disabled = history.length === 0;
}

$('#notifications-clear').addEventListener('click', async () => {
  await invoke('clear_notification_history');
  showNotificationHistory();
});

// ---- Volume ----

let volumeFlashTimer;
function showVolume({ volume, muted }) {
  ui.volumeFlash = { volume, muted };
  $('#volume-flash-bar').value = muted ? 0 : volume;
  $('#volume-flash-value').textContent = muted ? 'Muted' : `${volume}%`;
  if (ui.panel === 'center' && ui.view === 'volume') {
    showCenterVolume(volume);
  }
  clearTimeout(volumeFlashTimer);
  volumeFlashTimer = setTimeout(() => {
    ui.volumeFlash = null;
    render();
    scheduleCollapse();
  }, VOLUME_FLASH_DURATION);
  render();
}

function showCenterVolume(volume) {
  $('#center-volume').value = volume;
  $('#center-volume-value').textContent = `${volume}%`;
}

$('#center-volume').addEventListener('input', (event) => {
  const volume = Number(event.target.value);
  $('#center-volume-value').textContent = `${volume}%`;
  invoke('set_volume', { volume }).catch(console.error);
});

// ---- App switcher (Alt+Space) ----

function showSwitcher(selection) {
  ui.switcher = selection;
  $('#switcher-app').textContent = selection.appName;
  $('#switcher-title').textContent = selection.title;
  $('#switcher-count').textContent = selection.count > 1 ? `${selection.position} of ${selection.count}` : '';
  render();
}

// ---- Music ----

let music = null;
let musicTimer;
let seekDragging = false;
let seekSettlesAt = 0;

function startMusic() {
  refreshMusic();
  // The only repeating work while a panel is open, and it stops when the panel closes.
  musicTimer = setInterval(refreshMusic, 1000);
}

function stopMusic() {
  clearInterval(musicTimer);
  musicTimer = undefined;
}

async function refreshMusic() {
  try {
    music = await invoke('get_media');
    $('#music-status').textContent = '';
  } catch (error) {
    music = null;
    $('#music-status').textContent = String(error);
  }
  renderMusic();
}

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

function renderMusic() {
  const session = music?.available ? music : null;
  $('#music-title').textContent = session ? session.title || 'Unknown title' : 'Nothing playing';
  $('#music-artist').textContent = session ? [session.artist, session.album].filter(Boolean).join(' · ') : '';
  for (const id of ['#music-previous', '#music-toggle', '#music-next']) {
    $(id).disabled = !session;
  }
  $('#music-toggle').textContent = session?.playing ? 'Pause' : 'Play';

  const seek = $('#music-seek');
  const hasTimeline = Boolean(session && session.duration > 0);
  seek.disabled = !hasTimeline || !session.canSeek;
  if (!seekDragging && Date.now() > seekSettlesAt) {
    seek.max = hasTimeline ? session.duration : 1;
    seek.value = hasTimeline ? session.position : 0;
  }
  $('#music-time').textContent = hasTimeline
    ? `${formatTime(Number(seek.value))} / ${formatTime(session.duration)}`
    : '--:-- / --:--';
}

async function controlMusic(action, position = null) {
  if (!music?.available) {
    return;
  }
  try {
    await invoke('control_media', { sessionId: music.sessionId, action, position });
  } catch (error) {
    $('#music-status').textContent = String(error);
  }
  refreshMusic();
}

$('#music-previous').addEventListener('click', () => controlMusic('previous'));
$('#music-toggle').addEventListener('click', () => controlMusic('toggle'));
$('#music-next').addEventListener('click', () => controlMusic('next'));
$('#music-seek').addEventListener('pointerdown', () => {
  seekDragging = true;
});
$('#music-seek').addEventListener('input', () => renderMusic());
$('#music-seek').addEventListener('change', (event) => {
  seekDragging = false;
  seekSettlesAt = Date.now() + SEEK_SETTLE_DELAY;
  controlMusic('seek', Number(event.target.value));
});

// ---- Apps ----

let apps = [];

async function showApps() {
  renderApps();
  try {
    apps = await invoke('get_apps');
    renderApps();
  } catch (error) {
    $('#apps-hint').hidden = false;
    $('#apps-hint').textContent = String(error);
  }
}

function openAppsSearch() {
  if (ui.toast) {
    return;
  }
  ui.keyboard = true;
  openPanel('apps');
  ui.keyboard = true;
  const search = $('#apps-search');
  search.value = '';
  renderApps();
  search.focus();
}

function matchingApps() {
  const query = $('#apps-search').value.trim().toLocaleLowerCase();
  return query ? apps.filter((app) => app.name.toLocaleLowerCase().includes(query)) : apps;
}

function appButton(app, onRightClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = app.name;
  button.title = app.name;
  button.addEventListener('click', () => launchApp(app.appId));
  button.addEventListener('contextmenu', (event) => {
    event.stopPropagation();
    onRightClick();
  });
  return button;
}

function renderApps() {
  const searching = $('#apps-search').value.trim() !== '';
  const favoriteApps = favorites.map((id) => apps.find((app) => app.appId === id)).filter(Boolean);
  $('#apps-favorites').hidden = searching || favoriteApps.length === 0;
  $('#apps-favorites').replaceChildren(...favoriteApps.map((app) => appButton(app, () => {
    favorites = favorites.filter((id) => id !== app.appId);
    saveJson('pill-favorite-apps', favorites);
    renderApps();
  })));
  $('#apps-hint').textContent = 'Right-click an app to add it to favorites.';
  $('#apps-hint').hidden = searching || favoriteApps.length > 0;
  $('#apps-list').replaceChildren(...matchingApps().map((app) => appButton(app, () => {
    if (!favorites.includes(app.appId)) {
      favorites.push(app.appId);
      saveJson('pill-favorite-apps', favorites);
      renderApps();
    }
  })));
}

async function launchApp(appId) {
  try {
    await invoke('launch_app', { appId });
    closeAll();
  } catch (error) {
    $('#apps-hint').hidden = false;
    $('#apps-hint').textContent = String(error);
  }
}

$('#apps-search').addEventListener('input', renderApps);
$('#apps-search').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    const [first] = matchingApps();
    if (first) {
      launchApp(first.appId);
    }
  }
});

// ---- Open apps ----

async function showRunning() {
  try {
    const windows = await invoke('get_open_windows');
    $('#running-list').replaceChildren(...windows.map((window) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = window.title === window.appName ? window.appName : `${window.appName} · ${window.title}`;
      button.title = window.title;
      button.addEventListener('click', async () => {
        try {
          await invoke('activate_window', { hwnd: window.hwnd });
          closeAll();
        } catch (error) {
          console.error('Could not switch apps:', error);
          showRunning();
        }
      });
      return button;
    }));
    $('#running-empty').hidden = windows.length > 0;
  } catch (error) {
    $('#running-list').replaceChildren();
    $('#running-empty').hidden = false;
    $('#running-empty').textContent = String(error);
  }
}

// ---- Weather ----

let weather = { status: 'unset' };

function degrees(value) {
  return value === null || value === undefined ? '--' : `${value}°`;
}

function showWeather(report) {
  weather = report;
  let text = '';
  if (report.status === 'ready') {
    text = report.temperature !== null ? degrees(report.temperature) : report.description;
    if (report.alerts.length > 0) {
      text = `Alert · ${text}`;
    }
  }
  $('#bar-weather').textContent = text;
  if (ui.panel === 'weather') {
    renderWeather();
  }
  if (ui.panel === 'center') {
    updateWeatherTile();
  }
}

function listItem(text) {
  const item = document.createElement('div');
  item.className = 'item';
  item.textContent = text;
  return item;
}

function chance(precipitation) {
  return precipitation ? ` · ${Math.round(precipitation)}% precip.` : '';
}

function renderWeather() {
  const ready = weather.status === 'ready';
  $('#weather-zip-form').hidden = weather.status !== 'unset';
  $('#weather-body').hidden = !ready;
  $('#weather-status').textContent = weather.error || (weather.status === 'loading' ? 'Loading weather…' : '');
  if (!ready) {
    return;
  }
  $('#weather-now').textContent = [degrees(weather.temperature), weather.description].filter(Boolean).join(' ');
  $('#weather-place').textContent = weather.place || weather.zip;
  $('#weather-alerts').hidden = weather.alerts.length === 0;
  $('#weather-alerts').textContent = weather.alerts.join(', ');
  $('#weather-updated').textContent = weather.updated;
  $('#weather-hourly').replaceChildren(...weather.hourly.map((hour) => listItem(
    `${hour.label} · ${degrees(hour.temperature)} · ${hour.description}${chance(hour.precipitation)}`,
  )));
  $('#weather-daily').replaceChildren(...weather.daily.map((day) => {
    const range = [day.high, day.low].filter((value) => value !== null).map(degrees).join(' / ');
    const notices = day.notices.length > 0 ? ` · ${day.notices.join(', ')}` : '';
    const item = listItem(`${day.name} · ${range} · ${day.description}${chance(day.precipitation)}${notices}`);
    item.title = item.textContent;
    item.classList.toggle('alert', day.notices.length > 0);
    return item;
  }));
}

async function saveZip(input, status) {
  status.textContent = 'Looking up the zip code…';
  try {
    showWeather(await invoke('set_weather_zip', { zip: input.value.trim() }));
    status.textContent = '';
    input.value = '';
    input.blur();
    return true;
  } catch (error) {
    status.textContent = String(error);
    return false;
  }
}

$('#weather-zip-form').addEventListener('submit', (event) => {
  event.preventDefault();
  saveZip($('#weather-zip'), $('#weather-status')).then(() => renderWeather());
});
$('#weather-refresh').addEventListener('click', async () => {
  $('#weather-updated').textContent = 'Refreshing…';
  await invoke('refresh_weather');
  showWeather(await invoke('get_weather'));
});

// ---- Pill Center ----

let batterySaver = null;
let nightLight = null;
let powerConfirm = null;
let powerConfirmTimer;

function showView(view) {
  ui.view = view;
  clearPowerConfirm();
  render();
}

function refreshCenter() {
  updateWeatherTile();
  updateNotificationTile();
  updateSaverTile();
}

function updateWeatherTile() {
  $('[data-tile="weather"]').textContent = weather.status === 'ready' && weather.temperature !== null
    ? `Weather ${degrees(weather.temperature)}`
    : 'Weather';
}

async function updateSaverTile() {
  try {
    batterySaver = await invoke('get_battery_saver');
  } catch {
    batterySaver = null;
  }
  const tile = $('#tile-saver');
  tile.disabled = batterySaver === null;
  tile.setAttribute('aria-pressed', String(batterySaver === true));
  tile.textContent = batterySaver === null ? 'Battery saver' : `Battery saver ${batterySaver ? 'on' : 'off'}`;
}

const tileActions = {
  weather: () => openPanel('weather'),
  volume: async () => {
    showView('volume');
    try {
      showCenterVolume((await invoke('get_volume')).volume);
    } catch (error) {
      $('#center-volume-value').textContent = String(error);
    }
  },
  nightlight: () => {
    showView('nightlight');
    loadNightLight(invoke('get_night_light'));
  },
  saver: async () => {
    if (batterySaver === null) {
      return;
    }
    try {
      await invoke('set_battery_saver', { on: !batterySaver });
    } catch (error) {
      console.error('Could not switch battery saver:', error);
    }
    // Windows takes a moment to apply it.
    setTimeout(updateSaverTile, 500);
  },
  settings: () => {
    invoke('open_settings', { page: 'windows' }).catch(console.error);
    closeAll();
  },
  power: () => showView('power'),
  notifications: () => {
    showView('notifications');
    showNotificationHistory();
  },
};

for (const tile of $$('[data-tile]')) {
  tile.addEventListener('click', () => tileActions[tile.dataset.tile]());
}
for (const back of $$('.back')) {
  back.addEventListener('click', () => showView('grid'));
}

async function loadNightLight(request) {
  const status = $('#nightlight-status');
  try {
    nightLight = await request;
    status.textContent = nightLight.available ? '' : 'Set up night light in Windows Settings first.';
  } catch (error) {
    status.textContent = String(error);
  }
  if (!nightLight) {
    return;
  }
  const toggle = $('#nightlight-toggle');
  toggle.disabled = !nightLight.available;
  toggle.textContent = nightLight.enabled ? 'On' : 'Off';
  toggle.setAttribute('aria-pressed', String(nightLight.enabled));
  const slider = $('#nightlight-strength');
  slider.disabled = !nightLight.available;
  if (nightLight.strength !== null) {
    slider.value = nightLight.strength;
  }
  $('#nightlight-value').textContent = nightLight.strength === null ? '--%' : `${nightLight.strength}%`;
}

$('#nightlight-toggle').addEventListener('click', () => {
  loadNightLight(invoke('set_night_light', { enabled: !nightLight?.enabled, strength: null }));
});
$('#nightlight-strength').addEventListener('input', (event) => {
  $('#nightlight-value').textContent = `${event.target.value}%`;
});
// Only on release: each change briefly turns night light off and on to apply it.
$('#nightlight-strength').addEventListener('change', (event) => {
  loadNightLight(invoke('set_night_light', { enabled: null, strength: Number(event.target.value) }));
});

const POWER_LABELS = { lock: 'Lock', shutdown: 'Shut down', restart: 'Restart' };

function clearPowerConfirm() {
  clearTimeout(powerConfirmTimer);
  powerConfirm = null;
  for (const button of $$('[data-power]')) {
    button.textContent = POWER_LABELS[button.dataset.power];
  }
}

// Shutting down and restarting can lose work, so they take a second click.
for (const button of $$('[data-power]')) {
  button.addEventListener('click', async () => {
    const action = button.dataset.power;
    if (action !== 'lock' && powerConfirm !== action) {
      clearPowerConfirm();
      powerConfirm = action;
      button.textContent = `Click again to ${POWER_LABELS[action].toLowerCase()}`;
      powerConfirmTimer = setTimeout(clearPowerConfirm, POWER_CONFIRM_DURATION);
      return;
    }
    clearPowerConfirm();
    try {
      await invoke('power_action', { action });
      closeAll();
    } catch (error) {
      console.error(`Could not ${action}:`, error);
    }
  });
}

// ---- Pill settings (right-click) ----

function renderSettings() {
  $('#settings-options').replaceChildren(...Object.entries(OPTION_NAMES).map(([key, name]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `${options[key] ? 'Shown' : 'Hidden'} · ${name}`;
    button.setAttribute('aria-pressed', String(options[key]));
    button.addEventListener('click', () => {
      options[key] = !options[key];
      saveJson('pill-options', options);
      renderSettings();
      render();
    });
    return button;
  }));
  $('#settings-zip').placeholder = weather.zip || 'Zip code';
  $('#settings-status').textContent = '';
}

$('#settings-zip-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (await saveZip($('#settings-zip'), $('#settings-status'))) {
    $('#settings-status').textContent = 'Saved.';
    $('#settings-zip').placeholder = weather.zip;
  }
});

// ---- Start ----

async function start() {
  updateClock();
  render();
  // Listen first so nothing sent during startup is missed.
  await Promise.all([
    listen('shortcut', ({ payload }) => {
      if (payload === 'toggle-idle') {
        ui.idleHidden = !ui.idleHidden;
        render();
      } else if (payload === 'open-apps') {
        openAppsSearch();
      }
    }),
    listen('volume', ({ payload }) => showVolume(payload)),
    listen('battery', ({ payload }) => showBattery(payload)),
    listen('weather', ({ payload }) => showWeather(payload)),
    listen('notification', ({ payload }) => showNotification(payload)),
    listen('notification-status', ({ payload }) => handleNotificationAccess(payload)),
    listen('switcher', ({ payload }) => showSwitcher(payload)),
    listen('switcher-end', () => {
      ui.switcher = null;
      render();
      scheduleCollapse();
    }),
  ]);
  showBattery(await invoke('get_battery'));
  showWeather(await invoke('get_weather'));
  handleNotificationAccess(await invoke('get_notification_status'));
}

start().catch((error) => console.error('The pill could not start:', error));
