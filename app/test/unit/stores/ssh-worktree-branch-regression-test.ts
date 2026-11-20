/**
 * Integration regression for SSH worktree discovery, branch lists, and switch.
 *
 * Fake desktop-ssh paths only — never dials a real host.
 *
 * mock.module must run before any import of ssh-remote-git (including
 * transitive imports through status/operation helpers).
 */
import { before, describe, it, mock, type TestContext } from 'node:test'
import assert from 'node:assert'
import { setTimeout as delay } from 'node:timers/promises'
import { resolve } from 'path'
import {
  formatSshRemoteLocation,
  formatSshResourcePath,
  isSshRemotePath,
} from '../../../src/lib/ssh/ssh-remote-location'

type TGitArgs = ReadonlyArray<string>

const location = {
  user: 'repro',
  hostname: 'example.invalid',
  port: 3333,
  identityFile: null as string | null,
  remotePath: '/tmp/fake-ssh-main',
}

const mainVirtual = formatSshRemoteLocation(location)
const linkedVirtual = formatSshRemoteLocation({
  ...location,
  remotePath: '/tmp/fake-ssh-linked',
})

const shaMain = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const gitCalls: Array<{ path: string; args: TGitArgs }> = []
let forEachRefBehavior: 'ok' | 'throw' = 'ok'

function forEachRefStdout(branchNames: ReadonlyArray<string>): string {
  const nul = '\u0000'
  const nl = '\n'
  return branchNames
    .map((name, i) => {
      const sha = `${'c'.repeat(39)}${i}`
      return [
        '',
        `refs/heads/${name}`,
        name,
        '',
        '',
        sha,
        '',
        '2024-01-01 00:00:00 +0000',
        nl,
      ].join(nul)
    })
    .join('')
}

function worktreeListStdout(): string {
  const nul = '\u0000'
  return [
    [
      'worktree /tmp/fake-ssh-main',
      `HEAD ${shaMain}`,
      'branch refs/heads/main',
    ].join(nul),
    [
      'worktree /tmp/fake-ssh-linked',
      'HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'branch refs/heads/feature',
    ].join(nul),
  ].join(`${nul}${nul}`)
}

function commitLogBuffer(sha: string): Buffer {
  const nul = '\u0000'
  const fields = [
    sha,
    sha.slice(0, 7),
    'commit summary',
    'commit body',
    'Ada <ada@example.com> 1700000000 +0000',
    'Ada <ada@example.com> 1700000000 +0000',
    '',
    '',
    'HEAD -> main',
  ]
  return Buffer.from(fields.join(nul) + nul)
}

let exec: typeof import('dugite').exec
let isolateGitConfig: typeof import('../../helpers/git-config').isolateGitConfig
let createAssistedCommitRunHarness: typeof import('../../helpers/assisted-commit-run').createAssistedCommitRunHarness
let seed: typeof import('../../helpers/assisted-commit').seed
let createTempDirectory: typeof import('../../helpers/temp').createTempDirectory
let canonicalMutationPath: typeof import('../../../src/lib/git/repository-operation').canonicalMutationPath
let getAssistedCommitProtectedPaths: typeof import('../../../src/lib/git/repository-operation').getAssistedCommitProtectedPaths
let isRepositoryAffectedByAssistedCommit: typeof import('../../../src/lib/git/repository-operation').isRepositoryAffectedByAssistedCommit
let protectAssistedCommitResources: typeof import('../../../src/lib/git/repository-operation').protectAssistedCommitResources
let repositoryPathsOverlap: typeof import('../../../src/lib/git/repository-operation').repositoryPathsOverlap
let withRepositoryGitOperation: typeof import('../../../src/lib/git/repository-operation').withRepositoryGitOperation
let AssistedCommitError: typeof import('../../../src/lib/git/assisted-commit').AssistedCommitError
let Repository: typeof import('../../../src/models/repository').Repository
let TipState: typeof import('../../../src/models/tip').TipState
let BackgroundPruneMinimumInterval: typeof import('../../../src/lib/stores/helpers/branch-pruner').BackgroundPruneMinimumInterval
let ipcRenderer: typeof import('electron').ipcRenderer

before(async () => {
  mock.module('../../../src/lib/ssh/ssh-remote-git', {
    namedExports: {
      execGitOverSsh: async (
        path: string,
        args: TGitArgs,
        options?: { encoding?: string | null }
      ) => {
        gitCalls.push({ path, args: [...args] })
        const asBuffer = options?.encoding === 'buffer'
        const wrap = (stdout: string | Buffer, exitCode = 0) => ({
          stdout: asBuffer
            ? Buffer.isBuffer(stdout)
              ? stdout
              : Buffer.from(stdout)
            : Buffer.isBuffer(stdout)
            ? stdout.toString('utf8')
            : stdout,
          stderr: '',
          exitCode,
          stderrText: '',
        })

        if (args.includes('for-each-ref')) {
          if (forEachRefBehavior === 'throw') {
            throw new Error('Expected newline')
          }
          return wrap(forEachRefStdout(['main', 'feature', 'hotfix']))
        }
        if (args.includes('worktree') && args.includes('list')) {
          return wrap(worktreeListStdout())
        }
        if (args.includes('status')) {
          return wrap(
            Buffer.from(`# branch.oid ${shaMain}\0# branch.head main\0`)
          )
        }
        if (args.includes('log')) {
          return wrap(commitLogBuffer(shaMain))
        }
        if (args.includes('rev-parse')) {
          if (args.includes('--absolute-git-dir')) {
            return wrap('/tmp/fake-ssh-main/.git\n')
          }
          if (args.includes('--git-common-dir')) {
            return wrap('/tmp/fake-ssh-main/.git\n')
          }
          if (args.includes('objects')) {
            return wrap('/tmp/fake-ssh-main/.git/objects\n')
          }
          return wrap('false\n\n.git\n')
        }
        if (args.includes('count-objects')) {
          return wrap('')
        }
        if (args.includes('config')) {
          return wrap('', 1)
        }
        if (args.includes('symbolic-ref')) {
          return wrap('refs/remotes/origin/main\n')
        }
        if (args.includes('--get-regexp') || args.includes('remote')) {
          return wrap('', 1)
        }
        return wrap('')
      },
      probeSshRepository: async (virtualPath: string) => {
        const remote =
          virtualPath === linkedVirtual
            ? '/tmp/fake-ssh-linked'
            : '/tmp/fake-ssh-main'
        return {
          kind: 'regular' as const,
          topLevelWorkingDirectory: virtualPath,
          gitDir: `${remote}/.git`,
        }
      },
      sshRemoteLocationExists: async () => true,
      readSshFileBundle: async () => new Map(),
      readSshTextFile: async () => null,
      readSshFilePrefix: async () => Buffer.alloc(0),
      sshAbsoluteFileExists: async () => false,
      statSshFile: async () => null,
      SshRemoteError: class SshRemoteError extends Error {
        public constructor(message: string, public readonly exitCode?: number) {
          super(message)
          this.name = 'SshRemoteError'
        }
      },
      SshSymlinkError: class SshSymlinkError extends Error {
        public constructor(path: string) {
          super(`Refusing to follow symbolic link ${path}.`)
          this.name = 'SshSymlinkError'
        }
      },
    },
  })
  ;[
    { exec },
    { isolateGitConfig },
    { createAssistedCommitRunHarness },
    { seed },
    { createTempDirectory },
    {
      canonicalMutationPath,
      getAssistedCommitProtectedPaths,
      isRepositoryAffectedByAssistedCommit,
      protectAssistedCommitResources,
      repositoryPathsOverlap,
      withRepositoryGitOperation,
    },
    { AssistedCommitError },
    { Repository },
    { TipState },
    { BackgroundPruneMinimumInterval },
    { ipcRenderer },
  ] = await Promise.all([
    import('dugite'),
    import('../../helpers/git-config'),
    import('../../helpers/assisted-commit-run'),
    import('../../helpers/assisted-commit'),
    import('../../helpers/temp'),
    import('../../../src/lib/git/repository-operation'),
    import('../../../src/lib/git/assisted-commit'),
    import('../../../src/models/repository'),
    import('../../../src/models/tip'),
    import('../../../src/lib/stores/helpers/branch-pruner'),
    import('electron'),
  ])
})

function ensureIpcSend() {
  if (typeof ipcRenderer.send !== 'function') {
    ;(ipcRenderer as { send: (...args: unknown[]) => void }).send = () => {}
  }
}

function trackPruneIntervals(t: TestContext, appStore: any) {
  const handles: number[] = []
  let next = 1
  t.mock.method(
    window,
    'setInterval',
    (_handler: TimerHandler, _timeout?: number) => {
      const handle = next++
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
  return { release }
}

/** Let fire-and-forget refresh tails finish while the harness DB is still open. */
async function settleSelection(release: () => void) {
  await delay(300)
  release()
  await delay(50)
}

async function waitFor(predicate: () => boolean, label: string) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > 10000) {
      throw new Error(`timed out waiting for ${label}`)
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

async function registerSshRepository(
  h: Awaited<ReturnType<typeof createAssistedCommitRunHarness>>,
  virtualPath: string
) {
  const id = await h.stores.repositoriesStore['db'].repositories.add({
    path: virtualPath,
    gitHubRepositoryID: null,
    missing: false,
    alias: null,
    groupName: null,
    defaultBranch: 'main',
    gitDir: '/tmp/fake-ssh-main/.git',
    lastStashCheckDate: null,
  })
  return new Repository(
    virtualPath,
    id,
    null,
    false,
    null,
    null,
    'main',
    {},
    null,
    false,
    '/tmp/fake-ssh-main/.git'
  )
}

describe('SSH worktree/branch regression', { concurrency: 1 }, () => {
  it('keeps SSH identities out of local realpath and cwd ancestry', async () => {
    assert.equal(await canonicalMutationPath(mainVirtual), mainVirtual)
    assert.equal(repositoryPathsOverlap(process.cwd(), mainVirtual), false)
    assert.equal(
      repositoryPathsOverlap(mainVirtual, resolve(mainVirtual)),
      false
    )

    const protection = protectAssistedCommitResources(process.cwd())
    try {
      assert.equal(isRepositoryAffectedByAssistedCommit(mainVirtual), false)
      await withRepositoryGitOperation(mainVirtual, 'mutation', async () => {})
    } finally {
      protection.release()
    }
  })

  it('namespaces remote POSIX metadata and still overlaps the same SSH host', async () => {
    const paths = await getAssistedCommitProtectedPaths(mainVirtual)
    assert.ok(paths.includes(mainVirtual))
    assert.ok(
      paths.every(
        path => path === mainVirtual || path.startsWith('desktop-ssh-resource:')
      )
    )
    assert.equal(
      paths.some(path => path.startsWith('/tmp/fake-ssh')),
      false
    )

    const common = formatSshResourcePath(location, '/tmp/fake-ssh-main/.git')
    assert.equal(repositoryPathsOverlap(mainVirtual, common), true)
    assert.equal(repositoryPathsOverlap(mainVirtual, process.cwd()), false)

    const linkedPaths = await getAssistedCommitProtectedPaths(linkedVirtual)
    assert.ok(linkedPaths.includes(common))

    const protection = protectAssistedCommitResources(mainVirtual, paths)
    try {
      assert.equal(isRepositoryAffectedByAssistedCommit(linkedVirtual), true)
      await assert.rejects(
        () =>
          withRepositoryGitOperation(linkedVirtual, 'mutation', async () => {
            throw new Error('must not run')
          }),
        (error: unknown) => error instanceof AssistedCommitError
      )
    } finally {
      protection.release()
    }
  })

  it('select loads full branches and worktrees, switch keeps identity, branches remain', async t => {
    await isolateGitConfig(t)
    ensureIpcSend()
    forEachRefBehavior = 'ok'
    gitCalls.length = 0

    const h = await createAssistedCommitRunHarness(t)
    const intervals = trackPruneIntervals(t, h.appStore)

    const cwdProtection = protectAssistedCommitResources(process.cwd())
    t.after(() => cwdProtection.release())

    const repository = await registerSshRepository(h, mainVirtual)
    h.appStore['repositories'] = [repository]

    const selected = await h.dispatcher.selectRepository(repository)
    assert.ok(selected instanceof Repository)
    assert.equal(selected.path, mainVirtual)

    await waitFor(
      () => h.state(repository).worktrees.length >= 2,
      'SSH worktrees after select'
    )
    await waitFor(
      () => h.state(repository).branchesState.allBranches.length >= 3,
      'SSH branches after select'
    )

    assert.equal(isRepositoryAffectedByAssistedCommit(mainVirtual), false)
    assert.equal(isSshRemotePath(mainVirtual), true)

    const beforeSwitchBranches = h
      .state(repository)
      .branchesState.allBranches.map(branch => branch.name)
      .sort()
    assert.deepStrictEqual(beforeSwitchBranches, ['feature', 'hotfix', 'main'])

    const linked = h
      .state(repository)
      .worktrees.find(worktree => worktree.path === linkedVirtual)
    assert.ok(linked)

    await h.dispatcher.switchWorktree(repository, linked)

    const after = h.appStore['selectedRepository']
    assert.ok(after instanceof Repository)
    assert.equal(after.path, linkedVirtual)
    assert.ok(after.sshRemote)
    assert.equal(after.sshRemote.user, location.user)
    assert.equal(after.sshRemote.hostname, location.hostname)
    assert.equal(after.sshRemote.port, location.port)
    assert.equal(after.sshRemote.remotePath, '/tmp/fake-ssh-linked')
    assert.ok(h.state(after).branchesState.allBranches.length >= 3)
    const tip = h.state(after).branchesState.tip
    assert.ok(
      tip.kind === TipState.Valid ||
        tip.kind === TipState.Unknown ||
        tip.kind === TipState.Detached
    )
    await settleSelection(intervals.release)
  })

  it('keeps previous branches and reports when for-each-ref fails', async t => {
    await isolateGitConfig(t)
    ensureIpcSend()
    forEachRefBehavior = 'ok'
    const h = await createAssistedCommitRunHarness(t)
    const intervals = trackPruneIntervals(t, h.appStore)
    const repository = await registerSshRepository(h, mainVirtual)
    h.appStore['repositories'] = [repository]
    await h.dispatcher.selectRepository(repository)
    await waitFor(
      () => h.state(repository).branchesState.allBranches.length >= 3,
      'initial branches'
    )

    const gitStore = h.appStore['gitStoreCache'].get(repository)
    let errors = 0
    const sub = gitStore.onDidError(() => {
      errors++
    })
    t.after(() => sub.dispose())

    forEachRefBehavior = 'throw'
    await gitStore.loadBranches()
    assert.equal(gitStore.allBranches.length, 3)
    assert.ok(errors >= 1)
    await settleSelection(intervals.release)
  })

  it('local repository still lists branches and worktrees under assisted-commit wrap', async t => {
    await isolateGitConfig(t)
    ensureIpcSend()
    const h = await createAssistedCommitRunHarness(t)
    const intervals = trackPruneIntervals(t, h.appStore)
    const source = await seed(t, { file: 'local\n' })
    await exec(['branch', 'feature-a'], source.path)
    await exec(['branch', 'feature-b'], source.path)

    const linkedPath = await createTempDirectory(t)
    await exec(
      ['worktree', 'add', '-b', 'linked-branch', linkedPath],
      source.path
    )
    t.after(async () => {
      await exec(
        ['worktree', 'remove', '--force', linkedPath],
        source.path
      ).catch(() => undefined)
    })

    const repository = await h.register(source)
    h.appStore['repositories'] = [repository]
    await h.dispatcher.selectRepository(repository)

    await waitFor(
      () => h.state(repository).branchesState.allBranches.length >= 3,
      'local branches'
    )
    await waitFor(
      () => h.state(repository).worktrees.length >= 2,
      'local worktrees'
    )

    assert.ok(h.appStore['selectedRepository'] instanceof Repository)
    assert.equal(
      (h.appStore['selectedRepository'] as InstanceType<typeof Repository>).id,
      repository.id
    )
    assert.equal(BackgroundPruneMinimumInterval, 1000 * 60 * 60 * 4)
    await settleSelection(intervals.release)
  })
})
