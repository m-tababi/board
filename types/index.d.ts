// Session-scoped flags; each lives in $.state so a hot reload keeps it.
export type BoardFlag = boolean

declare module 'claude-code' {
  interface PluginState {
    board: {
      // A board run (collect, judge, ask, apply) is underway.
      running: BoardFlag
      // A main-thread turn runs (turn.start until its turn.complete).
      isTurnRunning: BoardFlag
      // The startup reminder was checked (session.start runs again on reload).
      startupChecked: BoardFlag
    }
  }
}
