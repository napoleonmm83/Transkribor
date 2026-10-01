import { useEffect, useRef, type ReactNode } from 'react'
import { useMatch } from 'react-router-dom'
import { useProjects } from './useProjects'
import { useProjectFiles } from './useProjectFiles'
import { useActiveJob } from './useActiveJob'
import { Ctx } from './useProjektDaten'

export function ProjektDatenProvider({ children }: { children: ReactNode }) {
  const projekte = useProjects()
  // Zwei Aufrufe statt eines optionalen Parameters: `useMatch('/p/:project/:base?')` waere
  // kuerzer, faellt aber je nach Router-Version auf die Nase — zwei Muster sind eindeutig.
  const mitDatei = useMatch('/p/:project/:base')
  const nurProjekt = useMatch('/p/:project')
  const projekt = (mitDatei ?? nurProjekt)?.params.project ?? null
  const datei = useProjectFiles(projekt ?? '')
  const { adopt, onSettled } = useActiveJob()

  // ALLE laufenden Jobs adoptieren, nicht nur die des offenen Projekts. Vorher stand dieser
  // Effekt in EditorView UND ProjectWorkspace -- wer die App auf "/" oder "/einstellungen"
  // neu startete, waehrend ein Lauf lief, sah auf EINEM Schirm die Karte "Laeuft gerade · 1"
  // und daneben "Bereit" in der Statuszeile, und bekam am Ende weder Systemmeldung noch
  // Taskleistenbalken. Verbraucher filtern ohnehin auf ihr Projekt (mergePhases-Kommentar).
  // `adopt` ist idempotent (gleiche Kennung -> unveraendertes prev), ein Aufruf zu viel
  // schadet also nicht; einer zu wenig schon.
  const aktive = projekte.projects.flatMap(p => (p.active_jobs ?? []).map(j => ({ ...j, project: p.name })))
  const signatur = aktive.map(j => `${j.project}/${j.id}`).join(',')
  useEffect(() => {
    for (const j of aktive) adopt(j.id, j.project, j.kind, j.bases)
  }, [signatur, adopt])   // eslint-disable-line react-hooks/exhaustive-deps

  // Zweiter Anlass neben dem Summenpoll-Waechter: wird ein Job dieses Prozesses terminal, ist
  // die Dateiliste veraltet (eine frisch geschriebene edit.json sieht der Summenpoll erst beim
  // naechsten Durchlauf). Stand vorher wortgleich in EditorView UND ProjectWorkspace — seit die
  // Daten geteilt sind, ist das eine globale Angelegenheit und keine der einzelnen Seite.
  // Lokale Konstanten statt projekte.refresh/datei.refresh direkt im Dep-Array: sonst meldet
  // exhaustive-deps "projekte"/"datei" fehlen -- mit den Konstanten sieht die Regel echte,
  // stabile Referenzen und bleibt ein echtes Netz gegen kuenftig instabile refresh-Funktionen.
  const projekteRefresh = projekte.refresh
  const dateiRefresh = datei.refresh
  useEffect(() => onSettled(() => { projekteRefresh(); dateiRefresh() }),
    [onSettled, projekteRefresh, dateiRefresh])

  // Der billige Waechter ueber die Dateiliste: aendern sich `dateien`/`fertig` in der
  // Zusammenfassung, hat sich auf der Platte etwas getan (ein Job mittendrin, oder eine von
  // Hand hineinkopierte Datei) — dann und nur dann neu laden. Ohne ihn bliebe eine fertig
  // transkribierte Datei bis zum Laufende deaktiviert, weil `has_raw` nur ueber diesen Abruf
  // hereinkommt und `onSettled` erst am Ende des GANZEN Jobs feuert.
  //
  // NICHT beim allerersten Eintreffen feuern: der Sprung von "unbekannt" auf die erste Zahl
  // ist keine Aenderung auf der Platte, und den ersten Abruf erledigt useProjectFiles selbst.
  //
  // Stand vorher wortgleich in EditorView.tsx UND ProjectWorkspace.tsx.
  const p = projekte.projects.find(x => x.name === projekt)
  const letzteZahlen = useRef<{ projekt: string; dateien: number; fertig: number } | null>(null)
  useEffect(() => {
    if (!p || !projekt) { letzteZahlen.current = null; return }
    const vorher = letzteZahlen.current
    letzteZahlen.current = { projekt, dateien: p.dateien, fertig: p.fertig }
    // Projektwechsel ist kein Anlass: die neue Liste holt useProjectFiles ohnehin selbst.
    if (vorher && vorher.projekt === projekt &&
        (vorher.dateien !== p.dateien || vorher.fertig !== p.fertig)) datei.refresh()
  }, [projekt, p?.dateien, p?.fertig])   // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Ctx.Provider value={{ projekte, dateien: { projekt, ...datei } }}>{children}</Ctx.Provider>
  )
}

