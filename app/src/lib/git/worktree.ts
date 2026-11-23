import * as Path from 'path'
import type { Repository } from '../../models/repository'
import type { WorktreeEntry, WorktreeType } from '../../models/worktree'
import { pathExists } from '../path-exists'
import { git } from './core'
import {
  formatSshRemoteLocation,
  ISshRemoteLocation,
  isSshRemotePath,
  normalizeRemotePath,
  parseSshRemoteLocation,
} from '../ssh/ssh-remote-location'

export interface IParseWorktreePorcelainOptions {
  /**
   * Replaces the path Git printed.
   *
   * Local lists keep platform normalization. SSH lists map the remote POSIX
   * path onto a virtual path for the same host instead.
   */
  readonly mapPath?: (gitPath: string) => string
}

/**
 * Keep the list already on screen when enumeration fails.
 *
 * `undefined` means the transport or Git command failed. A successful list,
 * including one that no longer contains a removed worktree, replaces it.
 */
export function applyDiscoveredWorktrees<T>(
  previous: readonly T[],
  discovered: readonly T[] | undefined
): readonly T[] {
  return discovered === undefined ? previous : discovered
}

/**
 * Map a path from `git worktree list` on an SSH host onto a virtual path.
 *
 * The host, user, port, and identity file stay the same. The path is a remote
 * POSIX path, so it is not passed through `path.win32.normalize`.
 */
export function mapSshWorktreePath(
  gitPath: string,
  location: ISshRemoteLocation
): string {
  return formatSshRemoteLocation({
    ...location,
    remotePath: normalizeRemotePath(gitPath),
  })
}

function assertLocalWorktreeMutation(path: string, action: string): void {
  if (isSshRemotePath(path)) {
    throw new Error(`Cannot ${action} a worktree on an SSH host from Desktop`)
  }
}

export function parseWorktreePorcelainOutput(
  stdout: string,
  options?: IParseWorktreePorcelainOptions
): ReadonlyArray<WorktreeEntry> {
  if (stdout.trim().length === 0) {
    return []
  }

  // With -z, worktree blocks are separated by double NUL and fields within
  // a block are separated by single NUL
  const blocks = stdout.replace(/\0$/, '').split('\0\0')
  const entries: WorktreeEntry[] = []

  for (let i = 0; i < blocks.length; i++) {
    const lines = blocks[i].split('\0')
    let path = ''
    let head = ''
    let branch: string | null = null
    let isDetached = false
    let isLocked = false
    let isPrunable = false

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        const gitPath = line.substring('worktree '.length)
        if (options?.mapPath) {
          path = options.mapPath(gitPath)
        } else {
          // Git for Windows will output paths using forward slashes, i.e.
          // c:/Users/niik/... but repositories added in Desktop always pass
          // through getRepositoryType which uses path.resolve to deduce the
          // absolute top level directory and that will normalize paths as well
          // so by normalizing here we can be more confident about comparing paths
          path = Path.normalize(gitPath)
        }
      } else if (line.startsWith('HEAD ')) {
        head = line.substring('HEAD '.length)
      } else if (line.startsWith('branch ')) {
        branch = line.substring('branch '.length)
      } else if (line === 'detached') {
        isDetached = true
      } else if (line === 'locked' || line.startsWith('locked ')) {
        isLocked = true
      } else if (line === 'prunable' || line.startsWith('prunable ')) {
        isPrunable = true
      }
    }

    const type: WorktreeType = i === 0 ? 'main' : 'linked'
    entries.push({ path, head, branch, isDetached, type, isLocked, isPrunable })
  }

  return entries
}

export async function listWorktrees(
  repositoryOrPath: Repository | string
): Promise<ReadonlyArray<WorktreeEntry>> {
  const path =
    typeof repositoryOrPath === 'string'
      ? repositoryOrPath
      : repositoryOrPath.path

  const result = await git(
    ['worktree', 'list', '--porcelain', '-z'],
    path,
    'listWorktrees'
  )

  const location = parseSshRemoteLocation(path)
  if (location) {
    return parseWorktreePorcelainOutput(result.stdout, {
      mapPath: gitPath => mapSshWorktreePath(gitPath, location),
    })
  }

  return parseWorktreePorcelainOutput(result.stdout)
}

export async function listWorktreesFromGitDir(
  gitDir: string
): Promise<ReadonlyArray<WorktreeEntry>> {
  const result = await git(
    ['--git-dir', gitDir, 'worktree', 'list', '--porcelain', '-z'],
    gitDir,
    'listWorktreesFromGitDir'
  )

  return parseWorktreePorcelainOutput(result.stdout)
}

/**
 * Resolve the path to the main worktree of the repository the given repository
 * belongs to, or null if it is already the main worktree or cannot be resolved.
 *
 * Prefers the path recorded when Desktop switched onto the worktree, falling
 * back to the worktree's administrative git dir for repositories recorded
 * before that path was persisted. The fallback only works while that metadata
 * exists — `git worktree remove` and `git worktree prune` both delete it.
 */
export async function resolveMainWorktreePath(
  repository: Repository
): Promise<string | null> {
  const { mainWorktreePath, gitDir, path } = repository

  if (mainWorktreePath === path) {
    return null
  }

  // A recorded path can outlive the location it names, so treat it as a hint
  // rather than the answer — otherwise a stale one would suppress the lookup
  // below, which may well still work.
  if (mainWorktreePath !== undefined && (await pathExists(mainWorktreePath))) {
    return mainWorktreePath
  }

  // An SSH git dir is a path on the remote host. A local `git --git-dir`
  // cannot list it, and a failed lookup must not invent a local path.
  if (repository.sshRemote || gitDir === undefined) {
    return null
  }

  const mainWorktree = (await listWorktreesFromGitDir(gitDir)).find(
    wt => wt.type === 'main'
  )

  return mainWorktree === undefined || mainWorktree.path === path
    ? null
    : mainWorktree.path
}

/** Options for creating and checking out a worktree. */
export interface IAddWorktreeOptions {
  /** Branch name used with -b (create new branch). */
  readonly createBranch?: string
  /** Commit-ish to check out (branch name, ref, or SHA). */
  readonly commitish?: string
}

export async function addWorktree(
  repository: Repository,
  path: string,
  options: IAddWorktreeOptions = {}
): Promise<void> {
  assertLocalWorktreeMutation(repository.path, 'create')
  const args = ['worktree', 'add']

  if (options.createBranch) {
    args.push('-b', options.createBranch)
  }

  args.push('--', path)

  if (options.commitish) {
    args.push(options.commitish)
  }

  await git(args, repository.path, 'addWorktree')
}

/**
 * Path argument for `git worktree remove`.
 *
 * SSH virtual ids become the remote POSIX path so Git on the host sees a
 * normal worktree directory, not a `desktop-ssh:` token.
 */
export function getWorktreeRemoveTarget(worktreePath: string): string {
  const remote = parseSshRemoteLocation(worktreePath)
  return remote !== null ? remote.remotePath : worktreePath
}

export async function removeWorktree(
  repositoryPath: string,
  worktreePath: string,
  force: boolean = false
): Promise<void> {
  // SSH may delete a linked worktree through the existing remote Git channel.
  // Force removal stays local-only: SSH callers must not pass force.
  if (isSshRemotePath(repositoryPath)) {
    if (force) {
      throw new Error(
        'Cannot force-delete a worktree on an SSH host from Desktop'
      )
    }
  }

  const args = ['worktree', 'remove']
  if (force) {
    args.push('--force')
  }
  args.push(getWorktreeRemoveTarget(worktreePath))

  await git(args, repositoryPath, 'removeWorktree')
}

/**
 * Move (rename) a linked worktree from `oldPath` to `newPath`.
 *
 * Git is run from the main worktree rather than from `repository.path` since
 * the repository is frequently the very worktree being moved, and Windows
 * refuses to rename a directory that is the working directory of a process.
 */
export async function moveWorktree(
  repository: Repository,
  oldPath: string,
  newPath: string
): Promise<void> {
  assertLocalWorktreeMutation(repository.path, 'move')
  const mainWorktree = (await listWorktrees(repository)).find(
    wt => wt.type === 'main'
  )

  // SSH repositories report no linked worktrees. Git still runs on the host
  // from the repository path; a local repository with no main worktree cannot
  // be renamed from here.
  if (mainWorktree === undefined && !isSshRemotePath(repository.path)) {
    throw new Error('Could not determine the main worktree of the repository')
  }

  await git(
    ['worktree', 'move', '--', oldPath, newPath],
    mainWorktree?.path ?? repository.path,
    'moveWorktree'
  )
}
