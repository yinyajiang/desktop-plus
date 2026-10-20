import { ISshRemoteLocation } from './ssh-remote-location'

const StorageKey = 'ssh-remote-recent-hosts'
const MaxRecentHosts = 8

/** A connection the user typed, remembered so it can be filled in again. */
export interface ISshRecentHost {
  readonly user: string
  readonly hostname: string
  readonly port: number | null
  readonly identityFile: string | null
}

export function sshRecentHostKey(host: ISshRecentHost): string {
  return `${host.user}\0${host.hostname}\0${host.port ?? ''}\0${
    host.identityFile ?? ''
  }`
}

export function formatSshRecentHost(host: ISshRecentHost): string {
  const port = host.port === null ? '' : `:${host.port}`
  const identity = host.identityFile ? ` (${host.identityFile})` : ''
  return `${host.user}@${host.hostname}${port}${identity}`
}

export function recentHostFromLocation(
  location: ISshRemoteLocation
): ISshRecentHost {
  return {
    user: location.user,
    hostname: location.hostname,
    port: location.port,
    identityFile: location.identityFile,
  }
}

/**
 * Recently typed SSH hosts. This list is not loaded from ~/.ssh/config.
 */
export function getRecentSshHosts(): ReadonlyArray<ISshRecentHost> {
  try {
    const raw = localStorage.getItem(StorageKey)
    if (!raw) {
      return []
    }

    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return []
    }

    return parsed.filter(isSshRecentHost).slice(0, MaxRecentHosts)
  } catch {
    return []
  }
}

export function rememberSshHost(
  host: ISshRecentHost
): ReadonlyArray<ISshRecentHost> {
  const key = sshRecentHostKey(host)
  const next = [
    host,
    ...getRecentSshHosts().filter(
      existing => sshRecentHostKey(existing) !== key
    ),
  ].slice(0, MaxRecentHosts)

  localStorage.setItem(StorageKey, JSON.stringify(next))
  return next
}

function isSshRecentHost(value: unknown): value is ISshRecentHost {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const host = value as Record<string, unknown>
  return (
    typeof host.user === 'string' &&
    host.user.length > 0 &&
    typeof host.hostname === 'string' &&
    host.hostname.length > 0 &&
    (host.port === null || typeof host.port === 'number') &&
    (host.identityFile === null || typeof host.identityFile === 'string')
  )
}
