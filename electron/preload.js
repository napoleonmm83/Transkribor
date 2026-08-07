'use strict'
/** Schmale Bruecke: die Statusseite darf genau diese vier Dinge, sonst nichts (contextIsolation). */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('transkribor', {
  status: () => ipcRenderer.invoke('status'),
  einrichten: () => ipcRenderer.invoke('einrichten'),
  logs: () => ipcRenderer.invoke('logs'),
  on: (kanal, fn) => {
    if (!['log', 'phase', 'status', 'fehler'].includes(kanal)) return
    ipcRenderer.on(kanal, (_e, nutzlast) => fn(nutzlast))
  },
})
