import assert from 'node:assert'
import { describe, it } from 'node:test'
import net from 'net'
import {
  DEFAULT_MOCK_UPDATE_PORT,
  allocateAvailableLoopbackPort,
  getMockControlUrl,
  getMockUpdatePort,
  getMockUpdateUrl,
  parseMockUpdatePort,
} from '../../e2e/mock-update-port'

describe('mock update port helpers', () => {
  it('parses explicit ports from DESKTOP_E2E_UPDATES_URL values', () => {
    assert.strictEqual(
      parseMockUpdatePort('http://127.0.0.1:51789/update'),
      51789
    )
    assert.strictEqual(
      parseMockUpdatePort('http://127.0.0.1:48012/update'),
      48012
    )
    assert.strictEqual(parseMockUpdatePort('http://127.0.0.1/update'), 80)
    assert.strictEqual(parseMockUpdatePort('https://127.0.0.1/update'), 443)
    assert.strictEqual(parseMockUpdatePort(undefined), null)
    assert.strictEqual(parseMockUpdatePort('not-a-url'), null)
  })

  it('uses the env URL port when present and otherwise the default', () => {
    assert.strictEqual(
      getMockUpdatePort('http://127.0.0.1:48012/update'),
      48012
    )
    assert.strictEqual(getMockUpdatePort(undefined), DEFAULT_MOCK_UPDATE_PORT)
    assert.strictEqual(getMockUpdateUrl(48012), 'http://127.0.0.1:48012/update')
    assert.strictEqual(
      getMockControlUrl(48012),
      'http://127.0.0.1:48012/_control'
    )
  })

  it('allocates a free loopback port that can be bound again', async () => {
    const port = await allocateAvailableLoopbackPort()
    assert.ok(port > 0 && port <= 65535)

    const server = net.createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', resolve)
    })
    await new Promise<void>((resolve, reject) =>
      server.close(err => (err ? reject(err) : resolve()))
    )
  })
})
