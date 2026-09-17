import { useEffect, useRef, useState } from 'react'
import { getProjektKontext, saveProjektKontext, type ProjektKontext } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'

type Props = {
  project: string
  offen: boolean
  onOpenChange: (open: boolean) => void
}

export function ProjektKontextDialog({ project, offen, onOpenChange }: Props) {
  return (
    <Dialog open={offen} onOpenChange={onOpenChange}>
      {offen && <ProjektKontextInhalt key={project} project={project} onOpenChange={onOpenChange} />}
    </Dialog>
  )
}

function ProjektKontextInhalt({ project, onOpenChange }: Omit<Props, 'offen'>) {
  const [data, setData] = useState<ProjektKontext | null>(null)
  const [text, setText] = useState('')
  const [fehler, setFehler] = useState('')
  const [speichert, setSpeichert] = useState(false)
  const [versuch, setVersuch] = useState(0)
  const generation = useRef({ active: false })

  useEffect(() => {
    const stand = { active: true }
    generation.current = stand
    getProjektKontext(project).then(d => {
      if (!stand.active) return
      setData(d)
      setText(d.text)
    }).catch(e => {
      if (stand.active) setFehler((e as Error).message)
    })
    return () => { stand.active = false }
  }, [project, versuch])

  const speichern = async () => {
    if (!data || speichert) return
    const stand = generation.current
    setSpeichert(true)
    setFehler('')
    try {
      await saveProjektKontext(project, { ...data, text })
      if (stand.active) onOpenChange(false)
    } catch (e) {
      if (stand.active) setFehler((e as Error).message)
    } finally {
      if (stand.active) setSpeichert(false)
    }
  }

  return (
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Namen &amp; Fachbegriffe</DialogTitle>
          <DialogDescription>
            Bekannte Namen, Orte und Schreibweisen helfen bei der Korrektur aller Aufnahmen in diesem Projekt.
          </DialogDescription>
        </DialogHeader>
        {data ? (
          <div className="grid gap-2">
            <label htmlFor="projektwissen" className="text-sm font-medium">Projektwissen</label>
            <Textarea id="projektwissen" value={text} onChange={e => setText(e.target.value)}
              disabled={speichert} rows={6} aria-describedby="projektwissen-hinweis"
              className="field-sizing-fixed min-h-36 max-h-64 resize-y border-muted-foreground focus-visible:ring-ring focus-visible:ring-2"
              placeholder="Namen, Orte und Fachbegriffe mit korrekter Schreibweise; bei Bedarf kurze Erläuterungen." />
            <p id="projektwissen-hinweis" className="text-sm text-muted-foreground">
              Gilt ab der nächsten Korrektur. Wähle bei fertigen Aufnahmen im Dateimenü „Neu korrigieren“.
              Speichern allein verändert keine Transkripte. Nutze nur Begriffe, die zur Aufnahme passen.
            </p>
          </div>
        ) : !fehler && <p className="text-sm text-muted-foreground">Laden …</p>}
        {fehler && <p role="alert" className="text-sm text-destructive break-words">{fehler}</p>}
        {!data && fehler && <Button variant="outline" onClick={() => { setFehler(''); setVersuch(v => v + 1) }}>Erneut laden</Button>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Abbrechen</Button>
          <Button onClick={speichern} disabled={!data || speichert || text === data.text}>
            {speichert ? 'Speichert …' : 'Speichern'}
          </Button>
        </DialogFooter>
      </DialogContent>
  )
}
