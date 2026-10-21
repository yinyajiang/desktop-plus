import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  getGroupKey,
  groupRepositories,
} from '../../src/ui/repositories-list/group-repositories'
import { Repository, ILocalRepositoryState } from '../../src/models/repository'
import { CloningRepository } from '../../src/models/cloning-repository'
import { gitHubRepoFixture } from '../helpers/github-repo-builder'
import { formatSshRemoteLocation } from '../../src/lib/ssh/ssh-remote-location'

function sshRepository(
  remotePathName: string,
  id: number,
  gitHubRepository: ReturnType<typeof gitHubRepoFixture> | null = null,
  groupName: string | null = null,
  hostname = 'build.example'
) {
  return new Repository(
    formatSshRemoteLocation({
      user: 'dev',
      hostname,
      port: null,
      identityFile: null,
      remotePath: `/srv/${remotePathName}`,
    }),
    id,
    gitHubRepository,
    false,
    null,
    groupName
  )
}

describe('repository list grouping', () => {
  const repositories: Array<Repository | CloningRepository> = [
    new Repository('repo1', 1, null, false),
    new Repository(
      'repo2',
      2,
      gitHubRepoFixture({ owner: 'me', name: 'my-repo2' }),
      false
    ),
    new Repository(
      'repo3',
      3,
      gitHubRepoFixture({
        owner: '',
        name: 'my-repo3',
        endpoint: 'https://github.big-corp.com/api/v3',
      }),
      false
    ),
    sshRepository('repo4', 4),
  ]

  const cache = new Map<number, ILocalRepositoryState>()

  it('groups repositories by owners, Enterprise, SSH, and Other', () => {
    const grouped = groupRepositories(repositories, cache, [])
    assert.equal(grouped.length, 4)

    assert.equal(grouped[0].identifier.kind, 'dotcom')
    assert.equal((grouped[0].identifier as any).owner.login, 'me')
    assert.equal(grouped[0].items.length, 1)

    let item = grouped[0].items[0]
    assert.equal(item.repository.path, 'repo2')

    assert.equal(grouped[1].identifier.kind, 'enterprise')
    assert.equal(grouped[1].items.length, 1)

    item = grouped[1].items[0]
    assert.equal(item.repository.path, 'repo3')

    assert.equal(grouped[2].identifier.kind, 'ssh')
    assert.equal(grouped[2].identifier.displayName, null)
    assert.equal(grouped[2].items.length, 1)

    item = grouped[2].items[0]
    assert.equal(item.repository.name, 'repo4')

    assert.equal(grouped[3].identifier.kind, 'other')
    assert.equal(grouped[3].items.length, 1)

    item = grouped[3].items[0]
    assert.equal(item.repository.path, 'repo1')
  })

  it('sorts repositories alphabetically within each group', () => {
    const repoA = new Repository('a', 1, null, false)
    const repoB = new Repository(
      'b',
      2,
      gitHubRepoFixture({ owner: 'me', name: 'b' }),
      false
    )
    const repoC = new Repository('c', 2, null, false)
    const repoD = new Repository(
      'd',
      2,
      gitHubRepoFixture({ owner: 'me', name: 'd' }),
      false
    )
    const repoZ = new Repository('z', 3, null, false)

    const grouped = groupRepositories(
      [repoC, repoB, repoZ, repoD, repoA],
      cache,
      []
    )
    assert.equal(grouped.length, 2)

    assert.equal(grouped[0].identifier.kind, 'dotcom')
    assert.equal((grouped[0].identifier as any).owner.login, 'me')
    assert.equal(grouped[0].items.length, 2)

    let items = grouped[0].items
    assert.equal(items[0].repository.path, 'b')
    assert.equal(items[1].repository.path, 'd')

    assert.equal(grouped[1].identifier.kind, 'other')
    assert.equal(grouped[1].items.length, 3)

    items = grouped[1].items
    assert.equal(items[0].repository.path, 'a')
    assert.equal(items[1].repository.path, 'c')
    assert.equal(items[2].repository.path, 'z')
  })

  it('only disambiguates Enterprise repositories', () => {
    const repoA = new Repository(
      'repo',
      1,
      gitHubRepoFixture({ owner: 'user1', name: 'repo' }),
      false
    )
    const repoB = new Repository(
      'repo',
      2,
      gitHubRepoFixture({ owner: 'user2', name: 'repo' }),
      false
    )
    const repoC = new Repository(
      'enterprise-repo',
      3,
      gitHubRepoFixture({
        owner: 'business',
        name: 'enterprise-repo',
        endpoint: 'https://ghe.io/api/v3',
      }),
      false
    )
    const repoD = new Repository(
      'enterprise-repo',
      3,
      gitHubRepoFixture({
        owner: 'silliness',
        name: 'enterprise-repo',
        endpoint: 'https://ghe.io/api/v3',
      }),
      false
    )

    const grouped = groupRepositories([repoA, repoB, repoC, repoD], cache, [])
    assert.equal(grouped.length, 3)

    assert.equal(grouped[0].identifier.kind, 'dotcom')
    assert.equal((grouped[0].identifier as any).owner.login, 'user1')
    assert.equal(grouped[0].items.length, 1)

    assert.equal(grouped[1].identifier.kind, 'dotcom')
    assert.equal((grouped[1].identifier as any).owner.login, 'user2')
    assert.equal(grouped[1].items.length, 1)

    assert.equal(grouped[2].identifier.kind, 'enterprise')
    assert.equal(grouped[2].items.length, 2)

    assert.equal(grouped[0].items[0].text[0], 'repo')
    assert(!grouped[0].items[0].needsDisambiguation)

    assert.equal(grouped[1].items[0].text[0], 'repo')
    assert(!grouped[1].items[0].needsDisambiguation)

    assert.equal(grouped[2].items[0].text[0], 'enterprise-repo')
    assert(grouped[2].items[0].needsDisambiguation)

    assert.equal(grouped[2].items[1].text[0], 'enterprise-repo')
    assert(grouped[2].items[1].needsDisambiguation)
  })

  it('groups SSH remotes from different hosts together, after Enterprise', () => {
    const enterprise = new Repository(
      'local-corp',
      1,
      gitHubRepoFixture({
        owner: 'corp',
        name: 'local-corp',
        endpoint: 'https://zzz.example.com/api/v3',
      }),
      false
    )
    const first = sshRepository('b-repo', 2, null, null, 'a.example')
    const second = sshRepository('a-repo', 3, null, null, 'z.example')
    const local = new Repository('plain', 4, null, false)

    const grouped = groupRepositories(
      [local, second, enterprise, first],
      cache,
      []
    )

    assert.deepStrictEqual(
      grouped.map(group => group.identifier.kind),
      ['enterprise', 'ssh', 'other']
    )
    assert.equal(grouped[1].identifier.displayName, null)
    assert.deepStrictEqual(
      grouped[1].items.map(item => item.repository.name),
      ['a-repo', 'b-repo']
    )
    assert.equal(grouped[2].items[0].repository.path, 'plain')
  })

  it('groups an SSH checkout of a GitHub repository under SSH', () => {
    const sshDotcom = sshRepository(
      'ignored',
      1,
      gitHubRepoFixture({ owner: 'me', name: 'cloud-repo' })
    )
    const sshEnterprise = sshRepository(
      'ignored',
      2,
      gitHubRepoFixture({
        owner: 'corp',
        name: 'corp-repo',
        endpoint: 'https://zzz.example.com/api/v3',
      }),
      null,
      'remote.example'
    )
    const dotcom = new Repository(
      'local-cloud',
      3,
      gitHubRepoFixture({ owner: 'me', name: 'local-cloud' }),
      false
    )
    const enterprise = new Repository(
      'local-corp',
      4,
      gitHubRepoFixture({
        owner: 'corp',
        name: 'local-corp',
        endpoint: 'https://zzz.example.com/api/v3',
      }),
      false
    )

    const grouped = groupRepositories(
      [sshEnterprise, dotcom, enterprise, sshDotcom],
      cache,
      []
    )

    assert.deepStrictEqual(
      grouped.map(group => group.identifier.kind),
      ['dotcom', 'enterprise', 'ssh']
    )
    assert.deepStrictEqual(
      grouped[2].items.map(item => item.repository.name),
      ['cloud-repo', 'corp-repo']
    )
  })

  it('uses a manual group name for an SSH remote', () => {
    const named = sshRepository('remote-repo', 1, null, 'Tools')
    const dotcom = new Repository(
      'gh',
      2,
      gitHubRepoFixture({ owner: 'me', name: 'gh' }),
      false
    )
    const local = new Repository('local', 3, null, false)

    const grouped = groupRepositories([local, named, dotcom], cache, [])

    assert.deepStrictEqual(
      grouped.map(group => group.identifier.kind),
      ['dotcom', 'ssh', 'other']
    )
    assert.equal(grouped[1].identifier.displayName, 'Tools')
    assert.equal(getGroupKey(grouped[1].identifier), '1:Tools')
    assert.equal(grouped[1].items[0].repository.name, 'remote-repo')
    assert.equal(grouped[2].items[0].repository.path, 'local')
  })

  it('leaves a repository that is still cloning in Other', () => {
    const cloning = new CloningRepository(
      '/tmp/clone',
      'https://example.com/repo.git',
      null
    )
    const ssh = sshRepository('remote', 1)
    const grouped = groupRepositories([cloning, ssh], cache, [])

    assert.deepStrictEqual(
      grouped.map(group => group.identifier.kind),
      ['ssh', 'other']
    )
    assert.equal(grouped[1].items[0].repository.path, cloning.path)
  })
})
