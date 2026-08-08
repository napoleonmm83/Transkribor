'use strict'
/** Schmale Bruecke: die Statusseite darf nur die hier aufgezaehlten Dinge, sonst nichts (contextIsolation). */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('transkribor', {
  status: () => ipcRenderer.invoke('status'),
  einrichten: () => ipcRenderer.invoke('einrichten'),
  logs: () => ipcRenderer.invoke('logs'),
  protokollOeffnen: () => ipcRenderer.invoke('protokollOeffnen'),
  update: {
    status: () => ipcRenderer.invoke('update:status'),
    pruefen: () => ipcRenderer.invoke('update:pruefen'),
    laden: () => ipcRenderer.invoke('update:laden'),
    installieren: () => ipcRenderer.invoke('update:installieren'),
  },
  on: (kanal, fn) => {
    if (!['log', 'phase', 'status', 'fehler', 'update'].includes(kanal)) return
    ipcRenderer.on(kanal, (_e, nutzlast) => fn(nutzlast))
  },
})
