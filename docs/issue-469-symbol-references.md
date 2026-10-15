# Symbolverweise statt Zeilennummern (#469)

Erklärende Kommentare und Docstrings verweisen auf die zuständige Funktion,
Klasse oder Konstante. Einfügen von Quellzeilen verschiebt diese Verweise nicht
mehr. Die Bestandsaufnahme im Issue war keine Aussage, dass alle alten
Zeilenverweise falsch waren.

Die Ziele wurden am Quelltext geprüft. Beispielsweise druckt `correct.cmd_run`
die Phasenbilanz, während `correct.main` den Prozess bei Totalausfall beendet.
Der Upload-Nachlauf führt über `app.upload_audio` und `app._start_transcribe` zu
`jobs.request`. Beim blockierten URL-Import lässt
`app._fetch_starten_unter_projektlebenszyklus` die Vorgangsnummer in der Antwort
weg; ein erfolgreich gestarteter Import hat dagegen eine Nummer.

## Fremdpakete

Die Versionen wurden am 2026-10-04 aus lokalem `METADATA` gelesen; die Symbole
und beschriebenen Zweige wurden in den zugehörigen Paketquellen geprüft.
Das bestätigt die Quellstellen, wiederholt aber keine historischen Audio- oder
Plattformmessungen aus den Kommentaren.

| Paketversion | Zuständige Symbole |
| --- | --- |
| faster-whisper 1.2.1 | `faster_whisper.transcribe.WhisperModel.generate_segments` |
| pyannote-audio 4.0.7 | `pyannote.audio.pipelines.clustering.VBxClustering.__call__`, `BaseClustering.filter_embeddings` und die Modulbindung `cluster_vbx` |
| pyannote-audio 4.0.7 | `pyannote.audio.pipelines.speaker_diarization.SpeakerDiarization.apply` |
| pyannote-audio 4.0.7 | `pyannote.audio.core.io.TORCHCODEC_AVAILABLE` und `pyannote.audio.pipelines.utils.diarization.set_num_speakers` |
| yt-dlp 2026.8.19 | `yt_dlp.utils._utils.Popen` |
| mutmut 3.7.0 | `mutmut.__main__.PytestRunner.execute_pytest` |

Die ersten Pakete lagen in der Haupt-venv. Die mutmut-Quelle lag in der
vorhandenen venv des Arbeitsbaums `release-058`; die Version entspricht dem
Projektpin. Die Änderung aktualisiert keine Abhängigkeit.

## Absichtlich erhaltene Koordinaten

Diagnostikbeispiele und Testdaten behalten ihre Positionsangaben: etwa
`x.py:1`, mypy-/ruff-Ausgaben und echte Warnzeilen aus Torch/Whisper. Auch der
ausführbare `notiz`-String im Phaseninventar bleibt erhalten. Seine Änderung
wäre eine Änderung der Testdaten. Historische Issue- und Commitnummern bleiben
ebenfalls erhalten.

## Prüfung

- Python: AST vor/nach der Änderung verglichen, ausschließlich Docstrings
  ausgeblendet; ausführbare Knoten und sonstige Strings sind gleich.
- TypeScript/JSX: mit dem vorhandenen `@babel/parser` geparst und Tokens ohne
  Kommentare vor/nach verglichen; ausführbare Strings und Testdaten sind gleich.
- Negativkontrollen: eine Änderung eines ausführbaren Strings wird von beiden
  Vergleichsprüfungen erkannt.
- `python -m pytest scripts/test_mutationsplaene.py webtool/test_diarize.py
  webtool/test_druck.py -q --basetemp .tmp-issue469/pytest-temp`: bestanden.
- `git diff --check`: bestanden. Unabhängiger Quell- und Diff-Review durchgeführt.

Die AST-/Tokenprüfungen ersetzen hier einen neuen Test für eine reine
Kommentaränderung. Es wurden keine Laufzeitfunktion und keine Fixture geändert.
