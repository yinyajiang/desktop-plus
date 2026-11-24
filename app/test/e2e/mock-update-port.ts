import net from 'net'

/** Default loopback port when DESKTOP_E2E_UPDATES_URL is unset. */
export const DEFAULT_MOCK_UPDATE_PORT = 51789

/**
 * Parse the TCP port from a DESKTOP_E2E_UPDATES_URL-style value.
 *
 * Returns null when the value is missing or not an http(s) URL with a
 * valid port (or a default port for the scheme).
 */
export function parseMockUpdatePort(
  updatesUrl: string | undefined
): number | null {
  if (updatesUrl === undefined || updatesUrl.trim() === '') {
    return null
  }

  try {
    const url = new URL(updatesUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null
    }

    if (url.port !== '') {
      const port = Number(url.port)
      return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null
    }

    return url.protocol === 'https:' ? 443 : 80
  } catch {
    return null
  }
}

/**
 * Port the mock update server should bind.
 *
 * Prefer DESKTOP_E2E_UPDATES_URL so packaged builds (which bake that URL into
 * the app) and the mock server stay on the same port. Fall back to the
 * historical default when unset.
 */
export function getMockUpdatePort(
  updatesUrl: string | undefined = process.env.DESKTOP_E2E_UPDATES_URL
): number {
  return parseMockUpdatePort(updatesUrl) ?? DEFAULT_MOCK_UPDATE_PORT
}

export function getMockUpdateUrl(port: number = getMockUpdatePort()): string {
  return `http://127.0.0.1:${port}/update`
}

export function getMockControlUrl(port: number = getMockUpdatePort()): string {
  return `http://127.0.0.1:${port}/_control`
}

/**
 * Ask the OS for a free IPv4 loopback port.
 *
 * On Windows GitHub-hosted runners, fixed ports such as 51789 often fall
 * inside Hyper-V / WinNAT excluded ranges and fail with EACCES. An
 * OS-assigned port from listen(0) is outside those ranges.
 */
export function allocateAvailableLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() =>
          reject(new Error('Failed to allocate a loopback port'))
        )
        return
      }

      const { port } = address
      server.close(err => (err ? reject(err) : resolve(port)))
    })
  })
}
