'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, cb) => ipcRenderer.on(channel, (_e, payload) => cb(payload));

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('cfg:get'),
  setConfig: (patch) => ipcRenderer.invoke('cfg:set', patch),
  resetSection: (section) => ipcRenderer.invoke('cfg:reset', section),
  getStatus: () => ipcRenderer.invoke('sp:status'),
  getLibrary: (force) => ipcRenderer.invoke('sp:library', !!force),
  testSlot: (i) => ipcRenderer.invoke('sp:test-slot', i),
  stopSound: () => ipcRenderer.invoke('sp:stop'),
  recordHotkey: (target) => ipcRenderer.invoke('hotkey:record', target),
  cancelRecord: () => ipcRenderer.invoke('hotkey:cancel'),
  openDataFolder: () => ipcRenderer.invoke('app:open-data'),
  statsSummary: () => ipcRenderer.invoke('stats:summary'),
  clearStats: () => ipcRenderer.invoke('stats:clear'),
  onConfigChanged: (cb) => on('cfg:changed', cb),
  onLibraryChanged: (cb) => on('library:changed', cb),
  onHotkeyRecorded: (cb) => on('hotkey:recorded', cb),
  onHotkeyRecordCancel: (cb) => on('hotkey:record-cancel', cb),
});
