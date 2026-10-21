import { describe, it } from 'node:test'
import assert from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildSshArgs,
  formatSshRemoteLocation,
  parseSshConnectionInput,
  parseSshManualConnectionInput,
  parseSshRemoteLocation,
} from '../../src/lib/ssh/ssh-remote-location'
import {
  configBlockForAlias,
  endpointFromSshG,
  fallbackEndpointFromConfigText,
  listHostAliasesInConfigText,
  loadUserSshConfig,
  parseSshGOutput,
  resetSshConfigHostCacheForTesting,
  resolveManualSshConnection,
  resolveSshConfigHost,
  SshConfigDefaultProbeHost,
  sshConfigListHint,
} from '../../src/lib/ssh/ssh-config-hosts'

const defaultIdentityFiles = [
  '~/.ssh/id_rsa',
  '~/.ssh/id_ecdsa',
  '~/.ssh/id_ecdsa_sk',
  '~/.ssh/id_ed25519',
  '~/.ssh/id_ed25519_sk',
  '~/.ssh/id_xmss',
  '~/.ssh/id_dsa',
]

const defaults = {
  user: 'ubuntu',
  hostname: SshConfigDefaultProbeHost,
  port: 22,
  identityFiles: defaultIdentityFiles,
}

describe('SSH config hosts', () => {
  it('lists concrete Host aliases and skips wildcards', () => {
    const text = [
      '# Host commented-out',
      'Host *',
      'Host dev* *.example.com "foo?"',
      'Host devbox bastion',
      'Host "!skip" real-host',
      'Host "my-host"',
      'HOST upper',
      'Host \\',
      '  continued',
      '  User ada',
    ].join('\n')

    assert.deepEqual(listHostAliasesInConfigText(text), [
      'devbox',
      'bastion',
      'real-host',
      'my-host',
      'upper',
      'continued',
    ])
    assert.equal(configBlockForAlias(text, 'continued')?.user, 'ada')
    assert.deepEqual(
      configBlockForAlias(
        'Host dev\n  IdentityFile "/home/ada/my keys/id"\n',
        'dev'
      )?.identityFiles,
      ['/home/ada/my keys/id']
    )
    assert.equal(configBlockForAlias(text, '*'), null)
    assert.equal(configBlockForAlias(text, 'dev*'), null)
  })

  it('reads Host aliases from Include files under the config home', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dplus-ssh-config-'))
    const sshDir = join(home, '.ssh')
    try {
      mkdirSync(join(sshDir, 'config.d'), { recursive: true })
      writeFileSync(
        join(sshDir, 'config'),
        [
          'Include config.d/*.conf',
          'Host *',
          'Host localbox dev*',
          'Host "kept-host"',
          '',
        ].join('\n')
      )
      writeFileSync(
        join(sshDir, 'config.d', '10-extra.conf'),
        [
          'Host included',
          '  User inc',
          '  HostName included.example.com',
          '  Port 2200',
          '  IdentityFile ~/.ssh/id_inc',
          '',
        ].join('\n')
      )

      const loaded = await loadUserSshConfig(home)
      assert.equal(loaded.error, null)
      assert.deepEqual(loaded.aliases, ['included', 'localbox', 'kept-host'])
      assert.deepEqual(loaded.blocks.get('included'), {
        user: 'inc',
        hostName: 'included.example.com',
        port: 2200,
        identityFiles: ['~/.ssh/id_inc'],
      })
      assert.equal(sshConfigListHint(loaded), null)

      const missing = await loadUserSshConfig(join(home, 'empty-home'))
      assert.deepEqual(missing.aliases, [])
      assert.equal(missing.error, 'missing')
      assert.match(
        sshConfigListHint(missing) ?? '',
        /No usable hosts were found/
      )
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('parses ssh -G and omits default port and identity files', () => {
    const devboxOut = [
      'host devbox',
      'user ada',
      'hostname 10.0.0.5',
      'port 2222',
      'identityfile ~/.ssh/id_dev',
      'identityfile /home/ada/my keys/id',
      '',
    ].join('\n')
    const bareOut = [
      'user ubuntu',
      'hostname barealias',
      'port 22',
      ...defaultIdentityFiles.map(file => `identityfile ${file}`),
      '',
    ].join('\n')

    const devbox = endpointFromSshG(
      'devbox',
      parseSshGOutput(devboxOut),
      defaults
    )
    assert.ok(devbox)
    assert.equal(devbox.user, 'ada')
    assert.equal(devbox.hostname, '10.0.0.5')
    assert.equal(devbox.port, 2222)
    assert.equal(devbox.identityFile, '~/.ssh/id_dev')
    assert.deepEqual(devbox.identityFiles, [
      '~/.ssh/id_dev',
      '/home/ada/my keys/id',
    ])

    const bare = endpointFromSshG(
      'barealias',
      parseSshGOutput(bareOut),
      defaults
    )
    assert.ok(bare)
    assert.equal(bare.user, 'ubuntu')
    assert.equal(bare.hostname, 'barealias')
    assert.equal(bare.port, null)
    assert.equal(bare.identityFile, null)
    assert.deepEqual(bare.identityFiles, [])

    const args = buildSshArgs(
      {
        user: bare.user,
        hostname: bare.hostname,
        port: bare.port,
        identityFile: bare.identityFile,
        remotePath: '/srv/repo',
      },
      null
    )
    assert.equal(args.includes('-p'), false)
    assert.equal(args.includes('-i'), false)
    assert.equal(args.includes('IdentitiesOnly=yes'), false)
    assert.equal(args.includes('-F'), false)
    assert.equal(args.at(-1), 'ubuntu@barealias')
  })

  it('keeps an explicit port of 22 when the config-wide port is different', () => {
    const endpoint = endpointFromSshG(
      'forcedefault',
      {
        user: 'git',
        hostname: 'forcedefault',
        port: 22,
        identityFiles: defaultIdentityFiles,
      },
      { ...defaults, user: 'git', port: 443 }
    )
    assert.ok(endpoint)
    assert.equal(endpoint.port, 22)
    assert.equal(endpoint.identityFile, null)

    const globalPort = endpointFromSshG(
      'nameonly',
      {
        user: 'git',
        hostname: '10.1.1.1',
        port: 443,
        identityFiles: defaultIdentityFiles,
      },
      { ...defaults, user: 'git', port: 443 }
    )
    assert.ok(globalPort)
    assert.equal(globalPort.port, 443)
    assert.equal(globalPort.hostname, '10.1.1.1')
  })

  it('stores the resolved host instead of the alias and does not pass unset options', () => {
    const endpoint = endpointFromSshG(
      'devbox',
      {
        user: 'ada',
        hostname: '10.0.0.5',
        port: 22,
        identityFiles: defaultIdentityFiles,
      },
      defaults
    )
    assert.ok(endpoint)
    const location = {
      user: endpoint.user,
      hostname: endpoint.hostname,
      port: endpoint.port,
      identityFile: endpoint.identityFile,
      remotePath: '/home/ada/src/repo',
    }
    const args = buildSshArgs(location, null)
    assert.equal(args.at(-2), '--')
    assert.equal(args.at(-1), 'ada@10.0.0.5')
    assert.equal(args.includes('devbox'), false)
    assert.equal(args.includes('-p'), false)
    assert.equal(args.includes('-i'), false)
    assert.equal(
      args.some(arg => arg.toLowerCase().includes('proxyjump')),
      false
    )

    const stored = parseSshRemoteLocation(formatSshRemoteLocation(location))
    assert.equal(stored?.hostname, '10.0.0.5')
    assert.equal(stored?.user, 'ada')
    assert.equal(stored?.port, null)
    assert.equal(stored?.identityFile, null)
  })

  it('resolves a selected host with ssh -G and falls back to the config file', async () => {
    resetSshConfigHostCacheForTesting()
    const calls: string[] = []
    const resolved = await resolveSshConfigHost('devbox', {
      username: 'local',
      runSshG: async alias => {
        calls.push(alias)
        if (alias === 'devbox') {
          return 'user ada\nhostname 10.0.0.5\nport 22\nidentityfile ~/.ssh/id_rsa\n'
        }
        return `user local\nhostname ${alias}\nport 22\nidentityfile ~/.ssh/id_rsa\n`
      },
      lookupConfigBlock: async () => {
        throw new Error('ssh -G succeeded, so the file is not needed')
      },
    })
    assert.deepEqual(calls, ['devbox', SshConfigDefaultProbeHost])
    assert.equal(resolved?.source, 'ssh-g')
    assert.equal(resolved?.hostname, '10.0.0.5')
    assert.equal(resolved?.port, null)
    assert.equal(resolved?.identityFile, null)

    const fallback = await resolveSshConfigHost('devbox', {
      username: 'local',
      runSshG: async () => null,
      lookupConfigBlock: async alias => {
        assert.equal(alias, 'devbox')
        return {
          user: 'ada',
          hostName: '10.0.0.5',
          port: null,
          identityFiles: [],
        }
      },
    })
    assert.equal(fallback?.source, 'config-file')
    assert.deepEqual(
      fallback && {
        user: fallback.user,
        hostname: fallback.hostname,
        port: fallback.port,
        identityFile: fallback.identityFile,
      },
      {
        user: 'ada',
        hostname: '10.0.0.5',
        port: null,
        identityFile: null,
      }
    )

    const fromText = fallbackEndpointFromConfigText(
      'bare',
      'Host bare\n',
      'ada'
    )
    assert.equal(fromText?.user, 'ada')
    assert.equal(fromText?.hostname, 'bare')
    assert.equal(fromText?.port, null)
    assert.equal(fromText?.identityFile, null)
  })

  it('does not ask ssh to resolve an alias that looks like an option', async () => {
    const calls: string[] = []
    const resolved = await resolveSshConfigHost('-oProxyCommand=id', {
      runSshG: async alias => {
        calls.push(alias)
        return 'user ada\nhostname example\nport 22\n'
      },
    })
    assert.equal(resolved, null)
    assert.deepEqual(calls, [])
  })

  it('accepts a manual Host alias and leaves user@host unchanged', async () => {
    assert.equal(parseSshConnectionInput('devbox'), null)
    assert.deepEqual(parseSshManualConnectionInput('devbox'), {
      kind: 'alias',
      alias: 'devbox',
    })
    assert.deepEqual(parseSshManualConnectionInput('ada@dev.example.com'), {
      kind: 'explicit',
      user: 'ada',
      hostname: 'dev.example.com',
      port: null,
    })
    assert.deepEqual(
      parseSshManualConnectionInput('ada@dev.example.com:2222'),
      {
        kind: 'explicit',
        user: 'ada',
        hostname: 'dev.example.com',
        port: 2222,
      }
    )
    assert.equal(parseSshManualConnectionInput('-oProxyCommand=id'), null)
    assert.equal(parseSshManualConnectionInput('dev*'), null)
    assert.equal(parseSshManualConnectionInput('ada@dev.example.com:0'), null)

    let sshCalls = 0
    const explicit = await resolveManualSshConnection(
      {
        kind: 'explicit',
        user: 'ada',
        hostname: 'dev.example.com',
        port: 2222,
      },
      { port: null, identityFile: null },
      {
        runSshG: async () => {
          sshCalls++
          return null
        },
      }
    )
    assert.equal(sshCalls, 0)
    assert.deepEqual(explicit, {
      user: 'ada',
      hostname: 'dev.example.com',
      port: 2222,
      identityFile: null,
    })

    const alias = await resolveManualSshConnection(
      { kind: 'alias', alias: 'devbox' },
      { port: null, identityFile: null },
      {
        username: 'local',
        runSshG: async aliasName => {
          if (aliasName === 'devbox') {
            return 'user ada\nhostname 10.0.0.5\nport 2222\nidentityfile ~/.ssh/id_dev\n'
          }
          return 'user local\nhostname probe\nport 22\nidentityfile ~/.ssh/id_rsa\n'
        },
      }
    )
    assert.deepEqual(alias, {
      user: 'ada',
      hostname: '10.0.0.5',
      port: 2222,
      identityFile: '~/.ssh/id_dev',
    })

    const overridden = await resolveManualSshConnection(
      { kind: 'alias', alias: 'devbox' },
      { port: 443, identityFile: '/keys/manual' },
      {
        username: 'local',
        runSshG: async aliasName => {
          if (aliasName === 'devbox') {
            return 'user ada\nhostname 10.0.0.5\nport 2222\nidentityfile ~/.ssh/id_dev\n'
          }
          return 'user local\nhostname probe\nport 22\nidentityfile ~/.ssh/id_rsa\n'
        },
      }
    )
    assert.equal(overridden?.port, 443)
    assert.equal(overridden?.identityFile, '/keys/manual')

    const unset = await resolveManualSshConnection(
      { kind: 'alias', alias: 'barealias' },
      { port: null, identityFile: null },
      {
        username: 'local',
        runSshG: async aliasName =>
          `user local\nhostname ${aliasName}\nport 22\nidentityfile ~/.ssh/id_rsa\n`,
      }
    )
    assert.deepEqual(unset, {
      user: 'local',
      hostname: 'barealias',
      port: null,
      identityFile: null,
    })
    const args = buildSshArgs({ ...unset!, remotePath: '/srv' }, null)
    assert.equal(args.includes('-p'), false)
    assert.equal(args.includes('-i'), false)
    assert.equal(args.at(-1), 'local@barealias')
  })

  it('matches ssh -G on a fixture config', t => {
    const probe = spawnSync('ssh', ['-V'], { encoding: 'utf8' })
    if (probe.error !== undefined) {
      t.skip('ssh is not installed')
      return
    }

    const directory = mkdtempSync(join(tmpdir(), 'dplus-ssh-g-'))
    const config = join(directory, 'config')
    try {
      writeFileSync(
        config,
        [
          'Host devbox',
          '  HostName 10.0.0.5',
          '  User ada',
          '  Port 2222',
          '  IdentityFile ~/.ssh/id_dev',
          '',
          'Host barealias',
          '',
          'Host nameonly',
          '  HostName 10.1.1.1',
          '',
        ].join('\n')
      )

      const query = (host: string) => {
        const result = spawnSync('ssh', ['-G', '-F', config, '--', host], {
          encoding: 'utf8',
          timeout: 8000,
        })
        assert.equal(result.status, 0, result.stderr)
        return parseSshGOutput(result.stdout)
      }

      const probed = query(SshConfigDefaultProbeHost)
      const devbox = endpointFromSshG('devbox', query('devbox'), probed)
      assert.equal(devbox?.user, 'ada')
      assert.equal(devbox?.hostname, '10.0.0.5')
      assert.equal(devbox?.port, 2222)
      assert.equal(devbox?.identityFile, '~/.ssh/id_dev')

      const bare = endpointFromSshG('barealias', query('barealias'), probed)
      assert.equal(bare?.user, probed.user)
      assert.equal(bare?.hostname, 'barealias')
      assert.equal(bare?.port, null)
      assert.equal(bare?.identityFile, null)
      const args = buildSshArgs(
        {
          user: bare!.user,
          hostname: bare!.hostname,
          port: bare!.port,
          identityFile: bare!.identityFile,
          remotePath: '/srv',
        },
        null
      )
      assert.equal(args.includes('-p'), false)
      assert.equal(args.includes('-i'), false)
      assert.equal(args.at(-1), `${probed.user}@barealias`)

      const nameOnly = endpointFromSshG('nameonly', query('nameonly'), probed)
      assert.equal(nameOnly?.hostname, '10.1.1.1')
      assert.equal(nameOnly?.port, null)
      assert.equal(nameOnly?.identityFile, null)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
