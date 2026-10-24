'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, cb) => ipcRenderer.on(channel, (_e, payload) => cb(payload));

contextBridge.exposeInMainWorld('hud', {
  onShow: (cb) => on('overlay:show', cb),
  onState: (cb) => on('overlay:state', cb),
  onPage: (cb) => on('overlay:page', cb),
  onHide: (cb) => on('overlay:hide', cb),
  // захват указателя (режим «забирать фокус»): смещения мыши идут в main отсюда, а не из uiohook
  move: (dx, dy) => ipcRenderer.send('overlay:move', dx, dy),
  pointerLock: (locked) => ipcRenderer.send('overlay:pointer-lock', !!locked),
});
