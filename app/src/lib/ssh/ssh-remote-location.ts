import { posix } from 'path'

/**
 * Virtual path prefix for a Git repository that lives on an SSH host.
 *
 * The value after the prefix is a base64url JSON payload. It is an app
 * identifier, not a path on the local disk, and it is never produced by
 * reading ~/.ssh/config.
 */
const SshRemotePathPrefix = 'desktop-ssh:'

/** Connection and working tree for one remote repository. */
export interface ISshRemoteLocation {
  readonly user: string
  readonly hostname: string
  /** Null means the system SSH default port (22). */
  readonly port: number | null
  /** Optional local path to a private key. Null uses the ssh client defaults. */
  readonly identityFile: string | null
  /** Absolute path of the working tree on the remote host. */
  readonly remotePath: string
}

interface IStoredSshRemoteLocation {
  readonly u: string
  readonly h: string
  readonly d: string
  readonly p?: number
  readonly i?: string
}

/**
 * Quote one argument for a remote POSIX shell (`sh -c`).
 *
 * OpenSSH sends the remote command as a single string. Callers must not
 * concatenate unsanitized user input into that string.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function formatSshRemoteLocation(location: ISshRemoteLocation): string {
  const stored: IStoredSshRemoteLocation = {
    u: location.user,
    h: location.hostname,
    d: location.remotePath,
    ...(location.port !== null ? { p: location.port } : {}),
    ...(location.identityFile ? { i: location.identityFile } : {}),
  }

  const encoded = Buffer.from(JSON.stringify(stored), 'utf8').toString(
    'base64url'
  )
  return `${SshRemotePathPrefix}${encoded}`
}

export function parseSshRemoteLocation(
  path: string
): ISshRemoteLocation | null {
  if (!path.startsWith(SshRemotePathPrefix)) {
    return null
  }

  try {
    const json = Buffer.from(
      path.slice(SshRemotePathPrefix.length),
      'base64url'
    ).toString('utf8')
    const parsed: unknown = JSON.parse(json)
    if (!isStoredSshRemoteLocation(parsed)) {
      return null
    }

    return {
      user: parsed.u,
      hostname: parsed.h,
      port: parsed.p ?? null,
      identityFile: parsed.i ?? null,
      remotePath: parsed.d,
    }
  } catch {
    return null
  }
}

export function isSshRemotePath(path: string): boolean {
  return parseSshRemoteLocation(path) !== null
}

/** `user@host[:port]:/remote/path`, suitable for display and the clipboard. */
export function formatSshRemoteLabel(location: ISshRemoteLocation): string {
  const port = location.port === null ? '' : `:${location.port}`
  return `${location.user}@${location.hostname}${port}:${location.remotePath}`
}

/**
 * Parse a connection the user typed. Accepts `user@host` and `user@host:port`.
 * IPv6 hosts must be wrapped in brackets (`user@[::1]`).
 *
 * This does not look at SSH config. A dedicated port field in the UI overrides
 * a port included here.
 */
export function parseSshConnectionInput(
  input: string
): { user: string; hostname: string; port: number | null } | null {
  const trimmed = input.trim()
  const match = /^([^@\s]+)@(\[[^\]]+\]|[^@\s:]+)(?::(\d+))?$/.exec(trimmed)
  if (match === null) {
    return null
  }

  const user = match[1]
  const hostname = match[2]
  if (user.length === 0 || hostname.length === 0) {
    return null
  }

  if (match[3] === undefined) {
    return { user, hostname, port: null }
  }

  const port = Number(match[3])
  if (!isValidPort(port)) {
    return null
  }

  return { user, hostname, port }
}

export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

/**
 * Resolve `git rev-parse --show-cdup` against a remote POSIX path.
 * `cdup` is `""` when `base` is already the working tree root.
 */
export function resolveRemotePath(base: string, cdup: string): string {
  const relative = cdup.trim()
  if (relative === '' || relative === '.') {
    return normalizeRemotePath(base)
  }

  return normalizeRemotePath(posix.join(base, relative))
}

/** Resolve `git rev-parse --git-dir`, which may be relative or absolute. */
export function resolveRemoteGitDir(root: string, gitDir: string): string {
  const trimmed = gitDir.trim()
  if (trimmed.startsWith('/')) {
    return normalizeRemotePath(trimmed)
  }

  return normalizeRemotePath(posix.join(root, trimmed))
}

export function normalizeRemotePath(path: string): string {
  const normalized = posix.normalize(path)
  if (normalized.length > 1 && normalized.endsWith('/')) {
    return normalized.slice(0, -1)
  }

  return normalized
}

/** Join segments onto a remote POSIX path. */
export function joinRemotePath(base: string, ...segments: string[]): string {
  return normalizeRemotePath(posix.join(base, ...segments))
}

/**
 * Join a working-tree-relative path onto `root` and reject anything that
 * leaves the tree. Git status paths are relative; this stops a crafted path
 * from addressing another directory on the host.
 */
export function resolveRemoteWorkingTreeFile(
  root: string,
  relativePath: string
): string | null {
  if (
    relativePath.length === 0 ||
    relativePath.includes('\0') ||
    posix.isAbsolute(relativePath)
  ) {
    return null
  }

  const rootNorm = normalizeRemotePath(root)
  if (!rootNorm.startsWith('/')) {
    return null
  }

  const absolute = normalizeRemotePath(posix.join(rootNorm, relativePath))
  const prefix = `${rootNorm}/`
  if (!absolute.startsWith(prefix)) {
    return null
  }

  return absolute
}

/**
 * Relative path under a remote git directory. Callers pass fixed names such
 * as `MERGE_HEAD` or `rebase-merge/orig-head`, never a working-tree path.
 */
export function assertSafeGitMetadataRelativePath(relative: string): void {
  const safe =
    /^[A-Za-z0-9._/-]+$/.test(relative) &&
    !relative.startsWith('/') &&
    relative
      .split('/')
      .every(part => part !== '' && part !== '.' && part !== '..')

  if (!safe) {
    throw new Error(`Unsafe git metadata path: ${relative}`)
  }
}

export function buildRemoteExistenceCommand(absolutePath: string): string {
  return `test -e ${shellQuote(absolutePath)}`
}

export function buildRemoteCatCommand(absolutePath: string): string {
  return `cat ${shellQuote(absolutePath)}`
}

/**
 * Read at most `maxBytes` from the start of a remote file.
 *
 * `bs` plus `count=1` is supported by both GNU and BSD `dd`, and it does not
 * pull the rest of a large file one byte at a time.
 */
export function buildRemotePrefixReadCommand(
  absolutePath: string,
  maxBytes: number
): string {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new Error('maxBytes must be a positive integer')
  }

  return `dd if=${shellQuote(absolutePath)} bs=${String(maxBytes)} count=1`
}

/**
 * Print `size mtimeSeconds`. GNU `stat` is tried first; BSD `stat` is the
 * fallback. A missing file makes both fail.
 */
export function buildRemoteStatCommand(absolutePath: string): string {
  const quoted = shellQuote(absolutePath)
  return `stat -c '%s %Y' ${quoted} 2>/dev/null || stat -f '%z %m' ${quoted}`
}

export function parseRemoteStat(
  stdout: string
): { size: number; mtimeSeconds: number } | null {
  const match = /^(\d+) (\d+)\s*$/.exec(stdout.trim())
  if (match === null) {
    return null
  }

  const size = Number(match[1])
  const mtimeSeconds = Number(match[2])
  if (!Number.isSafeInteger(size) || !Number.isSafeInteger(mtimeSeconds)) {
    return null
  }

  return { size, mtimeSeconds }
}

/** Delete one working-tree file. `rm -f` does not remove directories. */
export function buildRemoteRemoveFileCommand(absolutePath: string): string {
  return `rm -f -- ${shellQuote(absolutePath)}`
}

/** Remote command exited because the path is a symbolic link. */
export const RemoteFileSymlinkExit = 3
/** Remote command exited because the path does not exist. */
export const RemoteFileMissingExit = 2
/** Remote command exited because the path is a directory. */
export const RemoteFileIsDirectoryExit = 4
/** Remote command exited because a temporary file could not be created. */
export const RemoteFileTempExit = 5

/**
 * Read a file without following a symlink. A missing file exits
 * {@link RemoteFileMissingExit}. A symlink, including a dangling one, exits
 * {@link RemoteFileSymlinkExit}.
 */
export function buildRemoteNoFollowReadCommand(absolutePath: string): string {
  const quoted = shellQuote(absolutePath)
  return `if [ -L ${quoted} ]; then exit ${RemoteFileSymlinkExit}; fi; if [ ! -e ${quoted} ]; then exit ${RemoteFileMissingExit}; fi; cat ${quoted}`
}

/** Remove a file. Missing and symlink paths use the same exit codes as the read. */
export function buildRemoteNoFollowDeleteCommand(absolutePath: string): string {
  const quoted = shellQuote(absolutePath)
  return `if [ -L ${quoted} ]; then exit ${RemoteFileSymlinkExit}; fi; if [ ! -e ${quoted} ]; then exit ${RemoteFileMissingExit}; fi; rm -f -- ${quoted}`
}

/**
 * Replace a file with the bytes on stdin.
 *
 * The body is not placed in the command string. A symlink is not followed:
 * the write goes to a temporary file in the same directory and `mv` replaces
 * the directory entry.
 */
export function buildRemoteNoFollowWriteCommand(absolutePath: string): string {
  const quoted = shellQuote(absolutePath)
  const template = shellQuote(
    posix.join(posix.dirname(absolutePath), '.dplus-write.XXXXXX')
  )
  return [
    `if [ -L ${quoted} ]; then exit ${RemoteFileSymlinkExit}; fi`,
    `if [ -d ${quoted} ]; then exit ${RemoteFileIsDirectoryExit}; fi`,
    `tmp=$(mktemp ${template}) || exit ${RemoteFileTempExit}`,
    `if cat > "$tmp"; then if [ -L ${quoted} ]; then rm -f "$tmp"; exit ${RemoteFileSymlinkExit}; fi; chmod 644 "$tmp"; mv -f "$tmp" ${quoted} || { status=$?; rm -f "$tmp"; exit "$status"; }; else status=$?; rm -f "$tmp"; exit "$status"; fi`,
  ].join('; ')
}

/**
 * Command run by the remote login shell after `ssh -t`.
 *
 * `-i` keeps the shell interactive without a login shell, so a profile that
 * `cd`s home does not undo the `cd` into the repository.
 */
export function buildInteractiveSshRemoteCommand(remotePath: string): string {
  return `cd -- ${shellQuote(remotePath)} && exec "\${SHELL:-/bin/sh}" -i`
}

/**
 * Arguments for an interactive `ssh` process, not including the `ssh` binary.
 *
 * Host-key checking stays at the OpenSSH default. `-F` is not set, and this
 * does not read an SSH config file to choose the host.
 */
export function buildInteractiveSshArgs(
  location: ISshRemoteLocation
): string[] {
  const connection = buildSshArgs(location, null)
  const destination = connection[connection.length - 1]
  return [
    ...connection.slice(0, -1),
    '-t',
    destination,
    buildInteractiveSshRemoteCommand(location.remotePath),
  ]
}

/** Quote argv for a local POSIX shell, such as Terminal's `do script`. */
export function quotePosixCommand(args: readonly string[]): string {
  return args.map(shellQuote).join(' ')
}

export class RemoteFileBundleError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'RemoteFileBundleError'
  }
}

/**
 * One POSIX command that prints each relative file under `directory`.
 *
 * A missing file is `path -`. A present file is `path <byte length>`, then
 * exactly that many bytes, then a newline. The length is in bytes so file
 * contents cannot be mistaken for the next header.
 */
export function buildRemoteFileBundleCommand(
  directory: string,
  relativeFiles: readonly string[]
): string {
  if (relativeFiles.length === 0) {
    throw new Error('No remote files to read')
  }

  return relativeFiles
    .map(relative => {
      assertSafeGitMetadataRelativePath(relative)
      const absolute = shellQuote(joinRemotePath(directory, relative))
      const id = shellQuote(relative)
      return `if test -f ${absolute}; then printf '%s ' ${id}; wc -c < ${absolute} | tr -d '[:space:]'; printf '\\n'; cat ${absolute}; printf '\\n'; else printf '%s -\\n' ${id}; fi`
    })
    .join('; ')
}

export function parseRemoteFileBundle(
  stdout: Buffer,
  relativeFiles: readonly string[]
): Map<string, Buffer | null> {
  const parsed = new Map<string, Buffer | null>()
  let offset = 0

  for (const relative of relativeFiles) {
    const newline = stdout.indexOf(0x0a, offset)
    if (newline < 0) {
      throw new RemoteFileBundleError(
        `Truncated remote file bundle header for ${relative}`
      )
    }

    const header = stdout.subarray(offset, newline).toString('utf8')
    if (header === `${relative} -`) {
      parsed.set(relative, null)
      offset = newline + 1
      continue
    }

    const prefix = `${relative} `
    if (
      !header.startsWith(prefix) ||
      !/^\d+$/.test(header.slice(prefix.length))
    ) {
      throw new RemoteFileBundleError(
        `Unexpected remote file bundle header for ${relative}`
      )
    }

    const size = Number(header.slice(prefix.length))
    if (!Number.isSafeInteger(size)) {
      throw new RemoteFileBundleError(
        `Invalid remote file bundle size for ${relative}`
      )
    }

    const start = newline + 1
    const end = start + size
    if (end >= stdout.length || stdout[end] !== 0x0a) {
      throw new RemoteFileBundleError(
        `Truncated remote file bundle body for ${relative}`
      )
    }

    parsed.set(relative, Buffer.from(stdout.subarray(start, end)))
    offset = end + 1
  }

  if (offset !== stdout.length) {
    throw new RemoteFileBundleError('Remote file bundle has trailing data')
  }

  return parsed
}

/**
 * Build argv for the system `ssh` client.
 *
 * Host-key checking and the user config file are left at OpenSSH defaults so
 * agent keys and known_hosts behave like a terminal session. This function
 * does not read or rewrite an SSH config file. `-F` is intentionally absent.
 */
export function buildSshArgs(
  location: ISshRemoteLocation,
  controlPath: string | null
): string[] {
  const args = [
    '-o',
    'ConnectTimeout=15',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
  ]

  if (location.port !== null) {
    args.push('-p', String(location.port))
  }

  if (location.identityFile) {
    args.push('-i', location.identityFile, '-o', 'IdentitiesOnly=yes')
  }

  if (controlPath) {
    args.push(
      '-o',
      'ControlMaster=auto',
      '-o',
      'ControlPersist=600',
      '-o',
      `ControlPath=${controlPath}`
    )
  }

  args.push(`${location.user}@${location.hostname}`)
  return args
}

const RemoteGitEnvAllowList = [
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE',
  'GIT_EDITOR',
  'GIT_SEQUENCE_EDITOR',
] as const

/**
 * Environment for the remote `git` process.
 *
 * Desktop's local askpass trampoline, credential helper, and embedded Git are
 * not forwarded. Push and pull therefore use the remote host's own Git
 * credentials. `GIT_EDITOR` defaults to `:` so a non-interactive session cannot
 * hang waiting for vim.
 */
export function buildRemoteGitCommand(
  remotePath: string,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>> | undefined
): string {
  const variables: Record<string, string> = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_EDITOR: ':',
    GIT_SEQUENCE_EDITOR: ':',
  }

  if (env) {
    for (const key of RemoteGitEnvAllowList) {
      const value = env[key]
      if (value) {
        variables[key] = value
      }
    }
  }

  const assignments = Object.entries(variables).map(
    ([key, value]) => `${key}=${shellQuote(value)}`
  )
  const quotedArgs = args.map(shellQuote).join(' ')
  return `env ${assignments.join(' ')} git -C ${shellQuote(
    remotePath
  )} ${quotedArgs}`
}

function isStoredSshRemoteLocation(
  value: unknown
): value is IStoredSshRemoteLocation {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const stored = value as Record<string, unknown>
  if (typeof stored.u !== 'string' || stored.u.length === 0) {
    return false
  }
  if (typeof stored.h !== 'string' || stored.h.length === 0) {
    return false
  }
  if (typeof stored.d !== 'string' || stored.d.length === 0) {
    return false
  }
  if (
    stored.p !== undefined &&
    (typeof stored.p !== 'number' || !isValidPort(stored.p))
  ) {
    return false
  }
  if (stored.i !== undefined && typeof stored.i !== 'string') {
    return false
  }

  return true
}
