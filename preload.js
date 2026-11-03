const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pillApp', {
  setInteractive: (interactive) => ipcRenderer.send('pill:set-interactive', interactive),
  setExpanded: (expanded) => ipcRenderer.invoke('pill:set-expanded', expanded),
  setSettingsOpen: (isOpen) => ipcRenderer.invoke('pill:set-settings-open', isOpen),
  setAppsOpen: (isOpen) => ipcRenderer.invoke('pill:set-apps-open', isOpen),
  setMusicOpen: (isOpen) => ipcRenderer.send('pill:set-music-open', isOpen),
  setWeatherOpen: (isOpen) => ipcRenderer.invoke('pill:set-weather-open', isOpen),
  getWeather: () => ipcRenderer.invoke('pill:get-weather'),
  setWeatherZip: (zip) => ipcRenderer.invoke('pill:set-weather-zip', zip),
  onWeather: (callback) => {
    const listener = (_event, report) => callback(report);
    ipcRenderer.on('pill:weather', listener);
    return () => ipcRenderer.removeListener('pill:weather', listener);
  },
  getBackdrop: () => ipcRenderer.invoke('pill:get-backdrop'),
  onBackdrop: (callback) => {
    const listener = (_event, backdrop) => callback(backdrop);
    ipcRenderer.on('pill:backdrop', listener);
    return () => ipcRenderer.removeListener('pill:backdrop', listener);
  },
  getVolume: () => ipcRenderer.invoke('pill:get-volume'),
  setVolume: (volume) => ipcRenderer.invoke('pill:set-volume', volume),
  getBatteryStatus: () => ipcRenderer.invoke('pill:get-battery-status'),
  setCenterOpen: (isOpen) => ipcRenderer.invoke('pill:set-center-open', isOpen),
  getNightLight: () => ipcRenderer.invoke('pill:get-night-light'),
  setNightLight: (enabled, strength) => ipcRenderer.invoke('pill:set-night-light', enabled, strength),
  getBatterySaver: () => ipcRenderer.invoke('pill:get-battery-saver'),
  setBatterySaver: (on) => ipcRenderer.invoke('pill:set-battery-saver', on),
  openWindowsSettings: () => ipcRenderer.invoke('pill:open-windows-settings'),
  runPowerAction: (action) => ipcRenderer.invoke('pill:power-action', action),
  getLaunchableApps: () => ipcRenderer.invoke('pill:get-launchable-apps'),
  launchApp: (appId) => ipcRenderer.invoke('pill:launch-app', appId),
  setAppSwitcherOpen: (isOpen) => ipcRenderer.invoke('pill:set-app-switcher-open', isOpen),
  getOpenWindows: () => ipcRenderer.invoke('pill:get-open-windows'),
  activateWindow: (hwnd) => ipcRenderer.invoke('pill:activate-window', hwnd),
  onBatteryPowerSource: (callback) => {
    const listener = (_event, isOnAc) => callback(isOnAc);
    ipcRenderer.on('pill:battery-power-source', listener);
    return () => ipcRenderer.removeListener('pill:battery-power-source', listener);
  },
  onShortcut: (callback) => {
    const listener = (_event, action, data) => callback(action, data);
    ipcRenderer.on('pill:shortcut', listener);
    return () => ipcRenderer.removeListener('pill:shortcut', listener);
  },
  getMediaSession: () => ipcRenderer.invoke('pill:get-media-session'),
  controlMediaSession: (sessionId, action) => ipcRenderer.invoke('pill:control-media-session', sessionId, action),
  openNotificationSettings: () => ipcRenderer.invoke('pill:open-notification-settings'),
  setNotificationOpen: (isOpen) => ipcRenderer.invoke('pill:set-notification-open', isOpen),
  onNotification: (callback) => {
    const listener = (_event, notification) => callback(notification);
    ipcRenderer.on('pill:notification', listener);
    return () => ipcRenderer.removeListener('pill:notification', listener);
  },
  onNotificationListenerStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('pill:notification-listener-status', listener);
    return () => ipcRenderer.removeListener('pill:notification-listener-status', listener);
  },
});
