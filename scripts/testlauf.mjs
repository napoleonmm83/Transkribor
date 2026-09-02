/**
 * `node --test` fahren, aber die TESTZAHL entscheiden lassen statt des Exitcodes (#510).
 *
 * Trifft das Glob keine Datei, druckt der Runner `tests 0` und endet mit **rc 0** — hier auf
 * Node 22.23.2 nachgestellt, im Issue #510 auf 24.20.0 (der Fassung, die `setup-node` in der
 * CI laedt) und dort in allen drei Aufrufformen, die in diesem Repo real vorkommen: bash mit
 * und ohne Anfuehrungszeichen und cmd.exe woertlich. Ein Verzeichniswechsel, eine Umbenennung
 * von `electron/`, ein anderer Dateisuffix oder ein Umbau des npm-Skripts macht damit aus 217
 * Waechtern einen gruenen Haken, und nichts im Protokoll sagt es an. Dieselbe Klasse steckte
 * hinter `CodeRabbit pass` bei erschoepftem Kontingent (#188) und hinter
 * `scripts/test_weg_benchmark.py`, das direkt mit `python` aufgerufen mit rc 0 und null Tests
 * durchlief (PR #501, `efda9c1`).
 *
 * Der Sensor ist deshalb die Bilanzzeile des Runners:
 *   - keine Bilanzzeile ODER `tests 0`  ->  rc 1
 *   - sonst der Exitcode des Kindes, unveraendert durchgereicht.
 *
 * **Keine Mindestzahl, nur `> 0`.** Eine feste Erwartung war hier nach einem einzigen PR
 * falsch (242 -> 244, Begruendung in `.github/workflows/test.yml`); ein Waechter, den jeder
 * Merge nachziehen muss, wird weggeklickt und schuetzt danach nichts mehr. Zwei getragene
 * Grenzen dazu, damit sie niemand fuer geschlossen haelt: verschwindet EINE Testdatei einer
 * Menge, faellt das hier nicht auf — gezaehlt wird „null gegen mehr als null", nicht „so viele
 * wie gestern". Und eine getroffene Datei OHNE einen einzigen `test()`-Aufruf zaehlt selbst
 * als 1 (auf 22 wie auf 24 gemessen); der Sensor faengt das leere GLOB, nicht die leere Datei.
 *
 * **EIN Aufruf je Testmenge — nicht zwei Muster in einem Aufruf.** `package.json` ruft
 * deshalb zweimal: erst die Electron-Suite, dann (mit `&&`) den Selbsttest daneben. Der
 * erste Entwurf hatte beide Muster in EINEM Aufruf, und dabei kam der Fehler des Issues
 * zurueck: mit umbenanntem `electron/` blieben nur die Selbsttests dieser Datei uebrig
 * (damals drei, `tests 3`), rc 0 — gruen, obwohl 217 Waechter weg waren. Gemessen, nicht ueberlegt. `> 0` ist eine
 * Aussage ueber die Summe; getrennt gefahren ist es eine Aussage ueber jede Menge einzeln.
 *
 * **Warum ein eigenes Skript und keine Auswertung in `package.json`:** npm faehrt Skripte
 * auf Windows durch `cmd.exe` und sonst durch `sh`. Eine Zeile, die die Ausgabe liest,
 * muesste in beiden Sprachen stimmen — Node ist die einzige, die auf allen drei Plattformen
 * dieselbe ist.
 *
 * Die Argumente gehen unveraendert an `node --test` weiter: unter bash expandiert die Shell
 * die Globs, unter cmd.exe kommen sie woertlich an und der Runner loest sie selbst auf (seit
 * Node 21.0.0, nodejs/node#47653). Beide Formen sind an diesem Skript gemessen, je 220 Tests.
 */
import { spawn } from 'node:child_process'

// **Die Form der Bilanzzeile haengt an der NODE-FASSUNG, nicht am Terminal.** Node 22 schreibt
// ins Rohr TAP (`# tests 7`), Node 24 — die Fassung der CI — den Spec-Reporter (`ℹ tests 7`);
// beides gemessen, letzteres im gegnerischen Review dieses PR auf 24.20.0. Der Sensor kennt
// deshalb BEIDE Formen; keine ist der Sonderfall. Das `\b` statt eines Zeilenendes macht ein
// CR am Zeilenende unschaedlich.
const BILANZ = /^(?:# |ℹ )tests (\d+)\b/gm
// Und die Bilanz kann GEFAERBT ankommen: mit `FORCE_COLOR=1` steht vor dem `ℹ` eine
// Steuerfolge (gemessen: ESC-Klammer-34-m vor `ℹ tests 217`), und eine am Zeilenanfang
// verankerte Regex greift dann nicht mehr — 217 gruene Tests waeren ein „Sensor unlesbar",
// also falsch rot. Verglichen wird darum entfaerbt; DURCHGEREICHT wird die Ausgabe roh.
// Das Steuerzeichen steht als `fromCharCode(27)` da und nicht als Escape im Literal: ein
// rohes ESC im Quelltext ist unsichtbar, und genau daran ist die erste Fassung gescheitert.
const FARBE = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g')

const muster = process.argv.slice(2)
const kind = spawn(process.execPath, ['--test', ...muster], { stdio: ['inherit', 'pipe', 'inherit'] })

let ausgabe = ''
kind.stdout.setEncoding('utf8')
// Durchreichen UND mitschreiben: der Lauf soll aussehen wie vorher, nur eben nachzaehlbar.
kind.stdout.on('data', stueck => { ausgabe += stueck; process.stdout.write(stueck) })

kind.on('error', fehler => {
  console.error(`[testlauf] Der Testlauf startete nicht: ${fehler.message}`)
  process.exitCode = 1
})

kind.on('close', (code, signal) => {
  // Die LETZTE Bilanzzeile zaehlt: unter dem Spec-Reporter kommt die Ausgabe eines Tests roh
  // durch, koennte also dieselbe Form tragen (unter TAP escapet der Runner sie).
  const treffer = [...ausgabe.replace(FARBE, '').matchAll(BILANZ)].at(-1)
  if (!treffer) {
    console.error('[testlauf] FEHLER: keine Bilanzzeile ("tests N") in der Ausgabe — die '
      + 'Testzahl ist nicht ablesbar, und ein unlesbarer Sensor ist rot, nicht gruen.')
    process.exitCode = 1
    return
  }
  if (Number(treffer[1]) === 0) {
    console.error(`[testlauf] FEHLER: null Tests gesammelt (${muster.join(' ') || '(ohne Muster)'}) `
      + '— ein leeres Glob ist kein bestandener Lauf.')
    process.exitCode = 1
    return
  }
  // `process.exitCode` statt `process.exit()`: letzteres kann die eben durchgereichte
  // Ausgabe abschneiden, wenn stdout ein Rohr ist.
  process.exitCode = signal ? 1 : code ?? 1
})
