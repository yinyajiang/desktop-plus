import { glob, readFile } from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { execFile } from '../exec-file'
import { findSystemSsh } from './find-system-ssh'
import {
  isQueryableSshHostAlias,
  isValidPort,
  SshManualConnectionInput,
} from './ssh-remote-location'

/**
 * Host name passed to `ssh -G` to read the config that applies to every host
 * (`Host *` and the compiled-in defaults) without matching a specific alias.
 */
export const SshConfigDefaultProbeHost = 'desktop-plus-ssh-default-probe'

const OpenSshDefaultPort = 22
const SshGTimeoutMs = 5000
const MaxConfigFiles = 64
const MaxConfigChars = 1024 * 1024
const MaxIncludeMatches = 100

/** Fields stored on a repository connection. Unset port and key stay null. */
export interface ISshConnectionFields {
  readonly user: string
  readonly hostname: string
  readonly port: number | null
  readonly identityFile: string | null
}

/** One Host block's explicit keywords. Null means the keyword was absent. */
export interface ISshConfigBlock {
  readonly user: string | null
  readonly hostName: string | null
  readonly port: number | null
  readonly identityFiles: readonly string[]
}

export interface ISshConfigHostBlock extends ISshConfigBlock {
  readonly patterns: readonly string[]
}

export type SshConfigEvent =
  | { readonly kind: 'host'; readonly block: ISshConfigHostBlock }
  | { readonly kind: 'include'; readonly patterns: readonly string[] }

/** The user, host, port, and keys `ssh -G` printed for one destination. */
export interface ISshGSnapshot {
  readonly user: string | null
  readonly hostname: string | null
  readonly port: number | null
  readonly identityFiles: readonly string[]
}

/**
 * A host resolved for the connection dialog and the repository record.
 *
 * `port` and `identityFile` are null when they were not set for this host, so
 * callers omit `-p` and `-i` and OpenSSH is not forced onto its defaults.
 * `hostname` is the resolved host, not an alias that only this machine knows.
 */
export interface ISshConfigHostEndpoint extends ISshConnectionFields {
  readonly alias: string
  readonly identityFiles: readonly string[]
  readonly source: 'ssh-g' | 'config-file'
}

export interface ILoadedSshConfig {
  readonly aliases: readonly string[]
  readonly blocks: ReadonlyMap<string, ISshConfigBlock>
  readonly error: 'missing' | 'unreadable' | null
}

export interface IResolveSshConfigHostOptions {
  /** Test hook. Production runs `ssh -G -- <alias>`. */
  readonly runSshG?: (alias: string) => Promise<string | null>
  /** Test hook. Production reads `~/.ssh/config` and its Include files. */
  readonly lookupConfigBlock?: (
    alias: string
  ) => Promise<ISshConfigBlock | null>
  readonly username?: string
}

let probeStdout: Promise<string | null> | null = null

/** Forgets the cached `ssh -G` default probe. */
export function resetSshConfigHostCacheForTesting(): void {
  probeStdout = null
}

/**
 * Home directory system OpenSSH uses for `~/.ssh/config`.
 *
 * `ssh` uses the password database, not the `HOME` environment variable.
 */
export function sshConfigHomeDirectory(): string {
  try {
    const home = os.userInfo().homedir
    if (home) {
      return home
    }
  } catch {
    // userInfo throws when the account has no passwd entry.
  }

  return os.homedir()
}

export function sshConfigListHint(loaded: ILoadedSshConfig): string | null {
  if (loaded.aliases.length > 0) {
    return null
  }

  if (loaded.error === 'unreadable') {
    return "Couldn't read ~/.ssh/config. Enter the connection manually."
  }

  return 'No usable hosts were found in ~/.ssh/config. Enter the connection manually.'
}

/** Host aliases in one config file. Include directives are not followed. */
export function listHostAliasesInConfigText(
  contents: string
): readonly string[] {
  const aliases: string[] = []
  const seen = new Set<string>()
  for (const event of parseSshConfigEvents(contents)) {
    if (event.kind !== 'host') {
      continue
    }
    for (const pattern of event.block.patterns) {
      if (!isQueryableSshHostAlias(pattern) || seen.has(pattern)) {
        continue
      }
      seen.add(pattern)
      aliases.push(pattern)
    }
  }
  return aliases
}

/** First matching Host block in one file, or null when the alias is absent. */
export function configBlockForAlias(
  contents: string,
  alias: string
): ISshConfigBlock | null {
  if (!isQueryableSshHostAlias(alias)) {
    return null
  }

  for (const event of parseSshConfigEvents(contents)) {
    if (event.kind !== 'host') {
      continue
    }
    if (event.block.patterns.includes(alias)) {
      return event.block
    }
  }

  return null
}

/**
 * Fallback when `ssh -G` cannot run. Only keywords on the alias's own Host
 * block are treated as set. `Host *` is not merged in; that needs `ssh -G`.
 */
export function fallbackEndpointFromConfigText(
  alias: string,
  contents: string,
  username: string
): ISshConfigHostEndpoint | null {
  const block = configBlockForAlias(contents, alias)
  if (block === null) {
    return null
  }

  return endpointFromBlock(alias, block, username)
}

export function parseSshConfigEvents(
  contents: string
): readonly SshConfigEvent[] {
  const events: SshConfigEvent[] = []
  let current: {
    patterns: string[]
    user: string | null
    hostName: string | null
    port: number | null
    identityFiles: string[]
  } | null = null

  const flush = () => {
    if (current === null) {
      return
    }
    events.push({
      kind: 'host',
      block: {
        patterns: current.patterns,
        user: current.user,
        hostName: current.hostName,
        port: current.port,
        identityFiles: current.identityFiles,
      },
    })
    current = null
  }

  for (const line of logicalLines(contents)) {
    const tokens = tokenizeConfigLine(line)
    if (tokens.length === 0) {
      continue
    }

    const keyword = tokens[0].toLowerCase()
    const args = tokens.slice(1)
    if (keyword === 'host') {
      flush()
      current = {
        patterns: args,
        user: null,
        hostName: null,
        port: null,
        identityFiles: [],
      }
      continue
    }

    if (keyword === 'include') {
      flush()
      if (args.length > 0) {
        events.push({ kind: 'include', patterns: args })
      }
      continue
    }

    if (keyword === 'match') {
      flush()
      continue
    }

    if (current === null || args.length === 0) {
      continue
    }

    const value = args[0]
    if (keyword === 'user' && current.user === null) {
      current.user = value
    } else if (keyword === 'hostname' && current.hostName === null) {
      current.hostName = value
    } else if (keyword === 'port' && current.port === null) {
      const port = Number(value)
      if (isValidPort(port)) {
        current.port = port
      }
    } else if (keyword === 'identityfile') {
      current.identityFiles.push(value)
    }
  }

  flush()
  return events
}

/** Parse `ssh -G` stdout. Identity file paths may contain spaces. */
export function parseSshGOutput(stdout: string): ISshGSnapshot {
  let user: string | null = null
  let hostname: string | null = null
  let port: number | null = null
  const identityFiles: string[] = []

  for (const line of stdout.split(/\r?\n/)) {
    const separator = line.indexOf(' ')
    if (separator <= 0) {
      continue
    }

    const key = line.slice(0, separator).toLowerCase()
    const value = line.slice(separator + 1).trim()
    if (value.length === 0) {
      continue
    }

    if (key === 'user' && user === null) {
      user = value
    } else if (key === 'hostname' && hostname === null) {
      hostname = value
    } else if (key === 'port' && port === null) {
      const parsed = Number(value)
      if (isValidPort(parsed)) {
        port = parsed
      }
    } else if (key === 'identityfile') {
      identityFiles.push(value)
    }
  }

  return { user, hostname, port, identityFiles }
}

/**
 * Turn two `ssh -G` snapshots into connection fields.
 *
 * The user and host name are the values OpenSSH would connect with. Port and
 * identity file are omitted when they match the config-wide defaults, so the
 * saved connection does not pass `-p` or `-i` for settings the user did not
 * configure. An explicit port of 22 is kept when the default probe uses
 * another port.
 */
export function endpointFromSshG(
  alias: string,
  host: ISshGSnapshot,
  defaults: ISshGSnapshot
): ISshConfigHostEndpoint | null {
  if (!host.user || !host.hostname) {
    return null
  }

  const identityFiles = sameStringList(
    host.identityFiles,
    defaults.identityFiles
  )
    ? []
    : host.identityFiles

  return {
    alias,
    user: host.user,
    hostname: host.hostname,
    port: explicitPort(host.port, defaults.port),
    identityFile: identityFiles[0] ?? null,
    identityFiles,
    source: 'ssh-g',
  }
}

/**
 * Read Host aliases from `~/.ssh/config` and Include files.
 *
 * `ssh -G` cannot list every Host token, so listing is a file parse. Relative
 * Include paths resolve under `~/.ssh`, matching OpenSSH.
 */
export async function loadUserSshConfig(
  home: string
): Promise<ILoadedSshConfig> {
  const aliases: string[] = []
  const blocks = new Map<string, ISshConfigBlock>()
  const visited = new Set<string>()
  const root = path.join(home, '.ssh', 'config')

  try {
    const existed = await walkConfigFile(
      root,
      home,
      aliases,
      blocks,
      visited,
      true
    )
    if (!existed) {
      return { aliases, blocks, error: 'missing' }
    }
  } catch {
    return { aliases, blocks, error: 'unreadable' }
  }

  return { aliases, blocks, error: null }
}

export async function listSshConfigHostAliases(
  home: string = sshConfigHomeDirectory()
): Promise<{
  readonly aliases: readonly string[]
  readonly hint: string | null
}> {
  const loaded = await loadUserSshConfig(home)
  return { aliases: loaded.aliases, hint: sshConfigListHint(loaded) }
}

/**
 * Resolve one alias to concrete connection fields.
 *
 * `ssh -G` is preferred so Include files and `Host *` match a real
 * connection. A lightweight parse of the Host block is the fallback when
 * `ssh` cannot be queried. The last resort, for a hostname with no config
 * entry, is this machine's user name and no port or identity file.
 */
export async function resolveSshConfigHost(
  alias: string,
  options: IResolveSshConfigHostOptions = {}
): Promise<ISshConfigHostEndpoint | null> {
  if (!isQueryableSshHostAlias(alias)) {
    return null
  }

  const fromSsh = await endpointFromQuery(alias, options)
  if (fromSsh) {
    return fromSsh
  }

  const username = options.username ?? currentUsername()
  const block = await lookupBlock(alias, options)
  if (block) {
    const fromFile = endpointFromBlock(alias, block, username)
    if (fromFile) {
      return fromFile
    }
  }

  if (!username) {
    return null
  }

  return {
    alias,
    user: username,
    hostname: alias,
    port: null,
    identityFile: null,
    identityFiles: [],
    source: 'config-file',
  }
}

/**
 * Manual form → connection fields.
 *
 * `user@host` is unchanged and does not consult SSH config. A bare alias is
 * resolved, and a blank port or identity file does not replace a value the
 * config left unset.
 */
export async function resolveManualSshConnection(
  input: SshManualConnectionInput,
  overrides: {
    readonly port: number | null
    readonly identityFile: string | null
  },
  options: IResolveSshConfigHostOptions = {}
): Promise<ISshConnectionFields | null> {
  if (input.kind === 'explicit') {
    return {
      user: input.user,
      hostname: input.hostname,
      port: overrides.port ?? input.port,
      identityFile: overrides.identityFile,
    }
  }

  const resolved = await resolveSshConfigHost(input.alias, options)
  if (resolved === null) {
    return null
  }

  return {
    user: resolved.user,
    hostname: resolved.hostname,
    port: overrides.port ?? resolved.port,
    identityFile: overrides.identityFile ?? resolved.identityFile,
  }
}

function endpointFromBlock(
  alias: string,
  block: ISshConfigBlock,
  username: string
): ISshConfigHostEndpoint | null {
  const user = block.user ?? username
  if (!user) {
    return null
  }

  return {
    alias,
    user,
    hostname: block.hostName ?? alias,
    port: block.port,
    identityFile: block.identityFiles[0] ?? null,
    identityFiles: block.identityFiles,
    source: 'config-file',
  }
}

async function endpointFromQuery(
  alias: string,
  options: IResolveSshConfigHostOptions
): Promise<ISshConfigHostEndpoint | null> {
  try {
    const [hostOut, defaultOut] = await Promise.all([
      querySshG(alias, options.runSshG),
      querySshG(SshConfigDefaultProbeHost, options.runSshG),
    ])
    if (hostOut === null) {
      return null
    }

    const host = parseSshGOutput(hostOut)
    // Without a probe, treat the host's own identity list as the default so
    // a failed probe cannot turn compiled-in keys into an explicit `-i`.
    const defaults =
      defaultOut === null
        ? {
            user: host.user,
            hostname: null,
            port: OpenSshDefaultPort,
            identityFiles: host.identityFiles,
          }
        : parseSshGOutput(defaultOut)
    return endpointFromSshG(alias, host, defaults)
  } catch {
    return null
  }
}

async function lookupBlock(
  alias: string,
  options: IResolveSshConfigHostOptions
): Promise<ISshConfigBlock | null> {
  if (options.lookupConfigBlock) {
    return options.lookupConfigBlock(alias)
  }

  try {
    const loaded = await loadUserSshConfig(sshConfigHomeDirectory())
    return loaded.blocks.get(alias) ?? null
  } catch {
    return null
  }
}

async function querySshG(
  alias: string,
  run: ((alias: string) => Promise<string | null>) | undefined
): Promise<string | null> {
  if (run) {
    return run(alias)
  }

  if (alias === SshConfigDefaultProbeHost) {
    if (probeStdout === null) {
      probeStdout = defaultRunSshG(alias)
    }
    return probeStdout
  }

  return defaultRunSshG(alias)
}

async function defaultRunSshG(alias: string): Promise<string | null> {
  if (!isQueryableSshHostAlias(alias)) {
    return null
  }

  try {
    // `-F` is intentionally absent so Include, `Host *`, and the system
    // config match the ssh client that later connects.
    const result = await execFile(findSystemSsh(), ['-G', '--', alias], {
      timeout: SshGTimeoutMs,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: MaxConfigChars,
    })
    return stdoutText(result.stdout)
  } catch (error) {
    log.debug(`Failed to read SSH configuration for '${alias}'`, error)
    return null
  }
}

function stdoutText(stdout: string | Buffer): string {
  return typeof stdout === 'string' ? stdout : stdout.toString('utf8')
}

function currentUsername(): string {
  try {
    return os.userInfo().username
  } catch {
    return process.env.USER || process.env.USERNAME || ''
  }
}

function explicitPort(
  hostPort: number | null,
  defaultPort: number | null
): number | null {
  if (hostPort === null) {
    return null
  }
  if (defaultPort !== null && hostPort !== defaultPort) {
    return hostPort
  }
  if (hostPort !== OpenSshDefaultPort) {
    return hostPort
  }
  return null
}

function sameStringList(
  left: readonly string[],
  right: readonly string[]
): boolean {
  if (left.length !== right.length) {
    return false
  }
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) {
      return false
    }
  }
  return true
}

async function walkConfigFile(
  filePath: string,
  home: string,
  aliases: string[],
  blocks: Map<string, ISshConfigBlock>,
  visited: Set<string>,
  isRoot: boolean
): Promise<boolean> {
  if (visited.size >= MaxConfigFiles) {
    return true
  }

  const resolved = path.resolve(filePath)
  if (visited.has(resolved)) {
    return true
  }
  visited.add(resolved)

  let text: string
  try {
    text = await readFile(resolved, 'utf8')
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      return false
    }
    if (isNodeError(error, 'EISDIR')) {
      if (isRoot) {
        throw error
      }
      return true
    }
    if (!isRoot) {
      return true
    }
    throw error
  }

  if (text.length > MaxConfigChars) {
    text = text.slice(0, MaxConfigChars)
  }

  for (const event of parseSshConfigEvents(text)) {
    if (event.kind === 'include') {
      for (const pattern of event.patterns) {
        const expanded = expandIncludePattern(pattern, home)
        const matches = await expandInclude(expanded)
        for (const match of matches) {
          await walkConfigFile(match, home, aliases, blocks, visited, false)
        }
      }
      continue
    }

    addHostBlock(event.block, aliases, blocks)
  }

  return true
}

function addHostBlock(
  block: ISshConfigHostBlock,
  aliases: string[],
  blocks: Map<string, ISshConfigBlock>
): void {
  const fields: ISshConfigBlock = {
    user: block.user,
    hostName: block.hostName,
    port: block.port,
    identityFiles: block.identityFiles,
  }
  for (const pattern of block.patterns) {
    if (!isQueryableSshHostAlias(pattern) || blocks.has(pattern)) {
      continue
    }
    blocks.set(pattern, fields)
    aliases.push(pattern)
  }
}

function expandIncludePattern(pattern: string, home: string): string {
  let expanded = pattern
  if (expanded === '~') {
    expanded = home
  } else if (expanded.startsWith('~/') || expanded.startsWith('~\\')) {
    expanded = path.join(home, expanded.slice(2))
  }

  if (path.isAbsolute(expanded)) {
    return expanded
  }

  // OpenSSH resolves a relative Include in the user config against ~/.ssh,
  // not against the file that contained the Include.
  return path.resolve(path.join(home, '.ssh'), expanded)
}

async function expandInclude(pattern: string): Promise<readonly string[]> {
  const normalized = pattern.split(path.sep).join('/')
  const matches: string[] = []
  try {
    for await (const entry of glob(normalized)) {
      matches.push(entry)
      if (matches.length >= MaxIncludeMatches) {
        break
      }
    }
  } catch {
    return []
  }

  matches.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
  return matches
}

function logicalLines(contents: string): readonly string[] {
  const lines: string[] = []
  let buffer = ''
  let pending = false
  for (const physicalLine of contents.split(/\r?\n/)) {
    buffer = pending ? buffer + physicalLine : physicalLine
    if (buffer.endsWith('\\')) {
      buffer = buffer.slice(0, -1)
      pending = true
      continue
    }
    pending = false
    lines.push(buffer)
    buffer = ''
  }
  if (pending && buffer.length > 0) {
    lines.push(buffer)
  }
  return lines
}

function tokenizeConfigLine(line: string): string[] {
  const tokens: string[] = []
  const length = line.length
  let index = 0
  while (index < length) {
    const char = line[index]
    if (char === ' ' || char === '\t') {
      index++
      continue
    }
    if (char === '#') {
      break
    }
    if (char === '"') {
      index++
      let value = ''
      while (index < length && line[index] !== '"') {
        if (line[index] === '\\' && index + 1 < length) {
          value += line[index + 1]
          index += 2
          continue
        }
        value += line[index]
        index++
      }
      if (index < length && line[index] === '"') {
        index++
      }
      tokens.push(value)
      continue
    }

    let value = ''
    while (
      index < length &&
      line[index] !== ' ' &&
      line[index] !== '\t' &&
      line[index] !== '#'
    ) {
      value += line[index]
      index++
    }
    if (value.length > 0) {
      tokens.push(value)
    }
  }
  return tokens
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === code
  )
}
