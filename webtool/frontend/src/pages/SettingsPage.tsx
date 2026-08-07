import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { KeyRound, Loader2, RefreshCw } from 'lucide-react'
import { getSettings, listModels, saveSettings, testSettings } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { ModelInfo, ProviderInfo, Settings } from '@/lib/types'

export function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null)
  const [modelle, setModelle] = useState<ModelInfo[]>([])
  const [key, setKey] = useState('')          // nur der NEU eingetippte Key; der gespeicherte kommt nie her
  const [laedt, setLaedt] = useState(false)
  const [testet, setTestet] = useState(false)

  useEffect(() => { getSettings().then(setS).catch(e => toast.error(String(e))) }, [])

  const prov: ProviderInfo | undefined = s?.providers.find(p => p.id === s.provider)
  const istAbo = s?.provider === 'claude-cli'

  // Nach jedem Speichern neu laden: die Liste haengt am Anbieter UND am Key.
  const modelleLaden = useCallback(async () => {
    setLaedt(true)
    try { setModelle(await listModels()) }
    catch (e) { setModelle([]); toast.error(`Modelle: ${(e as Error).message}`) }
    finally { setLaedt(false) }
  }, [])

  const speichern = async (patch: Record<string, string>, danach?: () => void) => {
    try {
      const neu = await saveSettings(patch)
      setS(cur => cur && { ...cur, ...neu })
      danach?.()
    } catch (e) { toast.error(`Speichern fehlgeschlagen: ${(e as Error).message}`) }
  }

  const anbieterWechseln = (id: string) => {
    const p = s?.providers.find(x => x.id === id)
    setModelle([])
    // Modell mitzurücksetzen ist Absicht: ein Modellname des alten Anbieters ist beim neuen ungültig.
    speichern({ provider: id, model: p?.default_model ?? '', base_url: '' })
  }

  const testen = async () => {
    setTestet(true)
    const r = await testSettings().catch(e => ({ ok: false, detail: String(e) }))
    setTestet(false)
    r.ok ? toast.success(r.detail || 'Verbindung steht') : toast.error(r.detail || 'Fehlgeschlagen')
  }

  if (!s) return <div className="mx-auto max-w-2xl p-6 text-sm text-muted-foreground">Lädt…</div>

  return (
    <div className="mx-auto max-w-2xl p-6">
      <div className="mb-3 flex items-center gap-3">
        <Link className="text-sm text-muted-foreground hover:underline" to="/">‹ Home</Link>
        <h1 className="text-xl font-semibold">Einstellungen</h1>
      </div>
      <p className="mb-6 text-sm text-muted-foreground">
        Womit korrigiert Transkribor die Transkripte? Die Transkription selbst läuft immer lokal
        mit Whisper auf deiner GPU — nur die Korrektur und Sprecher-Zuordnung braucht ein Sprachmodell.
      </p>

      <label className="mb-1 block text-sm font-medium">Anbieter</label>
      <Select value={s.provider} onValueChange={anbieterWechseln}>
        <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent>
          {s.providers.map(p => <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>)}
        </SelectContent>
      </Select>
      {prov?.hint && <p className="mt-1 text-xs text-muted-foreground">{prov.hint}</p>}

      {prov && !istAbo && (
        <div className="mt-6 space-y-6">
          {prov.id === 'custom' && (
            <div>
              <label className="mb-1 block text-sm font-medium">Basis-URL</label>
              <Input defaultValue={s.base_url} placeholder="http://localhost:11434/v1"
                onBlur={e => e.target.value !== s.base_url && speichern({ base_url: e.target.value })} />
            </div>
          )}

          <div>
            <label className="mb-1 block text-sm font-medium">API-Key</label>
            <div className="flex gap-2">
              <Input type="password" value={key} onChange={e => setKey(e.target.value)}
                placeholder={s.has_key ? '•••••••• (gespeichert)' : 'sk-…'} autoComplete="off" />
              <Button variant="outline" disabled={!key}
                onClick={() => speichern({ api_key: key }, () => { setKey(''); toast.success('Key gespeichert') })}>
                <KeyRound className="size-4" /> Speichern
              </Button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Wird nur lokal in deinem Benutzerprofil gespeichert und nie wieder angezeigt.
              {prov.keys_url && <> <a className="underline" href={prov.keys_url} target="_blank" rel="noreferrer">Key erstellen</a></>}
              {s.env_key && <> · Umgebungsvariable {s.env_key} ist gesetzt.</>}
            </p>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">Modell</label>
            <div className="flex gap-2">
              {modelle.length > 0 ? (
                <Select value={s.model} onValueChange={m => speichern({ model: m })}>
                  <SelectTrigger className="w-full"><SelectValue placeholder="Modell wählen" /></SelectTrigger>
                  <SelectContent>
                    {modelle.map(m => <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              ) : (
                <Input defaultValue={s.model} placeholder="Modellname"
                  onBlur={e => e.target.value !== s.model && speichern({ model: e.target.value })} />
              )}
              <Button variant="outline" onClick={modelleLaden} disabled={laedt} title="Modelle vom Anbieter laden">
                {laedt ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              </Button>
            </div>
          </div>
        </div>
      )}

      <div className="mt-8 flex items-center gap-2">
        <Button onClick={testen} disabled={testet}>
          {testet && <Loader2 className="size-4 animate-spin" />} Verbindung testen
        </Button>
        <span className="text-xs text-muted-foreground">
          Änderungen greifen sofort — auch für schon laufende Korrekturen ab dem nächsten Block.
        </span>
      </div>
    </div>
  )
}
