import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * ISO-Datum als deutsches Datum.
 *
 * Die Kürzung auf zehn Zeichen ist defensiv und heute UNERREICHBAR: `releases.ts` kürzt den
 * GitHub-Zeitstempel schon beim Einlesen, und `ytdlp.geprueft` kommt als `date.isoformat()`.
 * Sie bleibt, weil die Funktion „nimm ein ISO-Datum" verspricht — kein Test wird rot, wenn
 * sie verschwindet, und das steht hier, damit niemand sie für abgesichert hält.
 *
 * Von Hand umgedreht statt per `toLocaleDateString`: dessen Ausgabe hängt an der ICU-Fassung
 * der Laufzeit, wäre also im Test eine andere als im Browser. Im Screenshot fiel auf, dass
 * `2026-08-13` in einer sonst durchgehend deutschen Seite wie eine Fehlermeldung aussieht.
 */
export function tag(iso: string) {
  return iso.slice(0, 10).split('-').reverse().join('.')
}
