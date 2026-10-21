import { describe, it } from 'node:test'
import assert from 'node:assert'
import { existsSync } from 'node:fs'
import { unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { exec } from 'dugite'

import { DiffType, ITextDiff } from '../../../src/models/diff'
import { Repository } from '../../../src/models/repository'
import { getTempFilePath } from '../../../src/lib/file-system'
import { git } from '../../../src/lib/git/core'
import {
  getResolutionDiff,
  getResolutionDiffExecution,
} from '../../../src/lib/git'
import { formatSshRemoteLocation } from '../../../src/lib/ssh/ssh-remote-location'
import { setupEmptyRepository } from '../../helpers/repositories'
import { makeCommit } from '../../helpers/repository-scaffolding'

describe('git/diff/getResolutionDiff', () => {
  it('diffs resolved content against the on-disk file', async t => {
    const repo = await setupEmptyRepository(t)

    await makeCommit(repo, {
      entries: [{ path: 'file.txt', contents: 'original\n' }],
      commitMessage: 'init',
    })

    const resolved = 'modified\n'
    const { diff } = await getResolutionDiff(repo, 'file.txt', {
      content: resolved,
    })

    assert.equal(diff.kind, DiffType.Text)
    const textDiff = diff as ITextDiff
    assert(textDiff.text.includes('-original'))
    assert(textDiff.text.includes('+modified'))
  })

  it('diffs SSH resolution files without inheriting the launch directory', async t => {
    const hostile = await setupEmptyRepository(t)
    await makeCommit(hostile, {
      entries: [{ path: '.gitattributes', contents: '* text=auto\n' }],
      commitMessage: 'attributes',
    })
    await exec(['config', 'core.autocrlf', 'true'], hostile.path)

    const local = getResolutionDiffExecution(hostile)
    assert.deepEqual([...local.prefixArgs], [])
    assert.equal(local.path, hostile.path)

    const sshRepo = new Repository(
      formatSshRemoteLocation({
        user: 'ada',
        hostname: 'dev.example.com',
        port: null,
        identityFile: null,
        remotePath: '/home/ada/repo',
      }),
      2,
      null,
      false
    )
    const execution = getResolutionDiffExecution(sshRepo)
    assert.equal(execution.path, tmpdir())
    assert.equal(execution.prefixArgs[0], '--git-dir')
    assert.equal(existsSync(String(execution.prefixArgs[1])), false)
    assert.equal(execution.prefixArgs.includes('core.autocrlf=false'), true)
    assert.equal(execution.prefixArgs.includes('core.safecrlf=false'), true)

    const crlf = getTempFilePath('resolution-crlf')
    const lf = getTempFilePath('resolution-lf')
    await writeFile(crlf, 'line\r\n')
    await writeFile(lf, 'line\n')
    try {
      const inherited = await git(
        ['diff', '--no-color', '--no-index', '--', crlf, lf],
        hostile.path,
        'resolutionDiffInheritance',
        { successExitCodes: new Set([0, 1]) }
      )
      assert.equal(inherited.stdout.trim(), '')

      const isolated = await git(
        [
          ...execution.prefixArgs,
          'diff',
          '--no-color',
          '--no-index',
          '--',
          crlf,
          lf,
        ],
        hostile.path,
        'resolutionDiffIsolated',
        { successExitCodes: new Set([0, 1]) }
      )
      assert.match(isolated.stdout, /^-line\r$/m)
      assert.match(isolated.stdout, /^\+line$/m)
      assert.equal(existsSync(String(execution.prefixArgs[1])), false)
    } finally {
      await unlink(crlf).catch(() => {})
      await unlink(lf).catch(() => {})
    }
  })
})
