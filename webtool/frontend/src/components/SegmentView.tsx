import { useState } from 'react'
import { toast } from 'sonner'
import { CircleHelp, MessageSquare, MessageSquarePlus, Play, ScanSearch, TriangleAlert } from 'lucide-react'
import type { Segment } from '@/lib/types'
import { isCorrected, tokenizeUncertain } from '@/lib/uncertainty'
import { gestrichen } from '@/lib/streichen'
import { UncertainWord } from './UncertainWord'
import { TextEditor, EINGABE_VERWORFEN } from './TextEditor'

function fmt(t: number) { const s = Math.max(0, t | 0); return `${(s / 60) | 0}:${String(s % 60).padStart(2, '0')}` }

/** Die Segment-Flags. Als Emoji (⚠ 🔇) rendern sie je nach System in einer fremden
 *  Schrift, erben die Textfarbe nicht und heissen fuer einen Screenreader gar nichts.
 *  `erklaerung` steht hier statt in der Legende: ein Symbolname allein ("Halluzination")
 *  sagt niemandem, was er mit dem Segment tun soll. */
export const FLAGS = [
  { key: 'hallucination', icon: TriangleAlert, titel: 'Halluzination',
    erklaerung: 'Auffällig repetitiver Text — Whisper hat sich womöglich verhakt. Gegen die Aufnahme prüfen.' },
  { key: 'low_conf', icon: CircleHelp, titel: 'Geringe Konfidenz',
    erklaerung: 'Whisper war im ganzen Segment unsicher, nicht nur bei einzelnen Wörtern.' },
] as const

export function SegmentView({ seg, active, onPlay, updateSegment, dimmen = false, aktiverTreffer = false }: {
  seg: Segment; active: boolean; onPlay: () => void;
  updateSegment: (id: number, patch: Partial<Segment>) => void;
  dimmen?: boolean; aktiverTreffer?: boolean;
}) {
  const [editing, setEditing] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  // EIN Zustand fuer die Notiz, obwohl zwei Knoepfe hineinfuehren (das Symbol, solange keine
  // Notiz da ist; die Notizzeile selbst, sobald eine steht). Zwei Zustaende waeren zwei
  // Wahrheiten darueber, ob das Feld offen ist.
  const [notiz, setNotiz] = useState(false)
  const corrected = isCorrected(seg)
  const flags = FLAGS.filter(f => seg.flags[f.key])
  const rawTokens = tokenizeUncertain(seg).map((t, i) => t.cls
    ? <UncertainWord key={i} word={seg.words[i]} cls={t.cls} />
    : <span key={i}>{t.text}</span>)
  const body = corrected ? seg.text : rawTokens
  const focusRing = 'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 rounded-sm'
  const ring = aktiverTreffer ? 'ring-2 ring-inset ring-yellow-400 dark:ring-yellow-500'
    : active ? 'ring-2 ring-inset ring-primary/60' : ''
  return (
    <div data-seg-id={seg.id}
      className={`group relative rounded-md px-2 py-1 transition-opacity ${active ? 'bg-primary/15 ' : ''}${ring}${dimmen ? ' opacity-40' : ''}`}>
      <button onClick={onPlay} title="Abspielen (Ctrl+Space)" aria-label="Segment abspielen"
        className={`absolute -left-5 top-1.5 text-primary opacity-60 transition-opacity group-hover:opacity-100 ${focusRing}`}>
        <Play className="size-3 fill-current" aria-hidden="true" />
      </button>
      {/* Zeitmarke in der Mono: gleiche Ziffernbreite, damit die Marken untereinander
          eine Spalte bilden statt zu tanzen. */}
      <span className="mr-2 select-none align-top font-mono text-[11px] tabular-nums text-muted-foreground">{fmt(seg.start)}</span>
      {flags.length > 0 && (
        <span className="mr-1.5 inline-flex select-none items-center gap-1 align-top">
          {/* Name und Tooltip am Wrapper: lucide-Icons nehmen kein title-Prop. */}
          {flags.map(f => (
            <span key={f.key} role="img" aria-label={f.titel} title={`${f.titel} — ${f.erklaerung}`}
              className="inline-flex text-amber-600 dark:text-amber-500">
              <f.icon className="size-3" aria-hidden="true" />
            </span>
          ))}
        </span>
      )}
      {editing
        ? <TextEditor initial={seg.text}
            onCommit={t => { updateSegment(seg.id, { text: t }); setEditing(false) }}
            onCancel={() => setEditing(false)}
            onVerworfen={() => toast.info(EINGABE_VERWORFEN)} />
        : <span onClick={() => setEditing(true)} className="lesesatz cursor-text">{body}</span>}
      {corrected &&
        <button onClick={() => setShowRaw(v => !v)} title="Roh-Wörter anzeigen" aria-pressed={showRaw}
          className={`ml-1.5 align-top opacity-30 transition-opacity hover:opacity-100 ${showRaw ? 'opacity-100' : ''} ${focusRing}`}>
          <ScanSearch className="inline size-3.5" aria-hidden="true" />
        </button>}
      {/* Die Notiz am Segment (#112). `segments[].note` ging seit je in den Export („##
          Anmerkungen“, `render_md.py`), hatte aber keinen Eingang: die Korrektur schreibt nur
          die Dokument-Liste, das Feld blieb leer und unsichtbar. Das Symbol steht nur, solange
          nichts drinsteht — danach ist die Notizzeile selbst der Weg hinein. Leeren streicht
          sie, wie bei den Anmerkungen. */}
      {!seg.note && !notiz &&
        <button onClick={() => setNotiz(true)} title="Notiz hinzufügen" aria-label="Notiz hinzufügen"
          className={`ml-1.5 align-top opacity-30 transition-opacity hover:opacity-100 ${focusRing}`}>
          {/* Bei 14 px im echten Zeilenkontext gegen StickyNote, Asterisk, NotebookPen und die
              blosse MessageSquare verglichen (nicht nach Namen gewaehlt): StickyNote ist dort
              eine Seite mit Eselsohr — dasselbe Bild wie das Datei-Symbol der Seitenleiste;
              NotebookPen wird zum Fleck, Asterisk liest sich als Pflichtfeld-Sternchen. Die
              Blase traegt hier ein Plus, weil dieser Knopf NUR steht, solange keine Notiz da
              ist; die Notizzeile darunter fuehrt dieselbe Blase ohne Plus. */}
          <MessageSquarePlus className="inline size-3.5" aria-hidden="true" />
        </button>}
      {corrected && showRaw &&
        <div className="mt-0.5 pl-1 text-xs leading-relaxed text-muted-foreground">{rawTokens}</div>}
      {(seg.note || notiz) &&
        <div className="mt-0.5 flex items-start gap-1 pl-1 text-muted-foreground">
          <MessageSquare className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
          {notiz
            // `t.trim() ? t : ''` — nur Leerraum IST ein Streichen, so wie in `Anmerkungen.setze`.
            // Ungefiltert bliebe "   " stehen: truthy, also faellt der Anlege-Knopf weg und die
            // Notizzeile zeigt nichts an — eine unsichtbare Notiz, die `render_md` ohnehin
            // wegstrippt. (Beim ANLEGEN kann das nicht passieren: dort ist der Ausgangswert ""
            // und `TextEditor` wertet unveraendert als Abbruch — die Luecke gab es nur beim
            // Leeren einer bestehenden Notiz.)
            // `?? ''` rein defensiv: fehlt der Schluessel, liefe `initial.trim()` in
            // `TextEditor.fertig` beim Blur auf `undefined` und risse das ganze Transkript mit.
            // Fehlen kann er nur ueber eine fremd erzeugte edit.json (`save_file` schreibt
            // jedes ankommende JSON) — fuer `text` gilt dasselbe, dort faengt es `isCorrected`.
            // Das Streichen bietet seit #154 den Rueckweg an: die Notiz hat — anders als der
            // Segmenttext mit seinem `raw_text` — keine Zweitschrift. Zurueck geht es ueber
            // denselben `updateSegment`, also nur dieses eine Feld.
            // KEIN zusaetzliches `&& seg.note` davor: es waere unerreichbar (nachgemessen, der
            // Test blieb unter der Mutation gruen). `TextEditor` bricht unveraendert-nach-trim
            // ab — kommt hier ein leeres `t` an, war `initial.trim()` also nicht leer, und
            // `initial` IST `seg.note`. Ein Riegel, den kein Test rot bekommt, ist Dekoration.
            ? <div className="flex-1"><TextEditor initial={seg.note ?? ''}
                onCommit={t => {
                  const streicht = !t.trim()
                  updateSegment(seg.id, { note: streicht ? '' : t })
                  if (streicht) gestrichen('Notiz', () => updateSegment(seg.id, { note: seg.note }))
                  setNotiz(false)
                }}
                onCancel={() => setNotiz(false)}
                onVerworfen={() => toast.info(EINGABE_VERWORFEN)} /></div>
            : <button type="button" onClick={() => setNotiz(true)} title="Notiz bearbeiten (leeren streicht sie)"
                className={`flex-1 cursor-text whitespace-pre-wrap text-left text-xs italic leading-relaxed ${focusRing}`}>
                {seg.note}
              </button>}
        </div>}
    </div>
  )
}
