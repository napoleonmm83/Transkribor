import type {
  Project, ProjectFile, EditDoc, JobStatus, StartJob, Settings, ModelInfo, Hardware, AuthStatus, LoginState, YtdlpStand,
  ProjectEinstellungen,
  EinstellungenWerte,
  DateiEinstellungen,
  DateiEinstellungenPatch,
} from './types'

const enc = encodeURIComponent
/** Fehler mit dem HTTP-Status daran. Erbt von `Error` und traegt dieselbe `message` wie zuvor
 *  (das `detail` des Servers) — alle bestehenden Aufrufer, die nur `e.message` lesen, bleiben
 *  unveraendert. Gebraucht wird der Status fuer den 409 aus #160: ein Speicherkonflikt ist
 *  kein Fehlschlag, den man wiederholen sollte, sondern eine Frage an den Nutzer. */
export class HttpFehler extends Error {
  // Feld und Zuweisung getrennt: `erasableSyntaxOnly` (tsconfig) verbietet
  // Konstruktor-Parameter-Eigenschaften, weil sie beim blossen Typ-Entfernen Code
  // hinterliessen. Faellt nur in `tsc -b` auf, nicht in `--noEmit`.
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'HttpFehler'
    this.status = status
  }
}
async function jn<T>(r: Response): Promise<T> {
  if (!r.ok) {
    throw new HttpFehler((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`, r.status)
  }
  return r.json() as Promise<T>
}
const get = <T>(u: string): Promise<T> => fetch(u).then(jn<T>)

export function audioUrl(project: string, base: string) {
  return `/api/projects/${enc(project)}/audio/${enc(base)}`
}
export async function listProjects(): Promise<Project[]> {
  return (await jn<{ projects: Project[] }>(await fetch('/api/projects'))).projects
}
/** Dateien EINES Projekts — fuer die Arbeitsflaeche und den Editor, die nicht mehr die
 *  ganze Projektliste (inkl. aller fremden Dateien) mitschleppen wollen. */
export function getProjectFiles(project: string): Promise<{ name: string; files: ProjectFile[] }> {
  return get(`/api/projects/${enc(project)}`)
}
/** Per-Projekt-Einstellungen (Sprache, Korrekturtiefe) + die zur Verfuegung stehenden Auswahlen. */
export async function getProjektEinstellungen(project: string): Promise<ProjectEinstellungen> {
  return get(`/api/projects/${enc(project)}/einstellungen`)
}
/** Nur gesetzte Felder senden (Partial). Der PUT echo't {sprache, korrektur} — ohne die
 *  Wahlmoeglichkeiten, die nur der GET liefert (siehe EinstellungenWerte). */
export async function saveProjektEinstellungen(
  project: string, patch: Partial<EinstellungenWerte>,
): Promise<EinstellungenWerte> {
  return jn(await fetch(`/api/projects/${enc(project)}/einstellungen`,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }))
}
/** Per-Datei-Einstellungen (Override, sonst Projekt-Standard) — Datei-Pendant von
 *  getProjektEinstellungen. Liefert dieselben Auswahlen (sprach_choices/tiefen). */
export async function getFileEinstellungen(project: string, base: string): Promise<DateiEinstellungen> {
  return get(`/api/projects/${enc(project)}/files/${enc(base)}/einstellungen`)
}
/** Schreibt den Datei-Override; nur gesetzte Felder senden (Partial).
 *  ANDERS als `saveProjektEinstellungen`: `sprache: null` und `mehrsprachig: null` sind hier
 *  eigene Befehle („Override entfernen", #166/#234), kein „nicht anfassen" — das Feld einfach
 *  wegzulassen bedeutet Letzteres. Am Projekt-Endpunkt ist `null` dagegen ein No-op (dort gibt
 *  es nichts zu erben). `korrektur` hat den Weg nicht: dort ist `auto` der Rueckweg.
 *  Reiner Schreibpfad; die Trigger (retranscribe/correct) stößt der Aufrufer separat an.
 *  Die Antwort trägt zusätzlich `sprache_eigen`/`_projekt`, `mehrsprachig_eigen`/`_projekt`
 *  und `sprecher`; der engere Rückgabetyp genügt den Aufrufern und bleibt damit gleich.
 *  **Das ist die harmlose Richtung von #239:** dort log der Typ (der PUT lieferte WENIGER als
 *  er behauptete), hier verschweigt er nur. Wer die Antwort auswertet statt bloss auf ihr
 *  Gelingen zu warten, weitet vorher den Typ — sonst ist das Feld unsichtbar da. */
export async function saveFileEinstellungen(
  project: string, base: string, patch: DateiEinstellungenPatch,
): Promise<EinstellungenWerte> {
  return jn(await fetch(`/api/projects/${enc(project)}/files/${enc(base)}/einstellungen`,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }))
}
/** Zeitlimit fuers Laden des Editor-Dokuments.
 *
 *  Ein `fetch` ohne Limit kann unbegrenzt offen bleiben (Verbindung steht, Antwort kommt nie —
 *  uvicorn mitten im Neustart, abgerissene WLAN-Strecke). Fuer `useDoc` ist das kein blosser
 *  Spinner: solange der Ladelauf offen ist, schreibt der Autosave nicht (sonst ginge die frisch
 *  geholte Fassung verloren), und die Leiste zeigt weiter „wird gespeichert“. Ohne Limit gaebe
 *  es aus diesem Zustand keinen Rueckweg. Mit ihm laeuft der `.catch`-Zweig, und #121 raeumt auf.
 *
 *  30 s, nicht knapper: ein kalter Serverstart importiert torch und laedt die Diarisierung.
 *  **Nur am GET** — ein Limit am `saveDoc`-PUT wuerde die Fehler-Episode aus #107 (drei Retries,
 *  finaler Toast) neu takten, und dort ist ein Fehlschlag bereits behandelt. */
const LADE_ZEITLIMIT_MS = 30_000

/** Zeitlimit fuers SENDEN (#299). Zwei Unterschiede zum GET oben, beide tragend:
 *
 *  **Die Frist waechst mit der Datei.** Ein Upload uebertraegt Audio; die 30 s eines
 *  JSON-Endpunkts schnitten einen echten Upload ab, statt einen haengenden abzuraeumen.
 *  Bemessen wird an der uebertragenen Menge, nicht an einer Antwortzeit. 1 MB/s ist die
 *  angesetzte Untergrenze und dafuer absichtlich weit unter der Wirklichkeit: der Server
 *  steht auf `127.0.0.1` (die Origin-Middleware in `app.py` weist alles andere mit 403 ab),
 *  die Strecke ist also Loopback plus ein Schreibvorgang auf die lokale Platte.
 *
 *  **Die Uebertragung ist aber nicht der einzige Zeitfresser, und daran haengt die
 *  Grundfrist.** `upload_audio` ruft bei gesetzter Sprache oder Sprecherzahl
 *  `projekt.setze_datei` → `sperre.datei(...)` mit `stale=60`; dessen Warteschleife gibt
 *  erst nach `sperre.frist(60)` = **65 s** auf bzw. greift erzwungen zu. Eine Grundfrist
 *  von 60 s waere damit KUERZER als die Worst-Case-Wartezeit im selben Request gewesen —
 *  die Frist haette einen Vorgang abgeschnitten, der noch regulaer laeuft. 90 s liegen
 *  darueber, mit Luft. (Bewusst eine eigene Zahl mit hingeschriebener Herleitung, keine
 *  zweite Quelle fuer `sperre.frist()`: die steht in Python und ist von hier nicht lesbar;
 *  ein Waechter im Test haelt sie ueber 65 s.)
 *  Die Frist soll „irgendwann aufgeben" heissen, nicht „schnell genug sein".
 *
 *  **Ein gerissenes Limit heisst NICHT „fehlgeschlagen".** Anders als beim Laden ist der
 *  Abbruch hier nicht folgenlos: der Server kann die Datei bereits geschrieben und den
 *  Transkriptions-Job gestartet haben. Wer daraufhin erneut hochlaedt, bekommt einen 409. */
const UPLOAD_GRUNDFRIST_MS = 90_000
const UPLOAD_MS_JE_MB = 1_000
const SENDE_ZEITLIMIT_MS = 30_000

/** `Math.ceil` ist Pflicht, nicht Kosmetik: Node wirft bei einem Bruchteil
 *  `RangeError: The value of "delay" is out of range`, und der Wurf kaeme VOR dem `fetch`,
 *  also als Absturz statt als Fehlschlag. Betroffen ist jede Groesse, die kein Vielfaches
 *  von 1000 Bytes ist — eine 1-Byte-Datei ergibt `90000.000001`. (Die urspruengliche
 *  Messung nannte hier `60000.001`; das war die Grundfrist VOR der Anhebung auf 90 s und
 *  stand danach als veraltete Zahl in einem Kommentar — genau die Fehlerklasse, gegen die
 *  dieses Repo am haeufigsten anlaeuft.) Der Browser
 *  runde still (WebIDL `unsigned long long`), der Testlauf haette den Aufruf also gar nicht
 *  erst zugelassen — dieselbe Plattformdifferenz, nur andersherum als sonst. */
const uploadFrist = (bytes: number) =>
  Math.ceil(UPLOAD_GRUNDFRIST_MS + (bytes / 1_000_000) * UPLOAD_MS_JE_MB)

/** Ein gerissenes SENDE-Zeitlimit als eigener Typ — wie `HttpFehler`, und aus demselben
 *  Grund: der Aufrufer muss es am TYP erkennen koennen, nicht am Meldungstext. Eine
 *  Umformulierung liesse eine Textpruefung sonst still auf den falschen Zweig fallen.
 *
 *  Gebraucht wird das im URL-Zweig von `MaterialDialog`: nach einem Zeitlimit darf er die
 *  Links NICHT erneut anbieten. Anders als beim Upload faengt den kein 409 ab —
 *  `fetch.download_one` legt ueber `unique_base` eine ZWEITE Datei an, die dann auch noch
 *  transkribiert und korrigiert wird. */
export class SendeZeitlimit extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SendeZeitlimit'
  }
}

/** Uebersetzt NUR das gerissene Zeitlimit; alles andere geht unveraendert weiter — der
 *  `HttpFehler` samt `status` muss durch, weil `MaterialDialog` die Dublette (409) daran von
 *  einem echten Fehlschlag unterscheidet. Gibt den Fehler ZURUECK statt zu werfen: ein
 *  `never`-Rueckgabetyp haenge an TS' Unerreichbarkeits-Analyse, `throw sendeFehler(...)` ist
 *  an der Aufrufstelle ohne Kniff zu lesen. */
function sendeFehler(e: unknown, folge: string): Error {
  return (e as Error)?.name === 'TimeoutError'
    ? new SendeZeitlimit(`Zeitlimit überschritten — ${folge}. Nach dem Neuladen zeigt die Liste, was angekommen ist.`)
    : e as Error
}

export async function getDoc(project: string, base: string): Promise<EditDoc> {
  return jn(await fetch(`/api/projects/${enc(project)}/files/${enc(base)}`,
    { signal: AbortSignal.timeout(LADE_ZEITLIMIT_MS) }))
}
/** Speichert und liefert den NEUEN `dateistand` zurueck (#160). Ohne den liefe der naechste
 *  Autosave gegen die eigene Schreibung von gerade eben und bekaeme 409 — die Sperre schluege
 *  bei jedem zweiten Speichern zu, ohne dass ein fremder Schreiber beteiligt waere. */
export async function saveDoc(
  project: string, base: string, doc: EditDoc,
): Promise<{ dateistand?: string }> {
  return jn(await fetch(`/api/projects/${enc(project)}/files/${enc(base)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(doc) }))
}
export type ExportFmt = 'md' | 'srt'
/** md -> /export, srt -> /export/srt; die Antwort traegt das Format als Schluessel.
 *  `sprecher=false` gilt nur fuer .srt (blendet die ">> Name:"-Praefixe aus). */
export async function exportText(
  project: string, base: string, fmt: ExportFmt, sprecher = true,
): Promise<string> {
  const pfad = fmt === 'md' ? '' : `/${fmt}${sprecher ? '' : '?sprecher=false'}`
  return (await jn<Record<ExportFmt, string>>(await fetch(
    `/api/projects/${enc(project)}/files/${enc(base)}/export${pfad}`,
    { method: 'POST' })))[fmt]
}
/** Body ist optional: fast alle POSTs hier sind reine Auslöser ohne Nutzlast. */
const post = (u: string, body?: unknown) => fetch(u, {
  method: 'POST',
  ...(body === undefined ? {} : {
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }),
})
export async function startTranscribe(project: string): Promise<StartJob> {
  return jn(await post(`/api/projects/${enc(project)}/transcribe`))
}
export async function startCorrect(project: string): Promise<StartJob> {
  return jn(await post(`/api/projects/${enc(project)}/correct`))
}
export async function startCorrectFile(project: string, base: string, force: boolean): Promise<StartJob> {
  return jn(await post(`/api/projects/${enc(project)}/files/${enc(base)}/correct${force ? '?force=true' : ''}`))
}
/** Transkript verwerfen und neu erzeugen. Raeumt serverseitig AUCH edit.json/md/srt weg —
 *  ohne das zeigte der Editor weiter den alten Text (load_or_build_doc bevorzugt edit.json). */
export async function startRetranscribeFile(project: string, base: string): Promise<StartJob> {
  return jn(await post(`/api/projects/${enc(project)}/files/${enc(base)}/transcribe`))
}
/** Eine einzelne Aufnahme samt Audio loeschen; das Projekt bleibt. */
export async function deleteFile(project: string, base: string): Promise<void> {
  await jn(await fetch(`/api/projects/${enc(project)}/files/${enc(base)}`, { method: 'DELETE' }))
}
export async function fetchUrls(project: string, urls: string[],
                                sprache?: string | (string | null)[],
                                mehrsprachig?: boolean,
                                sprecher?: (number | null)[]): Promise<StartJob> {
  try {
    // `return await`, nicht `return`: in einer async-Funktion laeuft die Ablehnung eines
    // ZURUECKGEGEBENEN Promise am eigenen `catch` vorbei — der `HttpFehler` aus `jn` kaeme
    // dann nie bei `sendeFehler` an, und dessen Durchlass-Zweig waere unerreichbar. Die
    // Mutationsprobe hat genau das aufgedeckt: „HttpFehler kommt durch" stimmte, aber aus
    // dem falschen Grund, und ein spaeter ergaenztes `await` haette es still gekippt.
    return await jn(await fetch(`/api/projects/${enc(project)}/fetch`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    // Der Handler validiert nur und startet einen Job — der Download laeuft im Subprozess.
    // Hier reicht die Frist eines JSON-Endpunkts.
    signal: AbortSignal.timeout(SENDE_ZEITLIMIT_MS),
    // `sprache` faellt nur weg, wenn sie GAR NICHT gesetzt ist. Eine leere Liste ist ein
    // gueltiger Wert und darf nicht als „nicht gesetzt" durchgehen — deshalb
    // `=== undefined` und nicht das truthy `sprache ?`, das hier bisher stand. Der
    // Parameter bleibt an Position 3 und wird nur im TYP breiter: ein Umsortieren waere
    // eine stille Bruchstelle fuer jeden bestehenden Aufrufer.
    body: JSON.stringify({ urls, ...(sprache === undefined ? {} : { sprache }),
                           ...(mehrsprachig === undefined ? {} : { mehrsprachig }),
                           // Index-parallel zu `urls`; ganz weglassen, wenn keine Zahl dabei
                           // ist — dann bleibt der Aufruf byte-gleich zu vorher. Ein leeres
                           // Feld reist als `null` mit und HAELT seinen Platz: mit `undefined`
                           // fiele der Eintrag in JSON.stringify weg und jede folgende Zahl
                           // rutschte eine Aufnahme nach vorn.
                           ...(sprecher === undefined ? {} : { sprecher }) }),
    }))
  } catch (e) { throw sendeFehler(e, 'der Import ist möglicherweise trotzdem gestartet') }
}
export async function getJob(jobId: string): Promise<JobStatus> {
  return jn(await fetch(`/api/jobs/${enc(jobId)}`))
}
export async function cancelJob(jobId: string): Promise<void> {
  await post(`/api/jobs/${enc(jobId)}/cancel`)
}
/** Der Upload stoesst serverseitig direkt die Transkription an -> job_id/started kommen mit zurueck.
 *  `sprache` ist optional: nur gesetzt, wenn das Projekt eine abweichende Sprache vorgibt.
 *  `mehrsprachig` ebenso — undefined heisst „kein Datei-Override“, der Projektwert gilt. */
export async function uploadAudio(project: string, file: File, sprache?: string,
                                  mehrsprachig?: boolean, sprecher?: number):
  Promise<{ base: string; file: string; job_id?: string; started?: boolean }> {
  const fd = new FormData(); fd.append('file', file)
  if (sprache) fd.append('sprache', sprache)
  if (mehrsprachig !== undefined) fd.append('mehrsprachig', String(mehrsprachig))
  // Nur bei einer echten Zahl: ein leeres Feld heisst „automatisch", und ein mitgeschicktes
  // "" waere fuer FastAPI ein Typfehler (422) statt eines ausgelassenen Feldes.
  if (sprecher !== undefined) fd.append('sprecher', String(sprecher))
  try {
    // `return await` — siehe `fetchUrls`: ohne das `await` erreicht die `jn`-Ablehnung den
    // eigenen `catch` nicht, und der 409 der Dublette liefe an `sendeFehler` vorbei.
    return await jn(await fetch(`/api/projects/${enc(project)}/audio`,
      { method: 'POST', body: fd, signal: AbortSignal.timeout(uploadFrist(file.size)) }))
  } catch (e) { throw sendeFehler(e, 'die Aufnahme ist möglicherweise trotzdem angekommen') }
}
export async function createProject(name: string): Promise<{ ok: boolean; name: string }> {
  return jn(await fetch('/api/projects', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  }))
}
/** Projekt umbenennen = Ordner umbenennen; die Aufnahmen wandern mit. */
export async function renameProject(project: string, name: string): Promise<{ name: string }> {
  return jn(await post(`/api/projects/${enc(project)}/rename`, { name }))
}
/** Aufnahme umbenennen: Audio UND alle abgeleiteten Dateien in einem Zug — der Basisname
 *  ist die Verbindung zwischen beiden. */
export async function renameFile(project: string, base: string, name: string): Promise<{ name: string }> {
  return jn(await post(`/api/projects/${enc(project)}/files/${enc(base)}/rename`, { name }))
}
export async function deleteProject(project: string): Promise<void> {
  await jn(await fetch(`/api/projects/${enc(project)}`, { method: 'DELETE' }))
}
export async function getSettings(): Promise<Settings> {
  return jn(await fetch('/api/settings'))
}
export async function getHardware(): Promise<Hardware> {
  return jn(await fetch('/api/hardware'))
}
/** Nur gesetzte Felder senden — ein ausgelassenes api_key laesst den gespeicherten Key stehen.
 *  `ungeschuetzt: true` heisst „geschrieben, aber ohne Schreibsperre" (#194) — es gehört NICHT
 *  in `Settings`: es beschreibt diesen einen Schreibvorgang, nicht den Zustand des Servers, und
 *  in den Zustand gemischt bliebe die Warnung für immer stehen.
 *
 *  **Der Rückgabetyp ist seit #239 wahr.** Vorher lieferte der PUT `providers`, `env_key`,
 *  `whisper_choices`, `ai_ready` und `ai_reason` NICHT — es fiel nur nicht auf, weil
 *  `SettingsPage.speichern` zusammenmischte und die fehlenden Felder aus dem vorigen Stand
 *  überlebten. Beide Endpunkte bauen ihren Rumpf jetzt aus `app._settings_body`; der Wächter
 *  dagegen steht im pytest (`test_settings_put_liefert_denselben_rumpf_wie_der_get`), weil eine
 *  Attrappe hier den Vertrag gar nicht prüfen kann — sie behauptet ihn.
 *
 *  **Pflichtfeld, nicht `?`:** der Server schickt es bei jedem PUT. Als optional getippt müsste
 *  keine Attrappe es nennen — hörte der Server eines Tages auf, es zu schicken, verschwände die
 *  Warnung still und kein Test würde rot. Der Preis ist, dass jede Attrappe es setzen muss, und
 *  genau das ist der Zweck. */
export async function saveSettings(patch: Record<string, string>):
    Promise<Settings & { ungeschuetzt: boolean }> {
  return jn(await fetch('/api/settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
  }))
}
/** Die beiseitegelegte Einstellungsdatei entfernen, wenn der Nutzer sie ausgewertet hat. */
export async function verwerfeKaputt(): Promise<void> {
  await jn(await fetch('/api/settings/kaputt', { method: 'DELETE' }))
}
/** Stösst pip an und kehrt SOFORT zurück (#174) — vorher hing der Request bis zu 340 s.
 *  `gestartet: false` heisst „es läuft schon einer"; in beiden Fällen fragt der Aufrufer über
 *  `getSettings()` nach, bis `ytdlp.laeuft` false ist, und liest dann `ytdlp.ergebnis`. */
export async function updateYtdlp(): Promise<{ gestartet: boolean } & YtdlpStand> {
  return jn(await post('/api/settings/ytdlp/update'))
}
export async function listModels(): Promise<ModelInfo[]> {
  return (await jn<{ models: ModelInfo[] }>(await fetch('/api/settings/models'))).models
}
export async function testSettings(): Promise<{ ok: boolean; detail: string }> {
  return jn(await post('/api/settings/test'))
}
export async function getAuth(): Promise<AuthStatus> {
  return jn(await fetch('/api/settings/auth'))
}
export async function startLogin(): Promise<LoginState> {
  return jn(await post('/api/settings/auth/login'))
}
export async function loginState(): Promise<LoginState> {
  return jn(await fetch('/api/settings/auth/login'))
}
export async function submitLoginCode(code: string): Promise<LoginState> {
  return jn(await post('/api/settings/auth/login/code', { code }))
}
export async function cancelLogin(): Promise<LoginState> {
  return jn(await post('/api/settings/auth/login/cancel'))
}
