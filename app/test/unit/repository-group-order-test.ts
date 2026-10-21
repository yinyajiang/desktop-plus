import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  applyRepositoryGroupOrder,
  getGroupKey,
  getRepositoryGroupDropBoundary,
  migrateRepositoryGroupKey,
  moveRepositoryGroupInOrder,
  RepositoryListGroup,
} from '../../src/ui/repositories-list/group-repositories'
import {
  getRepositoryGroupOrder,
  renameKeyInGroupOrder,
} from '../../src/lib/stores/repository-group-order'
import { getCollapsedRepositoryGroups } from '../../src/lib/stores/repository-group-collapse'

const customGroup = (name: string) => ({
  identifier: { kind: 'other', displayName: name } as RepositoryListGroup,
})
const recentGroup = {
  identifier: { kind: 'recent', displayName: null } as RepositoryListGroup,
}
const pinsGroup = {
  identifier: { kind: 'pins', displayName: null } as RepositoryListGroup,
}

const keysOf = (
  groups: ReadonlyArray<{ readonly identifier: RepositoryListGroup }>
) => groups.map(g => getGroupKey(g.identifier))

describe('applyRepositoryGroupOrder', () => {
  const a = customGroup('a')
  const b = customGroup('b')
  const c = customGroup('c')
  const d = customGroup('d')

  it('keeps the default order when there is no saved order', () => {
    const groups = [recentGroup, a, b, c]
    assert.equal(applyRepositoryGroupOrder(groups, []), groups)
  })

  it('sorts the groups in the saved order', () => {
    const ordered = applyRepositoryGroupOrder([a, b, c], ['1:c', '1:a', '1:b'])
    assert.deepStrictEqual(keysOf(ordered), ['1:c', '1:a', '1:b'])
  })

  it('keeps pins and recent at the top', () => {
    const ordered = applyRepositoryGroupOrder(
      [pinsGroup, recentGroup, a, b],
      ['1:b', '0:recent', '-1:pins', '1:a']
    )
    assert.deepStrictEqual(keysOf(ordered), [
      '-1:pins',
      '0:recent',
      '1:b',
      '1:a',
    ])
  })

  it('inserts new groups after the last group that sorts before them', () => {
    const ordered = applyRepositoryGroupOrder([a, b, c, d], ['1:d', '1:b'])
    assert.deepStrictEqual(keysOf(ordered), ['1:a', '1:d', '1:b', '1:c'])
  })

  it('appends a new group after its alphabetical predecessor', () => {
    const ordered = applyRepositoryGroupOrder(
      [customGroup('A'), customGroup('B'), customGroup('Z')],
      ['1:Z', '1:A']
    )
    assert.deepStrictEqual(keysOf(ordered), ['1:Z', '1:A', '1:B'])
  })

  it('puts a new group at the top when no group sorts before it', () => {
    const ordered = applyRepositoryGroupOrder(
      [customGroup('0'), customGroup('A'), customGroup('Z')],
      ['1:Z', '1:A']
    )
    assert.deepStrictEqual(keysOf(ordered), ['1:0', '1:Z', '1:A'])
  })

  it('inserts several new groups at once', () => {
    const e = customGroup('e')
    const f = customGroup('f')
    const ordered = applyRepositoryGroupOrder(
      [a, b, c, d, e, f],
      ['1:c', '1:a', '1:e']
    )
    assert.deepStrictEqual(keysOf(ordered), [
      '1:c',
      '1:a',
      '1:b',
      '1:d',
      '1:e',
      '1:f',
    ])
  })

  it('keeps the default order when no saved key matches a group', () => {
    const upperA = customGroup('A')
    const groups = [pinsGroup, recentGroup, upperA, a, b, c]
    const ordered = applyRepositoryGroupOrder(groups, ['1:gone', '0:recent'])
    assert.deepStrictEqual(keysOf(ordered), keysOf(groups))
  })

  it('keeps pins and recent above new groups inserted at the top', () => {
    const zero = customGroup('0')
    const ordered = applyRepositoryGroupOrder(
      [pinsGroup, recentGroup, zero, a, b, c],
      ['1:c', '1:a']
    )
    assert.deepStrictEqual(keysOf(ordered), [
      '-1:pins',
      '0:recent',
      '1:0',
      '1:c',
      '1:a',
      '1:b',
    ])
  })

  it('ignores saved keys of groups that are not present', () => {
    const ordered = applyRepositoryGroupOrder(
      [a, b, c],
      ['1:gone', '1:c', '1:other', '1:a']
    )
    assert.deepStrictEqual(keysOf(ordered), ['1:c', '1:a', '1:b'])
  })

  it('uses the first position of duplicated saved keys', () => {
    const ordered = applyRepositoryGroupOrder([a, b], ['1:b', '1:a', '1:b'])
    assert.deepStrictEqual(keysOf(ordered), ['1:b', '1:a'])
  })

  it('keeps a saved Other group when upgrading its key for the SSH group', () => {
    const other = {
      identifier: { kind: 'other', displayName: null } as RepositoryListGroup,
    }
    const ssh = {
      identifier: { kind: 'ssh', displayName: null } as RepositoryListGroup,
    }
    const work = customGroup('Work')
    const ordered = applyRepositoryGroupOrder(
      [ssh, work, other],
      ['3:other', '1:Work'].map(migrateRepositoryGroupKey)
    )
    assert.deepStrictEqual(keysOf(ordered), ['4:other', '1:Work', '3:ssh'])
  })
})

describe('saved repository group keys', () => {
  const orderKey = 'repository-group-order'
  const collapsedKey = 'collapsed-repository-groups'

  it('rewrites the saved Other group key from before SSH existed', () => {
    localStorage.setItem(
      orderKey,
      JSON.stringify(['1:a', '3:other', '2:ghe.io'])
    )
    try {
      assert.deepStrictEqual(getRepositoryGroupOrder(), [
        '1:a',
        '4:other',
        '2:ghe.io',
      ])
    } finally {
      localStorage.removeItem(orderKey)
    }
  })

  it('leaves current group keys unchanged', () => {
    localStorage.setItem(orderKey, JSON.stringify(['3:ssh', '4:other']))
    try {
      assert.deepStrictEqual(getRepositoryGroupOrder(), ['3:ssh', '4:other'])
    } finally {
      localStorage.removeItem(orderKey)
    }
  })

  it('keeps a previously collapsed Other group collapsed', () => {
    localStorage.setItem(collapsedKey, JSON.stringify(['3:other', '1:Work']))
    try {
      assert.deepStrictEqual(
        [...getCollapsedRepositoryGroups()],
        ['4:other', '1:Work']
      )
    } finally {
      localStorage.removeItem(collapsedKey)
    }
  })
})

describe('moveRepositoryGroupInOrder', () => {
  const displayed = ['1:a', '1:b', '1:c', '1:d']

  it('moves a group before another one', () => {
    assert.deepStrictEqual(
      moveRepositoryGroupInOrder([], displayed, '1:d', '1:b', 'before'),
      ['1:a', '1:d', '1:b', '1:c']
    )
  })

  it('moves a group after another one', () => {
    assert.deepStrictEqual(
      moveRepositoryGroupInOrder([], displayed, '1:a', '1:c', 'after'),
      ['1:b', '1:c', '1:a', '1:d']
    )
  })

  it('moves a group to the start and the end', () => {
    assert.deepStrictEqual(
      moveRepositoryGroupInOrder([], displayed, '1:c', '1:a', 'before'),
      ['1:c', '1:a', '1:b', '1:d']
    )
    assert.deepStrictEqual(
      moveRepositoryGroupInOrder([], displayed, '1:a', '1:d', 'after'),
      ['1:b', '1:c', '1:d', '1:a']
    )
  })

  it('returns the saved order when the displayed order does not change', () => {
    const saved = ['1:x', '1:b']
    for (const [moved, target, position] of [
      ['1:b', '1:b', 'before'],
      ['1:b', '1:b', 'after'],
      ['1:b', '1:c', 'before'],
      ['1:b', '1:a', 'after'],
    ] as const) {
      assert.equal(
        moveRepositoryGroupInOrder(saved, displayed, moved, target, position),
        saved
      )
    }
  })

  it('returns the saved order when a group is not displayed', () => {
    const saved = ['1:a']
    assert.equal(
      moveRepositoryGroupInOrder(saved, displayed, '1:x', '1:a', 'before'),
      saved
    )
    assert.equal(
      moveRepositoryGroupInOrder(saved, displayed, '1:a', '1:x', 'after'),
      saved
    )
  })

  it('keeps hidden groups after the saved group that preceded them', () => {
    assert.deepStrictEqual(
      moveRepositoryGroupInOrder(
        ['1:b', '1:hidden1', '1:hidden2', '1:a'],
        ['1:b', '1:a', '1:c'],
        '1:c',
        '1:b',
        'before'
      ),
      ['1:c', '1:b', '1:hidden1', '1:hidden2', '1:a']
    )
  })

  it('keeps hidden groups without a preceding group at the start', () => {
    assert.deepStrictEqual(
      moveRepositoryGroupInOrder(
        ['1:hidden1', '1:hidden2', '1:b', '1:a'],
        ['1:b', '1:a'],
        '1:a',
        '1:b',
        'before'
      ),
      ['1:hidden1', '1:hidden2', '1:a', '1:b']
    )
  })

  it('restores the position of hidden groups when they reappear', () => {
    const order = moveRepositoryGroupInOrder(
      ['1:a', '1:hidden', '1:b', '1:c'],
      ['1:a', '1:b', '1:c'],
      '1:c',
      '1:a',
      'before'
    )
    assert.deepStrictEqual(order, ['1:c', '1:a', '1:hidden', '1:b'])

    const ordered = applyRepositoryGroupOrder(
      [
        customGroup('a'),
        customGroup('b'),
        customGroup('c'),
        customGroup('hidden'),
      ],
      order
    )
    assert.deepStrictEqual(keysOf(ordered), ['1:c', '1:a', '1:hidden', '1:b'])
  })
})

describe('getRepositoryGroupDropBoundary', () => {
  const displayed = ['1:a', '1:b', '1:c']

  it('makes dropping after a group the same as before the next one', () => {
    assert.deepStrictEqual(
      getRepositoryGroupDropBoundary(displayed, {
        groupKey: '1:a',
        position: 'after',
      }),
      { groupKey: '1:b', position: 'before' }
    )
    assert.deepStrictEqual(
      getRepositoryGroupDropBoundary(displayed, {
        groupKey: '1:b',
        position: 'after',
      }),
      { groupKey: '1:c', position: 'before' }
    )
  })

  it('keeps dropping before a group as it is', () => {
    for (const groupKey of displayed) {
      const target = { groupKey, position: 'before' } as const
      assert.equal(getRepositoryGroupDropBoundary(displayed, target), target)
    }
  })

  it('keeps dropping after the last group as it is', () => {
    const target = { groupKey: '1:c', position: 'after' } as const
    assert.equal(getRepositoryGroupDropBoundary(displayed, target), target)
  })

  it('keeps a target whose group is not displayed as it is', () => {
    const target = { groupKey: '1:x', position: 'after' } as const
    assert.equal(getRepositoryGroupDropBoundary(displayed, target), target)
  })

  it('drops both forms of a boundary at the same position', () => {
    const after = getRepositoryGroupDropBoundary(displayed, {
      groupKey: '1:a',
      position: 'after',
    })
    assert.deepStrictEqual(
      moveRepositoryGroupInOrder(
        [],
        displayed,
        '1:c',
        after.groupKey,
        after.position
      ),
      moveRepositoryGroupInOrder([], displayed, '1:c', '1:a', 'after')
    )
  })
})

describe('renameKeyInGroupOrder', () => {
  it('replaces the old key in place', () => {
    assert.deepStrictEqual(
      renameKeyInGroupOrder(['1:a', '1:old', '1:b'], '1:old', '1:new', false),
      ['1:a', '1:new', '1:b']
    )
  })

  it('drops a stale entry for the new key when its group does not exist', () => {
    assert.deepStrictEqual(
      renameKeyInGroupOrder(
        ['1:new', '1:a', '1:old', '1:b'],
        '1:old',
        '1:new',
        false
      ),
      ['1:a', '1:new', '1:b']
    )
    assert.deepStrictEqual(
      renameKeyInGroupOrder(['1:a', '1:new'], '1:old', '1:new', false),
      ['1:a']
    )
  })

  it('keeps the position of an existing group with the new key', () => {
    assert.deepStrictEqual(
      renameKeyInGroupOrder(
        ['1:new', '1:a', '1:old', '1:b'],
        '1:old',
        '1:new',
        true
      ),
      ['1:new', '1:a', '1:b']
    )
  })

  it('gives an existing group without a position the old one', () => {
    assert.deepStrictEqual(
      renameKeyInGroupOrder(['1:a', '1:old'], '1:old', '1:new', true),
      ['1:a', '1:new']
    )
  })

  it('leaves the order untouched when neither key is saved', () => {
    assert.deepStrictEqual(
      renameKeyInGroupOrder(['1:a', '1:b'], '1:old', '1:new', true),
      ['1:a', '1:b']
    )
  })

  it('leaves the order untouched when the key does not change', () => {
    const order = ['1:a', '1:old']
    assert.equal(renameKeyInGroupOrder(order, '1:old', '1:old', false), order)
  })
})
