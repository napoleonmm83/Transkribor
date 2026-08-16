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
  const setze = (text: string) => {
    if (text.trim()) { onCommit(text); return }
    // Auf `''` normalisiert, nicht der Leerraum durchgereicht: `TextEditor` vergleicht
    // GETRIMMT und schreibt UNGETRIMMT, ein geleertes Feld kann also als "   " ankommen —
    // truthy genug, um als Inhalt zu gelten, zu leer, um irgendwo zu erscheinen (`render_md`
    // strippt). Dieselbe Falle wie bei der Segment-Notiz an PR #153.
    onCommit('')
    // Kein `wert.trim()`-Vorbehalt davor: ein leeres Feld kann diesen Zweig gar nicht
    // erreichen — `TextEditor` wertet unveraendert (getrimmt) als Abbruch und ruft `onCommit`
    // dann nie. Ein Waechter, den kein Test rot bekommt, waere Dekoration.
    //
    // Zurueckgeschrieben wird `wert` **unbedingt**. Wer in den zehn Sekunden bis zum Toast
    // schon neu getippt hat, verliert das damit — anders als bei den Anmerkungen gibt es hier
    // keine Liste, in die man den Eintrag zurueckschieben koennte, ohne etwas zu ersetzen.
    // Der Toast nennt den gestrichenen Text, ein Fehlgriff ist also sichtbar; der Absatz, den
    // man ohne Rueckweg verliert, ist es nicht.
    gestrichen(titel, wert, () => onCommit(wert))
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
