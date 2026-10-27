const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pillApp', {
  setInteractive: (interactive) => ipcRenderer.send('pill:set-interactive', interactive),
  setExpanded: (expanded) => ipcRenderer.invoke('pill:set-expanded', expanded),
  setAppsOpen: (isOpen) => ipcRenderer.send('pill:set-apps-open', isOpen),
  setMusicOpen: (isOpen) => ipcRenderer.send('pill:set-music-open', isOpen),
  getVolume: () => ipcRenderer.invoke('pill:get-volume'),
  setVolume: (volume) => ipcRenderer.invoke('pill:set-volume', volume),
  getApps: () => ipcRenderer.invoke('pill:get-apps'),
  launchApp: (id) => ipcRenderer.invoke('pill:launch-app', id),
  getRunningWindows: () => ipcRenderer.invoke('pill:get-running-windows'),
  toggleRunningWindow: (id) => ipcRenderer.invoke('pill:toggle-running-window', id),
  getMediaSession: () => ipcRenderer.invoke('pill:get-media-session'),
  controlMediaSession: (sessionId, action) => ipcRenderer.invoke('pill:control-media-session', sessionId, action),
});
