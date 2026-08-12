# Plan — `sprache`-Validierung an Upload + Fetch (#143)

**Issue:** #143 — `upload_audio`/`fetch` schreiben `sprache` ohne Validierung (gleiche Klasse wie #139)
**Spec:** `2026-08-12-transkribor-einstellungs-validierung-design.md` (#139) — dieser Plan wendet deren Entwurf an, er findet keinen neuen.

## Problem

#139 hat `sprachen.pruef_fehler(sprache, korrektur)` eingeführt und an **beide** Einstellungs-PUTs
gebunden (`app.py` Zeile 245, 274). Unbekannte Werte → 400 mit Feldname im `detail`.

Zwei weitere Schreibpfade übernehmen `sprache` weiterhin **ungeprüft**:

- `POST /api/projects/{p}/audio` (`upload_audio`, app.py:752) — `sprache: str = Form(None)`,
  geschrieben via `_projekt.setze_datei(...)` (app.py:770), sobald wahrheitsgemäss.
- `POST /api/projects/{p}/fetch` (`fetch_urls`, app.py:609) — `body.sprache`, gefädelt in die
  Subprozess-Env `TRANSKRIBOR_FETCH_SPRACHE` (app.py:627); `fetch.py` trägt es später ein.

Eine ungültige Sprache — vom Frontend nicht wählbar, aber per Roh-POST/ungeeignetem Client
möglich — gelangt so ins System. #139 schloss die PUT-Tür, diese beiden Fenster stehen offen.

## Entwurfsentscheidung: Endpoint-Prüfung, nicht zentral in `setze_datei`

Ponytail-Reflex wäre: statt in jedem Handler die Prüfung zu wiederholen, **einmal** in
`_projekt.setze_datei`/`speichern`. **Hier verworfen**, zwei gemessene Gründe:

1. **Upload schreibt die Datei, bevor `setze_datei` läuft.** Validierung erst beim Schreiben
   ließe bei 400 eine Audio-Datei auf der Platz zurück — orphan. Die Prüfung muss **vor** dem
   Datei-Schreiben sitzen (neben den anderen 400-Checks), also am Handler.
2. **Fetch reicht `sprache` durch eine Env-Variable an den fetch-Job.** Validierung erst in
   `fetch.py`/`setze_datei` hieße: der Download läuft erst, scheitert dann mid-Job. Am Endpoint
   geprüft, kommt sofort 400 zurück, bevor ein Job startet.

Ein zentraler Wächter würde zusätzlich die Endpoint-Prüfung brauchen (die wegen der
Nebenwirkungen bleiben muss) — wäre eine zusätzliche Schicht, keine ersetzende. #139's Entwurf
(Prüfung am Handler) ist also richtig; #143 spiegelt ihn.

## Änderung

In beiden Handlern, nach den bestehenden 400-Checks, vor dem Schreiben/Env-Bauen:

```python
fehler = _sprachen.pruef_fehler(sprache=<das sprache-Argument des Handlers>)
if fehler:
    raise HTTPException(status_code=400, detail=fehler)
```

- `pruef_fehler(sprache=None)` → `None` (No-Op): bedingungslos aufrufbar, ändert nichts am
  Legacy-Fall „kein Feld gesendet".
- Nur `sprache` — weder Pfad nimmt `korrektur` an.
- `400` (nicht 422): Konsistenz mit #139 und `_validate` in denselben Handlern.
- Upload: Prüfung **vor** `os.makedirs`/Datei-Schreiben (orphan-Vermeidung, siehe oben).

## Tasks

1. **TDD rot** — zwei Tests in `webtool/test_api.py`, Spiegel der #139-Tests (Zeile 1025ff):
   - `test_upload_lehnt_unbekannte_sprache_ab`: `POST …/audio` mit `data={"sprache": "enm"}` → 400, `"Sprache" in detail`. Datei darf **nicht** auf der Platte liegen (orphan-Check).
   - `test_fetch_lehnt_unbekannte_sprache_ab`: `POST …/fetch` mit `{"urls":[…], "sprache":"enm"}` → 400, `"Sprache" in detail`. Job darf **nicht** gestartet werden (monkeypatch `jobs.start`).
2. **Implement** — `pruef_fehler`-Guard in `upload_audio` und `fetch_urls`.
3. **TDD grün** + volle Suite.
4. **Review** — Subagent (CodeRabbit evtl. rate-limited, siehe Memory).
5. **PR + Merge** — Standard-Flow, `--rebase --delete-branch`, master fast-forward.
6. **Aufräumen** — #143 schließen; Memory nachziehen. README braucht keinen Strich: die UI
   bot ungültige Sprachen nie an, geschlossen wird eine Back-End-Lücke, keine Bedienänderung.

## Nicht issue-würdig / bewusst nicht getan

- Zentrale Wächter in `setze_datei`/`speichern` (siehe Entwurfsentscheidung).
- `fetch.py`-seitige Prüfung des env-Werts — doppelt und spät (Endpoint prüft früh).
- README-Änderung (keine Nutzersicht-Änderung).
