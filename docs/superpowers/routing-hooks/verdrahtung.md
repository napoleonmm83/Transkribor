# Verdrahtung der Routing-Hooks

Die Skripte in diesem Ordner sind Kopien der produktiven Dateien — **sie tun von sich aus
nichts.** Was sie auslöst, steht in zwei `settings.json`, und die lagen bis zum
Abschlussreview in keiner Sicherung: ginge `~/.claude/` verloren, liesse sich aus dem Repo
alles wiederherstellen ausser der Zustellung. Diese Datei schliesst die Lücke.

Aufgenommen wird hier **nur der Routing-Anteil**. Beide `settings.json` tragen weitere Hooks,
Plugin-Schalter und Nutzereinstellungen, die mit diesem System nichts zu tun haben — eine
Vollkopie wäre eine zweite Quelle für fremden Zustand.

## Woher welche Datei kommt

| Kopie hier | Produktiv |
|---|---|
| `routing-sperre.sh`, `routing-sperre.test.sh`, `routing-lint.sh` | `$CLAUDE_PROJECT_DIR/.claude/hooks/` |
| `routing-tafel.sh`, `routing-tafel.test.sh` | `~/.claude/hooks/` |
| die Agentendateien und beide Tafeln | `docs/superpowers/routing-agenten/` (eigener Ordner) |

## 1. `~/.claude/settings.json` — die Tafel bei jedem Prompt

```json
"UserPromptSubmit": [
  {
    "matcher": "",
    "hooks": [
      { "type": "command", "command": "bash \"$HOME/.claude/hooks/routing-tafel.sh\"", "shell": "bash", "timeout": 5 }
    ]
  }
]
```

## 2. `$CLAUDE_PROJECT_DIR/.claude/settings.json` — die Sperre vor `gh pr create`

```json
"PreToolUse": [
  {
    "matcher": "Bash",
    "hooks": [
      { "type": "command", "command": "cd \"${CLAUDE_PROJECT_DIR:-E:/Git/Transkribor}\" && bash .claude/hooks/routing-sperre.sh", "timeout": 10 }
    ]
  },
  {
    "matcher": "PowerShell",
    "hooks": [
      { "type": "command", "command": "cd \"${CLAUDE_PROJECT_DIR:-E:/Git/Transkribor}\" && bash .claude/hooks/routing-sperre.sh", "timeout": 10 }
    ]
  }
]
```

(Der `Bash`-Block trägt produktiv noch zwei ältere Hooks desselben Projekts —
`kein-pauschales-add.sh` und `readme-pflicht.sh`. Sie gehören nicht zu diesem System und
stehen deshalb nicht hier.)

**Der zweite Matcher ist kein Zierrat.** Diese Umgebung hat zwei Shells, und die
Systembeschreibung nennt PowerShell als die *primäre*. Gemessen über alle
Sitzungstranskripte dieses Projekts: **23 von 187** `gh pr create` liefen über das
`PowerShell`-Werkzeug (letzter am 2026-08-15) — 12 % aller PR-Eröffnungen gingen am Wächter
vorbei, ohne Hinweis, ohne Meldung. Das Skript musste dafür **nicht** angefasst werden: es
liest Roh-JSON und ist damit shell-agnostisch; die reale Form
`Set-Location <pfad>; gh pr create --base master` trifft über den `;`-Anker (Prüfung 30 im
Selbsttest). Es fehlte allein die Verdrahtung.

**Die Matcher sind Reguläre Ausdrücke.** `"Bash"` trifft deshalb auch `BashOutput`, wo die
Prüfung gegenstandslos ist (sie läuft dort ins Leere und lässt durch). Bewusst nicht
verankert — so ist es an den beiden älteren Hooks seit jeher.

## Was hier NICHT geprüft wird

**Kein Selbsttest liest diese `settings.json`.** Fällt ein Eintrag heraus — Umsortierung,
Backup-Rückspiel, eine Hand —, bleiben alle Prüfungen grün und das System ist wirkungslos;
ein fehlendes Skript endet mit Exit 127, und ein 127 **blockiert nicht**. Das ist bekannt,
bewusst offen gelassen und liegt als eigenes Issue. Diese Datei ist die Sicherung, nicht die
Prüfung.

## Wiederherstellen

1. Skripte aus diesem Ordner an die Orte der Tabelle oben kopieren.
2. Die beiden JSON-Blöcke in die jeweilige `settings.json` einfügen (bestehende `hooks`-Einträge
   ergänzen, nicht ersetzen) und mit `node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' <datei>`
   nachprüfen — eine ungültige `settings.json` schaltet **alle** Hooks ab.
3. Selbsttests fahren: `bash .claude/hooks/routing-sperre.test.sh` und
   `bash ~/.claude/hooks/routing-tafel.test.sh` (beide `OK`), dazu
   `bash .claude/hooks/routing-lint.sh` (`Tafel sauber.`).
4. Neue Sitzung starten: eine mitten in der Sitzung angelegte `~/.claude/agents/`-Datei gilt
   nicht (siehe Spec §2), und die Tafel wird erst beim nächsten Prompt eingespielt.
