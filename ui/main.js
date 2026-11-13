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

// The idle pill, and the extra room around it that still counts as hovering it.
const IDLE = { width: 132, height: 6 };
const IDLE_ROOM = { width: 40, height: 6 };
// The spring overshoots, so the window always has this much spare width, and this much spare height
// while the pill grows.
const SPRING_ROOM = { width: 40, height: 36 };
// How long size changes take; these match #pill's transitions in style.css.
const GROW_TIME = 500;
const SHRINK_TIME = 340;
const MAX_RADIUS = 20;

const pill = $('#pill');
const content = $('#content');

// ---- Motion ----

// A spring's settling curve as a CSS linear() easing, worked out once. Lower damping bounces more.
function springEasing(damping) {
  const steps = 48;
  // Settles to within about 0.2% by the end of the animation.
  const frequency = 6.5 / damping;
  const damped = frequency * Math.sqrt(1 - damping * damping);
  const points = [];
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    const decay = Math.exp(-damping * frequency * t);
    const value = 1 - decay * (Math.cos(damped * t) + ((damping * frequency) / damped) * Math.sin(damped * t));
    points.push(step === steps ? 1 : Number(value.toFixed(4)));
  }
  return `linear(${points.join(', ')})`;
}

const SPRING = springEasing(0.68); // growing and appearing: a soft rebound
const SPRING_POP = springEasing(0.5); // small things like icons and dots: a livelier one
const SPRING_OUT = springEasing(0.95); // leaving: quick, barely any rebound
document.documentElement.style.setProperty('--spring', SPRING);
document.documentElement.style.setProperty('--spring-pop', SPRING_POP);
document.documentElement.style.setProperty('--spring-out', SPRING_OUT);

/** Replays a short animation on an element, for things that change in place rather than appear. */
function bump(element, keyframes, duration = 380, easing = SPRING_POP) {
  element.animate(keyframes, { duration, easing });
}

// Text that changes in place slides in from the side a little.
const SLIDE_IN = [{ opacity: 0, transform: 'translateX(8px)' }, { opacity: 1, transform: 'none' }];

// ---- Theme ----

function setTheme(theme) {
  document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
}

// ---- Sliders ----

/** Keeps a slider's filled part in step with its value. */
function paintSlider(slider) {
  const min = Number(slider.min) || 0;
  const max = Number(slider.max) || 1;
  const fraction = max > min ? (Number(slider.value) - min) / (max - min) : 0;
  slider.style.setProperty('--fill', `${Math.min(100, Math.max(0, fraction * 100))}%`);
}

function setSlider(slider, value) {
  slider.value = value;
  paintSlider(slider);
}

for (const slider of $$('.slider')) {
  slider.addEventListener('input', () => paintSlider(slider));
  paintSlider(slider);
}

// ---- Icons ----

function icon(name, className = 'icon') {
  const image = document.createElement('img');
  image.className = className;
  image.src = `icons/${name}.png`;
  image.alt = '';
  image.draggable = false;
  return image;
}

function glyph(name, className = 'glyph') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className);
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#g-${name}`);
  svg.append(use);
  return svg;
}

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

let closeTimer;

function render() {
  const expanded = Boolean(ui.hover || ui.panel || isPinned());
  pill.classList.toggle('idle-hidden', ui.idleHidden);
  // Window previews draw over the page, so they go before anything else takes their place.
  if (!expanded || !previewsWanted()) {
    hidePreviews();
  }

  if (!expanded) {
    // Closing fades the content while the glass shrinks around it, then hides it. What was showing is
    // left as it is until then, so nothing jumps while it goes.
    if (!pill.classList.contains('collapsed') && !pill.classList.contains('closing')) {
      pill.classList.add('closing');
      clearTimeout(closeTimer);
      closeTimer = setTimeout(() => {
        pill.classList.replace('closing', 'collapsed');
      }, SHRINK_TIME);
    }
    updateSize();
    return;
  }
  clearTimeout(closeTimer);
  pill.classList.remove('collapsed', 'closing');

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
  updateSize();
}

// ---- Sizing ----
//
// The glass springs to the size of #content. Resizing a window every frame would be slow and shaky, so the
// window changes at most twice per change: it grows first, with room for the spring to overshoot, and is
// trimmed to fit once the pill has settled.
//
// The window keeps one width and stays pinned to the top of the screen, so it only ever gets taller or
// shorter downward. A window that changed width would be re-centered, and for a frame the old picture would
// show in the new place, which looked like a twitch. The pill also waits for a bigger window to be in place
// before growing, so the window's edge never cuts off its rounded corners.

const WINDOW_WIDTH = 480 + SPRING_ROOM.width;
// After a spring's set time, a little longer before trimming, so the window never clips it mid-motion.
const SETTLE_MARGIN = 80;

let pillSize = null;
let windowHeight = 0;
let sizeVersion = 0;
let settleTimer;

function isIdle() {
  return pill.classList.contains('collapsed') || pill.classList.contains('closing');
}

function targetSize() {
  return isIdle() ? IDLE : { width: content.offsetWidth, height: content.offsetHeight };
}

function updateSize() {
  const target = targetSize();
  if (pillSize && target.width === pillSize.width && target.height === pillSize.height) {
    return;
  }
  const growing = !pillSize || target.width > pillSize.width || target.height > pillSize.height;
  pillSize = target;
  const version = ++sizeVersion;
  clearTimeout(settleTimer);

  const settledHeight = target.height + (target === IDLE ? IDLE_ROOM.height : 0);
  const apply = () => {
    // A newer size came along while waiting for the window, and that one wins.
    if (version !== sizeVersion) {
      return;
    }
    pill.dataset.motion = growing ? 'grow' : 'shrink';
    pill.style.width = `${target.width}px`;
    pill.style.height = `${target.height}px`;
    pill.style.borderRadius = `${Math.min(MAX_RADIUS, target.height / 2)}px`;
    settleTimer = setTimeout(
      () => setWindowHeight(settledHeight),
      (growing ? GROW_TIME : SHRINK_TIME) + SETTLE_MARGIN,
    );
  };

  const roomy = settledHeight + (growing ? SPRING_ROOM.height : 0);
  if (roomy > windowHeight) {
    setWindowHeight(roomy).then(apply);
  } else {
    apply();
  }
}

/** Resizes the window, resolving once the page has actually been given the new size. */
function setWindowHeight(height) {
  if (height === windowHeight) {
    return Promise.resolve();
  }
  windowHeight = height;
  const resized = new Promise((resolve) => {
    const done = () => {
      window.removeEventListener('resize', done);
      clearTimeout(fallback);
      requestAnimationFrame(() => resolve());
    };
    // In case Windows doesn't report a change, such as when the size was already right.
    const fallback = setTimeout(done, 100);
    window.addEventListener('resize', done);
  });
  invoke('set_size', { width: WINDOW_WIDTH, height })
    .then((mouseInside) => {
      // A window that shrinks away from a still mouse is never told the mouse left.
      if (!mouseInside && ui.hover) {
        ui.hover = false;
        scheduleCollapse();
      }
    })
    .catch((error) => console.error('Could not resize the pill:', error));
  return resized;
}

// The window is wider than the idle pill, so only the pill and a little room around it open it.
function overIdlePill(event) {
  const reach = (IDLE.width + IDLE_ROOM.width) / 2;
  return Math.abs(event.clientX - window.innerWidth / 2) <= reach;
}

// Content that changes size on its own, like a list that loads, resizes the pill too.
new ResizeObserver(() => updateSize()).observe(content);

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

function onPointer(event) {
  if (isIdle() && !overIdlePill(event)) {
    return;
  }
  clearTimeout(collapseTimer);
  if (!ui.hover) {
    ui.hover = true;
    render();
  }
}
document.addEventListener('mouseover', onPointer);
// Moving along the top into the idle pill's reach doesn't cross any element, so moves count too. This
// only fires while the mouse is over the pill's own window.
document.addEventListener('mousemove', onPointer);
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
    if (ui.panel === 'running' && !ui.switcher) {
      onRunningKey(event);
    }
    return;
  }
  if (ui.switcher) {
    invoke('switcher_cancel');
  } else {
    closeAll();
  }
});

function openPanel(name, runningSelection = -1) {
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
    showRunning(runningSelection);
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
  const element = $('#bar-battery');
  element.classList.toggle('empty', !battery);
  if (!battery) {
    return;
  }
  const level = Math.min(100, Math.max(0, battery.percentage));
  element.classList.toggle('low', level <= 15 && !battery.isCharging);
  $('#bar-battery-value').textContent = String(level);
  // An SVG element has no hidden property, so the attribute is set directly.
  $('#bar-battery-bolt').toggleAttribute('hidden', !battery.isCharging);
  element.title = battery.isCharging ? `${level}%, charging` : `${level}%`;
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
    const timer = $('#toast-timer');
    timer.getAnimations().forEach((animation) => animation.cancel());
    timer.hidden = ui.toast.kind === 'settings';
    // The settings prompt waits for the user; real notifications go away on their own.
    if (ui.toast.kind !== 'settings') {
      toastTimer = setTimeout(nextToast, TOAST_DURATION);
      timer.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], {
        duration: TOAST_DURATION,
        easing: 'linear',
        fill: 'forwards',
      });
    }
    // A notification that replaces another one pops in afresh.
    if (!$('#toast').hidden) {
      bump($('#toast'), [{ opacity: 0, transform: 'translateY(-6px) scale(0.97)' }, { opacity: 1, transform: 'none' }], 420, SPRING);
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
  $('#notifications-badge').hidden = !unreadNotifications;
  $('#tile-notifications').title = unreadNotifications ? 'Notifications (new)' : 'Notifications';
}

async function showNotificationHistory() {
  unreadNotifications = false;
  updateNotificationTile();
  const history = await invoke('get_notification_history');
  $('#notifications-list').replaceChildren(...history.map((entry) => {
    const item = document.createElement('div');
    item.className = 'item notification';
    const heading = document.createElement('div');
    heading.className = 'dim small';
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
  $('#volume-flash-bar').style.transform = `scaleX(${muted ? 0 : volume / 100})`;
  $('#volume-flash-value').textContent = muted ? 'Muted' : String(volume);
  $('#volume-flash-icon').classList.toggle('muted', Boolean(muted));
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
  setSlider($('#center-volume'), volume);
  $('#center-volume-value').textContent = String(volume);
}

$('#center-volume').addEventListener('input', (event) => {
  const volume = Number(event.target.value);
  $('#center-volume-value').textContent = String(volume);
  invoke('set_volume', { volume }).catch(console.error);
});

// ---- App switcher (Alt+Space) ----

function showSwitcher(selection) {
  const stepping = Boolean(ui.switcher);
  ui.switcher = selection;
  $('#switcher-app').textContent = selection.appName;
  $('#switcher-title').textContent = selection.title === selection.appName ? '' : selection.title;
  $('#switcher-count').textContent = selection.count > 1 ? `${selection.position}/${selection.count}` : '';
  // Each step slides the next app in.
  if (stepping) {
    bump($('#switcher-app'), SLIDE_IN, 300, SPRING);
    bump($('#switcher-title'), SLIDE_IN, 340, SPRING);
  }
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
  const action = session?.playing ? 'Pause' : 'Play';
  const toggleIcon = $('#music-toggle-icon');
  if (toggleIcon.dataset.icon !== action) {
    const changed = Boolean(toggleIcon.dataset.icon);
    toggleIcon.dataset.icon = action;
    toggleIcon.src = `icons/${action.toLowerCase()}.png`;
    $('#music-toggle').title = action;
    $('#music-toggle').setAttribute('aria-label', action);
    if (changed) {
      bump(toggleIcon, [{ opacity: 0, transform: 'scale(0.5)' }, { opacity: 1, transform: 'scale(1)' }]);
    }
  }

  const seek = $('#music-seek');
  const hasTimeline = Boolean(session && session.duration > 0);
  seek.disabled = !hasTimeline || !session.canSeek;
  if (!seekDragging && Date.now() > seekSettlesAt) {
    seek.max = hasTimeline ? session.duration : 1;
    seek.value = hasTimeline ? session.position : 0;
  }
  paintSlider(seek);
  $('#music-elapsed').textContent = hasTimeline ? formatTime(Number(seek.value)) : '--:--';
  $('#music-duration').textContent = hasTimeline ? formatTime(session.duration) : '--:--';
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
  $('#apps-hint').hidden = true;
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
//
// A grid of the open apps, each with a live preview. Windows draws the previews itself, on top of the page,
// at boxes the page reports (see previews.rs). Since they don't move with the page, they are placed once the
// panel has stopped moving, moved when the grid scrolls, and taken away before the panel closes or is covered.

let runningSelected = -1;
let runningColumns = 3;
let previewsOn = false;
let previewVersion = 0;
let previewFrame = 0;

/** Holding Alt+Space opens the panel from the keyboard, with the switcher's app selected. */
function openRunning(selected) {
  openPanel('running', selected);
  ui.keyboard = true;
  render();
}

async function showRunning(selected = -1) {
  runningSelected = selected;
  let windows;
  try {
    windows = await invoke('get_open_windows');
    $('#running-empty').textContent = 'No open apps';
  } catch (error) {
    windows = [];
    $('#running-empty').textContent = String(error);
  }
  if (ui.panel !== 'running') {
    return;
  }
  runningColumns = windows.length <= 2 ? 2 : windows.length <= 9 ? 3 : 4;
  runningSelected = Math.min(runningSelected, windows.length - 1);
  const list = $('#running-list');
  list.style.setProperty('--columns', runningColumns);
  list.replaceChildren(...windows.map((window, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'window-tile';
    button.classList.toggle('selected', index === runningSelected);
    button.dataset.hwnd = window.hwnd;
    button.title = window.title === window.appName ? window.appName : `${window.appName} · ${window.title}`;
    const preview = document.createElement('span');
    preview.className = 'window-preview';
    const fallback = document.createElement('span');
    fallback.className = 'window-preview-name';
    fallback.textContent = window.appName;
    preview.append(fallback);
    const name = document.createElement('span');
    name.className = 'window-name ellipsis';
    name.textContent = window.appName;
    button.append(preview, name);
    button.addEventListener('click', () => activateRunning(window.hwnd));
    return button;
  }));
  $('#running-empty').hidden = windows.length > 0;
  placePreviews(true);
}

async function activateRunning(hwnd) {
  hidePreviews();
  try {
    await invoke('activate_window', { hwnd });
    closeAll();
  } catch (error) {
    console.error('Could not switch apps:', error);
    showRunning(runningSelected);
  }
}

function selectRunning(index) {
  const tiles = $('#running-list').children;
  if (tiles.length === 0) {
    return;
  }
  runningSelected = Math.min(tiles.length - 1, Math.max(0, index));
  for (const [i, tile] of [...tiles].entries()) {
    tile.classList.toggle('selected', i === runningSelected);
  }
  tiles[runningSelected].scrollIntoView({ block: 'nearest' });
}

function previewsWanted() {
  return ui.panel === 'running' && !ui.toast && !ui.switcher && !isIdle();
}

/** Puts the previews over their boxes. When the panel has just appeared, waits for it to stop moving. */
async function placePreviews(settle = false) {
  const version = ++previewVersion;
  if (settle) {
    const panel = $('[data-panel="running"]');
    await Promise.all(panel.getAnimations().map((animation) => animation.finished.catch(() => {})));
  }
  if (version !== previewVersion || !previewsWanted()) {
    return;
  }
  const list = $('#running-list');
  const view = list.getBoundingClientRect();
  const slots = [];
  for (const tile of list.children) {
    const box = tile.firstElementChild.getBoundingClientRect();
    // Windows can't cut a preview off at the grid's edge, so one scrolled partly out of view waits.
    if (box.top >= view.top - 1 && box.bottom <= view.bottom + 1) {
      slots.push({ hwnd: Number(tile.dataset.hwnd), x: box.left, y: box.top, width: box.width, height: box.height });
    }
  }
  previewsOn = true;
  try {
    const shown = new Set(await invoke('show_previews', { slots }));
    for (const tile of list.children) {
      tile.classList.toggle('live', shown.has(Number(tile.dataset.hwnd)));
    }
  } catch (error) {
    console.error('Could not show previews:', error);
  }
}

function hidePreviews() {
  previewVersion += 1;
  cancelAnimationFrame(previewFrame);
  if (previewsOn) {
    previewsOn = false;
    invoke('hide_previews').catch(console.error);
  }
}

$('#running-list').addEventListener('scroll', () => {
  cancelAnimationFrame(previewFrame);
  previewFrame = requestAnimationFrame(() => placePreviews());
}, { passive: true });

function onRunningKey(event) {
  const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -runningColumns, ArrowDown: runningColumns };
  if (event.key in moves) {
    event.preventDefault();
    selectRunning(runningSelected < 0 ? 0 : runningSelected + moves[event.key]);
  } else if (event.key === 'Enter' && runningSelected >= 0) {
    event.preventDefault();
    const tile = $('#running-list').children[runningSelected];
    if (tile) {
      activateRunning(Number(tile.dataset.hwnd));
    }
  } else if (event.key === ' ') {
    // The Space that opened the panel is still down and repeating.
    event.preventDefault();
  }
}

// ---- Weather ----

let weather = { status: 'unset' };

function degrees(value) {
  return value === null || value === undefined ? '--' : `${value}°`;
}

function showWeather(report) {
  weather = report;
  const ready = report.status === 'ready';
  const alerting = ready && report.alerts.length > 0;
  const barIcon = $('#bar-weather-icon');
  const iconName = alerting ? 'danger' : ready ? report.icon : null;
  barIcon.hidden = !iconName;
  if (iconName) {
    barIcon.src = `icons/${iconName}.png`;
  }
  $('#bar-weather-temp').textContent = ready
    ? report.temperature !== null ? degrees(report.temperature) : iconName ? '' : report.description
    : '';
  $('#bar-weather').classList.toggle('empty', !ready);
  $('#bar-weather').title = ready
    ? [...report.alerts, report.description].filter(Boolean).join(' · ')
    : '';
  if (ui.panel === 'weather') {
    renderWeather();
  }
  if (ui.panel === 'center') {
    updateWeatherTile();
  }
}

function svg(name, attributes = {}) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, value);
  }
  return element;
}

function rainChance(precipitation) {
  const element = document.createElement('span');
  element.className = 'rain';
  if (precipitation) {
    element.append(`${Math.round(precipitation)}%`);
    element.title = `${Math.round(precipitation)}% chance of rain`;
  }
  return element;
}

function renderWeather() {
  const ready = weather.status === 'ready';
  $('#weather-zip-form').hidden = weather.status !== 'unset';
  $('#weather-body').hidden = !ready;
  $('#weather-status').textContent = weather.error || (weather.status === 'loading' ? 'Loading weather…' : '');
  if (!ready) {
    return;
  }
  $('#weather-icon').hidden = !weather.icon;
  if (weather.icon) {
    $('#weather-icon').src = `icons/${weather.icon}.png`;
  }
  $('#weather-temp').textContent = degrees(weather.temperature);
  $('#weather-desc').textContent = weather.description;
  $('#weather-place').textContent = weather.place || weather.zip;
  $('#weather-refresh').title = weather.updated ? `Refresh (${weather.updated.toLowerCase()})` : 'Refresh';
  $('#weather-alerts').hidden = weather.alerts.length === 0;
  $('#weather-alerts-text').textContent = weather.alerts.join(', ');
  renderHourly();
  renderWeek();
}

// The next 48 hours, side by side, with a marker where each new day starts.
function renderHourly() {
  const cells = [];
  let lastDay = 'Today';
  weather.hourly.forEach((hour, index) => {
    if (hour.day !== lastDay) {
      const marker = document.createElement('div');
      marker.className = 'hour-day';
      marker.textContent = hour.day;
      cells.push(marker);
      lastDay = hour.day;
    }
    const cell = document.createElement('div');
    cell.className = 'hour';
    cell.title = hour.description;
    const label = document.createElement('span');
    label.className = 'hour-label';
    label.textContent = index === 0 ? 'Now' : hour.label;
    const picture = hour.icon ? icon(hour.icon) : document.createElement('span');
    picture.classList.add('icon');
    const temperature = document.createElement('span');
    temperature.className = 'hour-temp';
    temperature.textContent = degrees(hour.temperature);
    cell.append(label, picture, temperature, rainChance(hour.precipitation));
    cells.push(cell);
  });
  const strip = $('#weather-hourly');
  strip.replaceChildren(...cells);
  strip.scrollLeft = 0;
}

// A mouse wheel scrolls the hourly strip sideways.
$('#weather-hourly').addEventListener('wheel', (event) => {
  if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
    return;
  }
  event.preventDefault();
  event.currentTarget.scrollBy({ left: event.deltaY, behavior: 'smooth' });
}, { passive: false });

// ---- The week's graph ----

// Drawing units; the graph scales to the panel's width.
const GRAPH = { width: 460, height: 156, left: 34, right: 8, top: 12, bottom: 46 };
let weekDays = [];
let weekPoints = [];

function averageTemperature(day) {
  const known = [day.high, day.low].filter((value) => value !== null && value !== undefined);
  return known.length ? known.reduce((sum, value) => sum + value, 0) / known.length : null;
}

/** Round temperature marks that cover the week with a little room on each side. */
function temperatureScale(values) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  let low = Math.floor((min - 2) / 5) * 5;
  let high = Math.ceil((max + 2) / 5) * 5;
  if (high - low < 10) {
    high = low + 10;
  }
  const step = high - low <= 20 ? 5 : high - low <= 40 ? 10 : 20;
  low = Math.floor(low / step) * step;
  high = Math.ceil(high / step) * step;
  const marks = [];
  for (let value = low; value <= high; value += step) {
    marks.push(value);
  }
  return { low, high, marks };
}

function renderWeek() {
  const graph = $('#weather-graph');
  hideTip(true);
  weekDays = weather.daily;
  const averages = weekDays.map(averageTemperature);
  const known = averages.filter((value) => value !== null);
  $('#weather-week').hidden = known.length === 0;
  if (known.length === 0) {
    graph.replaceChildren();
    return;
  }

  const { width, height, left, right, top, bottom } = GRAPH;
  const plotBottom = height - bottom;
  const { low, high, marks } = temperatureScale(known);
  const column = (width - left - right) / weekDays.length;
  const x = (index) => left + column * (index + 0.5);
  const y = (temperature) => top + ((high - temperature) / (high - low)) * (plotBottom - top);
  graph.setAttribute('viewBox', `0 0 ${width} ${height}`);

  const parts = [];
  // Temperature marks on the left.
  for (const mark of marks) {
    parts.push(svg('line', { class: 'grid-line', x1: left - 4, x2: width - right, y1: y(mark), y2: y(mark) }));
    const label = svg('text', { class: 'axis', x: left - 8, y: y(mark) + 3.5, 'text-anchor': 'end' });
    label.textContent = `${mark}°`;
    parts.push(label);
  }

  weekPoints = averages.map((value, index) => (value === null ? null : { x: x(index), y: y(value) }));

  // The line through each day's average, broken where a day has no temperature.
  let path = '';
  let drawing = false;
  for (const point of weekPoints) {
    if (!point) {
      drawing = false;
      continue;
    }
    path += `${drawing ? 'L' : 'M'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
    drawing = true;
  }
  if (weekPoints.every(Boolean)) {
    const first = weekPoints[0];
    const last = weekPoints[weekPoints.length - 1];
    parts.push(svg('path', { class: 'graph-area', d: `${path}L${last.x} ${plotBottom}L${first.x} ${plotBottom}Z` }));
  }
  parts.push(svg('path', { class: 'graph-line', d: path, pathLength: '1' }));

  weekDays.forEach((day, index) => {
    const group = svg('g', { class: 'graph-day', 'data-index': index });
    group.append(svg('line', { class: 'graph-guide', x1: x(index), x2: x(index), y1: top - 4, y2: plotBottom }));
    if (day.icon) {
      const picture = svg('image', { class: 'graph-icon', href: `icons/${day.icon}.png`, x: x(index) - 8, y: plotBottom + 9, width: 16, height: 16 });
      group.append(picture);
    }
    const label = svg('text', { class: 'day-label', x: x(index), y: height - 5 });
    label.textContent = day.short;
    group.append(label);
    const point = weekPoints[index];
    if (point) {
      const dot = svg('circle', { class: 'graph-dot', cx: point.x, cy: point.y, r: 3 });
      // The dots pop on one after another as the line reaches them.
      dot.style.animationDelay = `${180 + index * 60}ms`;
      group.append(dot);
    }
    // The whole column answers to the mouse, not just the small dot.
    group.append(svg('rect', { class: 'graph-hit', x: x(index) - column / 2, y: 0, width: column, height }));
    group.addEventListener('pointerenter', () => showDay(index));
    parts.push(group);
  });
  graph.replaceChildren(...parts);
}

$('#weather-graph').addEventListener('pointerleave', () => hideTip());

let activeDay = null;
let tipHideTimer;

function showDay(index) {
  const day = weekDays[index];
  if (!day || activeDay === index) {
    return;
  }
  for (const group of $$('.graph-day')) {
    const active = Number(group.dataset.index) === index;
    group.classList.toggle('active', active);
    group.querySelector('.graph-dot')?.classList.toggle('active', active);
    group.querySelector('.graph-guide').classList.toggle('active', active);
  }

  const tip = $('#weather-tip');
  const name = document.createElement('strong');
  name.textContent = day.name;
  const range = document.createElement('span');
  range.textContent = [day.high !== null ? `High ${degrees(day.high)}` : '', day.low !== null ? `Low ${degrees(day.low)}` : '']
    .filter(Boolean)
    .join(' · ');
  const description = document.createElement('span');
  description.className = 'dim';
  description.textContent = day.description;
  const lines = [name, range, description];
  if (day.precipitation) {
    const rain = document.createElement('span');
    rain.className = 'dim';
    rain.textContent = `${Math.round(day.precipitation)}% chance of rain`;
    lines.push(rain);
  }
  for (const notice of day.notices) {
    const line = document.createElement('span');
    line.className = 'alert';
    line.append(icon('danger', 'icon small'), notice);
    lines.push(line);
  }
  const body = document.createElement('div');
  body.className = 'tip-body';
  body.append(...lines);
  tip.replaceChildren(...(day.icon ? [icon(day.icon, 'icon tip-icon')] : []), body);

  const appearing = tip.hidden || tip.classList.contains('leaving');
  clearTimeout(tipHideTimer);
  tip.hidden = false;
  tip.classList.remove('leaving');

  // Beside the dot, on whichever side has more room, so the dot and its column stay in view.
  const graph = $('#weather-graph');
  const scale = graph.clientWidth / GRAPH.width;
  const point = weekPoints[index] || { x: GRAPH.left + ((GRAPH.width - GRAPH.left - GRAPH.right) / weekDays.length) * (index + 0.5), y: GRAPH.top };
  const dotX = point.x * scale;
  const dotY = point.y * scale;
  const tipWidth = tip.offsetWidth;
  const tipHeight = tip.offsetHeight;
  const gap = 14;
  const onRight = dotX < graph.clientWidth / 2;
  const left = Math.min(Math.max(onRight ? dotX + gap : dotX - gap - tipWidth, 0), graph.clientWidth - tipWidth);
  const top = Math.min(Math.max(dotY - tipHeight / 2, 0), graph.clientHeight - tipHeight);
  const transform = `translate(${left}px, ${top}px)`;

  if (appearing) {
    // Placed at once, then popped in. After that it glides between days.
    tip.style.transition = 'none';
    tip.style.transform = transform;
    void tip.offsetWidth;
    tip.style.transition = '';
    bump(tip, [{ opacity: 0, scale: '0.85' }, { opacity: 1, scale: '1' }], 320);
  } else {
    tip.style.transform = transform;
  }
  activeDay = index;
}

function hideTip(immediately = false) {
  activeDay = null;
  for (const element of $$('.graph-day.active, .graph-dot.active, .graph-guide.active')) {
    element.classList.remove('active');
  }
  const tip = $('#weather-tip');
  clearTimeout(tipHideTimer);
  if (immediately) {
    tip.hidden = true;
    tip.classList.remove('leaving');
    return;
  }
  tip.classList.add('leaving');
  tipHideTimer = setTimeout(() => {
    tip.hidden = true;
    tip.classList.remove('leaving');
  }, 160);
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
  const button = $('#weather-refresh');
  if (button.disabled) {
    return;
  }
  button.disabled = true;
  // Spins only while the refresh is under way.
  const spin = button.querySelector('.glyph').animate(
    [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
    { duration: 800, iterations: Infinity },
  );
  try {
    await invoke('refresh_weather');
    showWeather(await invoke('get_weather'));
  } finally {
    spin.cancel();
    button.disabled = false;
  }
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
  const ready = weather.status === 'ready';
  $('#tile-weather-icon').src = `icons/${(ready && weather.icon) || 'clear-day'}.png`;
  $('#tile-weather-temp').textContent = ready && weather.temperature !== null ? degrees(weather.temperature) : '';
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
  tile.title = batterySaver === null ? 'Battery saver' : `Battery saver ${batterySaver ? 'on' : 'off'}`;
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
  toggle.setAttribute('aria-checked', String(Boolean(nightLight.enabled)));
  toggle.title = nightLight.enabled ? 'On' : 'Off';
  const slider = $('#nightlight-strength');
  slider.disabled = !nightLight.available;
  if (nightLight.strength !== null) {
    setSlider(slider, nightLight.strength);
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
    button.classList.remove('confirm');
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
      button.classList.add('confirm');
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
    button.className = 'option';
    button.setAttribute('role', 'switch');
    const label = document.createElement('span');
    label.textContent = name;
    // Looks like a switch; the whole row is what gets clicked.
    const toggle = document.createElement('span');
    toggle.className = 'switch';
    toggle.setAttribute('aria-hidden', 'true');
    toggle.append(Object.assign(document.createElement('span'), { className: 'knob' }));
    button.append(label, toggle);
    const paint = () => {
      button.setAttribute('aria-checked', String(options[key]));
      toggle.setAttribute('aria-checked', String(options[key]));
    };
    paint();
    button.addEventListener('click', () => {
      options[key] = !options[key];
      saveJson('pill-options', options);
      paint();
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
    listen('theme', ({ payload }) => setTheme(payload)),
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
    listen('switcher-expand', ({ payload }) => {
      ui.switcher = null;
      openRunning(payload);
    }),
  ]);
  setTheme(await invoke('get_theme'));
  showBattery(await invoke('get_battery'));
  showWeather(await invoke('get_weather'));
  handleNotificationAccess(await invoke('get_notification_status'));
}

start().catch((error) => console.error('The pill could not start:', error));
