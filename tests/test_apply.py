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
            }
            return 0, json.dumps(self.task_view(self.tasks[new_id])), ""
        task = self.tasks.get(parts[2])
        if task is None:
            return 1, "", "Not Found(404)"
        is_details = len(parts) == 4 and parts[3] == "details"
        if method == "get":
            if is_details:
                return 0, json.dumps({"description": task["description"], "@odata.etag": task["detailsEtag"]}), ""
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
                task["detailsEtag"] = self.etag("details")
            else:
                if "percentComplete" in body:
                    task["percentComplete"] = body["percentComplete"]
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
            row(1, "create", title="Bad\x1b[31m title", bucket="backlog", assign=False),
            row(1, "create", title="x" * 71, bucket="backlog", assign=False),
            row(1, "create", title=" Padded title", bucket="backlog", assign=False),
        ]
        for bad in cases:
            g = FakeGraph([task(T1)])
            out = self.run_apply(g, [bad], [1])
            self.assertRefusedUnwritten(out, g, "")

    def test_values_of_the_wrong_type_are_refused_not_crashed(self):
        for bad in (row(1, "move", bucket=["done"]), row(1, "marker", marker={"status": ["x"]}), row(1, "create", title="Card", bucket={}, assign=False)):
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
        rows = [row(1, "percent", percent=100), row(2, "move", bucket="done"), row(3, "assign")]
        out = self.run_apply(g, rows, [1, 2, 3])
        self.assertEqual(out["status"], "ok")
        self.assertEqual(self.results(out), {1: "ok", 2: "ok", 3: "ok"})
        [(kind, tid, body)] = g.writes
        self.assertEqual((kind, tid), ("patch-task", T1))
        self.assertEqual(body["percentComplete"], 100)
        self.assertEqual(body["bucketId"], BUCKETS["done"])
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

    def test_titles_with_backticks_stay_verbatim_and_reach_az_as_one_argument(self):
        title = "Fix `rm -rf` and $(whoami) in \"quotes\""
        g = FakeGraph([task(T1)])
        rows = [row(1, "create", title=title, bucket="backlog", assign=True, marker=MARKER)]
        out = self.run_apply(g, rows, [1])
        self.assertEqual(self.results(out), {1: "ok"})
        kind, body = g.writes[0]
        self.assertEqual((kind, body["title"]), ("post", title))
        self.assertEqual(body["planId"], PLAN)
        self.assertEqual(list(body["assignments"]), [ME])
        post = next(c for c in g.calls if "post" in c)
        self.assertEqual(json.loads(post[post.index("--body") + 1])["title"], title)
        created = next(t for t in g.tasks.values() if t["id"] != T1)
        self.assertTrue(created["description"].startswith("<!-- board -->\nSTATUS 2026-10-27: in review"))

    def test_create_skips_a_title_that_exists(self):
        g = FakeGraph([task(T1, title="Same Title")])
        out = self.run_apply(g, [row(1, "create", title="same title", bucket="backlog", assign=False)], [1])
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
        out = self.run_apply(g, [row(1, "create", title="New Card", bucket="done", assign=True)], [1], planId="PlanFake0000000000000009")
        self.assertEqual(self.results(out), {1: "ok"})
        [(kind, body)] = g.writes
        self.assertEqual((body["planId"], body["bucketId"], list(body["assignments"])), ("PlanFake0000000000000009", other["done"], [ME]))


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

            rows = [row(1, "create", title="New Card", bucket="backlog", assign=False), row(2, "percent", percent=100)]
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
