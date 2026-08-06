import { describe, it, expect } from 'vitest'
import { parseJobPhases } from './jobPhases'

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
    expect(p.active).toEqual({ base: 'B', phase: 'verify' })
    expect(p.perBase).toEqual({ A: 'done' })
    expect(p.global).toBeNull()
  })
  it('Vorstufe: global=glossary, kein active', () => {
    const p = parseJobPhases('correct', ['→ Glossar (…) …'])
    expect(p.active).toBeNull()
    expect(p.global).toBe('glossary')
  })
  it('diarize-SKIP ist kein Fehler', () => {
    const p = parseJobPhases('correct', ['diarize: SKIP A (kein Audio gefunden)', '→ Korrigiere A …'])
    expect(p.perBase.A).toBeUndefined()
    expect(p.active).toEqual({ base: 'A', phase: 'correct' })
  })
  it('SKIP human_edited + FEHLT -> terminal', () => {
    const p = parseJobPhases('correct', [
      '↷ SKIP A (human_edited=true; --force zum Neu-Korrigieren)',
      '✗ FEHLT/ungültig: B.correction.json — überspringe',
    ])
    expect(p.perBase).toEqual({ A: 'skipped', B: 'failed' })
    expect(p.active).toBeNull()
  })
  it('reuse -> apply -> done', () => {
    const p = parseJobPhases('correct', [
      '↷ nutze vorhandene A.correction.json', 'apply: A -> edit.json + md (3 Segmente)',
    ])
    expect(p.perBase).toEqual({ A: 'done' })
  })
  it('Blockzaehler -> Prozent + Detail, Verify-Pass ist die halbe Blockbreite', () => {
    const p = parseJobPhases('correct', [
      '540 Segmente → 4 Blöcke à max. 150',
      'Block 1/4 (IDs 0–149)', '→ Korrigiere A …', '→ Verifiziere A (Treue gegen Roh) …',
      'Block 2/4 (IDs 150–299)', '→ Korrigiere A …',
    ])
    expect(p.active).toEqual({ base: 'A', phase: 'correct', pct: 25, detail: 'Block 2/4' })
  })
  it('halber Block waehrend der Verifikation', () => {
    const p = parseJobPhases('correct', [
      'Block 1/4 (IDs 0–149)', '→ Korrigiere A …', '→ Verifiziere A (Treue gegen Roh) …',
    ])
    expect(p.active).toEqual({ base: 'A', phase: 'verify', pct: 13, detail: 'Block 1/4' })
  })
  it('Blockzaehler endet mit der Datei — die naechste faengt ohne an', () => {
    const p = parseJobPhases('correct', [
      'Block 1/4 (IDs 0–149)', '→ Korrigiere A …',
      'apply: A -> edit.json + md (540 Segmente)',
      '→ Korrigiere B …',
    ])
    expect(p.active).toEqual({ base: 'B', phase: 'correct' })
  })
  it('ungechunkte Datei bleibt ohne Prozent', () => {
    const p = parseJobPhases('correct', ['→ Korrigiere A …'])
    expect(p.active).toEqual({ base: 'A', phase: 'correct' })
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
    expect(p.active).toEqual({ base: 'C', phase: 'transcribe' })
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
    expect(p.active).toEqual({ base: 'A', phase: 'transcribe', pct: 45 })
  })
  it('tqdm-Rest nach der fertig-Zeile faellt nicht auf eine tote Datei zurueck', () => {
    const p = parseJobPhases('transcribe', [
      '[Demo] -> transkribiere A …', ' 99%|#########9| 99000/100000 [00:44<00:00, 2250.00frames/s]',
      '[Demo] fertig A: 45s, 40 Segmente, Audio 2:00, 2.6x',
      '100%|##########| 100000/100000 [00:45<00:00, 2222.00frames/s]',
    ])
    expect(p.active).toBeNull()
    expect(p.perBase).toEqual({ A: 'done' })
  })
})

describe('URL-Import', () => {
  it('meldet Herunterladen und danach die Transkription', () => {
    const p = parseJobPhases('transcribe', [
      '[fetch] lade Mein Interview …',
    ])
    expect(p.global).toBe('download')
    expect(p.active).toBeNull()
  })

  it('beendet die Download-Phase nach der Bilanzzeile', () => {
    const p = parseJobPhases('transcribe', [
      '[fetch] lade Mein Interview …',
      '[fetch] fertig Mein Interview',
      '[fetch] 1 von 1 geladen',
      '[Demo] -> transkribiere Mein Interview …',
    ])
    expect(p.global).toBeNull()
    expect(p.active).toEqual({ base: 'Mein Interview', phase: 'transcribe' })
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
