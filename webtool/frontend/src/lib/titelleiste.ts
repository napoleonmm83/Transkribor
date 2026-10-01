/** Vorhanden = wir laufen unter Electron. Im Browser (webtool.ps1 :8000, Vite :5173) fehlt
 *  das Objekt, und dann gibt es weder ein rahmenloses Fenster noch etwas zu zeichnen. */
export function plattform(): string | null {
  const w = window as unknown as { transkribor?: { plattform?: string } }
  return w.transkribor?.plattform ?? null
}

/** Steuert diese Zeile ein Rasterelement bei? Das Raster der AppShell muss dieselbe Antwort
 *  kennen wie die Komponente selbst — sonst hat es im Browser eine Zeile zu viel. */
export function hatTitelzeile(): boolean { return plattform() !== null }

