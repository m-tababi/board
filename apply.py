#!/usr/bin/env python3
"""Applies the confirmed rows of a board proposal file to the Planner board.

Called only by the board mod after the user said yes. No LLM, standard library
only. Graph is reached through `az rest` with an argument list, never a shell.

    apply.py --proposals FILE --rows 1,2,4 --sha256 HEX [--report FILE.jsonl]

Board, owner and az come from the owner's config file (~/.claude/board/config.json,
outside any repository); a missing or broken config refuses the run before any call.
Runs only with a fresh confirmation file (~/.claude/board/confirm.json, written
by the mod after the yes, at most 120 s old, same hash and rows), which it
deletes on reading. Each row's result goes to the report file the moment it is
known, one JSON line each, then a last line with "final": true. Prints one JSON
object: {"status": "ok"|"aborted", "reason", "written", "rows"}. Exit 0 when the
run went through (rows may be skipped), 2 when it was refused before any write,
3 when it stopped after a write.
"""

import argparse
import datetime
import hashlib
import json
import os
import re
import subprocess
import sys
import time

GRAPH = "https://graph.microsoft.com/v1.0"
BUCKET_KEYS = ("backlog", "sprint_backlog", "in_progress", "in_review", "done")
# The block text after the date; the config may add statuses of its own (written with spaces).
BASE_STATUSES = {
    "open": "open",
    "in_progress": "in progress",
    "in_review": "in review",
    "done": "done",
    "outdated": "outdated",
    "superseded": "superseded",
    "blocked": "blocked",
}
PERCENTS = (0, 50, 100)
MAX_ROWS = 30
MAX_CREATE_TITLE = 70
# A new card in the create-backlog format, mapped to Planner as post-backlog does.
PRIORITIES = {"Urgent": 1, "Important": 3, "Medium": 5, "Low": 9}
STORY_RE = re.compile(r"^As a developer, I want to .{5,} so that .{5,}\.$")
# Title characters Planner or Markdown would read as markup.
TITLE_MARKUP_RE = re.compile(r"[`*_\[]|\]\(")
# A heading's date prefix ("2026-10-20 — …"): post-backlog drops it from the title.
DATE_TITLE_RE = re.compile(r"^\s*\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}\s*[—–]")
MAX_TASKS = 40
# New cards per run, as the mod allows.
MAX_CREATES = 15
# Existing cards brought into the create-backlog format per run.
MAX_REWRITES = 15
MAX_CHECKLIST = 20
# Above it, a rewrite keeps what the old description held.
PREVIOUS_NOTES = "Previous notes:"
SOURCE_FILE_RE = re.compile(r"^[A-Za-z0-9_.-]{1,40}/[A-Za-z0-9_][A-Za-z0-9_./-]{0,199}$")
AZ_TIMEOUT_S = 30
# No card starts after 120 s; the slowest card (five az calls of 30 s: task GET,
# PATCH, assignment check, details GET and PATCH; a new card takes the title list,
# POST, details GET and PATCH) then ends by 270 s, below the mod's kill at 330 s.
# Rows not started are reported as not run.
BUDGET_S = 120
CONFIRM_MAX_AGE_MS = 120_000
CONFIRM_PATH = os.path.join(os.path.expanduser("~"), ".claude", "board", "confirm.json")
CONFIG_PATH = os.path.join(os.path.expanduser("~"), ".claude", "board", "config.json")
# Every key the config may hold (the mod reads the rest); any other key refuses it.
CONFIG_KEYS = {
    "azPath", "planId", "buckets", "ownerId", "ownerLogin", "repos", "backlogSources", "changelog",
    "statusFiles", "standFile", "skipTitlePrefixes", "promptRules", "extraStatuses", "skillPath", "ghPath", "pythonPath",
}

ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
ETAG_RE = re.compile(r'^W/"[A-Za-z0-9+/=_-]{1,200}"$')
GUID_RE = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
FULL_GUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
REPO_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]{1,40}$")
SLUG_RE = re.compile(r"^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$")
STATUS_NAME_RE = re.compile(r"^[a-z][a-z_]{0,19}$")
REF_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_./-]{0,119}(:[0-9]{1,6}(-[0-9]{1,6})?)?$")
CONTROL_RE = re.compile(r"[\x00-\x1f\x7f-\x9f\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]")

TASK_KEYS = {"n", "action", "evidence", "taskId", "title", "etag", "detailsEtag"}
ACTION_KEYS = {
    "percent": TASK_KEYS | {"percent"},
    "move": TASK_KEYS | {"bucket"},
    "assign": TASK_KEYS,
    "marker": TASK_KEYS | {"marker"},
    "source": TASK_KEYS | {"source"},
    # An existing card in the create-backlog format: title, priority, description and checklist anew.
    "rewrite": TASK_KEYS | {"newTitle", "priority", "userStory", "tasks", "acceptanceCriteria"},
    "create": {"n", "action", "evidence", "title", "priority", "userStory", "tasks", "acceptanceCriteria", "source"},
}
# The task field each action writes; two rows writing one field of one card are refused.
FIELD = {"percent": "percent", "move": "bucket", "assign": "assign", "marker": "description", "source": "description", "rewrite": "description"}

BLOCK_OPEN = "<!-- board -->"
BLOCK_CLOSE = "<!-- /board -->"
# The block at the very top: its lines up to the close, then up to two line breaks.
BLOCK_RE = re.compile(r"\A<!-- board -->\r?\n(.*?)\r?\n<!-- /board -->(?:\r?\n){0,2}", re.DOTALL)
STATUS_LINE_RE = re.compile(r"\ASTATUS \d{4}-\d{2}-\d{2}: ([^\r\n]*)\Z")
# The line naming a card's backlog entry, above the board block; kept as it is.
SOURCE_LINE_RE = re.compile(r"\A<!-- board-src: [^\r\n]* -->(?:\r?\n){0,2}")


class Refusal(Exception):
    """The file, the selection or the confirmation does not hold: nothing is written."""


class Config:
    """What apply.py takes from the owner's config: az, the plan, its buckets, the owner, the repos."""

    def __init__(self, az, plan_id, buckets, owner, repos, statuses):
        self.az = az
        self.plan_id = plan_id
        self.buckets = buckets
        # The only person this script ever assigns; never read from the proposal file.
        self.owner = owner
        self.repos = repos
        self.statuses = statuses


def load_config(path=CONFIG_PATH):
    """Reads and checks the owner's config; Refusal when it is missing or does not hold."""
    try:
        with open(path, "rb") as f:
            cfg = json.loads(f.read().decode("utf-8"))
    except (OSError, ValueError) as err:
        raise Refusal(f"Konfiguration {path} fehlt oder ist unlesbar") from err
    if not isinstance(cfg, dict) or not set(cfg) <= CONFIG_KEYS:
        raise Refusal("Konfiguration: unbekannte Felder")
    az = cfg.get("azPath")
    if not isinstance(az, str) or not os.path.isabs(az) or not os.path.isfile(az) or not os.access(az, os.X_OK):
        raise Refusal("Konfiguration: azPath ist kein ausführbares Programm mit absolutem Pfad")
    plan_id = cfg.get("planId")
    if not isinstance(plan_id, str) or not ID_RE.match(plan_id):
        raise Refusal("Konfiguration: planId unzulässig")
    buckets = cfg.get("buckets")
    if not isinstance(buckets, dict) or set(buckets) != set(BUCKET_KEYS):
        raise Refusal(f"Konfiguration: buckets braucht genau {', '.join(BUCKET_KEYS)}")
    if any(not isinstance(v, str) or not ID_RE.match(v) for v in buckets.values()) or len(set(buckets.values())) != len(buckets):
        raise Refusal("Konfiguration: Bucket-ID unzulässig oder doppelt")
    owner = cfg.get("ownerId")
    if not isinstance(owner, str) or not FULL_GUID_RE.match(owner):
        raise Refusal("Konfiguration: ownerId ist keine Benutzer-ID")
    repos = cfg.get("repos")
    if not isinstance(repos, dict) or not all(
        isinstance(k, str) and REPO_NAME_RE.match(k) and isinstance(v, str) and SLUG_RE.match(v) for k, v in repos.items()
    ):
        raise Refusal("Konfiguration: repos unzulässig")
    statuses = dict(BASE_STATUSES)
    extra = cfg.get("extraStatuses", [])
    if not isinstance(extra, list) or not all(isinstance(x, str) and STATUS_NAME_RE.match(x) and x not in statuses for x in extra):
        raise Refusal("Konfiguration: extraStatuses unzulässig")
    statuses.update({x: x.replace("_", " ") for x in extra})
    return Config(az, plan_id, dict(buckets), owner, set(repos), statuses)


class Stop(Exception):
    """A check after a write failed: the remaining rows are not run."""


class Skip(Exception):
    """This row cannot be done safely; the card is left as it is."""


def run_az(argv):
    try:
        done = subprocess.run(argv, capture_output=True, text=True, timeout=AZ_TIMEOUT_S, check=False)
    except (OSError, subprocess.TimeoutExpired) as err:
        return 1, "", str(err)
    return done.returncode, done.stdout, done.stderr


def file_sha256(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def parse_rows(spec):
    if not re.fullmatch(r"[1-9][0-9]{0,2}(,[1-9][0-9]{0,2})*", spec):
        raise ValueError(f"--rows: {spec!r}")
    return [int(x) for x in spec.split(",")]


def _text(value, name, limit):
    if not isinstance(value, str) or len(value) > limit or CONTROL_RE.search(value):
        raise Refusal(f"{name}: kein zulässiger Text")
    return value


def _check_marker(marker, cfg):
    if not isinstance(marker, dict) or not set(marker) <= {"status", "repo", "pr", "ref"}:
        raise Refusal("marker: unbekannte Felder")
    if marker.get("status") not in cfg.statuses:
        raise Refusal("marker.status: nicht in der Liste")
    if ("repo" in marker) != ("pr" in marker):
        raise Refusal("marker: repo und pr nur zusammen")
    if "pr" in marker:
        pr = marker["pr"]
        if marker["repo"] not in cfg.repos or type(pr) is not int or not 1 <= pr <= 99999:
            raise Refusal("marker.pr/repo: unzulässig")
    if "ref" in marker and (not isinstance(marker["ref"], str) or not REF_RE.match(marker["ref"]) or ".." in marker["ref"]):
        raise Refusal("marker.ref: unzulässig")


def _check_source(source):
    if not isinstance(source, dict) or set(source) != {"file", "heading"}:
        raise Refusal("source: braucht genau file und heading")
    if not isinstance(source["file"], str) or not SOURCE_FILE_RE.match(source["file"]) or ".." in source["file"]:
        raise Refusal("source.file: unzulässig")
    heading = _text(source["heading"], "source.heading", 300)
    if heading != heading.strip() or not heading:
        raise Refusal("source.heading: unzulässig")


def _check_card(row, title_key="title"):
    """The create-backlog fields of a new or rewritten card; anything off refuses the file."""
    n = row["n"]
    title = _text(row[title_key], title_key, MAX_CREATE_TITLE)
    if title != title.strip() or len(title) < 3 or BLOCK_OPEN in title or "<!--" in title or TITLE_MARKUP_RE.search(title) or DATE_TITLE_RE.search(title):
        raise Refusal(f"Zeile {n}: title unzulässig (3-{MAX_CREATE_TITLE} Zeichen, kein Datum, kein Markdown, keine Backticks)")
    if row["priority"] not in PRIORITIES:
        raise Refusal(f"Zeile {n}: priority nur Urgent, Important, Medium oder Low")
    if not STORY_RE.match(_text(row["userStory"], "userStory", 600)):
        raise Refusal(f"Zeile {n}: userStory nicht „As a developer, I want to … so that ….“")
    tasks, criteria = row["tasks"], row["acceptanceCriteria"]
    if not isinstance(tasks, list) or not 1 <= len(tasks) <= MAX_TASKS:
        raise Refusal(f"Zeile {n}: 1 bis {MAX_TASKS} tasks")
    if not isinstance(criteria, list) or not 3 <= len(criteria) <= 5:
        raise Refusal(f"Zeile {n}: 3 bis 5 acceptanceCriteria")
    # An HTML comment in the card would stop every later marker on it.
    if any("<!--" in x for x in [row["userStory"], *tasks, *criteria] if isinstance(x, str)):
        raise Refusal(f"Zeile {n}: kein <!-- in userStory, tasks oder acceptanceCriteria")
    for item, limit in [(t, 100) for t in tasks] + [(c, 200) for c in criteria]:
        if len(_text(item, "tasks/acceptanceCriteria", limit).strip()) < 3 or item != item.strip():
            raise Refusal(f"Zeile {n}: Eintrag in tasks/acceptanceCriteria zu kurz oder mit Rand")
    if title_key == "title":
        _check_source(row["source"])


def source_key(heading):
    """The short hash naming a backlog heading in the card's board-src line."""
    return hashlib.sha256(heading.encode("utf-8")).hexdigest()[:12]


def source_line(source):
    return f"<!-- board-src: {source['file']}#{source_key(source['heading'])} -->"


def card_body(row):
    """The description post-backlog writes for a create-backlog entry: priority, story, criteria, tasks past twenty."""
    tasks = row["tasks"]
    lines = [f"Priority: {row['priority']}", "", row["userStory"], "", "Acceptance Criteria:"]
    lines += [f"- {c}" for c in row["acceptanceCriteria"]]
    if len(tasks) > MAX_CHECKLIST:
        lines += ["", "Remaining tasks:"] + [f"- {t}" for t in tasks[MAX_CHECKLIST:]]
    return "\n".join(lines)


def checklist_of(tasks, checked=frozenset(), taken=frozenset()):
    """The first twenty tasks as Planner checklist items; a task whose text is in `checked` stays ticked.

    Keys in `taken` (old items that stay) are skipped.
    """
    keys = (f"item-{i:02d}" for i in range(1, 100) if f"item-{i:02d}" not in taken)
    return {
        next(keys): {
            "@odata.type": "#microsoft.graph.plannerChecklistItem",
            "title": t,
            "isChecked": t.strip().lower() in checked,
            "orderHint": f" {chr(97 + i)}!",
        }
        for i, t in enumerate(tasks[:MAX_CHECKLIST])
    }


def card_details(row):
    """Description and checklist of a new card, as post-backlog maps a create-backlog entry."""
    return {"description": source_line(row["source"]) + "\n\n" + card_body(row), "checklist": checklist_of(row["tasks"])}


def rewritten_details(details, row):
    """An existing card's details in the create-backlog format.

    The board-src line and the board block at the top stay as they are; the
    post-backlog body follows, and everything else the old description held
    stays word for word below it under "Previous notes:". The checklist becomes
    the tasks: an item whose text a task repeats keeps its tick, a ticked item
    no task repeats stays as it is, an unticked one goes. Skip when the ticked
    items kept and the tasks together pass twenty.
    """
    old = details.get("description") or ""
    head = SOURCE_LINE_RE.match(old)
    parts = []
    rest = old
    if head:
        parts.append(head.group(0).rstrip("\r\n"))
        rest = old[head.end() :]
    block = BLOCK_RE.match(rest)
    if block:
        parts.append(block.group(0).rstrip("\r\n"))
        rest = rest[block.end() :]
    body = card_body(row)
    if rest.strip():
        body += f"\n\n{PREVIOUS_NOTES}\n{rest}"
    parts.append(body)
    items = {k: v for k, v in (details.get("checklist") or {}).items() if isinstance(v, dict)}
    checked = {str(v.get("title", "")).strip().lower() for v in items.values() if v.get("isChecked") is True}
    tasks = {t.strip().lower() for t in row["tasks"]}
    kept = {k for k, v in items.items() if v.get("isChecked") is True and str(v.get("title", "")).strip().lower() not in tasks}
    if kept and min(len(row["tasks"]), MAX_CHECKLIST) + len(kept) > MAX_CHECKLIST:
        raise Skip(f"{len(kept)} abgehakte alte Einträge bleiben, mit den Tasks über {MAX_CHECKLIST} in der Checkliste")
    checklist = checklist_of(row["tasks"], checked, kept)
    for key in items:
        if key not in checklist and key not in kept:
            checklist[key] = None
    return {"description": "\n\n".join(parts), "checklist": checklist}


def with_source(description, source):
    """The description with the board-src line on top; Skip when it already has one."""
    if SOURCE_LINE_RE.match(description):
        raise Skip("Quellzeile schon gesetzt")
    line = source_line(source)
    return line + ("\n\n" + description if description else "")


def _strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for k, v in value.items():
            yield k
            yield from _strings(v)
    elif isinstance(value, list):
        for v in value:
            yield from _strings(v)


def validate(doc, cfg):
    """Checks the whole file against the positive list; any fault refuses all of it."""
    if not isinstance(doc, dict) or set(doc) != {"version", "planId", "createdAt", "rows"}:
        raise Refusal("Datei: unerwartete Felder")
    if doc["version"] != 1 or doc["planId"] != cfg.plan_id:
        raise Refusal("planId/version: nicht dieses Board")
    rows = doc["rows"]
    if not isinstance(rows, list) or len(rows) > MAX_ROWS:
        raise Refusal(f"höchstens {MAX_ROWS} Zeilen je Lauf")
    if any(GUID_RE.search(s) for s in _strings(doc)):
        raise Refusal("Benutzer-ID in der Datei: Zuweisungen gehen nur an die ownerId der Konfiguration")

    seen_n, seen_field, seen_titles, etags = set(), set(), set(), {}
    rewrites = 0
    for row in rows:
        if not isinstance(row, dict) or row.get("action") not in ACTION_KEYS:
            raise Refusal(f"Aktion nicht erlaubt: {row.get('action') if isinstance(row, dict) else row!r}")
        action = row["action"]
        allowed = ACTION_KEYS[action]
        extra = set(row) - allowed
        if extra:
            raise Refusal(f"Zeile {row.get('n')}: unbekannte Felder {sorted(extra)}")
        n = row.get("n")
        if type(n) is not int or n < 1 or n in seen_n:
            raise Refusal(f"Zeilennummer unzulässig: {n!r}")
        seen_n.add(n)
        _text(row.get("evidence", ""), "evidence", 400)

        if action == "create":
            if set(row) != allowed:
                raise Refusal(f"Zeile {n}: create braucht {', '.join(sorted(allowed - {'n', 'action'}))}")
            _check_card(row)
            title = row["title"]
            if title.lower() in seen_titles:
                raise Refusal(f"Zeile {n}: Karte doppelt angelegt")
            seen_titles.add(title.lower())
            if len(seen_titles) > MAX_CREATES:
                raise Refusal(f"höchstens {MAX_CREATES} neue Karten je Lauf")
            continue
        if action == "rewrite":
            rewrites += 1
            if rewrites > MAX_REWRITES:
                raise Refusal(f"höchstens {MAX_REWRITES} neu gefasste Karten je Lauf")

        if allowed - set(row):
            raise Refusal(f"Zeile {n}: es fehlen {sorted(allowed - set(row) - {'evidence'})}")
        if not isinstance(row["taskId"], str) or not ID_RE.match(row["taskId"]):
            raise Refusal(f"Zeile {n}: taskId unzulässig")
        for key in ("etag", "detailsEtag"):
            if not isinstance(row[key], str) or not ETAG_RE.match(row[key]):
                raise Refusal(f"Zeile {n}: {key} unzulässig")
        if etags.setdefault(row["taskId"], (row["etag"], row["detailsEtag"])) != (row["etag"], row["detailsEtag"]):
            raise Refusal(f"Zeile {n}: andere ETags als die übrigen Zeilen dieser Karte")
        _text(row["title"], "title", 255)
        if action == "percent" and (type(row["percent"]) is not int or row["percent"] not in PERCENTS):
            raise Refusal(f"Zeile {n}: percent nur 0, 50 oder 100")
        if action == "move" and row["bucket"] not in cfg.buckets:
            raise Refusal(f"Zeile {n}: bucket unbekannt")
        if action == "marker":
            _check_marker(row["marker"], cfg)
        if action == "source":
            _check_source(row["source"])
        if action == "rewrite":
            _check_card(row, "newTitle")
        key = (row["taskId"], FIELD[action])
        if key in seen_field:
            raise Refusal(f"Zeile {n}: Feld {FIELD[action]} der Karte doppelt")
        seen_field.add(key)


def consume_confirmation(path, sha, selected, now_ms):
    """Reads and deletes the mod's confirmation; refuses unless it names this hash and these rows, freshly."""
    try:
        with open(path, "rb") as f:
            raw = f.read()
    except OSError as err:
        raise Refusal("keine Bestätigung des board-Mods") from err
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
    try:
        confirm = json.loads(raw.decode("utf-8"))
    except ValueError as err:
        raise Refusal("Bestätigung unlesbar") from err
    if not isinstance(confirm, dict) or set(confirm) != {"sha256", "rows", "at"}:
        raise Refusal("Bestätigung: unerwartete Felder")
    if confirm["sha256"] != sha or confirm["rows"] != selected:
        raise Refusal("Bestätigung passt nicht zu Datei oder Zeilen")
    at = confirm["at"]
    if type(at) not in (int, float) or not -5000 <= now_ms - at <= CONFIRM_MAX_AGE_MS:
        raise Refusal("Bestätigung zu alt (über 120 s)")


def marker_line(marker, today, statuses):
    line = f"STATUS {today.isoformat()}: {statuses[marker['status']]}"
    if "pr" in marker:
        line += f" · PR {marker['repo']}#{marker['pr']}"
    if "ref" in marker:
        line += f" · ref {marker['ref']}"
    return line


def with_marker(description, marker, today, statuses=BASE_STATUSES):
    """The description with the board block on top; None when the block already says this.

    Raises Skip when a block was edited by hand or another block sits below the top.
    A board-src line on top stays where it is, the block goes below it.
    """
    head = SOURCE_LINE_RE.match(description)
    if head:
        rest = with_marker(description[head.end() :], marker, today, statuses)
        if rest is None:
            return None
        start = head.group(0)
        return start + ("" if start.endswith("\n") or not rest else "\n") + rest
    line = marker_line(marker, today, statuses)
    found = BLOCK_RE.match(description)
    rest = description
    if found:
        status = STATUS_LINE_RE.match(found.group(1))
        if status is None:
            raise Skip("Markerblock von Hand geändert")
        if status.group(1) == line.split(": ", 1)[1]:
            return None
        rest = description[found.end() :]
    if BLOCK_OPEN in rest or BLOCK_CLOSE in rest:
        raise Skip("weiterer Markerblock in der Beschreibung")
    block = f"{BLOCK_OPEN}\n{line}\n{BLOCK_CLOSE}"
    return block + ("\n\n" + rest if rest else "")


class Graph:
    def __init__(self, call, az):
        self.call = call
        self.az = az

    def get(self, path):
        rc, out, err = self.call([self.az, "rest", "--method", "get", "--url", GRAPH + path])
        if rc != 0:
            raise RuntimeError(_short(err))
        value = json.loads(out)
        if not isinstance(value, dict):
            raise RuntimeError("Graph-Antwort ist kein Objekt")  # noqa: TRY004 - callers treat every bad answer as RuntimeError
        return value

    def write(self, method, path, body, etag=None):
        argv = [self.az, "rest", "--method", method, "--url", GRAPH + path, "--body", json.dumps(body), "--headers"]
        if etag is not None:
            argv.append(f"If-Match={etag}")
        argv.append("Content-Type=application/json")
        rc, out, err = self.call(argv)
        if rc != 0:
            # az names the HTTP reason; a 412 is "Precondition Failed".
            return ("conflict" if "Precondition Failed" in err else "error"), _short(err)
        return "ok", out


def _short(text):
    return CONTROL_RE.sub(" ", text or "").strip()[:200]


def _assignment(owner):
    return {owner: {"@odata.type": "#microsoft.graph.plannerAssignment", "orderHint": " !"}}


class Report:
    """Row results as they happen: the outcome's list and, flushed line by line, the report file."""

    def __init__(self, path):
        self.path = path
        self.results = {}
        if path is not None:
            with open(path, "w", encoding="utf-8"):
                pass

    def _line(self, value):
        if self.path is None:
            return
        with open(self.path, "a", encoding="utf-8") as f:
            f.write(json.dumps(value, ensure_ascii=False) + "\n")
            f.flush()
            os.fsync(f.fileno())

    def note(self, row, result, detail=""):
        if row["n"] in self.results:
            return
        self.results[row["n"]] = {"n": row["n"], "result": result, "detail": detail}
        self._line(self.results[row["n"]])

    def final(self, outcome, selected):
        outcome["rows"] = [self.results[n] for n in selected if n in self.results]
        self._line({"final": True, "status": outcome["status"], "reason": outcome["reason"], "written": outcome["written"]})
        return outcome


def apply(
    path, selected, sha, *, call=run_az, today=None, confirm_path=CONFIRM_PATH, config_path=CONFIG_PATH, report_path=None, clock=time.time, budget_s=BUDGET_S
):
    today = today or datetime.date.today()
    outcome = {"status": "ok", "reason": "", "written": False, "rows": []}
    try:
        report = Report(report_path)
    except OSError as err:
        return {**outcome, "status": "aborted", "reason": f"Bericht nicht schreibbar: {err}"}
    try:
        consume_confirmation(confirm_path, sha, selected, clock() * 1000)
        cfg = load_config(config_path)
        if not re.fullmatch(r"[0-9a-f]{64}", sha or ""):
            raise Refusal("Hash unzulässig")
        # One read: the bytes hashed are the bytes parsed.
        with open(path, "rb") as f:
            data = f.read()
        if hashlib.sha256(data).hexdigest() != sha:
            raise Refusal("Hash der Datei weicht von der angezeigten ab")
        doc = json.loads(data.decode("utf-8"))
        validate(doc, cfg)
        rows = {r["n"]: r for r in doc["rows"]}
        if len(set(selected)) != len(selected) or any(n not in rows for n in selected):
            raise Refusal("Zeilenauswahl passt nicht zur Datei")
    except Refusal as err:
        outcome.update(status="aborted", reason=str(err))
        return report.final(outcome, selected)
    except (OSError, ValueError) as err:
        outcome.update(status="aborted", reason=f"Datei unlesbar: {err}")
        return report.final(outcome, selected)
    except (TypeError, KeyError, AttributeError) as err:
        # A value of the wrong type (a list where a name belongs) is a refused file, not a crash.
        outcome.update(status="aborted", reason=f"Datei unzulässig: {type(err).__name__}")
        return report.final(outcome, selected)

    graph = Graph(call, cfg.az)
    state = {"titles": None}

    # One group per card, in the order of its first selected row; creations stand alone.
    groups = {}
    for n in selected:
        row = rows[n]
        key = ("create", n) if row["action"] == "create" else ("task", row["taskId"])
        groups.setdefault(key, []).append(row)

    # The plan's titles, read once before the clock starts when a row creates or renames a card.
    if any(rows[n]["action"] in ("create", "rewrite") for n in selected):
        try:
            _titles(graph, cfg, state)
        except (RuntimeError, ValueError):
            pass  # each row that needs the list reports it
    started = clock()
    stopped = None
    for (kind, _), group in groups.items():
        if stopped is not None:
            for r in group:
                report.note(r, "not_run", "Lauf angehalten")
            continue
        if clock() - started > budget_s:
            for r in group:
                report.note(r, "not_run", "Zeitbudget erschöpft")
            continue
        try:
            if kind == "create":
                _create(graph, group[0], today, state, report.note, outcome, cfg)
            else:
                _update(graph, group, today, report.note, outcome, cfg, state)
        except Stop as err:
            stopped = str(err)
        except Exception as err:  # noqa: BLE001 - anything unexpected after a write: stop, report what is known
            for r in group:
                report.note(r, "error", f"unerwartet: {type(err).__name__}: {_short(str(err))}")
            stopped = f"unerwarteter Fehler bei Zeile {group[0]['n']}; Lauf angehalten"
    if stopped is not None:
        outcome.update(status="aborted", reason=stopped)
    return report.final(outcome, selected)


def _update(graph, group, today, note, outcome, cfg, state):
    task_id = group[0]["taskId"]
    # A rewrite writes both halves: title and priority with the task, the rest with the details.
    task_rows = [r for r in group if r["action"] in ("percent", "move", "assign", "rewrite")]
    marker_rows = [r for r in group if r["action"] in ("marker", "source", "rewrite")]
    # Rewrites whose task half did not go through: their details stay as they are.
    held = set()
    # The rewritten details, made from a fresh read before anything is written.
    prepared = {}

    if task_rows:
        try:
            live = graph.get(f"/planner/tasks/{task_id}")
        except (RuntimeError, ValueError) as err:
            for r in task_rows:
                note(r, "error", str(err))
                held.add(r["n"])
            live = None
        if live is not None and live.get("@odata.etag") != task_rows[0]["etag"]:
            for r in task_rows:
                note(r, "skipped", "Karte seit dem Abgleich geändert")
                held.add(r["n"])
        elif live is not None:
            before = set(live.get("assignments") or {})
            # Only the owner's own cards are assigned or rewritten.
            creator = ((live.get("createdBy") or {}).get("user") or {}).get("id")
            for r in task_rows:
                if r["action"] in ("assign", "rewrite") and creator != cfg.owner:
                    note(r, "skipped", "Karte hat jemand anderes angelegt")
                    held.add(r["n"])
            for r in task_rows:
                if r["action"] == "rewrite" and r["n"] not in held:
                    try:
                        others = {t for i, t in _titles(graph, cfg, state).items() if i != task_id}
                    except (RuntimeError, ValueError) as err:
                        note(r, "error", f"Kartenliste nicht lesbar: {err}")
                        held.add(r["n"])
                        continue
                    if r["newTitle"].lower() in others:
                        note(r, "skipped", "eine andere Karte trägt diesen Titel schon")
                        held.add(r["n"])
                        continue
                    _prepare_rewrite(graph, task_id, r, note, held, prepared)
            body, sent = {}, []
            for r in task_rows:
                if r["action"] == "percent":
                    body["percentComplete"] = r["percent"]
                elif r["action"] == "move":
                    body["bucketId"] = cfg.buckets[r["bucket"]]
                elif r["action"] == "rewrite":
                    if r["n"] in held:
                        continue
                    if before - {cfg.owner}:
                        note(r, "skipped", "Karte ist jemand anderem zugewiesen")
                        held.add(r["n"])
                        continue
                    body["title"] = r["newTitle"]
                    body["priority"] = PRIORITIES[r["priority"]]
                elif r["n"] in held:
                    continue
                elif before:
                    note(r, "skipped", "Karte ist schon zugewiesen")
                    continue
                elif live.get("bucketId") != cfg.buckets["in_progress"] and not any(
                    x["action"] == "move" and x["bucket"] == "in_progress" for x in task_rows
                ):
                    # Backlog and Sprint Backlog cards stay free unless this run starts them.
                    note(r, "skipped", "Karte liegt nicht in In Progress und wird nicht dorthin verschoben")
                    continue
                else:
                    body["assignments"] = _assignment(cfg.owner)
                sent.append(r)
            if body:
                result, detail = graph.write("patch", f"/planner/tasks/{task_id}", body, task_rows[0]["etag"])
                for r in sent:
                    if r["action"] == "rewrite" and result == "ok":
                        # The new title counts for the rows after it, once the card carries it.
                        state["titles"][task_id] = r["newTitle"].lower()
                        continue
                    note(r, {"ok": "ok", "conflict": "skipped", "error": "error"}[result], "" if result == "ok" else detail)
                    held.add(r["n"])
                if result == "ok":
                    outcome["written"] = True
                    try:
                        _check_assignments(graph, task_id, before, "assignments" in body, cfg.owner)
                    except Stop:
                        # The task half of a rewrite is written: the row says so before the run stops.
                        for r in sent:
                            if r["action"] == "rewrite":
                                note(r, "error", "Titel und Priorität neu, Beschreibung und Checkliste nicht: Lauf angehalten")
                        raise

    for r in marker_rows:
        if r["n"] in held:
            continue
        if r["action"] == "rewrite":
            result, detail = graph.write("patch", f"/planner/tasks/{task_id}/details", prepared[r["n"]], r["detailsEtag"])
            note(r, "ok" if result == "ok" else "error", "" if result == "ok" else f"Titel und Priorität neu, Beschreibung und Checkliste nicht: {detail}")
            continue
        try:
            details = graph.get(f"/planner/tasks/{task_id}/details")
        except (RuntimeError, ValueError) as err:
            note(r, "error", str(err))
            continue
        if details.get("@odata.etag") != r["detailsEtag"]:
            note(r, "skipped", "Beschreibung seit dem Abgleich geändert")
            continue
        try:
            old = details.get("description") or ""
            new = with_source(old, r["source"]) if r["action"] == "source" else with_marker(old, r["marker"], today, cfg.statuses)
        except Skip as err:
            note(r, "skipped", str(err))
            continue
        if new is None:
            note(r, "unchanged", "Markerblock schon aktuell")
            continue
        result, detail = graph.write("patch", f"/planner/tasks/{task_id}/details", {"description": new}, r["detailsEtag"])
        note(r, {"ok": "ok", "conflict": "skipped", "error": "error"}[result], "" if result == "ok" else detail)
        outcome["written"] = outcome["written"] or result == "ok"


def _prepare_rewrite(graph, task_id, row, note, held, prepared):
    """Reads the details and builds the rewrite; on any doubt the row is skipped before a write."""
    try:
        details = graph.get(f"/planner/tasks/{task_id}/details")
    except (RuntimeError, ValueError) as err:
        note(row, "error", str(err))
        held.add(row["n"])
        return
    if details.get("@odata.etag") != row["detailsEtag"]:
        note(row, "skipped", "Beschreibung seit dem Abgleich geändert")
        held.add(row["n"])
        return
    try:
        prepared[row["n"]] = rewritten_details(details, row)
    except Skip as err:
        note(row, "skipped", str(err))
        held.add(row["n"])


def _check_assignments(graph, task_id, before, assigned, owner):
    try:
        after = set(graph.get(f"/planner/tasks/{task_id}").get("assignments") or {})
    except (RuntimeError, ValueError) as err:
        raise Stop(f"Zuweisungen von {task_id} nach dem Schreiben nicht lesbar ({err}); Lauf angehalten") from err
    if after - {owner} != before - {owner} or (owner in after) != (owner in before or assigned):
        raise Stop(f"Zuweisung von {task_id} hat sich unerwartet geändert; Lauf angehalten")


def _titles(graph, cfg, state):
    """Task id -> lower-case title of every card of the plan, read once per run (and kept up to date)."""
    if state["titles"] is None:
        titles = {}
        path = f"/planner/plans/{cfg.plan_id}/tasks"
        while path:
            page = graph.get(path)
            titles.update({str(t.get("id", "")): str(t.get("title", "")).strip().lower() for t in page.get("value", [])})
            following = page.get("@odata.nextLink") or ""
            path = following[len(GRAPH) :] if following.startswith(GRAPH + "/") else None
        state["titles"] = titles
    return state["titles"]


def _create(graph, row, today, state, note, outcome, cfg):
    title = row["title"]
    try:
        titles = _titles(graph, cfg, state)
    except (RuntimeError, ValueError) as err:
        note(row, "error", f"Kartenliste nicht lesbar: {err}")
        return
    if title.lower() in titles.values():
        note(row, "skipped", "Karte mit diesem Titel gibt es schon")
        return

    body = {"planId": cfg.plan_id, "bucketId": cfg.buckets["backlog"], "title": title, "priority": PRIORITIES[row["priority"]]}
    result, out = graph.write("post", "/planner/tasks", body)
    if result != "ok":
        note(row, "error", out)
        return
    outcome["written"] = True
    try:
        created = json.loads(out)
    except ValueError:
        created = None
    new_id = created.get("id") if isinstance(created, dict) else None
    # The new title counts for the rows after it, under the new id or, without one, a stand-in key.
    titles[new_id if isinstance(new_id, str) else f"row-{row['n']}"] = title.lower()
    if not isinstance(new_id, str) or not ID_RE.match(new_id):
        note(row, "error", "angelegt, aber ohne gültige ID zurückgemeldet – auf dem Board prüfen")
        raise Stop("Neue Karte ohne gültige ID zurückgemeldet; Lauf angehalten")
    if not set(created.get("assignments") or {}) <= {cfg.owner}:
        note(row, "error", f"angelegt als {new_id} mit fremder Zuweisung – auf dem Board prüfen")
        raise Stop(f"Neue Karte {new_id} trägt eine fremde Zuweisung; Lauf angehalten")
    try:
        details = graph.get(f"/planner/tasks/{new_id}/details")
    except (RuntimeError, ValueError) as err:
        note(row, "error", f"angelegt als {new_id}, Beschreibung und Checkliste nicht gesetzt ({err})")
        return
    result, detail = graph.write("patch", f"/planner/tasks/{new_id}/details", card_details(row), details.get("@odata.etag"))
    note(row, "ok" if result == "ok" else "error", new_id if result == "ok" else f"angelegt als {new_id}, Beschreibung und Checkliste: {detail}")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--proposals", required=True)
    parser.add_argument("--rows", required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--report")
    args = parser.parse_args(argv)
    try:
        selected = parse_rows(args.rows)
    except ValueError as err:
        outcome = {"status": "aborted", "reason": str(err), "written": False, "rows": []}
    else:
        outcome = apply(args.proposals, selected, args.sha256, report_path=args.report)
    print(json.dumps(outcome, ensure_ascii=False))
    if outcome["status"] == "ok":
        return 0
    return 3 if outcome["written"] else 2


if __name__ == "__main__":
    sys.exit(main())
