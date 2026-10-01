/** Die Sprechernamen eines Dokuments in der Reihenfolge ihres ersten Auftretens.
 *  Ohne Filter: welcher Name als Dateiname taugt, weiss nur der Mensch davor — eine
 *  Heuristik („nimm den, der nicht Interviewer heisst“) liegt beim ersten Sonderfall falsch. */
export function sprecherNamen(doc: { segments?: { speaker?: string }[] } | null): string[] {
  const gesehen: string[] = []
  for (const s of doc?.segments ?? []) {
    const n = (s.speaker || '').trim()
    if (n && !gesehen.includes(n)) gesehen.push(n)
  }
  return gesehen
}
