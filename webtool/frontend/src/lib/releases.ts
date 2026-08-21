/** Ein veröffentlichter Stand, wie ihn der Versionsverlauf zeigt. */
export type Release = {
  /** Ohne führendes „v" — so steht sie auch im Update-Zustand aus Electron. */
  version: string
  tag: string
  /** ISO `YYYY-MM-DD`; die Uhrzeit interessiert hier niemanden. */
  datum: string
  /** Markdown, wie es in der Release-Beschreibung steht. */
  notizen: string
  url: string
}

// 15 geholt, 10 gezeigt: der Prerelease-Filter greift NACH dem Abruf, sonst zeigte die Seite
// neun Fassungen, sobald ein `modelle-v1` dazwischenliegt — und zwar unvorhersehbar viele.
const QUELLE = 'https://api.github.com/repos/napoleonmm83/Transkribor/releases?per_page=15'
const ZEIGEN = 10

/**
 * Ohne Frist bedeutet eine haengende Verbindung (Captive Portal, eine Firewall, die verwirft
 * statt abzulehnen) einen Spinner ohne Ausweg: der Link zu GitHub haengt am Fehlerzweig, und
 * den erreicht nur, wer eine Ablehnung bekommt. Zehn Sekunden sind grosszuegig fuer 30 KB
 * JSON. Ganze Zahl, weil `AbortSignal.timeout` bei einem Bruchteil in Node `RangeError`
 * wirft — und zwar VOR dem fetch, also als Absturz statt als Fehlschlag (#298).
 */
const FRIST_MS = 10000

/**
 * Die Frist ist ein PARAMETER, nicht nur eine Konstante — dasselbe Muster wie `autoUpdater`
 * in `updater.erstellen` oder `werkzeug` in `setup.einrichten`. Grund: `AbortSignal.timeout`
 * laeuft an vitests Fake-Timers VORBEI (gemessen: `advanceTimersByTime(10001)` laesst
 * `aborted` auf `false`), Node zaehlt intern. Ohne den Parameter liesse sich nur pruefen,
 * DASS ein Signal uebergeben wird — nicht, dass die Frist wirklich abbricht.
 */

/**
 * Die letzten Fassungen von GitHub. Direkt aus dem Browser, ohne Umweg über den eigenen
 * Server: es gibt nichts zu verbergen und nichts zwischenzuspeichern, und ein Endpunkt mehr
 * wäre eine Schicht, die nur durchreicht.
 *
 * Vorabfassungen fallen raus, und das ist keine Kosmetik: `modelle-v1` (die GGML-Dateien für
 * whisper.cpp) ist ein Release ohne App und ohne Notizen — im Verlauf eine Zeile, zu der es
 * nichts zu lesen gibt. Aus demselben Grund hält `electron/CLAUDE.md` fest, dass solche
 * Releases `--prerelease` tragen MÜSSEN.
 */
export async function holeReleases(signal?: AbortSignal, fristMs = FRIST_MS): Promise<Release[]> {
  // Beide Abbruchgruende zaehlen: das Zeitlimit UND das Verlassen der Seite.
  const frist = AbortSignal.timeout(fristMs)
  const r = await fetch(QUELLE, {
    headers: { Accept: 'application/vnd.github+json' },
    signal: signal ? AbortSignal.any([signal, frist]) : frist,
  })
  if (!r.ok) throw new Error(`GitHub antwortet ${r.status}`)
  const roh: unknown = await r.json()
  // Bei überschrittenem Anfragekontingent antwortet GitHub mit einem Objekt, nicht mit einer
  // Liste — ungeprüft stürbe die Seite an `roh.filter is not a function`.
  if (!Array.isArray(roh)) throw new Error('GitHub antwortet nicht mit einer Liste')
  return (roh as Record<string, unknown>[])
    .filter(e => e && !e.draft && !e.prerelease)
    .slice(0, ZEIGEN)
    .map(e => ({
      version: String(e.tag_name ?? '').replace(/^v/, ''),
      tag: String(e.tag_name ?? ''),
      datum: String(e.published_at ?? '').slice(0, 10),
      notizen: String(e.body ?? ''),
      url: String(e.html_url ?? ''),
    }))
}
