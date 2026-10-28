# board

A Claude Code plugin that keeps a Microsoft Planner board in step with the backlog files, pull requests and changelog of your GitHub repositories.

## What it does

You press the ` ▦ Board ` button (or type `/board`). The plugin reads your Planner board, your recent PRs and your backlog files, and asks Opus what on the board is out of date. Opus proposes changes: move this card to Done, mark that one as superseded, create a card for a new backlog entry. The proposals appear in a pane called **Board Update**, one row each. You tick the rows you agree with and press **Übernehmen** (apply). A fixed Python script then writes exactly those rows to Planner, and nothing else.

The model never writes to the board itself. It only proposes; the plugin checks every proposal against what it read; you decide; the script writes.

The pane's labels are in German.

## The pane

```
╭─ Board Update ───────────────────────────────────────────────────────────╮
│ 41 Karten · 80 PRs · 37 Backlog-Einträge · 5 Vorschläge                  │
│ [x] → Done  Fix the Cache Race                                           │
│       Beleg: PR api#133 gemergt, CHANGELOG 1.4.0                         │
│       In Review → Done                                                   │
│ [x] Marker „erledigt“ · PR api#133  Fix the Cache Race                   │
│ [x] → Sprint Backlog  Tidy the Docs Folder                               │
│ [ ] → In Progress  Add Retry to the Upload Client                        │
│ [ ] mir zuweisen  Add Retry to the Upload Client                         │
│ [x] neu in Backlog (Important)  API: Cache the Parsed Pages              │
│       Quelle: api/backlog.md › 2026-10-20 — Cache the parsed pages       │
│         A rerun should skip the parser.                                  │
│       Karte:                                                             │
│         API: Cache the Parsed Pages                                      │
│         Priority: Important                                              │
│         As a developer, I want to cache the parsed pages so that a       │
│         rerun skips the parser.                                          │
│         Tasks:                                                           │
│         - [ ] Add a cache folder per input                               │
│         - [x] Hash each input file                                       │
│         Acceptance Criteria:                                             │
│         - A rerun reads pages from the cache                             │
│         - …                                                              │
│ 2 Vorschläge verworfen:                                                  │
│ ✗ neu in Backlog (Medium)  Extract the Flag Helper                       │
│     – userStory nicht „As a developer, I want to … so that ….“           │
│ ✗ mir zuweisen  Fix the Cache Race                                       │
│     – Karte ist schon zugewiesen                                         │
│ [ Übernehmen (4) ]  [ Alle ab ]  [ Abbrechen ]                           │
╰──────────────────────────────────────────────────────────────────────────╯
```

- `[x]` / `[ ]` ticks or unticks a row. Pressing the row itself opens it: the evidence, the value before and after, and for a new card its source entry and the card as it will be written.
- Rows the plugin dropped stay visible, greyed out, with the reason (`✗ …`).
- While it collects or while Opus thinks, the pane shows `Sammelt …` / `Opus denkt …` with a seconds counter and an **Abbrechen** (cancel) button. Opus's answer does not stream.
- After **Übernehmen** each row shows its result as the write script reports it: `ok`, `übersprungen` (skipped), `unverändert` (unchanged), `Fehler` (error), `nicht ausgeführt` (not run) or `unbekannt – auf dem Board prüfen` (unknown, check the board). **Schließen** closes the pane.

## How a run works

1. **Read.** The plugin reads, without a shell (every program gets an argument list):
   - all cards of the plan via `az rest` against Microsoft Graph, and the details (description, checklist) of every card not in Done;
   - the last 40 PRs of each configured repository via `gh pr list`;
   - each backlog file and the changelog via `gh api …/contents` at the configured ref, or from a local working copy;
   - the status files, each backlog source's stand file, and the `create-backlog` skill file.
2. **Opus.** One model call (`opus`, effort `medium`, no tools). All collected data is passed inside a `<data>` block marked as untrusted evidence, never instructions. The `create-backlog` skill file goes into the rules word for word.
3. **Check.** The plugin checks every proposed row against a fixed list of allowed actions and against its own read. Card ids and ETags come from that read, never from the answer. Rows that fail are dropped with a reason. Then the plugin adds its own rows from the stand files (see [Stand files](#stand-files)).
4. **You decide.** The rows appear in the pane. Every row starts ticked, except a move into In Progress and the assignment that goes with it.
5. **Write.** On **Übernehmen** the plugin writes a one-time confirmation and starts the write script (`apply.py`, standard library only) with the proposal file, its SHA-256 hash and the numbers of the ticked rows. The script writes those rows and reports each result.

Run data is kept in `~/.claude/board/`: `snapshot-<time>.json`, `reply-<time>.txt`, `proposals-<time>.json`, `apply-<time>.jsonl` and `last-run.md`.

## Features

- **New cards from backlog entries.** Each `## ` heading in a backlog file is one entry. For an open entry that no card covers yet, Opus writes a new card in the format of the `create-backlog` skill. It takes only the entry's idea and writes the card fresh; it does not copy the entry's wording. Every new card belongs to exactly one entry: the plugin refuses a card whose source heading is not in a backlog file it read. The card gets a hidden line `<!-- board-src: <repo>/<path>#<hash> -->` at the top of its description that ties it to its entry.
- **Label prefix per source.** A backlog source with a `label` gets it in front of each new card's title (`API: Cache the Parsed Pages`). The plugin sets it, not the model.
- **Ticked tasks carried over.** Tasks that the backlog entry marks done with `- [x]` start ticked on the new card's checklist.
- **Linking older cards.** An existing card that already covers an entry but has no `board-src` line can get one (`Quelle setzen`).
- **Sprint Backlog and In Progress from stand files.** Lines under `## Nächster Schritt` and `## In Arbeit` in a stand file move the matching cards. This is plain code, no model.
- **In Progress from your own PRs.** Without a stand file line, the model may start a card only for an open PR of yours whose title or branch names that card. The plugin checks the PR against the list it read.
- **Done from the changelog and PRs.** Opus judges each open card against the changelog head (Unreleased and the two newest releases), the PR list, the backlog files (a heading containing `DONE` marks a finished entry) and the status files. Finished work gets 100 %, a move to Done and a status marker.
- **Status markers.** A small block at the top of a card's description, for example `STATUS 2026-10-28: done · PR api#133 · ref backlog.md:120`. Statuses: `open`, `in_progress`, `in_review`, `done`, `outdated`, `superseded`, `blocked`, plus your own.
- **Broken reply lines dropped alone.** If Opus's reply is in the requested one-row-per-line form and a single line is not valid JSON, only that line is dropped (`kein gültiges JSON`); the other rows go through the normal checks. A reply in any other unparseable form is unusable.
- **Dry run without a surface.** `claude -p "/board"` prints the proposal table to the log and writes nothing.
- **Reminder.** At the start of a session a toast says when the last review is more than 7 days old, or that there has never been one.

What it never does: delete cards, rename cards, assign anyone other than you, write free text to the board, or rewrite existing cards. A rewrite action still exists in the code but is switched off; any rewrite row the model sends is dropped (`neu fassen ist abgeschaltet`).

## Requirements

- **Claude Code** with plugin hooks modules, on a surface that can draw panes. The ` ▦ Board ` button sits beside the hint line in fullscreen mode (when the line has room) and above the prompt otherwise. `/board` starts a run as well.
- **Azure CLI** (`az`), logged in (`az login`) with an account that can read and write the plan. The plugin uses `az rest` against Microsoft Graph.
- **GitHub CLI** (`gh`), logged in (`gh auth login`), with read access to the configured repositories.
- **Python 3** for the write script (standard library only).
- **The `create-backlog` skill** as a file, by default `~/.claude/skills/create-backlog/SKILL.md`. Without it the plugin still runs but proposes no new cards.

## Installation

The repository is its own single-plugin marketplace (marketplace `board`, plugin `board`):

```
/plugin marketplace add m-tababi/board
/plugin install board@board
```

Others can install it this way only while the GitHub repository is public.

Then write your config (next section). It is also worth adding these rules to `permissions.deny` in `~/.claude/settings.json`, so the main model cannot run the write script by hand. The first covers a clone in a folder named `board`, the second the installed copy under `~/.claude/plugins/cache/`:

```json
"Bash(*board/apply.py*)",
"Bash(*board/*/apply.py*)"
```

For development, `claude --plugin-dir /path/to/board` loads a clone for one session.

## Configuration

Copy `config.example.json` to `~/.claude/board/config.json` and fill it in. The plugin and the write script read the same file and both refuse to run when it is missing or does not hold. The file stays on your machine and outside any repository; `.gitignore` lists `config.json` in case a copy ends up in the clone. Unknown fields are refused.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `azPath` | string | yes | Absolute path of the `az` executable. The write script also checks that it is executable. |
| `planId` | string | yes | The Planner plan's id. |
| `buckets` | object | yes | The plan's bucket ids under exactly these keys: `backlog`, `sprint_backlog`, `in_progress`, `in_review`, `done`. No id twice. |
| `ownerId` | string (GUID) | yes | Your Microsoft Entra user id. The only person the plugin ever assigns. |
| `ownerLogin` | string | yes | Your GitHub login. Only your open PRs can start a card, and a card tied to someone else's PR is never assigned to you. |
| `repos` | object | yes | Short name → `owner/repo`. The short name is what markers and backlog sources refer to (`PR api#133`). Each repository's last 40 PRs are read. |
| `backlogSources` | array | yes | The backlog files, see below. May be empty. |
| `changelog` | object | no | One changelog file: `repo`, `path`, `ref`, optional `local`. Its head (Unreleased and the two newest releases) is read. |
| `statusFiles` | string[] | no | Local files given to the model as context; absolute or `~/…`. A file that cannot be read stops the run before the model call, unless it is also a stand file. |
| `skillPath` | string | no | The `create-backlog` skill file; default `~/.claude/skills/create-backlog/SKILL.md`. |
| `skipTitlePrefixes` | string[] | no | Cards whose title starts with one of these (case aside) are never touched. |
| `promptRules` | string[] | no | Extra rules for your board, one English sentence each, appended to the model's rules. |
| `extraStatuses` | string[] | no | Marker statuses beyond the built-in ones; lower case, `_` for spaces, at most 20 characters. |
| `ghPath` | string | no | Absolute path of `gh`; default `/usr/bin/gh`. |
| `pythonPath` | string | no | Absolute path of `python3`; default `/usr/bin/python3`. |
| `standFile` | – | no | Older key, accepted and ignored. Use `stand` on a backlog source instead. |

Each entry of `backlogSources`:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `repo` | string | yes | A short name from `repos`. |
| `path` | string | yes | Path of the backlog file in that repository. |
| `ref` | string | yes | Branch or ref to read it from. |
| `local` | string | no | Read this working copy instead of the file on GitHub, for example a backlog file that is not committed. `~/` is expanded. |
| `label` | string | no | Put in front of every new card's title from this source as `<label>: `. Letters, digits, spaces and hyphens, 1–30 characters. |
| `stand` | string | no | This source's stand file, absolute or `~/…`. See [Stand files](#stand-files). |

Example with made-up values:

```json
{
  "azPath": "/usr/local/bin/az",
  "planId": "ExamplePlanId0000000000001",
  "buckets": {
    "backlog": "ExampleBucketBacklog000001",
    "sprint_backlog": "ExampleBucketSprint0000001",
    "in_progress": "ExampleBucketProgress00001",
    "in_review": "ExampleBucketReview0000001",
    "done": "ExampleBucketDone000000001"
  },
  "ownerId": "00000000-0000-4000-8000-000000000000",
  "ownerLogin": "your-github-login",
  "repos": {
    "api": "your-github-login/api",
    "docs": "your-github-login/docs"
  },
  "backlogSources": [
    { "repo": "api", "path": "backlog.md", "ref": "main", "label": "API", "stand": "~/notes/api-status.md" },
    { "repo": "docs", "path": "backlog.md", "ref": "main", "local": "~/src/docs/backlog.md" }
  ],
  "changelog": { "repo": "api", "path": "CHANGELOG.md", "ref": "main" },
  "statusFiles": ["~/notes/api-status.md"],
  "skipTitlePrefixes": ["Meeting:"],
  "promptRules": ["Cards about the release checklist stay in Backlog."],
  "extraStatuses": ["waiting"]
}
```

## Stand files

A stand file is a local Markdown file in which you note what you are doing next and what you are working on. Each backlog source can name one with `stand`. Two of its sections move that source's cards:

```markdown
## Nächster Schritt

- Tidy the docs folder

## In Arbeit

- Add retry to the upload client
```

- A line under `## Nächster Schritt` moves the card from Backlog to **Sprint Backlog**. The row starts ticked.
- A line under `## In Arbeit` moves the card from Backlog or Sprint Backlog to **In Progress** and assigns it to you. Both rows start unticked. A card named in both sections goes to In Progress.
- A line matches when it is exactly the title of an entry in the same source's backlog file: the entry's `## ` heading without a leading `YYYY-MM-DD — ` date. The comparison ignores a list marker (`- `, `* `, `1. `), surrounding spaces, runs of spaces and case. Backticks count. A title shared by two entries matches neither.
- The card is found through its `board-src` line, never by its title. It must be a card you created. A card already in the target column, or further right, gets no row. An entry without a card gets no move; the create comes first, the move in a later run.
- A section runs from its heading to the next `#` or `##` heading. Other sections and any other text in the file are ignored, and so is prose around a title.
- If the model moves the same card (to In Review or Done, say), its row wins and the stand file row is left out.
- A stand file that cannot be read, or that lacks one of the two sections, moves nothing for its source. The pane says so (`api-status.md: kein Abschnitt In Arbeit`) and the run goes on.
- Removing a line from the stand file does not move the card back.

## Card format and limits

New cards follow the `create-backlog` skill and are mapped to Planner the way the `post-backlog` skill does it. The plugin and the write script both check what a machine can check:

- **Title:** 3–255 characters, one line, no date prefix, no backticks, no `*`, `[` or `](`.
- **Priority:** `Urgent`, `Important`, `Medium` or `Low` (Planner priority 1, 3, 5, 9).
- **User story:** exactly `As a developer, I want to … so that ….`
- **Tasks:** 1–40, each one line of 3–100 characters. A longer task is cut to 97 characters plus `...`.
- **Acceptance criteria:** 3–5, each one line of 3–200 characters.
- No `<!--` in story, tasks or criteria, and no control characters in any field.
- **On the card:** the description holds the `board-src` line, `Priority`, the user story and the acceptance criteria. The first 20 tasks become the checklist; any further tasks go into the description under `Remaining tasks:`. New cards go to Backlog, unassigned.
- **No duplicates:** the source entry must not be in a `DONE` section, no open card may already carry its `board-src` line, no open card may have the same title (date, backticks and punctuation aside), and no card at all may have the exact title.

"English" is asked of the model, not checked. Whether a card's content fits its source entry is not checked by machine either; the pane shows the source heading and the entry's first lines right above the card, so you can compare before you apply.

Limits per run:

| Limit | Value |
| --- | --- |
| Rows in total | 30 (stand file rows first, the model's rows fill the rest) |
| New cards | 15 |
| Length of Opus's reply | 32 000 tokens |

## Safety model

- **One-time confirmation.** The write script runs only with a confirmation file the plugin writes after you press **Übernehmen**. It must be at most 120 s old and name the same hash and the same rows. The script deletes it on reading.
- **Hash of what you saw.** The proposal file is read once, hashed and parsed from those same bytes. A different hash refuses the run.
- **The script checks again.** It refuses the whole file on unknown fields or actions, any user id in the file, or bad ids or ETags. Before each write it reads the card live: every write carries `If-Match` with the ETag the plugin read, and a card changed since is skipped. It assigns only a free card you created that is, or is being moved, in In Progress, and it compares assignments before and after; an unexpected change stops the run.
- **Bounded time.** No card starts after 120 s, each `az` call is cut at 30 s, and the plugin stops the script at 330 s. A row without a reported result is shown as unknown.
- **Guards.** A hook refuses Bash commands that name the write script by its path or run `apply.py` with a Python interpreter. Write, Edit and NotebookEdit calls on the confirmation or proposal files in `~/.claude/board/` are refused too. Together with the deny rules above they catch accidents. They are a tripwire, not a boundary: a command that reaches the script without naming it gets past them.
- **Config outside the repository.** Plan, buckets, user id, repositories and paths live only in `~/.claude/board/config.json`. Nothing about your board is in this repository.
- **Honest limits.** If your settings already let the model write to Planner by other means (an MCP server, `az` in an allowed command), the plugin adds no barrier against that. The real boundary is who holds the Planner rights.

## Development

```
python -m pytest tests/        # the write script against a fake Graph and a made-up config
claude plugin test .           # plugin logic, the pane and the run
claude plugin validate .
```

`tsconfig.json` extends `.claude-plugin/types/tsconfig.json`, which Claude Code writes when it loads the plugin from a folder. Run `tsc -p .` after the plugin has been loaded once.

```
.claude-plugin/
  plugin.json        manifest
  marketplace.json   single-plugin marketplace pointing at this repository
hooks/
  hooks.json         names the hooks module
  register.tsx       reading, the model call, the pane, the button, the guards, the reminder
  board.ts           pure logic: config check, prompt, proposal checks, guard, texts
types/index.d.ts     state contract
tests/
  board.test.tsx     plugin tests
  test_apply.py      write script tests
apply.py             the write script (standard library only)
config.example.json  every config field with made-up values
```

## License

MIT, see [LICENSE](LICENSE). Copyright Mohamed Tababi.
