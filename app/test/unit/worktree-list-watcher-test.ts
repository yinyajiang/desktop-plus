import assert from 'node:assert'
import { mkdir } from 'fs/promises'
import { join } from 'path'
import { describe, it } from 'node:test'
import { exec } from 'dugite'
import { setupEmptyRepository } from '../helpers/repositories'
import { makeCommit } from '../helpers/repository-scaffolding'
import { createTempDirectory } from '../helpers/temp'
import { watchLocalWorktreeList } from '../../src/lib/worktree-list-watcher'
import { formatSshRemoteLocation } from '../../src/lib/ssh/ssh-remote-location'

async function waitFor(check: () => boolean): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > 2000) {
      throw new Error('timed out waiting for the worktree watcher')
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

describe('local worktree list watcher', () => {
  it('notices the worktrees directory appearing and a later add, then ignores events after dispose', async t => {
    const repo = await setupEmptyRepository(t, 'main')
    await makeCommit(repo, {
      entries: [{ path: 'README', contents: 'hello' }],
    })

    let events = 0
    const listWatch = await watchLocalWorktreeList(repo.path, () => {
      events++
    })

    const worktreesDir = join(repo.path, '.git', 'worktrees')
    await mkdir(worktreesDir)
    await waitFor(() => events >= 1)
    const afterCreate = events

    await mkdir(join(worktreesDir, 'feature-a'))
    await waitFor(() => events > afterCreate)

    listWatch.dispose()
    const afterDispose = events
    await mkdir(join(worktreesDir, 'feature-b'))
    await new Promise(resolve => setTimeout(resolve, 500))
    assert.strictEqual(events, afterDispose)
  })

  it('watches the common git dir from a linked checkout whose .git entry is a file', async t => {
    const repo = await setupEmptyRepository(t, 'main')
    await makeCommit(repo, {
      entries: [{ path: 'README', contents: 'hello' }],
    })
    await exec(['branch', 'feature-a'], repo.path)
    const linkedPath = join(await createTempDirectory(t), 'linked')
    await exec(['worktree', 'add', linkedPath, 'feature-a'], repo.path)
    t.after(async () => {
      await exec(
        ['worktree', 'remove', '--force', linkedPath],
        repo.path
      ).catch(() => {})
    })

    let events = 0
    const listWatch = await watchLocalWorktreeList(linkedPath, () => {
      events++
    })
    t.after(() => listWatch.dispose())

    const worktreesDir = join(repo.path, '.git', 'worktrees')
    await mkdir(join(worktreesDir, 'another'))
    await waitFor(() => events >= 1)
  })

  it('does not watch an SSH virtual path', async () => {
    let called = false
    const listWatch = await watchLocalWorktreeList(
      formatSshRemoteLocation({
        user: 'dev',
        hostname: 'build.example',
        port: null,
        identityFile: null,
        remotePath: '/srv/repos/main',
      }),
      () => {
        called = true
      }
    )
    listWatch.dispose()
    assert.strictEqual(called, false)
  })
})
