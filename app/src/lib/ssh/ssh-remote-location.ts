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
