import { useLayoutEffect, useRef } from 'react'
import { toast } from 'sonner'
import { gestrichen } from '@/lib/streichen'
import { EditierbarerText } from './EditierbarerText'

/**
 * Ein Kopffeld des Dokuments (Kontext, Zusammenfassung) — Klick oeffnet das Textfeld.
 * Die Rubrik darueber, das Feld selbst kommt aus `EditierbarerText` (geteilt mit den
 * Anmerkungen, #112).
 *
 * **Leeren streicht — und seit #226 mit Rueckweg.** #154 hat Anmerkung und Segment-Notiz
 * einen Toast mit „Rueckgaengig" gegeben; die dritte Stelle mit derselben Eigenschaft blieb
 * aussen vor. Auch hier gibt es **keine Zweitschrift** (anders als beim Segmenttext, wo
 * `raw_text` die Erstfassung haelt und der `ScanSearch`-Knopf sie zeigt), ein Fehlklick
 * kostet also einen ganzen Absatz — und `context` steht im Export ganz oben.
 */
export function DokumentFeld({ titel, wert, platzhalter, onCommit, aktiv = false, dimmen = false }: {
  titel: string; wert: string; platzhalter: string; onCommit: (text: string) => void;
  aktiv?: boolean; dimmen?: boolean;
}) {
  /** Der Feldinhalt, wie er JETZT ist — fuer den Rueckweg, der zehn Sekunden spaeter feuert.
   *  Ein Ref und keine Closure, aus demselben Grund wie `aktuell` in `Anmerkungen`: `wert` aus
   *  dem Render der Streichung ist beim Klick veraltet.
   *
   *  Im `useLayoutEffect` statt im Render-Koerper: eine Zuweisung waehrend des Renderns
   *  uebernimmt auch den Stand eines verworfenen Durchlaufs. Gelesen wird der Ref nur aus einem
   *  Ereignis-Rueckruf, also nach dem Commit. */
  const aktuell = useRef(wert)
  useLayoutEffect(() => { aktuell.current = wert }, [wert])

  const setze = (text: string) => {
    if (text.trim()) { onCommit(text); return }
    // Auf `''` normalisiert, nicht der Leerraum durchgereicht: `TextEditor` vergleicht
    // GETRIMMT und schreibt UNGETRIMMT, ein geleertes Feld kann also als "   " ankommen.
    // **Sichtbar waere das hier nichts** — `EditierbarerText` rendert `wert.trim() ||
    // Platzhalter`, `render_md` strippt, Suche und Umbenennen sehen keinen Unterschied
    // (alle vier nachgesehen, nicht angenommen). Der Grund ist ein anderer als bei der
    // Segment-Notiz (PR #153, wo `"   "` den Anlege-Knopf verdraengte): ein gestrichenes Feld
    // soll **denselben** Zustand haben wie ein nie gesetztes aus `build_edit_doc`, sonst
    // haengt an einem Vergleich irgendwann ein Unterschied, den niemand sehen kann.
    onCommit('')
    // Kein `wert.trim()`-Vorbehalt davor: ein leeres Feld kann diesen Zweig gar nicht
    // erreichen — `TextEditor` wertet unveraendert (getrimmt) als Abbruch und ruft `onCommit`
    // dann nie. Ein Waechter, den kein Test rot bekommt, waere Dekoration.
    //
    // **Der Rueckweg schreibt NUR in ein weiterhin leeres Feld** (CodeRabbit-Bot, Major). Ein
    // unbedingtes `onCommit(wert)` stand hier zuerst, mit der Begruendung, es gebe — anders als
    // bei den Anmerkungen — keine Liste, in die sich der Eintrag zurueckschieben liesse. Das
    // stimmt, entschuldigt aber nichts: der Ablauf „streichen → neu tippen → auf den alten
    // Toast klicken" ist zehn Sekunden lang erreichbar und wirft den NEUEN Absatz weg. Genau
    // der Verlust, gegen den #154 geschrieben ist, ausgeloest vom Rettungsknopf selbst.
    //
    // **Und nicht stumm aussteigen:** ein Knopf, der nichts tut, sieht aus wie ein Fehlschlag,
    // und der Nutzer traegt den Absatz nicht von Hand nach (dieselbe Regel wie bei
    // `streichungenVergessen`, das den Knopf lieber WEGNIMMT als ihn falsch feuern zu lassen —
    // wegnehmen kann dieser Rueckruf ihn nicht mehr, er laeuft ja gerade). Also sagen, warum.
    gestrichen(titel, wert, () => {
      if (aktuell.current.trim()) {
        toast.info(`${titel} wurde inzwischen neu geschrieben — der alte Text bleibt gestrichen.`)
        return
      }
      onCommit(wert)
    })
  }

  return (
    <div>
      <h2 className="rubrik mb-3">{titel}</h2>
      {/* „das Feld“, nicht „ihn“/„sie“: derselbe Text traegt „Kontext“ (m.) und
          „Zusammenfassung“ (w.) — ein Pronomen waere an einem der beiden falsch. */}
      <EditierbarerText wert={wert} platzhalter={platzhalter} onCommit={setze}
        titel={`${titel} bearbeiten (leeren streicht das Feld)`} aktiv={aktiv} dimmen={dimmen}
        className="lesebreite w-full text-sm leading-relaxed text-muted-foreground" />
    </div>
  )
}
