'use strict'
/** Schmale Bruecke: die Statusseite darf nur die hier aufgezaehlten Dinge, sonst nichts (contextIsolation). */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('transkribor', {
  status: () => ipcRenderer.invoke('status'),
  einrichten: () => ipcRenderer.invoke('einrichten'),
  // Der Rueckweg des laengsten Laufs der App (#242) — ohne Argument, die laufende
  // Einrichtung lebt im Hauptprozess; ein Abbruch ohne Lauf ist wirkungslos.
  abbrechen: () => ipcRenderer.invoke('einrichten:abbrechen'),
  logs: () => ipcRenderer.invoke('logs'),
  protokollOeffnen: () => ipcRenderer.invoke('protokollOeffnen'),
  // Ohne Argument, und das ist der Punkt (#218): der Hauptprozess kennt das Verzeichnis
  // selbst. Naehme der Kanal einen Pfad entgegen, waere aus der schmalen Bruecke ein
  // „oeffne beliebiges Verzeichnis" geworden — fuer alles, was in diesem Fenster laeuft,
  // und dort laeuft Transkripttext, der aus einem URL-Import stammen kann.
  projekteOeffnen: () => ipcRenderer.invoke('projekteOeffnen'),
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
