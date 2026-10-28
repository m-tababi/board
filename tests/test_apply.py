"""Tests for apply.py: a fake Graph behind the injectable runner, never az; a made-up config."""

import atexit
import datetime
import hashlib
import json
import os
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import apply

# Made-up values only: no real plan, bucket or user id belongs in a test.
PLAN = "PlanFake0000000000000001"
ME = "00000000-0000-4000-8000-000000000001"
OTHER = "00000000-0000-4000-8000-000000000002"
BUCKETS = {
    "backlog": "BucketBacklog00000000001",
    "sprint_backlog": "BucketSprint000000000001",
    "in_progress": "BucketProgress0000000001",
    "in_review": "BucketReview000000000001",
    "done": "BucketDone00000000000001",
}
TODAY = datetime.date(2026, 10, 27)
T1 = "TaskFakeOne0000000000001"
T2 = "TaskFakeTwo0000000000002"

# A stand-in for az: the config insists on an executable file; the runner never starts it.
_fd, AZ = tempfile.mkstemp(prefix="fake-az-")
os.close(_fd)
os.chmod(AZ, 0o755)
atexit.register(os.unlink, AZ)


def config(**override):
    value = {
        "azPath": AZ,
        "planId": PLAN,
        "buckets": dict(BUCKETS),
        "ownerId": ME,
        "ownerLogin": "owner-login",
        "repos": {"alpha": "example-org/alpha", "beta": "example-org/beta"},
        "extraStatuses": ["side_project"],
    }
    value.update(override)
    return value


class FakeGraph:
    """Planner in memory, answering the argv apply.py hands its runner."""

    def __init__(self, tasks):
        self.tasks = {t["id"]: t for t in tasks}
        self.calls = []
        self.writes = []
        self.counter = 0
        # Hooks a test sets: a change made by "someone else" right before a write.
        self.before_patch = None
        self.after_patch = None

    def etag(self, kind):
        self.counter += 1
        return f'W/"{kind}-{self.counter}"'

    def __call__(self, argv):
        self.calls.append(list(argv))
        assert argv[0] == AZ and argv[1] == "rest", argv
        opts = dict(zip(argv[2::2], argv[3::2]))
        method, url = opts["--method"], opts["--url"]
        assert url.startswith(apply.GRAPH + "/"), url
        path = url[len(apply.GRAPH) :]
        parts = path.strip("/").split("/")
        if method == "get" and parts[:2] == ["planner", "plans"]:
            return 0, json.dumps({"value": [self.task_view(t) for t in self.tasks.values()]}), ""
        if parts[:2] != ["planner", "tasks"]:
            return 1, "", "unexpected url"
        if method == "post":
            body = json.loads(opts["--body"])
            self.writes.append(("post", body))
            new_id = f"NEW{len(self.tasks)}x"
            self.tasks[new_id] = {
                "id": new_id,
                "title": body["title"],
                "bucketId": body["bucketId"],
                "percentComplete": 0,
                "assignments": {k: {} for k in body.get("assignments", {})},
                "etag": self.etag("task"),
                "description": "",
                "detailsEtag": self.etag("details"),
                "checklist": {},
            }
            return 0, json.dumps(self.task_view(self.tasks[new_id])), ""
        task = self.tasks.get(parts[2])
        if task is None:
            return 1, "", "Not Found(404)"
        is_details = len(parts) == 4 and parts[3] == "details"
        if method == "get":
            if is_details:
                return 0, json.dumps({"description": task["description"], "checklist": task.get("checklist", {}), "@odata.etag": task["detailsEtag"]}), ""
            return 0, json.dumps(self.task_view(task)), ""
        if method == "patch":
            if self.before_patch is not None:
                self.before_patch(self, task)
            headers = argv[argv.index("--headers") + 1 :]
            match = next(h for h in headers if h.startswith("If-Match="))[len("If-Match=") :]
            current = task["detailsEtag"] if is_details else task["etag"]
            if match != current:
                return 1, "", "Precondition Failed(412)"
            body = json.loads(opts["--body"])
            self.writes.append(("patch-details" if is_details else "patch-task", parts[2], body))
            if is_details:
                task["description"] = body["description"]
                # Graph merges a checklist PATCH: a key set to null goes, the others are set.
                merged = dict(task.get("checklist", {}))
                for key, item in body.get("checklist", {}).items():
                    if item is None:
                        merged.pop(key, None)
                    else:
                        merged[key] = item
                task["checklist"] = merged
                task["detailsEtag"] = self.etag("details")
            else:
                if "percentComplete" in body:
                    task["percentComplete"] = body["percentComplete"]
                if "title" in body:
                    task["title"] = body["title"]
                if "bucketId" in body:
                    task["bucketId"] = body["bucketId"]
                for user in body.get("assignments", {}):
                    task["assignments"][user] = {}
                task["etag"] = self.etag("task")
            if self.after_patch is not None:
                self.after_patch(self, task)
            return 0, "", ""
        return 1, "", "bad method"

    @staticmethod
    def task_view(t):
        return {
            "id": t["id"],
            "title": t["title"],
            "bucketId": t["bucketId"],
            "percentComplete": t["percentComplete"],
            "assignments": t["assignments"],
            "createdBy": {"user": {"id": t.get("createdBy", ME)}},
            "@odata.etag": t["etag"],
        }


def task(tid, title="A card", assignments=(), description="Old text\nline 2", bucket="backlog"):
    return {
        "id": tid,
        "title": title,
        "bucketId": BUCKETS[bucket],
        "percentComplete": 0,
        "assignments": {a: {} for a in assignments},
        "etag": f'W/"t-{tid}"',
        "description": description,
        "detailsEtag": f'W/"d-{tid}"',
    }


def row(n, action, tid=T1, **extra):
    base = {"n": n, "action": action, "evidence": "backlog.md:12"}
    if action != "create":
        base.update({"taskId": tid, "title": "A card", "etag": f'W/"t-{tid}"', "detailsEtag": f'W/"d-{tid}"'})
    base.update(extra)
    return base


MARKER = {"status": "in_review", "repo": "alpha", "pr": 133, "ref": "backlog.md:273"}
SOURCE = {"file": "alpha/backlog.md", "heading": "2026-10-20 — Cache the Parsed Pages"}
STORY = "As a developer, I want to cache the parsed pages so that a rerun skips the parser."
CRITERIA = ["A rerun reads pages from the cache", "A changed input invalidates its entry", "The cache folder is documented"]


def card(n=1, **extra):
    """A new card in the create-backlog format."""
    value = {
        "n": n,
        "action": "create",
        "evidence": "alpha/backlog.md:40",
        "title": "Cache the Parsed Pages",
        "priority": "Important",
        "userStory": STORY,
        "tasks": ["Add a cache folder per input", "Key entries by the input hash"],
        "acceptanceCriteria": list(CRITERIA),
        "source": dict(SOURCE),
    }
    value.update(extra)
    return value


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.write_config(config())

    def write_config(self, value):
        with open(self.config_path, "w", encoding="utf-8") as f:
            f.write(value if isinstance(value, str) else json.dumps(value))

    @property
    def config_path(self):
        return os.path.join(self.dir.name, "config.json")

    def write(self, rows, **top):
        doc = {"version": 1, "planId": PLAN, "createdAt": "2026-10-27T12:00:00Z", "rows": rows}
        doc.update(top)
        text = json.dumps(doc, ensure_ascii=False, indent=2)
        path = os.path.join(self.dir.name, "proposals.json")
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        return path, hashlib.sha256(text.encode("utf-8")).hexdigest()

    @property
    def confirm_path(self):
        return os.path.join(self.dir.name, "confirm.json")

    @property
    def report_path(self):
        return os.path.join(self.dir.name, "apply.jsonl")

    def confirm(self, sha, selected, age_s=1.0, **override):
        value = {"sha256": sha, "rows": selected, "at": (time.time() - age_s) * 1000}
        value.update(override)
        with open(self.confirm_path, "w", encoding="utf-8") as f:
            json.dump(value, f)

    def run_apply(self, graph, rows, selected, sha=None, confirm=True, clock=time.time, **top):
        path, digest = self.write(rows, **top)
        sha = sha or digest
        if confirm:
            self.confirm(sha, selected)
        return apply.apply(
            path, selected, sha, call=graph, today=TODAY, confirm_path=self.confirm_path, config_path=self.config_path, report_path=self.report_path, clock=clock
        )

    def report_lines(self):
        with open(self.report_path, encoding="utf-8") as f:
            return [json.loads(line) for line in f]

    def results(self, outcome):
        return {r["n"]: r["result"] for r in outcome["rows"]}


class Refusals(Base):
    def assertRefusedUnwritten(self, outcome, graph, needle):
        self.assertEqual(outcome["status"], "aborted")
        self.assertIn(needle, outcome["reason"])
        self.assertEqual(graph.writes, [])

    def test_hash_mismatch_aborts_before_any_call(self):
        g = FakeGraph([task(T1)])
        out = self.run_apply(g, [row(1, "percent", percent=100)], [1], sha="0" * 64)
        self.assertRefusedUnwritten(out, g, "Hash")
        self.assertEqual(g.calls, [])

    def test_forbidden_actions_are_refused(self):
        for action in ("delete", "priority", "checklist", "unassign", "rename"):
            g = FakeGraph([task(T1)])
            out = self.run_apply(g, [row(1, action)], [1])
            self.assertRefusedUnwritten(out, g, "Aktion")

    def test_unknown_keys_are_refused(self):
        g = FakeGraph([task(T1)])
        out = self.run_apply(g, [row(1, "percent", percent=100, priority=1)], [1])
        self.assertRefusedUnwritten(out, g, "priority")

    def test_foreign_user_id_in_the_file_is_refused(self):
        for extra in ({"userId": OTHER}, {"assignee": ME}, {"evidence": f"assign {OTHER}"}):
            g = FakeGraph([task(T1)])
            out = self.run_apply(g, [row(1, "assign", **extra)], [1])
            self.assertRefusedUnwritten(out, g, "")

    def test_ids_with_shell_syntax_are_refused(self):
        for bad in ("x$(touch /tmp/pwned)", "x`id`", 'x"; rm -rf ~; "', "x/../y", ""):
            g = FakeGraph([task(T1)])
            out = self.run_apply(g, [row(1, "percent", tid=bad, percent=100)], [1])
            self.assertRefusedUnwritten(out, g, "taskId")

    def test_bad_values_are_refused(self):
        cases = [
            row(1, "percent", percent=30),
            row(1, "move", bucket="trash"),
            row(1, "marker", marker={**MARKER, "status": "free text"}),
            row(1, "marker", marker={**MARKER, "ref": "see $(id)"}),
            row(1, "marker", marker={**MARKER, "pr": "133"}),
            row(1, "marker", marker={**MARKER, "note": "x"}),
            card(title="Bad\x1b[31m title"),
            card(title="x" * 256),
            card(title=" Padded title"),
        ]
        for bad in cases:
            g = FakeGraph([task(T1)])
            out = self.run_apply(g, [bad], [1])
            self.assertRefusedUnwritten(out, g, "")

    def test_values_of_the_wrong_type_are_refused_not_crashed(self):
        for bad in (row(1, "move", bucket=["done"]), row(1, "marker", marker={"status": ["x"]}), card(priority=["Low"]), card(tasks="one task")):
            g = FakeGraph([task(T1)])
            out = self.run_apply(g, [bad], [1])
            self.assertRefusedUnwritten(out, g, "")

    def test_wrong_plan_and_too_many_rows_are_refused(self):
        g = FakeGraph([task(T1)])
        self.assertRefusedUnwritten(self.run_apply(g, [row(1, "percent", percent=100)], [1], planId="other"), g, "planId")
        rows = [row(i, "percent", tid=f"T{i}", percent=100) for i in range(1, apply.MAX_ROWS + 2)]
        self.assertRefusedUnwritten(self.run_apply(g, rows, [1]), g, "30")

    def test_selection_must_name_existing_rows_once(self):
        g = FakeGraph([task(T1)])
        rows = [row(1, "percent", percent=100)]
        self.assertRefusedUnwritten(self.run_apply(g, rows, [2]), g, "Zeile")
        self.assertRefusedUnwritten(self.run_apply(g, rows, [1, 1]), g, "Zeile")

    def test_two_rows_writing_one_field_are_refused(self):
        g = FakeGraph([task(T1)])
        rows = [row(1, "percent", percent=100), row(2, "percent", percent=50)]
        self.assertRefusedUnwritten(self.run_apply(g, rows, [1, 2]), g, "doppelt")


class Writes(Base):
    def test_percent_move_assign_go_out_in_one_patch_with_the_read_etag(self):
        g = FakeGraph([task(T1)])
        rows = [row(1, "percent", percent=50), row(2, "move", bucket="in_progress"), row(3, "assign")]
        out = self.run_apply(g, rows, [1, 2, 3])
        self.assertEqual(out["status"], "ok")
        self.assertEqual(self.results(out), {1: "ok", 2: "ok", 3: "ok"})
        [(kind, tid, body)] = g.writes
        self.assertEqual((kind, tid), ("patch-task", T1))
        self.assertEqual(body["percentComplete"], 50)
        self.assertEqual(body["bucketId"], BUCKETS["in_progress"])
        self.assertEqual(list(body["assignments"]), [ME])
        patch = next(c for c in g.calls if "patch" in c)
        self.assertIn(f'If-Match=W/"t-{T1}"', patch)

    def test_only_selected_rows_run(self):
        g = FakeGraph([task(T1)])
        rows = [row(1, "percent", percent=100), row(2, "move", bucket="done")]
        out = self.run_apply(g, rows, [2])
        self.assertEqual(self.results(out), {2: "ok"})
        self.assertNotIn("percentComplete", g.writes[0][2])

    def test_a_card_changed_since_the_read_is_skipped(self):
        changed = task(T1)
        changed["etag"] = 'W/"someone-else"'
        g = FakeGraph([changed])
        out = self.run_apply(g, [row(1, "percent", percent=100)], [1])
        self.assertEqual(out["status"], "ok")
        self.assertEqual(self.results(out), {1: "skipped"})
        self.assertEqual(g.writes, [])

    def test_a_412_from_graph_skips_the_row(self):
        g = FakeGraph([task(T1)])

        def race(graph, t):
            t["etag"] = 'W/"raced"'

        g.before_patch = race
        out = self.run_apply(g, [row(1, "move", bucket="done")], [1])
        self.assertEqual(self.results(out), {1: "skipped"})
        self.assertIn("412", out["rows"][0]["detail"])
        self.assertEqual(g.writes, [])

    def test_assign_only_in_in_progress_or_with_a_selected_move_there(self):
        for bucket, rows, selected, expected in (
            ("backlog", [row(1, "assign")], [1], {1: "skipped"}),
            ("sprint_backlog", [row(1, "move", bucket="in_progress"), row(2, "assign")], [2], {2: "skipped"}),
            ("backlog", [row(1, "move", bucket="in_progress"), row(2, "assign")], [1, 2], {1: "ok", 2: "ok"}),
            ("in_progress", [row(1, "assign")], [1], {1: "ok"}),
        ):
            g = FakeGraph([task(T1, bucket=bucket)])
            out = self.run_apply(g, rows, selected)
            self.assertEqual(self.results(out), expected, (bucket, selected))
            if expected == {1: "skipped"} or expected == {2: "skipped"}:
                self.assertEqual(g.writes, [])

    def test_assign_never_touches_a_card_someone_holds(self):
        g = FakeGraph([task(T1, assignments=[OTHER])])
        out = self.run_apply(g, [row(1, "assign")], [1])
        self.assertEqual(self.results(out), {1: "skipped"})
        self.assertEqual(g.writes, [])

    def test_a_foreign_assignment_change_aborts_the_run(self):
        g = FakeGraph([task(T1), task(T2)])

        def drop_other(graph, t):
            t["assignments"][OTHER] = {}

        g.after_patch = drop_other
        rows = [row(1, "percent", percent=100), row(2, "percent", tid=T2, percent=100)]
        out = self.run_apply(g, rows, [1, 2])
        self.assertEqual(out["status"], "aborted")
        self.assertIn("Zuweisung", out["reason"])
        self.assertEqual(len(g.writes), 1)
        self.assertEqual(self.results(out)[2], "not_run")

    def test_marker_goes_on_top_and_keeps_the_rest_byte_identical(self):
        old = "Line `$(id)` and \"quotes\"\r\nsecond line\n\n- [ ] item"
        g = FakeGraph([task(T1, description=old)])
        out = self.run_apply(g, [row(1, "marker", marker=MARKER)], [1])
        self.assertEqual(self.results(out), {1: "ok"})
        new = g.tasks[T1]["description"]
        self.assertEqual(
            new,
            "<!-- board -->\nSTATUS 2026-10-27: in review · PR alpha#133 · ref backlog.md:273\n<!-- /board -->\n\n" + old,
        )
        patch = next(c for c in g.calls if "patch" in c)
        self.assertIn(f'If-Match=W/"d-{T1}"', patch)

    def test_marker_is_idempotent_and_replaces_its_own_block(self):
        old = "Body"
        g = FakeGraph([task(T1, description=old)])
        self.run_apply(g, [row(1, "marker", marker=MARKER)], [1])
        first = g.tasks[T1]["description"]
        details_etag = g.tasks[T1]["detailsEtag"]

        # Same fields again, read after the first write: nothing to change.
        again = row(1, "marker", marker=MARKER, detailsEtag=details_etag)
        out = self.run_apply(g, [again], [1])
        self.assertEqual(self.results(out), {1: "unchanged"})
        self.assertEqual(g.tasks[T1]["description"], first)

        # Planner may hand the text back with CRLF; the block is still found.
        g.tasks[T1]["description"] = first.replace("\n", "\r\n")
        out = self.run_apply(g, [again], [1])
        self.assertEqual(self.results(out), {1: "unchanged"})

        # A new status replaces the block; the body stays as it was.
        moved = row(1, "marker", marker={**MARKER, "status": "done"}, detailsEtag=details_etag)
        g.tasks[T1]["description"] = first
        out = self.run_apply(g, [moved], [1])
        self.assertEqual(self.results(out), {1: "ok"})
        self.assertTrue(g.tasks[T1]["description"].endswith("<!-- /board -->\n\nBody"))
        self.assertEqual(g.tasks[T1]["description"].count("<!-- board -->"), 1)
        self.assertIn("STATUS 2026-10-27: done", g.tasks[T1]["description"])

    def test_marker_without_pr_or_ref_with_a_status_of_the_config(self):
        g = FakeGraph([task(T1, description="")])
        self.run_apply(g, [row(1, "marker", marker={"status": "side_project"})], [1])
        self.assertEqual(g.tasks[T1]["description"], "<!-- board -->\nSTATUS 2026-10-27: side project\n<!-- /board -->")

    def test_backticks_and_quotes_in_a_task_stay_verbatim_and_reach_az_as_one_argument(self):
        task_text = "Fix `rm -rf` and $(whoami) in \"quotes\""
        g = FakeGraph([task(T1)])
        out = self.run_apply(g, [card(tasks=[task_text])], [1])
        self.assertEqual(self.results(out), {1: "ok"})
        patch = next(c for c in g.calls if "patch" in c)
        self.assertEqual(json.loads(patch[patch.index("--body") + 1])["checklist"]["item-01"]["title"], task_text)

    def test_create_skips_a_title_that_exists(self):
        g = FakeGraph([task(T1, title="Same Title")])
        out = self.run_apply(g, [card(title="same title")], [1])
        self.assertEqual(self.results(out), {1: "skipped"})
        self.assertEqual(g.writes, [])

    def test_az_failure_is_an_error_row_not_a_crash(self):
        g = FakeGraph([task(T1)])
        out = self.run_apply(g, [row(1, "percent", tid="Missing1", percent=100)], [1])
        self.assertEqual(self.results(out), {1: "error"})


class Configuration(Base):
    def test_a_missing_or_broken_config_refuses_before_any_call(self):
        missing_az = os.path.join(self.dir.name, "no-az")
        cases = [
            None,
            "{not json",
            config(unknown=1),
            config(planId="bad id"),
            config(azPath=missing_az),
            config(azPath="relative/az"),
            config(ownerId="someone"),
            config(buckets={**BUCKETS, "done": BUCKETS["backlog"]}),
            config(buckets={k: v for k, v in BUCKETS.items() if k != "done"}),
            config(repos={"alpha": "not a slug"}),
            config(extraStatuses=["open"]),
        ]
        for value in cases:
            if value is None:
                os.unlink(self.config_path)
            else:
                self.write_config(value)
            g = FakeGraph([task(T1)])
            out = self.run_apply(g, [row(1, "percent", percent=100)], [1])
            self.assertEqual(out["status"], "aborted", value)
            self.assertIn("Konfiguration", out["reason"])
            self.assertEqual(g.calls, [])
            # The confirmation is spent all the same.
            self.assertFalse(os.path.exists(self.confirm_path))

    def test_the_example_config_holds(self):
        here = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "config.example.json")
        with open(here, encoding="utf-8") as f:
            example = json.load(f)
        self.write_config({**example, "azPath": AZ})
        cfg = apply.load_config(self.config_path)
        self.assertEqual(sorted(cfg.buckets), sorted(apply.BUCKET_KEYS))

    def test_a_status_or_repo_the_config_does_not_name_is_refused(self):
        for marker in ({"status": "mystery"}, {**MARKER, "repo": "gamma"}):
            g = FakeGraph([task(T1)])
            out = self.run_apply(g, [row(1, "marker", marker=marker)], [1])
            self.assertEqual(out["status"], "aborted", marker)
            self.assertEqual(g.writes, [])

    def test_the_plan_bucket_and_owner_come_from_the_config(self):
        other = {k: f"{v[:-1]}9" for k, v in BUCKETS.items()}
        self.write_config(config(planId="PlanFake0000000000000009", buckets=other))
        g = FakeGraph([task(T1)])
        out = self.run_apply(g, [card()], [1], planId="PlanFake0000000000000009")
        self.assertEqual(self.results(out), {1: "ok"})
        (kind, body) = g.writes[0]
        self.assertEqual((body["planId"], body["bucketId"]), ("PlanFake0000000000000009", other["backlog"]))
        g = FakeGraph([task(T1, bucket="in_progress")])
        g.tasks[T1]["bucketId"] = other["in_progress"]
        self.run_apply(g, [row(1, "move", bucket="done"), row(2, "assign")], [1, 2], planId="PlanFake0000000000000009")
        [(kind, tid, body)] = g.writes
        self.assertEqual((body["bucketId"], list(body["assignments"])), (other["done"], [ME]))


class NewCards(Base):
    """A create row is a create-backlog entry; apply.py maps it to Planner as post-backlog does."""

    def test_a_valid_card_goes_out_exactly_as_post_backlog_writes_it(self):
        g = FakeGraph([task(T1)])
        out = self.run_apply(g, [card()], [1])
        self.assertEqual(out["status"], "ok")
        [(kind, body), (patch_kind, new_id, details)] = g.writes
        self.assertEqual((kind, body), ("post", {"planId": PLAN, "bucketId": BUCKETS["backlog"], "title": "Cache the Parsed Pages", "priority": 3}))
        self.assertEqual(patch_kind, "patch-details")
        self.assertEqual(self.results(out), {1: "ok"})
        self.assertEqual(out["rows"][0]["detail"], new_id)
        key = hashlib.sha256(SOURCE["heading"].encode("utf-8")).hexdigest()[:12]
        self.assertEqual(
            details["description"],
            f"<!-- board-src: alpha/backlog.md#{key} -->\n\n"
            "Priority: Important\n\n"
            f"{STORY}\n\n"
            "Acceptance Criteria:\n- A rerun reads pages from the cache\n- A changed input invalidates its entry\n- The cache folder is documented",
        )
        self.assertEqual(
            details["checklist"],
            {
                "item-01": {"@odata.type": "#microsoft.graph.plannerChecklistItem", "title": "Add a cache folder per input", "isChecked": False, "orderHint": " a!"},
                "item-02": {"@odata.type": "#microsoft.graph.plannerChecklistItem", "title": "Key entries by the input hash", "isChecked": False, "orderHint": " b!"},
            },
        )
        # The fake takes a details PATCH only with the new card's details etag; no assignment.
        self.assertEqual(g.tasks[new_id]["assignments"], {})

    def test_tasks_ticked_in_the_entry_start_ticked(self):
        g = FakeGraph([task(T1)])
        out = self.run_apply(g, [card(doneTasks=["key entries by the input hash"])], [1])
        self.assertEqual(out["status"], "ok")
        checklist = g.writes[1][2]["checklist"]
        self.assertEqual([checklist[k]["isChecked"] for k in ("item-01", "item-02")], [False, True])
        # A done task the card does not carry refuses the file before any write.
        g = FakeGraph([task(T1)])
        out = self.run_apply(g, [card(doneTasks=["Some other task"])], [1])
        self.assertEqual(out["status"], "aborted")
        self.assertEqual(g.writes, [])

    def test_the_source_key_matches_the_mod(self):
        # The same literal sits in tests/board.test.tsx.
        self.assertEqual(apply.source_key(SOURCE["heading"]), "1edc5164ebbd")

    def test_the_four_priorities_map_to_planner_numbers(self):
        for label, number in (("Urgent", 1), ("Important", 3), ("Medium", 5), ("Low", 9)):
            g = FakeGraph([task(T1)])
            self.run_apply(g, [card(priority=label)], [1])
            self.assertEqual(g.writes[0][1]["priority"], number)

    def test_more_than_twenty_tasks_go_twenty_to_the_checklist_and_the_rest_below_the_description(self):
        tasks = [f"Task number {i}" for i in range(1, 26)]
        g = FakeGraph([task(T1)])
        out = self.run_apply(g, [card(tasks=tasks)], [1])
        self.assertEqual(self.results(out), {1: "ok"})
        details = g.writes[1][2]
        self.assertEqual([v["title"] for v in details["checklist"].values()], tasks[:20])
        self.assertEqual(list(details["checklist"])[-1], "item-20")
        self.assertEqual([v["orderHint"] for v in details["checklist"].values()][-1], " t!")
        self.assertTrue(details["description"].endswith("\n\nRemaining tasks:\n- Task number 21\n- Task number 22\n- Task number 23\n- Task number 24\n- Task number 25"))

    def test_a_card_off_the_format_refuses_the_file(self):
        cases = [
            card(priority="Must"),
            card(priority="important"),
            card(userStory="As a developer, I want the cache so that reruns are fast."),
            card(userStory="As a developer, I want to cache the parsed pages."),
            card(userStory="As an operator, I want to cache the parsed pages so that reruns are fast."),
            card(userStory="As a developer, I want to cache the parsed pages so that reruns are fast"),
            card(userStory="As a developer, I want to cache pages\nso that reruns are fast."),
            card(acceptanceCriteria=CRITERIA[:2]),
            card(acceptanceCriteria=CRITERIA + ["Fourth criterion", "Fifth criterion", "Sixth criterion"]),
            card(tasks=[]),
            card(tasks=[f"Task {i:03d}" for i in range(41)]),
            card(tasks=["x" * 101]),
            card(tasks=["ok task", "line\nbreak"]),
            card(tasks=["ab"]),
            card(title="Cache the `parsed` Pages"),
            card(title="Cache the *Parsed* Pages"),
            card(title="Cache [the](x) Pages"),
            card(title="2026-10-20 — Cache the Parsed Pages"),
            card(tasks=["Add <!-- board --> here"]),
            card(acceptanceCriteria=CRITERIA[:2] + ["Ends <!-- /board -->"]),
            card(title="Cache Pages 2026-10-20 – Again"),
            card(source={"file": "alpha/backlog.md"}),
            card(source={"file": "../backlog.md", "heading": "x"}),
            card(source={"file": "alpha/backlog.md", "heading": "two\nlines"}),
            {**card(), "bucket": "backlog"},
            {k: v for k, v in card().items() if k != "priority"},
        ]
        for bad in cases:
            g = FakeGraph([task(T1)])
            out = self.run_apply(g, [bad], [1])
            self.assertEqual(out["status"], "aborted", bad)
            self.assertEqual(g.writes, [], bad)

    def test_more_than_fifteen_new_cards_refuse_the_file(self):
        g = FakeGraph([task(T1)])
        rows = [card(n=i, title=f"Cache Part {i}") for i in range(1, 17)]
        out = self.run_apply(g, rows, [1])
        self.assertEqual(out["status"], "aborted")
        self.assertIn("15", out["reason"])
        self.assertEqual(g.writes, [])
        # Fifteen are fine.
        g = FakeGraph([task(T1)])
        self.assertEqual(self.run_apply(g, rows[:15], [1])["status"], "ok")

    def test_a_marker_keeps_the_source_line_on_top(self):
        g = FakeGraph([task(T1)])
        self.run_apply(g, [card()], [1])
        new_id = next(t for t in g.tasks if t != T1)
        first = g.tasks[new_id]["description"]
        source = first.split("\n", 1)[0]
        etag = g.tasks[new_id]["detailsEtag"]
        out = self.run_apply(g, [row(1, "marker", tid=new_id, marker=MARKER, etag=g.tasks[new_id]["etag"], detailsEtag=etag)], [1])
        self.assertEqual(self.results(out), {1: "ok"})
        marked = g.tasks[new_id]["description"]
        self.assertEqual(
            marked,
            source + "\n\n<!-- board -->\nSTATUS 2026-10-27: in review · PR alpha#133 · ref backlog.md:273\n<!-- /board -->\n\n" + first.split("\n\n", 1)[1],
        )
        # The same marker again: nothing to change.
        again = row(1, "marker", tid=new_id, marker=MARKER, etag=g.tasks[new_id]["etag"], detailsEtag=g.tasks[new_id]["detailsEtag"])
        self.assertEqual(self.results(self.run_apply(g, [again], [1])), {1: "unchanged"})

    def test_source_sets_only_the_source_line_of_an_old_card(self):
        old = "Old text\r\nwith `code` and <!-- board -->\nSTATUS 2026-01-01: open\n<!-- /board -->"
        g = FakeGraph([task(T1, description=old)])
        out = self.run_apply(g, [row(1, "source", source=SOURCE)], [1])
        self.assertEqual(self.results(out), {1: "ok"})
        key = hashlib.sha256(SOURCE["heading"].encode("utf-8")).hexdigest()[:12]
        self.assertEqual(g.tasks[T1]["description"], f"<!-- board-src: alpha/backlog.md#{key} -->\n\n" + old)
        [(kind, tid, body)] = g.writes
        self.assertEqual((kind, list(body)), ("patch-details", ["description"]))
        # A card that has its line keeps it.
        again = row(1, "source", source={**SOURCE, "heading": "Another Heading"}, detailsEtag=g.tasks[T1]["detailsEtag"])
        self.assertEqual(self.results(self.run_apply(g, [again], [1])), {1: "skipped"})

    def test_source_and_marker_on_one_card_are_refused(self):
        g = FakeGraph([task(T1)])
        out = self.run_apply(g, [row(1, "source", source=SOURCE), row(2, "marker", marker=MARKER)], [1, 2])
        self.assertEqual(out["status"], "aborted")
        self.assertIn("doppelt", out["reason"])


def rewrite(n=1, tid=T1, **extra):
    """An existing card brought into the create-backlog format."""
    value = row(n, "rewrite", tid)
    value.update(
        {
            "newTitle": "Cache the Parsed Pages",
            "priority": "Important",
            "userStory": STORY,
            "tasks": ["Add a cache folder per input", "Key entries by the input hash"],
            "acceptanceCriteria": list(CRITERIA),
        }
    )
    value.update(extra)
    return value


OLD_CHECKLIST = {
    "a1": {"@odata.type": "#microsoft.graph.plannerChecklistItem", "title": "add a cache folder per input ", "isChecked": True, "orderHint": " !"},
    "b2": {"@odata.type": "#microsoft.graph.plannerChecklistItem", "title": "A task that went", "isChecked": True, "orderHint": " !!"},
}


class Rewrites(Base):
    """A rewrite puts an existing card into the create-backlog format."""

    def old_card(self, title_override="cache pages (todo)", **extra):
        old = task(
            T1,
            title=title_override,
            description="<!-- board-src: alpha/backlog.md#0123456789ab -->\n\n<!-- board -->\nSTATUS 2026-10-01: open · PR alpha#133\n<!-- /board -->\n\nOld free text\nwith lines",
            **extra,
        )
        old["checklist"] = dict(OLD_CHECKLIST)
        return old

    def test_a_rewrite_goes_out_as_two_patches_keeping_source_line_and_marker(self):
        g = FakeGraph([self.old_card()])
        out = self.run_apply(g, [rewrite()], [1])
        self.assertEqual(out["status"], "ok")
        self.assertEqual(self.results(out), {1: "ok"})
        [(kind1, tid1, task_body), (kind2, tid2, details_body)] = g.writes
        self.assertEqual((kind1, tid1, task_body), ("patch-task", T1, {"title": "Cache the Parsed Pages", "priority": 3}))
        self.assertEqual((kind2, tid2), ("patch-details", T1))
        self.assertEqual(
            details_body["description"],
            "<!-- board-src: alpha/backlog.md#0123456789ab -->\n\n"
            "<!-- board -->\nSTATUS 2026-10-01: open · PR alpha#133\n<!-- /board -->\n\n"
            "Priority: Important\n\n"
            f"{STORY}\n\n"
            "Acceptance Criteria:\n- A rerun reads pages from the cache\n- A changed input invalidates its entry\n- The cache folder is documented"
            # Nothing of the old description is lost: it stays word for word below.
            "\n\nPrevious notes:\nOld free text\nwith lines",
        )
        self.assertEqual(
            details_body["checklist"],
            {
                "item-01": {"@odata.type": "#microsoft.graph.plannerChecklistItem", "title": "Add a cache folder per input", "isChecked": True, "orderHint": " a!"},
                "item-02": {"@odata.type": "#microsoft.graph.plannerChecklistItem", "title": "Key entries by the input hash", "isChecked": False, "orderHint": " b!"},
                "a1": None,
            },
        )
        # On the board: the ticked item no task repeats stays, the repeated one carries its tick over.
        self.assertEqual(sorted(g.tasks[T1]["checklist"]), ["b2", "item-01", "item-02"])
        self.assertTrue(g.tasks[T1]["checklist"]["b2"]["isChecked"])
        self.assertEqual(g.tasks[T1]["title"], "Cache the Parsed Pages")
        # Each PATCH went with the etag read before it.
        patches = [c for c in g.calls if "patch" in c]
        self.assertIn(f'If-Match=W/"t-{T1}"', patches[0])
        self.assertIn(f'If-Match=W/"d-{T1}"', patches[1])

    def test_a_card_without_line_or_block_gets_the_plain_body_and_more_than_twenty_tasks_overflow(self):
        g = FakeGraph([task(T1, description="Just text\n\n  with `code`")])
        tasks = [f"Task number {i}" for i in range(1, 23)]
        self.run_apply(g, [rewrite(tasks=tasks)], [1])
        body = g.writes[1][2]
        self.assertTrue(body["description"].startswith("Priority: Important\n\n"))
        self.assertTrue(body["description"].endswith("\n\nRemaining tasks:\n- Task number 21\n- Task number 22\n\nPrevious notes:\nJust text\n\n  with `code`"))
        self.assertEqual(len(body["checklist"]), 20)

    def test_nothing_left_below_line_and_block_gets_no_notes(self):
        g = FakeGraph([task(T1, description="<!-- board -->\nSTATUS 2026-10-01: open\n<!-- /board -->\n\n")])
        self.run_apply(g, [rewrite()], [1])
        self.assertNotIn("Previous notes:", g.writes[1][2]["description"])

    def test_ticks_carry_over_by_lower_case_as_in_the_pane(self):
        # The pane compares with toLowerCase(); the script with lower(), not casefold(): ß stays ß.
        old = task(T1, description="")
        old["checklist"] = {"k1": {"title": "Straße prüfen", "isChecked": True, "orderHint": " !"}}
        g = FakeGraph([old])
        self.run_apply(g, [rewrite(tasks=["STRASSE prüfen", "ADD a cache folder per input"])], [1])
        cl = g.writes[1][2]["checklist"]
        self.assertEqual([v["isChecked"] for v in cl.values() if v is not None], [False, False])
        # The old ticked item stays, as no task repeats it in lower case.
        self.assertIn("k1", g.tasks[T1]["checklist"])

    def test_unticked_old_items_go_ticked_ones_stay_on_their_own_keys(self):
        old = task(T1, description="")
        old["checklist"] = {
            "item-01": {"title": "Ticked and kept", "isChecked": True, "orderHint": " !"},
            "item-02": {"title": "Open and dropped", "isChecked": False, "orderHint": " !!"},
        }
        g = FakeGraph([old])
        self.run_apply(g, [rewrite()], [1])
        cl = g.writes[1][2]["checklist"]
        # The ticked item-01 is not touched; the new tasks take the next free keys, over the unticked item-02.
        self.assertNotIn("item-01", cl)
        self.assertEqual([cl["item-02"]["title"], cl["item-03"]["title"]], ["Add a cache folder per input", "Key entries by the input hash"])
        self.assertEqual(sorted(g.tasks[T1]["checklist"]), ["item-01", "item-02", "item-03"])
        self.assertEqual(g.tasks[T1]["checklist"]["item-01"]["title"], "Ticked and kept")

    def test_ticked_items_and_tasks_past_twenty_skip_the_row_before_any_write(self):
        old = task(T1, description="")
        old["checklist"] = {"k1": {"title": "Ticked, no task repeats it", "isChecked": True, "orderHint": " !"}}
        g = FakeGraph([old])
        out = self.run_apply(g, [rewrite(tasks=[f"Task number {i}" for i in range(1, 21)])], [1])
        self.assertEqual(self.results(out), {1: "skipped"})
        self.assertIn("über 20", out["rows"][0]["detail"])
        self.assertEqual(g.writes, [])

    def test_a_card_someone_else_holds_is_left_alone(self):
        g = FakeGraph([self.old_card(assignments=[OTHER])])
        out = self.run_apply(g, [rewrite()], [1])
        self.assertEqual(self.results(out), {1: "skipped"})
        self.assertEqual(g.writes, [])

    def test_a_card_someone_else_made_is_neither_rewritten_nor_assigned(self):
        made = self.old_card()
        made["createdBy"] = OTHER
        g = FakeGraph([made])
        out = self.run_apply(g, [rewrite(), row(2, "assign")], [1, 2])
        self.assertEqual(self.results(out), {1: "skipped", 2: "skipped"})
        self.assertIn("angelegt", out["rows"][0]["detail"])
        self.assertEqual(g.writes, [])
        # A move on such a card still goes.
        g = FakeGraph([made])
        out = self.run_apply(g, [row(1, "move", bucket="done")], [1])
        self.assertEqual(self.results(out), {1: "ok"})

    def test_a_stop_after_the_task_half_still_reports_the_rewrite(self):
        g = FakeGraph([self.old_card(), task(T2)])

        def someone_joins(graph, t):
            t["assignments"][OTHER] = {}

        g.after_patch = someone_joins
        out = self.run_apply(g, [rewrite(), row(2, "percent", tid=T2, percent=100)], [1, 2])
        self.assertEqual(out["status"], "aborted")
        self.assertEqual(self.results(out), {1: "error", 2: "not_run"})
        self.assertIn("Titel und Priorität neu", out["rows"][0]["detail"])
        self.assertEqual(len(g.writes), 1)

    def test_a_new_title_another_card_carries_is_skipped_before_any_write(self):
        g = FakeGraph([self.old_card(), task(T2, title="cache the parsed pages")])
        out = self.run_apply(g, [rewrite()], [1])
        self.assertEqual(self.results(out), {1: "skipped"})
        self.assertIn("andere Karte", out["rows"][0]["detail"])
        self.assertEqual(g.writes, [])
        # Its own old title does not count.
        g = FakeGraph([self.old_card(title_override="Cache the Parsed Pages")])
        self.assertEqual(self.results(self.run_apply(g, [rewrite()], [1])), {1: "ok"})

    def test_two_rewrites_or_a_rewrite_and_a_create_never_give_out_one_title(self):
        g = FakeGraph([self.old_card(), task(T2, description="old")])
        out = self.run_apply(g, [rewrite(), rewrite(n=2, tid=T2)], [1, 2])
        self.assertEqual(self.results(out), {1: "ok", 2: "skipped"})
        g = FakeGraph([self.old_card()])
        out = self.run_apply(g, [rewrite(), card(n=2)], [1, 2])
        self.assertEqual(self.results(out), {1: "ok", 2: "skipped"})
        self.assertEqual([w[0] for w in g.writes], ["patch-task", "patch-details"])

    def test_a_rewrite_that_does_not_go_keeps_the_old_title_taken(self):
        held = self.old_card(title_override="Keep the Old Title", assignments=[OTHER])
        g = FakeGraph([held])
        out = self.run_apply(g, [rewrite(), card(n=2, title="Keep the Old Title")], [1, 2])
        self.assertEqual(self.results(out), {1: "skipped", 2: "skipped"})
        self.assertEqual(g.writes, [])

    def test_a_changed_card_is_skipped_whole(self):
        changed = self.old_card()
        changed["etag"] = 'W/"someone-else"'
        g = FakeGraph([changed])
        out = self.run_apply(g, [rewrite()], [1])
        self.assertEqual(self.results(out), {1: "skipped"})
        self.assertEqual(g.writes, [])

    def test_a_move_and_a_rewrite_of_one_card_share_one_task_patch(self):
        g = FakeGraph([self.old_card()])
        out = self.run_apply(g, [row(1, "move", bucket="in_review"), rewrite(n=2)], [1, 2])
        self.assertEqual(self.results(out), {1: "ok", 2: "ok"})
        self.assertEqual(g.writes[0][2], {"bucketId": BUCKETS["in_review"], "title": "Cache the Parsed Pages", "priority": 3})

    def test_a_rewrite_off_the_format_or_beside_a_marker_refuses_the_file(self):
        for rows in (
            [rewrite(userStory="As a developer, I want the cache so that reruns are fast.")],
            [rewrite(newTitle="2026-10-20 — Cache the Parsed Pages")],
            [rewrite(acceptanceCriteria=CRITERIA[:2])],
            [rewrite(tasks=[])],
            [rewrite(priority="Must")],
            [{k: v for k, v in rewrite().items() if k != "userStory"}],
            [rewrite(source=SOURCE)],
            [rewrite(), row(2, "marker", marker=MARKER)],
            [rewrite(n=i, tid=f"Task{i:020d}") for i in range(1, 17)],
        ):
            g = FakeGraph([self.old_card()])
            out = self.run_apply(g, rows, [1])
            self.assertEqual(out["status"], "aborted", rows[0])
            self.assertEqual(g.writes, [])


class Confirmation(Base):
    def test_without_confirmation_nothing_runs(self):
        g = FakeGraph([task(T1)])
        out = self.run_apply(g, [row(1, "percent", percent=100)], [1], confirm=False)
        self.assertEqual(out["status"], "aborted")
        self.assertIn("Bestätigung", out["reason"])
        self.assertEqual(g.calls, [])

    def test_stale_or_foreign_confirmation_is_refused_and_consumed(self):
        rows = [row(1, "percent", percent=100), row(2, "move", bucket="done")]
        path, digest = self.write(rows)
        for kwargs in ({"age_s": 121}, {"rows": [1]}, {"sha256": "0" * 64}, {"extra": 1}):
            g = FakeGraph([task(T1)])
            age = kwargs.pop("age_s", 1.0)
            self.confirm(digest, [1, 2], age_s=age, **kwargs)
            out = apply.apply(path, [1, 2], digest, call=g, today=TODAY, confirm_path=self.confirm_path, config_path=self.config_path)
            self.assertEqual(out["status"], "aborted", kwargs)
            self.assertEqual(g.calls, [])
            self.assertFalse(os.path.exists(self.confirm_path))

    def test_a_confirmation_works_once(self):
        g = FakeGraph([task(T1)])
        rows = [row(1, "percent", percent=100)]
        path, digest = self.write(rows)
        self.confirm(digest, [1])
        first = apply.apply(path, [1], digest, call=g, today=TODAY, confirm_path=self.confirm_path, config_path=self.config_path)
        second = apply.apply(path, [1], digest, call=g, today=TODAY, confirm_path=self.confirm_path, config_path=self.config_path)
        self.assertEqual(first["status"], "ok")
        self.assertEqual(second["status"], "aborted")
        self.assertFalse(os.path.exists(self.confirm_path))


class DetailsAndMixed(Base):
    def test_a_description_changed_since_the_read_is_skipped(self):
        changed = task(T1)
        changed["detailsEtag"] = 'W/"edited"'
        g = FakeGraph([changed])
        out = self.run_apply(g, [row(1, "marker", marker=MARKER)], [1])
        self.assertEqual(self.results(out), {1: "skipped"})
        self.assertEqual(g.writes, [])

    def test_a_412_on_the_details_skips_the_row(self):
        g = FakeGraph([task(T1)])

        def race(graph, t):
            t["detailsEtag"] = 'W/"raced"'

        g.before_patch = race
        out = self.run_apply(g, [row(1, "marker", marker=MARKER)], [1])
        self.assertEqual(self.results(out), {1: "skipped"})
        self.assertIn("Precondition Failed", out["rows"][0]["detail"])

    def test_an_error_that_only_mentions_412_is_an_error(self):
        def failing(argv):
            if "patch" in argv:
                return 1, "", "Internal Server Error(500) request-id 4120-aa"
            return g(argv)

        g = FakeGraph([task(T1)])
        path, digest = self.write([row(1, "percent", percent=100)])
        self.confirm(digest, [1])
        out = apply.apply(path, [1], digest, call=failing, today=TODAY, confirm_path=self.confirm_path, config_path=self.config_path)
        self.assertEqual(self.results(out), {1: "error"})

    def test_task_and_marker_rows_of_one_card_use_their_own_etags(self):
        g = FakeGraph([task(T1)])
        rows = [row(1, "move", bucket="done"), row(2, "marker", marker=MARKER)]
        out = self.run_apply(g, rows, [1, 2])
        self.assertEqual(self.results(out), {1: "ok", 2: "ok"})
        patches = [c for c in g.calls if "patch" in c]
        self.assertIn(f'If-Match=W/"t-{T1}"', patches[0])
        self.assertTrue(patches[0][5].endswith(f"/planner/tasks/{T1}"))
        self.assertIn(f'If-Match=W/"d-{T1}"', patches[1])
        self.assertTrue(patches[1][5].endswith(f"/planner/tasks/{T1}/details"))

    def test_rows_of_one_card_with_different_etags_are_refused(self):
        g = FakeGraph([task(T1)])
        rows = [row(1, "move", bucket="done"), row(2, "percent", percent=100, etag='W/"other"')]
        out = self.run_apply(g, rows, [1, 2])
        self.assertEqual(out["status"], "aborted")
        self.assertIn("ETag", out["reason"])


class MarkerEdges(Base):
    def test_a_block_followed_by_one_line_break_is_replaced_not_doubled(self):
        probe = "<!-- board -->\nSTATUS 2026-01-01: open\n<!-- /board -->\nText"
        g = FakeGraph([task(T1, description=probe)])
        out = self.run_apply(g, [row(1, "marker", marker=MARKER)], [1])
        self.assertEqual(self.results(out), {1: "ok"})
        new = g.tasks[T1]["description"]
        self.assertEqual(new.count("<!-- board -->"), 1)
        self.assertTrue(new.endswith("<!-- /board -->\n\nText"))

    def test_the_same_block_with_one_line_break_is_unchanged(self):
        same = "<!-- board -->\nSTATUS 2026-01-01: in review · PR alpha#133 · ref backlog.md:273\n<!-- /board -->\nText"
        g = FakeGraph([task(T1, description=same)])
        out = self.run_apply(g, [row(1, "marker", marker=MARKER)], [1])
        self.assertEqual(self.results(out), {1: "unchanged"})

    def test_a_hand_edited_or_second_block_is_left_alone(self):
        for desc in (
            "<!-- board -->\nSTATUS 2026-01-01: open\nmy own note\n<!-- /board -->\nText",
            "Intro\n<!-- board -->\nSTATUS 2026-01-01: open\n<!-- /board -->",
            "<!-- board -->\nSTATUS 2026-01-01: open\n<!-- /board -->\n\n<!-- board -->\nSTATUS 2026-01-02: done\n<!-- /board -->",
        ):
            g = FakeGraph([task(T1, description=desc)])
            out = self.run_apply(g, [row(1, "marker", marker=MARKER)], [1])
            self.assertEqual(self.results(out), {1: "skipped"}, desc)
            self.assertEqual(g.writes, [])


class PartialRuns(Base):
    def test_each_row_reaches_the_report_before_the_next_card_starts(self):
        g = FakeGraph([task(T1), task(T2)])
        seen_before_second = []

        def watching(argv):
            if T2 in " ".join(argv) and not seen_before_second:
                seen_before_second.append(self.report_lines())
            return g(argv)

        rows = [row(1, "percent", percent=100), row(2, "percent", tid=T2, percent=100)]
        path, digest = self.write(rows)
        self.confirm(digest, [1, 2])
        apply.apply(path, [1, 2], digest, call=watching, today=TODAY, confirm_path=self.confirm_path, config_path=self.config_path, report_path=self.report_path)
        self.assertEqual(seen_before_second[0], [{"n": 1, "result": "ok", "detail": ""}])
        lines = self.report_lines()
        self.assertEqual([line.get("n") for line in lines[:-1]], [1, 2])
        self.assertEqual(lines[-1], {"final": True, "status": "ok", "reason": "", "written": True})

    def test_rows_past_the_time_budget_are_reported_not_run(self):
        g = FakeGraph([task(T1), task(T2)])
        base = time.time()
        # Read by the confirmation, the start, then before each card.
        ticks = iter([base, base, base, base + apply.BUDGET_S + 1])
        # Budget plus the slowest card (five az calls) stays below the mod's kill.
        self.assertLess(apply.BUDGET_S + 5 * apply.AZ_TIMEOUT_S + 30, 330)
        rows = [row(1, "percent", percent=100), row(2, "percent", tid=T2, percent=100)]
        out = self.run_apply(g, rows, [1, 2], clock=lambda: next(ticks))
        self.assertEqual(self.results(out), {1: "ok", 2: "not_run"})
        self.assertEqual(g.tasks[T2]["percentComplete"], 0)

    def test_an_unexpected_failure_after_a_write_stops_and_keeps_the_report(self):
        g = FakeGraph([task(T1), task(T2), task("T3x")])

        def breaking(argv):
            if T2 in " ".join(argv):
                raise TypeError("odd answer")
            return g(argv)

        rows = [row(1, "percent", percent=100), row(2, "percent", tid=T2, percent=100), row(3, "percent", tid="T3x", percent=100)]
        path, digest = self.write(rows)
        self.confirm(digest, [1, 2, 3])
        out = apply.apply(path, [1, 2, 3], digest, call=breaking, today=TODAY, confirm_path=self.confirm_path, config_path=self.config_path, report_path=self.report_path)
        self.assertEqual(out["status"], "aborted")
        self.assertTrue(out["written"])
        self.assertEqual(self.results(out), {1: "ok", 2: "error", 3: "not_run"})
        self.assertEqual(len(self.report_lines()), 4)

    def test_a_created_card_is_reported_even_when_its_answer_is_wrong(self):
        for answer, needle in (({"id": "bad id!"}, "ohne gültige ID"), ({"id": "NEW9x", "assignments": {OTHER: {}}}, "fremder Zuweisung")):
            g = FakeGraph([task(T1)])

            def posting(argv, answer=answer, g=g):
                if "post" in argv:
                    g.writes.append(("post", json.loads(argv[argv.index("--body") + 1])))
                    return 0, json.dumps(answer), ""
                return g(argv)

            rows = [card(), row(2, "percent", percent=100)]
            path, digest = self.write(rows)
            self.confirm(digest, [1, 2])
            out = apply.apply(path, [1, 2], digest, call=posting, today=TODAY, confirm_path=self.confirm_path, config_path=self.config_path)
            self.assertEqual(out["status"], "aborted")
            self.assertEqual(self.results(out), {1: "error", 2: "not_run"})
            self.assertIn(needle, out["rows"][0]["detail"])


class Cli(Base):
    def test_argv_parsing_is_strict(self):
        self.assertEqual(apply.parse_rows("1,2,10"), [1, 2, 10])
        for bad in ("", "1,,2", "a", "1;2", "-1", "1 2", "0"):
            with self.assertRaises(ValueError):
                apply.parse_rows(bad)

    def test_the_shared_hash_fixture_matches_the_mod(self):
        # The same text and digest sit in tests/board.test.ts.
        text = '{"rows":[]}\nÄ'
        path = os.path.join(self.dir.name, "fixture.json")
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        self.assertEqual(apply.file_sha256(path), "38af88d060177d15ab6e4a7e69d4699f52d8c82602adbdceb3874ded67908411")


if __name__ == "__main__":
    unittest.main()
