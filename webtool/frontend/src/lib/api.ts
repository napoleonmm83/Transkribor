import type {
  Project, ProjectFile, EditDoc, JobStatus, StartJob, Settings, ModelInfo, Hardware, AuthStatus, LoginState, YtdlpStand,
  ProjectEinstellungen,
  EinstellungenWerte,
  DateiEinstellungen,
  DateiEinstellungenPatch,
} from './types'

const enc = encodeURIComponent
async function jn<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`)
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
 *  ANDERS als `saveProjektEinstellungen`: `mehrsprachig: null` ist hier ein eigener Befehl
 *  („Override entfernen", #166), kein „nicht anfassen" — das Feld einfach wegzulassen bedeutet
 *  Letzteres. Am Projekt-Endpunkt ist `null` dagegen ein No-op (dort gibt es nichts zu erben).
 *  Reiner Schreibpfad; die Trigger (retranscribe/correct) stößt der Aufrufer separat an.
 *  Die Antwort trägt zusätzlich `mehrsprachig_eigen`/`_projekt`; der engere Rückgabetyp
 *  genügt den Aufrufern und bleibt damit gleich. */
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

export async function getDoc(project: string, base: string): Promise<EditDoc> {
  return jn(await fetch(`/api/projects/${enc(project)}/files/${enc(base)}`,
    { signal: AbortSignal.timeout(LADE_ZEITLIMIT_MS) }))
}
export async function saveDoc(project: string, base: string, doc: EditDoc): Promise<void> {
  await jn(await fetch(`/api/projects/${enc(project)}/files/${enc(base)}`, {
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
export async function fetchUrls(project: string, urls: string[], sprache?: string,
                                mehrsprachig?: boolean): Promise<StartJob> {
  return jn(await fetch(`/api/projects/${enc(project)}/fetch`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls, ...(sprache ? { sprache } : {}),
                           ...(mehrsprachig === undefined ? {} : { mehrsprachig }) }),
  }))
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
                                  mehrsprachig?: boolean):
  Promise<{ base: string; file: string; job_id?: string; started?: boolean }> {
  const fd = new FormData(); fd.append('file', file)
  if (sprache) fd.append('sprache', sprache)
  if (mehrsprachig !== undefined) fd.append('mehrsprachig', String(mehrsprachig))
  return jn(await fetch(`/api/projects/${enc(project)}/audio`, { method: 'POST', body: fd }))
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
