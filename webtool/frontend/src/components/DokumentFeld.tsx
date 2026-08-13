import { EditierbarerText } from './EditierbarerText'

/**
 * Ein Kopffeld des Dokuments (Kontext, Zusammenfassung) — Klick oeffnet das Textfeld.
 * Die Rubrik darueber, das Feld selbst kommt aus `EditierbarerText` (geteilt mit den
 * Anmerkungen, #112).
 */
export function DokumentFeld({ titel, wert, platzhalter, onCommit, aktiv = false, dimmen = false }: {
  titel: string; wert: string; platzhalter: string; onCommit: (text: string) => void;
  aktiv?: boolean; dimmen?: boolean;
}) {
  return (
    <div>
      <h2 className="rubrik mb-3">{titel}</h2>
      <EditierbarerText wert={wert} platzhalter={platzhalter} onCommit={onCommit}
        titel={`${titel} bearbeiten`} aktiv={aktiv} dimmen={dimmen}
        className="lesebreite w-full text-sm leading-relaxed text-muted-foreground" />
    </div>
  )
}
