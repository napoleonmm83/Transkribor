'use strict'
/**
 * Update-Zustand als EIN Objekt. Der autoUpdater wird hineingereicht statt importiert:
 * so laeuft der Automat im Test ohne Electron, wie setup.plan() es vormacht.
 */

/**
 * Leerstring heisst: dieses System kann sich selbst aktualisieren.
 * Sonst ein CODE, kein Satz — die Formulierung steht in SettingsPage.tsx, wo Umlaute
 * erlaubt sind und der Text hingehoert.
 */
function nichtMoeglich(plattform, gepackt, appimage) {
  if (!gepackt) return 'entwicklung'
  // Die Variable setzt die AppImage-Laufzeit selbst; ein deb-Start hat sie nicht, und
  // fuer deb kennt electron-updater ohnehin keinen Weg.
  if (plattform === 'linux' && !appimage) return 'kein-appimage'
  return ''
}

/**
 * owner/repo aus einer app-update.yml lesen (electron-builder erzeugt sie beim Packen aus
 * build.publish und legt sie zu den Resources). Regex statt YAML-Parser: die Datei hat vier
 * flache Zeilen, und parseLatestMac macht es nebenan schon so.
 * Unvollstaendig ist wie gar nicht — ein halbes Ergebnis baute sonst eine URL mit
 * "undefined" darin und verdeckte dabei den Rueckfall.
 */
function publishAusYml(text) {
  const t = String(text || '')
  const provider = /^provider:\s*(\S+)/m.exec(t)
  const owner = /^owner:\s*(\S+)/m.exec(t)
  const repo = /^repo:\s*(\S+)/m.exec(t)
  if (!provider || provider[1] !== 'github' || !owner || !repo) return null
  return { provider: 'github', owner: owner[1], repo: repo[1] }
}

/**
 * Feed- + Release-URL fuer den Mac-Manualcheck ableiten. Eine Wahrheitsquelle statt
 * hartkodiert — bei Repository-Umzug zieht das mit. null, falls kein github-Publish.
 *
 * ZWEI Quellen, und keine deckt beide Faelle ab: electron-builder LOESCHT `build` aus der
 * package.json, die es in die App legt (app-builder-lib/out/fileTransformer.js,
 * `ignoredPackageMetadataProperties`) — gepackt gibt es nur die app-update.yml. Im
 * Entwicklungsbetrieb gibt es umgekehrt nur die package.json. Eine **github**-yml gewinnt:
 * sie ist die Konfiguration, mit der das laufende Artefakt tatsaechlich gebaut wurde. Alles
 * andere (`provider: generic`) faellt auf `build.publish` zurueck — heute unerreichbar, weil
 * die beiden Quellen nie gleichzeitig existieren, aber die Regel ist nicht "yml schlaegt
 * package.json", sondern "eine github-yml schlaegt sie".
 */
function macUrls(paket, ymlText) {
  const p = publishAusYml(ymlText) || (paket && paket.build && paket.build.publish && paket.build.publish[0])
  if (!p || p.provider !== 'github' || !p.owner || !p.repo) return null
  const base = `https://github.com/${p.owner}/${p.repo}`
  return { feed: `${base}/releases/latest/download/latest-mac.yml`, release: `${base}/releases/latest` }
}

/** Semver-Vergleich. true falls a > b (X.Y.Z numerisch), null bei ungueltigem Format.
 *  Build-Suffixe absichtlich nicht behandelt: latest-mac.yml traegt reines X.Y.Z, und alles andere
 *  ist ein Fehlerzustand (-> 'fehler'), kein Stolpern im Dunkeln. */
function istNeuer(a, b) {
  const pa = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(a))
  const pb = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(b))
  if (!pa || !pb) return null
  for (let i = 1; i <= 3; i++) {
    const d = +pa[i] - +pb[i]
    if (d > 0) return true
    if (d < 0) return false
  }
  return false
}

/** Liest {version, groesse} aus einer latest-mac.yml; null, falls keine version-Zeile.
 *  size ist optional (groesse dann null — nicht "0 MB" erfunden, dieselbe Regel wie 'verfuegbar'). */
function parseLatestMac(text) {
  const v = /^version:\s*(\S+)/m.exec(text)
  if (!v) return null
  const s = /^[\s-]*size:\s*(\d+)/m.exec(text)
  return { version: v[1], groesse: s ? +s[1] : null }
}

/**
 * Darf die Hintergrund-Pruefung laufen? Weissliste statt Ausschlussliste: eine spaeter
 * dazukommende Zustandsart gilt im Zweifel als "nichts zu tun".
 * Wer schon ein Update gefunden hat (verfuegbar/laedt/bereit), sucht nicht weiter — der
 * Zeitgeber wuerde sonst genau die Fusszeile ueberschreiben, in der das Update steht.
 * 'fehler' wird erneut versucht: ein Netzaussetzer ist kein Dauerzustand.
 */
const ERNEUT_PRUEFEN = ['unbekannt', 'aktuell', 'fehler']
function sollPruefen(stand) { return !!stand && ERNEUT_PRUEFEN.includes(stand.art) }

/**
 * Ein Automat, der nur EINES sagen kann: warum es hier keine Updates gibt (#319).
 *
 * Gebraucht, wenn `erstellen` gar nicht erst laufen konnte — etwa weil
 * `require('electron-updater')` wirft (Verpackungsfehler). Vorher blieb `aktualisierer` in
 * `main.js` dann `null`, `update:status` lieferte `null`, und im Frontend ist das **nicht**
 * von „laeuft im normalen Browser" zu unterscheiden: die Versionsseite sagte in der
 * INSTALLIERTEN App „Updates gibt es in der installierten App" und schickte den Nutzer im
 * Kreis. Dieselbe Klasse wie `"text": ""` in `apply_correction` — ein Wert trug zwei
 * Bedeutungen; jetzt sagt der Zustand, welche gemeint ist.
 *
 * Die Aktionen sind No-Ops, weil es nichts zu tun gibt — **nicht**, weil ein Wurf gefaehrlich
 * waere: `ipcMain.handle` serialisiert einen Wurf zu einer abgelehnten Promise im Renderer
 * (electron.d.ts zu `handle`/`invoke`), und `useUpdate` verschluckt die ohnehin mit
 * `.catch(() => {})`. Die erste Fassung dieses Kommentars behauptete „ein Wurf im
 * Hauptprozess waere schlimmer" — die Entscheidung bleibt, der Grund war erfunden.
 */
function ersatz(version, grund) {
  const stand = { version, art: 'nicht_moeglich', grund }
  return {
    zustand: () => stand,
    pruefen: () => {},
    laden: () => {},
    installieren: () => {},
  }
}

/**
 * Nach einem Wurf beim Aufbau: den bestehenden Automaten behalten, sonst den Ersatz.
 *
 * Das ist die EINZIGE Entscheidung des #319-Fixes, und sie stand zuerst als `if` in
 * `main.js` — entgegen der Regel, die dort selbst notiert ist („alles, was eine Entscheidung
 * trifft, gehoert woandershin"): `main.js` ist das einzige Electron-Modul ohne Tests (#251).
 * Faellt sie weg, bleiben alle Tests des Fixes gruen und #319 ist zurueck, denn die
 * Frontend-Tests pruefen nur die ANZEIGE eines Zustands, den ausschliesslich diese Zeile
 * erzeugt.
 *
 * Warum ueberhaupt „behalten": der `try` in `main.js` umschliesst auch `pruefen()` und den
 * 6-h-Zeitgeber. Ein Wurf DANACH darf einen funktionierenden Automaten nicht durch einen
 * ersetzen, der „geht nicht" sagt.
 */
function nachFehler(vorhanden, version) {
  return vorhanden || ersatz(version, 'kein-updater')
}

/**
 * Baut den Automaten. `aendert` wird bei jeder Zustandsaenderung gerufen — daran haengt
 * die Anzeige im Fenster.
 */
function erstellen({ autoUpdater, version, plattform, gepackt, appimage, aendert, hole, openExternal, feedUrl, releaseUrl }) {
  const grund = nichtMoeglich(plattform, gepackt, appimage)
  let stand = grund ? { version, art: 'nicht_moeglich', grund } : { version, art: 'unbekannt' }

  const setzen = neu => { stand = { version, ...neu }; aendert(stand) }

  // Mac: Auto-Update ist ohne Notarisierung tot (Squirrel.Mac will echte Signatur), aber die
  // Pruefung laeuft am autoUpdater vorbei — ein HTTP-Vergleich gegen latest-mac.yml. Bei
  // verfuegbar -> 'verfuegbar_manuell' (manueller Download), laden oeffnet den Browser, nicht
  // downloadUpdate. hole/openExternal werden hereingereicht (wie autoUpdater) -> ohne Mac testbar.
  if (plattform === 'darwin' && gepackt) {
    // Ohne Feed-URL waere jede Pruefung ein hole(null) -> "Failed to parse URL from null":
    // richtig, aber unbrauchbar, weil die einzige sinnvolle Reaktion nicht darin steht. Der
    // Fall ist erreichbar, sobald beide Quellen oben leer ausgehen (kein github-Publish,
    // fehlende app-update.yml) — dann KANN dieses Exemplar sich nicht aktualisieren.
    if (!feedUrl) stand = { version, art: 'nicht_moeglich', grund: 'keine-quelle' }
    return {
      zustand: () => stand,
      pruefen: () => {
        if (!feedUrl) return
        setzen({ art: 'prueft' })
        hole(feedUrl).then(r => {
          if (!r.ok) throw new Error(`latest-mac.yml HTTP ${r.status}`)
          return r.text()
        }).then(parseLatestMac).then(gelesen => {
          if (!gelesen) return setzen({ art: 'fehler', text: 'latest-mac.yml ohne Version' })
          const neu = istNeuer(gelesen.version, version)
          if (neu === null) return setzen({ art: 'fehler', text: `Version nicht lesbar: ${gelesen.version}` })
          if (neu) return setzen({ art: 'verfuegbar_manuell', neue: gelesen.version, groesse: gelesen.groesse })
          setzen({ art: 'aktuell' })
        }).catch(e => setzen({ art: 'fehler', text: (e && e.message) || String(e) }))
      },
      laden: () => { if (releaseUrl) openExternal(releaseUrl) },
      installieren: () => {},
    }
  }

  if (!grund) {
    // Ohne das laedt electron-updater beim Pruefen sofort los und "erst auf Klick"
    // waere wirkungslos.
    autoUpdater.autoDownload = false
    autoUpdater.on('update-available', info => setzen({
      art: 'verfuegbar',
      neue: info.version,
      // Fehlende Groesse bleibt unbekannt statt zu "0 MB" zu werden — das waere eine
      // Behauptung, die die Anzeige nicht belegen kann.
      groesse: (info.files && info.files[0] && info.files[0].size) || null,
    }))
    autoUpdater.on('update-not-available', () => setzen({ art: 'aktuell' }))
    autoUpdater.on('download-progress', p => setzen({
      art: 'laedt',
      prozent: p.percent,
      geladen: p.transferred,
      gesamt: p.total,
      tempo: p.bytesPerSecond,
    }))
    autoUpdater.on('update-downloaded', info => setzen({ art: 'bereit', neue: info.version }))
    // electron-updater liefert den ausfuehrlichen Text als zweites Argument
    // ("Cannot check for updates: <stack>") — der geht sonst verloren.
    autoUpdater.on('error', (e, nachricht) => setzen({
      art: 'fehler',
      text: nachricht || String((e && e.message) || e),
    }))
  }

  return {
    zustand: () => stand,
    pruefen: () => {
      if (grund) return                       // wuerde ohnehin scheitern
      setzen({ art: 'prueft' })
      autoUpdater.checkForUpdates().catch(() => {})   // Fehler kommt ueber 'error'
    },
    laden: () => { if (!grund) autoUpdater.downloadUpdate().catch(() => {}) },
    installieren: () => { if (!grund) autoUpdater.quitAndInstall() },
  }
}

module.exports = { nichtMoeglich, sollPruefen, erstellen, ersatz, nachFehler, macUrls, istNeuer, parseLatestMac, publishAusYml }
