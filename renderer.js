const pill = document.querySelector('.pill');
const pillClock = document.querySelector('.pill-clock');
const pillDate = document.querySelector('.pill-date');
const appsToggle = document.querySelector('.apps-toggle');
const appsControls = document.querySelector('.apps-controls');
const appsSearch = document.querySelector('.apps-search');
const appsList = document.querySelector('.apps-list');
const appsStatus = document.querySelector('.apps-status');
const runningAppsList = document.querySelector('.running-apps-list');
const runningAppsStatus = document.querySelector('.running-apps-status');
const volumeToggle = document.querySelector('.volume-toggle');
const volumeControls = document.querySelector('.volume-controls');
const volumeSlider = document.querySelector('.volume-slider');
const volumeValue = document.querySelector('.volume-value');
const volumeError = document.querySelector('.volume-error');
const musicToggle = document.querySelector('.music-toggle');
const musicControls = document.querySelector('.music-controls');
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
let animating = false;
let opening = false;
let installedApps = [];
let runningRefreshTimer;
let refreshingRunningApps = false;
let musicRefreshTimer;
let refreshingMusic = false;
let controllingMusic = false;
let currentMediaSession;
let notificationTimer;
let notificationQueue = [];
let notificationOpen = false;
let currentNotification;

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

function showNextNotification() {
  clearTimeout(notificationTimer);
  const notification = notificationQueue.shift();
  currentNotification = notification;
  if (!notification) {
    notificationOpen = false;
    notificationToast.setAttribute('aria-hidden', 'true');
    notificationToast.inert = true;
    pill.classList.remove('notification-open');
    window.pillApp.setNotificationOpen(false).catch((error) => {
      console.error('Failed to resize the pill after a notification:', error);
    });
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
  if (!notificationOpen) {
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
    const fallback = setTimeout(finish, 400);

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
          if (!appsControls.classList.contains('is-open') && !pill.classList.contains('apps-closing')) {
            window.pillApp.setMusicOpen(false);
          }
          pill.classList.remove('music-closing');
        }
      });
    }
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

function renderApps() {
  const query = appsSearch.value.trim().toLocaleLowerCase();
  const matches = installedApps.filter((app) => app.name.toLocaleLowerCase().includes(query));
  appsList.replaceChildren();

  if (matches.length === 0) {
    appsStatus.textContent = installedApps.length === 0
      ? 'No Start Menu apps were found.'
      : 'No apps match your search.';
    return;
  }

  appsStatus.textContent = matches.length > 100
    ? `Showing the first 100 of ${matches.length} apps. Refine your search.`
    : '';
  for (const app of matches.slice(0, 100)) {
    const button = document.createElement('button');
    button.className = 'app-result';
    button.type = 'button';
    button.role = 'option';
    button.textContent = app.name;
    button.addEventListener('click', async () => {
      appsStatus.textContent = `Launching ${app.name}...`;
      try {
        await window.pillApp.launchApp(app.id);
        appsStatus.textContent = '';
      } catch (error) {
        appsStatus.textContent = `Could not launch ${app.name}.`;
        console.error('Failed to launch app:', error);
      }
    });
    appsList.append(button);
  }
}

function renderRunningApps(runningApps) {
  runningAppsList.replaceChildren();
  if (runningApps.length === 0) {
    runningAppsStatus.textContent = 'No open apps found.';
    return;
  }

  runningAppsStatus.textContent = '';
  for (const app of runningApps) {
    const button = document.createElement('button');
    const name = document.createElement('span');
    const action = document.createElement('span');
    const actionLabel = app.minimized || !app.active ? 'Open' : 'Minimize';
    button.className = 'running-app';
    button.type = 'button';
    button.setAttribute('role', 'listitem');
    button.setAttribute('aria-label', `${actionLabel} ${app.title}`);
    name.className = 'running-app-name';
    name.textContent = app.title;
    action.className = 'running-app-action';
    action.textContent = actionLabel;
    button.append(name, action);
    button.addEventListener('click', async () => {
      button.disabled = true;
      const progressLabel = actionLabel === 'Open' ? 'Opening' : 'Minimizing';
      runningAppsStatus.textContent = `${progressLabel} ${app.title}...`;
      try {
        await window.pillApp.toggleRunningWindow(app.id);
        await refreshRunningApps();
      } catch (error) {
        runningAppsStatus.textContent = `Could not ${actionLabel.toLowerCase()} ${app.title}.`;
        console.error('Failed to manage running app window:', error);
      } finally {
        button.disabled = false;
      }
    });
    runningAppsList.append(button);
  }
}

async function refreshRunningApps() {
  if (refreshingRunningApps) {
    return;
  }
  refreshingRunningApps = true;
  refreshingRunningApps = true;
  try {
    const runningApps = await window.pillApp.getRunningWindows();
    renderRunningApps(runningApps);
  } catch (error) {
    runningAppsStatus.textContent = 'Could not load open apps.';
    console.error('Failed to load running apps:', error);
  } finally {
    refreshingRunningApps = false;
  }
}

function finishAppsClosing() {
  pill.classList.remove('apps-open', 'apps-closing', 'apps-content-ready');
  appsControls.classList.remove('is-open');
}

function setAppsControlsOpen(isOpen, resizeWindow = true) {
  if (isOpen) {
    pill.classList.remove('apps-closing', 'apps-content-ready');
    pill.classList.add('apps-open');
    appsControls.classList.add('is-open');
    appsControls.setAttribute('aria-hidden', 'false');
    appsControls.inert = false;
    appsToggle.setAttribute('aria-expanded', 'true');
    if (resizeWindow) {
      window.pillApp.setAppsOpen(true);
    }
    waitForPillTransition().then(() => {
      if (pill.classList.contains('apps-open')) {
        pill.classList.add('apps-content-ready');
      }
    });
    refreshRunningApps();
    runningRefreshTimer = setInterval(refreshRunningApps, 5000);
  } else {
    pill.classList.remove('apps-open');
    pill.classList.add('apps-closing');
    appsControls.setAttribute('aria-hidden', 'true');
    appsControls.inert = true;
    appsToggle.setAttribute('aria-expanded', 'false');
    clearInterval(runningRefreshTimer);
    runningRefreshTimer = undefined;

    waitForPillTransition().then(() => {
      if (pill.classList.contains('apps-closing') && expanded) {
        finishAppsClosing();
        if (resizeWindow && !pill.classList.contains('music-open')) {
          window.pillApp.setAppsOpen(false);
        }
      }
    });
  }
}

async function collapsePill() {
  if (!expanded || animating) {
    return;
  }

  animating = true;
  expanded = false;
  pill.setAttribute('aria-expanded', 'false');
  if (pill.classList.contains('music-open')) {
    pill.classList.add('music-closing');
  }
  if (appsControls.classList.contains('is-open')) {
    setAppsControlsOpen(false, false);
  }
  if (pill.classList.contains('music-open')) {
    setMusicControlsOpen(false, false);
  }
  setVolumeControlsOpen(false);
  await waitForPillTransition();
  if (pill.classList.contains('apps-closing')) {
    finishAppsClosing();
  }
  pill.classList.remove('music-closing');
  await window.pillApp.setExpanded(false);
  animating = false;
}

async function expandPill() {
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

  if (expanded && !pill.matches(':hover')) {
    collapsePill();
  }
}

pill.addEventListener('mouseenter', () => {
  if (notificationOpen) {
    return;
  }
  if (!expanded) {
    window.pillApp.setInteractive(true);
  }
});

pill.addEventListener('mouseleave', () => {
  if (notificationOpen) {
    return;
  }
  if (expanded) {
    if (!opening) {
      collapsePill();
    }
  } else {
    window.pillApp.setInteractive(false);
  }
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

pill.addEventListener('click', (event) => {
  if (
    pill.classList.contains('volume-adjusting')
    && !volumeToggle.contains(event.target)
    && !volumeSlider.contains(event.target)
  ) {
    finishVolumeAdjustment();
  }
});

appsToggle.addEventListener('click', async () => {
  const isOpen = appsToggle.getAttribute('aria-expanded') !== 'true';
  if (pill.classList.contains('music-open')) {
    setMusicControlsOpen(false, false);
  }
  setVolumeControlsOpen(false);
  setAppsControlsOpen(isOpen);
  if (!isOpen) {
    return;
  }

  appsStatus.textContent = 'Loading apps...';
  appsSearch.value = '';
  appsSearch.focus();
  try {
    installedApps = await window.pillApp.getApps();
    if (appsControls.classList.contains('is-open')) {
      renderApps();
    }
  } catch (error) {
    appsStatus.textContent = 'Could not load installed apps.';
    console.error('Failed to load installed apps:', error);
  }
});
appsSearch.addEventListener('input', renderApps);
appsSearch.addEventListener('input', renderApps);

musicToggle.addEventListener('click', () => {
  const isOpen = musicToggle.getAttribute('aria-expanded') !== 'true';
  const switchingFromApps = appsControls.classList.contains('is-open');
  if (switchingFromApps) {
    setAppsControlsOpen(false, false);
    finishAppsClosing();
  }
  setVolumeControlsOpen(false);
  setMusicControlsOpen(isOpen, !switchingFromApps);
  if (isOpen && switchingFromApps) {
    waitForPillTransition().then(() => {
      if (pill.classList.contains('music-open')) {
        window.pillApp.setMusicOpen(true);
      }
    });
  }
});

musicPrevious.addEventListener('click', () => controlMusic('previous'));
musicPlayPause.addEventListener('click', () => controlMusic('toggle'));
musicNext.addEventListener('click', () => controlMusic('next'));

volumeToggle.addEventListener('click', async () => {
  const isOpen = !pill.classList.contains('volume-adjusting');
  if (appsControls.classList.contains('is-open')) {
    setAppsControlsOpen(false);
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
