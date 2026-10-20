import { join } from 'path'
import { readFile, stat } from 'fs/promises'
import { Repository } from '../../models/repository'
import { readPartialFile } from '../file-system'
import { pathExists } from '../path-exists'
import {
  readSshFilePrefix,
  readSshTextFile,
  sshAbsoluteFileExists,
  statSshFile,
} from '../ssh/ssh-remote-git'
import {
  joinRemotePath,
  resolveRemoteWorkingTreeFile,
} from '../ssh/ssh-remote-location'

/**
 * Absolute git directory on the remote host.
 *
 * Stored `gitDir` values come from `git rev-parse --git-dir`. When that has
 * not been recorded yet, a normal repository uses `$root/.git`.
 */
export function remoteGitDirectory(repository: Repository): string | null {
  const remote = repository.sshRemote
  if (remote === null) {
    return null
  }

  if (repository.gitDir !== undefined && repository.gitDir.startsWith('/')) {
    return joinRemotePath(repository.gitDir)
  }

  return joinRemotePath(remote.remotePath, '.git')
}

function remoteGitFile(
  repository: Repository,
  segments: readonly string[]
): string | null {
  const directory = remoteGitDirectory(repository)
  if (directory === null) {
    return null
  }

  return joinRemotePath(directory, ...segments)
}

/** Whether a file under the git directory exists, locally or over SSH. */
export async function gitMetadataExists(
  repository: Repository,
  ...segments: string[]
): Promise<boolean> {
  const remoteFile = remoteGitFile(repository, segments)
  if (repository.sshRemote && remoteFile) {
    return sshAbsoluteFileExists(repository.sshRemote, remoteFile)
  }

  return pathExists(join(repository.resolvedGitDir, ...segments))
}

/** Read a text file under the git directory. Throws when it is missing. */
export async function readGitMetadata(
  repository: Repository,
  ...segments: string[]
): Promise<string> {
  const remoteFile = remoteGitFile(repository, segments)
  if (repository.sshRemote && remoteFile) {
    return readSshTextFile(repository.sshRemote, remoteFile)
  }

  return readFile(join(repository.resolvedGitDir, ...segments), 'utf8')
}

/**
 * Stat a file under the git directory.
 *
 * Returns null when the file is missing or the host cannot be reached, which
 * matches the local `stat` failure callers already treat as "never fetched".
 */
export async function statGitMetadata(
  repository: Repository,
  ...segments: string[]
): Promise<{ readonly size: number; readonly mtime: Date } | null> {
  const remoteFile = remoteGitFile(repository, segments)
  if (repository.sshRemote && remoteFile) {
    return statSshFile(repository.sshRemote, remoteFile)
  }

  try {
    const fstat = await stat(join(repository.resolvedGitDir, ...segments))
    return { size: fstat.size, mtime: fstat.mtime }
  } catch {
    return null
  }
}

export async function workingTreeFileExists(
  repository: Repository,
  relativePath: string
): Promise<boolean> {
  if (repository.sshRemote) {
    const absolute = resolveRemoteWorkingTreeFile(
      repository.sshRemote.remotePath,
      relativePath
    )
    if (absolute === null) {
      return false
    }

    return sshAbsoluteFileExists(repository.sshRemote, absolute)
  }

  return pathExists(join(repository.path, relativePath))
}

export async function readWorkingTreeText(
  repository: Repository,
  relativePath: string
): Promise<string> {
  if (repository.sshRemote) {
    const absolute = requireWorkingTreeFile(repository, relativePath)
    return readSshTextFile(repository.sshRemote, absolute)
  }

  return readFile(join(repository.path, relativePath), 'utf8')
}

/**
 * Read up to `maxBytes` from the start of a working-tree file.
 *
 * The local read is inclusive of the last index, matching `readPartialFile`.
 */
export async function readWorkingTreePrefix(
  repository: Repository,
  relativePath: string,
  maxBytes: number
): Promise<Buffer> {
  if (repository.sshRemote) {
    const absolute = requireWorkingTreeFile(repository, relativePath)
    return readSshFilePrefix(repository.sshRemote, absolute, maxBytes)
  }

  return readPartialFile(join(repository.path, relativePath), 0, maxBytes - 1)
}

function requireWorkingTreeFile(
  repository: Repository,
  relativePath: string
): string {
  const remote = repository.sshRemote
  if (remote === null) {
    throw new Error('Not an SSH repository')
  }

  const absolute = resolveRemoteWorkingTreeFile(remote.remotePath, relativePath)
  if (absolute === null) {
    throw new Error('The file path is outside the remote repository.')
  }

  return absolute
}
