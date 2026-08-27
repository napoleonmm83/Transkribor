import { describe, it, expect } from 'vitest'
import { describePhases, parseJobPhases } from './jobPhases'

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
    // ergaeben. `0/2` und nicht `1/2`, obwohl Block 1 fertig gemeldet ist: `prog()` wird beim
    // Betreten der Phase ausgewertet (`→ Korrigiere`), ein spaeteres `✓ fertig` rechnet den
    // Eintrag nicht nach. Beim Messen dieses Tests aufgefallen — hier festgehalten, damit der
    // naechste Leser es nicht fuer einen Tippfehler haelt.
    expect(parseJobPhases('correct', mit).active).toEqual({ A: { phase: 'correct', pct: 0, detail: '0/2 Blöcke' } })
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
  it('aktive + fertige + skip', () => {
    const p = parseJobPhases('transcribe', [
      '[Demo] Modell large-v3, 3 Datei(en)',
      '[Demo] -> transkribiere A …', '[Demo] fertig A: 12s, 40 Segmente, Audio 2:00, 10.0x',
      '[Demo] skip (vorhanden): B', '[Demo] -> transkribiere C …',
    ])
    expect(p.active).toEqual({ C: { phase: 'transcribe' } })
    expect(p.perBase).toEqual({ A: 'done', B: 'skipped' })
  })
  it('ignoriert skip (vorhanden) fuer Dateien ausserhalb des Scopes', () => {
    const p = parseJobPhases('transcribe', [
      '[scope] B',
      '[Demo] skip (vorhanden): A',
      '[Demo] -> transkribiere B …',
      '[Demo] skip (vorhanden): C',
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
      '[fetch] skip (vorhanden): audio_02',
      '[fetch] FEHLER audio_03: broken pipe',
    ])
    expect(p.perBase).toEqual({ audio_01: 'done', audio_02: 'skipped', audio_03: 'failed' })
    expect(p.global).toBeNull()
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
    // Der $-verankerte Traeger ist BEWUSST `skip (Audio nicht mehr vorhanden)` und nicht
    // `skip (vorhanden)`: letzteres druckt seit dem gestaffelten Lauf niemand mehr, ein Test
    // darauf sicherte die Eigenschaft ueber einen Kanal, den es nicht gibt.
    const p = parseJobPhases('transcribe', [
      '[P] skip (Audio nicht mehr vorhanden): Interview ',
      '[P] fertig Interview : 3s, 4 Segmente, 1.0x',
    ])
    expect(Object.keys(p.perBase)).toEqual(['Interview '])
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
