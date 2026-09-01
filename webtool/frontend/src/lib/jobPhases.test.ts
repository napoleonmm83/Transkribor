import { describe, it, expect } from 'vitest'
import { describePhases, parseJobPhases , imBereich, zugelassen, laufOrdnung, warteKarte } from './jobPhases'
// Der Ausgang gehoert zum Befund: ein richtig geparster Zustand nuetzt nichts, wenn die
// Meldung daraus weiterhin „fertig" sagt (#405 + #376).
import { ausgang } from './jobAusgang'

describe('parseJobPhases — correct', () => {
  it('aktive Datei + Phase, sequentiell', () => {
    const p = parseJobPhases('correct', [
      "run: 3 Datei(en) in Projekt 'Demo'",
      '→ Diarisiere A …', '→ Diarisiere B …',
      // MIT Dauer-Anhang — genau so druckt correct.py die Zeile seit der Phasenmessung.
      // Vorher stand hier die Form ohne Anhang, und der Test wäre gegen einen $-Anker
      // im Regex blind geblieben, während die Produktion längst anders druckt.
      'diarize: 2 Datei(en) diarisiert in 45s',
      'prep: 3 Datei(en) getaggt in /x',
      '→ Glossar (gemeinsame Namen/Begriffe) …', '✓ Glossar: 4 Eigennamen, 2 Korrekturen',
      '→ Korrigiere A …', 'apply: A -> edit.json + md (12 Segmente)',
      '→ Korrigiere B …', '→ Verifiziere B (Treue gegen Roh) …',
    ])
    expect(p.active).toEqual({ B: { phase: 'verify' } })
    expect(p.perBase).toEqual({ A: 'done' })
    expect(p.global).toBeNull()
  })
  it('der Dauer-Anhang beendet die Diarisierungs-Phase weiterhin', () => {
    // Der Wächter für den stdout-Vertrag: `correct.py` haengt seit der Phasenmessung
    // ` in 45s` an diese Zeile an, und `/^diarize: \d+ Datei/` darf deshalb keinen
    // $-Anker bekommen. Sonst bliebe die Anzeige waehrend `cmd_prep` auf „Diarisiere A"
    // stehen, obwohl die Diarisierung fertig ist.
    //
    // Der Schnitt endet ABSICHTLICH vor dem ersten `→ Korrigiere`: das setzt `active[A]`
    // neu und macht die Wirkung dieser Zeile unsichtbar. Genau daran war der erste Versuch
    // dieses Tests vacuous — die Mutation (mit $-Anker) blieb gruen, gemessen.
    const p = parseJobPhases('correct', [
      '→ Diarisiere A …', '⏱ A: Diarisierung 45s',
      'diarize: 1 Datei(en) diarisiert in 45s',
    ])
    expect(p.active).toEqual({})
    expect(p.global).toBeNull()
  })

  it('die ⏱-Messzeilen aendern nichts am geparsten Zustand', () => {
    // Die Phasenmessung druckt drei neue Zeilenarten. Keine davon darf ein Datei-Ereignis
    // ausloesen: `⏱ A: …` sieht `→ Diarisiere A …` aehnlich genug, dass ein spaeter
    // gelockerter Regex sie fangen koennte, und `⏱ A · Block 1/2: …` steht dem
    // Block-Fortschritt `[✓✗↷] A · Block n/m …` sehr nahe — faenge er sie, zaehlte der
    // Balken den Block DOPPELT und schoesse ueber 100 %.
    //
    // Verglichen wird gegen den Lauf OHNE die Messzeilen, nicht gegen ein hingeschriebenes
    // Ergebnis: so bleibt der Test gueltig, wenn sich am Parser sonst etwas aendert, und er
    // misst genau die eine Eigenschaft, um die es geht — dass die Zeilen folgenlos sind.
    const ohne = [
      '→ Diarisiere A …', 'diarize: 1 Datei(en) diarisiert in 45s',
      'A: 300 Segmente → 2 Blöcke',
      '→ Korrigiere A · Block 1/2 …', '✓ A · Block 1/2 fertig',
    ]
    const mit = [
      '→ Diarisiere A …', '⏱ A: Diarisierung 45s', 'diarize: 1 Datei(en) diarisiert in 45s',
      'A: 300 Segmente → 2 Blöcke',
      '→ Korrigiere A · Block 1/2 …', '⏱ A · Block 1/2: Korrektur 82s, Verify 61s',
      '✓ A · Block 1/2 fertig',
      '⏱ Phasen: diarisieren 45s · vorbereiten 1s · glossar 30s · korrigieren 620s · '
        + 'gesamt 696s (parallel=3)',
    ]
    expect(parseJobPhases('correct', mit)).toEqual(parseJobPhases('correct', ohne))
    // Positivkontrolle: der Vergleich oben waere auch dann gruen, wenn BEIDE Laeufe nichts
    // ergaeben. `1/2`, weil `blockDone` den laufenden Eintrag seit #347 nachrechnet — bis
    // dahin stand hier `0/2` mit der Begruendung, `prog()` werde nur beim BETRETEN der Phase
    // ausgewertet. Genau das war der Fehler: beim letzten Block folgt kein `→ Korrigiere`
    // mehr, sondern `apply:`, der Balken blieb also bis zum Schluss eine Stufe zu niedrig.
    expect(parseJobPhases('correct', mit).active).toEqual({ A: { phase: 'correct', pct: 50, detail: '1/2 Blöcke' } })
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
  it('der letzte Block zieht den Balken SOFORT nach, ohne folgende Korrigiere-Zeile (#347)', () => {
    // Die unterscheidende Zusicherung fuer #347, und der Grund, warum sie eigens dasteht:
    // JEDER andere Blocktest dieser Datei endet auf einer weiteren `→ Korrigiere`-Zeile, die
    // `prog()` ohnehin neu auswertet — sie waeren also auch ohne den Fix gruen (gemessen: von
    // 194 Tests in src/lib fiel genau EINER, die Positivkontrolle oben). Beim LETZTEN Block
    // gibt es diese Zeile nicht: danach kommt `apply:`. Genau dort war der Balken sichtbar zu
    // niedrig, und genau das misst dieser Fall.
    // Die Zeilenfolge ist die ECHTE: `_correct_file` druckt je Block Korrigieren, Verifizieren
    // und danach sein ✓ (correct.py). Die erste Fassung dieses Tests stellte `→ Korrigiere 2/2`
    // VOR `✓ 1/2` — scharf, aber eine Folge, die kein Drucker erzeugt (gegnerischer Pruefer).
    const p = parseJobPhases('correct', [
      'A: 300 Segmente → 2 Blöcke à max. 150',
      '→ Korrigiere A · Block 1/2 …', '→ Verifiziere A · Block 1/2 (Treue gegen Roh) …',
      '✓ A · Block 1/2 fertig',
      '→ Korrigiere A · Block 2/2 …', '→ Verifiziere A · Block 2/2 (Treue gegen Roh) …',
      '✓ A · Block 2/2 fertig',
    ])
    // Ohne den Nachzug staende hier 1/2: die letzte Phasenzeile ist `→ Verifiziere 2/2`, und
    // die wurde ausgewertet, als erst ein Block fertig war.
    expect(p.active.A).toEqual({ phase: 'verify', pct: 100, detail: '2/2 Blöcke' })
  })
  it('ein RESUME-Lauf legt keinen Eintrag ohne Phase an (#347)', () => {
    // Der Riegel `if (active[base])` in `blockDone`, gemessen am ECHTEN Strom statt an einer
    // gebauten Sequenz: `correct.py:1062` druckt im Wiederaufnahme-Zweig `↷ … schon vorhanden`
    // und danach `✓ … fertig`, ruft aber `_correct_one` NICHT — es gibt also KEINE
    // `→ Korrigiere`-Zeile, die `active` anlegt. Ohne den Riegel entstuende hier ein Eintrag
    // aus `pct`/`detail` OHNE `phase`: die Pille beschriftete ihn mit `PHASE_LABEL[undefined]`,
    // und `global` faellt auf null, weil `parseJobPhases` am Ende `Object.keys(active).length`
    // fragt — die Vorbereiten-Phase verschwaende also mit.
    //
    // Die erste Fassung dieses Tests haengte eine Blockzeile hinter `apply:`. Das ist
    // AEQUIVALENT gedacht und im Strom unerreichbar: `cmd_run` sammelt alle Bloecke, bevor
    // `cmd_apply` laeuft (correct.py:1343). Ein Waechter auf einer Sequenz, die kein Drucker
    // erzeugt, deckt den Fall nicht, den er decken soll — gefunden vom kalten Plan-Reviewer.
    const p = parseJobPhases('correct', [
      'prep: 1 Datei(en) vorbereitet',
      'A: 300 Segmente → 2 Blöcke à max. 150',
      '  ↷ A · Block 1/2 schon vorhanden', '  ✓ A · Block 1/2 fertig',
      '  ↷ A · Block 2/2 schon vorhanden', '  ✓ A · Block 2/2 fertig',
    ])
    expect(p.active).toEqual({})
    expect(p.global).toBe('prep')
  })
  it('uebersprungene und gescheiterte Bloecke zaehlen auch als erledigt', () => {
    const p = parseJobPhases('correct', [
      'A: 300 Segmente → 2 Blöcke à max. 150',
      '→ Korrigiere A · Block 1/2 …', '✗ A · Block 1/2 ohne gültiges Ergebnis',
      '→ Korrigiere A · Block 2/2 …',
    ])
    expect(p.active.A).toEqual({ phase: 'correct', pct: 50, detail: '1/2 Blöcke' })
  })
  it('ein wiederverwendeter Block zaehlt EINMAL, nicht zweimal', () => {
    // correct.py meldet beim Reuse '↷ schon vorhanden' UND faellt danach in dieselbe
    // Pruefung, die '✓ fertig' druckt — ein blosser Zaehler schoesse ueber 100%.
    const p = parseJobPhases('correct', [
      'A: 300 Segmente → 2 Blöcke à max. 150',
      '↷ A · Block 1/2 schon vorhanden', '✓ A · Block 1/2 fertig',
      '→ Korrigiere A · Block 2/2 …',
    ])
    expect(p.active.A).toEqual({ phase: 'correct', pct: 50, detail: '1/2 Blöcke' })
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
  it('aktive + fertige + aufgegebene Aufnahme', () => {
    // Traeger war `skip (vorhanden)`, bis #408 den Zweig als tot entlarvte: seit 10098e4
    // druckt transcribe.py die Form nicht mehr (die schon fertigen Dateien filtert `offen`
    // heraus, sie erreichen die Schleife gar nicht). Die geprueften Eigenschaften — Cursor
    // wandert weiter, Terminalzustaende sammeln sich — sind dieselben, nur ueber die Form,
    // die es wirklich gibt. Sie zaehlt 'failed', nicht 'skipped' (transcribe.py legt die
    // Datei in `failed_bases`).
    const p = parseJobPhases('transcribe', [
      '[Demo] Modell large-v3, 3 Datei(en)',
      '[Demo] -> transkribiere A …', '[Demo] fertig A: 12s, 40 Segmente, Audio 2:00, 10.0x',
      '[Demo] skip (Audio nicht mehr vorhanden): B', '[Demo] -> transkribiere C …',
    ])
    expect(p.active).toEqual({ C: { phase: 'transcribe' } })
    expect(p.perBase).toEqual({ A: 'done', B: 'failed' })
  })
  it('ignoriert Terminalzeilen fuer Dateien ausserhalb des Scopes', () => {
    const p = parseJobPhases('transcribe', [
      '[scope] B',
      '[Demo] skip (Audio nicht mehr vorhanden): A',
      '[Demo] -> transkribiere B …',
      '[Demo] skip (Audio nicht mehr vorhanden): C',
    ])
    expect(p.scope).toEqual(new Set(['B']))
    expect(p.active).toEqual({ B: { phase: 'transcribe' } })
    // A und C duerfen NICHT in perBase auftauchen
    expect(p.perBase).toEqual({})
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
  it('liest die Zeilen des reinen Download-Jobs (kind fetch)', () => {
    // app.py fuehrt den URL-Import als eigene Art 'fetch' -> derselbe Zeilen-Dialekt wie transcribe
    const p = parseJobPhases('fetch', ['[fetch] lade Mein Interview …'])
    expect(p.global).toBe('download')
    expect(p.active).toEqual({})
  })
  it('Projekt mit Name "fetch" wird bei transcribe nicht als Download-Phase fehlinterpretiert (#379)', () => {
    const p = parseJobPhases('transcribe', [
      '[fetch] -> transkribiere audio_01 …',
      '45%|',
    ])
    expect(p.global).toBeNull()
    expect(p.active).toEqual({ audio_01: { phase: 'transcribe', pct: 45 } })
  })
  it('Projekt mit Name "fetch" markiert transkribiere-FEHLER, fertig und skip korrekt (#379)', () => {
    const p = parseJobPhases('transcribe', [
      '[fetch] fertig audio_01: 12s',
      '[fetch] skip (Audio nicht mehr vorhanden): audio_02',
      '[fetch] FEHLER audio_03: broken pipe',
    ])
    expect(p.perBase).toEqual({ audio_01: 'done', audio_02: 'failed', audio_03: 'failed' })
    expect(p.global).toBeNull()
  })
})

describe('parseJobPhases — die gestaffelte Pipeline (#405)', () => {
  // Seit v0.48.0 (10098e4) laeuft die Korrektur INNERHALB des Transkriptions-Jobs. Der Parser
  // stieg fuer `kind === 'transcribe'` aber vor dem gesamten correct-Dialekt aus — Diarisieren,
  // Korrigieren, Verifizieren und Anwenden waren damit unsichtbar, und eine gescheiterte
  // Korrektur meldete `done`, weil der Zustand aus der Transkription stehenblieb.
  //
  // Die Zeilen unten sind KEINE Erfindung: sie stammen aus einem echten Lauf auf der GPU
  // (faster-whisper tiny, echtes pyannote, Anbieter `custom` auf einen toten Loopback-Port —
  // damit ist `llm.available()` gruen und jeder Aufruf scheitert). Nur die Warnungen von
  // torch/pyannote sind weggelassen; sie stehen im echten Strom mit drin und sind fuer jedes
  // Muster folgenlos (der Test darunter prueft genau das).
  const ECHT = [
    '[scope] AufnahmeC',
    '[Probe] device=cuda (NVIDIA GeForce RTX 5080)',
    '[Probe] Modell tiny, 3 Datei(en)',
    '[active] AufnahmeC',
    '[Probe] -> transkribiere AufnahmeC …',
    '[Probe] fertig AufnahmeC: 0s, 0 Segmente, Audio 0:03, 3.0x',
    '[active] AufnahmeC',
    '→ Diarisiere AufnahmeC …',
    '⏱ AufnahmeC: Diarisierung 4s',
    '[done] AufnahmeC',
    'diarize: 1 Datei(en) diarisiert in 4s',
    '[done] AufnahmeC',
    '[active] AufnahmeC',
    '→ Korrigiere AufnahmeC …',
    '[Probe] Warte auf verbleibende KI-Korrekturen…',
    '  KI-Anbieter: Kein Kontakt zu http://127.0.0.1:9/v1/chat/completions',
    '  [diagnose] network\tKeine Verbindung zum Anbieter\tBitte Internetverbindung pruefen.',
    '⏱ AufnahmeC: Korrektur 2s',
    '✗ FEHLT/ungültig: AufnahmeC.correction.json — überspringe',
    '[done] AufnahmeC',
    '[Probe] Korrektur: 0 von 1 Datei(en) korrigiert',
    '⏱ [Probe]: 1 Datei(en) transkribiert in 9s (Audio 0:03, 0.4x)',
  ]

  it('eine gescheiterte Korrektur meldet nicht mehr „fertig"', () => {
    // DER Befund aus #405. Vorher: perBase {AufnahmeC:'done'} — Erfolg ueber einen Lauf, der
    // die Korrektur weggeworfen hat. An genau diesen Zeilen mit beiden Parsern gemessen:
    // der Stand vor dieser Reparatur liefert 'done', dieser hier 'failed'.
    expect(parseJobPhases('transcribe', ECHT).perBase).toEqual({ AufnahmeC: 'failed' })
  })

  it('…und der Lauf meldet dem Nutzer keinen Erfolg mehr', () => {
    // Die zweite Haelfte, und die erst macht den Befund zu einem Schaden: `ausgang()` las
    // `perBase` und fand nichts Gescheitertes, also `{art:'erfolg'}` — der Toast sagte
    // „fertig" ueber einen Lauf mit Exitcode 1. Ohne diese Zusicherung koennte der Parser
    // richtig liegen und die Meldung trotzdem falsch bleiben.
    expect(ausgang({ status: 'done', phases: parseJobPhases('transcribe', ECHT) }))
      .toEqual({ art: 'teil', misslungen: ['AufnahmeC'], versucht: 1 })
  })

  it('waehrend Diarisierung und Korrektur steht die richtige Phase da', () => {
    // Zweite Haelfte von #405: die Dateizeile zeigte waehrend der teuersten Minuten den
    // Zustand aus der Transkription, also „fertig", waehrend die Arbeit noch lief.
    const bis = (n: number) => parseJobPhases('transcribe', ECHT.slice(0, n))
    expect(bis(9).active).toEqual({ AufnahmeC: { phase: 'diarize' } })
    // `global` bleibt dabei null, und das ist kein Mangel: die Rueckgabe unterdrueckt die
    // globale Phase, solange eine Datei aktiv ist (eine Datei-Phase ist die genauere
    // Auskunft). Hier stand zuerst `toBe('diarize')` — die Behauptung war meine, nicht die
    // des Codes.
    expect(bis(9).global).toBeNull()
    expect(bis(15).active).toEqual({ AufnahmeC: { phase: 'correct' } })
    // …und am Ende raeumt der Terminalzustand den Spinner ab.
    expect(parseJobPhases('transcribe', ECHT).active).toEqual({})
  })

  it('die Warnungen von torch/pyannote im selben Strom aendern nichts', () => {
    // `jobs.py` mergt stderr nach stdout — im echten Job stehen zwischen den Zeilen oben
    // mehrzeilige Tracebacks. Ein Muster, das daran haengenbleibt, erfaende eine Datei.
    const laerm = [
      'W0827 21:23:19.042000 126312 torch\\utils\\flop_counter.py:29] triton not found',
      'Traceback (most recent call last):',
      '  File "E:\\...\\torch\\_ops.py", line 1503, in load_library',
      'OSError: Could not load this library: libtorchcodec_core8.dll',
      '  warnings.warn(',
    ]
    const mit = parseJobPhases('transcribe', [...ECHT.slice(0, 8), ...laerm, ...ECHT.slice(8)])
    expect(mit.perBase).toEqual({ AufnahmeC: 'failed' })
    expect(mit.active).toEqual({})
  })

  it('ein Wurf in der Vorbereitung OHNE KI-Pool faerbt die Aufnahme NICHT rot (#421)', () => {
    // Die Gegenrichtung, und sie ist der Grund fuer die zweite Zeilenform in transcribe.py.
    // Ohne Anbieter ist die Korrektur bewusst aus; ein Wurf in Diarisierung oder Prep darf
    // einen absichtlich ausgelassenen Schritt nicht nachtraeglich als Fehlschlag melden —
    // spiegelverkehrt derselbe Fehler wie ein rotes Exitcode fuer eine geschuetzte
    // `human_edited`-Datei (#417-Review).
    const ohne = parseJobPhases('transcribe', [
      '[scope] A', '[Probe] -> transkribiere A …', '[Probe] fertig A: 1s, 2 Segmente, 1.0x',
      '[autocorrect] KI-Phase uebersprungen — kein KI-Anbieter eingestellt',
      '[Probe] Vorbereitung gescheitert bei A (ohne KI-Phase): RuntimeError: CUDA out of memory',
    ])
    expect(ohne.perBase).toEqual({ A: 'done' })

    // …MIT Pool dagegen schon: dieselbe Ursache, andere Bedeutung, andere Zeile.
    const mit = parseJobPhases('transcribe', [
      '[scope] A', '[Probe] -> transkribiere A …', '[Probe] fertig A: 1s, 2 Segmente, 1.0x',
      '[Probe] Autocorrect-Fehler bei A: RuntimeError: CUDA out of memory',
    ])
    expect(mit.perBase).toEqual({ A: 'failed' })
  })

  it('ein SCHWAECHERES Urteil ueberschreibt kein staerkeres (#405/B1)', () => {
    // Der gestaffelte Lauf ist die erste Stelle, an der eine Aufnahme in EINEM Job zwei
    // Terminalurteile bekommt. `apply: SKIP … (human_edited=true)` schuetzt die Handarbeit
    // des Nutzers und heisst 'skipped' — ungefiltert stand die gerade transkribierte
    // Aufnahme danach auf „Uebersprungen".
    const p = parseJobPhases('transcribe', [
      '[scope] A\tB',
      '[P] -> transkribiere A …', '[P] fertig A: 1s, 2 Segmente, 1.0x',
      'apply: SKIP A (human_edited=true; --force zum Ueberschreiben)',
      '[P] -> transkribiere B …', '[P] fertig B: 1s, 2 Segmente, 1.0x',
      '✗ FEHLT/ungültig: B.correction.json — überspringe',
    ])
    expect(p.perBase).toEqual({ A: 'done', B: 'failed' })
    // Und DAS ist der Schaden, den es anrichtete: `ausgang()` zieht die uebersprungenen aus
    // dem NENNER, also meldete ein Lauf ueber zwei Aufnahmen „1 von 1 fehlgeschlagen".
    expect(ausgang({ status: 'done', phases: p }))
      .toEqual({ art: 'teil', misslungen: ['B'], versucht: 2 })

    // Gegenrichtung, und sie ist der Zweck dieses ganzen PR: 'done' -> 'failed' MUSS
    // durchgehen. Eine Rangregel, die auch das blockt, macht #405 wieder zu.
    const q = parseJobPhases('transcribe', [
      '[scope] A', '[P] -> transkribiere A …', '[P] fertig A: 1s, 2 Segmente, 1.0x',
      '✗ FEHLT/ungültig: A.correction.json — überspringe',
    ])
    expect(q.perBase).toEqual({ A: 'failed' })

    // …und der Spinner ist trotzdem weg, auch wenn das Urteil verworfen wurde.
    expect(p.active).toEqual({})
  })

  it('ein fetch-Job faellt NICHT in den correct-Dialekt', () => {
    // Der Riegel, der vom frueheren unbedingten `continue` uebrigbleibt. Ein Download-Job hat
    // keine Korrekturphase (`app.py` haengt immer `--download-only` an); faellt er trotzdem
    // durch, liest `^\[[^\]]+\] FEHLER (.+?): ` die URL einer `[fetch] FEHLER`-Zeile als
    // Basisnamen — die Falle aus #379, die den `continue` ueberhaupt begruendet hat.
    const p = parseJobPhases('fetch', [
      '[fetch] lade https://x/y …',
      '→ Korrigiere Video …',
      'apply: Video -> edit.json + md (3 Segmente)',
      '[fetch] FEHLER https://x/y: tot',
    ])
    expect(p.perBase).toEqual({})
    expect(p.active).toEqual({})
  })
})

describe('parseJobPhases — scope', () => {
  it('parst [scope] mit Tab-getrennten Dateinamen', () => {
    const p = parseJobPhases('correct', ['[scope] S1\tS2\tTimeline 1', '→ Glossar …'])
    expect(p.scope).toEqual(new Set(['S1', 'S2', 'Timeline 1']))
    expect(p.global).toBe('glossary')
  })
  it('parst leeren [scope] (z.B. URL-Import / fetch mit noch keinen Dateien)', () => {
    const p = parseJobPhases('fetch', ['[scope] ', '[fetch] lade Video …'])
    expect(p.scope).toEqual(new Set())
    expect(p.global).toBe('download')
  })
  it('bleibt undefined wenn kein [scope] gesendet wurde', () => {
    const p = parseJobPhases('transcribe', ['[Demo] -> transkribiere A …'])
    expect(p.scope).toBeUndefined()
  })
})

describe('parseJobPhases — Bereichs-Nachtrag [scope+]', () => {
  it('erweitert den Bereich um eine waehrend des Laufs hochgeladene Aufnahme', () => {
    // Der Fall aus dem Alltag: `[scope]` steht, bevor die Schleife das erste Mal
    // `find_audio` ruft — C existiert da noch nicht, wird aber verarbeitet.
    const p = parseJobPhases('transcribe', ['[scope] A\tB', '[scope+] C'])
    expect(p.scope).toEqual(new Set(['A', 'B', 'C']))
  })

  it('macht aus dem Nachtrag KEINEN Erstbereich', () => {
    // Die Fehlerrichtung ist der Punkt, und sie ist dieselbe wie serverseitig in `jobs.py`:
    // `scope === undefined` heisst fuer `imBereich` „gilt fuer alle" — die vorsichtige Seite.
    // Wuerde der Nachtrag den Bereich eroeffnen, verwuerfe `terminal()` ab da jedes Urteil
    // einer Aufnahme, ueber die der Lauf nie eine Zusage gemacht hat.
    const p = parseJobPhases('transcribe', [
      '[scope+] C',
      '[Demo] fertig A: 1s, 2 Segmente, 1.0x',
    ])
    expect(p.scope).toBeUndefined()
    expect(p.perBase).toEqual({ A: 'done' })
  })

  it('laesst die Zulassung fuer die nachgetragene Aufnahme gelten', () => {
    // Der eigentliche Zweck: `zugelassen` entscheidet, ob die Zeile ihren Zustand zeigt,
    // `imBereich` zusaetzlich, ob sie „In Warteschlange…" sagen darf. Ohne den Nachtrag war
    // beides false und die Zeile fiel auf „Nur Audio — noch nicht transkribiert" zurueck.
    const p = parseJobPhases('transcribe', ['[scope] A', '[scope+] C'])
    expect(imBereich(p, 'C', true)).toBe(true)
    expect(zugelassen(p, 'C', true)).toBe(true)
    expect(imBereich(p, 'Fremd', true)).toBe(false)
  })

  it('ein Projekt namens „scope+" verliert nicht seinen Status', () => {
    // `safe_name` laesst `+` durch (nur Steuerzeichen, Trenner und `..` fliegen raus), also
    // praefixt transcribe.py in einem so benannten Projekt JEDE Zeile mit `[scope+] `.
    // Dagegen tragen zwei Dinge: der Zweig steht ZULETZT (die spezifischen Formen gewinnen
    // vorher), und er ist ADDITIV — anders als beim ersetzenden `[scope]` bleiben die echten
    // Basisnamen also stehen, und was dazukommt, passt auf keine Datei.
    const p = parseJobPhases('transcribe', [
      '[scope] S1\tS2',
      '[scope+] Modell large-v3, 2 Datei(en)',
      '[scope+] -> transkribiere S1 …',
      '[scope+] fertig S1: 12s, 30 Segmente, 1.2x',
    ])
    expect(p.perBase).toEqual({ S1: 'done' })
    expect(p.scope?.has('S1')).toBe(true)
    expect(p.scope?.has('S2')).toBe(true)
  })
})

// Die Formen unten stammen alle aus einer vollstaendigen Gegenueberstellung Druckzeile <->
// Regex (#374/#375). Sie sind NICHT abgetippt, sondern an den f-Strings in correct.py und
// transcribe.py abgelesen und danach gegen den echten Parser gemessen — handgetippte Fixtures
// bestaetigen genau die Annahme, die man beim Schreiben hatte.
describe('parseJobPhases — Druckformen, die der Parser nicht kannte (#374)', () => {
  it('die Diarisierungs-Phase ueberlebt den Sprecherzahl-Zusatz', () => {
    // correct.py haengt seit #264 ` ({n} Sprecher)` an. Das gierige `(.+)` machte daraus den
    // Schluessel "Timeline 13 (5 Sprecher)"; beide Verbraucher schlagen aber mit dem exakten
    // Basisnamen nach, die Phase war also unsichtbar. Der Schnitt endet VOR `→ Korrigiere`:
    // das setzt `active` neu und machte die Wirkung dieser Zeile unsichtbar.
    const p = parseJobPhases('correct', ['→ Diarisiere Timeline 13 (5 Sprecher) …'])
    expect(p.active).toEqual({ 'Timeline 13': { phase: 'diarize' } })
  })
  it('… und die Form OHNE Zusatz bleibt unveraendert', () => {
    // Negativkontrolle: der optionale Teil darf keiner Datei ohne Sprecherzahl etwas abschneiden.
    const p = parseJobPhases('correct', ['→ Diarisiere Timeline 13 …'])
    expect(p.active).toEqual({ 'Timeline 13': { phase: 'diarize' } })
  })

  it('`skip (Audio nicht mehr vorhanden)` ist ein FEHLSCHLAG, kein Uebersprungen', () => {
    // Die einzige inhaltliche Entscheidung dieses Stands, und sie war ungetestet: die Mutation
    // 'failed' -> 'skipped' blieb ueber alle 731 Tests gruen. Sie zaehlt, weil `jobAusgang.ts`
    // 'skipped' aus dem Nenner der versuchten Dateien nimmt und nicht als misslungen fuehrt —
    // aus einer verlorenen Aufnahme wuerde wieder eine stille. `transcribe.py` legt sie in
    // dieselbe `failed_bases` wie den FEHLER-Pfad; die Anzeige folgt dem Lauf, nicht umgekehrt.
    const p = parseJobPhases('transcribe', ['[P] skip (Audio nicht mehr vorhanden): A'])
    expect(p.perBase).toEqual({ A: 'failed' })
  })

  it('ein Basisname mit Klammern ueberlebt ALLE DREI `apply: SKIP`-Formen', () => {
    // Der bestehende Klammer-Test deckt nur `human_edited=`. Bei der Form "… nicht lesbar:"
    // stand zuerst ein `.+?` statt eines Ankers, und damit lief das greedy `(.+)` ueber das
    // Ende des Namens hinaus: gemessen an `Interview (Teil 1)` kam der Schluessel
    // "Interview (Teil 1) (Interview" heraus UND der Spinner blieb stehen — also genau der
    // Zustand, den dieser Zweig beheben soll. Der Rueckverweis `\1` bindet die Begruendung an
    // den Namen, den sie wiederholt (correct.py druckt dort `{base}.edit.json`).
    const b = 'Interview (Teil 1)'
    for (const grund of [
      '(human_edited=true; --force zum Ueberschreiben)',
      `(${b}.edit.json nicht lesbar: JSONDecodeError: Expecting value; --force zum Ueberschreiben)`,
      '(waehrend des Laufs handbearbeitet; --force zum Ueberschreiben)',
    ]) {
      const p = parseJobPhases('correct', [`→ Korrigiere ${b} …`, `apply: SKIP ${b} ${grund}`])
      expect(p.perBase, grund).toEqual({ [b]: 'skipped' })
      expect(p.active, grund).toEqual({})
    }
  })

  it('ein Basisname, der SELBST auf `(N Sprecher)` endet, wird an der Bereichszeile gerettet', () => {
    // Von Subagent (M1) UND CodeRabbit-CLI unabhängig gefunden. Aus der Zeile allein ist der
    // Fall NICHT entscheidbar — `correct.py:298-300` hängt den Zusatz an, beide Lesarten
    // ergeben dieselben Bytes. Die zweite Quelle ist `[scope]` mit den echten Basisnamen.
    const p = parseJobPhases('correct', [
      '[scope] Runde 2 (3 Sprecher)',
      '→ Diarisiere Runde 2 (3 Sprecher) …',
    ])
    expect(p.active).toEqual({ 'Runde 2 (3 Sprecher)': { phase: 'diarize' } })
    // … und `[done]` findet denselben Schlüssel wieder. Vorher stand dort der gekürzte Name,
    // `[done]` druckt aber den rohen — der Spinner blieb bis zum Phasen-Sweep stehen.
    const q = parseJobPhases('correct', [
      '[scope] Runde 2 (3 Sprecher)',
      '→ Diarisiere Runde 2 (3 Sprecher) …',
      '[done] Runde 2 (3 Sprecher)',
    ])
    expect(q.active).toEqual({})
  })

  it('… aber bei ECHTER Zweideutigkeit gewinnt die gekürzte Form', () => {
    // Was die Bereichsrettung NEU erlaubt hat (CodeRabbit-Bot am PR): liegen `Runde 2` UND
    // `Runde 2 (3 Sprecher)` im selben Projekt und ist für `Runde 2` die Zahl 3 gesetzt, dann
    // steht der volle Text wegen der FREMDEN Datei im Bereich — die Phase landete unter dem
    // falschen Namen, und `[done] Runde 2` traf ihn nicht mehr. Vor der Rettung war die
    // Paarung richtig, weil immer gekürzt wurde.
    // Stehen beide Lesarten im Bereich, ist die Zeile wirklich nicht entscheidbar. Dann gilt
    // die gekürzte Form: das ist das bisherige Verhalten und der häufigere der beiden Fälle.
    const p = parseJobPhases('correct', [
      '[scope] Runde 2\tRunde 2 (3 Sprecher)',
      '→ Diarisiere Runde 2 (3 Sprecher) …',
      '[done] Runde 2',
    ])
    expect(p.active).toEqual({})
  })

  it('… und der HÄUFIGE Fall bleibt unberührt: gesetzte Sprecherzahl wird weiter abgeschnitten', () => {
    // Die Negativkontrolle zur Zeile darüber. Ohne sie wäre der Fix eine Regression an genau
    // der Stelle, die #374 Punkt 1 behoben hat — die Datei steht MIT ihrem echten Namen im
    // Bereich, der Zusatz gehört ihr also nicht.
    const p = parseJobPhases('correct', [
      '[scope] Timeline 13',
      '→ Diarisiere Timeline 13 (5 Sprecher) …',
    ])
    expect(p.active).toEqual({ 'Timeline 13': { phase: 'diarize' } })
    // Und ohne Bereichszeile bleibt es beim bisherigen Verhalten — der Rückfall darf den
    // Normalfall nicht plötzlich anders lesen.
    const ohne = parseJobPhases('correct', ['→ Diarisiere Timeline 13 (5 Sprecher) …'])
    expect(ohne.active).toEqual({ 'Timeline 13': { phase: 'diarize' } })
  })

  it('fremder Text hinter einem Klammerpräfix kann keine Datei-Meldung fälschen', () => {
    // Gemeldet von einem Parallelstrang (#413), hier nachgemessen. `.+?` ist faul, backtrackt
    // aber über die ganze Zeile bis zu einem SPÄTEREN `]` — das `^` schützt nicht, weil das
    // echte Präfix den Anker selbst erfüllt. Mehrere Druckstellen setzen rohen Ausnahmetext
    // hinter ein Klammerpräfix, der Weg ist also erreichbar.
    const gefaelscht = parseJobPhases('transcribe', ['[x] kaputt] skip (Audio nicht mehr vorhanden): D1'])
    expect(gefaelscht.perBase).toEqual({})

    // Positivkontrolle — ohne sie wäre eine Regex, die GAR nichts mehr fängt, ebenfalls grün.
    // Und zwar mit dem Randleerzeichen-Namen, den dieser Stand anderswo verteidigt.
    const echt = parseJobPhases('transcribe', ['[P] skip (Audio nicht mehr vorhanden): Interview '])
    expect(echt.perBase).toEqual({ 'Interview ': 'failed' })

    // KEIN gewollter Vertrag, sondern ein GETRAGENER DEFEKT — festgehalten, damit eine
    // Änderung bewusst passiert, nicht damit sie unterbleibt. Die eigentliche Behebung liegt
    // beim Producer und steht als #416: solange `paths.safe_name` `[`/`]` durchlässt (gemessen,
    // `A]B` kommt unverändert heraus), sind ein Projektname mit Klammer und eine Injektion auf
    // der Zeile NICHT unterscheidbar — beide ergeben dieselbe Form, und `scope` hilft hier
    // nicht, weil ein Angreifer als Basisnamen einfach eine echte Datei des Laufs wählt.
    // Der Parser muss sich also entscheiden, und „keine Falschaussage" wiegt schwerer als
    // „Live-Anzeige für einen ungewöhnlichen Namen". Begrenzt ist der Verlust auch: ohne
    // gesetzten `state` greift `ruhe(file)` in `FileStatusPill` und zeigt den echten
    // Ruhezustand — es fehlt die Phase WÄHREND des Laufs, kein Zustand danach.
    // Wer #416 löst, dreht diese Zusicherung um.
    const getragen = parseJobPhases('transcribe', ['[A]B] skip (Audio nicht mehr vorhanden): D1'])
    expect(getragen.perBase).toEqual({})
  })

  it('`apply: FEHLT {base}.json` beendet die Datei — sonst meldet der Lauf ERFOLG', () => {
    // Codex-Befund [high] am Bündel, nachgemessen und bestätigt. Ungelesen war diese Zeile
    // nicht bloss ein hängender Spinner: `cmd_apply` gibt "missing" zurück, `correct_ai_single`
    // verwirft den Wert (correct.py:1041 `cmd_apply(...)`, :1042 `return True`), und ohne
    // perBase-Eintrag findet `ausgang()` kein `misslungen` und keine `bilanz` — der Lauf meldete
    // {art:'erfolg'} über eine edit.json, die nie geschrieben wurde.
    const p = parseJobPhases('correct', [
      '→ Korrigiere A …',
      'apply: FEHLT A.json - Roh-Transkript nicht gefunden',
      '[done] A',
    ])
    expect(p.perBase).toEqual({ A: 'failed' })
    expect(p.active).toEqual({})   // `[done]` räumt nur diarize — ohne den Zweig bliebe der Spinner
  })

  it('… und ein Basisname, der SELBST auf `.json` endet, überlebt beide FEHLT-Formen', () => {
    // Der Grund, den Zweig in #407 zu parken: die naheliegende Weitung
    // `(.+?)\.(?:correction\.)?json` hätte `daten.json` auf "daten" verkürzt. Der Anker ist
    // hier nicht der Rückverweis aus I1 (der Name steht nur EINMAL in der Zeile), sondern der
    // feste SCHLUSSTEXT — er lässt genau eine Zerlegung der Zeile zu.
    // Was diese Zusicherung NICHT belegt: die Wahl des Quantors. Fester Schlusstext plus `$`
    // lassen nur eine Zerlegung zu, gierig und faul liefern hier also überall dasselbe — die
    // Zusicherung ist Regressionsschutz gegen die genannte Weitung, kein Beleg für `(.+)`.
    const b = 'daten.json'
    const roh = parseJobPhases('correct', [`apply: FEHLT ${b}.json - Roh-Transkript nicht gefunden`])
    expect(roh.perBase).toEqual({ [b]: 'failed' })
    // Negativkontrolle zur Reihenfolge: der spezifischere Zweig darf den Zwilling nicht schlucken.
    const korr = parseJobPhases('correct', ['apply: FEHLT A.correction.json - erst Korrektur-Workflow laufen lassen'])
    expect(korr.perBase).toEqual({ A: 'failed' })
    // Und die Gegenrichtung — der EINZIGE Fall, in dem die Reihenfolge der beiden Zweige
    // wirklich entscheidet. Ein Basisname auf `.correction` ergibt dieselbe Zeichenfolge
    // `.correction.json`; steht der kürzere Zweig vorn, kappt sein `(.+?)` den Namen zu "A".
    // Ohne diese Zusicherung wäre der Reihenfolge-Kommentar im Code eine Behauptung, die
    // keine Mutation rot bekommt.
    const heikel = parseJobPhases('correct', ['apply: FEHLT A.correction.json - Roh-Transkript nicht gefunden'])
    expect(heikel.perBase).toEqual({ 'A.correction': 'failed' })
  })

  it('beide Schutzpfade von `apply: SKIP` beenden die Datei', () => {
    // correct.py druckt DREI Begruendungen; der Parser kannte nur `human_edited=`. Die beiden
    // anderen sind die Schutzpfade aus #190 und #278 — beide heissen "deine Fassung bleibt
    // stehen", und beide liessen die Datei bis Jobende auf einem Spinner stehen.
    const p = parseJobPhases('correct', [
      '→ Korrigiere A …', '→ Korrigiere B …',
      'apply: SKIP A (A.edit.json nicht lesbar: JSONDecodeError: Expecting value; --force zum Ueberschreiben)',
      'apply: SKIP B (waehrend des Laufs handbearbeitet; --force zum Ueberschreiben)',
    ])
    expect(p.perBase).toEqual({ A: 'skipped', B: 'skipped' })
    expect(p.active).toEqual({})
  })

  it('die leichten Korrektur-Tiefen erzeugen eine Phase statt „Vorbereiten…"', () => {
    // In einem Lauf ohne `voll*`-Datei wurde nie ein active-Eintrag gesetzt, `global` blieb
    // ueber die gesamte LLM-Dauer auf 'prep' — und genau das ist bei diesen Tiefen die ganze
    // Arbeit (ein Aufruf je Datei, ohne Glossar und Treue-Pass).
    const leicht = parseJobPhases('correct', ['prep: 1 Datei(en) getaggt in /x', '→ Leichte Korrektur A …'])
    expect(leicht.active).toEqual({ A: { phase: 'correct' } })
    expect(leicht.global).toBeNull()
    const kurz = parseJobPhases('correct', ['prep: 1 Datei(en) getaggt in /x', '→ Nur Zusammenfassung B …'])
    expect(kurz.active).toEqual({ B: { phase: 'correct' } })
    expect(kurz.global).toBeNull()
  })
})

describe('parseJobPhases — Robustheit gegen echte Namen und Zeilen (#379)', () => {
  it('ein Projekt namens „scope" verliert nicht seinen ganzen Status', () => {
    // transcribe.py praefixt JEDE Zeile mit dem Projektnamen, und `safe_name('scope')` liefert
    // 'scope' (gemessen). Ohne "nur die erste [scope]-Zeile zaehlt" las der Parser jede davon
    // als Bereichsmeldung; `terminal()` verwarf danach jeden echten Dateistatus — gemessen kam
    // `perBase: {}` heraus statt `{S1:'done'}`. Dieselbe Falle, die #396 fuer 'fetch' schloss.
    const p = parseJobPhases('transcribe', [
      '[scope] S1\tS2',
      '[scope] Modell large-v3, 2 Datei(en)',
      '[scope] -> transkribiere S1 …',
      '[scope] fertig S1: 12s, 30 Segmente, 1.2x',
    ])
    expect(p.scope).toEqual(new Set(['S1', 'S2']))
    expect(p.perBase).toEqual({ S1: 'done' })
  })

  it('ein Basisname mit Leerzeichen am Ende bleibt EIN Eintrag', () => {
    // `safe_name('Interview ')` laesst den Namen unveraendert (gemessen). Getrimmt zerfaellt
    // dieselbe Datei in zwei Schluessel: "Interview" aus einer $-verankerten Zeile, "Interview "
    // aus einer mittigen — ein Phantom-Eintrag, der nie mehr verschwindet.
    // BEIDE Zeilenformen sind noetig, und das ist der Kern: der Schnitt wirkt nur an den
    // ZEILENENDEN. In der fertig-Zeile steht der Name mitten drin (`(.+?): ` faengt das
    // Leerzeichen mit), nur die skip-Zeile endet auf ihm. Ein Test allein auf der fertig-Zeile
    // bleibt gruen, auch wenn man `trim()` zurueckbaut — genau so vacuous war der erste Versuch,
    // gemessen an der Mutation.
    // Der $-verankerte Traeger ist `skip (Audio nicht mehr vorhanden)`. Der frueher
    // naheliegende Zwilling `skip (vorhanden)` scheidet aus: seine Druckform ist seit dem
    // gestaffelten Lauf weg, und seit #408 auch der Parser-Zweig — ein Test darauf sicherte
    // die Eigenschaft ueber einen Kanal, den es nicht gibt.
    const p = parseJobPhases('transcribe', [
      '[P] skip (Audio nicht mehr vorhanden): Interview ',
      '[P] fertig Interview : 3s, 4 Segmente, 1.0x',
    ])
    expect(Object.keys(p.perBase)).toEqual(['Interview '])
  })

  it('… und die BEREICHSZEILE frisst die Randleerzeichen auch nicht', () => {
    // Dieselbe Klasse wie der Zeilenschnitt darüber, nur eine Zeile höher gedacht — und
    // genau deshalb übersehen: `l.slice(7).trim()` schnitt an den ENDEN der ganzen Nutzlast,
    // also am ersten und am letzten Basisnamen. Ein Name mittendrin blieb heil, die Ränder
    // nicht. Folge: `terminal()` filtert die Datei über `scope.has(base)` weg — kein
    // perBase-Eintrag, kein Aufräumen von `active`. Sie hängt bis Jobende auf dem Spinner
    // UND fehlt in der Bilanz, also wieder der #376-Zustand.
    // Geschnitten wird jetzt genau EIN Trennleerzeichen hinter `[scope]`, mehr nicht.
    const hinten = parseJobPhases('transcribe', [
      '[scope] Zweite\tInterview ',
      '[P] skip (Audio nicht mehr vorhanden): Interview ',
    ])
    expect(hinten.perBase).toEqual({ 'Interview ': 'failed' })

    const vorne = parseJobPhases('transcribe', [
      '[scope]  Interview\tZweite',
      '[P] skip (Audio nicht mehr vorhanden):  Interview',
    ])
    expect(vorne.perBase).toEqual({ ' Interview': 'failed' })

    // Negativkontrolle: der leere Bereich des fetch-Laufs bleibt ein leeres Set — er ist
    // truthy und lässt `terminal()` bewusst ALLES verwerfen (siehe Kommentar am fetch-Zweig).
    expect(parseJobPhases('fetch', ['[scope] ']).scope).toEqual(new Set())
  })

  it('… und `[done]` findet denselben Namen wieder', () => {
    // Zweiter lebender Traeger derselben Eigenschaft, und er gehoert zum Zweig, den dieser
    // Stand gerade eingefuehrt hat: `[done] {base}` ist $-verankert. Getrimmt trifft es den
    // active-Eintrag nicht mehr, und der Diarisierungs-Spinner klemmt bis zum Phasen-Sweep.
    const p = parseJobPhases('correct', ['→ Diarisiere Interview  …', '[done] Interview '])
    expect(p.active).toEqual({})
  })

  it('ein Basisname mit Leerzeichen am ANFANG behaelt seinen Blockfortschritt', () => {
    // Die Gegenkante: die Einrueckung muss fallen (correct.py setzt vor Block- und
    // Diagnosezeilen genau zwei Leerzeichen), ein drittes Leerzeichen gehoert aber schon zum
    // Namen. `/^\s+/` frass es mit — die eingerueckte Bloecke-Zeile ergab dann "Interview",
    // die nicht eingerueckte `→ Korrigiere`-Zeile " Interview", und der Balken fand seinen
    // Eintrag nicht mehr. Sichtbar wird das NUR an pct/detail, nicht am Schluessel.
    const p = parseJobPhases('correct', [
      '   Interview: 540 Segmente → 4 Blöcke à max. 150',
      '  ✓  Interview · Block 1/4 fertig',
      '→ Korrigiere  Interview · Block 2/4 …',
    ])
    expect(p.active).toEqual({ ' Interview': { phase: 'correct', pct: 25, detail: '1/4 Blöcke' } })
  })

  it('eingerueckte Diagnosezeilen bleiben folgenlos', () => {
    // Negativkontrolle zur Zeile darueber: vorne wird weiterhin abgeschnitten. correct.py
    // druckt eingerueckte Diagnosezeilen; keine davon darf ein Datei-Ereignis erzeugen.
    const p = parseJobPhases('correct', [
      '→ Korrigiere A …', '  claude exit 1: irgendwas', '  [diagnose] limit\tKontingent\tspaeter',
    ])
    expect(p.active).toEqual({ A: { phase: 'correct' } })
    expect(p.perBase).toEqual({})
  })

  it('`[done]` beendet die Diarisierung EINER Datei, nicht erst die ganze Phase', () => {
    // Bisher raeumte nur der Phasen-Sweep auf: bei N Aufnahmen standen bis zu N-1 Spinner ueber
    // laengst fertigen Dateien, ueber die teuerste Phase des Prep-Schritts. `[done] {base}`
    // folgt auf JEDEN Ausgang der Schleife (Erfolg, "keine Sprecher", unlesbar, Ausnahme).
    const p = parseJobPhases('correct', [
      '→ Diarisiere A …', '→ Diarisiere B …', '⏱ A: Diarisierung 45s', '[done] A',
    ])
    expect(p.active).toEqual({ B: { phase: 'diarize' } })
    // `global` ist null, solange eine Datei aktiv ist (Rueckgabe unten in jobPhases.ts) — die
    // Aussage dieses Tests steckt allein in `active`.
    expect(p.global).toBeNull()
  })

  it('`[done]` beendet KEINE laufende Korrektur', () => {
    // Negativkontrolle: correct.py druckt `[done] {base}` auch am Ende der KI-Phase. Wuerde es
    // dort den active-Eintrag loeschen, verschwaende der Korrektur-Spinner, bevor `apply` den
    // Terminal-Status setzt — die Datei sieht dann fertig aus, obwohl nichts geschrieben ist.
    const p = parseJobPhases('correct', ['→ Korrigiere A …', '[done] A'])
    expect(p.active).toEqual({ A: { phase: 'correct' } })
  })
})

describe('parseJobPhases — Zeilen-Injektion durch fremden Text (#413)', () => {
  // `\[.+?\]` war lazy und backtrackte ueber die ganze Zeile bis zu einem SPAETEREN `]`.
  // Das `^` half nicht: das echte Praefix erfuellt den Anker selbst. Jede Zeile der Form
  // `[irgendwas] … ] fertig X: …` meldete X damit als fertig.
  //
  // Woher der fremde Text kommt: 13 Druckstellen in transcribe.py, ytdlp_update.py und
  // sperre.py setzen rohen Ausnahmetext hinter ein Klammerpraefix. Der gefaehrlichste Weg
  // ist `[{name}] Autocorrect-Fehler bei {base}: {ex}` — `ex` entsteht in `cmd_diarize`/
  // `prep_single`, die TRANSKRIPTE lesen, und die koennen aus einem URL-Import stammen.
  //
  // Die fuenfte Form (`skip (Audio nicht mehr vorhanden)`) kam mit dem Buendel und war dort
  // zuerst gehaertet; ihre Gegenkontrolle steht oben. Hier stehen die vier uebrigen.
  const gift = '] fertig D1: x'

  it('ein spaeteres `]` im Fremdtext meldet keine Datei als fertig', () => {
    const p = parseJobPhases('transcribe', [
      '[scope]	D1',
      '[Demo] -> transkribiere D1 …',
      `[autocorrect] KI-Phase uebersprungen — kaputt${gift}`,
    ])
    expect(p.perBase).toEqual({})                       // NICHT { D1: 'done' }
    expect(p.active).toEqual({ D1: { phase: 'transcribe' } })
  })

  it('dasselbe fuer FEHLER und -> transkribiere', () => {
    // `[ytdlp]`-Zeilen erreichen diese Muster wirklich: `parseJobPhases` behandelt
    // `transcribe` und `fetch` gemeinsam, und `[ytdlp]` faellt nicht unter den
    // vorgezogenen `[fetch] `-Filter. Gegen master gemessen ergab die erste Zeile dort
    // `{ D1: 'failed' }` — ein Fehlschlag, den niemand verursacht hat (#409).
    const fehler = parseJobPhases('fetch', [
      '[scope]	D1', '[ytdlp] Update fehlgeschlagen: kaputt] FEHLER D1: x',
    ])
    expect(fehler.perBase).toEqual({})
    const aktiv = parseJobPhases('transcribe', [
      '[scope]	D1', '[sperre] nicht anlegbar (kaputt] -> transkribiere D1 …',
    ])
    expect(aktiv.active).toEqual({})
  })

  it('die ECHTEN Zeilen funktionieren unveraendert', () => {
    // Gegenkontrolle: ein Riegel, der auch die echten Formen abweist, waere schlimmer als
    // die Luecke. Der Preis dafuer ist ein GETRAGENER DEFEKT, kein gewollter Vertrag —
    // ein Projektname mit `]` verliert die Live-Anzeige, weil `paths.safe_name` das Zeichen
    // durchlaesst. Solange das so ist, sind ein solcher Name und eine Injektion auf der
    // Zeile nicht unterscheidbar; die Behebung liegt beim Producer und steht als #416.
    const p = parseJobPhases('transcribe', [
      '[scope]	A	B	C',
      '[Demo] -> transkribiere A …', '[Demo] fertig A: 12s, 30 Segmente',
      '[Demo] skip (Audio nicht mehr vorhanden): B',
      '[Demo] FEHLER C: kaputt',
    ])
    expect(p.perBase).toEqual({ A: 'done', B: 'failed', C: 'failed' })
  })
})
describe('parseJobPhases - Aufnahme kommt mitten im Lauf dazu (#431)', () => {
  // `[scope]` steht fest, bevor `transcribe_project` das erste Mal `find_audio` ruft. Eine
  // waehrend des Laufs hochgeladene Aufnahme steht also nie darin - verarbeitet wird sie
  // trotzdem, und der Lauf kuendigt sie mit `[active]` an.
  it('laesst das Urteil einer Aufnahme durch, die erst per [active] auftaucht', () => {
    const p = parseJobPhases('transcribe', [
      '[scope] A',
      '[Demo] -> transkribiere A ...', '[Demo] fertig A: 1s, 2 Segmente, 1.0x',
      '[active] B',
      '[Demo] -> transkribiere B ...', '[Demo] fertig B: 1s, 2 Segmente, 1.0x',
    ])
    expect(p.perBase).toEqual({ A: 'done', B: 'done' })
  })

  // Die Gegenrichtung, und ohne sie waere der Test darueber auch dann gruen, wenn `terminal()`
  // GAR NICHT mehr filterte. Der `scope`-Riegel ist die Wache gegen ein Projekt namens
  // "scope", dessen eigene Fortschrittszeilen sonst als Bereichsmeldung gelesen wuerden -
  // gemessen blieb perBase danach leer.
  it('verwirft weiterhin ein Urteil ohne [scope]- UND ohne [active]-Zulassung', () => {
    const p = parseJobPhases('transcribe', [
      '[scope] A',
      '[Demo] fertig A: 1s, 2 Segmente, 1.0x',
      '[Demo] fertig Fremd: 1s, 2 Segmente, 1.0x',
    ])
    expect(p.perBase).toEqual({ A: 'done' })
  })

  // `[done] {base}` ist fuer den Parser heute eine No-op-Zeile (nur `jobs.py` liest sie, um
  // `active_bases` zu raeumen). Der Test haelt fest, dass sie das fuer `gesehen` auch BLEIBEN
  // muss: wer sie eines Tages hier verarbeitet und dabei die Zulassung zuruecknimmt, laesst
  // genau das Urteil wieder fallen, das eine Zeile spaeter kommt.
  it('behaelt die Zulassung ueber ein [done] hinweg', () => {
    const p = parseJobPhases('transcribe', [
      '[scope] A', '[active] B', '[done] B',
      '[Demo] fertig B: 1s, 2 Segmente, 1.0x',
    ])
    expect(p.perBase).toEqual({ B: 'done' })
  })
})

describe('parseJobPhases - ein Projekt namens "active" (#431, Review-Befund A1)', () => {
  // `transcribe.py` praefixt JEDE Zeile mit `[{Projektname}] `. Die erste Fassung des Fixes
  // stellte den `[active]`-Zweig VOR die Dialekt-Regexe und frass sie damit alle - gemessen
  // ergab das `perBase={}` statt `{B:'done'}`. Dieselbe Falle wie beim Projekt namens "scope"
  // und wie #379 fuer "fetch"; deshalb steht der Zweig jetzt ZULETZT.
  it('liest die Projektzeilen, statt sie als Bereichsmeldung zu fressen', () => {
    const p = parseJobPhases('transcribe', [
      '[scope] B',
      '[active] -> transkribiere B ...',
      '[active] fertig B: 1s, 2 Segmente, 1.0x',
    ])
    expect(p.perBase).toEqual({ B: 'done' })
  })

  // Gegenrichtung: die ECHTE Marke wird weiterhin gelesen. Ohne sie waere der Test oben auch
  // dann gruen, wenn der Zweig ganz fehlte.
  it('liest eine echte [active]-Marke weiterhin', () => {
    const p = parseJobPhases('transcribe', ['[scope] A', '[active] B'])
    expect(p.gesehen).toEqual(new Set(['B']))
  })
})

describe('imBereich / zugelassen - die EINE Quelle der drei Filterstellen (#431)', () => {
  const ph = (scope?: string[], gesehen?: string[]) => ({
    global: null, active: {}, perBase: {},
    ...(scope ? { scope: new Set(scope) } : {}),
    ...(gesehen ? { gesehen: new Set(gesehen) } : {}),
  })

  it('Bereich erlaubt BEIDES - Prognose und Zustand', () => {
    expect(imBereich(ph(['a']), 'a', true)).toBe(true)
    expect(zugelassen(ph(['a']), 'a', true)).toBe(true)
  })

  // Der Kern des Review-Befunds A2: das Glossar meldet seit #450 KORPUSWEIT `[active]`.
  // Duerfte `gesehen` auch die Prognose stellen, stuende bei einem Einzeldatei-Lauf der
  // ganze Korpus auf "In Warteschlange..." (gemessen: 3 statt 1).
  it('Beobachtung erlaubt den Zustand, aber KEINE Warte-Prognose', () => {
    expect(zugelassen(ph(['a'], ['b']), 'b', true)).toBe(true)
    expect(imBereich(ph(['a'], ['b']), 'b', true)).toBe(false)
  })

  it('weder noch: beides falsch', () => {
    expect(zugelassen(ph(['a']), 'fremd', true)).toBe(false)
    expect(imBereich(ph(['a']), 'fremd', true)).toBe(false)
  })

  it('ohne Bereichszeile gilt alles als drin - bisheriges Verhalten', () => {
    expect(imBereich(ph(), 'x', true)).toBe(true)
  })

  it('ohne laufenden Job ist beides falsch', () => {
    expect(imBereich(ph(['a'], ['a']), 'a', false)).toBe(false)
    expect(zugelassen(ph(['a'], ['a']), 'a', false)).toBe(false)
  })
})

describe('parseJobPhases - Vorbelegung aus der Server-Buchfuehrung (#475)', () => {
  // Der Server bucht jede `[active]`-Zeile, BEVOR sie in den bei MAX_JOB_LINES gedeckelten
  // Puffer wandert, und gibt die Menge im Schnappschuss mit. Faellt die Zeile aus dem Puffer,
  // ist sie die einzige verbliebene Zulassung.
  const lines = ['[scope] Frueh', '[Demo] FEHLER Spaet: Tonspur unlesbar']

  it('kippt den AUSGANG des Laufs, nicht nur die Pille', () => {
    // Ohne Vorbelegung faellt der Fehlschlag der spaet dazugekommenen Aufnahme weg -- der
    // Lauf meldete "fertig", obwohl eine Datei gescheitert ist.
    expect(ausgang({ status: 'done', phases: parseJobPhases('transcribe', lines) }))
      .toEqual({ art: 'erfolg' })
    // Mit Vorbelegung meldet derselbe Lauf ihn. Das ist die ZWEITE Verhaltensaenderung des
    // Fixes -- sie haengt an Toast und Betriebssystem-Meldung, nicht nur an der Anzeige, und
    // stand vor diesem Test nirgends.
    expect(ausgang({ status: 'done', phases: parseJobPhases('transcribe', lines, ['Spaet']) }))
      .toEqual({ art: 'teil', misslungen: ['Spaet'], versucht: 1 })
  })

  it('schaltet den Bereichsfilter mit einer LEEREN Vorbelegung nicht ab', () => {
    // Der Server schickt das Feld IMMER mit, auch leer -- und keine Attrappe im Bestand trug
    // es. Gemessen: eine Vereinfachung, die den Parameter als truthy liest und damit den
    // Bereichsfilter fuer JEDEN Lauf abschaltet, blieb ueber alle 802 Tests gruen. Diese
    // Zusicherung ist der Sensor dafuer.
    const p = parseJobPhases('transcribe', [
      '[scope] A',
      '[Demo] fertig A: 1s, 2 Segmente, 1.0x',
      '[Demo] fertig Fremd: 1s, 2 Segmente, 1.0x',
    ], [])
    expect(p.perBase).toEqual({ A: 'done' })
  })
})

describe('parseJobPhases - was das Endurteil ueber die Platte beweist (`erreicht`)', () => {
  // Die Untergrenze fuer `ruhe()` in FileStatusPill. Ohne sie faellt die Pille im Moment des
  // Endurteils auf die Dateiliste zurueck, und die ist dort zwingend die aeltere Quelle: sie
  // wird nicht gepollt, und ein geschriebenes Roh-`<base>.json` aendert weder `dateien` noch
  // `fertig` in der Zusammenfassung, stoesst also auch den Summenpoll-Waechter nicht an.
  // Im Browser gemessen: „Nur Audio - noch nicht transkribiert" ueber eine Aufnahme, deren
  // `[done]` und deren `<base>.json` beide schon da waren.
  it('`fertig X:` beweist das Roh-Transkript', () => {
    const p = parseJobPhases('transcribe', ['[Demo] fertig A: 12s, 30 Segmente, 1.2x'])
    expect(p.erreicht).toEqual({ A: 'raw' })
  })

  it('`apply: X -> edit.json` beweist die Editordatei', () => {
    const p = parseJobPhases('correct', ['apply: A -> edit.json'])
    expect(p.erreicht).toEqual({ A: 'edit' })
  })

  it('der gestaffelte Lauf hebt `raw` auf `edit`', () => {
    // Reihenfolge im echten Lauf: erst die Transkription, dann die Korrektur derselben Datei.
    const p = parseJobPhases('transcribe', [
      '[Demo] fertig A: 12s, 30 Segmente, 1.2x',
      'apply: A -> edit.json',
    ])
    expect(p.erreicht).toEqual({ A: 'edit' })
  })

  it('ein spaeteres `fertig` senkt den Beleg wieder auf `raw`', () => {
    // Die Gegenrichtung, und sie ist NICHT theoretisch: `delete_file` prueft `active_only`
    // und gibt eine Aufnahme nach ihrem `[done]` frei (#485). Wer sie loescht und gleichnamig
    // neu hochlaedt, bekommt im selben Strom ein zweites `fertig A:` — das beweist ein
    // frisches Roh-Transkript und widerlegt die alte edit.json.
    //
    // Mit der urspruenglichen „nur aufwaerts"-Regel stand hier `{A: 'edit'}`, und die Zeile
    // haette bis Jobende „Fertig" ueber eine Aufnahme behauptet, die nur Audio ist — ohne
    // jede Selbstheilung. Ein `raw` NACH einem `edit` kann im normalen Lauf gar nicht
    // vorkommen (`transcribe_project` fasst nur Aufnahmen ohne `.json` an), die Reihenfolge
    // ist also selbst das Signal.
    const p = parseJobPhases('transcribe', [
      'apply: A -> edit.json',
      '[Demo] fertig A: 12s, 30 Segmente, 1.2x',
    ])
    expect(p.erreicht).toEqual({ A: 'raw' })
  })

  it('ein geschuetzter `apply: SKIP` belegt die edit.json trotzdem', () => {
    // Hier stand zuerst „SKIP traegt nichts ein, denn 'skipped' rendert ueber STATE[]" — das
    // gilt nur fuer den reinen `correct`-Job. Im GESTAFFELTEN Lauf kommt vorher `fertig X:`
    // ('done', RANG 2), und das folgende 'skipped' (RANG 1) wird von der Rangregel
    // verschluckt: der Zustand bleibt 'done', und 'done' faellt sehr wohl auf `ruhe()` durch.
    // Deshalb ist die Reihenfolge hier der Kern des Tests, nicht Beiwerk.
    const p = parseJobPhases('transcribe', [
      '[Demo] fertig A: 12s, 30 Segmente, 1.2x',
      'apply: SKIP A (waehrend des Laufs handbearbeitet)',
    ])
    expect(p.perBase).toEqual({ A: 'done' })        // 'skipped' verschluckt, wie dokumentiert
    expect(p.erreicht).toEqual({ A: 'edit' })       // die edit.json ist trotzdem da
  })

  it('eine NICHT zugelassene Aufnahme bekommt keinen Beleg', () => {
    // Dieselbe Wache wie fuer `perBase`: steht ein Bereich und gehoert die Aufnahme weder zu
    // ihm noch zu `gesehen`, ist die Zeile nicht ueber sie. Ohne das koennte fremder Text in
    // einem Transkript eine Datei als „fertig" ausweisen, die der Lauf nie angefasst hat.
    const p = parseJobPhases('transcribe', [
      '[scope] A',
      '[Demo] fertig Fremd: 12s, 30 Segmente, 1.2x',
    ])
    expect(p.erreicht).toBeUndefined()
  })

  it('ohne Endurteil gibt es das Feld gar nicht', () => {
    // Wie `gesehen`: ein immer vorhandenes leeres Objekt waere eine Feldaenderung in jeder
    // Antwort, fuer einen Fall, den es meist nicht gibt.
    const p = parseJobPhases('transcribe', ['[Demo] -> transkribiere A …'])
    expect(p.erreicht).toBeUndefined()
  })
})

// IDENTITAET STATT ANWESENHEIT (#479/#489): eine waehrend eines Laufs geloeschte und
// gleichnamig neu hochgeladene Aufnahme darf die Urteile der alten nicht erben. Zwei
// Signale tragen das: die serverseitige `entfernt`-Menge (Fenster A — das Loeschen druckt
// keine Zeile, der Server ist der einzige Rueckweg) und das `[scope+]`-REANNONCEMENT
// (Fenster B — transcribe.py meldet nur nach, wenn die Datei-IDENTITAET `_kennung` von der
// zuletzt angekuendigten abweicht; die Marke ist der parser-sichtbare Beweis „eine ANDERE
// Datei unter diesem Namen").
describe('parseJobPhases: geloeschte Aufnahmen erben keine Urteile (#479/#489)', () => {
  // Der Ablauf aus #489: fertig korrigiert -> [done] -> geloescht -> gleichnamig neu
  // hochgeladen. Im Puffer stehen noch die alten Zeilen; der Server hat `entfernt:['X']`.
  const PUFFER = [
    '[scope] X',
    '[Demo] -> transkribiere X …',
    '[Demo] fertig X: 12s, 30 Segmente, 1.2x',
    'apply: X -> edit.json',
    '[done] X',
  ]

  it('Fenster A: serverseitiges entfernt unterdrueckt Urteil UND Beleg sofort', () => {
    // Ohne diesen Rueckweg stuende hier {X:'done'} / {X:'edit'} — die Pille zeigte „Fertig"
    // ueber einer Aufnahme, die nur Audio ist, bis der Lauf sie wieder erreicht (Minuten).
    const p = parseJobPhases('transcribe', PUFFER, undefined, ['X'])
    expect(p.perBase).toEqual({})
    expect(p.erreicht).toBeUndefined()
  })

  it('Fenster A raeumt Urteil UND Spinner am unterdrueckten Endurteil (#379-Halbsatz)', () => {
    // Der Spinner entsteht durch die PHASEN-Zeile (`-> transkribiere X`), das Raeumen durch
    // das ENDURTEIL — beides muss im Puffer stehen, sonst misst der Test einen Zustand, den
    // kein Lauf druckt (gegnerisches Review B1: die erste Fassung hatte nur [active] X und
    // war unter der Mutation still gruen — die Phase bucht active, aber nichts rief terminal).
    const p = parseJobPhases('transcribe', [
      '[scope] X',
      '[active] X',
      '[Demo] -> transkribiere X …',
      '[Demo] fertig X: 1s, 2 Segmente, 1.0x',
    ], undefined, ['X'])
    expect(p.perBase).toEqual({})
    expect(p.active).toEqual({})
  })

  it('nur die geloeschte Aufnahme ist betroffen; `gesehen`-Zulassung ueberlebt fuer andere', () => {
    const p = parseJobPhases('transcribe', [
      ...PUFFER,
      '[Demo] fertig Y: 9s, 12 Segmente, 1.0x',
    ], ['Y'], ['X'])
    expect(p.perBase).toEqual({ Y: 'done' })
  })

  it('Fenster B (Parser-Regel): das Reannoncement tilgt ein altes Urteil bis zur Marke', () => {
    // KEIN Produzent druckt diese Sequenz heute (kalter Zweitleser: Base mit Urteil ist in
    // processed/failed_bases, nie wieder pending, wird also nie re-annonciert) — der Test
    // uebt die PARSER-REGEL, nicht einen realen Strom: tilgt die Marke nicht, gewinnt das
    // ranghohe alte 'failed' gegen das neuere 'done'. Die Regel ist Defensive gegen eine
    // kuenftige Erweiterung der Druckbedingung (Kommentar am [scope+]-Zweig).
    const p = parseJobPhases('transcribe', [
      '[scope] X',
      '[Demo] FEHLER X: kaputt',
      '[scope+] X',
      '[Demo] fertig X: 5s, 8 Segmente, 1.0x',
    ])
    expect(p.perBase).toEqual({ X: 'done' })
  })

  it('Fenster B (Parser-Regel): der alte edit-Beleg stirbt an der Marke — auch OHNE neuen Beleg', () => {
    // Parser-Ebene wie der Nachbar-Test (kein Produzent druckt Urteil-dann-Marke); hier
    // die Beleg-Haelfte: tilgt die Marke nicht, bliebe der alte `edit` stehen, und ohne
    // nachfolgenden Beleg heilt auch die Zeilenfolge nichts — #489 in der schaerfen Form.
    const p = parseJobPhases('transcribe', [
      '[scope] X',
      'apply: X -> edit.json',
      '[scope+] X',
      '[Demo] FEHLER X: kaputt',
    ])
    expect(p.erreicht).toBeUndefined()
    expect(p.perBase).toEqual({ X: 'failed' })
  })

  it('Zweitloeschung nach der Marke: die Unterdrueckung HAELT (Reaktivierung ist serverseitig)', () => {
    // Review W1: die Server-Realitaet nach der Zweitloeschung ist Seed {X} PLUS die Marke
    // des ERSTEN Reuploads im Puffer — der Server hat X neu gebucht und raeumt erst bei
    // der NAECHSTEN Marke. Ein parser-seitiges Lift an der Marke hob hier die frisch
    // gebuchte Unterdrueckung auf, und die Aufnahme dahinter erbte X2s Urteile
    // (erreicht 'edit' ueber Nur-Audio, am echten Parser gemessen). Der Parser darf die
    // Marke NUR zum rueckblickenden Tilgen nutzen — nie zur Reaktivierung.
    const p = parseJobPhases('transcribe', [
      ...PUFFER,
      '[scope+] X',
      '[Demo] fertig X: 5s, 8 Segmente, 1.0x',
    ], undefined, ['X'])
    expect(p.perBase).toEqual({})
    expect(p.erreicht).toBeUndefined()
  })

  it('nach der ZWEITEN Marke gilt der neue Stand wieder (Doppelzyklus, Reaktivierung serverseitig)', () => {
    // Der Server hat bei der zweiten Marke gebucht (discard), der Seed kommt also leer —
    // der Parser tilgt an BEIDEN Marken und laesst nur den letzten Stand gelten.
    const p = parseJobPhases('transcribe', [
      ...PUFFER,
      '[scope+] X',
      '[Demo] fertig X: 5s, 8 Segmente, 1.0x',
      '[scope+] X',
      '[Demo] fertig X: 4s, 6 Segmente, 1.0x',
    ], undefined, [])
    expect(p.perBase).toEqual({ X: 'done' })
    expect(p.erreicht).toEqual({ X: 'raw' })
  })

  it('Doppel-Zyklus: ein zweites Reannoncement tilgt die Urteile des ersten', () => {
    // Loeschen/Neu-Anlegen kann sich wiederholen. Jede Marke entwertet alles bis zu ihr —
    // sonst stuende am Ende das `failed` des ersten Reuploads ueber der zweiten neuen Datei.
    const p = parseJobPhases('transcribe', [
      '[scope] X',
      '[scope+] X',
      '[Demo] FEHLER X: wieder kaputt',
      '[scope+] X',
      '[Demo] fertig X: 4s, 6 Segmente, 1.0x',
    ])
    expect(p.perBase).toEqual({ X: 'done' })
  })

  it('ein [scope+] einer NEUEN Aufnahme tilgt nichts', () => {
    // Der Normalfall des Nachtrags (#431): eine Base, die noch nie im Bereich stand, hat
    // keine Vergangenheit. Die Erweiterung des Zweigs darf diesen Weg nicht veraendern.
    const p = parseJobPhases('transcribe', [
      '[scope] A',
      '[Demo] fertig A: 3s, 4 Segmente, 1.0x',
      '[scope+] B',
      '[Demo] fertig B: 2s, 2 Segmente, 1.0x',
    ])
    expect(p.perBase).toEqual({ A: 'done', B: 'done' })
    expect(p.erreicht).toEqual({ A: 'raw', B: 'raw' })
  })
})

describe('laufOrdnung / warteKarte (#370, #442)', () => {
  it('EIN Schluessel fuer beide Laeufe — die Basen, wie beide Erzeuger sie sortieren', () => {
    // Hier stand ein Zwei-Schluessel-Entwurf: `base + "."` fuer transcribe, weil dessen
    // Schleife nach Dateiname MIT Endung sortierte. Das war fuer `Interview` / `Interview-2`
    // richtig und fuer jede Base MIT PUNKT falsch — nachgerechnet laufen `Aufnahme.wav` und
    // `Aufnahme.1.wav` als `Aufnahme.1`, `Aufnahme`, der geratene Schluessel dreht sie um.
    // Behoben an der WURZEL: `transcribe.py` sortiert jetzt selbst nach der Base, `correct.py`
    // tat es ohnehin. Die Oberflaeche raet nichts mehr.
    expect(laufOrdnung(['Interview-2', 'Interview'])).toEqual(['Interview', 'Interview-2'])
    expect(laufOrdnung(['Aufnahme.1', 'Aufnahme'])).toEqual(['Aufnahme', 'Aufnahme.1'])
  })

  it('unter dem Zeilendeckel zaehlt eine FERTIGE Aufnahme nicht mehr als wartend', () => {
    // `fuege_zeile_an` verdraengt bei MAX_JOB_LINES aus der MITTE (an einem echten Lauf sind
    // 10.560 Zeilen gemessen, #475) — genau die `fertig X:`-Zeilen frueher Aufnahmen fallen
    // heraus. Allein an `perBase` gemessen bekaemen A und B „Wartet auf Transkription", und D
    // stuende auf „noch 3" statt „noch 1": aus einem fehlenden Etikett wuerde eine falsche
    // Zahl. Der Rueckweg ist die Serverbuchfuehrung `gesehen` (vierter Parameter), die den
    // Deckel ueberlebt.
    const gedeckelt = parseJobPhases('transcribe',
      ['[scope] A\tB\tC\tD', '[active] C', '[Demo] -> transkribiere C …'], ['A', 'B', 'C'])
    expect(gedeckelt.perBase).toEqual({})           // die Urteile sind aus dem Puffer gefallen
    const karte = warteKarte(gedeckelt, 'transcribe')
    expect(Object.keys(karte).sort()).toEqual(['C', 'D'])   // A und B sind durch, nicht wartend
    // C ist die LAUFENDE Datei: sie gehoert in die Menge (sie liegt vor D), zeigt aber nie
    // eine Wartezeile — die Pille prueft die aktive Phase vor dem Wartezweig.
    expect(karte.D).toEqual({ art: 'transcribe', vor: 1 })
  })

  it('im correct-Lauf gilt der Rueckweg NICHT — dort meldet das Glossar korpusweit', () => {
    // Die Gegenrichtung, und ohne sie waere der Riegel oben ein Totalausfall: seit #450 druckt
    // der Glossar-Schritt `[active]` fuer JEDE Aufnahme des Korpus. Auf `correct` angewandt
    // waere damit alles „schon durch" und die Karte bliebe fuer immer leer.
    const p = parseJobPhases('correct', ['[scope] A\tB\tC'], ['A', 'B', 'C'])
    expect(warteKarte(p, 'correct')).toEqual({ A: { art: 'correct', vor: 0 },
                                               B: { art: 'correct', vor: 1 },
                                               C: { art: 'correct', vor: 2 } })
  })

  it('die Zahl kommt aus der LAUFordnung, nicht aus der Reihenfolge des Bereichs', () => {
    // Der Befund des kalten Plan-Reviewers, als Zusicherung: eine waehrend des Laufs
    // hochgeladene Aufnahme haengt der Parser per `[scope+]` ans ENDE der Menge, der Lauf
    // sortiert sie aber ein. Aus der Mengenreihenfolge gerechnet waere die Zahl fuer beide
    // falsch — fuer die Nachzuegler-Datei zu gross, fuer ihre Nachbarin zu klein.
    const phasen = parseJobPhases('transcribe', ['[scope] B\tZ', '[Demo] fertig B: 1s', '[scope+] A'])
    expect([...(phasen.scope ?? [])]).toEqual(['B', 'Z', 'A'])   // Mengenreihenfolge: A hinten
    expect(warteKarte(phasen, 'transcribe')).toEqual({ A: { art: 'transcribe', vor: 0 },
                                                      Z: { art: 'transcribe', vor: 1 } })
  })

  it('eine Aufnahme mit Endurteil liegt vor niemandem mehr', () => {
    const phasen = parseJobPhases('correct', ['[scope] A\tB\tC', 'apply: A -> edit.json + md (3 Segmente)'])
    expect(warteKarte(phasen, 'correct')).toEqual({ B: { art: 'correct', vor: 0 },
                                                   C: { art: 'correct', vor: 1 } })
  })

  it('die LAUFENDE Datei zaehlt mit — sie liegt vor den wartenden', () => {
    const phasen = parseJobPhases('correct', ['[scope] A\tB', '→ Korrigiere A …'])
    expect(warteKarte(phasen, 'correct').B).toEqual({ art: 'correct', vor: 1 })
  })

  it('eine GELOESCHTE Aufnahme verlaengert die Schlange der uebrigen nicht', () => {
    // `terminal()` unterdrueckt das Urteil einer geloeschten Aufnahme (#479/#489) — richtig,
    // die Datei gibt es nicht mehr. Ohne den eigenen Riegel lese die Karte diese Abwesenheit
    // als „steht noch aus": das Loeschen EINER fertigen Aufnahme machte die Warteschlange
    // aller uebrigen um eins laenger, und zwar dauerhaft (A ist in `processed`, wird nie
    // re-annonciert). Gefunden von der Was-erlaubt-Linse, am echten Parser gemessen.
    const p = parseJobPhases('correct', ['[scope] A\tB\tC'], undefined, ['A'])
    expect(warteKarte(p, 'correct')).toEqual({ B: { art: 'correct', vor: 0 },
                                               C: { art: 'correct', vor: 1 } })
  })

  it('ein Basisname wie constructor bringt den Parser nicht zu Fall', () => {
    // `safe_name` laesst `constructor`, `toString`, `valueOf` durch. In einem gewoehnlichen
    // Objekt findet `blocks['constructor']` den PROTOTYP — truthy, aber ohne `done`, und
    // `prog()` wirft.
    //
    // GEMESSEN ist der WURF: `blocks` zurueck auf `{}` gesetzt (Mutation M16) macht genau
    // diesen Test rot, mit `TypeError: Cannot read properties of undefined (reading 'size')`.
    // HERGELEITET, nicht gemessen, ist die FOLGE: `parseJobPhases` wird in
    // `JobProvider.tick()` ohne eigenes try/catch gerufen, und der naechste `setTimeout` steht
    // dahinter — daraus folgt gelesen, dass das Polling aller Jobs des Projekts stehenbliebe.
    // Ein Test dafuer muesste den Provider mit einer solchen Aufnahme laufen lassen und das
    // AUSBLEIBEN weiterer Abfragen zeigen; das ist nicht gebaut.
    // Vorbestehend, gefunden vom kalten Diff-Leser.
    expect(() => parseJobPhases('correct',
      ['[scope] constructor\tB', '→ Korrigiere constructor · Block 1/2 …'])).not.toThrow()
  })

  it('ohne Bereich und fuer den URL-Import entsteht gar keine Karte', () => {
    // Beide Rueckfaelle sind die sichere Richtung: `imBereich` liest ein fehlendes `scope`
    // als „gilt fuer alle", daraus liesse sich nur eine geratene Zahl bilden; und der
    // URL-Import kennt ueberhaupt keine Basisnamen.
    expect(warteKarte(parseJobPhases('transcribe', ['[Demo] -> transkribiere A …']), 'transcribe')).toEqual({})
    expect(warteKarte(parseJobPhases('fetch', ['[scope] A\tB']), 'fetch')).toEqual({})
  })
})
