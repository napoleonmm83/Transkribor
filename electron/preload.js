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
  // Gibt eine Abmeldefunktion zurueck, damit Hoerer (z.B. in React-Hooks beim Unmount)
  // sich wieder loesen koennen — sonst haeuft ein wiederholt geoeffneter Screen sie an.
  on: (kanal, fn) => {
    if (!['log', 'phase', 'status', 'fehler', 'update'].includes(kanal)) return () => {}
    const hoerer = (_e, nutzlast) => fn(nutzlast)
    ipcRenderer.on(kanal, hoerer)
    return () => ipcRenderer.removeListener(kanal, hoerer)
  },
  // Fuer die Rand-Reserven der eigenen Titelzeile: die Fensterknoepfe stehen auf macOS
  // links, sonst rechts. process.platform gibt es im Renderer nicht (contextIsolation).
  plattform: process.platform,
  titelleisteFarbe: f => ipcRenderer.invoke('titelleisteFarbe', f),
  fortschritt: (a, modus) => ipcRenderer.invoke('fortschritt', a, modus),
})
