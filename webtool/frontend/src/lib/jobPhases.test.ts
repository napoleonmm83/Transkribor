import { describe, it, expect } from 'vitest'
import { describePhases, parseJobPhases } from './jobPhases'

describe('parseJobPhases — correct', () => {
  it('aktive Datei + Phase, sequentiell', () => {
    const p = parseJobPhases('correct', [
      "run: 3 Datei(en) in Projekt 'Demo'",
      '→ Diarisiere A …', '→ Diarisiere B …', 'diarize: 2 Datei(en) diarisiert',
      'prep: 3 Datei(en) getaggt in /x',
      '→ Glossar (gemeinsame Namen/Begriffe) …', '✓ Glossar: 4 Eigennamen, 2 Korrekturen',
      '→ Korrigiere A …', 'apply: A -> edit.json + md (12 Segmente)',
      '→ Korrigiere B …', '→ Verifiziere B (Treue gegen Roh) …',
    ])
    expect(p.active).toEqual({ B: { phase: 'verify' } })
    expect(p.perBase).toEqual({ A: 'done' })
    expect(p.global).toBeNull()
  })
  it('mehrere Dateien gleichzeitig — verschraenkte Zeilen bleiben getrennt', () => {
    const p = parseJobPhases('correct', [
      '→ Korrigiere A …', '→ Korrigiere B …', '→ Korrigiere C …',
      '→ Verifiziere A (Treue gegen Roh) …',
      'apply: B -> edit.json + md (12 Segmente)',
    ])
    expect(p.active).toEqual({ A: { phase: 'verify' }, C: { phase: 'correct' } })
    expect(p.perBase).toEqual({ B: 'done' })
  })
  it('Vorstufe: global=glossary, kein active', () => {
    const p = parseJobPhases('correct', ['→ Glossar (…) …'])
    expect(p.active).toEqual({})
    expect(p.global).toBe('glossary')
  })
  it('diarize-SKIP ist kein Fehler', () => {
    const p = parseJobPhases('correct', ['diarize: SKIP A (kein Audio gefunden)', '→ Korrigiere A …'])
    expect(p.perBase.A).toBeUndefined()
    expect(p.active).toEqual({ A: { phase: 'correct' } })
  })
  it('SKIP human_edited + FEHLT -> terminal', () => {
    const p = parseJobPhases('correct', [
      '↷ SKIP A (human_edited=true; --force zum Neu-Korrigieren)',
      '✗ FEHLT/ungültig: B.correction.json — überspringe',
    ])
    expect(p.perBase).toEqual({ A: 'skipped', B: 'failed' })
    expect(p.active).toEqual({})
  })
  it('reuse -> apply -> done', () => {
    const p = parseJobPhases('correct', [
      '↷ nutze vorhandene A.correction.json', 'apply: A -> edit.json + md (3 Segmente)',
    ])
    expect(p.perBase).toEqual({ A: 'done' })
  })
  it('Fortschritt einer gestueckelten Datei = fertige Bloecke', () => {
    const p = parseJobPhases('correct', [
      'A: 540 Segmente → 4 Blöcke à max. 150',
      '→ Korrigiere A · Block 1/4 …', '→ Verifiziere A · Block 1/4 (Treue gegen Roh) …',
      '✓ A · Block 1/4 fertig',
      '→ Korrigiere A · Block 2/4 …', '→ Korrigiere A · Block 3/4 …',
    ])
    expect(p.active).toEqual({ A: { phase: 'correct', pct: 25, detail: '1/4 Blöcke' } })
  })
  it('uebersprungene und gescheiterte Bloecke zaehlen auch als erledigt', () => {
    const p = parseJobPhases('correct', [
      'A: 300 Segmente → 2 Blöcke à max. 150',
      '↷ A · Block 1/2 schon vorhanden', '✗ A · Block 2/2 ohne gültiges Ergebnis',
      '→ Korrigiere A · Block 2/2 …',
    ])
    expect(p.active.A.pct).toBe(100)
  })
  it('Blockzaehler endet mit der Datei — die naechste faengt ohne an', () => {
    const p = parseJobPhases('correct', [
      'A: 540 Segmente → 4 Blöcke à max. 150', '→ Korrigiere A · Block 1/4 …',
      'apply: A -> edit.json + md (540 Segmente)',
      '→ Korrigiere B …',
    ])
    expect(p.active).toEqual({ B: { phase: 'correct' } })
  })
  it('ungechunkte Datei bleibt ohne Prozent', () => {
    const p = parseJobPhases('correct', ['→ Korrigiere A …'])
    expect(p.active).toEqual({ A: { phase: 'correct' } })
  })
  it('Basisname mit Blockzusatz wird nicht abgeschnitten', () => {
    const p = parseJobPhases('correct', ['→ Korrigiere Timeline 1 · Block 2/3 …'])
    expect(Object.keys(p.active)).toEqual(['Timeline 1'])
  })
  it('Basisname mit Klammern -> SKIP greedy bis (human_edited=', () => {
    const p = parseJobPhases('correct', [
      '↷ SKIP Interview (Teil 1) (human_edited=true; --force zum Neu-Korrigieren)',
      'apply: SKIP Zweites (Teil 2) (human_edited=true; --force zum Ueberschreiben)',
    ])
    expect(p.perBase).toEqual({ 'Interview (Teil 1)': 'skipped', 'Zweites (Teil 2)': 'skipped' })
  })
})

describe('parseJobPhases — transcribe', () => {
  it('aktive + fertige + skip', () => {
    const p = parseJobPhases('transcribe', [
      '[Demo] Modell large-v3, 3 Datei(en)',
      '[Demo] -> transkribiere A …', '[Demo] fertig A: 12s, 40 Segmente, Audio 2:00, 10.0x',
      '[Demo] skip (vorhanden): B', '[Demo] -> transkribiere C …',
    ])
    expect(p.active).toEqual({ C: { phase: 'transcribe' } })
    expect(p.perBase).toEqual({ A: 'done', B: 'skipped' })
  })
  it('FEHLER -> failed', () => {
    expect(parseJobPhases('transcribe', ['[Demo] FEHLER A: broken pipe']).perBase).toEqual({ A: 'failed' })
  })
  it('tqdm-Balken von Whisper -> Prozent der aktiven Datei', () => {
    // Zeilen 1:1 aus einem echten Lauf: Whisper haengt UserWarnings OHNE Zeilenumbruch
    // an die tqdm-Zeile an — der Prozentwert steht trotzdem vorn.
    const p = parseJobPhases('transcribe', [
      '[Demo] -> transkribiere A …',
      '  0%|          | 0/1906 [00:00<?, ?frames/s]E:\\…\\whisper\\timing.py:42: UserWarning: Failed to launch Triton kernels…',
      ' 45%|████▌     | 858/1906 [00:02<00:02, 500.00frames/s]',
    ])
    expect(p.active).toEqual({ A: { phase: 'transcribe', pct: 45 } })
  })
  it('tqdm-Rest nach der fertig-Zeile faellt nicht auf eine tote Datei zurueck', () => {
    const p = parseJobPhases('transcribe', [
      '[Demo] -> transkribiere A …', ' 99%|#########9| 99000/100000 [00:44<00:00, 2250.00frames/s]',
      '[Demo] fertig A: 45s, 40 Segmente, Audio 2:00, 2.6x',
      '100%|##########| 100000/100000 [00:45<00:00, 2222.00frames/s]',
    ])
    expect(p.active).toEqual({})
    expect(p.perBase).toEqual({ A: 'done' })
  })
})

describe('describePhases', () => {
  const von = (kind: string, lines: string[]) => describePhases(parseJobPhases(kind, lines))

  it('nennt Phase und Datei statt roher Log-Zeilen', () => {
    expect(von('correct', ['→ Verifiziere Timeline 1 (Treue gegen Roh) …'])).toBe('Verifizieren Timeline 1…')
  })
  it('haengt Blockfortschritt bzw. Prozent an', () => {
    expect(von('correct', ['A: 600 Segmente → 4 Blöcke à max. 150', '✓ A · Block 1/4 fertig',
      '→ Korrigiere A · Block 2/4 …'])).toBe('Korrigieren A · 1/4 Blöcke')
    expect(von('transcribe', ['[D] -> transkribiere A …', ' 45%|##| 45/100'])).toBe('Transkribieren A · 45%')
  })
  it('zaehlt bei parallelen Dateien alle laufenden auf', () => {
    expect(von('correct', ['→ Korrigiere A …', '→ Verifiziere B (Treue gegen Roh) …']))
      .toBe('Korrigieren A…  |  Verifizieren B…')
  })
  it('faellt auf die Vorstufe zurueck, wenn keine Datei aktiv ist', () => {
    expect(von('correct', ['prep: 4 Datei(en) getaggt in E:\\x'])).toBe('Vorbereiten…')
  })
  it('leer, solange nichts erkennbar laeuft — pyannote-Warnungen erzeugen keinen Text', () => {
    expect(von('correct', ['  warnings.warn(', 'UserWarning: std(): degrees of freedom is <= 0'])).toBe('')
  })
})

describe('URL-Import', () => {
  it('meldet Herunterladen und danach die Transkription', () => {
    const p = parseJobPhases('transcribe', [
      '[fetch] lade Mein Interview …',
    ])
    expect(p.global).toBe('download')
    expect(p.active).toEqual({})
  })

  it('beendet die Download-Phase nach der Bilanzzeile', () => {
    const p = parseJobPhases('transcribe', [
      '[fetch] lade Mein Interview …',
      '[fetch] fertig Mein Interview',
      '[fetch] 1 von 1 geladen',
      '[Demo] -> transkribiere Mein Interview …',
    ])
    expect(p.global).toBeNull()
    expect(p.active).toEqual({ 'Mein Interview': { phase: 'transcribe' } })
  })

  it('haelt eine fetch-FEHLER-Zeile aus der perBase-Auswertung heraus', () => {
    // '[fetch] FEHLER <url>: …' darf NICHT als Datei-Fehlschlag gelesen werden
    const p = parseJobPhases('transcribe', [
      '[fetch] FEHLER https://youtu.be/x: Video ist nicht öffentlich abrufbar (Login nötig)',
      '[fetch] 0 von 1 geladen',
    ])
    expect(p.perBase).toEqual({})
  })
})
