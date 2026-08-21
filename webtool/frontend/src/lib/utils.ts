import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * ISO-Datum als deutsches Datum. Längere Zeitstempel (`2026-08-21T12:17:28Z`, wie GitHub sie
 * liefert) werden auf den Tag gekürzt.
 *
 * Von Hand umgedreht statt per `toLocaleDateString`: dessen Ausgabe hängt an der ICU-Fassung
 * der Laufzeit, wäre also im Test eine andere als im Browser. Im Screenshot fiel auf, dass
 * `2026-08-13` in einer sonst durchgehend deutschen Seite wie eine Fehlermeldung aussieht.
 */
export function tag(iso: string) {
  return iso.slice(0, 10).split('-').reverse().join('.')
}
