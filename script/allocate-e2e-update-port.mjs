#!/usr/bin/env node
/**
 * Print an OS-assigned free IPv4 loopback port for DESKTOP_E2E_UPDATES_URL.
 *
 * Windows GitHub runners often deny bind() on fixed ports (EACCES) when they
 * fall inside Hyper-V / WinNAT excluded ranges. listen(0) returns a safe port.
 */
import net from 'net'

const server = net.createServer()

server.once('error', error => {
  console.error(error)
  process.exit(1)
})

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  if (address === null || typeof address === 'string') {
    console.error('Failed to allocate a loopback port')
    process.exit(1)
  }

  const { port } = address
  server.close(err => {
    if (err) {
      console.error(err)
      process.exit(1)
    }
    process.stdout.write(String(port))
  })
})
