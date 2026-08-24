import json
import sys
from pathlib import Path
import pytest

sys.path.insert(0, str(Path(__file__).parent))
import coderabbit_status


def test_parse_rate_limited_comment():
    comment_body = """
<!-- This is an auto-generated comment: summarize by coderabbit.ai -->
<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->

> [!WARNING]
> ## Review limit reached
> 
> **Next included review available in 19 minutes.**
> 
> <details>
> <summary>View limit details</summary>
> 
> **Limit details:** You’ve used all 3 included reviews currently available.
"""
    comments = [{"author": {"login": "coderabbitai"}, "body": comment_body}]
    res = coderabbit_status.analyze_coderabbit(pr_info={"comments": comments, "statusCheckRollup": []}, inline_comments=[])
    assert res["status"] == "RATE_LIMITED"
    assert res["rate_limited"] is True
    assert res["wait_minutes"] == 19
    assert "19" in res["message"]


def test_parse_in_progress_check():
    checks = [
        {"name": "CodeRabbit", "status": "IN_PROGRESS", "conclusion": None}
    ]
    res = coderabbit_status.analyze_coderabbit(pr_info={"comments": [], "statusCheckRollup": checks}, inline_comments=[])
    assert res["status"] == "IN_PROGRESS"
    assert res["in_progress"] is True


def test_parse_completed_with_comments_and_pre_merge_warnings():
    summary_body = """
<!-- pre_merge_checks_walkthrough_start -->
<details>
<summary>🚥 Pre-merge checks | ✅ 6 | ❌ 1</summary>

### ❌ Failed checks (1 warnings)

| Check name | Status | Explanation | Resolution |
| :---: | :--- | :--- | :--- |
| Readme Bei Nutzer-Sichtbarer Aenderung | ⚠️ Warning | README unveraendert | README aktualisieren |

</details>
<!-- pre_merge_checks_walkthrough_end -->
"""
    comments = [{"author": {"login": "coderabbitai"}, "body": summary_body}]
    inline = [
        {
            "id": 12345,
            "user": {"login": "coderabbitai[bot]"},
            "path": "webtool/llm.py",
            "line": 449,
            "body": "_🎯 Functional Correctness_ | _🟡 Minor_\n\n**HTTP-Statuscodes nur im Statuskontext erkennen.**\n\nErkenne 402 nur als Statuscode.",
        }
    ]
    res = coderabbit_status.analyze_coderabbit(
        pr_info={"comments": comments, "statusCheckRollup": [{"name": "CodeRabbit", "status": "COMPLETED", "conclusion": "SUCCESS"}]},
        inline_comments=inline,
    )
    assert res["status"] == "COMPLETED"
    assert len(res["actionable_comments"]) == 1
    assert res["actionable_comments"][0]["path"] == "webtool/llm.py"
    assert res["actionable_comments"][0]["line"] == 449
    assert "HTTP-Statuscodes" in res["actionable_comments"][0]["title"]
    assert len(res["failed_pre_merge_checks"]) == 1
    assert res["failed_pre_merge_checks"][0]["name"] == "Readme Bei Nutzer-Sichtbarer Aenderung"


def test_parse_rate_limited_without_wait_minutes():
    comment_body = "<!-- rate limited by coderabbit.ai -->\n## Review limit reached"
    comments = [{"author": {"login": "coderabbitai"}, "body": comment_body}]
    res = coderabbit_status.analyze_coderabbit(pr_info={"comments": comments, "statusCheckRollup": []}, inline_comments=[])
    assert res["status"] == "RATE_LIMITED"
    assert res["wait_minutes"] is None
    report = coderabbit_status.format_report({"number": 1, "title": "Test"}, res)
    assert "None" not in report
    assert "nicht verfügbar" in report


def test_ignores_foreign_comments():
    # Kommentare von normalen Benutzern (z.B. Alice) dürfen weder Rate-Limit noch Pre-Merge noch Befunde triggern
    foreign_comments = [
        {"author": {"login": "alice"}, "body": "<!-- rate limited by coderabbit.ai -->\nReview limit reached"},
        {"author": {"login": "bob"}, "body": "Pre-merge checks\nFailed checks\n| Readme | ⚠️ | x | y |"},
    ]
    foreign_inline = [
        {"id": 99, "user": {"login": "charlie"}, "path": "test.py", "line": 1, "body": "**Human comment**"}
    ]
    res = coderabbit_status.analyze_coderabbit(
        pr_info={"comments": foreign_comments, "statusCheckRollup": []},
        inline_comments=foreign_inline,
    )
    assert res["status"] == "NOT_STARTED"
    assert res["rate_limited"] is False
    assert len(res["failed_pre_merge_checks"]) == 0
    assert len(res["actionable_comments"]) == 0


def test_rejects_non_allowlisted_login_containing_coderabbit():
    # Login enthält "coderabbit", gehört aber nicht zur exakten Allowlist
    fake_comments = [
        {"author": {"login": "coderabbit-helper"}, "body": "<!-- rate limited by coderabbit.ai -->\nReview limit reached"},
        {"author": {"login": "fake-coderabbit"}, "body": "Pre-merge checks\nFailed checks\n| Readme | ⚠️ | x | y |"},
    ]
    fake_inline = [
        {"id": 100, "user": {"login": "coderabbit-imposter"}, "path": "test.py", "line": 1, "body": "**Imposter**"}
    ]
    res = coderabbit_status.analyze_coderabbit(
        pr_info={"comments": fake_comments, "statusCheckRollup": []},
        inline_comments=fake_inline,
    )
    assert res["status"] == "NOT_STARTED"
    assert res["rate_limited"] is False
    assert len(res["failed_pre_merge_checks"]) == 0
    assert len(res["actionable_comments"]) == 0


def test_completed_check_without_comments_is_activity():
    # CodeRabbit Check abgeschlossen, aber 0 Befunde und 0 Kommentare -> COMPLETED statt NOT_STARTED
    checks = [
        {"name": "CodeRabbit", "status": "COMPLETED", "conclusion": "SUCCESS"}
    ]
    res = coderabbit_status.analyze_coderabbit(
        pr_info={"comments": [], "statusCheckRollup": checks},
        inline_comments=[],
    )
    assert res["status"] == "COMPLETED"
    assert res["in_progress"] is False
    assert len(res["actionable_comments"]) == 0
    assert len(res["failed_pre_merge_checks"]) == 0
    assert "abgeschlossen" in res["message"]


