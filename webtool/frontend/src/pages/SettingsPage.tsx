import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { KeyRound, Loader2, RefreshCw } from 'lucide-react'
import { getHardware, getSettings, listModels, saveSettings, testSettings } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { Hardware, ModelInfo, ProviderInfo, Settings } from '@/lib/types'

export function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null)
  const [modelle, setModelle] = useState<ModelInfo[]>([])
  // Nur das NEU Eingetippte; die gespeicherten Geheimnisse kommen nie zum Frontend zurueck.
  const [key, setKey] = useState('')
  const [hf, setHf] = useState('')
  const [laedt, setLaedt] = useState(false)
  const [testet, setTestet] = useState(false)
  const [hw, setHw] = useState<Hardware | null>(null)

  useEffect(() => { getSettings().then(setS).catch(e => toast.error(String(e))) }, [])
  useEffect(() => { getHardware().then(setHw).catch(() => setHw(null)) }, [])

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

      <div className="mb-8 rounded-md border p-4">
        <label className="mb-1 block text-sm font-medium">Qualität der Transkription</label>
        <Select value={s.whisper_model} onValueChange={m => speichern({ whisper_model: m })}>
          <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            {s.whisper_choices.map(c => (
              <SelectItem key={c.id} value={c.id}>
                {c.label}{c.hint && ` — ${c.hint}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="mt-2 text-xs text-muted-foreground">
          {/* Ohne torch gibt es kein Rechenwerk, auf das man zeigen könnte — und ein
              CUDA-Hinweis wäre dann die falsche Fährte: es fehlt die ganze Umgebung. */}
          {!hw ? 'Gerät wird ermittelt …'
            : hw.torch_ok
              ? <>Rechnet auf: <span className="font-medium">{hw.name}</span></>
              : <span className="text-amber-600 dark:text-amber-500">
                  Die Python-Umgebung ist unvollständig (PyTorch fehlt) — bitte Transkribor
                  neu starten und die Einrichtung durchlaufen lassen.
                </span>}
          {hw?.torch_ok && hw.device === 'cpu' && (
            <span className="block text-amber-600 dark:text-amber-500">
              {s.whisper_model.startsWith('large')
                ? 'Ohne GPU braucht „Beste Qualität" auf der CPU sehr lange — für längere Interviews besser „Schnell und gut" wählen. '
                : ''}
              Wenn dieser Rechner eine NVIDIA-Grafikkarte hat, wurde PyTorch ohne CUDA
              installiert — dann die Umgebung neu einrichten.
            </span>
          )}
        </p>
      </div>

      {!s.ai_ready && (
        <div className="mb-6 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
          <span className="font-medium">Korrektur ist nicht eingerichtet.</span>{' '}
          {s.ai_reason} Die Transkription funktioniert trotzdem — nur die Korrektur und
          Sprecher-Zuordnung brauchen ein Sprachmodell.
        </div>
      )}

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
                <KeyRound className="size-4" /> Key speichern
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

      {/* Getrennt vom Anbieter: die Diarisierung laeuft lokal mit pyannote, das Token dient nur
          dem Modell-Download bei Hugging Face. */}
      <div className="mt-8 border-t pt-6">
        <label className="mb-1 block text-sm font-medium">Sprecher-Erkennung (optional)</label>
        <div className="flex gap-2">
          <Input type="password" value={hf} onChange={e => setHf(e.target.value)}
            placeholder={s.has_hf_token ? '•••••••• (gespeichert)' : 'Hugging-Face-Token (hf_…)'} autoComplete="off" />
          <Button variant="outline" disabled={!hf}
            onClick={() => speichern({ hf_token: hf }, () => { setHf(''); toast.success('Token gespeichert') })}>
            Token speichern
          </Button>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Ohne Token ordnet Transkribor die Sprecher allein aus dem Text zu. Mit Token trennt
          pyannote sie akustisch — dafür einmalig&nbsp;
          <a className="underline" href="https://huggingface.co/pyannote/speaker-diarization-community-1" target="_blank" rel="noreferrer">
            die Modellbedingungen akzeptieren</a> und&nbsp;
          <a className="underline" href="https://huggingface.co/settings/tokens" target="_blank" rel="noreferrer">ein Token erstellen</a>.
        </p>
      </div>

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
