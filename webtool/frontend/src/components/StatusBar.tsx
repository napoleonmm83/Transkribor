import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Settings } from 'lucide-react'
import { ThemeToggle } from './ThemeToggle'
import { useActiveJob, zeigtLauf } from '@/hooks/useActiveJob'
import { useUpdate } from '@/hooks/useUpdate'
import { getHardware } from '@/lib/api'
import { KIND_LABEL } from '@/lib/jobPhases'
import type { UpdateZustand } from '@/lib/types'

/**
 * Was in der Fusszeile ueber ein Update steht — `null`, solange es nichts zu tun gibt.
 *
 * Bewusst nur die Zustaende, die eine Handlung nach sich ziehen: „aktuell“ und „prueft“
 * sind Rauschen in einer Zeile, die man dauernd im Blick hat. Der Text fuehrt auf die
 * Versionsseite, wo die vollstaendige Steuerung steht — die sechs Zustaende samt
 * Fortschrittsbalken und Protokoll-Link ein zweites Mal in 24 px Hoehe nachzubauen,
 * waere zwei Fassungen derselben Sache.
 *
 * `keine-quelle` und `kein-updater` sind die Ausnahmen unter `nicht_moeglich`: die anderen
 * Gruende sind Eigenschaften der Installation, die der Nutzer kennt (Entwicklungsbetrieb,
 * .deb-Paket) — diese beiden sind DEFEKTE, die ihn dauerhaft von Updates abschneiden, ohne
 * dass er es merkt. Sie ziehen eine Handlung nach sich (neu herunterladen bzw. ins Protokoll
 * sehen), also gehoeren sie hierher.
 */
function updateHinweis(z: UpdateZustand | null): string | null {
  if (!z) return null
  if (z.art === 'nicht_moeglich' && (z.grund === 'keine-quelle' || z.grund === 'kein-updater')) {
    return 'Updates nicht möglich'
  }
  if (z.art === 'verfuegbar' || z.art === 'verfuegbar_manuell') return `Update ${z.neue} verfügbar`
  // Kein „Update verfügbar": es ist keines, das dieser Mac starten könnte. Der Satz nennt die
  // Zahl, weil „nicht möglich" ohne sie zum Suchen einlädt — die Einzelheiten stehen auf der
  // Versionsseite, wie bei jedem anderen Zustand auch (#536).
  if (z.art === 'zu_altes_os') return `Update ${z.neue} braucht macOS ${z.braucht}`
  if (z.art === 'laedt') return `Update lädt · ${Math.round(z.prozent)} %`
  if (z.art === 'bereit') return `Update ${z.neue} bereit`
  if (z.art === 'fehler') return 'Update-Prüfung fehlgeschlagen'
  return null
}

/**
 * Die Fusszeile der App. Sie zeigt ausschliesslich, was ohnehin schon bekannt ist —
 * kein eigener Zustand, keine eigene Abfrageschleife: laufende Jobs kommen aus dem
 * JobProvider, der Update-Zustand aus der Electron-Bruecke, das Rechenwerk einmalig
 * beim Start.
 *
 * Faellt eine der Quellen aus, bleibt ihr Feld LEER statt einen Fehler zu tragen.
 * Eine Statuszeile, in der Fehlermeldungen stehen, ist eine, die man ausblendet.
 */
export function StatusBar() {
  const { jobs } = useActiveJob()
  const { zustand } = useUpdate()
  const [rechenwerk, setRechenwerk] = useState('')

  // Einmal je Serverlauf ermittelt (GET /api/hardware ist auf der Backend-Seite gecacht) —
  // ein Poll waere hier sinnlos, die Grafikkarte wechselt nicht zur Laufzeit.
  useEffect(() => { getHardware().then(h => setRechenwerk(h.asr)).catch(() => {}) }, [])

  const laufend = jobs.filter(j => zeigtLauf(j.status))
  const text = laufend.length === 0
    ? 'Bereit'
    : `${laufend.length} ${laufend.length === 1 ? 'Lauf' : 'Läufe'} · ` +
      laufend.map(j => `${j.project}: ${KIND_LABEL[j.kind] ?? j.kind}`).join(' · ')

  const hinweis = updateHinweis(zustand)
  // Electron kennt die Version der LAUFENDEN App; im Browser gibt es die Bruecke nicht,
  // dort ist der zur Bauzeit eingesetzte Wert die einzige — und richtige — Quelle.
  const version = zustand?.version ?? __APP_VERSION__

  return (
    // col-span-1 md:col-span-2: auf breiten Fenstern steht sie neben der Leiste in einer
    // eigenen Spalte -- ohne den Span reichte sie nur unter die Inhaltsspalte.
    <footer className="col-span-1 flex h-6 shrink-0 items-center gap-4 border-t bg-background px-3 text-xs text-muted-foreground md:col-span-2">
      <span className="min-w-0 flex-1 truncate" aria-live="polite">{text}</span>
      {hinweis && (
        // aria-live: ein Update taucht auf, ohne dass jemand etwas angeklickt hat.
        <Link to="/version" aria-live="polite"
          className="shrink-0 font-medium text-primary underline-offset-2 hover:underline
                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {hinweis}
        </Link>
      )}
      {/* Unter `md` ist die Seitenleiste ausgeblendet (AppShell) — dann ist die Palette der
          EINZIGE vollstaendige Weg zu den Projekten, und ihr Hinweis war mit dem Suchfeld der
          alten Galerie verschwunden (#73). Genau da, wo die Leiste fehlt, steht er jetzt: die
          Fusszeile ist auf jeder Route sichtbar. Kein Knopf, sondern der Text — die Palette
          oeffnet sich ueber ihren eigenen Tastatur-Zuhoerer (ProjektPalette.tsx); ein zweiter
          Ausloeser braeuchte einen gehobenen Zustand fuer einen Fall, den es nur unter `md`
          gibt. Reiner Browser-Betrieb im schmalen Fenster; das Electron-Fenster hat
          `minWidth: 900` und kommt hier nie an. */}
      <span className="shrink-0 md:hidden">
        {/* „Ctrl“, nicht „Strg“: die Palette nimmt `ctrlKey || metaKey`, und macOS ist ein
            ausgeliefertes Ziel (dmg) — dort steht auf der Taste „ctrl“, ein „Strg“ gibt es
            nicht. Die App schreibt es anderswo schon so (`Abspielen (Ctrl+Space)`). */}
        <kbd className="rounded border px-1 font-sans">Ctrl</kbd>
        <span aria-hidden="true"> + </span>
        <kbd className="rounded border px-1 font-sans">K</kbd> für alle Projekte
      </span>
      {/* Der einzige Weg zu den Einstellungen stand bisher auf der Uebersicht -- aus dem
          Editor musste man erst dorthin zurueck. Die Fusszeile ist auf JEDER Seite da. */}
      <Link to="/einstellungen"
        className="inline-flex shrink-0 items-center gap-1 underline-offset-2 hover:text-foreground
                   hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Settings className="size-3" aria-hidden="true" /> Einstellungen
      </Link>
      {/* Aus derselben Not wie der Einstellungen-Link: er stand nur in der Editor-Leiste. */}
      <ThemeToggle />
      {rechenwerk && <span className="shrink-0">{rechenwerk}</span>}
      {/* Die Nummer IST der Weg zur Versionsseite — sie steht auf jeder Route, und wer
          wissen will, welche Fassung laeuft, klickt genau hier. */}
      <Link to="/version"
        className="shrink-0 tabular-nums underline-offset-2 hover:text-foreground hover:underline
                   focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        v{version}
      </Link>
    </footer>
  )
}
