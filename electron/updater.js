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
 * Feed- + Release-URL fuer den Mac-Manualcheck aus build.publish ableiten. Eine Wahrheitsquelle
 * statt hartkodiert — bei Repository-Umzug zieht das mit. null, falls kein github-Publish.
 */
function macUrls(paket) {
  const p = paket && paket.build && paket.build.publish && paket.build.publish[0]
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
    return {
      zustand: () => stand,
      pruefen: () => {
        setzen({ art: 'prueft' })
        hole(feedUrl).then(r => r.text()).then(parseLatestMac).then(gelesen => {
          if (!gelesen) return setzen({ art: 'fehler', text: 'latest-mac.yml ohne Version' })
          const neu = istNeuer(gelesen.version, version)
          if (neu === null) return setzen({ art: 'fehler', text: `Version nicht lesbar: ${gelesen.version}` })
          if (neu) return setzen({ art: 'verfuegbar_manuell', neue: gelesen.version, groesse: gelesen.groesse })
          setzen({ art: 'aktuell' })
        }).catch(e => setzen({ art: 'fehler', text: (e && e.message) || String(e) }))
      },
      laden: () => { openExternal(releaseUrl) },
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

module.exports = { nichtMoeglich, sollPruefen, erstellen, macUrls, istNeuer, parseLatestMac }
