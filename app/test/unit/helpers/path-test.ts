import { describe, it } from 'node:test'
import assert from 'node:assert'
import * as Path from 'path'
import { Repository } from '../../../src/models/repository'
import { getRepositoryClipboardPath } from '../../../src/lib/helpers/path'
import { formatSshRemoteLocation } from '../../../src/lib/ssh/ssh-remote-location'

describe('getRepositoryClipboardPath', () => {
  const relative = 'apps/web-base/nuxt.config.ts'

  it('returns an absolute path for a local repository full copy', () => {
    const repository = new Repository('/Users/me/project', -1, null, false)
    assert.strictEqual(
      getRepositoryClipboardPath(repository, relative, 'full'),
      Path.join('/Users/me/project', relative)
    )
  })

  it('returns a normalized relative path for a local relative copy', () => {
    const repository = new Repository('/Users/me/project', -1, null, false)
    assert.strictEqual(
      getRepositoryClipboardPath(repository, relative, 'relative'),
      relative
    )
  })

  it('returns only the repository-relative path for SSH full and relative copies', () => {
    const location = formatSshRemoteLocation({
      hostname: 'example.com',
      user: 'dev',
      port: 22,
      remotePath: '/home/dev/project',
      identityFile: null,
    })
    const repository = new Repository(location, -1, null, false)

    assert.notStrictEqual(repository.sshRemote, null)
    assert.strictEqual(
      getRepositoryClipboardPath(repository, relative, 'full'),
      relative
    )
    assert.strictEqual(
      getRepositoryClipboardPath(repository, relative, 'relative'),
      relative
    )
    assert.doesNotMatch(
      getRepositoryClipboardPath(repository, relative, 'full'),
      /desktop-ssh/
    )
    assert.doesNotMatch(
      getRepositoryClipboardPath(repository, relative, 'full'),
      /\/home\/dev/
    )
  })
})
