import { spawn, ChildProcess } from 'child_process'
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join, posix } from 'path'
import { withSshAskpassEnv } from '../trampoline/trampoline-environment'
import { deleteMostRecentSSHCredential } from './ssh-credential-storage'
import {
  ISshRemoteLocation,
  buildRemoteGitCommand,
  buildSshArgs,
  formatSshRemoteLocation,
  normalizeRemotePath,
  parseSshRemoteLocation,
  resolveRemoteGitDir,
  resolveRemotePath,
  shellQuote,
} from './ssh-remote-location'

export class SshRemoteError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'SshRemoteError'
  }
}

/**
 * Run Git on a repository that lives on an SSH host.
 *
 * TODO: intentional gaps are documented in docs/ssh-remote-repositories.md.
 * In particular, Desktop's credential helper and hook UI stay on this machine,
 * and merge/rebase/cherry-pick state is still detected from a local .git
 * directory.
 */

export type SshRepositoryProbe =
  | { kind: 'bare' }
  | { kind: 'regular'; topLevelWorkingDirectory: string; gitDir: string }
  | { kind: 'unsafe'; path: string }
  | { kind: 'missing'; message: string }

export interface ISshGitExecutionOptions {
  readonly stdin?: string | Buffer
  readonly encoding?: BufferEncoding | 'buffer'
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly processCallback?: (process: ChildProcess) => void
  readonly isBackgroundTask?: boolean
  readonly maxBuffer?: number
}

interface ISshCommandResult {
  readonly stdout: string | Buffer
  readonly stderr: string | Buffer
  readonly exitCode: number
  readonly stderrText: string
}

let controlMasterUnsupported = process.platform === 'win32'
let systemSshPath: string | null = null

export function findSystemSsh(): string {
  if (systemSshPath) {
    return systemSshPath
  }

  if (process.platform === 'win32') {
    const windowsOpenSSH = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe'
    if (existsSync(windowsOpenSSH)) {
      systemSshPath = windowsOpenSSH
      return systemSshPath
    }
  }

  systemSshPath = 'ssh'
  return systemSshPath
}

export async function testSshConnection(
  location: ISshRemoteLocation
): Promise<void> {
  const result = await execRemoteCommand(location, 'true')
  if (result.exitCode !== 0) {
    throw new SshRemoteError(
      sshFailureMessage(result.stderrText, result.exitCode)
    )
  }
}

export async function getRemoteHome(
  location: ISshRemoteLocation
): Promise<string> {
  const result = await execRemoteCommand(location, 'printf %s "$HOME"')
  if (result.exitCode !== 0 || typeof result.stdout !== 'string') {
    throw new SshRemoteError(
      sshFailureMessage(result.stderrText, result.exitCode)
    )
  }

  if (!result.stdout.startsWith('/')) {
    throw new SshRemoteError(
      'The remote home directory is not an absolute POSIX path. A POSIX login shell is required.'
    )
  }

  return result.stdout
}

export async function expandRemotePath(
  location: ISshRemoteLocation,
  input: string
): Promise<string> {
  const trimmed = input.trim()
  if (trimmed === '~' || trimmed.startsWith('~/')) {
    const home = await getRemoteHome(location)
    if (trimmed === '~') {
      return home
    }

    return normalizeRemotePath(posix.join(home, trimmed.slice(2)))
  }

  if (!trimmed.startsWith('/')) {
    throw new SshRemoteError(
      'Enter an absolute remote path, or a path starting with ~.'
    )
  }

  return normalizeRemotePath(trimmed)
}

export async function listRemoteDirectories(
  location: ISshRemoteLocation,
  directory: string
): Promise<ReadonlyArray<string>> {
  const result = await execRemoteCommand(
    location,
    `ls -1pa ${shellQuote(directory)}`
  )
  if (result.exitCode !== 0 || typeof result.stdout !== 'string') {
    throw new SshRemoteError(
      sshFailureMessage(result.stderrText, result.exitCode)
    )
  }

  return result.stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.endsWith('/') && line !== './' && line !== '../')
    .map(line => line.slice(0, -1))
    .filter(name => name.length > 0)
}

export async function sshRemoteLocationExists(
  virtualPath: string
): Promise<boolean> {
  const location = parseSshRemoteLocation(virtualPath)
  if (!location) {
    return false
  }

  try {
    const result = await execRemoteCommand(
      location,
      `test -e ${shellQuote(location.remotePath)}`
    )
    return result.exitCode === 0
  } catch (error) {
    log.debug('SSH location check failed', error)
    return false
  }
}

export async function sshRemoteDirectoryExists(
  virtualPath: string
): Promise<boolean> {
  const location = parseSshRemoteLocation(virtualPath)
  if (!location) {
    return false
  }

  try {
    const result = await execRemoteCommand(
      location,
      `test -d ${shellQuote(location.remotePath)}`
    )
    return result.exitCode === 0
  } catch (error) {
    log.debug('SSH directory check failed', error)
    return false
  }
}

export async function readSshWorkingTreeFile(
  virtualPath: string,
  relativePath: string
): Promise<Buffer> {
  const location = parseSshRemoteLocation(virtualPath)
  if (!location) {
    throw new SshRemoteError('Not an SSH repository')
  }

  const absolute = posix.isAbsolute(relativePath)
    ? relativePath
    : posix.join(location.remotePath, relativePath)
  const result = await execRemoteCommand(
    location,
    `cat ${shellQuote(absolute)}`,
    { encoding: 'buffer' }
  )
  if (result.exitCode !== 0 || !Buffer.isBuffer(result.stdout)) {
    throw new SshRemoteError(
      sshFailureMessage(result.stderrText, result.exitCode)
    )
  }

  return result.stdout
}

/**
 * Ask the remote Git whether `virtualPath` is a working tree, and return the
 * repository root as another virtual path when it is.
 */
export async function probeSshRepository(
  virtualPath: string
): Promise<SshRepositoryProbe> {
  const location = parseSshRemoteLocation(virtualPath)
  if (!location) {
    return { kind: 'missing', message: 'Invalid SSH repository path.' }
  }

  let result: ISshCommandResult
  try {
    result = await execGitOverSsh(
      virtualPath,
      ['rev-parse', '--is-bare-repository', '--show-cdup', '--git-dir'],
      { encoding: 'utf8' }
    )
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unable to run git over SSH.'
    return { kind: 'missing', message }
  }

  if (result.stderrText.includes('dubious ownership')) {
    return { kind: 'unsafe', path: location.remotePath }
  }

  if (result.exitCode !== 0 || typeof result.stdout !== 'string') {
    return {
      kind: 'missing',
      message: sshFailureMessage(result.stderrText, result.exitCode),
    }
  }

  if (result.stdout.startsWith('true\n')) {
    return { kind: 'bare' }
  }

  const match = result.stdout.match(/^(true|false)\n(.*)\n([\s\S]*)\n$/)
  if (match === null || match[1] === 'true') {
    return match && match[1] === 'true'
      ? { kind: 'bare' }
      : {
          kind: 'missing',
          message: 'This directory does not appear to be a Git repository.',
        }
  }

  const root = resolveRemotePath(location.remotePath, match[2])
  const gitDir = resolveRemoteGitDir(root, match[3].replace(/\n+$/, ''))
  return {
    kind: 'regular',
    topLevelWorkingDirectory: formatSshRemoteLocation({
      ...location,
      remotePath: root,
    }),
    gitDir,
  }
}

export async function execGitOverSsh(
  virtualPath: string,
  args: ReadonlyArray<string>,
  options: ISshGitExecutionOptions = {}
): Promise<ISshCommandResult> {
  const location = parseSshRemoteLocation(virtualPath)
  if (!location) {
    throw new SshRemoteError('Not an SSH repository')
  }

  const command = buildRemoteGitCommand(location.remotePath, args, options.env)
  log.debug(`SSH ${location.user}@${location.hostname} git ${args.join(' ')}`)
  return execRemoteCommand(location, command, options)
}

async function execRemoteCommand(
  location: ISshRemoteLocation,
  remoteCommand: string,
  options: ISshGitExecutionOptions = {}
): Promise<ISshCommandResult> {
  return withSshAskpassEnv(async (askpassEnv, token) => {
    const controlPath = await getControlPath(location)
    let result = await runSsh(
      location,
      remoteCommand,
      controlPath,
      askpassEnv,
      options
    )

    if (controlPath && isControlMasterUnsupported(result.stderrText)) {
      controlMasterUnsupported = true
      result = await runSsh(location, remoteCommand, null, askpassEnv, options)
    }

    if (isSshAuthFailure(result.stderrText, result.exitCode)) {
      await deleteMostRecentSSHCredential(token)
    }

    if (
      options.maxBuffer !== undefined &&
      options.maxBuffer !== Infinity &&
      byteLength(result.stdout) > options.maxBuffer
    ) {
      throw new SshRemoteError('stdout maxBuffer exceeded')
    }

    return result
  }, options.isBackgroundTask ?? false)
}

async function runSsh(
  location: ISshRemoteLocation,
  remoteCommand: string,
  controlPath: string | null,
  askpassEnv: Record<string, string | undefined>,
  options: ISshGitExecutionOptions
): Promise<ISshCommandResult> {
  const args = [...buildSshArgs(location, controlPath), remoteCommand]
  return spawnSsh(findSystemSsh(), args, askpassEnv, options)
}

function spawnSsh(
  sshPath: string,
  args: string[],
  askpassEnv: Record<string, string | undefined>,
  options: ISshGitExecutionOptions
): Promise<ISshCommandResult> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (result: ISshCommandResult) => {
      if (settled) {
        return
      }
      settled = true
      resolve(result)
    }
    const fail = (error: unknown) => {
      if (settled) {
        return
      }
      settled = true
      reject(asSshSpawnError(error))
    }

    let child: ChildProcess
    try {
      child = spawn(sshPath, args, {
        env: spawnEnvironment(askpassEnv),
        windowsHide: true,
      })
    } catch (error) {
      fail(error)
      return
    }

    const encoding =
      options.encoding === 'buffer' ? null : options.encoding ?? 'utf8'
    if (encoding) {
      child.stdout?.setEncoding(encoding)
      child.stderr?.setEncoding(encoding)
    }

    const stdoutChunks: Array<Buffer | string> = []
    const stderrChunks: Array<Buffer | string> = []

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdoutChunks.push(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderrChunks.push(chunk)
    })

    options.processCallback?.(child)

    child.on('error', error => {
      fail(error)
    })
    child.on('close', code => {
      const stdout = joinChunks(stdoutChunks, encoding)
      const stderr = joinChunks(stderrChunks, encoding)
      finish({
        stdout,
        stderr,
        exitCode: code ?? 1,
        stderrText: coerceChunkText(stderr),
      })
    })

    if (!child.stdin) {
      return
    }

    if (options.stdin === undefined) {
      child.stdin.end()
    } else {
      child.stdin.end(options.stdin)
    }
  })
}

function joinChunks(
  chunks: ReadonlyArray<Buffer | string>,
  encoding: BufferEncoding | null
): string | Buffer {
  if (encoding === null) {
    return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))
  }

  return chunks.join('')
}

function coerceChunkText(value: string | Buffer): string {
  return typeof value === 'string' ? value : value.toString('utf8')
}

function byteLength(value: string | Buffer): number {
  return typeof value === 'string' ? Buffer.byteLength(value) : value.length
}

function spawnEnvironment(
  extra: Record<string, string | undefined>
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value
    }
  }

  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) {
      delete env[key]
    } else {
      env[key] = value
    }
  }

  return env
}

async function getControlPath(
  location: ISshRemoteLocation
): Promise<string | null> {
  if (controlMasterUnsupported) {
    return null
  }

  const directory = join(tmpdir(), 'dplus-ssh')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const hash = createHash('sha256')
    .update(
      `${location.user}\0${location.hostname}\0${location.port ?? ''}\0${
        location.identityFile ?? ''
      }`
    )
    .digest('hex')
    .slice(0, 16)
  const socket = join(directory, hash)
  // macOS sun_path is short. Fall back to a new connection when the path
  // would be rejected by ssh.
  if (socket.length > 100) {
    return null
  }

  return socket
}

function isControlMasterUnsupported(stderr: string): boolean {
  return (
    (/unsupported option/i.test(stderr) && /controlmaster/i.test(stderr)) ||
    /Bad configuration option: controlmaster/i.test(stderr)
  )
}

function isSshAuthFailure(stderr: string, exitCode: number): boolean {
  if (exitCode === 0) {
    return false
  }

  return (
    /Permission denied/i.test(stderr) ||
    /Authentication failed/i.test(stderr) ||
    /Too many authentication failures/i.test(stderr)
  )
}

function asSshSpawnError(error: unknown): Error {
  if (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  ) {
    return new SshRemoteError(
      'The system OpenSSH client (ssh) was not found. Install OpenSSH and make sure ssh is on PATH.'
    )
  }

  return error instanceof Error
    ? error
    : new SshRemoteError('Failed to start ssh')
}

export function sshFailureMessage(stderr: string, exitCode: number): string {
  const text = stderr.trim()
  if (/Could not resolve hostname/i.test(text)) {
    return 'Could not resolve the host. Check the hostname and your network connection.'
  }
  if (/Connection refused/i.test(text)) {
    return 'The host refused the connection. Check the address and port.'
  }
  if (/Connection timed out|Operation timed out/i.test(text)) {
    return 'Timed out connecting to the host.'
  }
  if (/Permission denied|Authentication failed/i.test(text)) {
    return 'SSH authentication failed. Check the user, identity file, and that ssh-agent has the right key.'
  }
  if (/Host key verification failed/i.test(text)) {
    return 'Host key verification failed. The server key was rejected or does not match known_hosts.'
  }
  if (/not a git repository/i.test(text)) {
    return 'This directory does not appear to be a Git repository.'
  }
  if (/dubious ownership/i.test(text)) {
    return 'Git on the remote host rejected this repository because of dubious ownership.'
  }
  if (text.length > 0) {
    return text.split('\n').slice(-8).join('\n')
  }

  return `SSH exited with code ${exitCode}.`
}
