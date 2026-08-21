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

const QUELLE = 'https://api.github.com/repos/napoleonmm83/Transkribor/releases?per_page=10'

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
export async function holeReleases(signal?: AbortSignal): Promise<Release[]> {
  const r = await fetch(QUELLE, { headers: { Accept: 'application/vnd.github+json' }, signal })
  if (!r.ok) throw new Error(`GitHub antwortet ${r.status}`)
  const roh: unknown = await r.json()
  // Bei überschrittenem Anfragekontingent antwortet GitHub mit einem Objekt, nicht mit einer
  // Liste — ungeprüft stürbe die Seite an `roh.filter is not a function`.
  if (!Array.isArray(roh)) throw new Error('GitHub antwortet nicht mit einer Liste')
  return (roh as Record<string, unknown>[])
    .filter(e => e && !e.draft && !e.prerelease)
    .map(e => ({
      version: String(e.tag_name ?? '').replace(/^v/, ''),
      tag: String(e.tag_name ?? ''),
      datum: String(e.published_at ?? '').slice(0, 10),
      notizen: String(e.body ?? ''),
      url: String(e.html_url ?? ''),
    }))
}
