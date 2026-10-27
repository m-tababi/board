# board

A Claude Code mod that reconciles a Microsoft Planner board with the state of your GitHub repositories. A button (` ▦ Board `) or `/board` collects the board, the PR list and your backlog files; Opus proposes changes; you confirm; a fixed script writes only the confirmed rows.

Everything about your board (plan, buckets, your user id, repositories, paths) lives in a local config file outside the repository: `~/.claude/board/config.json`. The repository holds no personal values.

## Flow

1. **Collect** without a shell (`$.process.run` with an argument list):
   - Board: `az rest` GET on the plan's cards, plus the details (description, checklist, ETag) of every card not in Done. Every id is checked against `^[A-Za-z0-9_-]+$` before it enters a URL.
   - Repositories: `gh api …/contents/<path>?ref=<ref>` for each backlog source and the changelog, `gh pr list --json` with metadata only (title, author, state, branch) for each configured repository. No `git fetch`.
   - Status files (`statusFiles`): read only; an unreadable one stops the run before the model. No card read, or a missing or broken config, stops the run too.
2. **Judge:** `$.model.complete` with `opus`, `effort: medium`, no tools. All data sits as untrusted material inside a `<data>` block.
3. **Check:** the mod checks the JSON answer against a positive list and drops rows with a reason. Ids, ETags and titles come from its own read, never from the answer. At most 30 rows.
4. **Show:** table `Nr | Karte | Aktion | Beleg` via `$.ui.log`, control characters removed.
5. **Ask:** `$.ui.ask` — only `ja`, `nein` or, under "Other", `ja außer 3, 7`; anything else stops.
6. **Write:** the mod writes `~/.claude/board/confirm.json` (hash, rows, time) and starts `<pythonPath> -I apply.py --proposals <file> --rows <n,…> --sha256 <hash> --report apply-<time>.jsonl`. apply.py runs only with that confirmation (at most 120 s old, same hash, same rows) and deletes it on reading (one-time token). Each row's result lands in the report at once (JSONL, fsynced). After 120 s apply.py starts no further card; the mod kills it at 330 s and then shows the rows from the report, and any selected row without an entry as "unknown – check the board".

Run data lives in `~/.claude/board/`: `snapshot-<time>.json`, `reply-<time>.txt`, `proposals-<time>.json`, `apply-<time>.jsonl`, `last-run.md`.

## Actions apply.py allows

| Action | Effect |
|---|---|
| `marker` | block `<!-- board -->` / `STATUS <date>: <status> · PR <repo>#<nr> · ref <path:line>` / `<!-- /board -->` at the top of the description; the rest byte-identical; only when the content changes |
| `percent` | 0, 50 or 100 % |
| `move` | bucket Backlog, Sprint Backlog, In Progress, In Review, Done |
| `assign` | assign the owner (`ownerId` from the config), only when the card is free |
| `create` | new card (title, bucket, optionally the owner, optionally a marker block) |

Not allowed: deleting, foreign assignments, priorities, checklists, renames, free text on the board.

## Configuration

Copy `config.example.json` to `~/.claude/board/config.json` and fill it in. The mod and apply.py read the same file; apply.py checks it itself and refuses to run when it is missing or broken.

## Tests

```bash
python -m pytest tests/        # apply.py against a fake Graph and a made-up config
claude plugin test .           # mod logic and flow
claude plugin validate .
```
