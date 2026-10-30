const pill = document.querySelector('.pill');
const pillClock = document.querySelector('.pill-clock');
const pillDate = document.querySelector('.pill-date');
const batteryPercentage = document.querySelector('.battery-percentage');
const pillSettingsMenu = document.querySelector('.pill-settings-menu');
const volumeToggle = document.querySelector('.volume-toggle');
const volumeControls = document.querySelector('.volume-controls');
const volumeSlider = document.querySelector('.volume-slider');
const volumeValue = document.querySelector('.volume-value');
const volumeError = document.querySelector('.volume-error');
const musicToggle = document.querySelector('.music-toggle');
const musicControls = document.querySelector('.music-controls');
const appsToggle = document.querySelector('.apps-toggle');
const appsPanel = document.querySelector('.apps-panel');
const appsSearch = document.querySelector('.apps-search');
const appsList = document.querySelector('.apps-list');
const appSwitcher = document.querySelector('.app-switcher');
const appSwitcherTrack = document.querySelector('.app-switcher-track');
const musicArtwork = document.querySelector('.music-artwork');
const musicTitle = document.querySelector('.music-title');
const musicArtist = document.querySelector('.music-artist');
const musicAlbum = document.querySelector('.music-album');
const musicStatus = document.querySelector('.music-status');
const musicPrevious = document.querySelector('.music-previous');
const musicPlayPause = document.querySelector('.music-play-pause');
const musicPlayPauseIcon = document.querySelector('.music-play-pause-icon');
const musicNext = document.querySelector('.music-next');
const notificationToast = document.querySelector('.notification-toast');
const notificationApp = document.querySelector('.notification-app');
const notificationTitle = document.querySelector('.notification-title');
const notificationMessage = document.querySelector('.notification-message');
const notificationClose = document.querySelector('.notification-close');
const notificationSettings = document.querySelector('.notification-settings');
let expanded = false;
let settingsOpen = false;
let appsOpen = false;
let keyboardPinned = false;
let animating = false;
let opening = false;
let refreshingBattery = false;
let musicRefreshTimer;
let refreshingMusic = false;
let controllingMusic = false;
let currentMediaSession;
let notificationTimer;
let notificationClosingTimer;
let batteryPowerSource;
let batteryRefreshRequested = false;
let batteryChargingRetryTimer;
let batteryChargingRetriesRemaining = 0;
let notificationQueue = [];
let notificationOpen = false;
let currentNotification;
let appsRequestId = 0;
let appsPanelRequestId = 0;
let launchableApps = [];
let appSwitcherOpen = false;
let appSwitcherWindows;
let appSwitcherIndex = 0;
let appSwitcherSteps = 0;
let appSwitcherCommitRequested = false;
let appSwitcherRequestId = 0;

const pillOptionTargets = new Map([
  ['volume', volumeToggle],
  ['music', musicToggle],
  ['apps', appsToggle],
  ['date', pillDate],
  ['time', pillClock],
  ['battery', batteryPercentage],
]);
const savedPillOptions = loadPillOptions();
const pillOptions = Object.fromEntries(
  [...pillOptionTargets.keys()].map((key) => [key, savedPillOptions[key] !== false]),
);

function loadPillOptions() {
  try {
    const savedOptions = window.localStorage.getItem('pill-options');
    if (!savedOptions) {
      return {};
    }

    const options = JSON.parse(savedOptions);
    if (options && typeof options === 'object' && !Array.isArray(options)) {
      return options;
    }
    console.error('Saved pill options have an invalid format.');
  } catch (error) {
    console.error('Failed to read saved pill options:', error);
  }

  return {};
}

function applyPillOption(key) {
  const enabled = pillOptions[key];
  const target = pillOptionTargets.get(key);
  const optionButton = pillSettingsMenu.querySelector(`[data-pill-option="${key}"]`);
  target.classList.toggle('pill-option-disabled', !enabled);
  target.setAttribute('aria-hidden', String(!enabled));
  target.inert = !enabled;
  optionButton.setAttribute('aria-pressed', String(enabled));
  optionButton.classList.toggle('is-disabled', !enabled);
}

function savePillOptions() {
  try {
    window.localStorage.setItem('pill-options', JSON.stringify(pillOptions));
  } catch (error) {
    console.error('Failed to save pill options:', error);
  }
}

for (const key of pillOptionTargets.keys()) {
  applyPillOption(key);
}

function updateClock() {
  const now = new Date();
  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(now);
  const date = new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
  }).format(now);
  pillClock.textContent = time;
  pillClock.dateTime = now.toISOString();
  pillClock.setAttribute('aria-label', time);
  pillDate.textContent = date;
  pillDate.dateTime = now.toISOString();
  pillDate.setAttribute('aria-label', new Intl.DateTimeFormat('en-US', {
    dateStyle: 'full',
  }).format(now));
  setTimeout(updateClock, (60 - now.getSeconds()) * 1000 - now.getMilliseconds());
}

updateClock();

async function refreshBatteryPercentage() {
  if (refreshingBattery) {
    batteryRefreshRequested = true;
    return;
  }

  refreshingBattery = true;
  try {
    const battery = await window.pillApp.getBatteryStatus();
    if (battery === null) {
      batteryPercentage.hidden = true;
      batteryPercentage.classList.remove('is-charging');
      return;
    }

    const { percentage, isCharging } = battery;
    batteryPercentage.textContent = String(percentage);
    batteryPercentage.setAttribute('aria-label', `Battery charge ${percentage} percent`);
    batteryPercentage.classList.toggle('is-low', percentage <= 20 && percentage > 10);
    batteryPercentage.classList.toggle('is-critical', percentage <= 10);
    const isChargingOnAc = isCharging && batteryPowerSource !== false;
    batteryPercentage.classList.toggle('is-charging', isChargingOnAc);
    batteryPercentage.hidden = false;
    if (isChargingOnAc) {
      clearTimeout(batteryChargingRetryTimer);
      batteryChargingRetryTimer = undefined;
      batteryChargingRetriesRemaining = 0;
    } else if (batteryPowerSource === true && batteryChargingRetriesRemaining > 0) {
      clearTimeout(batteryChargingRetryTimer);
      batteryChargingRetriesRemaining -= 1;
      batteryChargingRetryTimer = setTimeout(refreshBatteryPercentage, 2000);
    }
  } catch (error) {
    batteryPercentage.hidden = true;
    batteryPercentage.classList.remove('is-charging');
    clearTimeout(batteryChargingRetryTimer);
    batteryChargingRetryTimer = undefined;
    batteryChargingRetriesRemaining = 0;
    console.error('Failed to read battery percentage:', error);
  } finally {
    refreshingBattery = false;
    if (batteryRefreshRequested) {
      batteryRefreshRequested = false;
      refreshBatteryPercentage();
    }
  }
}

window.pillApp.onBatteryPowerSource((isOnAc) => {
  batteryPowerSource = isOnAc;
  clearTimeout(batteryChargingRetryTimer);
  batteryChargingRetryTimer = undefined;
  if (isOnAc) {
    batteryChargingRetriesRemaining = 5;
    refreshBatteryPercentage();
  } else {
    batteryChargingRetriesRemaining = 0;
    batteryPercentage.classList.remove('is-charging');
  }
});

refreshBatteryPercentage();
setInterval(refreshBatteryPercentage, 60000);

function showNextNotification() {
  clearTimeout(notificationTimer);
  const notification = notificationQueue.shift();
  currentNotification = notification;
  if (!notification) {
    notificationOpen = false;
    notificationToast.setAttribute('aria-hidden', 'true');
    notificationToast.inert = true;
    pill.classList.remove('notification-open');
    pill.classList.add('notification-closing');
    clearTimeout(notificationClosingTimer);
    window.pillApp.setNotificationOpen(false).catch((error) => {
      console.error('Failed to resize the pill after a notification:', error);
    });
    notificationClosingTimer = setTimeout(() => {
      pill.classList.remove('notification-closing');
    }, 320);
    window.pillApp.setInteractive(expanded);
    if (expanded && !pill.matches(':hover')) {
      collapsePill();
    }
    return;
  }

  notificationOpen = true;
  notificationApp.textContent = notification.appName || 'Windows';
  notificationTitle.textContent = notification.title || notification.appName || 'Notification';
  notificationMessage.textContent = notification.message || '';
  notificationSettings.hidden = !notification.settingsNeeded;
  notificationToast.setAttribute('aria-hidden', 'false');
  notificationToast.inert = false;
  pill.classList.add('notification-open');
  window.pillApp.setNotificationOpen(true).catch((error) => {
    console.error('Failed to expand the pill for a notification:', error);
  });
  window.pillApp.setInteractive(true);

  notificationTimer = notification.settingsNeeded
    ? undefined
    : setTimeout(showNextNotification, 7000);
}

function enqueueNotification(notification) {
  if (notificationQueue.length >= 20) {
    notificationQueue.shift();
  }
  notificationQueue.push(notification);
  if (!notificationOpen && !appSwitcherOpen) {
    showNextNotification();
  }
}

notificationClose.addEventListener('click', showNextNotification);
notificationSettings.addEventListener('click', async () => {
  try {
    await window.pillApp.openNotificationSettings();
  } catch (error) {
    console.error('Failed to open Windows notification settings:', error);
  }
  clearTimeout(notificationTimer);
  showNextNotification();
});

window.pillApp.onNotification((notification) => {
  enqueueNotification(notification);
});
window.pillApp.onNotificationListenerStatus((status) => {
  if (status.access === 'Allowed') {
    notificationQueue = notificationQueue.filter((notification) => !notification.settingsNeeded);
    if (currentNotification && currentNotification.settingsNeeded) {
      showNextNotification();
    }
  } else if (status.access !== 'Unavailable') {
    enqueueNotification({
      appName: 'The Pill',
      title: 'Notification access is needed',
      message: 'Allow The Pill to read Windows notifications in Settings to show them here.',
      settingsNeeded: true,
    });
  } else {
    enqueueNotification({
      appName: 'The Pill',
      title: 'Windows notifications are unavailable',
      message: 'The Pill could not connect to Windows notifications. Check the app installation and permissions.',
      settingsNeeded: true,
    });
  }
});

function waitForPillTransition() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const fallback = setTimeout(finish, 500);

    function finish(event) {
      if (event && (event.target !== pill || event.propertyName !== 'height')) {
        return;
      }

      clearTimeout(fallback);
      pill.removeEventListener('transitionend', finish);
      resolve();
    }

    pill.addEventListener('transitionend', finish);
  });
}

function waitForAppsPanelTransition() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const fallback = setTimeout(finish, 500);

    function finish(event) {
      if (event && (event.target !== appsPanel || event.propertyName !== 'opacity')) {
        return;
      }

      clearTimeout(fallback);
      appsPanel.removeEventListener('transitionend', finish);
      resolve();
    }

    appsPanel.addEventListener('transitionend', finish);
  });
}

function setVolumeControlsOpen(isOpen) {
  pill.classList.toggle('volume-adjusting', isOpen);
  volumeControls.setAttribute('aria-hidden', String(!isOpen));
  volumeControls.inert = !isOpen;
  volumeToggle.setAttribute('aria-expanded', String(isOpen));
}

function setMusicControlsOpen(isOpen, resizeWindow = true) {
  if (isOpen) {
    pill.classList.remove('music-closing');
    pill.classList.remove('music-artwork-ready');
  } else if (resizeWindow && pill.classList.contains('music-open')) {
    pill.classList.add('music-closing');
    pill.classList.remove('music-artwork-ready');
  }
  pill.classList.toggle('music-open', isOpen);
  musicControls.setAttribute('aria-hidden', String(!isOpen));
  musicControls.inert = !isOpen;
  musicToggle.setAttribute('aria-expanded', String(isOpen));
  if (isOpen) {
    refreshMusicSession();
    musicRefreshTimer = setInterval(refreshMusicSession, 2000);
    if (resizeWindow) {
      window.pillApp.setMusicOpen(true);
    }
    waitForPillTransition().then(() => {
      if (pill.classList.contains('music-open')) {
        pill.classList.add('music-artwork-ready');
      }
    });
  } else {
    clearInterval(musicRefreshTimer);
    musicRefreshTimer = undefined;
    if (resizeWindow) {
      waitForPillTransition().then(() => {
        if (
          !pill.classList.contains('music-open')
          && expanded
        ) {
          window.pillApp.setMusicOpen(false);
          pill.classList.remove('music-closing');
        }
      });
    }
  }
}

function renderLaunchableApps() {
  const query = appsSearch.value.trim().toLocaleLowerCase();
  const matchingApps = launchableApps.filter((app) => app.name.toLocaleLowerCase().includes(query));
  appsList.replaceChildren();

  if (matchingApps.length === 0) {
    return;
  }

  for (const app of matchingApps) {
    const item = document.createElement('div');
    item.className = 'app-list-item';
    item.setAttribute('role', 'listitem');
    const button = document.createElement('button');
    button.className = 'app-launch-button';
    button.type = 'button';
    button.dataset.appId = app.appId;
    button.textContent = app.name;
    item.append(button);
    appsList.append(item);
  }
}

async function refreshLaunchableApps() {
  const requestId = ++appsRequestId;
  appsList.replaceChildren();
  try {
    launchableApps = await window.pillApp.getLaunchableApps();
    if (requestId !== appsRequestId) {
      return;
    }
    renderLaunchableApps();
  } catch (error) {
    if (requestId !== appsRequestId) {
      return;
    }
    console.error('Failed to load launchable apps:', error);
  }
}

async function setAppsPanelOpen(isOpen, resizeWindow = true) {
  if (appsOpen === isOpen) {
    return;
  }

  if (!isOpen) {
    keyboardPinned = false;
  }

  if (isOpen && (settingsOpen || notificationOpen || animating || opening || appSwitcherOpen)) {
    return;
  }

  if (isOpen && pill.classList.contains('music-open')) {
    setMusicControlsOpen(false, false);
  }
  if (isOpen) {
    finishVolumeAdjustment();
  }

  const requestId = ++appsPanelRequestId;
  appsOpen = isOpen;
  appsToggle.setAttribute('aria-expanded', String(isOpen));
  appsPanel.setAttribute('aria-hidden', String(!isOpen));
  appsPanel.inert = !isOpen;
  if (isOpen) {
    pill.classList.remove('apps-closing');
    pill.classList.add('apps-open');
  } else {
    appsSearch.value = '';
    renderLaunchableApps();
    pill.classList.remove('apps-open');
    pill.classList.add('apps-closing');
    await Promise.all([
      waitForAppsPanelTransition(),
      waitForPillTransition(),
    ]);
    if (requestId !== appsPanelRequestId) {
      return;
    }
    pill.classList.remove('apps-closing');
  }

  if (resizeWindow) {
    try {
      await window.pillApp.setAppsOpen(isOpen);
    } catch (error) {
      console.error(`Failed to ${isOpen ? 'open' : 'close'} the apps panel:`, error);
      if (requestId !== appsPanelRequestId) {
        return;
      }
      if (isOpen) {
        appsOpen = false;
        appsToggle.setAttribute('aria-expanded', 'false');
        appsPanel.setAttribute('aria-hidden', 'true');
        appsPanel.inert = true;
        appsSearch.value = '';
        renderLaunchableApps();
        keyboardPinned = false;
        pill.classList.remove('apps-open');
        return;
      }
    }
  }

  if (isOpen && requestId === appsPanelRequestId) {
    window.pillApp.setInteractive(true);
    refreshLaunchableApps();
    appsSearch.focus();
  }
}

function switchAppsToMusic() {
  const requestId = ++appsPanelRequestId;
  appsOpen = false;
  appsToggle.setAttribute('aria-expanded', 'false');
  appsPanel.setAttribute('aria-hidden', 'true');
  appsPanel.inert = true;
  appsSearch.value = '';
  renderLaunchableApps();
  pill.classList.remove('apps-open');
  pill.classList.add('apps-closing');

  setMusicControlsOpen(true, false);
  Promise.all([
    waitForAppsPanelTransition(),
    waitForPillTransition(),
  ]).then(() => {
    if (requestId === appsPanelRequestId && pill.classList.contains('music-open')) {
      pill.classList.remove('apps-closing');
      window.pillApp.setMusicOpen(true);
    }
  });
}

async function launchSelectedApp(button) {
  button.disabled = true;
  try {
    await window.pillApp.launchApp(button.dataset.appId);
    await collapsePill();
  } catch (error) {
    button.disabled = false;
    console.error('Failed to launch Windows app:', error);
  }
}

function renderMusicSession(session) {
  currentMediaSession = session && session.available ? session : undefined;
  const available = Boolean(currentMediaSession);
  musicTitle.textContent = available && session.title ? session.title : 'Nothing playing';
  musicArtist.textContent = available ? session.artist || 'Unknown artist' : '';
  musicAlbum.textContent = available ? session.album || '' : '';
  musicStatus.textContent = available
    ? `${session.playbackStatus || 'Unknown'}${session.sessionId ? '' : ' · Controls unavailable'}`
    : 'Finds music playing in Windows apps.';
  const artworkSource = available && session.thumbnail ? session.thumbnail : '';
  if (musicArtwork.getAttribute('src') !== artworkSource) {
    if (artworkSource) {
      musicArtwork.src = artworkSource;
    } else {
      musicArtwork.removeAttribute('src');
    }
  }
  musicArtwork.hidden = !available || !session.thumbnail;
  document.querySelector('.music-artwork-placeholder').hidden = musicArtwork.hidden;
  for (const button of [musicPrevious, musicPlayPause, musicNext]) {
    button.disabled = !available || !session.sessionId;
  }
  const isPlaying = available && session.playbackStatus === 'Playing';
  if (!controllingMusic) {
    updatePlayPauseButton(isPlaying);
  }
}

function updatePlayPauseButton(isPlaying) {
  const playPauseIconSource = isPlaying ? 'pillicons/pause.png' : 'pillicons/play.png';
  if (musicPlayPauseIcon.getAttribute('src') !== playPauseIconSource) {
    musicPlayPauseIcon.src = playPauseIconSource;
    musicPlayPauseIcon.classList.remove('is-changing');
    void musicPlayPauseIcon.offsetWidth;
    musicPlayPauseIcon.classList.add('is-changing');
  }
  musicPlayPause.setAttribute(
    'aria-label',
    isPlaying ? 'Pause' : 'Play',
  );
}

async function refreshMusicSession() {
  if (refreshingMusic || controllingMusic) {
    return;
  }

  refreshingMusic = true;
  try {
    renderMusicSession(await window.pillApp.getMediaSession());
  } catch (error) {
    currentMediaSession = undefined;
    for (const button of [musicPrevious, musicPlayPause, musicNext]) {
      button.disabled = true;
    }
    musicStatus.textContent = 'Could not read Windows media session.';
    console.error('Failed to read Windows media session:', error);
  } finally {
    refreshingMusic = false;
  }
}

async function controlMusic(action) {
  if (!currentMediaSession || !currentMediaSession.sessionId) {
    return;
  }

  if (action === 'toggle') {
    updatePlayPauseButton(musicPlayPause.getAttribute('aria-label') !== 'Pause');
  }

  const controlButton = action === 'next'
    ? musicNext
    : action === 'previous'
      ? musicPrevious
      : undefined;
  if (controlButton) {
    controlButton.classList.remove('is-bumping');
    void controlButton.offsetWidth;
    controlButton.classList.add('is-bumping');
  }

  for (const button of [musicPrevious, musicPlayPause, musicNext]) {
    button.disabled = true;
  }
  controllingMusic = true;
  musicStatus.textContent = 'Updating player...';
  try {
    await window.pillApp.controlMediaSession(currentMediaSession.sessionId, action);
    controllingMusic = false;
    await refreshMusicSession();
  } catch (error) {
    controllingMusic = false;
    await refreshMusicSession();
    musicStatus.textContent = 'Could not control the current track.';
    console.error('Failed to control Windows media session:', error);
  } finally {
    controllingMusic = false;
    if (currentMediaSession) {
      musicPrevious.disabled = false;
      musicPlayPause.disabled = false;
      musicNext.disabled = false;
    }
  }
}

function finishVolumeAdjustment() {
  setVolumeControlsOpen(false);
  volumeSlider.disabled = true;
}

window.pillApp.onShortcut((action) => {
  if (action === 'toggle-idle-visibility') {
    pill.classList.toggle('idle-transparent');
  } else if (action === 'open-apps-search') {
    openAppsFromShortcut();
  } else if (action === 'app-switcher-next') {
    stepAppSwitcher();
  } else if (action === 'app-switcher-release') {
    closeAppSwitcher(true);
  }
});

function showAppSwitcherSelection() {
  const selected = appSwitcherWindows[appSwitcherIndex];
  const entry = document.createElement('div');
  entry.className = 'app-switcher-entry';
  const name = document.createElement('span');
  name.className = 'app-switcher-name';
  name.textContent = selected ? selected.appName : 'No open apps';
  const title = document.createElement('span');
  title.className = 'app-switcher-title';
  title.textContent = selected && selected.title !== selected.appName ? selected.title : '';
  title.hidden = !title.textContent;
  entry.append(name, title);

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  for (const previousEntry of appSwitcherTrack.querySelectorAll('.app-switcher-entry:not(.is-leaving)')) {
    if (reduceMotion) {
      previousEntry.remove();
    } else {
      previousEntry.classList.add('is-leaving');
      previousEntry.addEventListener('animationend', () => previousEntry.remove(), { once: true });
    }
  }
  if (!reduceMotion) {
    entry.classList.add('is-entering');
  }
  appSwitcherTrack.append(entry);
}

function stepAppSwitcher() {
  if (!appSwitcherOpen) {
    openAppSwitcher();
    return;
  }

  appSwitcherSteps += 1;
  if (appSwitcherWindows && appSwitcherWindows.length > 1) {
    appSwitcherIndex = (appSwitcherIndex + 1) % appSwitcherWindows.length;
    showAppSwitcherSelection();
  }
}

async function openAppSwitcher() {
  if (notificationOpen || animating || opening) {
    return;
  }

  const requestId = ++appSwitcherRequestId;
  appSwitcherOpen = true;
  appSwitcherWindows = undefined;
  appSwitcherSteps = 1;
  appSwitcherCommitRequested = false;
  const windowsLoad = window.pillApp.getOpenWindows();
  window.pillApp.setInteractive(true);

  if (settingsOpen) {
    await closePillSettings(false, true);
    if (requestId !== appSwitcherRequestId) {
      return;
    }
    if (settingsOpen) {
      appSwitcherOpen = false;
      return;
    }
  }
  // Taller panels must finish shrinking before the window does, or the pill gets clipped.
  const shrinking = appsOpen
    || pill.classList.contains('apps-closing')
    || pill.classList.contains('music-open');
  if (appsOpen) {
    setAppsPanelOpen(false, false);
  }
  if (pill.classList.contains('music-open')) {
    setMusicControlsOpen(false, false);
  }
  finishVolumeAdjustment();
  keyboardPinned = true;

  const showAppSwitcher = () => {
    expanded = true;
    pill.setAttribute('aria-expanded', 'true');
    pill.classList.add('app-switcher-open');
    appSwitcher.setAttribute('aria-hidden', 'false');
    appSwitcher.inert = false;
  };
  opening = true;
  try {
    if (shrinking) {
      showAppSwitcher();
      await waitForPillTransition();
      if (requestId !== appSwitcherRequestId) {
        return;
      }
    }
    await window.pillApp.setAppSwitcherOpen(true);
  } catch (error) {
    console.error('Failed to open the app switcher:', error);
  } finally {
    opening = false;
  }
  if (requestId !== appSwitcherRequestId) {
    return;
  }
  showAppSwitcher();

  let windows;
  try {
    windows = await windowsLoad;
  } catch (error) {
    console.error('Failed to load open apps:', error);
    windows = [];
  }
  if (requestId !== appSwitcherRequestId) {
    return;
  }
  appSwitcherWindows = windows;
  appSwitcherIndex = windows.length > 0 ? appSwitcherSteps % windows.length : 0;
  showAppSwitcherSelection();
  if (appSwitcherCommitRequested) {
    closeAppSwitcher(true);
  }
}

async function closeAppSwitcher(commit) {
  if (!appSwitcherOpen) {
    return;
  }
  if (commit && !appSwitcherWindows) {
    appSwitcherCommitRequested = true;
    return;
  }

  // Cancelling returns to the app that was active before the pill took focus.
  const selected = appSwitcherWindows
    ? appSwitcherWindows[commit ? appSwitcherIndex : 0]
    : undefined;
  const requestId = ++appSwitcherRequestId;
  appSwitcherOpen = false;
  appSwitcherWindows = undefined;
  keyboardPinned = false;
  appSwitcher.setAttribute('aria-hidden', 'true');
  appSwitcher.inert = true;
  if (selected) {
    window.pillApp.activateWindow(selected.hwnd).catch((error) => {
      console.error('Failed to switch to the selected app:', error);
    });
  }

  const stayExpanded = pill.matches(':hover');
  if (!stayExpanded) {
    expanded = false;
    pill.setAttribute('aria-expanded', 'false');
  }
  pill.classList.remove('app-switcher-open');
  await waitForPillTransition();
  if (requestId !== appSwitcherRequestId) {
    return;
  }
  appSwitcherTrack.replaceChildren();
  try {
    if (stayExpanded) {
      await window.pillApp.setAppSwitcherOpen(false);
    } else {
      await window.pillApp.setExpanded(false);
    }
  } catch (error) {
    console.error('Failed to close the app switcher:', error);
  }
  if (!notificationOpen && notificationQueue.length > 0) {
    showNextNotification();
  }
}

async function openAppsFromShortcut() {
  if (notificationOpen || animating || opening || appSwitcherOpen) {
    return;
  }

  if (appsOpen) {
    if (pill.matches(':hover')) {
      setAppsPanelOpen(false);
    } else {
      collapsePill();
    }
    return;
  }

  window.pillApp.setInteractive(true);

  if (settingsOpen) {
    await closePillSettings(false, true);
    if (settingsOpen) {
      return;
    }
  }

  keyboardPinned = !pill.matches(':hover');
  if (!expanded) {
    await expandPill(true);
  }
  if (!expanded || animating || opening) {
    keyboardPinned = false;
    return;
  }

  await setAppsPanelOpen(true);
  if (appsOpen) {
    appsSearch.focus();
  } else {
    keyboardPinned = false;
  }
}

async function collapsePill() {
  if (appSwitcherOpen) {
    await closeAppSwitcher(false);
    return;
  }
  if (!expanded || animating) {
    return;
  }
  keyboardPinned = false;

  if (settingsOpen) {
    await closePillSettings(true);
    return;
  }

  if (appsOpen) {
    setAppsPanelOpen(false, false);
  }

  animating = true;
  expanded = false;
  pill.setAttribute('aria-expanded', 'false');
  if (pill.classList.contains('music-open')) {
    pill.classList.add('music-closing');
  }
  if (pill.classList.contains('music-open')) {
    setMusicControlsOpen(false, false);
  }
  setVolumeControlsOpen(false);
  await waitForPillTransition();
  pill.classList.remove('music-closing');
  try {
    await window.pillApp.setExpanded(false);
  } catch (error) {
    console.error('Failed to collapse pill window:', error);
  } finally {
    animating = false;
  }
}

async function closePillSettings(collapse = false, keepOpen = false) {
  if (!settingsOpen || animating || opening) {
    return;
  }

  animating = true;
  settingsOpen = false;
  if (collapse) {
    expanded = false;
    pill.setAttribute('aria-expanded', 'false');
    pill.classList.add('settings-collapse');
  } else {
    pill.classList.add('settings-returning');
  }
  pill.classList.add('settings-closing');
  pillSettingsMenu.setAttribute('aria-hidden', 'true');
  pillSettingsMenu.inert = true;
  await waitForPillTransition();

  try {
    if (collapse) {
      await window.pillApp.setExpanded(false);
    } else {
      await window.pillApp.setSettingsOpen(false);
    }
  } catch (error) {
    console.error('Failed to close the pill settings menu:', error);
    settingsOpen = true;
    if (collapse) {
      expanded = true;
      pill.setAttribute('aria-expanded', 'true');
    }
    pill.classList.remove('settings-closing', 'settings-collapse', 'settings-returning');
    pillSettingsMenu.setAttribute('aria-hidden', 'false');
    pillSettingsMenu.inert = false;
    animating = false;
    return;
  }

  pill.classList.remove('settings-open', 'settings-closing', 'settings-collapse', 'settings-returning');
  animating = false;
}

async function openPillSettings() {
  if (settingsOpen) {
    await closePillSettings();
    return;
  }

  if (notificationOpen || animating || opening || appSwitcherOpen) {
    return;
  }

  if (pill.classList.contains('music-open')) {
    setMusicControlsOpen(false, false);
  }
  if (appsOpen) {
    await setAppsPanelOpen(false);
  }
  finishVolumeAdjustment();

  opening = true;
  window.pillApp.setInteractive(true);
  expanded = true;
  settingsOpen = true;
  pill.setAttribute('aria-expanded', 'true');
  pill.classList.add('settings-open', 'settings-switching-out', 'settings-entering');
  pillSettingsMenu.setAttribute('aria-hidden', 'true');
  pillSettingsMenu.inert = true;
  try {
    await window.pillApp.setSettingsOpen(true);
  } catch (error) {
    opening = false;
    settingsOpen = false;
    expanded = false;
    pill.setAttribute('aria-expanded', 'false');
    pill.classList.remove('settings-open', 'settings-switching-out', 'settings-entering');
    console.error('Failed to open the pill elements menu:', error);
    return;
  }

  await waitForPillTransition();
  pill.classList.remove('settings-switching-out');
  pillSettingsMenu.setAttribute('aria-hidden', 'false');
  pillSettingsMenu.inert = false;
  requestAnimationFrame(() => {
    pill.classList.remove('settings-entering');
  });
  opening = false;
  window.pillApp.setInteractive(true);
  if (!keepOpen && !pill.matches(':hover')) {
    collapsePill();
  }
}

async function expandPill(keepOpen = false) {
  if (animating || opening || expanded) {
    return;
  }

  opening = true;
  try {
    await window.pillApp.setExpanded(true);
  } catch (error) {
    opening = false;
    console.error('Failed to expand pill window:', error);
    return;
  }
  expanded = true;
  pill.setAttribute('aria-expanded', 'true');
  await waitForPillTransition();
  opening = false;

  if (!keepOpen && expanded && !pill.matches(':hover')) {
    collapsePill();
  }
}

pill.addEventListener('mouseenter', () => {
  if (notificationOpen) {
    return;
  }
  keyboardPinned = false;
  if (!expanded) {
    window.pillApp.setInteractive(true);
  }
});

pill.addEventListener('mouseleave', () => {
  if (notificationOpen || appSwitcherOpen) {
    return;
  }
  if (expanded) {
    if (!opening && !keyboardPinned) {
      collapsePill();
    }
  } else {
    window.pillApp.setInteractive(false);
  }
});

pill.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  openPillSettings();
});

pill.addEventListener('click', (event) => {
  if (event.target !== pill) {
    return;
  }

  if (expanded) {
    collapsePill();
  } else {
    expandPill();
  }
});

pillSettingsMenu.addEventListener('click', (event) => {
  const optionButton = event.target.closest('[data-pill-option]');
  if (!optionButton) {
    return;
  }

  const key = optionButton.dataset.pillOption;
  const enabled = !pillOptions[key];
  pillOptions[key] = enabled;
  applyPillOption(key);
  savePillOptions();

  if (enabled) {
    return;
  }

  if (key === 'music' && pill.classList.contains('music-open')) {
    setMusicControlsOpen(false, false);
  } else if (key === 'apps' && appsOpen) {
    setAppsPanelOpen(false);
  } else if (key === 'volume' && pill.classList.contains('volume-adjusting')) {
    finishVolumeAdjustment();
  }
});

document.addEventListener('keydown', (event) => {
  if (appSwitcherOpen && (event.key === 'Escape' || event.key === 'Enter')) {
    event.preventDefault();
    closeAppSwitcher(event.key === 'Enter');
  } else if (event.key === 'Escape' && settingsOpen) {
    event.preventDefault();
    collapsePill();
  } else if (event.key === 'Escape' && appsOpen) {
    event.preventDefault();
    collapsePill();
  }
});

pill.addEventListener('click', (event) => {
  if (
    pill.classList.contains('volume-adjusting')
    && !volumeToggle.contains(event.target)
    && !volumeSlider.contains(event.target)
  ) {
    finishVolumeAdjustment();
  }
});

musicToggle.addEventListener('click', async () => {
  const isOpen = musicToggle.getAttribute('aria-expanded') !== 'true';
  if (isOpen && (appsOpen || pill.classList.contains('apps-closing'))) {
    switchAppsToMusic();
    return;
  }
  if (appsOpen) {
    await setAppsPanelOpen(false, false);
  }
  setVolumeControlsOpen(false);
  setMusicControlsOpen(isOpen);
});

appsToggle.addEventListener('click', () => setAppsPanelOpen(!appsOpen));
appsSearch.addEventListener('input', renderLaunchableApps);
appsList.addEventListener('click', (event) => {
  const button = event.target.closest('.app-launch-button');
  if (button) {
    launchSelectedApp(button);
  }
});

musicPrevious.addEventListener('click', () => controlMusic('previous'));
musicPlayPause.addEventListener('click', () => controlMusic('toggle'));
musicNext.addEventListener('click', () => controlMusic('next'));

volumeToggle.addEventListener('click', async () => {
  const isOpen = !pill.classList.contains('volume-adjusting');
  if (appsOpen) {
    setAppsPanelOpen(false);
  }
  if (pill.classList.contains('music-open')) {
    setMusicControlsOpen(false);
  }
  setVolumeControlsOpen(isOpen);
  volumeError.textContent = '';

  if (!isOpen) {
    volumeSlider.disabled = true;
    return;
  }

  volumeSlider.disabled = true;
  try {
    const volume = await window.pillApp.getVolume();
    if (!pill.classList.contains('volume-adjusting')) {
      return;
    }

    volumeSlider.value = String(volume);
    volumeValue.value = `${volume}%`;
    volumeSlider.disabled = false;
    volumeSlider.focus();
  } catch (error) {
    if (pill.classList.contains('volume-adjusting')) {
      volumeError.textContent = 'Could not read Windows volume.';
    }
    console.error('Failed to read system volume:', error);
  }
});

volumeSlider.addEventListener('input', async () => {
  const volume = Number(volumeSlider.value);
  volumeValue.value = `${volume}%`;
  volumeError.textContent = '';

  try {
    await window.pillApp.setVolume(volume);
  } catch (error) {
    volumeError.textContent = 'Could not set Windows volume.';
    console.error('Failed to set system volume:', error);
  }
});
