# Version anzeigen und Updates mit sichtbarem Fortschritt

**Stand:** 2026-08-08 · Ausgangsversion 0.2.1

## Problem

Die App zeigt ihre Version nirgends an. Wer wissen will, welche Fassung läuft, muss den
Installer suchen oder ins Protokoll schauen.

Das Update läuft heute unsichtbar: `main.js` prüft beim Start, `electron-updater` lädt bei
einem Treffer **stillschweigend rund 100 MB** (`autoDownload` ist Vorgabe), und erst danach
erscheint ein Dialog. Wer den wegklickt, findet ihn nie wieder. Schlägt etwas fehl, steht es
nur im Protokoll — der Nutzer sieht nichts.

## Ziel

In den Einstellungen der Weboberfläche steht die laufende Version, daneben der Zustand des
Updates: geprüft, verfügbar, ladend (mit Prozent, MB und Tempo), bereit, fehlgeschlagen oder
auf dieser Plattform nicht möglich. Der Download startet erst auf Klick.

## Entscheidungen

| Frage | Entscheidung | Grund |
|---|---|---|
| Ort | Einstellungsseite der Weboberfläche (`/einstellungen`) | Dorthin schaut der Nutzer ohnehin; die Electron-Statusseite verschwindet nach dem Start und ist danach unerreichbar. |
| Auslöser | Prüfung automatisch beim Start, **Download auf Klick** | 100 MB ungefragt über ein gedrosseltes Netz zu ziehen ist übergriffig. Die Prüfung selbst kostet nichts. |
| Transport | IPC über `preload.js` | Der Python-Server hat mit Updates nichts zu tun. Ein Umweg über HTTP wären zwei Hops innerhalb desselben Prozessbaums, durch ein Rohr, das es schon gibt. |
| Plattformen ohne Update | Version + Klartext-Grund + Link zur Release-Seite | Ein roter Fehler wäre irreführend — kaputt ist nichts. Ausblenden würde den Nutzer im Unklaren lassen, dass es überhaupt Updates gibt. |

## Architektur

```
electron/updater.js  (neu)
    autoUpdater-Ereignisse  ->  EIN Zustandsobjekt
      ├─ ipcMain 'update:status'        aktuellen Zustand holen
      ├─ ipcMain 'update:pruefen'       Prüfung anstossen
      ├─ ipcMain 'update:laden'         Download starten
      ├─ ipcMain 'update:installieren'  neu starten und installieren
      └─ senden('update', zustand)      Push bei jeder Änderung
                    ↓
             preload.js  (Kanal 'update' ergänzt)
                    ↓
      webtool/frontend/src/hooks/useUpdate.ts
                    ↓
             SettingsPage.tsx  →  Abschnitt „Version und Updates"
```

**Warum ein eigenes Modul:** `main.js` hält bereits Fenster, Backend, IPC und Protokoll
zusammen. Der Update-Teil wächst nun um Zustandsverwaltung und Fortschritt. Ausgelagert
bleibt `main.js` lesbar, und der Zustandsautomat ist ohne laufendes Electron prüfbar — wie
`setup.plan()` und `webtool/device.py` es vormachen.

**`preload.js`** bekommt vier Methoden und den Kanal `update` in die Erlaubnisliste. Die
Brücke hängt am Fenster, nicht an der Seite: `window.transkribor` steht damit auch der
React-Oberfläche zur Verfügung — aber nur, wenn sie in Electron läuft.

## Zustände

Ein Objekt, acht Zustände. Die Oberfläche bildet sie direkt ab; es gibt **keinen zweiten
Zustand im Frontend**, der auseinanderlaufen könnte.

| Zustand | Felder | Anzeige |
|---|---|---|
| `unbekannt` | — | nur Version, Knopf *Nach Updates suchen* (vor der ersten Prüfung) |
| `prueft` | — | „Wird geprüft …", Knopf gesperrt |
| `aktuell` | — | **Transkribor 0.2.1** · aktuell · Knopf *Nach Updates suchen* |
| `verfuegbar` | `version`, `groesse` | **0.3.0 verfügbar** · Knopf *Herunterladen (94 MB)* |
| `laedt` | `prozent`, `geladen`, `gesamt`, `tempo` | Balken · **43 % · 41 von 94 MB · 6,2 MB/s** |
| `bereit` | `version` | **0.3.0 ist bereit** · Knopf *Neu starten und installieren* |
| `fehler` | `text` | „Prüfung fehlgeschlagen" + Grund + *Protokoll öffnen* |
| `nicht_moeglich` | `grund` | Grund im Klartext + Link zur Release-Seite |

Die Fortschrittswerte stammen unverändert aus dem `download-progress`-Ereignis
(`percent`, `transferred`, `total`, `bytesPerSecond`), die Downloadgrösse aus
`UpdateInfo.files[0].size` des `update-available`-Ereignisses. **Keine Restzeit:** sie
schwankt bei einem 94-MB-Download so stark, dass sie mehr verunsichert als hilft.

`prueft` ist ein eigener Zustand und nicht bloss „noch nichts bekannt": nach einem
Fehlschlag drückt der Nutzer *Nach Updates suchen*, und ohne diese Unterscheidung sähe er
nicht, dass überhaupt etwas passiert.

### Wann `nicht_moeglich` gilt

Drei prüfbare Regeln, keine Vermutungen:

1. `!app.isPackaged` → „Entwicklungsmodus — Updates gibt es nur in der installierten App."
2. `process.platform === 'darwin'` → „Auf macOS nicht möglich, solange die App nicht
   notarisiert ist." Squirrel.Mac verlangt eine echte Signatur; ad-hoc genügt nicht.
3. `linux && !process.env.APPIMAGE` → „Nur die AppImage kann sich selbst aktualisieren."
   Die Variable setzt die AppImage-Laufzeit selbst; ein `.deb`-Start hat sie nicht, und
   `electron-updater` kennt für deb ohnehin keinen Weg.

## Verhaltensänderungen am Bestand

- **`autoDownload = false`.** Ohne das lädt `electron-updater` beim Prüfen sofort los und
  „erst auf Klick" wäre wirkungslos.
- **Der Dialog nach `update-downloaded` entfällt.** Der Zustand steht künftig an einem Ort
  statt in einem Popup, das man wegklickt und nicht wiederfindet.
- Der bestehende `error`-Listener bleibt: Fehler gehen **weiterhin ins Protokoll** und
  zusätzlich in den Zustand.

## Prüfungen

- `electron/updater.test.js` — Zustandsautomat gegen einen Attrappen-`autoUpdater`: jeder
  Übergang und die drei Plattformregeln. Ohne Electron, wie `setup.test.js`.
- `webtool/frontend/src/hooks/useUpdate.test.tsx` — der Hook, **einschliesslich des Falls
  ohne Electron**: im normalen Browser erscheint der Abschnitt nicht und nichts stürzt ab.
- `SettingsPage` — rendert jeden der acht Zustände.

## Bewusst nicht dabei

- **Versionsanzeige im reinen Browser.** Die Nummer kommt aus `app.getVersion()`; der
  Python-Server kennt sie nicht, weil im gepackten Zustand keine `package.json` neben ihm
  liegt. Ohne Electron bleibt der ganze Abschnitt unsichtbar — dort wäre er sinnlos.
- **Restzeit, Änderungsprotokoll im Dialog, Update-Kanäle (beta/stable).** Nichts davon
  löst ein Problem, das jemand hat.
- **Notarisierung.** Sie würde macOS-Updates erst ermöglichen, ist aber eine eigene
  Entscheidung mit eigenen Kosten (99 $/Jahr) und keine Frage der Oberfläche.
