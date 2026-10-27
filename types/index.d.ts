// Session-scoped values; each lives in $.state so a hot reload keeps it.
export type BoardFlag = boolean

// Where a run stands, as the pane draws it.
export type BoardPhase = 'idle' | 'collecting' | 'thinking' | 'ready' | 'applying' | 'done' | 'failed'

// One proposal in the pane: checkbox, change, card; opened, evidence and before -> after.
export type BoardRow = { n: number; card: string; change: string; why: string; before: string; after: string; isChecked: boolean; isOpen: boolean }

// One row's result from apply.py's report.
export type BoardResult = { n: number; result: string; detail: string }

// What the run has read so far; -1 while not yet known.
export type BoardCounts = { cards: number; prs: number; backlog: number; unreadable: number; dropped: string[] }

declare module 'claude-code' {
  interface PluginState {
    board: {
      // A board run (collect, judge, show, apply) is underway.
      running: BoardFlag
      // A main-thread turn runs (turn.start until its turn.complete).
      isTurnRunning: BoardFlag
      // The startup reminder was checked (session.start runs again on reload).
      startupChecked: BoardFlag
      phase: Shaped<BoardPhase>
      rows: Shaped<BoardRow[]>
      results: Shaped<BoardResult[]>
      // When the current phase began, and the clock's last tick (redraws the elapsed seconds).
      startedAt: Shaped<number>
      tick: Shaped<number>
      counts: Shaped<BoardCounts>
      // The phase's line: why a run failed, or what it came to.
      note: Shaped<string>
    }
  }
}
