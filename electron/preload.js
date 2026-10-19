'use strict';
// Puente mínimo entre la interfaz y la app de escritorio (diálogos nativos).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pstx', {
  isDesktop: true,
  pickFiles: () => ipcRenderer.invoke('pick-files'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  openDataFolder: () => ipcRenderer.invoke('open-data-folder'),
  deleteOldLibrary: () => ipcRenderer.invoke('delete-old-library'),
});
