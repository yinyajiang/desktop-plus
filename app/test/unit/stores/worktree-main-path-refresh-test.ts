import { isolateGitConfig } from '../../helpers/git-config'
import assert from 'node:assert'
import { describe, it, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { rm } from 'fs/promises'
import { exec } from 'dugite'
import { AppStore } from '../../../src/lib/stores/app-store'
import { BackgroundPruneMinimumInterval } from '../../../src/lib/stores/helpers/branch-pruner'
import { listWorktrees } from '../../../src/lib/git'
import { Repository } from '../../../src/models/repository'
import { createAssistedCommitRunHarness } from '../../helpers/assisted-commit-run'
import { seed } from '../../helpers/assisted-commit'

/**
 * Intercept the pruner interval so a regression fails the assertion instead
 * of leaving the referenced 4h timer that keeps the test worker alive.
 * Handles are cleared again on the way out. The unmocked clone suite is what
 * proves the worker actually exits.
 */
function trackPruneIntervals(t: TestContext, appStore: AppStore) {
  const scheduled: number[] = []
  const handles: number[] = []
  let nextHandle = 1
  t.mock.method(
    window,
    'setInterval',
    (_handler: TimerHandler, timeout?: number) => {
      if (typeof timeout === 'number') {
        scheduled.push(timeout)
      }
      const handle = nextHandle++
      handles.push(handle)
      return handle
    }
  )

  const release = () => {
    appStore['stopBackgroundPruner']()
    appStore['stopWorktreeDiscovery']()
    appStore['stopBackgroundFetching']()
    appStore['stopPullRequestUpdater']()
    for (const handle of handles) {
      window.clearInterval(handle)
    }
  }
  t.after(release)
  return { scheduled, release }
}

function countMainPathWrites(
  t: TestContext,
  stores: Awaited<ReturnType<typeof createAssistedCommitRunHarness>>['stores']
) {
  let writes = 0
  const original =
    stores.repositoriesStore.updateRepositoryMainWorktreePath.bind(
      stores.repositoriesStore
    )
  t.mock.method(
    stores.repositoriesStore,
    'updateRepositoryMainWorktreePath',
    async (
      ...args: Parameters<
        typeof stores.repositoriesStore.updateRepositoryMainWorktreePath
      >
    ) => {
      writes++
      return original(...args)
    }
  )
  return () => writes
}

async function waitFor(predicate: () => boolean, label: string) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > 10000) {
      throw new Error(`timed out waiting for ${label}`)
    }
    await delay(25)
  }
}

describe('main worktree path refresh', { concurrency: 1 }, () => {
  it('does not select a repository that is not loaded when its worktrees refresh', async t => {
    await isolateGitConfig(t)
    const h = await createAssistedCommitRunHarness(t)
    const intervals = trackPruneIntervals(t, h.appStore)
    const writes = countMainPathWrites(t, h.stores)
    const source = await seed(t, { file: 'unselected\n' })
    const repository = await h.register(source)

    assert.equal(h.appStore['selectedRepository'], null)
    assert.equal(h.appStore['repositories'].length, 0)

    await h.appStore._refreshRepository(repository)
    await delay(250)

    assert.equal(h.appStore['selectedRepository'], null)
    assert.equal(writes(), 0)
    assert.equal(
      intervals.scheduled.includes(BackgroundPruneMinimumInterval),
      false
    )
    const [persisted] = await h.stores.repositoriesStore.getAll()
    assert.equal(persisted.mainWorktreePath, undefined)
    assert.equal(h.appStore['currentBranchPruner'], null)
  })

  it('does not select a loaded repository that is not the current selection', async t => {
    await isolateGitConfig(t)
    const h = await createAssistedCommitRunHarness(t)
    const intervals = trackPruneIntervals(t, h.appStore)
    const writes = countMainPathWrites(t, h.stores)
    const source = await seed(t, { file: 'loaded\n' })
    await h.register(source)
    const loaded = await h.stores.repositoriesStore.getAll()
    h.appStore['setRepositories'](loaded)

    assert.equal(h.appStore['selectedRepository'], null)
    await h.appStore._refreshRepository(loaded[0])
    await delay(250)

    assert.equal(h.appStore['selectedRepository'], null)
    assert.equal(writes(), 0)
    assert.equal(
      intervals.scheduled.includes(BackgroundPruneMinimumInterval),
      false
    )
    const [persisted] = await h.stores.repositoriesStore.getAll()
    assert.equal(persisted.mainWorktreePath, undefined)
    assert.equal(h.appStore['currentBranchPruner'], null)
  })

  it('records the main path for the selected repository without another prune interval', async t => {
    await isolateGitConfig(t)
    assert.equal(BackgroundPruneMinimumInterval, 4 * 60 * 60 * 1000)
    const h = await createAssistedCommitRunHarness(t)
    const intervals = trackPruneIntervals(t, h.appStore)
    const writes = countMainPathWrites(t, h.stores)
    const main = await seed(t, { file: 'selected\n' })
    const linkedPath = `${main.path}-linked`
    t.after(() => rm(linkedPath, { recursive: true, force: true }))
    await exec(['worktree', 'add', '-b', 'feature', linkedPath], main.path)
    await h.register(new Repository(linkedPath, -1, null, false))
    const [loaded] = await h.stores.repositoriesStore.getAll()
    h.appStore['setRepositories']([loaded])

    await h.appStore._selectRepository(loaded)
    await h.appStore._refreshRepository(loaded)
    await waitFor(
      () => intervals.scheduled.includes(BackgroundPruneMinimumInterval),
      'the selected repository prune interval'
    )
    await waitFor(
      () => writes() >= 1,
      'the selected repository main path write'
    )

    let stableWrites = writes()
    let stableSince = Date.now()
    const settleStarted = Date.now()
    while (Date.now() - stableSince < 200) {
      if (Date.now() - settleStarted > 10000) {
        throw new Error('main path writes did not settle')
      }
      if (writes() !== stableWrites) {
        stableWrites = writes()
        stableSince = Date.now()
      }
      await delay(25)
    }

    const discovered = (await listWorktrees(loaded)).find(
      worktree => worktree.type === 'main'
    )
    assert.ok(discovered)
    assert.notEqual(discovered.path, loaded.path)
    const [persisted] = await h.stores.repositoriesStore.getAll()
    assert.equal(persisted.path, linkedPath)
    assert.equal(persisted.mainWorktreePath, discovered.path)
    const selected = h.appStore['selectedRepository']
    assert.ok(selected instanceof Repository)
    assert.equal(selected.id, loaded.id)
    assert.equal(selected.path, linkedPath)
    assert.equal(selected.mainWorktreePath, discovered.path)

    const writesAfterSettle = writes()
    const intervalsAfterSettle = intervals.scheduled.length
    await h.appStore._refreshRepository(loaded)
    await delay(400)

    assert.equal(writes(), writesAfterSettle)
    assert.ok(writesAfterSettle <= 2)
    assert.equal(intervals.scheduled.length, intervalsAfterSettle)
    assert.deepEqual(
      intervals.scheduled.filter(
        timeout => timeout === BackgroundPruneMinimumInterval
      ),
      [BackgroundPruneMinimumInterval]
    )
    intervals.release()
  })
})
