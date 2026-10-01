/** Sekunde der ersten Stelle ueber der Pegelschwelle, mit 0,25 s Vorlauf.
 *
 *  Findet GERAEUSCH, nicht Sprache — Applaus, Wind und eine zuschlagende Autotuer setzen sie
 *  genauso. Deshalb heisst der Marker „erstes Geräusch" und diese Funktion verspricht nichts
 *  anderes (Spec 5.3; das Mockup sagte noch „erste Sprache" und behauptete damit mehr, als
 *  die Messung hergibt).
 *
 *  Rueckgabe 0 heisst „von vorn": durchgehend laut ODER durchgehend still. Beides ist der
 *  richtige Ausgang — ans Ende einer stummen Datei zu springen waere der Schaden, den eine
 *  Sprunghilfe ueberhaupt anrichten kann.
 */
export function ersteStelle(peaks: Float32Array, dauer: number): number {
  // `Math.abs` auf BEIDEN Seiten, und das ist kein Feinschliff: `exportPeaks` behaelt das
  // VORZEICHEN — wavesurfer nimmt je Fenster das Sample mit dem groessten Betrag und pusht
  // es unveraendert (`wavesurfer.js:441`, nachgelesen statt angenommen). Ein lautes Fenster
  // mit negativer Spitze ist genauso laut wie eines mit positiver; ohne Betrag laese diese
  // Funktion an echtem Audio rund die Haelfte aller lauten Fenster als Stille.
  let max = 0
  for (const p of peaks) max = Math.max(max, Math.abs(p))
  // Die Wache `if (max <= 0) return 0` stand hier und ist ZURUECKGEBAUT: bei lauter Nullen
  // ist die Schwelle 0, `0 > 0` ist falsch, und das `return 0` unten faengt den Fall
  // ohnehin — gemessen, die Mutation „Wache raus" liess alle Tests gruen. Ein Waechter,
  // den kein Test rot bekommt, ist Dekoration.
  const schwelle = max * 0.22
  for (let k = 0; k < peaks.length; k++) {
    if (Math.abs(peaks[k]) > schwelle) return Math.max(0, (k / peaks.length) * dauer - 0.25)
  }
  return 0
}

