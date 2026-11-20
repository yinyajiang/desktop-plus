import { watch, type FSWatcher } from 'fs'
import * as Path from 'path'
import { git } from './git/core'
import { isSshRemotePath } from './ssh/ssh-remote-location'

/** Collapse a burst of directory events into one refresh. */
const WorktreeWatchDebounceMs = 300

export interface IWorktreeListWatch {
  dispose(): void
}

/**
 * Watch the Git common directory for linked worktrees added or removed
 * outside Desktop.
 *
 * `git rev-parse --git-common-dir` follows a linked checkout's `.git` file
 * back to the main repository. The common directory is watched so the
 * `worktrees` directory can be attached when it appears. That subdirectory is
 * watched when it already exists. This is not a scan of the working tree.
 *
 * SSH repositories have no local common directory. Callers skip them, and
 * this returns a no-op watch if one is passed in.
 */
export async function watchLocalWorktreeList(
  repositoryPath: string,
  onChange: () => void
): Promise<IWorktreeListWatch> {
  if (isSshRemotePath(repositoryPath)) {
    return { dispose() {} }
  }

  const result = await git(
    ['rev-parse', '--git-common-dir'],
    repositoryPath,
    'watchLocalWorktreeList'
  )
  const printed = result.stdout.trim()
  const commonDir = Path.isAbsolute(printed)
    ? printed
    : Path.resolve(repositoryPath, printed)

  let disposed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let commonWatcher: FSWatcher | null = null
  let worktreesWatcher: FSWatcher | null = null

  const dispose = () => {
    disposed = true
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    commonWatcher?.close()
    worktreesWatcher?.close()
    commonWatcher = null
    worktreesWatcher = null
  }

  const schedule = () => {
    if (disposed) {
      return
    }
    if (timer !== null) {
      clearTimeout(timer)
    }
    timer = setTimeout(() => {
      timer = null
      if (!disposed) {
        onChange()
      }
    }, WorktreeWatchDebounceMs)
    timer.unref?.()
  }

  const attachWorktrees = () => {
    if (disposed || worktreesWatcher !== null) {
      return
    }

    try {
      const dir = Path.join(commonDir, 'worktrees')
      const watcher = watch(dir, { persistent: false }, () => {
        schedule()
      })
      watcher.on('error', () => {
        watcher.close()
        if (worktreesWatcher === watcher) {
          worktreesWatcher = null
        }
      })
      worktreesWatcher = watcher
    } catch {
      // The directory is created with the first linked worktree.
    }
  }

  try {
    commonWatcher = watch(commonDir, { persistent: false }, () => {
      schedule()
      attachWorktrees()
    })
    commonWatcher.on('error', () => {
      commonWatcher?.close()
      commonWatcher = null
    })
  } catch (error) {
    dispose()
    throw error
  }

  attachWorktrees()

  return { dispose }
}
