const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pillApp', {
  setInteractive: (interactive) => ipcRenderer.send('pill:set-interactive', interactive),
  setExpanded: (expanded) => ipcRenderer.invoke('pill:set-expanded', expanded),
  focusWindow: () => ipcRenderer.invoke('pill:focus-window'),
  setAppsOpen: (isOpen) => ipcRenderer.send('pill:set-apps-open', isOpen),
  setMusicOpen: (isOpen) => ipcRenderer.send('pill:set-music-open', isOpen),
  getVolume: () => ipcRenderer.invoke('pill:get-volume'),
  setVolume: (volume) => ipcRenderer.invoke('pill:set-volume', volume),
  getApps: () => ipcRenderer.invoke('pill:get-apps'),
  launchApp: (id) => ipcRenderer.invoke('pill:launch-app', id),
  getRunningWindows: () => ipcRenderer.invoke('pill:get-running-windows'),
  toggleRunningWindow: (id) => ipcRenderer.invoke('pill:toggle-running-window', id),
  activateRunningWindow: (id) => ipcRenderer.invoke('pill:activate-running-window', id),
  endRunningAppSelection: () => ipcRenderer.send('pill:running-selection-ended'),
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
