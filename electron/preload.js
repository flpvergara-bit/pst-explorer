'use strict';
// Minimal bridge between the UI and the desktop app (native dialogs).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pstx', {
  isDesktop: true,
  pickFiles: () => ipcRenderer.invoke('pick-files'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  openDataFolder: () => ipcRenderer.invoke('open-data-folder'),
  deleteOldLibrary: () => ipcRenderer.invoke('delete-old-library'),
});
