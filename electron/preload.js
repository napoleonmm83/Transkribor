'use strict'
/** Schmale Bruecke: die Statusseite darf genau diese fuenf Dinge, sonst nichts (contextIsolation). */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('transkribor', {
  status: () => ipcRenderer.invoke('status'),
  einrichten: () => ipcRenderer.invoke('einrichten'),
  logs: () => ipcRenderer.invoke('logs'),
  protokollOeffnen: () => ipcRenderer.invoke('protokollOeffnen'),
  on: (kanal, fn) => {
    if (!['log', 'phase', 'status', 'fehler'].includes(kanal)) return
    ipcRenderer.on(kanal, (_e, nutzlast) => fn(nutzlast))
  },
})
