/**
 * How often the selected SSH repository asks the host for `git worktree list`.
 *
 * There is no remote filesystem watcher. Focus, reselection, fetch, and pull
 * still refresh immediately. This interval covers changes made on the host
 * while the repository stays selected.
 */
export const SshWorktreeRefreshIntervalMs = 20_000

/**
 * One in-flight discovery for the selected SSH repository, plus at most one
 * follow-up if another request arrives before it finishes.
 *
 * A failed refresh does not stop the scheduler. The caller keeps the previous
 * list when the command fails.
 */
export class SshWorktreeRefreshScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private inFlight = false
  private queued = false
  private stopped = true

  public constructor(
    private readonly refresh: () => Promise<void>,
    private readonly intervalMs = SshWorktreeRefreshIntervalMs
  ) {}

  public start(): void {
    this.stop()
    this.stopped = false
    this.timer = setInterval(() => {
      this.request()
    }, this.intervalMs)
    this.timer.unref?.()
    // Selection must discover linked worktrees immediately. The interval only
    // covers changes made on the host while this repository stays selected.
    this.request()
  }

  public stop(): void {
    this.stopped = true
    this.queued = false
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Run now, or queue a single follow-up when a list is already running. */
  public request(): void {
    if (this.stopped) {
      return
    }
    if (this.inFlight) {
      this.queued = true
      return
    }
    void this.run()
  }

  private async run(): Promise<void> {
    this.inFlight = true
    try {
      await this.refresh()
    } catch {
      // The next interval tries again. The caller retains the previous list.
    } finally {
      this.inFlight = false
      if (this.queued && !this.stopped) {
        this.queued = false
        void this.run()
      }
    }
  }
}
