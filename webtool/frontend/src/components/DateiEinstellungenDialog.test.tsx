import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import * as api from '@/lib/api'
import { DateiEinstellungenDialog } from './DateiEinstellungenDialog'
import type { ProjectFile } from '@/lib/types'

const BASIS = {
  // `sprache`/`mehrsprachig` = effektiv, `_eigen` = Datei-Override (null: folgt dem Projekt),
  // `_projekt` = der Standard, den sie dann erbt (#166 fuer den Haken, #234 fuer die Sprache).
  // Vorgabe hier: die Datei ERBT beides — der Normalfall, seit der Upload nur noch Abweichungen
  // schreibt. Wer einen Override braucht, setzt `sprache_eigen` im einzelnen Test.
  sprache: 'ch', korrektur: 'auto', mehrsprachig: false,
  sprache_eigen: null, sprache_projekt: 'ch',
  mehrsprachig_eigen: null, mehrsprachig_projekt: false,
  // Vorgabe `null` = automatisch schaetzen (Verhalten wie vor #264); `sprecher_max` kommt
  // vom Server, damit das Eingabefeld den Bereich nicht ein zweites Mal kennen muss.
  sprecher: null, sprecher_max: 20,
  sprach_choices: [
    { id: 'ch', label: 'Schweizerdeutsch', hint: '' },
    { id: 'en', label: 'Englisch', hint: '' },
  ],
  tiefen: [{ id: 'auto', label: 'Automatisch (aus Sprache)' }, { id: 'voll_dialekt', label: 'Voll (mit Dialekt)' }, { id: 'leicht', label: 'Leicht' }],
}
const datei = (p: Partial<ProjectFile> = {}): ProjectFile =>
  ({ base: 'a', has_audio: true, has_raw: true, has_edit: false, has_md: false, ...p })

/** Readiness-Signal: der Sprach-Wähler steht. Über die ROLLE, nicht über einen Sprachnamen —
 *  seit #234 zeigt der Trigger „Folgt dem Projekt (…)" statt des blossen Namens, und ein Test,
 *  der darauf zielt, misst die Beschriftung statt der Bereitschaft. */
const sprachWaehlerDa = () => screen.findByRole('combobox', { name: 'Sprache' })

/** shadcn-Select öffnen: der Trigger portalt nach document.body; container-Query greift nicht. */
const spracheWaehlen = async (label: string) => {
  fireEvent.click(document.body.querySelector('[role="combobox"]')!)
  // IN der geoeffneten Liste suchen, nicht global: seit #234 sagt der Sprach-Trigger selbst
  // „Folgt dem Projekt (…)", und der Mehrsprachig-Trigger daneben ebenfalls — ein globales
  // findByText findet dann zwei Elemente und der Test stirbt an seinem eigenen Helfer.
  fireEvent.click(await within(await screen.findByRole('listbox')).findByText(label))
}

describe('DateiEinstellungenDialog', () => {
  it('zeigt ohne eigenen Wert „folgt dem Projekt" — mit dem geerbten Namen (#234)', async () => {
    // Der Trigger muss BEIDES sagen: dass die Datei erbt, und WAS sie erbt. Nur „folgt dem
    // Projekt" liesse offen, worauf die naechste Transkription laeuft; nur „Schweizerdeutsch"
    // (der Stand vor #234) sah aus wie ein eigener Wert — und war beim Speichern auch einer.
    const getSpy = vi.spyOn(api, 'getFileEinstellungen').mockResolvedValue(BASIS)
    render(<DateiEinstellungenDialog project="p" base="a" file={datei()} offen />)
    expect(await sprachWaehlerDa()).toHaveTextContent('Folgt dem Projekt (Schweizerdeutsch)')
    getSpy.mockRestore()
  })

  it('macht aus einem Alt-Eintrag „sprache: \'\'" keinen leeren Wähler', async () => {
    /* Ein leerer String ist ein Eintrag, den es zu entfernen gibt — `datei_ansicht` reicht ihn
       deshalb bewusst durch. Im Dialog richtete er drei Schäden an: Radix zeigt bei `value=""`
       seinen Platzhalter (der Wähler stünde LEER da), `"" ?? projekt` bleibt `""` (`??` greift
       nur bei null/undefined), womit ohne jede Nutzeraktion „Speichern & neu transkribieren"
       erschiene — und ein Klick darauf schickte `{sprache: ""}` in ein 400. Erzeugt wurde so
       ein Eintrag vom URL-Import mit leerer `TRANSKRIBOR_FETCH_SPRACHE` (dort jetzt ebenfalls
       geschlossen). */
    const saveSpy = vi.spyOn(api, 'saveFileEinstellungen')
      .mockResolvedValue({ sprache: 'ch', korrektur: 'auto', mehrsprachig: false })
    vi.spyOn(api, 'getFileEinstellungen').mockResolvedValue({ ...BASIS, sprache_eigen: '' })
    render(<DateiEinstellungenDialog project="p" base="a" file={datei()} offen />)
    expect(await sprachWaehlerDa()).toHaveTextContent('Folgt dem Projekt (Schweizerdeutsch)')
    // Kein Phantom-Trigger: die Sprache ist effektiv unveraendert.
    expect(screen.queryByRole('button', { name: /neu transkribieren/ })).not.toBeInTheDocument()
    // Aufzuraeumen gibt es trotzdem etwas — der Knopf ist scharf und raeumt den Eintrag beim
    // ersten Oeffnen weg. **Genau deshalb normalisiert der SERVER `""` nicht zu `null`**
    // (CodeRabbit an PR #240 schlug das vor, gemessen): dann waere `sprachWahl === sprache_eigen`,
    // der Knopf grau — und der Alt-Eintrag bliebe fuer immer in projekt.json stehen, unsichtbar.
    // `sprache_eigen` sagt, was WIRKLICH in der Datei steht; das Aufraeumen ist der Dialog.
    const knopf = screen.getByRole('button', { name: 'Speichern' })
    expect(knopf).toBeEnabled()
    fireEvent.click(knopf)
    await waitFor(() => expect(saveSpy).toHaveBeenCalledWith('p', 'a',
      expect.objectContaining({ sprache: null })))
    saveSpy.mockRestore()
  })

  it('zeigt einen eigenen Wert als solchen an, nicht als geerbten', async () => {
    // Die Gegenprobe: ein Override sieht anders aus als eine Erbschaft. Ohne sie bliebe der
    // Test oben auch dann gruen, wenn der Dialog IMMER „folgt dem Projekt" anzeigte.
    vi.spyOn(api, 'getFileEinstellungen')
      .mockResolvedValue({ ...BASIS, sprache: 'en', sprache_eigen: 'en' })
    render(<DateiEinstellungenDialog project="p" base="a" file={datei()} offen />)
    const w = await sprachWaehlerDa()
    expect(w).toHaveTextContent('Englisch')
    expect(w).not.toHaveTextContent('Folgt dem Projekt')
  })

  it('zeigt bei korrektur="auto" das Auto-Label im Tiefe-Trigger (nicht leer, #141)', async () => {
    vi.spyOn(api, 'getFileEinstellungen').mockResolvedValue(BASIS)
    render(<DateiEinstellungenDialog project="p" base="a" file={datei()} offen />)
    await sprachWaehlerDa()              // Sprache-Trigger = Readiness-Signal
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
    await sprachWaehlerDa()
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
    await sprachWaehlerDa()
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
    await sprachWaehlerDa()
    await spracheWaehlen('Englisch')
    fireEvent.click(screen.getByRole('button', { name: 'Speichern & neu transkribieren' }))
    await waitFor(() => expect(saveSpy).toHaveBeenCalledWith('p', 'a', expect.objectContaining({ sprache: 'en' })))
    expect(onGespeichert).toHaveBeenCalledWith({ neuTranskribieren: true, neuKorrigieren: false })
    expect(onOpenChange).toHaveBeenCalledWith(false)
    saveSpy.mockRestore()
  })

  it('„folgt dem Projekt" schickt bei der Sprache NULL — der Rückweg aus #234', async () => {
    // Der Kern des Issues: vor diesem Fix gab es den Weg zurück gar nicht. Eine Datei mit einem
    // Sprach-Eintrag zog bei einer späteren Änderung des Projekt-Standards nie wieder mit, und
    // der Eintrag entstand beim Upload auch dann, wenn niemand die Auswahl angefasst hatte.
    //
    // `null` MUSS im JSON landen (`undefined` würde JSON.stringify wegwerfen und hiesse „nicht
    // anfassen"); serverseitig entscheidet `model_fields_set`, also die Anwesenheit des
    // Schlüssels. Deshalb `sprache: null` wörtlich prüfen, nicht bloss „irgendwas gesendet".
    const saveSpy = vi.spyOn(api, 'saveFileEinstellungen')
      .mockResolvedValue({ sprache: 'ch', korrektur: 'auto', mehrsprachig: false })
    vi.spyOn(api, 'getFileEinstellungen')
      .mockResolvedValue({ ...BASIS, sprache: 'en', sprache_eigen: 'en' })
    render(<DateiEinstellungenDialog project="p" base="a" file={datei()} offen />)
    await sprachWaehlerDa()
    await spracheWaehlen('Folgt dem Projekt (Schweizerdeutsch)')
    // en -> geerbtes ch ist ein echter Sprachwechsel: das vorhandene Transkript ist hin.
    fireEvent.click(screen.getByRole('button', { name: 'Speichern & neu transkribieren' }))
    await waitFor(() => expect(saveSpy).toHaveBeenCalledWith('p', 'a',
      expect.objectContaining({ sprache: null })))
    saveSpy.mockRestore()
  })

  it('ein Sprach-Wechsel OHNE Wirkung wird gespeichert, loest aber keine Neu-Transkription aus', async () => {
    // Von „Schweizerdeutsch" (eigen) auf „folgt dem Projekt (Schweizerdeutsch)": der Override
    // verschwindet, die Sprache bleibt dieselbe. Eine Neu-Transkription wäre hier ein
    // kompletter Whisper-Lauf für nichts — gespeichert werden muss es trotzdem, sonst fände
    // der Nutzer den Rückweg vor und der Knopf bliebe grau. (Dieselbe Unterscheidung wie beim
    // Haken in #166, hier nur teurer.)
    const saveSpy = vi.spyOn(api, 'saveFileEinstellungen')
      .mockResolvedValue({ sprache: 'ch', korrektur: 'auto', mehrsprachig: false })
    const onGespeichert = vi.fn()
    vi.spyOn(api, 'getFileEinstellungen').mockResolvedValue({ ...BASIS, sprache_eigen: 'ch' })
    render(<DateiEinstellungenDialog project="p" base="a" file={datei()} offen
      onGespeichert={onGespeichert} />)
    await sprachWaehlerDa()
    await spracheWaehlen('Folgt dem Projekt (Schweizerdeutsch)')
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
    await waitFor(() => expect(saveSpy).toHaveBeenCalledWith('p', 'a',
      expect.objectContaining({ sprache: null })))
    expect(onGespeichert).toHaveBeenCalledWith({ neuTranskribieren: false, neuKorrigieren: false })
    saveSpy.mockRestore()
  })

  it('zeigt bei !has_raw den Hinweis zur nächsten Transkription und keinen Trigger-Knopf', async () => {
    vi.spyOn(api, 'getFileEinstellungen').mockResolvedValue(BASIS)
    render(<DateiEinstellungenDialog project="p" base="a" file={datei({ has_raw: false })} offen />)
    await sprachWaehlerDa()
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
    await sprachWaehlerDa()          // erster Aufruf geladen

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
    // Dieselbe Begruendung wie bei `spracheWaehlen`: beide Waehler tragen inzwischen dieselbe
    // Beschriftung, unterschieden werden sie ueber die geoeffnete Liste.
    fireEvent.click(await within(await screen.findByRole('listbox')).findByText(label))
  }
  const speichern = (r: Partial<{ mehrsprachig: boolean }> = {}) =>
    vi.spyOn(api, 'saveFileEinstellungen')
      .mockResolvedValue({ sprache: 'ch', korrektur: 'auto', mehrsprachig: true, ...r })

  it('schickt einen gesetzten Haken mit', async () => {
    vi.spyOn(api, 'getFileEinstellungen').mockResolvedValue(BASIS)
    const saveSpy = speichern()
    render(<DateiEinstellungenDialog project="p" base="a" file={datei()} offen />)
    await sprachWaehlerDa()
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
    await sprachWaehlerDa()
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
    await sprachWaehlerDa()
    await waehle(/^Ja —/)
    fireEvent.click(screen.getByRole('button', { name: 'Speichern & neu transkribieren' }))
    await waitFor(() => expect(onGespeichert).toHaveBeenCalledWith(
      { neuTranskribieren: true, neuKorrigieren: false }))
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
    await sprachWaehlerDa()
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
    await sprachWaehlerDa()
    expect(await screen.findByText(/^Ja —/)).toBeInTheDocument()   // Serverwert kommt an
    expect(screen.getByRole('button', { name: /speichern/i })).toBeDisabled()
  })
})

describe('DateiEinstellungenDialog — Sprecherzahl (#264)', () => {
  const feld = () => screen.getByLabelText('Anzahl Sprecher')
  const knopf = () => screen.getByRole('button', { name: /Speichern/ })

  it('schickt die eingetragene Zahl und meldet sie als Neu-Korrektur', async () => {
    // Der Weg, für den das Feld existiert: pyannote fand an Marcus' Kameramikrofon-Aufnahme
    // 2 statt 4 Sprecher. Die Zahl muss beim Server ankommen UND den correct-Lauf auslösen —
    // die Diarisierung ist dessen Prep-Schritt. Ein `transcribe` wäre hier falsch und teuer.
    vi.spyOn(api, 'getFileEinstellungen').mockResolvedValue(BASIS)
    const save = vi.spyOn(api, 'saveFileEinstellungen').mockResolvedValue(
      { sprache: 'ch', korrektur: 'auto', mehrsprachig: false })
    const onGespeichert = vi.fn()
    render(<DateiEinstellungenDialog project="p" base="a" file={datei()} offen
                                     onGespeichert={onGespeichert} />)
    await sprachWaehlerDa()
    fireEvent.change(feld(), { target: { value: '4' } })
    fireEvent.click(knopf())
    await waitFor(() => expect(save).toHaveBeenCalledWith('p', 'a',
      expect.objectContaining({ sprecher: 4 })))
    expect(onGespeichert).toHaveBeenCalledWith({ neuTranskribieren: false, neuKorrigieren: true })
    save.mockRestore()
  })

  it('leeren heisst „automatisch" und schickt null', async () => {
    // Ohne Rückweg bliebe eine einmal getippte Zahl für immer stehen. `null` ist der Befehl
    // „Override entfernen" (dieselbe Mechanik wie bei sprache/mehrsprachig) — `undefined`
    // würde von JSON.stringify weggeworfen und hiesse „nicht anfassen".
    vi.spyOn(api, 'getFileEinstellungen').mockResolvedValue({ ...BASIS, sprecher: 5 })
    const save = vi.spyOn(api, 'saveFileEinstellungen').mockResolvedValue(
      { sprache: 'ch', korrektur: 'auto', mehrsprachig: false })
    render(<DateiEinstellungenDialog project="p" base="a" file={datei()} offen />)
    await waitFor(() => expect(feld()).toHaveValue('5'))
    fireEvent.change(feld(), { target: { value: '' } })
    fireEvent.click(knopf())
    await waitFor(() => expect(save).toHaveBeenCalledWith('p', 'a',
      expect.objectContaining({ sprecher: null })))
    save.mockRestore()
  })

  it('eine ungültige Zahl sperrt den Knopf GANZ — auch bei einer anderen Änderung', async () => {
    /* Der Datenverlust-Pfad: bei ungültiger Eingabe ist `sprecherWahl` undefined, und das
       `?? null` im Speicher-Rumpf schriebe daraus eine LÖSCHUNG. Wäre nur der eigene Zweig
       gesperrt, liesse sich über eine Tiefe-Änderung trotzdem speichern — und die vorhandene
       Zahl wäre still weg, während der Nutzer sie gerade korrigieren wollte. */
    vi.spyOn(api, 'getFileEinstellungen').mockResolvedValue({ ...BASIS, sprecher: 5 })
    const save = vi.spyOn(api, 'saveFileEinstellungen').mockResolvedValue(
      { sprache: 'ch', korrektur: 'auto', mehrsprachig: false })
    render(<DateiEinstellungenDialog project="p" base="a" file={datei()} offen />)
    await waitFor(() => expect(feld()).toHaveValue('5'))
    fireEvent.change(feld(), { target: { value: '99' } })          // über sprecher_max
    expect(knopf()).toBeDisabled()
    expect(feld()).toHaveAttribute('aria-invalid', 'true')
    // ... und auch eine gleichzeitige, für sich gültige Änderung hebt die Sperre nicht auf
    await spracheWaehlen('Englisch')
    expect(knopf()).toBeDisabled()
    fireEvent.change(feld(), { target: { value: '6' } })           // korrigiert -> wieder frei
    expect(knopf()).toBeEnabled()
    expect(save).not.toHaveBeenCalled()
    save.mockRestore()
  })

  it('eine unveränderte Zahl loest keinen Lauf aus', async () => {
    // Sonst liefe nach jedem Öffnen-und-Speichern eine Neu-Korrektur mit `force` quer über
    // eine handbearbeitete Fassung — für eine Einstellung, die niemand angefasst hat.
    vi.spyOn(api, 'getFileEinstellungen').mockResolvedValue({ ...BASIS, sprecher: 3 })
    render(<DateiEinstellungenDialog project="p" base="a" file={datei()} offen />)
    await waitFor(() => expect(feld()).toHaveValue('3'))
    expect(knopf()).toBeDisabled()
  })
})

describe('DateiEinstellungenDialog — Sprecherzahl, ungültige Zwischeneingabe (CodeRabbit)', () => {
  it('eine Fehleingabe löscht die gesetzte Zahl NICHT', async () => {
    /* Der Grund für `type="text"`. Bei `type="number"` liefert der Browser für „5e" einen
       LEEREN value (`validity.badInput`) und zeigt dem Nutzer trotzdem „5e" an — im Browser
       gemessen: `{value: "", badInput: true}`. Dieser Dialog liest leer als „automatisch":
       der Knopf wäre scharf geworden und hätte die vorhandene 5 STILL gelöscht, beim blossen
       Vertippen, mit „Speichern & neu korrigieren" auf dem Knopf.

       jsdom bildet `badInput` NICHT nach (es reicht jeden String durch), der Test kann den
       Zahlenfeld-Fall also gar nicht herstellen — er prüft stattdessen die Eigenschaft, die
       den Fix trägt: ein nicht-numerischer Text kommt im Zustand AN und gilt als ungültig.
       Genau das ist bei `type="number"` unmöglich, und deshalb ist der Feldtyp Teil der
       Zusicherung. */
    vi.spyOn(api, 'getFileEinstellungen').mockResolvedValue({ ...BASIS, sprecher: 5 })
    const save = vi.spyOn(api, 'saveFileEinstellungen').mockResolvedValue(
      { sprache: 'ch', korrektur: 'auto', mehrsprachig: false })
    render(<DateiEinstellungenDialog project="p" base="a" file={datei()} offen />)
    const feld = () => screen.getByLabelText('Anzahl Sprecher')
    await waitFor(() => expect(feld()).toHaveValue('5'))
    expect(feld()).toHaveAttribute('type', 'text')     // der Fix selbst
    for (const kaputt of ['5e', '-', '1.5', '1e3']) {
      fireEvent.change(feld(), { target: { value: kaputt } })
      expect(feld(), `${kaputt}: der Text muss stehen bleiben`).toHaveValue(kaputt)
      expect(screen.getByRole('button', { name: /Speichern/ }),
             `${kaputt}: haette sperren muessen`).toBeDisabled()
    }
    expect(save).not.toHaveBeenCalled()
    save.mockRestore()
  })
})
