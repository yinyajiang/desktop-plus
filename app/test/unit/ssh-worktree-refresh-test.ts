import assert from 'node:assert'
import { describe, it } from 'node:test'
import { SshWorktreeRefreshScheduler } from '../../src/lib/ssh-worktree-refresh'

async function waitFor(check: () => boolean): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > 2000) {
      throw new Error('timed out waiting for worktree refresh')
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

describe('SSH worktree refresh scheduler', () => {
  it('runs a queued refresh after the in-flight one and stops after stop()', async t => {
    let releaseFirst: () => void = () => {}
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve
    })
    let calls = 0
    const scheduler = new SshWorktreeRefreshScheduler(async () => {
      calls++
      if (calls === 1) {
        await firstGate
      }
    }, 60_000)
    t.after(() => scheduler.stop())

    scheduler.start()
    scheduler.request()
    scheduler.request()
    scheduler.request()
    assert.strictEqual(calls, 1)

    releaseFirst()
    await waitFor(() => calls === 2)
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.strictEqual(calls, 2)

    scheduler.stop()
    scheduler.request()
    assert.strictEqual(calls, 2)
  })

  it('keeps scheduling after a refresh throws', async t => {
    let calls = 0
    const scheduler = new SshWorktreeRefreshScheduler(async () => {
      calls++
      if (calls === 1) {
        throw new Error('ssh transport failed')
      }
    }, 60_000)
    t.after(() => scheduler.stop())

    scheduler.start()
    scheduler.request()
    await waitFor(() => calls === 1)
    scheduler.request()
    await waitFor(() => calls === 2)
  })

  it('drops a queued refresh when stopped during the in-flight one', async t => {
    let releaseFirst: () => void = () => {}
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve
    })
    let calls = 0
    const scheduler = new SshWorktreeRefreshScheduler(async () => {
      calls++
      if (calls === 1) {
        await firstGate
      }
    }, 60_000)
    t.after(() => scheduler.stop())

    scheduler.start()
    scheduler.request()
    scheduler.request()
    scheduler.stop()
    releaseFirst()
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.strictEqual(calls, 1)
  })
})
