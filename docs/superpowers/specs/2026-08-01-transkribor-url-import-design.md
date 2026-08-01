# Transkribor — URL-Import (YouTube + Instagram Reels) (Design)

Datum: 2026-08-01
Status: entworfen, freigegeben
Betrifft: `transcribe.py`, `webtool/fetch.py` (neu), `webtool/app.py`, `webtool/frontend/`

---

## 1 · Problem & Ziel

Audio kommt heute nur über Drag & Drop bzw. `POST /api/projects/{p}/audio` ins Projekt.
Interviewmaterial liegt aber oft als **YouTube-Video** oder **Instagram-Reel** vor; es
manuell herunterzuladen und umzuwandeln ist ein Medienbruch.

**Ziel:** URL(s) einfügen → Tonspur landet im Projekt → genau diese Datei(en) werden
transkribiert. Alles danach (Diarisierung, Korrektur, Editor) bleibt unverändert.

**Nicht-Ziel:** Playlists, Login-pflichtige/private Inhalte, weitere Plattformen,
Behalten der Videospur.

## 2 · Kernidee

Die Pipeline endet heute schon bei „Audiodatei liegt in `projekte/<P>/audio/`".
Der URL-Import ist damit **kein neuer Pfad, sondern eine zweite Quelle für denselben
Schreibpfad**. `transcribe.py`, `correct.py`, `diarize.py` und der Editor werden nicht
angefasst — bis auf eine Ausnahme (§4).

```
URL(s) ──► POST /api/projects/{p}/fetch ──► jobs.start(kind="transcribe")
                                              │
                                              ▼
                                   python -m webtool.fetch <projekt> <url…>
                                              │
                        ┌─────────────────────┴──────────────────────┐
                        │ pro URL: yt-dlp → m4a nach audio/          │
                        │          Basisnamen sammeln                │
                        └─────────────────────┬──────────────────────┘
                                              ▼
                            transcribe_project(projekt, only=[bases])
```

## 3 · `webtool/fetch.py` (neu)

CLI: `python -m webtool.fetch <projekt> <url> [<url> …]`, `cwd` = Repo-Root
(damit `import transcribe` greift, wie bei `correct.py`).

Ablauf je URL:

1. **Host prüfen** (Defense in Depth, zweite Instanz nach dem Endpoint) —
   nur `https` und Host in `{youtube.com, www.youtube.com, m.youtube.com, youtu.be,
   instagram.com, www.instagram.com}`.
2. **Metadaten holen** (`YoutubeDL.extract_info(url, download=False)`) → Titel.
3. **Basisnamen ableiten** (§3.1).
4. **Herunterladen** mit `format="bestaudio[ext=m4a]/bestaudio"` und
   `FFmpegExtractAudio(preferredcodec="m4a")`, `outtmpl` → `projekte/<P>/audio/<base>.%(ext)s`.
   **Warum m4a:** `.m4a` steht bereits in `AUDIO_EXT` (`app.py:19`, `transcribe.py:20`) und
   spielt im Browser-Player. YouTubes Default `bestaudio` ist Opus-in-`.webm` — das würde
   `find_audio()` und den Player brechen.
5. **Fortschritt** als stdout-Zeilen im Projektschema (`[fetch] …`), wie überall sonst.

Nach der Schleife: `transcribe_project(projekt, model, language, only=bases)` —
nur wenn `bases` nicht leer ist.

### 3.1 Titel → Basisname

Der Basisname ist die Trust-Boundary zu `paths.safe_name()` **und** der Text, den
Marcus später in der Dateiliste sieht. Ableitung:

- Zeichen entfernen/ersetzen, die `safe_name()` ablehnt: `/ \ : ..` sowie NUL
- Steuerzeichen und für Windows unzulässige Zeichen (`< > " | ? *`) entfernen
- Umlaute/ß bleiben erhalten (lesbar; das Dateisystem ist NTFS/UTF-8)
- Mehrfach-Leerzeichen kollabieren, an den Rändern trimmen
- auf 80 Zeichen kürzen
- leeres Ergebnis (z. B. rein emoji-Titel) → Fallback `<plattform>-<video-id>`
- Kollision im `audio/`-Verzeichnis → Suffix `-2`, `-3`, …

Das Ergebnis wird abschließend durch `paths.safe_name()` geschickt; wirft das trotzdem,
ist es ein Bug, kein erwarteter Fall.

### 3.2 Fehlerfälle

| Fall | Verhalten |
|---|---|
| Reel privat / Login nötig | Zeile „`[fetch] FEHLER <url>: Video ist nicht öffentlich abrufbar (Login nötig)`", weiter mit nächster URL |
| Host nicht in der Whitelist | Endpoint antwortet 400, kein Job |
| yt-dlp veraltet (Instagram ändert sich häufig) | Fehlerzeile inkl. yt-dlp-Meldung + Hinweis `pip install -U yt-dlp` |
| **alle** URLs fehlgeschlagen | Exit-Code 1 → Job-Status `error`, Whisper wird nicht geladen |
| einzelne URLs fehlgeschlagen | Exit-Code 0, die erfolgreichen werden transkribiert |
| Zieldatei existiert bereits | Suffix `-2` (kein Abbruch, keine Überschreibung) |

## 4 · `transcribe.py` — Datei-Filter (die einzige Änderung außerhalb des neuen Codes)

Heute transkribiert `transcribe_project()` **alles** im Projekt. Beim URL-Import wäre das
ein unerwünschter Nebeneffekt: ein eingefügtes Reel würde alte, absichtlich liegen
gelassene Dateien mit-transkribieren und die GPU binden.

```python
def transcribe_project(name, model, language, only=None):
    ...
    files = find_audio(proj_dir)
    if only is not None:                       # nur diese Basisnamen (URL-Import)
        files = [f for f in files
                 if os.path.splitext(os.path.basename(f))[0] in set(only)]
```

- Eingefügt direkt nach `find_audio()`, also **vor** dem bestehenden `if not files`-Guard
  (`transcribe.py:70`) und damit vor `whisper.load_model()`: eine leer gefilterte Liste
  steigt wie bisher mit einer Meldung aus, statt 3 GB VRAM für nichts zu laden.
- Default `None` = bisheriges Verhalten. Der „Transkribieren"-Button bleibt bewusst
  projektweit.
- Kein neuer CLI-Schalter: einziger Aufrufer ist `fetch.py` per Import. (Nachrüstbar,
  falls die Kommandozeile das je braucht.)

## 5 · Backend-Endpoint

```
POST /api/projects/{project}/fetch
Body: { "urls": ["https://…", "https://…"] }
→ { "job_id": "...", "started": true }
```

- `_validate(project)` wie bei den übrigen Endpoints
- `urls`: nichtleer, max. 20 Einträge, jede einzeln gegen Schema+Host-Whitelist geprüft;
  ungültig → 400 mit Nennung der beanstandeten URL
- `jobs.start(project, [sys.executable, "-m", "webtool.fetch", project, *urls],
  cwd=ROOT, kind="transcribe")`

**Warum `kind="transcribe"`:** erbt unverändert die Ein-Job-pro-Projekt-Dedupe, die
Einzel-GPU-Serialisierung (`GPU_KINDS`), `cancel` samt Prozessbaum-Kill und die
Reload-Discovery über `active_for()`. `jobs.py` wird nicht angefasst.

## 6 · Frontend

| Datei | Änderung |
|---|---|
| `components/UrlFetch.tsx` (neu) | `<textarea>` (eine URL pro Zeile) + Button „Holen"; leere Zeilen werden verworfen |
| `lib/api.ts` | `fetchUrls(project, urls): Promise<StartJob>` |
| `lib/jobPhases.ts` | globale Phase `download` aus `[fetch] …`-Zeilen |
| `pages/ProjectWorkspace.tsx` | `<UrlFetch>` unter der Dropzone; `startJob(…, 'transcribe', 'Herunterladen')`; `GLOBAL_LABEL.download = 'Herunterladen…'` |

Statuspille, „Abbrechen" und Reload-Robustheit funktionieren ohne Zutun, weil es ein
gewöhnlicher Job ist.

## 7 · Abhängigkeit

`yt-dlp` neu im `.venv`. Unvermeidbar — die Extraktion von YouTube/Instagram ist nichts,
was ein paar Zeilen selbst leisten. ffmpeg ist bereits Voraussetzung
(`transcribe.py:ensure_ffmpeg`) und wird für die m4a-Extraktion mitbenutzt.

Das Repo hat **keine `requirements.txt`** (torch cu128 hängt an einem Custom-Index; die
Umgebung ist in `CLAUDE.md` unter „Umgebung (Fakten)" beschrieben). Der URL-Import führt
deshalb keine Manifest-Datei ein, sondern folgt dem Muster von pyannote:
`.venv\Scripts\pip install yt-dlp` plus eine Zeile in `CLAUDE.md`.

**Instagram altert schnell:** yt-dlp-Extraktoren brechen dort regelmäßig. Deshalb enthält
die Fehlermeldung bei nicht-Login-Fehlern den Hinweis `pip install -U yt-dlp` — das ist in
der Praxis der häufigste Fix.

## 8 · Tests (`webtool/test_fetch.py`)

Ohne Netzwerk, yt-dlp gemockt:

1. Titel → Basisname: Sonderzeichen, `..`, Pfadtrenner, Überlänge, Emoji-Fallback
2. Kollision → `-2`
3. Host-Whitelist: erlaubte Hosts, `http://`, fremder Host, `file://`
4. Alle URLs fehlgeschlagen → Exit 1 und `transcribe_project` wird **nicht** aufgerufen
5. Teilweiser Fehlschlag → `transcribe_project` wird mit genau den erfolgreichen Bases aufgerufen

Ergänzend in `test_api.py`: `POST …/fetch` mit ungültiger URL → 400.

## 9 · Bewusst weggelassen

| Weggelassen | Nachrüsten, wenn |
|---|---|
| Playlist-Import | Marcus regelmäßig ganze Kanäle braucht — dann eine Schleife in `fetch.py` |
| Cookie-/Login-Support | private Reels tatsächlich anfallen (`--cookies-from-browser` oder Pfad in `.env`) |
| TikTok, X, Vimeo | konkreter Bedarf; yt-dlp kann sie, es ist nur die Whitelist |
| Video behalten | jemand das Bild braucht |
| Fortschritt in Prozent | die Textzeilen im Job-Log nicht mehr reichen |

## 10 · Implementierungs-Reihenfolge

1. `transcribe.py`: Parameter `only` + Test
2. `webtool/fetch.py` inkl. Basisnamen-Ableitung + `test_fetch.py`
3. `requirements.txt`: `yt-dlp`
4. `app.py`: `POST /api/projects/{project}/fetch` + Test
5. Frontend: `api.ts`, `jobPhases.ts`, `UrlFetch.tsx`, `ProjectWorkspace.tsx`
6. End-to-End mit einem echten öffentlichen YouTube-Video und einem öffentlichen Reel
7. `CLAUDE.md` um den URL-Import ergänzen
