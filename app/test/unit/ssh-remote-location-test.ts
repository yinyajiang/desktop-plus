import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  buildRemoteGitCommand,
  buildSshArgs,
  formatSshRemoteLabel,
  formatSshRemoteLocation,
  parseSshConnectionInput,
  parseSshRemoteLocation,
  resolveRemoteGitDir,
  resolveRemotePath,
  shellQuote,
} from '../../src/lib/ssh/ssh-remote-location'

const location = {
  user: 'ada',
  hostname: 'dev.example.com',
  port: 2222,
  identityFile: '/keys/id_ed25519',
  remotePath: '/home/ada/src/repo',
}

describe('SSH remote locations', () => {
  it('round-trips a connection and remote path', () => {
    const path = formatSshRemoteLocation(location)
    assert.equal(path.startsWith('desktop-ssh:'), true)
    assert.deepEqual(parseSshRemoteLocation(path), location)
  })

  it('omits the default port and identity file when they are unset', () => {
    const path = formatSshRemoteLocation({
      ...location,
      port: null,
      identityFile: null,
    })
    assert.deepEqual(parseSshRemoteLocation(path), {
      ...location,
      port: null,
      identityFile: null,
    })
  })

  it('rejects a local filesystem path', () => {
    assert.equal(parseSshRemoteLocation('/home/ada/src/repo'), null)
    assert.equal(parseSshRemoteLocation('desktop-ssh:not-base64'), null)
  })

  it('parses a typed connection without reading SSH config', () => {
    assert.deepEqual(parseSshConnectionInput('ada@dev.example.com'), {
      user: 'ada',
      hostname: 'dev.example.com',
      port: null,
    })
    assert.deepEqual(parseSshConnectionInput('ada@dev.example.com:2222'), {
      user: 'ada',
      hostname: 'dev.example.com',
      port: 2222,
    })
    assert.deepEqual(parseSshConnectionInput('ada@[::1]:22'), {
      user: 'ada',
      hostname: '[::1]',
      port: 22,
    })
    assert.equal(parseSshConnectionInput('dev.example.com'), null)
    assert.equal(parseSshConnectionInput('ada@dev.example.com:0'), null)
  })

  it('formats a label people can read', () => {
    assert.equal(
      formatSshRemoteLabel(location),
      'ada@dev.example.com:2222:/home/ada/src/repo'
    )
  })

  it('resolves rev-parse cdup and git dir on the remote', () => {
    assert.equal(
      resolveRemotePath('/home/ada/src/repo/pkg', '../'),
      '/home/ada/src/repo'
    )
    assert.equal(
      resolveRemotePath('/home/ada/src/repo', ''),
      '/home/ada/src/repo'
    )
    assert.equal(
      resolveRemoteGitDir('/home/ada/src/repo', '.git'),
      '/home/ada/src/repo/.git'
    )
    assert.equal(
      resolveRemoteGitDir('/home/ada/src/repo', '/home/ada/src/repo/.git'),
      '/home/ada/src/repo/.git'
    )
  })

  it('quotes remote shell metacharacters', () => {
    assert.equal(shellQuote(`/home/ada/My Repo`), `'/home/ada/My Repo'`)
    assert.equal(shellQuote(`ada's repo`), `'ada'\\''s repo'`)
  })

  it('builds a remote git command without Desktop credential helper config', () => {
    const command = buildRemoteGitCommand(
      `/home/ada/My Repo`,
      ['status', '--porcelain=2', '-z'],
      {
        GIT_AUTHOR_NAME: `Ada Lovelace`,
        GIT_CONFIG_PARAMETERS: `'credential.helper=desktop'`,
        GIT_LFS_PROGRESS: '/tmp/local-lfs-progress',
      }
    )

    assert.match(command, /git -C '\/home\/ada\/My Repo' 'status'/)
    assert.match(command, /GIT_TERMINAL_PROMPT='0'/)
    assert.match(command, /GIT_AUTHOR_NAME='Ada Lovelace'/)
    assert.equal(command.includes('credential.helper'), false)
    assert.equal(command.includes('GIT_LFS_PROGRESS'), false)
    assert.equal(command.includes('/tmp/local-lfs-progress'), false)
  })

  it('passes the typed host to ssh and does not disable host checking or point at a config file', () => {
    const args = buildSshArgs(location, null)
    assert.equal(args.at(-1), 'ada@dev.example.com')
    assert.equal(args.includes('-p'), true)
    assert.equal(args[args.indexOf('-p') + 1], '2222')
    assert.equal(args.includes('-i'), true)
    assert.equal(args[args.indexOf('-i') + 1], '/keys/id_ed25519')
    assert.equal(args.includes('-F'), false)
    assert.equal(args.includes('StrictHostKeyChecking=no'), false)
    assert.equal(args.includes('UserKnownHostsFile=/dev/null'), false)
    assert.equal(args.join(' ').includes('ssh_config'), false)
  })

  it('leaves identity selection to ssh when the user did not type a key path', () => {
    const args = buildSshArgs(
      { ...location, identityFile: null, port: null },
      null
    )
    assert.equal(args.includes('-i'), false)
    assert.equal(args.includes('-p'), false)
    assert.equal(args.includes('IdentitiesOnly=yes'), false)
  })
})
