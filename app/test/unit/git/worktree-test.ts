import assert from 'node:assert'
import * as Path from 'path'
import { realpath, rm } from 'fs/promises'
import { describe, it, type TestContext } from 'node:test'
import { exec } from 'dugite'
import { setupEmptyRepository } from '../../helpers/repositories'
import { makeCommit } from '../../helpers/repository-scaffolding'
import { createTempDirectory } from '../../helpers/temp'
import { win32 } from 'path'
import {
  parseWorktreePorcelainOutput,
  listWorktrees,
  listWorktreesFromGitDir,
  resolveMainWorktreePath,
  applyDiscoveredWorktrees,
  mapSshWorktreePath,
  addWorktree,
  removeWorktree,
  moveWorktree,
  getWorktreeRemoveTarget,
} from '../../../src/lib/git'
import { Repository } from '../../../src/models/repository'
import { getWorktreeDisplayName } from '../../../src/models/worktree'
import {
  formatSshRemoteLocation,
  parseSshRemoteLocation,
  ISshRemoteLocation,
} from '../../../src/lib/ssh/ssh-remote-location'

describe('git/worktree', () => {
  describe('parseWorktreePorcelainOutput', () => {
    it('returns empty array for empty output', () => {
      assert.deepStrictEqual(parseWorktreePorcelainOutput(''), [])
      assert.deepStrictEqual(parseWorktreePorcelainOutput('  \n  '), [])
    })

    it('parses a single main worktree', () => {
      const output =
        [
          'worktree /path/to/repo',
          'HEAD abc1234abc1234abc1234abc1234abc1234abc123',
          'branch refs/heads/main',
        ].join('\0') + '\0'

      const entries = parseWorktreePorcelainOutput(output)
      assert.strictEqual(entries.length, 1)
      assert.deepStrictEqual(entries[0], {
        path: Path.normalize('/path/to/repo'),
        head: 'abc1234abc1234abc1234abc1234abc1234abc123',
        branch: 'refs/heads/main',
        isDetached: false,
        type: 'main',
        isLocked: false,
        isPrunable: false,
      })
    })

    it('parses multiple worktrees', () => {
      const output =
        [
          [
            'worktree /path/to/repo',
            'HEAD abc1234abc1234abc1234abc1234abc1234abc123',
            'branch refs/heads/main',
          ].join('\0'),
          [
            'worktree /path/to/linked',
            'HEAD def5678def5678def5678def5678def5678def567',
            'branch refs/heads/feature',
          ].join('\0'),
        ].join('\0\0') + '\0'

      const entries = parseWorktreePorcelainOutput(output)
      assert.strictEqual(entries.length, 2)

      assert.strictEqual(entries[0].type, 'main')
      assert.strictEqual(entries[0].path, Path.normalize('/path/to/repo'))

      assert.strictEqual(entries[1].type, 'linked')
      assert.strictEqual(entries[1].path, Path.normalize('/path/to/linked'))
      assert.strictEqual(entries[1].branch, 'refs/heads/feature')
    })

    it('parses detached HEAD worktree', () => {
      const output =
        [
          [
            'worktree /path/to/repo',
            'HEAD abc1234abc1234abc1234abc1234abc1234abc123',
            'branch refs/heads/main',
          ].join('\0'),
          [
            'worktree /path/to/detached',
            'HEAD def5678def5678def5678def5678def5678def567',
            'detached',
          ].join('\0'),
        ].join('\0\0') + '\0'

      const entries = parseWorktreePorcelainOutput(output)
      assert.strictEqual(entries.length, 2)

      assert.strictEqual(entries[1].isDetached, true)
      assert.strictEqual(entries[1].branch, null)
    })

    it('parses locked worktree', () => {
      const output =
        [
          [
            'worktree /path/to/repo',
            'HEAD abc1234abc1234abc1234abc1234abc1234abc123',
            'branch refs/heads/main',
          ].join('\0'),
          [
            'worktree /path/to/locked-wt',
            'HEAD def5678def5678def5678def5678def5678def567',
            'branch refs/heads/locked-branch',
            'locked',
          ].join('\0'),
        ].join('\0\0') + '\0'

      const entries = parseWorktreePorcelainOutput(output)
      assert.strictEqual(entries[1].isLocked, true)
    })

    it('parses locked worktree with reason', () => {
      const output =
        [
          [
            'worktree /path/to/repo',
            'HEAD abc1234abc1234abc1234abc1234abc1234abc123',
            'branch refs/heads/main',
          ].join('\0'),
          [
            'worktree /path/to/locked-wt',
            'HEAD def5678def5678def5678def5678def5678def567',
            'branch refs/heads/locked-branch',
            'locked reason why it is locked',
          ].join('\0'),
        ].join('\0\0') + '\0'

      const entries = parseWorktreePorcelainOutput(output)
      assert.strictEqual(entries[1].isLocked, true)
    })

    it('parses prunable worktree', () => {
      const output =
        [
          [
            'worktree /path/to/repo',
            'HEAD abc1234abc1234abc1234abc1234abc1234abc123',
            'branch refs/heads/main',
          ].join('\0'),
          [
            'worktree /path/to/prunable-wt',
            'HEAD def5678def5678def5678def5678def5678def567',
            'branch refs/heads/stale',
            'prunable gitdir file points to non-existent location',
          ].join('\0'),
        ].join('\0\0') + '\0'

      const entries = parseWorktreePorcelainOutput(output)
      assert.strictEqual(entries[1].isPrunable, true)
    })

    it('parses paths with spaces', () => {
      const output =
        [
          [
            'worktree /path/to/my repo',
            'HEAD abc1234abc1234abc1234abc1234abc1234abc123',
            'branch refs/heads/main',
          ].join('\0'),
          [
            'worktree /path/to/my other worktree',
            'HEAD def5678def5678def5678def5678def5678def567',
            'branch refs/heads/feature',
          ].join('\0'),
        ].join('\0\0') + '\0'

      const entries = parseWorktreePorcelainOutput(output)
      assert.strictEqual(entries[0].path, Path.normalize('/path/to/my repo'))
      assert.strictEqual(
        entries[1].path,
        Path.normalize('/path/to/my other worktree')
      )
    })

    it('parses worktree with locked and prunable flags combined', () => {
      const output =
        [
          [
            'worktree /path/to/repo',
            'HEAD abc1234abc1234abc1234abc1234abc1234abc123',
            'branch refs/heads/main',
          ].join('\0'),
          [
            'worktree /path/to/bad-wt',
            'HEAD def5678def5678def5678def5678def5678def567',
            'detached',
            'locked',
            'prunable',
          ].join('\0'),
        ].join('\0\0') + '\0'

      const entries = parseWorktreePorcelainOutput(output)
      assert.strictEqual(entries[1].isDetached, true)
      assert.strictEqual(entries[1].isLocked, true)
      assert.strictEqual(entries[1].isPrunable, true)
      assert.strictEqual(entries[1].branch, null)
    })

    it('parses paths with newlines', () => {
      const output =
        [
          [
            'worktree /path/to/my\nrepo',
            'HEAD abc1234abc1234abc1234abc1234abc1234abc123',
            'branch refs/heads/main',
          ].join('\0'),
          [
            'worktree /path/to/my\nother\nworktree',
            'HEAD def5678def5678def5678def5678def5678def567',
            'branch refs/heads/feature',
          ].join('\0'),
        ].join('\0\0') + '\0'

      const entries = parseWorktreePorcelainOutput(output)
      assert.strictEqual(entries[0].path, Path.normalize('/path/to/my\nrepo'))
      assert.strictEqual(
        entries[1].path,
        Path.normalize('/path/to/my\nother\nworktree')
      )
    })
  })

  describe('listWorktrees', () => {
    /** Helper to extract checked-out branch refs from worktree entries */
    function checkedOutBranches(
      worktrees: ReadonlyArray<{ readonly branch: string | null }>
    ): ReadonlySet<string> {
      return new Set(worktrees.map(wt => wt.branch).filter(b => b !== null))
    }

    it('returns only main worktree branch when there are no linked worktrees', async t => {
      const repo = await setupEmptyRepository(t, 'main')
      await makeCommit(repo, {
        entries: [{ path: 'README', contents: 'hello' }],
      })

      const branches = checkedOutBranches(await listWorktrees(repo))
      assert.strictEqual(branches.size, 1)
      assert(branches.has('refs/heads/main'))
    })

    it('returns branches checked out in linked worktrees', async t => {
      const repo = await setupEmptyRepository(t, 'main')
      await makeCommit(repo, {
        entries: [{ path: 'README', contents: 'hello' }],
      })
      await exec(['branch', 'feature-a'], repo.path)
      await exec(
        ['worktree', 'add', repo.path + '-wt-a', 'feature-a'],
        repo.path
      )

      const branches = checkedOutBranches(await listWorktrees(repo))
      assert(branches.has('refs/heads/feature-a'))
      assert(branches.has('refs/heads/main'))
      assert.strictEqual(branches.size, 2)
    })

    it('handles multiple linked worktrees', async t => {
      const repo = await setupEmptyRepository(t, 'main')
      await makeCommit(repo, {
        entries: [{ path: 'README', contents: 'hello' }],
      })
      await exec(['branch', 'feature-a'], repo.path)
      await exec(['branch', 'feature-b'], repo.path)
      await exec(
        ['worktree', 'add', repo.path + '-wt-a', 'feature-a'],
        repo.path
      )
      await exec(
        ['worktree', 'add', repo.path + '-wt-b', 'feature-b'],
        repo.path
      )

      const branches = checkedOutBranches(await listWorktrees(repo))
      assert(branches.has('refs/heads/feature-a'))
      assert(branches.has('refs/heads/feature-b'))
      assert(branches.has('refs/heads/main'))
      assert.strictEqual(branches.size, 3)
    })

    it('handles detached HEAD worktrees', async t => {
      const repo = await setupEmptyRepository(t, 'main')
      await makeCommit(repo, {
        entries: [{ path: 'README', contents: 'hello' }],
      })

      const { stdout } = await exec(['rev-parse', 'HEAD'], repo.path)
      const sha = stdout.trim()
      await exec(
        ['worktree', 'add', '--detach', repo.path + '-wt-detached', sha],
        repo.path
      )

      const branches = checkedOutBranches(await listWorktrees(repo))
      assert.strictEqual(branches.size, 1)
      assert(branches.has('refs/heads/main'))
    })

    it('lists worktrees from a git dir after a linked worktree directory is removed', async t => {
      const repo = await setupEmptyRepository(t, 'main')
      await makeCommit(repo, {
        entries: [{ path: 'README', contents: 'hello' }],
      })
      await exec(['branch', 'feature-a'], repo.path)

      const worktreePath = repo.path + '-wt-a'
      await exec(['worktree', 'add', worktreePath, 'feature-a'], repo.path)

      const { stdout } = await exec(['rev-parse', '--git-dir'], worktreePath)
      const gitDir = Path.resolve(worktreePath, stdout.trim())

      await rm(worktreePath, { recursive: true, force: true })

      const worktrees = await listWorktreesFromGitDir(gitDir)
      const mainWorktree = worktrees.find(wt => wt.type === 'main')
      const repoPath = await realpath(repo.path)
      const resolvedWorktreePath = repoPath + '-wt-a'

      assert.strictEqual(mainWorktree?.path, repoPath)
      assert(
        worktrees.some(wt => wt.path === resolvedWorktreePath && wt.isPrunable)
      )
    })
  })

  describe('resolveMainWorktreePath', () => {
    /**
     * Sets up a repository with a single linked worktree and returns the
     * realpath'd main worktree path, the linked worktree path and the linked
     * worktree's admin git dir.
     */
    async function setupWorktree(t: TestContext) {
      const repo = await setupEmptyRepository(t, 'main')
      await makeCommit(repo, {
        entries: [{ path: 'README', contents: 'hello' }],
      })
      await exec(['branch', 'feature-a'], repo.path)

      const worktreePath = repo.path + '-wt-a'
      await exec(['worktree', 'add', worktreePath, 'feature-a'], repo.path)

      const { stdout } = await exec(['rev-parse', '--git-dir'], worktreePath)

      return {
        repo,
        mainPath: await realpath(repo.path),
        worktreePath,
        gitDir: Path.resolve(worktreePath, stdout.trim()),
      }
    }

    it('resolves from the persisted path once the worktree metadata is gone', async t => {
      const { repo, mainPath, worktreePath, gitDir } = await setupWorktree(t)

      // Desktop switched onto the worktree, recording the main worktree it
      // came from.
      const selected = new Repository(
        worktreePath,
        1,
        null,
        false,
        null,
        null,
        null,
        {},
        null,
        false,
        gitDir,
        mainPath
      )

      // `git worktree remove` deletes the working directory *and* the admin
      // metadata under <main>/.git/worktrees/<name>.
      await exec(['worktree', 'remove', '--force', worktreePath], repo.path)

      assert.strictEqual(await resolveMainWorktreePath(selected), mainPath)
    })

    it('falls back to the git dir when no path was persisted', async t => {
      const { mainPath, worktreePath, gitDir } = await setupWorktree(t)

      // A repository record written before the main worktree path was
      // persisted has a git dir but no main worktree path.
      const selected = new Repository(
        worktreePath,
        1,
        null,
        false,
        null,
        null,
        null,
        {},
        null,
        false,
        gitDir
      )

      // A plain delete leaves the admin metadata intact, so the worktree set
      // is still discoverable through it.
      await rm(worktreePath, { recursive: true, force: true })

      assert.strictEqual(await resolveMainWorktreePath(selected), mainPath)
    })

    it('returns null when the repository is already the main worktree', async t => {
      const { repo, mainPath } = await setupWorktree(t)

      const selected = new Repository(
        mainPath,
        1,
        null,
        false,
        null,
        null,
        null,
        {},
        null,
        false,
        Path.join(repo.path, '.git'),
        mainPath
      )

      assert.strictEqual(await resolveMainWorktreePath(selected), null)
    })

    it('falls back to the git dir when the persisted path is stale', async t => {
      const { mainPath, worktreePath, gitDir } = await setupWorktree(t)

      // A persisted path can outlive the location it names — a repository moved
      // outside Desktop, say. It shouldn't stop us resolving the main worktree
      // by the means that still work.
      const selected = new Repository(
        worktreePath,
        1,
        null,
        false,
        null,
        null,
        null,
        {},
        null,
        false,
        gitDir,
        Path.join(mainPath, 'no', 'longer', 'here')
      )

      assert.strictEqual(await resolveMainWorktreePath(selected), mainPath)
    })

    it('returns null when neither a persisted path nor a git dir is available', async t => {
      const { worktreePath } = await setupWorktree(t)

      const selected = new Repository(worktreePath, 1, null, false)

      assert.strictEqual(await resolveMainWorktreePath(selected), null)
    })
  })

  describe('external worktree add and remove', () => {
    it('sees a worktree added and removed from the main root and listed from the linked root', async t => {
      const repo = await setupEmptyRepository(t, 'main')
      await makeCommit(repo, {
        entries: [{ path: 'README', contents: 'hello' }],
      })
      await exec(['branch', 'feature-a'], repo.path)

      const linkedPath = Path.join(await createTempDirectory(t), 'linked wt')
      await exec(['worktree', 'add', linkedPath, 'feature-a'], repo.path)

      const fromMain = await listWorktrees(repo)
      assert.strictEqual(fromMain.length, 2)
      assert.strictEqual(fromMain[0].type, 'main')
      assert.strictEqual(fromMain[1].type, 'linked')
      assert.strictEqual(fromMain[0].path, await realpath(repo.path))
      assert.strictEqual(fromMain[1].path, await realpath(linkedPath))

      const linked = new Repository(linkedPath, -1, null, false)
      const fromLinked = await listWorktrees(linked)
      assert.strictEqual(fromLinked.length, 2)
      assert.strictEqual(
        fromLinked.find(worktree => worktree.type === 'main')?.path,
        await realpath(repo.path)
      )
      assert.strictEqual(
        fromLinked.find(worktree => worktree.type === 'linked')?.path,
        await realpath(linkedPath)
      )

      await exec(['worktree', 'remove', '--force', linkedPath], repo.path)

      const afterRemove = await listWorktrees(repo)
      assert.strictEqual(afterRemove.length, 1)
      assert.strictEqual(afterRemove[0].type, 'main')
      assert.strictEqual(afterRemove[0].path, await realpath(repo.path))
    })
  })

  describe('SSH worktree paths', () => {
    const location: ISshRemoteLocation = {
      user: 'dev',
      hostname: 'build.example',
      port: 2222,
      identityFile: '/keys/id_ed25519',
      remotePath: '/srv/repos/main',
    }

    const porcelain = (paths: ReadonlyArray<string>) =>
      paths
        .map((gitPath, index) =>
          [
            `worktree ${gitPath}`,
            `HEAD ${index === 0 ? 'a'.repeat(40) : 'b'.repeat(40)}`,
            `branch refs/heads/${index === 0 ? 'main' : 'feature'}`,
          ].join('\0')
        )
        .join('\0\0') + '\0'

    it('maps main and linked remote paths, including spaces, without Windows normalization', () => {
      const linkedGitPath = '/srv/repos/my linked wt'
      const entries = parseWorktreePorcelainOutput(
        porcelain(['/srv/repos/main/', linkedGitPath]),
        { mapPath: gitPath => mapSshWorktreePath(gitPath, location) }
      )

      assert.strictEqual(entries.length, 2)
      assert.strictEqual(entries[0].type, 'main')
      assert.strictEqual(entries[1].type, 'linked')
      assert.strictEqual(
        entries[0].path,
        formatSshRemoteLocation({
          ...location,
          remotePath: '/srv/repos/main',
        })
      )

      const linked = parseSshRemoteLocation(entries[1].path)
      assert.ok(linked)
      assert.strictEqual(linked.remotePath, linkedGitPath)
      assert.strictEqual(linked.user, location.user)
      assert.strictEqual(linked.hostname, location.hostname)
      assert.strictEqual(linked.port, location.port)
      assert.strictEqual(linked.identityFile, location.identityFile)
      assert.strictEqual(entries[1].path.includes('\\'), false)
      assert.notStrictEqual(win32.normalize(linkedGitPath), linkedGitPath)
      assert.strictEqual(getWorktreeDisplayName(entries[0]), 'main')
      assert.strictEqual(getWorktreeDisplayName(entries[1]), 'my linked wt')
    })

    it('keeps the previous list when discovery fails and drops a removed worktree when it succeeds', () => {
      const previous = parseWorktreePorcelainOutput(
        porcelain(['/srv/repos/main', '/srv/repos/my linked wt']),
        { mapPath: gitPath => mapSshWorktreePath(gitPath, location) }
      )
      const mainOnly = previous.slice(0, 1)

      assert.strictEqual(
        applyDiscoveredWorktrees(previous, undefined),
        previous
      )
      assert.deepStrictEqual(
        applyDiscoveredWorktrees(previous, mainOnly),
        mainOnly
      )
      assert.notStrictEqual(applyDiscoveredWorktrees(previous, []), previous)
      assert.strictEqual(applyDiscoveredWorktrees(previous, []).length, 0)
    })

    it('does not create or move an SSH worktree, and rejects force delete', async () => {
      const repository = new Repository(
        formatSshRemoteLocation(location),
        -1,
        null,
        false
      )
      const linked = formatSshRemoteLocation({
        ...location,
        remotePath: '/srv/repos/linked',
      })

      await assert.rejects(
        () => addWorktree(repository, '/srv/repos/new'),
        /Cannot create a worktree on an SSH host/
      )
      await assert.rejects(
        () => removeWorktree(repository.path, linked, true),
        /Cannot force-delete a worktree on an SSH host/
      )
      await assert.rejects(
        () =>
          moveWorktree(repository, '/srv/repos/linked', '/srv/repos/renamed'),
        /Cannot move a worktree on an SSH host/
      )
    })

    it('maps an SSH virtual worktree path to the remote POSIX remove target', () => {
      const linked = formatSshRemoteLocation({
        ...location,
        remotePath: '/srv/repos/my linked wt',
      })
      assert.strictEqual(
        getWorktreeRemoveTarget(linked),
        '/srv/repos/my linked wt'
      )
      assert.strictEqual(
        getWorktreeRemoveTarget('/srv/repos/already-posix'),
        '/srv/repos/already-posix'
      )
    })
  })
})
