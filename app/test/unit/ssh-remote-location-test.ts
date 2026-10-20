import { describe, it } from 'node:test'
import assert from 'node:assert'
import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildInteractiveSshArgs,
  buildRemoteFileBundleCommand,
  buildRemoteGitCommand,
  buildRemoteNoFollowDeleteCommand,
  buildRemoteNoFollowReadCommand,
  buildRemoteNoFollowWriteCommand,
  buildRemotePrefixReadCommand,
  buildRemoteRemoveFileCommand,
  buildRemoteStatCommand,
  buildSshArgs,
  quotePosixCommand,
  RemoteFileSymlinkExit,
  formatSshRemoteLabel,
  formatSshRemoteLocation,
  parseRemoteFileBundle,
  parseRemoteStat,
  parseSshConnectionInput,
  parseSshRemoteLocation,
  resolveRemoteGitDir,
  resolveRemotePath,
  resolveRemoteWorkingTreeFile,
  shellQuote,
} from '../../src/lib/ssh/ssh-remote-location'
import { rebaseInternalStateFromFiles } from '../../src/lib/git/rebase-progress'
import { planSshTerminalLaunch } from '../../src/lib/ssh/ssh-terminal-launch'
import { ShellError } from '../../src/lib/shells/error'

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

  it('keeps working-tree reads inside the remote repository', () => {
    assert.equal(
      resolveRemoteWorkingTreeFile('/home/ada/src/repo', 'src/app.ts'),
      '/home/ada/src/repo/src/app.ts'
    )
    assert.equal(
      resolveRemoteWorkingTreeFile('/home/ada/src/repo', '../etc/passwd'),
      null
    )
    assert.equal(
      resolveRemoteWorkingTreeFile('/home/ada/src/repo', '/etc/passwd'),
      null
    )
    assert.equal(
      resolveRemoteWorkingTreeFile('/home/ada/src/repo', "src/ada's file"),
      "/home/ada/src/repo/src/ada's file"
    )
  })

  it('parses GNU and BSD stat output', () => {
    assert.deepEqual(parseRemoteStat('42 1700000000\n'), {
      size: 42,
      mtimeSeconds: 1700000000,
    })
    assert.equal(parseRemoteStat(''), null)
    assert.equal(parseRemoteStat('not a stat'), null)
  })

  it('reads git metadata through a POSIX shell without confusing file contents for headers', () => {
    const root = mkdtempSync(join(tmpdir(), 'dplus-ssh-meta-'))
    const directory = join(root, 'My Repo.git')
    try {
      mkdirSync(join(directory, 'rebase-merge'), { recursive: true })
      const squashBody = 'MERGE_HEAD -\nnot a header\n'
      writeFileSync(join(directory, 'MERGE_HEAD'), 'abc123\n')
      writeFileSync(join(directory, 'SQUASH_MSG'), squashBody)
      writeFileSync(
        join(directory, 'rebase-merge', 'head-name'),
        'refs/heads/topic\n'
      )

      const files = [
        'MERGE_HEAD',
        'SQUASH_MSG',
        'REBASE_HEAD',
        'rebase-merge/head-name',
        'rebase-merge/orig-head',
      ]
      const command = buildRemoteFileBundleCommand(directory, files)
      assert.equal(command.includes(directory), true)
      assert.equal(command.includes(`'${directory}`), true)

      const result = spawnSync('sh', ['-c', command], { encoding: 'buffer' })
      assert.equal(result.status, 0, result.stderr.toString('utf8'))
      const parsed = parseRemoteFileBundle(result.stdout, files)
      assert.equal(parsed.get('MERGE_HEAD')?.toString('utf8'), 'abc123\n')
      assert.equal(parsed.get('SQUASH_MSG')?.toString('utf8'), squashBody)
      assert.equal(parsed.get('REBASE_HEAD'), null)
      assert.equal(
        parsed.get('rebase-merge/head-name')?.toString('utf8'),
        'refs/heads/topic\n'
      )
      assert.equal(parsed.get('rebase-merge/orig-head'), null)

      assert.deepEqual(
        rebaseInternalStateFromFiles(
          parsed.get('REBASE_HEAD') === null ? null : 'set',
          'aaa\n',
          parsed.get('rebase-merge/head-name')?.toString('utf8') ?? null,
          'bbb\n'
        ),
        null
      )
      assert.deepEqual(
        rebaseInternalStateFromFiles(
          'set',
          'aaa\n',
          'refs/heads/topic\n',
          'bbb\n'
        ),
        {
          originalBranchTip: 'aaa',
          targetBranch: 'topic',
          baseBranchTip: 'bbb',
        }
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reads a file prefix and file size with portable remote commands', () => {
    const root = mkdtempSync(join(tmpdir(), 'dplus-ssh-file-'))
    const file = join(root, "ada's file")
    try {
      writeFileSync(file, 'hello world')
      const read = spawnSync(
        'sh',
        ['-c', buildRemotePrefixReadCommand(file, 5)],
        { encoding: 'buffer' }
      )
      assert.equal(read.status, 0, read.stderr.toString('utf8'))
      assert.equal(read.stdout.toString('utf8'), 'hello')

      const statResult = spawnSync('sh', ['-c', buildRemoteStatCommand(file)], {
        encoding: 'utf8',
      })
      assert.equal(statResult.status, 0, statResult.stderr)
      assert.equal(parseRemoteStat(statResult.stdout)?.size, 11)

      const removed = spawnSync(
        'sh',
        ['-c', buildRemoteRemoveFileCommand(file)],
        { encoding: 'utf8' }
      )
      assert.equal(removed.status, 0, removed.stderr)
      const afterRemove = spawnSync(
        'sh',
        ['-c', buildRemoteStatCommand(file)],
        { encoding: 'utf8' }
      )
      assert.notEqual(afterRemove.status, 0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reads and writes a file without following a symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'dplus-ssh-ignore-'))
    const directory = join(root, "ada's repo")
    const target = join(directory, 'secret')
    const ignore = join(directory, '.gitignore')
    try {
      mkdirSync(directory)
      writeFileSync(target, 'secret contents')
      symlinkSync(target, ignore)

      const readLink = spawnSync(
        'sh',
        ['-c', buildRemoteNoFollowReadCommand(ignore)],
        { encoding: 'utf8' }
      )
      assert.equal(readLink.status, RemoteFileSymlinkExit)
      assert.equal(readLink.stdout.includes('secret contents'), false)

      const writeLink = spawnSync(
        'sh',
        ['-c', buildRemoteNoFollowWriteCommand(ignore)],
        { input: 'node_modules\n', encoding: 'utf8' }
      )
      assert.equal(writeLink.status, RemoteFileSymlinkExit)
      assert.equal(
        spawnSync('sh', ['-c', `cat ${quotePosixCommand([target])}`], {
          encoding: 'utf8',
        }).stdout,
        'secret contents'
      )

      const deleted = spawnSync(
        'sh',
        ['-c', buildRemoteNoFollowDeleteCommand(ignore)],
        { encoding: 'utf8' }
      )
      assert.equal(deleted.status, RemoteFileSymlinkExit)

      rmSync(ignore)
      const body = 'node_modules\n# note\n'
      const command = buildRemoteNoFollowWriteCommand(ignore)
      assert.equal(command.includes(body), false)
      const written = spawnSync('sh', ['-c', command], {
        input: body,
        encoding: 'utf8',
      })
      assert.equal(written.status, 0, written.stderr)
      const read = spawnSync(
        'sh',
        ['-c', buildRemoteNoFollowReadCommand(ignore)],
        { encoding: 'utf8' }
      )
      assert.equal(read.status, 0, read.stderr)
      assert.equal(read.stdout, body)

      const removed = spawnSync(
        'sh',
        ['-c', buildRemoteNoFollowDeleteCommand(ignore)],
        { encoding: 'utf8' }
      )
      assert.equal(removed.status, 0, removed.stderr)
      const missing = spawnSync(
        'sh',
        ['-c', buildRemoteNoFollowReadCommand(ignore)],
        { encoding: 'utf8' }
      )
      assert.equal(missing.status, 2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('builds an interactive ssh command without disabling host checking', () => {
    const args = buildInteractiveSshArgs({
      ...location,
      remotePath: "/home/ada/ada's repo",
    })
    assert.equal(args.includes('-t'), true)
    assert.equal(args.includes('-F'), false)
    assert.equal(args.includes('StrictHostKeyChecking=no'), false)
    assert.equal(args.includes('UserKnownHostsFile=/dev/null'), false)
    assert.equal(args.includes('ada@dev.example.com'), true)
    const remoteCommand = args[args.length - 1]
    assert.equal(
      remoteCommand,
      `cd -- '/home/ada/ada'\\''s repo' && exec "\${SHELL:-/bin/sh}" -i`
    )
    assert.equal(args.join(' ').includes('ssh_config'), false)
  })

  it('asks a terminal to run ssh in the remote repository', () => {
    const plan = planSshTerminalLaunch({
      platform: 'linux',
      shell: 'GNOME Terminal',
      terminalPath: '/usr/bin/gnome-terminal',
      sshPath: 'ssh',
      location,
    })
    assert.equal(plan.file, '/usr/bin/gnome-terminal')
    assert.equal(plan.args[0], '--')
    assert.equal(plan.args[1], 'ssh')
    assert.equal(plan.args.includes('-t'), true)
    assert.equal(plan.args.at(-2), 'ada@dev.example.com')

    const terminal = planSshTerminalLaunch({
      platform: 'darwin',
      shell: 'Terminal',
      terminalPath: '/System/Applications/Utilities/Terminal.app',
      sshPath: 'ssh',
      location: { ...location, remotePath: '/home/ada/say "hi"' },
    })
    assert.equal(terminal.file, 'osascript')
    const source = terminal.args[1]
    assert.equal(source.includes('tell application "Terminal"'), true)
    assert.equal(source.includes('say \\"hi\\"'), true)
    assert.equal(source.includes('StrictHostKeyChecking=no'), false)

    const windows = planSshTerminalLaunch({
      platform: 'win32',
      shell: 'Windows Terminal',
      terminalPath: 'wt.exe',
      sshPath: 'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
      location,
    })
    assert.deepEqual(windows.args.slice(0, 4), ['-w', '0', 'new-tab', '--'])
    assert.equal(windows.args[4], 'C:\\Windows\\System32\\OpenSSH\\ssh.exe')

    const prompt = planSshTerminalLaunch({
      platform: 'win32',
      shell: 'Command Prompt',
      terminalPath: 'cmd.exe',
      sshPath: 'ssh.exe',
      location,
    })
    assert.equal(prompt.file, 'ssh.exe')
    assert.equal(prompt.windowsHide, false)

    assert.throws(
      () =>
        planSshTerminalLaunch({
          platform: 'linux',
          shell: 'Warp',
          terminalPath: '/usr/bin/warp-terminal',
          sshPath: 'ssh',
          location,
        }),
      ShellError
    )
  })
})
