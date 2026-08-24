#!/usr/bin/env python3
"""Prüft nachhaltig und autonom den Status von CodeRabbit auf Pull Requests.

Funktionen:
- Erkennt, ob CodeRabbit rate-limited ist (inkl. verbleibender Wartezeit in Minuten).
- Erkennt, ob CodeRabbit noch aktiv prüft (Check-Run / Review in Progress).
- Erkennt, ob CodeRabbit fertig ist, und extrahiert:
  - Konkrete Inline-Review-Befunde (Datei, Zeile, Titel, Text, AI-Prompt)
  - Pre-Merge-Check Warnungen & Fehlversuche (z.B. README-Aktualisierung, Messungsbelege)
  - Zusammenfassung und Handlungsanweisungen.

Nutzung:
    python3 scripts/coderabbit_status.py [PR_NUMMER] [--json]
"""
import argparse
import json
import re
import subprocess
import sys


def analyze_coderabbit(pr_info: dict, inline_comments: list) -> dict:
    """Klassifiziert den aktuellen Zustand von CodeRabbit anhand der PR-Kommentare und Checks."""
    comments = pr_info.get("comments", []) or []
    checks = pr_info.get("statusCheckRollup", []) or []

    # 1. Prüfen auf Rate-Limit
    for c in comments:
        author = c.get("author", {}).get("login", "")
        if "coderabbit" in author.lower():
            body = c.get("body", "")
            if "rate limited by coderabbit.ai" in body or "Review limit reached" in body:
                wait_match = re.search(r"Next included review available in (\d+)\s+minutes", body, re.IGNORECASE)
                wait_min = int(wait_match.group(1)) if wait_match else None
                msg = f"CodeRabbit ist rate-limited. Nächster Review verfügbar in {wait_min} Minuten." if wait_min else "CodeRabbit ist rate-limited."
                return {
                    "status": "RATE_LIMITED",
                    "rate_limited": True,
                    "in_progress": False,
                    "wait_minutes": wait_min,
                    "message": msg,
                    "actionable_comments": [],
                    "failed_pre_merge_checks": [],
                }

    # 2. Prüfen auf laufenden Check / Review
    for chk in checks:
        name = chk.get("name", "") or chk.get("context", "")
        if "coderabbit" in name.lower():
            state = (chk.get("status") or chk.get("state") or "").upper()
            if state in ("IN_PROGRESS", "QUEUED", "PENDING"):
                return {
                    "status": "IN_PROGRESS",
                    "rate_limited": False,
                    "in_progress": True,
                    "wait_minutes": None,
                    "message": "CodeRabbit prüft den PR aktuell noch (Review läuft)...",
                    "actionable_comments": [],
                    "failed_pre_merge_checks": [],
                }

    # 3. CodeRabbit abgeschlossen: Befunde und Pre-Merge Checks extrahieren
    failed_checks = []
    for c in comments:
        author = c.get("author", {}).get("login", "")
        if "coderabbit" not in author.lower():
            continue
        body = c.get("body", "")
        if "Pre-merge checks" in body and "Failed checks" in body:
            # Tabelle extrahieren
            lines = body.splitlines()
            in_table = False
            for line in lines:
                if "Failed checks" in line:
                    in_table = True
                    continue
                if in_table:
                    if line.startswith("|") and not re.search(r"^\|\s*(Check name|:?-+:?)\s*\|", line, re.IGNORECASE):
                        parts = [p.strip() for p in line.split("|") if p.strip()]
                        if len(parts) >= 4 and parts[0].lower() != "check name":
                            failed_checks.append({
                                "name": parts[0],
                                "status": parts[1],
                                "explanation": parts[2],
                                "resolution": parts[3],
                            })
                    elif line.startswith("<details>") or line.startswith("</details>") or line.startswith("### ✅"):
                        in_table = False

    actionable = []
    for c in inline_comments:
        author = c.get("user", {}).get("login", "") or c.get("author", {}).get("login", "")
        if "coderabbit" not in author.lower():
            continue
        body = c.get("body", "")
        # Titel aus **...** extrahieren
        title_match = re.search(r"\*\*(.*?)\*\*", body)
        title = title_match.group(1) if title_match else body.splitlines()[0] if body else ""
        actionable.append({
            "id": c.get("id"),
            "path": c.get("path"),
            "line": c.get("line"),
            "title": title,
            "body": body,
        })

    has_activity = bool(actionable or failed_checks or any("coderabbit" in (c.get("author", {}).get("login", "").lower()) for c in comments))

    return {
        "status": "COMPLETED" if has_activity else "NOT_STARTED",
        "rate_limited": False,
        "in_progress": False,
        "wait_minutes": None,
        "message": f"CodeRabbit Review abgeschlossen ({len(actionable)} Befunde, {len(failed_checks)} Pre-Merge Warnungen)." if has_activity else "Noch keine CodeRabbit Aktivität gefunden.",
        "actionable_comments": actionable,
        "failed_pre_merge_checks": failed_checks,
    }


def fetch_pr_info(pr_num: int | None = None) -> tuple[dict, list]:
    """Holt PR-Details und Inline-Kommentare über das GitHub CLI (gh)."""
    target = [str(pr_num)] if pr_num else []
    view_cmd = ["gh", "pr", "view"] + target + ["--json", "number,title,state,headRefName,statusCheckRollup,comments"]
    res = subprocess.run(view_cmd, capture_output=True, text=True, check=True)
    pr_data = json.loads(res.stdout)

    actual_num = pr_data["number"]
    # Inline comments abfragen
    api_cmd = ["gh", "api", f"repos/:owner/:repo/pulls/{actual_num}/comments"]
    api_res = subprocess.run(api_cmd, capture_output=True, text=True, check=True)
    inline_comments = json.loads(api_res.stdout) if api_res.stdout.strip() else []

    return pr_data, inline_comments


def format_report(pr_data: dict, analysis: dict) -> str:
    """Formatiert das Ergebnis menschenlesbar für das Terminal."""
    lines = []
    lines.append(f"🐰 CodeRabbit Status für PR #{pr_data.get('number')} ({pr_data.get('title')})")
    lines.append(f"Status: {analysis['status']}")
    lines.append(f"Meldung: {analysis['message']}\n")

    if analysis["rate_limited"]:
        if analysis["wait_minutes"] is None:
            lines.append("⏳ RATE LIMITED: Die verbleibende Wartezeit ist nicht verfügbar.")
        else:
            lines.append(f"⏳ RATE LIMITED: Bitte ca. {analysis['wait_minutes']} Minuten warten.")
        return "\n".join(lines)

    if analysis["in_progress"]:
        lines.append("🔄 Prüfung läuft noch im Hintergrund...")
        return "\n".join(lines)

    if analysis["failed_pre_merge_checks"]:
        lines.append("⚠️ Pre-Merge Check Warnungen:")
        for chk in analysis["failed_pre_merge_checks"]:
            lines.append(f"  - [{chk['name']}] ({chk['status']}): {chk['explanation']}")
            lines.append(f"    👉 Lösung: {chk['resolution']}")
        lines.append("")

    if analysis["actionable_comments"]:
        lines.append(f"📝 Gefundene Inline-Review-Befunde ({len(analysis['actionable_comments'])}):")
        for i, c in enumerate(analysis["actionable_comments"], 1):
            lines.append(f"  {i}. {c['path']}:{c['line']} — {c['title']}")
    else:
        lines.append("✅ Keine offenen Review-Befunde.")

    return "\n".join(lines)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="CodeRabbit Status & Review Checker")
    parser.add_argument("pr", nargs="?", type=int, help="PR Nummer (optional, sonst aktueller Branch)")
    parser.add_argument("--json", action="store_true", help="JSON-Ausgabe")
    args = parser.parse_args(argv)

    try:
        pr_data, inline_comments = fetch_pr_info(args.pr)
        analysis = analyze_coderabbit(pr_data, inline_comments)
    except Exception as e:
        print(f"Fehler beim Abrufen von CodeRabbit-Daten: {e}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps({"pr": pr_data.get("number"), "analysis": analysis}, indent=2, ensure_ascii=False))
    else:
        print(format_report(pr_data, analysis))
    return 0


if __name__ == "__main__":
    sys.exit(main())
