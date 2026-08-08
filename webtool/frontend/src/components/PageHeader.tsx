import { Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'

/**
 * Der Kopf aller Nicht-Editor-Seiten. Vorher baute ihn jede Seite selbst — mit drei
 * verschiedenen Titelgroessen (2xl/xl/xl) und einem '‹ Home' als blossem Textlink. Beim
 * Wechsel zwischen Galerie und Einstellungen sprang der Titel, was eine Anwendung billig
 * wirken laesst: gleiche Ebene, gleiche Groesse.
 *
 * Die Rubrik darueber ist das redaktionelle Signal — sie sagt, WO man ist, ohne dass der
 * Titel es wiederholen muss ("Projekt" / "Demo" statt nur "Demo").
 */
export function PageHeader({ rubrik, titel, zurueck, zurueckText = 'Übersicht', children }: {
  rubrik?: string
  titel: string
  /** Route des uebergeordneten Bereichs. Fehlt sie, ist diese Seite die oberste. */
  zurueck?: string
  zurueckText?: string
  /** Aktionen rechts (Knoepfe, Links). */
  children?: React.ReactNode
}) {
  return (
    <header className="mb-8">
      {zurueck && (
        // Eigene Zeile statt neben dem Titel: als Nachbar des H1 las sich der Pfeil wie ein
        // Teil des Titels. -mx-2 haelt den Text trotz Klickflaeche in der Fluchtlinie.
        <Link to={zurueck}
          className="-mx-2 mb-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm
                     text-muted-foreground transition-colors hover:text-foreground">
          <ArrowLeft className="size-4" aria-hidden="true" />
          {zurueckText}
        </Link>
      )}
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          {rubrik && <div className="rubrik mb-1.5">{rubrik}</div>}
          {/* break-words: Projektnamen sind Nutzereingaben und koennen beliebig lang sein.
              3xl statt 2xl: Space Grotesk hat bei kleinen Graden zu wenig Eigenart, um den
              Wechsel zur Bedienschrift ueberhaupt sichtbar zu machen. */}
          <h1 className="text-3xl font-semibold break-words">{titel}</h1>
        </div>
        {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
      </div>
    </header>
  )
}
