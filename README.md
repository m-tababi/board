# board

A Claude Code plugin that keeps a Microsoft Planner board in step with your GitHub repositories. A button (` ▦ Board `) or `/board` opens a docked pane, **Board Update**: the plugin reads the board, the PR list and your backlog files, Opus proposes changes, you check or uncheck each one, and a fixed script writes only the rows you took over.

- Finished work moves to Done, moved work changes columns, stale cards get a status marker.
- New backlog entries become cards in the format of the `create-backlog` skill. Opus never invents a task: every new card belongs to exactly one entry of a backlog file.
- The next steps named in your stand file can be pulled into the Sprint Backlog.
- Nothing about your board is in this repository. Plan, buckets, user id, repositories and paths live in a local config file.

The pane's labels are German.

## The pane

While it runs:

```
Opus denkt … 31 s
53 Karten · 80 PRs · 106 Backlog-Einträge
[ Abbrechen ]
```

With the proposals:

```
53 Karten · 80 PRs · 106 Backlog-Einträge · 4 Vorschläge
[x] → Done  Fix Cache Race
      Beleg: PR #133 merged, CHANGELOG 0.12.0
      In Review → Done
[x] Marker „erledigt“ · PR app#133  Fix Cache Race
[ ] → Sprint Backlog  Tidy the Docs Folder
[x] neu in Backlog (Important)  Cache the Parsed Pages
      Quelle: app/backlog.md › 2026-10-20 — Cache the Parsed Pages
        A rerun should skip the parser.
      Karte:
        Cache the Parsed Pages
        Priority: Important
        As a developer, I want to cache the parsed pages so that a rerun skips the parser.
        Tasks:
        - Add a cache folder per input
        Acceptance Criteria:
        - A rerun reads pages from the cache
        - …
2 Vorschläge verworfen: …
[ Übernehmen (3) ]  [ Alle ab ]  [ Abbrechen ]
```

`[x]` / `[ ]` checks or unchecks a row; a press on the row opens its evidence, the value before and after and, for a new card, its source entry and the card as it will stand. After **Übernehmen** each row shows its result (`ok`, `übersprungen`, `unverändert`, `Fehler`, `nicht ausgeführt`, `unbekannt – auf dem Board prüfen`) as the write script reports it; **Schließen** closes the pane.

The phases are `collecting`, `thinking`, `ready`, `applying` and `done` (or `failed`, with the reason). The seconds redraw once a second while a phase runs; Opus's answer does not stream, so there is no live text.

## Requirements

- Claude Code with plugin hooks modules (the early-access function-hooks API). Its test kit ran on Claude Code 2.1.311; a live run on a real board is still to come. A surface that draws panes: the terminal (fullscreen) or the desktop app.
- [Azure CLI](https://learn.microsoft.com/cli/azure/) (`az`), signed in (`az login`) with an account that can read and write the plan. The plugin calls `az rest` against Microsoft Graph.
- [GitHub CLI](https://cli.github.com/) (`gh`), signed in (`gh auth login`), with read access to the configured repositories.
- `python3` (3.8 or newer, standard library only) for the write script.
- The `create-backlog` skill as a file (default `~/.claude/skills/create-backlog/SKILL.md`). Without it the plugin still runs but creates no cards.

## Installation

```
/plugin install board --marketplace m-tababi/board
```

Then write your config (next section) and add these rules to `permissions.deny` in `~/.claude/settings.json`. The first covers a clone in a folder named `board`, the second the installed copy (`~/.claude/plugins/cache/<marketplace>/board/<version>/apply.py`):

```json
"Bash(*board/apply.py*)",
"Bash(*board/*/apply.py*)"
```

Like the plugin's own guard they are a tripwire, not a boundary: they match the command's text, so a command that reaches the script without naming that path (a variable, a `cd` first, a renamed copy) gets past them.

For development, `claude --plugin-dir /path/to/board` loads a clone for one session.

## Configuration

Copy `config.example.json` to `~/.claude/board/config.json` and fill it in. The plugin and the write script read the same file; the write script checks it itself and refuses to write when it is missing or broken. The file stays on your machine; never commit it (`.gitignore` lists `config.json`).

| Field | Required | Meaning |
| --- | --- | --- |
| `azPath` | yes | Absolute path of the `az` executable. |
| `planId` | yes | The Planner plan's id (`az rest --method get --url https://graph.microsoft.com/v1.0/me/planner/plans`). |
| `buckets` | yes | The plan's bucket ids under exactly these keys: `backlog`, `sprint_backlog`, `in_progress`, `in_review`, `done`. |
| `ownerId` | yes | Your Entra user id (a GUID). The only person the plugin ever assigns. |
| `ownerLogin` | yes | Your GitHub login. Cards tied to a PR by anyone else are never assigned to you. |
| `repos` | yes | Short name → `owner/repo`. The short name is what a status marker names (`PR app#133`); each repository's last 40 PRs are read as metadata. |
| `backlogSources` | yes | Backlog files read from GitHub: `[{ "repo": <short name>, "path": "backlog.md", "ref": "main" }]`. Each `## ` heading is one entry; a heading containing `DONE` marks a finished entry. |
| `changelog` | no | One changelog file, same shape; its head (Unreleased and the two newest releases) is read. |
| `statusFiles` | no | Local files read as context (absolute or `~/…`). One that cannot be read stops the run before the model. |
| `standFile` | no | A local file with a `Nächster Schritt` / `Next step` heading. Only work named in that section is pulled into the Sprint Backlog. Without it no card is moved there. |
| `skillPath` | no | The `create-backlog` skill file; default `~/.claude/skills/create-backlog/SKILL.md`. |
| `skipTitlePrefixes` | no | Cards whose title starts with one of these (case aside) are never touched. |
| `promptRules` | no | Extra rules for this board, one English sentence each, appended to the model's rules. |
| `extraStatuses` | no | Marker statuses beyond `open`, `in_progress`, `in_review`, `done`, `outdated`, `superseded`, `blocked` (lower case, `_` for spaces). |
| `ghPath`, `pythonPath` | no | Absolute paths; defaults `/usr/bin/gh` and `/usr/bin/python3`. |

## What a run does

1. **Collect** without a shell (each program started with an argument list): the plan's cards via `az rest` GET, the details (description, checklist, ETag) of every card not in Done, the PR metadata via `gh pr list --json`, the backlog files and the changelog via `gh api …/contents`, the status and stand files, the skill file. Every id is checked against `^[A-Za-z0-9_-]+$` before it enters a URL.
2. **Judge:** one `$.model.complete` call, `opus`, `effort: medium`, no tools. All collected data sits as untrusted material inside a `<data>` block; the skill file goes into the rules word for word.
3. **Check:** the plugin checks every proposed row against a positive list and drops what does not hold, with a reason shown in the pane. Ids, ETags and titles come from its own read, never from the answer. At most 30 rows.
4. **Show** them in the pane. **Übernehmen** writes `~/.claude/board/confirm.json` (hash of the proposal file, the checked rows, the time) and starts `python3 -I apply.py --proposals <file> --rows <n,…> --sha256 <hash> --report <file>.jsonl`.

Run data lives in `~/.claude/board/`: `snapshot-<time>.json`, `reply-<time>.txt`, `proposals-<time>.json`, `apply-<time>.jsonl`, `last-run.md`.

### Actions

| Action | Effect on the board |
| --- | --- |
| `percent` | 0, 50 or 100 %. |
| `move` | Another bucket. Into the Sprint Backlog only from Backlog, for a step named in the stand file, at most 3 per run, never assigned. |
| `assign` | Assigns the owner, only on a free card in In Progress. |
| `marker` | A block `<!-- board -->` / `STATUS <date>: <status> · PR <repo>#<nr> · ref <path:line>` / `<!-- /board -->` at the top of the description; the rest stays byte-identical. A block edited by hand, or a second one, is left alone. |
| `create` | A new card in Backlog, unassigned, at most 5 per run, mapped as the `post-backlog` skill does: the title without the date, priority Urgent 1 / Important 3 / Medium 5 / Low 9, a description of `Priority`, user story and acceptance criteria, the tasks as checklist (at most 20, the rest under `Remaining tasks:`). A line `<!-- board-src: <file>#<hash of the heading> -->` on top names the entry; markers go below it. |
| `source` | Puts only that `board-src` line on top of an older card that covers an entry but has none. |

Not possible: deleting cards, renaming, assigning anyone else, writing free text.

### What a new card must be

The source of truth for the format is the `create-backlog` skill itself. The plugin and the write script check what a machine can check, and drop or refuse anything else:

- Title 3–70 characters, one line, no date prefix (`2026-10-20 — …`), no backticks, no `*`, `_`, `[` or `](`.
- Priority one of `Urgent`, `Important`, `Medium`, `Low`.
- User story `As a developer, I want to … so that ….`
- 1–40 tasks of 3–100 characters, 3–5 acceptance criteria of 3–200 characters; no line breaks or control characters in any field.
- The source heading is an entry of a backlog file that was read, not in a `DONE` section, and no open card already carries its `board-src` line; no open card has the same title (date, backticks and punctuation aside), and no card at all has the exact title.

"English" is asked of the model, not checked; the text is in the pane before you take it over.

That a new card's title and content fit its source entry is **not** checked by machine: headings may be in another language than the English card, so no rule can compare them. The pane shows each new card's source heading and the entry's first lines right above the card; checking that they belong together is yours before Übernehmen.

## Security model

- **One-time confirmation.** The write script runs only with `confirm.json` written by the plugin after the press on Übernehmen: at most 120 s old, the same hash, the same rows. It deletes the file on reading; a left-over one is deleted at the start of each run.
- **Hash of what you saw.** The proposal file is read once, hashed and parsed from those bytes; a different hash refuses the run.
- **Strict schema.** Unknown fields, unknown actions, a user id anywhere in the file, bad ids or ETags refuse the whole file before any write.
- **Optimistic writes.** Every PATCH carries `If-Match` with the ETag read before; a card changed since, or a 412, is skipped. Assignments are compared before and after each task PATCH; an unexpected change stops the run.
- **Bounded time.** No card starts after 120 s, each `az` call is cut at 30 s, the plugin kills the script at 330 s and shows every row the JSONL report holds; a row without a line is marked unknown.
- **Guard.** A `tool.call` hook refuses Bash commands that literally name the write script by its path (`board/apply.py`, or a cache copy `board/<version>/apply.py`) or run `apply.py` with a python interpreter, whatever wraps it (`sh -c`, `eval`, `sudo`, `if … then`). The mod's test file (`tests/test_apply.py`) and `python -m pytest tests/` pass. A heredoc or a commit message that names the script may trip it too. Together with the deny rules above it catches accidents.
- **Run files.** Write, Edit and NotebookEdit calls on `~/.claude/board/confirm.json` or a `proposals-*.json` there are refused (with `~`, `.` and `..` resolved); only the plugin itself writes them.
- **Honest limits.** The guard is a tripwire, not a boundary: a variable or a renamed copy gets past it, and a shell command (`echo … > confirm.json`) can still write a confirmation. If your settings already let the model write to Planner (an MCP server, `az` in an allowed command), the plugin adds no barrier against that. The real boundary is who holds the Planner rights.

## The reminder

At the start of an interactive session a toast says when the last review is more than 7 days old. A review is a run that wrote at least one row (or found it already so), a run with nothing to propose, or a deliberate no (Abbrechen after the proposals were shown or while Opus judged, Übernehmen with nothing checked); the last kinds only when every card could be read.

Without a surface (`claude -p "/board"`) the run is a dry run: the proposal table goes to the log and nothing is written.

## Development

```
python -m pytest tests/        # the write script against a fake Graph and a made-up config
claude plugin test .           # plugin logic, the pane and the run
claude plugin validate .
```

`tsconfig.json` extends `.claude-plugin/types/tsconfig.json`, which Claude Code writes when it loads the plugin from a folder; run `tsc -p .` after it has loaded the plugin once.

```
.claude-plugin/
  plugin.json        manifest
  marketplace.json   single-plugin marketplace pointing at this repository
hooks/
  hooks.json         names the hooks module
  register.tsx       collecting, the model call, the pane, the pill, the guard, the reminder
  board.ts           pure logic: config check, prompt, proposal checks, guard, texts
types/index.d.ts     state contract (PluginState)
tests/
  board.test.tsx     plugin tests
  test_apply.py      write-script tests
apply.py             the write script (standard library only)
config.example.json  every config field with made-up values
tsconfig.json
```

## License

MIT
