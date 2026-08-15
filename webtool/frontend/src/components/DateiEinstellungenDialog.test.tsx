import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import * as api from '@/lib/api'
import { DateiEinstellungenDialog } from './DateiEinstellungenDialog'
import type { ProjectFile } from '@/lib/types'

const BASIS = {
  // `mehrsprachig` = effektiv, `_eigen` = Datei-Override (null: folgt dem Projekt),
  // `_projekt` = der Standard, den sie dann erbt (#166).
  sprache: 'ch', korrektur: 'auto', mehrsprachig: false,
  mehrsprachig_eigen: null, mehrsprachig_projekt: false,
  sprach_choices: [
    { id: 'ch', label: 'Schweizerdeutsch', hint: '' },
    { id: 'en', label: 'Englisch', hint: '' },
  ],
  tiefen: [{ id: 'auto', label: 'Automatisch (aus Sprache)' }, { id: 'voll_dialekt', label: 'Voll (mit Dialekt)' }, { id: 'leicht', label: 'Leicht' }],
}
const datei = (p: Partial<ProjectFile> = {}): ProjectFile =>
  ({ base: 'a', has_audio: true, has_raw: true, has_edit: false, has_md: false, ...p })

/** shadcn-Select öffnen: der Trigger portalt nach document.body; container-Query greift nicht. */
const spracheWaehlen = async (label: string) => {
  fireEvent.click(document.body.querySelector('[role="combobox"]')!)
  fireEvent.click(await screen.findByText(label))
}

describe('DateiEinstellungenDialog', () => {
  it('lädt die effektiven Werte und zeigt sie an', async () => {
    const getSpy = vi.spyOn(api, 'getFileEinstellungen').mockResolvedValue(BASIS)
    render(<DateiEinstellungenDialog project="p" base="a" file={datei()} offen />)
    await waitFor(() => expect(screen.getByText('Schweizerdeutsch')).toBeInTheDocument())
    getSpy.mockRestore()
  })

  it('zeigt bei korrektur="auto" das Auto-Label im Tiefe-Trigger (nicht leer, #141)', async () => {
    vi.spyOn(api, 'getFileEinstellungen').mockResolvedValue(BASIS)
    render(<DateiEinstellungenDialog project="p" base="a" file={datei()} offen />)
    await screen.findByText('Schweizerdeutsch')              // Sprache-Trigger = Readiness-Signal
    // Tiefe-Select ist der zweite combobox; seit #141 ist "auto" in TIEFEN, darum steht das
    // Label im Trigger statt leer. Deckt das geteilte tiefen.map-Muster beider Dialoge.
    expect(screen.getAllByRole('combobox')[1]).toHaveTextContent('Automatisch')
  })

  it('deaktiviert Speichern, solange nichts geändert ist', async () => {
    vi.spyOn(api, 'getFileEinstellungen').mockResolvedValue(BASIS)
    render(<DateiEinstellungenDialog project="p" base="a" file={datei()} offen />)
    expect(await screen.findByText('Speichern')).toBeDisabled()
  })

  it('zeigt bei Sprache-Änderung + has_raw den Transkriptions-Hinweis und den Trigger-Knopf', async () => {
    vi.spyOn(api, 'getFileEinstellungen').mockResolvedValue(BASIS)
    render(<DateiEinstellungenDialog project="p" base="a" file={datei({ has_edit: true })} offen />)
    await screen.findByText('Schweizerdeutsch')
    await spracheWaehlen('Englisch')
    expect(screen.getByText(/erfordert eine Neu-Transkription/)).toBeInTheDocument()
    expect(screen.getByText(/handbearbeiteten Fassung/)).toBeInTheDocument()   // has_edit
    expect(screen.getByRole('button', { name: 'Speichern & neu transkribieren' })).toBeEnabled()
  })

  it('zeigt bei nur-Tiefe-Änderung den Korrektur-Knopf', async () => {
    vi.spyOn(api, 'getFileEinstellungen').mockResolvedValue(BASIS)
    render(<DateiEinstellungenDialog project="p" base="a" file={datei()} offen />)
    // Readiness-Signal ist der Sprache-Trigger (stabil vorhanden); der Tiefe-Trigger zeigt
    // bei korrektur='auto' mittlerweile das Auto-Label (seit #141 in TIEFEN enthalten).
    await screen.findByText('Schweizerdeutsch')
    // Ueber den Namen, NICHT ueber "letzte combobox": seit #166 steht die Mehrsprachig-Auswahl
    // dahinter, und der Index zeigte dann still auf das falsche Bedienelement.
    fireEvent.click(screen.getByRole('combobox', { name: /korrektur-tiefe/i }))
    fireEvent.click(await screen.findByText('Leicht'))
    expect(screen.getByRole('button', { name: 'Speichern & neu korrigieren' })).toBeEnabled()
  })

  it('ruft onGespeichert mit den richtigen Flags und speichert nur bei Änderung', async () => {
    const saveSpy = vi.spyOn(api, 'saveFileEinstellungen')
      .mockResolvedValue({ sprache: 'en', korrektur: 'auto', mehrsprachig: false })
    const onGespeichert = vi.fn()
    const onOpenChange = vi.fn()
    vi.spyOn(api, 'getFileEinstellungen').mockResolvedValue(BASIS)
    render(<DateiEinstellungenDialog project="p" base="a" file={datei()} offen
      onOpenChange={onOpenChange} onGespeichert={onGespeichert} />)
    await screen.findByText('Schweizerdeutsch')
    await spracheWaehlen('Englisch')
    fireEvent.click(screen.getByRole('button', { name: 'Speichern & neu transkribieren' }))
    await waitFor(() => expect(saveSpy).toHaveBeenCalledWith('p', 'a', expect.objectContaining({ sprache: 'en' })))
    expect(onGespeichert).toHaveBeenCalledWith({ neuTranskribieren: true, tiefeGeaendert: false })
    expect(onOpenChange).toHaveBeenCalledWith(false)
    saveSpy.mockRestore()
  })

  it('zeigt bei !has_raw den Hinweis zur nächsten Transkription und keinen Trigger-Knopf', async () => {
    vi.spyOn(api, 'getFileEinstellungen').mockResolvedValue(BASIS)
    render(<DateiEinstellungenDialog project="p" base="a" file={datei({ has_raw: false })} offen />)
    await screen.findByText('Schweizerdeutsch')
    await spracheWaehlen('Englisch')
    expect(screen.getByText(/nächsten Transkription/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /neu transkribieren/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Speichern' })).toBeEnabled()
  })
})

describe('DateiEinstellungenDialog — Zustand beim Öffnen', () => {
  it('zeigt nach einem fehlgeschlagenen GET NICHT das Formular des vorigen Aufrufs', async () => {
    /* Ohne Rücksetzen bleibt `data` aus dem letzten erfolgreichen Laden stehen: der Dialog
       stünde bedienbar da, mit den Werten einer ANDEREN Datei, und ein Klick auf Speichern
       schriebe sie auf die jetzt geöffnete. Der Fall ist selten, die Folge still. */
    const spy = vi.spyOn(api, 'getFileEinstellungen').mockResolvedValue(BASIS)
    const { rerender } = render(
      <DateiEinstellungenDialog project="p" base="a" file={datei()} offen />)
    await screen.findByText('Schweizerdeutsch')          // erster Aufruf geladen

    rerender(<DateiEinstellungenDialog project="p" base="a" file={datei()} offen={false} />)
    spy.mockRejectedValue(new Error('weg'))
    rerender(<DateiEinstellungenDialog project="p" base="b" file={datei()} offen />)
    // ZUERST belegen, dass der Dialog wirklich offen und der zweite GET durch ist — sonst ist
    // „kein Wähler da" schon wahr, bevor Radix seinen Inhalt einhängt, und der Test bestünde
    // aus dem falschen Grund (genau so ueberlebte er beim ersten Anlauf seine Mutation).
    await screen.findByRole('heading', { name: /„b“/ })
    expect(screen.queryByRole('combobox', { name: 'Sprache' })).not.toBeInTheDocument()
    spy.mockRestore()
  })
})

describe('DateiEinstellungenDialog — mehrsprachig', () => {
  const wahl = () => screen.getByRole('combobox', { name: /mehrere sprachen/i })
  const waehle = async (label: RegExp) => {
    fireEvent.click(wahl())
    fireEvent.click(await screen.findByText(label))
  }
  const speichern = (r: Partial<{ mehrsprachig: boolean }> = {}) =>
    vi.spyOn(api, 'saveFileEinstellungen')
      .mockResolvedValue({ sprache: 'ch', korrektur: 'auto', mehrsprachig: true, ...r })

  it('schickt einen gesetzten Haken mit', async () => {
    vi.spyOn(api, 'getFileEinstellungen').mockResolvedValue(BASIS)
    const saveSpy = speichern()
    render(<DateiEinstellungenDialog project="p" base="a" file={datei()} offen />)
    await screen.findByText('Schweizerdeutsch')
    await waehle(/^Ja —/)
    fireEvent.click(screen.getByRole('button', { name: /speichern/i }))
    await waitFor(() => expect(saveSpy).toHaveBeenCalledWith(
      'p', 'a', expect.objectContaining({ mehrsprachig: true })))
    saveSpy.mockRestore()
  })

  it('„folgt dem Projekt" schickt NULL — der Rückweg aus #166', async () => {
    /* Der Kern des Issues: `datei_mehrsprachig` loest den Rueckfall ueber die ANWESENHEIT des
       Schluessels auf. `undefined` wuerde von JSON.stringify weggeworfen und hiesse „nicht
       anfassen" — dann bliebe der Override stehen und die Datei zoege bei einer Aenderung des
       Projekt-Standards nie wieder mit. Nur ein ausdrueckliches `null` entfernt ihn. */
    vi.spyOn(api, 'getFileEinstellungen').mockResolvedValue(
      { ...BASIS, mehrsprachig: true, mehrsprachig_eigen: true, mehrsprachig_projekt: false })
    const saveSpy = speichern()
    render(<DateiEinstellungenDialog project="p" base="a" file={datei()} offen />)
    await screen.findByText('Schweizerdeutsch')
    await waehle(/Folgt dem Projekt/)
    fireEvent.click(screen.getByRole('button', { name: /speichern/i }))
    await waitFor(() => expect(saveSpy).toHaveBeenCalledWith(
      'p', 'a', expect.objectContaining({ mehrsprachig: null })))
    saveSpy.mockRestore()
  })

  it('nennt den Projektwert in der Beschriftung — BEIDE Faelle', async () => {
    /* Ohne ihn entscheidet der Nutzer ueber einen Wert, den er erst woanders nachschlagen muss.
       BEIDE Faelle, weil nur der `true`-Fall eine fest verdrahtete Beschriftung „(ja)" nicht
       von der echten Ableitung unterscheidet — gemessen: mit hartkodiertem „(ja)" blieben
       alle 442 Tests gruen. */
    vi.spyOn(api, 'getFileEinstellungen').mockResolvedValue(
      { ...BASIS, mehrsprachig: true, mehrsprachig_eigen: null, mehrsprachig_projekt: true })
    const { unmount } = render(<DateiEinstellungenDialog project="p" base="a" file={datei()} offen />)
    expect(await screen.findByText(/Folgt dem Projekt \(ja\)/)).toBeInTheDocument()
    unmount()

    vi.spyOn(api, 'getFileEinstellungen').mockResolvedValue(
      { ...BASIS, mehrsprachig: false, mehrsprachig_eigen: null, mehrsprachig_projekt: false })
    render(<DateiEinstellungenDialog project="p" base="b" file={datei()} offen />)
    expect(await screen.findByText(/Folgt dem Projekt \(nein\)/)).toBeInTheDocument()
  })

  it('behandelt eine Haken-Änderung wie einen Sprachwechsel', async () => {
    /* Der Haken aendert, WIE Whisper dekodiert (multilingual + Kontext aus) — ein vorhandenes
       Transkript ist danach falsch. Ohne diese Verzweigung bliebe der Haken eine Einstellung
       ohne Wirkung auf bereits transkribierte Dateien. */
    vi.spyOn(api, 'getFileEinstellungen').mockResolvedValue(BASIS)
    const saveSpy = speichern()
    const onGespeichert = vi.fn()
    render(<DateiEinstellungenDialog project="p" base="a" file={datei({ has_raw: true })} offen
      onGespeichert={onGespeichert} />)
    await screen.findByText('Schweizerdeutsch')
    await waehle(/^Ja —/)
    fireEvent.click(screen.getByRole('button', { name: 'Speichern & neu transkribieren' }))
    await waitFor(() => expect(onGespeichert).toHaveBeenCalledWith(
      { neuTranskribieren: true, tiefeGeaendert: false }))
    saveSpy.mockRestore()
  })

  it('ein Wechsel OHNE Wirkung wird gespeichert, loest aber keine Neu-Transkription aus', async () => {
    /* Von „ja" auf „folgt dem Projekt (ja)": der Override verschwindet, das Ergebnis bleibt
       gleich. Wuerde hier neu transkribiert, kostete eine reine Aufraeumaktion einen kompletten
       GPU-Lauf; waere der Knopf grau, gaebe es den Rueckweg nicht. Beides zusammen ist der
       Grund fuer die zwei getrennten Bedingungen im Dialog. */
    vi.spyOn(api, 'getFileEinstellungen').mockResolvedValue(
      { ...BASIS, mehrsprachig: true, mehrsprachig_eigen: true, mehrsprachig_projekt: true })
    const saveSpy = speichern()
    render(<DateiEinstellungenDialog project="p" base="a" file={datei({ has_raw: true })} offen />)
    await screen.findByText('Schweizerdeutsch')
    await waehle(/Folgt dem Projekt/)
    const knopf = screen.getByRole('button', { name: 'Speichern' })   // NICHT „& neu transkribieren"
    expect(knopf).toBeEnabled()
    fireEvent.click(knopf)
    await waitFor(() => expect(saveSpy).toHaveBeenCalledWith(
      'p', 'a', expect.objectContaining({ mehrsprachig: null })))
    saveSpy.mockRestore()
  })

  it('ohne Änderung bleibt der Speichern-Knopf gesperrt', async () => {
    vi.spyOn(api, 'getFileEinstellungen').mockResolvedValue(
      { ...BASIS, mehrsprachig: true, mehrsprachig_eigen: true, mehrsprachig_projekt: false })
    render(<DateiEinstellungenDialog project="p" base="a" file={datei()} offen />)
    await screen.findByText('Schweizerdeutsch')
    expect(await screen.findByText(/^Ja —/)).toBeInTheDocument()   // Serverwert kommt an
    expect(screen.getByRole('button', { name: /speichern/i })).toBeDisabled()
  })
})
