import assert from 'node:assert'
import http from 'http'
import { after, describe, it } from 'node:test'
import {
  allocateAvailableLoopbackPort,
  createMockUpdateServer,
} from '../../e2e/mock-update-server'

describe('createMockUpdateServer port binding', () => {
  const previous = process.env.DESKTOP_E2E_UPDATES_URL

  after(() => {
    if (previous === undefined) {
      delete process.env.DESKTOP_E2E_UPDATES_URL
    } else {
      process.env.DESKTOP_E2E_UPDATES_URL = previous
    }
  })

  it('listens on the port from DESKTOP_E2E_UPDATES_URL', async () => {
    const port = await allocateAvailableLoopbackPort()
    process.env.DESKTOP_E2E_UPDATES_URL = `http://127.0.0.1:${port}/update`

    const server = await createMockUpdateServer()
    try {
      assert.strictEqual(server.port, port)
      assert.strictEqual(server.url, `http://127.0.0.1:${port}/update`)

      const status = await new Promise<number>((resolve, reject) => {
        http
          .get(`http://127.0.0.1:${port}/update`, res => {
            res.resume()
            resolve(res.statusCode ?? 0)
          })
          .on('error', reject)
      })
      assert.strictEqual(status, 204)
    } finally {
      await server.close()
    }
  })
})
