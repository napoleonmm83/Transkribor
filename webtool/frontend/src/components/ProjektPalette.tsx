import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useProjekte } from '@/hooks/useProjektDaten'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'

/** Ctrl+K oeffnet die Projektsuche von ueberall -- auch im Editor, wo es kein eigenes
 *  Suchfeld gibt (deshalb steht diese Komponente in App.tsx neben den Routen, nicht in
 *  der Galerie). Das Kuerzel greift NICHT, waehrend in einem Textfeld getippt wird --
 *  dieselbe Regel wie bei Ctrl+←/→ in EditorView.tsx, sonst kapert die Palette das
 *  Tippen im Suchfeld der Galerie oder in einem Segmenttext. */
export function ProjektPalette() {
  const [open, setOpen] = useState(false)
  // Die geteilte Liste (ProjektDatenProvider) pollt ohnehin fuer die Seitenleiste -- ein
  // eigener Schalter je nach Offen-Zustand waere hier wirkungslos, seit Task 3 gibt es nur
  // noch EINEN Poll fuer die ganze App.
  const { projects } = useProjekte()
  const navigate = useNavigate()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'k' || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return
      const el = document.activeElement
      if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement || (el as HTMLElement)?.isContentEditable) return
      e.preventDefault()
      setOpen(o => !o)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const gehe = useCallback((name: string) => {
    setOpen(false)
    navigate(`/p/${encodeURIComponent(name)}`)
  }, [navigate])

  const laufende = projects.filter(p => (p.active_jobs?.length ?? 0) > 0)
  // "Projekte" ohne die laufenden -- sonst stuende jedes laufende Projekt doppelt in der Liste.
  const uebrige = projects.filter(p => (p.active_jobs?.length ?? 0) === 0)

  return (
    <CommandDialog open={open} onOpenChange={setOpen}
      title="Projekte" description="Projekt suchen und öffnen">
      <CommandInput placeholder="Projekt suchen…" />
      <CommandList>
        <CommandEmpty>Keine Projekte gefunden</CommandEmpty>
        {laufende.length > 0 && (
          <CommandGroup heading="Läuft gerade">
            {laufende.map(p => (
              <CommandItem key={p.name} value={p.name} onSelect={() => gehe(p.name)}>
                {p.name}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        <CommandGroup heading="Projekte">
          {uebrige.map(p => (
            <CommandItem key={p.name} value={p.name} onSelect={() => gehe(p.name)}>
              {p.name}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
