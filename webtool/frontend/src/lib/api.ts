import type {
  Project, ProjectFile, EditDoc, JobStatus, StartJob, Settings, ModelInfo, Hardware, AuthStatus, LoginState,
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
export async function getDoc(project: string, base: string): Promise<EditDoc> {
  return jn(await fetch(`/api/projects/${enc(project)}/files/${enc(base)}`))
}
export async function saveDoc(project: string, base: string, doc: EditDoc): Promise<void> {
  await jn(await fetch(`/api/projects/${enc(project)}/files/${enc(base)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(doc) }))
}
export type ExportFmt = 'md' | 'srt'
/** md -> /export, srt -> /export/srt; die Antwort traegt das Format als Schluessel. */
export async function exportText(project: string, base: string, fmt: ExportFmt): Promise<string> {
  return (await jn<Record<ExportFmt, string>>(await fetch(
    `/api/projects/${enc(project)}/files/${enc(base)}/export${fmt === 'md' ? '' : `/${fmt}`}`,
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
export async function fetchUrls(project: string, urls: string[]): Promise<StartJob> {
  return jn(await fetch(`/api/projects/${enc(project)}/fetch`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ urls }),
  }))
}
export async function getJob(jobId: string): Promise<JobStatus> {
  return jn(await fetch(`/api/jobs/${enc(jobId)}`))
}
export async function cancelJob(jobId: string): Promise<void> {
  await post(`/api/jobs/${enc(jobId)}/cancel`)
}
/** Der Upload stoesst serverseitig direkt die Transkription an -> job_id/started kommen mit zurueck. */
export async function uploadAudio(project: string, file: File):
  Promise<{ base: string; file: string; job_id?: string; started?: boolean }> {
  const fd = new FormData(); fd.append('file', file)
  return jn(await fetch(`/api/projects/${enc(project)}/audio`, { method: 'POST', body: fd }))
}
export async function createProject(name: string): Promise<{ ok: boolean; name: string }> {
  return jn(await fetch('/api/projects', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  }))
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
/** Nur gesetzte Felder senden — ein ausgelassenes api_key laesst den gespeicherten Key stehen. */
export async function saveSettings(patch: Record<string, string>): Promise<Settings> {
  return jn(await fetch('/api/settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
  }))
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
